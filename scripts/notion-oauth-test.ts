// Notion OAuth 測試：授權網址、換 token、401 自動 refresh、勾選頁面只留最上層、callback 伺服器。全部用假的 Notion API
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-notion-oauth-"));
Object.assign(process.env, {
  STATE_FILE: path.join(tmp, "state.json"),
  NOTION_OAUTH_CLIENT_ID: "cid",
  NOTION_OAUTH_CLIENT_SECRET: "csecret",
  PUBLIC_BASE_URL: "https://example.test/pm-bot/",
  HTTP_PORT: "18790",
  NOTION_TOKEN: "",
});
const oauth = await import("../src/sources/notion-oauth.js");
const { notion, sharedRoots } = await import("../src/sources/notion.js");
const { startHttp } = await import("../src/http.js");

const calls: { url: string; init: any }[] = [];
let accessValid = "at1";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init: any = {}) => {
  const u = String(url);
  if (!u.startsWith("https://api.notion.com")) return realFetch(url, init);
  calls.push({ url: u, init });
  const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
  const p = u.replace("https://api.notion.com/v1", "");
  if (p === "/oauth/token") {
    const b = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, "Basic " + Buffer.from("cid:csecret").toString("base64"));
    if (b.grant_type === "authorization_code") {
      if (b.code !== "good") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      assert.equal(b.redirect_uri, "https://example.test/pm-bot/notion/callback");
      return ok({ access_token: "at1", refresh_token: "rt1", bot_id: "b", workspace_id: "w", workspace_name: "我的工作區", owner: {} });
    }
    if (b.grant_type === "refresh_token") {
      assert.equal(b.refresh_token, "rt1");
      accessValid = "at2";
      return ok({ access_token: "at2", refresh_token: "rt2" });
    }
  }
  if (init.headers?.Authorization !== `Bearer ${accessValid}`) return new Response(JSON.stringify({ code: "unauthorized" }), { status: 401 });
  if (p === "/users/me") return ok({ id: "b" });
  if (p === "/search")
    return ok({
      has_more: false,
      results: [
        { object: "page", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", url: "https://www.notion.so/Root-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", parent: { type: "workspace" }, properties: { t: { type: "title", title: [{ plain_text: "專案首頁" }] } } },
        { object: "page", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", url: "https://www.notion.so/b", parent: { type: "page_id", page_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, properties: {} },
        { object: "page", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", url: "https://www.notion.so/c", parent: { type: "block_id", block_id: "blk1" }, properties: {} },
        { object: "database", id: "dddddddd-dddd-dddd-dddd-dddddddddddd", url: "https://www.notion.so/d", parent: { type: "page_id", page_id: "99999999-9999-9999-9999-999999999999" }, title: [{ plain_text: "任務表" }] },
        { object: "page", id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", url: "https://www.notion.so/e", parent: { type: "database_id", database_id: "dddddddd-dddd-dddd-dddd-dddddddddddd" }, properties: {} },
        { object: "page", id: "ffffffff-ffff-ffff-ffff-ffffffffffff", url: "https://www.notion.so/f", archived: true, parent: { type: "workspace" }, properties: {} },
      ],
    });
  if (p === "/blocks/blk1") return ok({ id: "blk1", parent: { type: "page_id", page_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" } });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

// 授權網址
assert.ok(oauth.oauthConfigured());
const ctx = { projectId: "abc123", userId: "u1", channelId: "c1" };
const url = new URL(oauth.authorizeUrl(ctx));
assert.equal(url.origin + url.pathname, "https://api.notion.com/v1/oauth/authorize");
assert.equal(url.searchParams.get("client_id"), "cid");
assert.equal(url.searchParams.get("owner"), "user");
assert.equal(url.searchParams.get("response_type"), "code");
assert.equal(url.searchParams.get("redirect_uri"), "https://example.test/pm-bot/notion/callback", "PUBLIC_BASE_URL 結尾的 / 要去掉");
const state = url.searchParams.get("state")!;
assert.ok(state.length >= 20);
console.log("✓ 授權網址");

// 換 token
await assert.rejects(oauth.finishAuth("good", "wrong-state"), /過期或用過/);
const { ctx: back, auth } = await oauth.finishAuth("good", state);
assert.deepEqual(back.projectId, "abc123");
assert.equal(auth.workspaceName, "我的工作區");
await assert.rejects(oauth.finishAuth("good", state), /過期或用過/, "state 只能用一次");
const f = path.join(tmp, "notion-auth.json");
assert.equal(fs.statSync(f).mode & 0o777, 0o600, "token 檔權限 600");
assert.equal(JSON.parse(fs.readFileSync(f, "utf8")).abc123.refreshToken, "rt1");
assert.equal(oauth.credFor("nope"), null, "沒授權、也沒 NOTION_TOKEN 的專案拿不到憑證");
console.log("✓ 換 token、存檔");

// 401 → refresh → 重試；新的 refresh token 要存起來
accessValid = "expired";
const cred = oauth.credFor("abc123")!;
// 讓 refresh 之後 at2 才有效
let refreshCalls = 0;
const origRefresh = cred.refresh!;
cred.refresh = () => (refreshCalls++, origRefresh());
assert.deepEqual(await notion(cred, "GET", "/users/me"), { id: "b" });
assert.equal(refreshCalls, 1);
assert.equal(cred.token, "at2");
const saved = JSON.parse(fs.readFileSync(f, "utf8")).abc123;
assert.equal(saved.accessToken, "at2");
assert.equal(saved.refreshToken, "rt2", "refresh token 會輪替，要存新的");
console.log("✓ 401 自動 refresh");

// 勾選的頁面只留最上層
const roots = await sharedRoots(oauth.credFor("abc123")!);
assert.deepEqual(
  roots.map((r) => [r.id[0], r.title, r.type]),
  [
    ["a", "專案首頁", "page"],
    ["d", "任務表", "database"],
  ],
  "子頁面、欄位裡的頁面、資料庫的列、封存的頁面都不算",
);
console.log("✓ 只連最上層頁面");

// callback 伺服器：有沒有 /pm-bot 前綴都接、錯誤頁、HTML escape
const seen: string[] = [];
const server = startHttp(async (q) => {
  seen.push(q.get("code") ?? q.get("error") ?? "");
  if (q.get("error")) return { ok: false, message: "取消 <b>" };
  return { ok: true, message: "好" };
})!;
await new Promise((r) => server.once("listening", r));
const base = "http://127.0.0.1:18790";
let r = await realFetch(`${base}/pm-bot/notion/callback?code=x&state=y`);
assert.equal(r.status, 200);
assert.match(await r.text(), /授權完成/);
r = await realFetch(`${base}/notion/callback?error=access_denied`);
assert.equal(r.status, 400);
const html = await r.text();
assert.ok(html.includes("取消 &lt;b&gt;") && !html.includes("<b>"), "訊息要 escape");
assert.equal((await realFetch(`${base}/pm-bot/healthz`)).status, 200);
assert.equal((await realFetch(`${base}/other`)).status, 404);
assert.deepEqual(seen, ["x", "access_denied"]);
server.close();
console.log("✓ callback 伺服器");


// 每個專案只看得到自己授權時勾的頁面
{
  oauth._reset();
  fs.writeFileSync(f, JSON.stringify({ A: { accessToken: "x", pages: undefined }, B: { accessToken: "y" } }));
  assert.deepEqual(oauth.claimPages("A", ["p1", "p2"]), ["p1", "p2"], "第一個專案：目前的頁面都算它的");
  assert.deepEqual(oauth.claimPages("B", ["p1", "p2"]), [], "B 授權時沒新勾：A 的頁面不會出現在 B");
  assert.deepEqual(oauth.claimPages("B", ["p1", "p2", "p3"]), ["p3"], "B 新勾的 p3 算 B 的");
  assert.deepEqual(oauth.claimPages("A", ["p2", "p3"]), ["p2"], "A 取消勾 p1 就拿掉；p3 是 B 的不算 A");
  assert.deepEqual(oauth.grantedPages("B"), ["p3"]);
  console.log("✓ 頁面歸屬各專案");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("all ok");
