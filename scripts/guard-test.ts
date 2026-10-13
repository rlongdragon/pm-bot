// 路徑判斷單元測試，不呼叫模型
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkToolCall } from "../src/sandbox.js";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "pmguard-"));
const alpha = path.join(base, "alpha");
const beta = path.join(base, "beta");
for (const d of [alpha, beta]) for (const s of ["raw", "files", "log", "notes"]) fs.mkdirSync(path.join(d, s), { recursive: true });
fs.writeFileSync(path.join(beta, "STATE.md"), "secret");
fs.symlinkSync(beta, path.join(alpha, "notes", "evil"));          // notes/evil -> ../beta
fs.symlinkSync(path.join(beta, "STATE.md"), path.join(alpha, "log", "x.md")); // log/x.md -> beta/STATE.md
const root = fs.realpathSync(alpha);

const cases: [string, "digest" | "ask", string, Record<string, unknown>, boolean][] = [
  ["寫 STATE.md", "digest", "Write", { file_path: "STATE.md" }, true],
  ["寫絕對路徑 STATE.md", "digest", "Edit", { file_path: path.join(alpha, "STATE.md") }, true],
  ["寫 notes/新檔", "digest", "Write", { file_path: "notes/research/a.md" }, true],
  ["寫 log/", "digest", "Write", { file_path: "log/2026-10-13.md" }, true],
  ["寫 outbox", "digest", "Write", { file_path: "outbox.md" }, true],
  ["寫其他專案", "digest", "Write", { file_path: "../beta/STATE.md" }, false],
  ["寫其他專案絕對路徑", "digest", "Write", { file_path: path.join(beta, "STATE.md") }, false],
  ["寫 raw/", "digest", "Edit", { file_path: "raw/2026-10-13.md" }, false],
  ["寫 pending", "digest", "Write", { file_path: "pending.md" }, false],
  ["寫 files/", "digest", "Write", { file_path: "files/a.txt" }, false],
  ["寫 .claude/settings.json", "digest", "Write", { file_path: ".claude/settings.json" }, false],
  ["寫專案根新檔", "digest", "Write", { file_path: "hack.md" }, false],
  ["寫 /tmp", "digest", "Write", { file_path: "/tmp/x" }, false],
  ["notes/.. 繞回根", "digest", "Write", { file_path: "notes/../hack.md" }, false],
  ["notes/../../beta", "digest", "Write", { file_path: "notes/../../beta/STATE.md" }, false],
  ["symlink 目錄逃脫", "digest", "Write", { file_path: "notes/evil/STATE.md" }, false],
  ["symlink 檔案逃脫", "digest", "Edit", { file_path: "log/x.md" }, false],
  ["讀自己 raw", "digest", "Read", { file_path: "raw/2026-10-13.md" }, true],
  ["讀其他專案", "ask", "Read", { file_path: "../beta/STATE.md" }, false],
  ["讀 symlink 逃脫", "ask", "Read", { file_path: "notes/evil/STATE.md" }, false],
  ["讀 /etc/passwd", "ask", "Read", { file_path: "/etc/passwd" }, false],
  ["Glob 自己", "ask", "Glob", { pattern: "**/*.md" }, true],
  ["Glob ..", "ask", "Glob", { pattern: "../**/*.md" }, false],
  ["Glob 絕對", "ask", "Glob", { pattern: "/root/**" }, false],
  ["Glob path 外", "ask", "Glob", { pattern: "*.md", path: beta }, false],
  ["Grep 自己", "ask", "Grep", { pattern: "x", path: "raw" }, true],
  ["Grep 無 path", "ask", "Grep", { pattern: "x" }, true],
  ["Grep path 外", "ask", "Grep", { pattern: "x", path: ".." }, false],
  ["Grep glob 逃脫", "ask", "Grep", { pattern: "x", glob: "../**" }, false],
  ["ask 模式寫 STATE", "ask", "Write", { file_path: "STATE.md" }, false],
  ["ask 模式 Edit", "ask", "Edit", { file_path: "notes/a.md" }, false],
  ["Bash", "digest", "Bash", { command: "ls" }, false],
  ["Agent", "digest", "Agent", { prompt: "x" }, false],
  ["WebFetch", "ask", "WebFetch", { url: "https://example.com" }, true],
];

let fail = 0;
for (const [name, mode, tool, input, expect] of cases) {
  const r = checkToolCall(root, mode, tool, input);
  const ok = r.ok === expect;
  if (!ok) fail++;
  console.log(`${ok ? "✓" : "✗"} ${name} → ${r.ok ? "允許" : "擋下"}${r.reason && !ok ? "（" + r.reason + "）" : ""}`);
}
fs.rmSync(base, { recursive: true, force: true });
console.log(`\n${cases.length - fail}/${cases.length} 通過`);
assert.equal(fail, 0);
