import fs from "node:fs";
import path from "node:path";
import type { HookCallbackMatcher, HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

/**
 * 每個專案一個資料夾，agent 的 cwd 就是那個資料夾。
 * 兩層鎖：
 *   1. 權限規則：dontAsk + 只允許寫特定檔案（cwd 外讀寫一律 deny）
 *   2. PreToolUse hook：每次工具呼叫都檢查實際路徑（解 symlink），不在白名單就擋
 * 任何一層擋下都不會執行。
 */

export type Mode = "digest" | "ask";

/** agent 可以寫的路徑（相對專案資料夾）。raw/、files/、pending.md 只有 bot 能寫。 */
const WRITABLE_FILES = ["STATE.md", "decisions.md", "people.md", "outbox.md"];
const WRITABLE_DIRS = ["log", "notes"];

export const TOOLS: Record<Mode, string[]> = {
  digest: ["Read", "Glob", "Grep", "Write", "Edit", "WebFetch"],
  ask: ["Read", "Glob", "Grep", "WebFetch"],
};

/** 第一層：權限規則。Edit(/x) 錨定在 cwd；dontAsk 下沒列到的寫入一律拒絕 */
export function allowRules(mode: Mode): string[] {
  const rules = ["WebFetch"];
  if (mode === "digest") {
    for (const f of WRITABLE_FILES) rules.push(`Edit(/${f})`);
    for (const d of WRITABLE_DIRS) rules.push(`Edit(/${d}/**)`);
  }
  return rules;
}

/** 解成真實絕對路徑；檔案不存在時解最近的既有祖先再接回去 */
function realResolve(p: string, cwd: string): string {
  let abs = path.resolve(cwd, p);
  const rest: string[] = [];
  while (!fs.existsSync(abs)) {
    const parent = path.dirname(abs);
    if (parent === abs) break;
    rest.unshift(path.basename(abs));
    abs = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(abs);
  } catch {
    real = abs;
  }
  return path.join(real, ...rest);
}

function inside(root: string, abs: string) {
  return abs === root || abs.startsWith(root + path.sep);
}

function isWritable(root: string, abs: string) {
  if (!inside(root, abs) || abs === root) return false;
  const rel = path.relative(root, abs);
  const parts = rel.split(path.sep);
  if (parts.length === 1) return WRITABLE_FILES.includes(rel);
  return WRITABLE_DIRS.includes(parts[0]) && parts.every((s) => s && s !== "..");
}

export interface GuardResult {
  ok: boolean;
  reason?: string;
}

/** 純函式，方便測試 */
export function checkToolCall(root: string, mode: Mode, tool: string, input: Record<string, unknown>): GuardResult {
  if (!TOOLS[mode].includes(tool)) return { ok: false, reason: `${mode} 模式不允許工具 ${tool}` };
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);

  const needInside = (p: string | undefined, label: string): GuardResult => {
    if (p === undefined) return { ok: true };
    const abs = realResolve(p, root);
    return inside(root, abs) ? { ok: true } : { ok: false, reason: `${label} 在專案資料夾外：${p}` };
  };

  switch (tool) {
    case "Read":
      return needInside(str("file_path"), "讀取路徑");
    case "Glob": {
      const pat = str("pattern") ?? "";
      if (pat.includes("..")) return { ok: false, reason: "Glob pattern 不能含 .." };
      if (path.isAbsolute(pat)) {
        const base = pat.split(/[*?[{]/)[0];
        const r = needInside(base || "/", "Glob pattern");
        if (!r.ok) return r;
      }
      return needInside(str("path"), "Glob 路徑");
    }
    case "Grep": {
      const g = str("glob") ?? "";
      if (g.includes("..") || path.isAbsolute(g)) return { ok: false, reason: "Grep glob 不能含 .. 或絕對路徑" };
      return needInside(str("path"), "Grep 路徑");
    }
    case "Write":
    case "Edit": {
      const p = str("file_path");
      if (!p) return { ok: false, reason: "缺 file_path" };
      const abs = realResolve(p, root);
      if (isWritable(root, abs)) return { ok: true };
      return {
        ok: false,
        reason: `不能寫 ${p}。只能寫 ${WRITABLE_FILES.join("、")}、${WRITABLE_DIRS.map((d) => d + "/").join("、")}`,
      };
    }
    case "WebFetch":
      return { ok: true };
  }
  return { ok: false, reason: `未知工具 ${tool}` };
}

/** 第二層：PreToolUse hook */
export function guardHook(projectRoot: string, mode: Mode, label: string): HookCallbackMatcher {
  const root = fs.realpathSync(projectRoot);
  return {
    hooks: [
      async (input: HookInput): Promise<HookJSONOutput> => {
        if (input.hook_event_name !== "PreToolUse") return { continue: true };
        const r = checkToolCall(root, mode, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
        if (r.ok) return { continue: true };
        console.warn(`[guard] ${label} DENY ${input.tool_name}: ${r.reason}`);
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: r.reason,
          },
        };
      },
    ],
  };
}
