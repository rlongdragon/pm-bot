// 看板測試：STATE.md 解析 + 用假的 Notion API 測 pushBoard 的新增、更新、封存
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store.js";
import { parseState, pushBoard } from "../src/board.js";

const STATE = `# 登入系統（abc123）

## 目標

做完登入系統。

## 進行中

- [ ] 登入頁 UI — @Alice — 期限 2026-10-21（下週三，待確認） — 來源 raw 2026-10-13#2 — 更新 2026-10-13
- [ ] 部署 — @Bob @Carol — 期限 未定 — 來源 raw 2026-10-13#4 — 更新 2026-10-13

## 阻塞 / 待決

- 要不要支援 Google 登入 — PM 決定 — 來源 raw 2026-10-13#5

## 下一步

- 後端 API 以 FastAPI 開工 — 來源 raw 2026-10-13#1

## 最近完成

（無）
`;

const cards = parseState(STATE);
const by = Object.fromEntries(cards.map((c) => [c.title, c]));
assert.equal(cards.length, 4);
assert.deepEqual(
  { s: by["登入頁 UI"].status, o: by["登入頁 UI"].owner, d: by["登入頁 UI"].due, n: by["登入頁 UI"].note, src: by["登入頁 UI"].source, u: by["登入頁 UI"].updated },
  { s: "進行中", o: "Alice", d: "2026-10-21", n: "下週三，待確認", src: "2026-10-13#2", u: "2026-10-13" },
);
assert.equal(by["部署"].owner, "Bob Carol");
assert.equal(by["部署"].due, null);
assert.equal(by["部署"].note, "未定");
assert.equal(by["要不要支援 Google 登入"].status, "待決");
assert.equal(by["後端 API 以 FastAPI 開工"].status, "下一步");
console.log("✓ STATE.md 解析");

// 假 Notion
const rows = new Map<string, any>();
let n = 0;
const calls: string[] = [];
const toProp = (props: any) => {
  const out: any = {};
  for (const [k, v] of Object.entries<any>(props)) {
    if (v.title) out[k] = { type: "title", title: v.title.map((t: any) => ({ plain_text: t.text.content })) };
    else if (v.rich_text) out[k] = { type: "rich_text", rich_text: v.rich_text.map((t: any) => ({ plain_text: t.text.content })) };
    else if ("select" in v) out[k] = { type: "select", select: v.select };
    else if ("date" in v) out[k] = { type: "date", date: v.date };
  }
  return out;
};
globalThis.fetch = (async (url: string, init: any) => {
  const u = String(url).replace("https://api.notion.com/v1", "");
  const body = init?.body ? JSON.parse(init.body) : {};
  calls.push(`${init.method} ${u.split("/")[1]}`);
  const ok = (j: any) => new Response(JSON.stringify(j), { status: 200 });
  if (init.method === "POST" && u.endsWith("/query")) return ok({ results: [...rows.values()].filter((r) => !r.archived), has_more: false });
  if (init.method === "POST" && u === "/pages") {
    const id = "row" + ++n;
    rows.set(id, { id, properties: toProp(body.properties) });
    return ok(rows.get(id));
  }
  if (init.method === "PATCH" && u.startsWith("/pages/")) {
    const r = rows.get(u.split("/")[2])!;
    if (body.archived) r.archived = true;
    if (body.properties) r.properties = toProp(body.properties);
    return ok(r);
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

process.env.NOTION_TOKEN = "fake";
store.load();
const p = store.createProject("登入系統");
p.board = { databaseId: "0123456789abcdef0123456789abcdef", url: "https://notion.so/x" };
const statePath = path.join(store.projectDir(p.id), "STATE.md");
fs.writeFileSync(statePath, STATE);

const r1 = await pushBoard(p);
assert.deepEqual(r1, { created: 4, updated: 0, archived: 0 });
console.log("✓ 第一次推：新增 4 張");

calls.length = 0;
const r2 = await pushBoard(p);
assert.deepEqual(r2, { created: 0, updated: 0, archived: 0 });
assert.deepEqual(calls, ["POST databases"], "沒變動時只查一次，不寫");
console.log("✓ 沒變動時只查詢、不寫入");

// 登入頁完成、部署被刪掉、新增一條
const s2 = STATE.replace("- [ ] 登入頁 UI — @Alice — 期限 2026-10-21（下週三，待確認） — 來源 raw 2026-10-13#2 — 更新 2026-10-13\n", "")
  .replace(/- \[ \] 部署.*\n/, "- [ ] API 文件 — @Bob — 期限 2026-10-25 — 來源 raw 2026-10-14#1 — 更新 2026-10-14\n")
  .replace("## 最近完成\n\n（無）", "## 最近完成\n\n- [x] 登入頁 UI — @Alice — 2026-10-20");
fs.writeFileSync(statePath, s2);
const r3 = await pushBoard(p);
assert.deepEqual(r3, { created: 1, updated: 1, archived: 1 });
const live = [...rows.values()].filter((r) => !r.archived).map((r) => `${r.properties["任務"].title[0].plain_text}:${r.properties["狀態"].select.name}`);
assert.ok(live.includes("登入頁 UI:完成"), "同一張卡搬到完成");
assert.ok(!live.some((x) => x.startsWith("部署")), "刪掉的封存");
assert.ok(live.includes("API 文件:進行中"));
console.log("✓ 完成的搬欄、刪掉的封存、新的新增：" + live.join("、"));
