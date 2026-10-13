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

const allowed = list(process.env.ALLOWED_USER_IDS);
const admins = list(process.env.ADMIN_USER_IDS);

export const config = {
  discordToken: process.env.DISCORD_TOKEN ?? "",
  discordClientId: process.env.DISCORD_CLIENT_ID ?? "",
  discordGuildId: process.env.DISCORD_GUILD_ID || undefined,
  allowedUserIds: allowed,
  adminUserIds: admins.length ? admins : allowed,
  knowledgeDir: path.resolve(process.env.KNOWLEDGE_DIR || "./knowledge"),
  stateFile: path.resolve(process.env.STATE_FILE || "./data/state.json"),
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir(),
  model: process.env.PM_MODEL || undefined,
  digestIntervalMin: Number(process.env.DIGEST_INTERVAL_MIN ?? 15),
  maxTurns: Number(process.env.MAX_TURNS ?? 40),
};

export function isAllowed(userId: string) {
  return config.allowedUserIds.length === 0 || config.allowedUserIds.includes(userId);
}
export function isAdmin(userId: string) {
  return config.adminUserIds.length === 0 || config.adminUserIds.includes(userId);
}
