/**
 * Notion OAuth：使用者按「授權 Notion」，在 Notion 的頁面挑選器勾要給 bot 看的頁面就好，不用複製 token。
 * 每個專案一組 token，存在 data/notion-auth.json（權限 600，不進筆記 git）。
 * access token 過期（401）時用 refresh token 換新的；Notion 每次都會換一組新的 refresh token。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { NotionCred } from "./notion.js";

const API = "https://api.notion.com/v1";

export function oauthConfigured(): boolean {
  return !!(config.notionClientId && config.notionClientSecret && config.publicBaseUrl);
}

export function redirectUri(): string {
  return `${config.publicBaseUrl}/notion/callback`;
}

/* ---------- token 儲存 ---------- */

export interface NotionAuth {
  accessToken: string;
  refreshToken?: string;
  workspaceId: string;
  workspaceName: string;
  botId: string;
  by: string;
  at: string;
  /**
   * 這個專案授權時「新勾」的最上層頁面 id。Notion 的授權是整個工作空間共用的，
   * 勾過的頁面每個專案的 token 都讀得到，所以 bot 自己記「哪一頁是在哪個專案勾的」，選單只列自己的。
   * undefined = 舊資料還沒算過。
   */
  pages?: string[];
}

const file = () => path.join(path.dirname(config.stateFile), "notion-auth.json");

let cache: Record<string, NotionAuth> | null = null;
function all(): Record<string, NotionAuth> {
  if (!cache) {
    try {
      cache = JSON.parse(fs.readFileSync(file(), "utf8"));
    } catch {
      cache = {};
    }
  }
  return cache!;
}
function save() {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const tmp = file() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(all(), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file());
}

export function authOf(projectId: string): NotionAuth | undefined {
  return all()[projectId];
}

export function forget(projectId: string): boolean {
  if (!all()[projectId]) return false;
  delete all()[projectId];
  save();
  return true;
}

/* ---------- 授權流程 ---------- */

export interface AuthContext {
  projectId: string;
  userId: string;
  channelId: string;
}

const STATE_TTL = 15 * 60_000;
const pending = new Map<string, AuthContext & { exp: number }>();

/** 產生授權網址。state 是一次性的亂數，只交給下指令的人 */
export function authorizeUrl(ctx: AuthContext): string {
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const state = crypto.randomBytes(18).toString("base64url");
  pending.set(state, { ...ctx, exp: Date.now() + STATE_TTL });
  const q = new URLSearchParams({ client_id: config.notionClientId!, response_type: "code", owner: "user", redirect_uri: redirectUri(), state });
  return `${API}/oauth/authorize?${q}`;
}

async function tokenRequest(body: Record<string, string>): Promise<any> {
  const basic = Buffer.from(`${config.notionClientId}:${config.notionClientSecret}`).toString("base64");
  const r = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`Notion 授權失敗（${r.status} ${j.error ?? j.code ?? ""}）：${j.error_description ?? j.message ?? ""}`) as Error & { status: number };
    e.status = r.status;
    throw e;
  }
  return j;
}

/** callback 收到 code：換 token、存起來。state 不對或過期就丟錯 */
export async function finishAuth(code: string, state: string): Promise<{ ctx: AuthContext; auth: NotionAuth }> {
  const ctx = pending.get(state);
  pending.delete(state);
  if (!ctx || ctx.exp < Date.now()) throw new Error("這個授權連結過期或用過了，回 Discord 重新 /link notion");
  const j = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });
  const auth: NotionAuth = {
    accessToken: j.access_token,
    refreshToken: j.refresh_token ?? undefined,
    workspaceId: j.workspace_id,
    workspaceName: j.workspace_name ?? "Notion",
    botId: j.bot_id,
    by: ctx.userId,
    at: new Date().toISOString(),
  };
  const prev = all()[ctx.projectId];
  auth.pages = prev?.pages;
  all()[ctx.projectId] = auth;
  save();
  return { ctx, auth };
}

/** 別的專案已經認領的頁面 */
function grantedElsewhere(projectId: string): Set<string> {
  const s = new Set<string>();
  for (const [pid, a] of Object.entries(all())) if (pid !== projectId) for (const id of a.pages ?? []) s.add(id);
  return s;
}

/**
 * 授權完（或第一次用舊資料）對一下目前讀得到的最上層頁面：
 * 不屬於別的專案的就算這個專案的，記下來。回傳這個專案現在能用的頁面 id。
 */
export function claimPages(projectId: string, currentRootIds: string[]): string[] {
  const a = all()[projectId];
  if (!a) return [];
  const others = grantedElsewhere(projectId);
  const mine = new Set(a.pages ?? []);
  for (const id of currentRootIds) if (!others.has(id)) mine.add(id);
  // 被取消勾選的頁面就不留了
  const cur = new Set(currentRootIds);
  a.pages = [...mine].filter((id) => cur.has(id));
  save();
  return a.pages;
}

export function grantedPages(projectId: string): string[] {
  return all()[projectId]?.pages ?? [];
}

const refreshing = new Map<string, Promise<string | null>>();

/** 同一個專案同時只換一次：refresh token 換過就失效，並行換會把彼此弄壞 */
function refresh(projectId: string): Promise<string | null> {
  let p = refreshing.get(projectId);
  if (!p) {
    p = (async () => {
      const a = authOf(projectId);
      if (!a?.refreshToken || !oauthConfigured()) return null;
      const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: a.refreshToken });
      a.accessToken = j.access_token;
      if (j.refresh_token) a.refreshToken = j.refresh_token;
      save();
      console.log(`[notion] ${projectId} token refreshed`);
      return a.accessToken;
    })().finally(() => refreshing.delete(projectId));
    refreshing.set(projectId, p);
  }
  return p;
}

/** 這個專案讀 Notion 用的憑證：有授權用授權的，沒有退回 .env 的 NOTION_TOKEN */
export function credFor(projectId: string, fallback = config.notionToken): NotionCred | null {
  const a = authOf(projectId);
  if (a) return { token: a.accessToken, refresh: () => refresh(projectId) };
  return fallback ? { token: fallback } : null;
}

/** 測試用 */
export function _reset() {
  cache = null;
  pending.clear();
  refreshing.clear();
}
