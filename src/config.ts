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
  /** GitHub App：使用者在安裝頁面勾 repo 就授權，不用 token。私鑰檔是建 App 時下載的 .pem */
  githubAppId: process.env.GITHUB_APP_ID || undefined,
  githubAppKeyFile: expandHome(process.env.GITHUB_APP_PRIVATE_KEY_FILE) ? path.resolve(expandHome(process.env.GITHUB_APP_PRIVATE_KEY_FILE)!) : undefined,
  /** Notion 讀取用的 integration（只開 Read content） */
  notionToken: process.env.NOTION_TOKEN || undefined,
  /** Notion 看板用的 integration（要 Update、Insert），只分享給看板頁；留空 = 用 NOTION_TOKEN */
  notionBoardToken: process.env.NOTION_BOARD_TOKEN || process.env.NOTION_TOKEN || undefined,
  /** Notion OAuth：/link notion 開授權頁，使用者勾頁面就好。要在 Notion 建 OAuth 連接，redirect URI 填 <PUBLIC_BASE_URL>/notion/callback */
  notionClientId: process.env.NOTION_OAUTH_CLIENT_ID || undefined,
  notionClientSecret: process.env.NOTION_OAUTH_CLIENT_SECRET || undefined,
  /** 外面連得到 bot HTTP 伺服器的網址，結尾不要 /。例如 http://<主機 IP>:8790 */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  /** bot 自己的 HTTP 伺服器，只接 OAuth callback；0 = 不開 */
  httpPort: Number(process.env.HTTP_PORT ?? 8790),
  /** 0.0.0.0 = 直接對外；127.0.0.1 = 只給本機（前面要有反向代理） */
  httpHost: process.env.HTTP_HOST || "127.0.0.1",
  /** 會議錄音（/meet）。音檔不進筆記 git，放這裡：<dir>/<專案ID>/<時間>_<平台>_<名稱>/ */
  recordingsDir: path.resolve(expandHome(process.env.RECORDINGS_DIR) || "./data/recordings"),
  opusBitrate: process.env.OPUS_BITRATE || "64k",
  meetBotName: process.env.MEET_BOT_NAME || "會議記錄員",
  /** Meet 房裡只剩 bot 超過幾秒就離開（0 = 不自動離開） */
  meetAloneTimeoutSec: Number(process.env.MEET_ALONE_TIMEOUT_SEC ?? 120),
  /** 等主持人放行最多幾秒 */
  meetAdmitTimeoutSec: Number(process.env.MEET_ADMIT_TIMEOUT_SEC ?? 600),
  /** 登入過 Google 的 Chromium profile（要登入才能進的會議用）；留空 = 每次全新訪客 */
  meetUserDataDir: expandHome(process.env.MEET_USER_DATA_DIR) || "",
  meetHeaded: process.env.MEET_HEADED === "1",
  /** 會議轉逐字稿：OpenAI 相容 API（預設 ai.rlong.me 的 LiteLLM），模型要能吃音訊 */
  transcribeBaseUrl: process.env.TRANSCRIBE_BASE_URL || "https://ai.rlong.me/v1",
  transcribeApiKey: process.env.TRANSCRIBE_API_KEY || undefined,
  transcribeApiKeyFile: expandHome(process.env.TRANSCRIBE_API_KEY_FILE) || undefined,
  /** 留空 = 不轉錄 */
  transcribeModel: process.env.TRANSCRIBE_MODEL ?? "gemini/gemini-3.6-flash",
  /** 主模型忙碌（503/429）或失敗時依序改用 */
  transcribeFallbackModels: list(process.env.TRANSCRIBE_FALLBACK_MODELS ?? "gemini/gemini-3.5-flash,gemini/gemini-2.5-flash"),
  /** 換掉預設的逐字稿 prompt（檔案內容原樣當開頭，程式只在後面補講者和時間資訊） */
  transcribePromptFile: expandHome(process.env.TRANSCRIBE_PROMPT_FILE) || undefined,
  /** 每段幾分鐘，太長會超過單次請求的大小限制 */
  transcribeChunkMin: Number(process.env.TRANSCRIBE_CHUNK_MIN ?? 20),
  /** 錄完自動轉錄 */
  transcribeAuto: process.env.TRANSCRIBE_AUTO !== "0",
  /** 同一個來源多久內不重抓（分鐘） */
  sourceMinIntervalMin: Number(process.env.SOURCE_MIN_INTERVAL_MIN ?? 10),
};

export function isAllowed(userId: string) {
  return config.allowedUserIds.length === 0 || config.allowedUserIds.includes(userId);
}
export function isAdmin(userId: string) {
  return config.adminUserIds.length === 0 || config.adminUserIds.includes(userId);
}
