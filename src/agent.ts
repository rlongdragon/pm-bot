import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";
import { allowRules, guardHook, TOOLS, type Mode } from "./sandbox.js";
import { projectDir } from "./store.js";

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
  for await (const m of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
    if (m.type === "assistant") {
      sessionId = m.session_id;
    } else if (m.type === "result") {
      sessionId = m.session_id;
      costUsd = m.total_cost_usd;
      turns = m.num_turns;
      denials = m.permission_denials?.length ?? 0;
      if (m.subtype === "success") text = m.result;
      else error = `${m.subtype}: ${m.errors?.join("; ")}`;
    }
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
