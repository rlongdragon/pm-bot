import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { allowRules, guardHook, TOOLS, type Mode } from "./sandbox.js";
import { projectDir } from "./store.js";
import { child, clip, flushTraces, setTraceAttrs, startTrace, type Obs } from "./trace.js";

const exec = promisify(execFile);

export interface AgentResult {
  text: string;
  sessionId: string;
  costUsd: number;
  turns: number;
  denials: number;
  error?: string;
}

/** 同一時間只跑一個 agent，避免兩支同時改筆記互蓋 */
let chain: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function rules(): string {
  try {
    return fs.readFileSync(path.join(config.knowledgeDir, "CLAUDE.md"), "utf8");
  } catch {
    return "";
  }
}

export interface RunOpts {
  project: string;
  mode: Mode;
  label: string;
  resume?: string;
  /** 只給監控用：誰觸發、在哪個頻道 */
  trace?: { userId?: string; channel?: string };
}

/** 組 SDK options。抽出來是為了讓測試能單獨驗證每一層 */
export function buildOptions(o: RunOpts): Options {
  const cwd = projectDir(o.project);
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CONFIG_DIR: config.claudeConfigDir };
  // 訂閱登入靠 CLAUDE_CONFIG_DIR 的憑證；外層若有 API key 會蓋過去，拿掉
  if (!process.env.PM_USE_API_KEY) delete env.ANTHROPIC_API_KEY;

  return {
    cwd,
    tools: TOOLS[o.mode],
    allowedTools: allowRules(o.mode),
    disallowedTools: ["Bash", "Agent", "NotebookEdit", "WebSearch"],
    permissionMode: "dontAsk",
    // 不讀任何 settings / CLAUDE.md：agent 就算寫了 .claude/settings.json 也不會生效
    settingSources: [],
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        `\n\n# 工作範圍\n你的工作目錄是專案「${o.project}」的資料夾。只能讀這個資料夾裡的東西` +
        (o.mode === "digest" ? "，只能寫 STATE.md、decisions.md、people.md、outbox.md、log/、notes/。" : "。這是問答回合，不能寫任何檔案。") +
        `路徑一律用相對路徑。\n` +
        `sources/ 是外部來源（GitHub、Notion）的唯讀副本，bot 會在你開始前同步好。引用時附原始網址。\n\n${rules()}`,
    },
    hooks: { PreToolUse: [guardHook(cwd, o.mode, o.label)] },
    maxTurns: config.maxTurns,
    model: config.model,
    resume: o.resume,
    env,
  };
}

export async function runAgent(prompt: string, o: RunOpts, override?: (opts: Options) => Options): Promise<AgentResult> {
  let text = "";
  let sessionId = o.resume ?? "";
  let costUsd = 0;
  let turns = 0;
  let denials = 0;
  let error: string | undefined;

  const options = override ? override(buildOptions(o)) : buildOptions(o);

  // 監控：一回合一條 trace；每個 assistant 訊息一個 generation、每個工具呼叫一個 span（結果回來時收掉）
  const trace = startTrace(o.label.split(":")[0], {
    userId: o.trace?.userId,
    sessionId: o.resume,
    input: clip(prompt),
    tags: [o.project, o.mode],
    metadata: { project: o.project, mode: o.mode, label: o.label, model: config.model, channel: o.trace?.channel, resume: !!o.resume },
  });
  const openSpans = new Map<string, Obs>();
  let turnInput: unknown = clip(prompt, 20_000);
  let last = new Date();
  // SDK 會把同一次 API 回覆拆成多個 assistant 訊息（每個 content block 一個，usage 相同），
  // 用 message.id 併成一個 generation，下一個不同訊息或回合結束時才收掉
  let cur: { id?: string; gen: Obs; msg: any; texts: string[]; tools: any[]; end: Date } | null = null;
  const closeGen = () => {
    if (!cur) return;
    const { gen, msg, texts, tools, end } = cur;
    const u = msg?.usage ?? {};
    const text = texts.join("\n");
    (gen as any).update({
      output: tools.length ? { text, tool_calls: tools.map((t) => ({ id: t.id, name: t.name, input: clip(t.input, 4000) })) } : text,
      usageDetails: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      },
      metadata: { stop_reason: msg?.stop_reason },
    });
    gen.end(end);
    cur = null;
  };

  for await (const m of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
    const now = new Date();
    if (m.type !== "assistant") closeGen();
    if (m.type === "system" && m.subtype === "init") {
      sessionId = m.session_id;
      if (trace) {
        trace.attrs.sessionId = sessionId;
        setTraceAttrs(trace.root, trace.attrs);
      }
    } else if (m.type === "assistant") {
      sessionId = m.session_id;
      if (trace) {
        const msg: any = m.message;
        const blocks: any[] = Array.isArray(msg?.content) ? msg.content : [];
        const texts: string[] = blocks.filter((b) => b.type === "text").map((b) => b.text);
        const tools = blocks.filter((b) => b.type === "tool_use");
        if (cur && msg?.id && cur.id === msg.id) {
          cur.texts.push(...texts);
          cur.tools.push(...tools);
          cur.msg = msg;
          cur.end = now;
        } else {
          closeGen();
          // 從上一個事件（prompt 送出或工具結果回來）算起，才是這次模型呼叫的時間
          const gen = child(trace, "claude", "generation", { model: msg?.model ?? config.model, input: turnInput }, last);
          cur = { id: msg?.id, gen, msg, texts, tools: [...tools], end: now };
          turnInput = [];
        }
        for (const t of tools) openSpans.set(t.id, child(trace, t.name, "tool", { input: clip(t.input, 20_000) }, now));
        last = now;
      }
    } else if (m.type === "user") {
      if (trace) {
        const content: any = (m as any).message?.content;
        const results: any[] = Array.isArray(content) ? content.filter((b) => b.type === "tool_result") : [];
        for (const r of results) {
          const out = typeof r.content === "string" ? r.content : Array.isArray(r.content) ? r.content.map((c: any) => c.text ?? "").join("\n") : "";
          const sp = openSpans.get(r.tool_use_id);
          if (sp) {
            (sp as any).update({ output: clip(out, 20_000), ...(r.is_error ? { level: "ERROR", statusMessage: clip(out, 300) } : {}) });
            sp.end(now);
          }
          openSpans.delete(r.tool_use_id);
          (turnInput as any[]).push({ tool_use_id: r.tool_use_id, is_error: !!r.is_error, result: clip(out, 4000) });
        }
        if (results.length) last = now;
      }
    } else if (m.type === "result") {
      sessionId = m.session_id;
      costUsd = m.total_cost_usd;
      turns = m.num_turns;
      denials = m.permission_denials?.length ?? 0;
      if (m.subtype === "success") text = m.result;
      else error = `${m.subtype}: ${m.errors?.join("; ")}`;
      if (trace) {
        (trace.root as any).update({
          output: error ? `❌ ${error}` : clip(text),
          ...(error ? { level: "ERROR", statusMessage: error } : {}),
          metadata: { project: o.project, mode: o.mode, label: o.label, model: config.model, channel: o.trace?.channel, costUsd, turns, denials, durationMs: m.duration_ms, durationApiMs: m.duration_api_ms, usage: m.usage },
        });
        if (error) {
          trace.attrs.tags = [o.project, o.mode, "error"];
          setTraceAttrs(trace.root, trace.attrs);
        }
      }
    }
  }
  closeGen();
  for (const s of openSpans.values()) {
    (s as any).update({ level: "WARNING", statusMessage: "沒有收到工具結果" });
    s.end();
  }
  if (trace) {
    trace.root.end();
    void flushTraces();
  }
  console.log(
    `[agent] ${o.label} turns=${turns} cost=$${costUsd.toFixed(3)} denials=${denials} session=${sessionId}${error ? " ERR " + error : ""}`,
  );
  return { text, sessionId, costUsd, turns, denials, error };
}

/* ---------- 知識庫 git ---------- */

export async function ensureKnowledgeRepo(templateDir: string) {
  const dir = config.knowledgeDir;
  fs.mkdirSync(dir, { recursive: true });
  const claudeMd = path.join(dir, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) fs.copyFileSync(path.join(templateDir, "CLAUDE.md"), claudeMd);
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "*/pending.md\n*/outbox.md\n.claude/\n*/.claude/\n");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await exec("git", ["init", "-q"], { cwd: dir });
    await gitCommit(dir, "init knowledge base", true);
  }
}

async function gitCommit(dir: string, message: string, allowEmpty = false) {
  const args = ["-c", "user.name=pm-bot", "-c", "user.email=pm-bot@local", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message];
  if (allowEmpty) args.push("--allow-empty");
  await exec("git", args, { cwd: dir });
}

export async function commitKnowledge(message: string): Promise<boolean> {
  const dir = config.knowledgeDir;
  await exec("git", ["add", "-A"], { cwd: dir });
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir });
  if (!stdout.trim()) return false;
  await gitCommit(dir, message);
  return true;
}
