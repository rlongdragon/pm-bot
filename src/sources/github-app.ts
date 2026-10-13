/**
 * GitHub App 認證：使用者在 GitHub 的安裝頁面勾 repo 就算授權，不用複製 token。
 * bot 用 App 的私鑰簽 JWT，換成一小時有效的 installation token，快過期自動重換。
 * 權限在建 App 時就鎖成唯讀（Contents、Issues、Pull requests、Metadata）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { config } from "../config.js";

const API = "https://api.github.com";

export function appConfigured(): boolean {
  return !!(config.githubAppId && config.githubAppKeyFile);
}

function b64url(b: Buffer | string) {
  return Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

let keyCache: crypto.KeyObject | null = null;
function privateKey(): crypto.KeyObject {
  if (!keyCache) {
    if (!config.githubAppKeyFile || !fs.existsSync(config.githubAppKeyFile)) throw new Error(`找不到 GitHub App 私鑰：${config.githubAppKeyFile}`);
    keyCache = crypto.createPrivateKey(fs.readFileSync(config.githubAppKeyFile, "utf8"));
  }
  return keyCache;
}

/** App 本身的 JWT，最多 10 分鐘；iat 往前 60 秒避免時鐘誤差 */
export function appJwt(now = Math.floor(Date.now() / 1000)): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(config.githubAppId) }));
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey());
  return `${head}.${body}.${b64url(sig)}`;
}

async function asApp(method: string, endpoint: string): Promise<{ status: number; body: any }> {
  const r = await fetch(API + endpoint, {
    method,
    headers: { Authorization: `Bearer ${appJwt()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "pm-bot" },
    signal: AbortSignal.timeout(20_000),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

let slugCache: string | null = null;
/** 安裝頁面：https://github.com/apps/<slug>/installations/new */
export async function installUrl(): Promise<string> {
  if (!slugCache) {
    const r = await asApp("GET", "/app");
    if (r.status !== 200) throw new Error(`讀不到 GitHub App 資訊（${r.status}）。檢查 GITHUB_APP_ID 和私鑰是不是同一個 App`);
    slugCache = r.body.slug as string;
  }
  return `https://github.com/apps/${slugCache}/installations/new`;
}

const installCache = new Map<string, { id: number | null; at: number }>();
const tokenCache = new Map<number, { token: string; expires: number }>();

/** 這個 repo 有沒有裝 App；有的話回 installation id。沒裝的結果只快取 1 分鐘，裝完很快就生效 */
async function installationFor(repo: string): Promise<number | null> {
  const c = installCache.get(repo);
  if (c && Date.now() - c.at < (c.id ? 10 * 60_000 : 60_000)) return c.id;
  const r = await asApp("GET", `/repos/${repo}/installation`);
  if (r.status !== 200 && r.status !== 404) throw new Error(`查 GitHub App 安裝狀態失敗（${r.status}）：${JSON.stringify(r.body).slice(0, 150)}`);
  const id = r.status === 200 ? (r.body.id as number) : null;
  installCache.set(repo, { id, at: Date.now() });
  return id;
}

/** 回這個 repo 用的 installation token；App 沒裝在這個 repo 回 null */
export async function tokenForRepo(repo: string): Promise<string | null> {
  if (!appConfigured()) return null;
  const inst = await installationFor(repo);
  if (!inst) return null;
  const c = tokenCache.get(inst);
  if (c && c.expires - Date.now() > 5 * 60_000) return c.token;
  const r = await asApp("POST", `/app/installations/${inst}/access_tokens`);
  if (r.status !== 201) {
    installCache.delete(repo);
    throw new Error(`換 GitHub App token 失敗（${r.status}）：${JSON.stringify(r.body).slice(0, 150)}`);
  }
  tokenCache.set(inst, { token: r.body.token, expires: Date.parse(r.body.expires_at) });
  return r.body.token as string;
}

/** 測試用 */
export function _resetCaches() {
  keyCache = null;
  slugCache = null;
  installCache.clear();
  tokenCache.clear();
}
