import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function list(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function defaultClaudeConfigDir(): string {
  const profile = path.join(os.homedir(), ".claude-profile");
  try {
    const p = fs.readFileSync(profile, "utf8").trim();
    if (p) return p;
  } catch {}
  return path.join(os.homedir(), ".claude");
}

/** .env 不經過 shell，~ 不會展開，這裡自己處理 */
function expandHome(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

const allowed = list(process.env.ALLOWED_USER_IDS);
const admins = list(process.env.ADMIN_USER_IDS);

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  discordClientId: process.env.DISCORD_CLIENT_ID ?? "",
  discordGuildId: process.env.DISCORD_GUILD_ID || undefined,
  allowedUserIds: allowed,
  adminUserIds: admins.length ? admins : allowed,
  knowledgeDir: path.resolve(expandHome(process.env.KNOWLEDGE_DIR) || "./knowledge"),
  stateFile: path.resolve(expandHome(process.env.STATE_FILE) || "./data/state.json"),
  claudeConfigDir: path.resolve(expandHome(process.env.CLAUDE_CONFIG_DIR) || defaultClaudeConfigDir()),
  model: process.env.PM_MODEL || undefined,
  /** 每天幾點巡檢（期限 / 久未更新提醒）；-1 = 不巡檢 */
  reviewHour: Number(process.env.REVIEW_HOUR ?? 9),
  /** reply 某句話時，抓那句之前 / 之後幾則當上下文 */
  contextBefore: Number(process.env.CONTEXT_BEFORE ?? 10),
  contextAfter: Number(process.env.CONTEXT_AFTER ?? 5),
  /** 同頻道多久沒互動就開新 session */
  sessionIdleHours: Number(process.env.SESSION_IDLE_HOURS ?? 3),
  maxTurns: Number(process.env.MAX_TURNS ?? 40),
  /** 外部來源。GitHub 不設也能看公開 repo（每小時 60 次） */
  githubToken: process.env.GITHUB_TOKEN || undefined,
  /** Notion 讀取用的 integration（只開 Read content） */
  notionToken: process.env.NOTION_TOKEN || undefined,
  /** Notion 看板用的 integration（要 Update、Insert），只分享給看板頁；留空 = 用 NOTION_TOKEN */
  notionBoardToken: process.env.NOTION_BOARD_TOKEN || process.env.NOTION_TOKEN || undefined,
  /** 同一個來源多久內不重抓（分鐘） */
  sourceMinIntervalMin: Number(process.env.SOURCE_MIN_INTERVAL_MIN ?? 10),
};

export function isAllowed(userId: string) {
  return config.allowedUserIds.length === 0 || config.allowedUserIds.includes(userId);
}
export function isAdmin(userId: string) {
  return config.adminUserIds.length === 0 || config.adminUserIds.includes(userId);
}
