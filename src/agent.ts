import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

const exec = promisify(execFile);

export interface AgentResult {
  text: string;
  sessionId: string;
  costUsd: number;
  turns: number;
  error?: string;
}

/** 同一時間只跑一個 agent，避免兩支同時改筆記互蓋 */
let chain: Promise<unknown> = Promise.resolve();
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebFetch",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git show *)",
  "Bash(ls *)",
  "Bash(wc *)",
  "Bash(head *)",
  "Bash(tail *)",
];

export async function runAgent(prompt: string, opts: { resume?: string; label: string }): Promise<AgentResult> {
  let text = "";
  let sessionId = opts.resume ?? "";
  let costUsd = 0;
  let turns = 0;
  let error: string | undefined;

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDE_CONFIG_DIR: config.claudeConfigDir,
  };
  // 訂閱登入靠 CLAUDE_CONFIG_DIR 裡的憑證；若外層有 API key 會蓋過去，拿掉
  if (!process.env.PM_USE_API_KEY) delete env.ANTHROPIC_API_KEY;

  const q = query({
    prompt,
    options: {
      cwd: config.knowledgeDir,
      permissionMode: "dontAsk",
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: ["Agent", "NotebookEdit", "WebSearch"],
      settingSources: ["project"],
      systemPrompt: { type: "preset", preset: "claude_code" },
      maxTurns: config.maxTurns,
      model: config.model,
      resume: opts.resume,
      env,
    },
  });

  for await (const m of q as AsyncIterable<SDKMessage>) {
    if (m.type === "assistant") {
      sessionId = m.session_id;
    } else if (m.type === "result") {
      sessionId = m.session_id;
      costUsd = m.total_cost_usd;
      turns = m.num_turns;
      if (m.subtype === "success") text = m.result;
      else error = `${m.subtype}: ${m.errors?.join("; ")}`;
    }
  }
  console.log(`[agent] ${opts.label} turns=${turns} cost=$${costUsd.toFixed(3)} session=${sessionId}${error ? " ERR " + error : ""}`);
  return { text, sessionId, costUsd, turns, error };
}

/* ---------- 知識庫 git ---------- */

export async function ensureKnowledgeRepo(templateDir: string) {
  const dir = config.knowledgeDir;
  fs.mkdirSync(dir, { recursive: true });
  for (const d of ["projects", "raw", "pending", "outbox"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const claudeMd = path.join(dir, "CLAUDE.md");
  if (!fs.existsSync(claudeMd)) fs.copyFileSync(path.join(templateDir, "CLAUDE.md"), claudeMd);
  const gi = path.join(dir, ".gitignore");
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, "pending/\noutbox/\n.claude/\n");
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await exec("git", ["init", "-q"], { cwd: dir });
    await exec("git", ["-c", "user.name=pm-bot", "-c", "user.email=pm-bot@local", "commit", "-q", "--allow-empty", "-m", "init knowledge base"], { cwd: dir });
  }
}

export async function commitKnowledge(message: string): Promise<boolean> {
  const dir = config.knowledgeDir;
  await exec("git", ["add", "-A"], { cwd: dir });
  const { stdout } = await exec("git", ["status", "--porcelain"], { cwd: dir });
  if (!stdout.trim()) return false;
  await exec("git", ["-c", "user.name=pm-bot", "-c", "user.email=pm-bot@local", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message], { cwd: dir });
  return true;
}
