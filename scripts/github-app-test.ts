// GitHub App 認證測試：自己產生的 RSA 金鑰 + 假的 GitHub API
// GITHUB_APP_ID=12345 GITHUB_APP_PRIVATE_KEY_FILE=tmp-gha/key.pem KNOWLEDGE_DIR=... npx tsx scripts/github-app-test.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { appJwt } from "../src/sources/github-app.js";
import * as store from "../src/store.js";
import { addLink, syncLinks } from "../src/sources/index.js";

// 1. JWT
const jwt = appJwt(1_700_000_000);
const [h, b, sig] = jwt.split(".");
const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), fs.readFileSync("tmp-gha/pub.pem", "utf8"), Buffer.from(sig, "base64url"));
const payload = JSON.parse(Buffer.from(b, "base64url").toString());
assert.ok(ok, "簽章要能用公鑰驗過");
assert.deepEqual(payload, { iat: 1_700_000_000 - 60, exp: 1_700_000_000 + 540, iss: "12345" });
assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).alg, "RS256");
console.log("✓ JWT 簽章與內容");

// 2. 假 GitHub
let installed = false;
const calls: string[] = [];
const authSeen: string[] = [];
globalThis.fetch = (async (url: string, init: any = {}) => {
  const u = String(url).replace("https://api.github.com", "");
  const auth = init.headers?.Authorization ?? "";
  calls.push(`${init.method ?? "GET"} ${u.split("?")[0]}`);
  const json = (j: any, status = 200) => new Response(JSON.stringify(j), { status, headers: { etag: `"e-${u}"` } });
  if (u === "/app") return json({ slug: "rlong-pm-bot" });
  if (u === "/repos/team/secret/installation") return installed ? json({ id: 42 }) : json({ message: "Not Found" }, 404);
  if (u === "/app/installations/42/access_tokens") return json({ token: "ghs_test", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
  if (u.startsWith("/repos/team/secret")) {
    authSeen.push(auth);
    if (auth !== "Bearer ghs_test") return json({ message: "Not Found" }, 404); // 私有 repo：沒 token 看不到
    if (u === "/repos/team/secret") return json({ full_name: "team/secret", description: "d", html_url: "https://github.com/team/secret", default_branch: "main", private: true });
    if (u.startsWith("/repos/team/secret/readme")) return new Response("# readme", { status: 200 });
    if (u.startsWith("/repos/team/secret/issues")) return json([]);
    if (u.startsWith("/repos/team/secret/commits")) return json([]);
    return json({ message: "Not Found" }, 404);
  }
  return json({ message: "unexpected " + u }, 500);
}) as typeof fetch;

store.load();
const p = store.createProject("app 測試");
await assert.rejects(addLink(p, "https://github.com/team/secret"), (e: Error) => {
  assert.match(e.message, /https:\/\/github\.com\/apps\/rlong-pm-bot\/installations\/new/);
  return true;
});
assert.equal(p.links?.length ?? 0, 0);
console.log("✓ 沒安裝：回授權連結，不加進去");

installed = true;
await new Promise((r) => setTimeout(r, 61_000)); // 「沒安裝」的結果快取 1 分鐘
const l = await addLink(p, "https://github.com/team/secret");
assert.equal(l.title, "team/secret");
assert.ok(authSeen.slice(-3).every((a) => a === "Bearer ghs_test"), "安裝後用 installation token");
console.log("✓ 安裝後：換到 installation token、連上私有 repo");

const before = calls.filter((c) => c.includes("access_tokens")).length;
await syncLinks(p, true);
assert.equal(calls.filter((c) => c.includes("access_tokens")).length, before, "token 還沒過期就不重換");
console.log("✓ token 快取：再次同步不重換 token");
