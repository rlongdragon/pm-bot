// /link 測試：GitHub 實際打 API（公開 repo、不帶 token），Notion 用假資料測轉換
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store.js";
import { addLink, linkDir, parseLink, syncLinks } from "../src/sources/index.js";
import { parseNotion, renderBlocks, propText } from "../src/sources/notion.js";

// 網址解析
assert.deepEqual(parseLink("https://github.com/anthropics/claude-code/issues/1"), { type: "github", target: "anthropics/claude-code" });
assert.deepEqual(parseLink("owner/repo.js"), { type: "github", target: "owner/repo.js" });
assert.equal(parseNotion("https://www.notion.so/ws/My-Page-0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
assert.equal(
  parseNotion("https://www.notion.so/ws/fedcba9876543210fedcba9876543210?v=0123456789abcdef0123456789abcdef"),
  "fedcba9876543210fedcba9876543210",
  "資料庫網址取 path 的 id，不是 ?v= 的 view id",
);
assert.equal(parseNotion("https://www.notion.so/ws/Release-Page-fedcba9876543210fedcba987654321a"), "fedcba9876543210fedcba987654321a", "標題結尾是 a-f 也不能吃到");
assert.equal(parseNotion("0123abcd-0123-4567-89ab-0123456789ab"), "0123abcd0123456789ab0123456789ab", "dashed uuid");
assert.equal(parseNotion("https://myteam.notion.site/Public-Doc-0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef");
assert.equal(parseNotion("https://app.notion.com/p/0123456789abcdef0123456789abcdef"), "0123456789abcdef0123456789abcdef", "API 回的 app.notion.com/p/ 網址");
assert.deepEqual(parseLink("https://app.notion.com/p/0123456789abcdef0123456789abcdef"), { type: "notion", target: "0123456789abcdef0123456789abcdef" });
assert.equal(parseLink("https://example.com/x"), null);
console.log("✓ 網址解析");

// Notion blocks 轉 markdown
const T = (s: string, extra = {}) => [{ plain_text: s, annotations: {}, ...extra }];
const blocks = [
  { id: "1", type: "heading_1", heading_1: { rich_text: T("會議記錄") } },
  { id: "2", type: "paragraph", paragraph: { rich_text: [...T("決定用 "), { plain_text: "FastAPI", annotations: { bold: true } }] } },
  { id: "3", type: "to_do", to_do: { rich_text: T("登入頁"), checked: false } },
  { id: "4", type: "to_do", to_do: { rich_text: T("API 文件"), checked: true } },
  { id: "5", type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: T("子項目父") } },
  { id: "6", type: "numbered_list_item", numbered_list_item: { rich_text: T("一") } },
  { id: "7", type: "numbered_list_item", numbered_list_item: { rich_text: T("二") } },
  { id: "8", type: "table", has_children: true, table: {} },
  { id: "9", type: "child_page", has_children: true, child_page: { title: "子頁面" } },
];
const kids: Record<string, any[]> = {
  "5": [{ id: "5a", type: "bulleted_list_item", bulleted_list_item: { rich_text: T("孫") } }],
  "8": [
    { id: "8a", type: "table_row", table_row: { cells: [T("欄1"), T("欄2")] } },
    { id: "8b", type: "table_row", table_row: { cells: [T("a"), T("b|c")] } },
  ],
  "9": [{ id: "9a", type: "paragraph", paragraph: { rich_text: T("子頁內容") } }],
};
const md = await renderBlocks(blocks, async (id) => kids[id] ?? []);
for (const want of ["# 會議記錄", "決定用 **FastAPI**", "- [ ] 登入頁", "- [x] API 文件", "- 子項目父\n  - 孫", "1. 一\n2. 二", "| 欄1 | 欄2 |\n| --- | --- |\n| a | b\\|c |", "## 📄 子頁面", "子頁內容"]) {
  assert.ok(md.includes(want), `缺：${want}\n---\n${md}`);
}
assert.equal(propText({ type: "status", status: { name: "進行中" } }), "進行中");
assert.equal(propText({ type: "people", people: [{ name: "Alice" }] }), "Alice");
assert.equal(propText({ type: "date", date: { start: "2026-10-21", end: null } }), "2026-10-21");
console.log("✓ Notion 轉 markdown");

// GitHub 實打
const repo = process.argv[2];
store.load();
const p = store.createProject("link 測試");
const l = await addLink(p, `https://github.com/${repo}`);
const dir = linkDir(p.id, l);
console.log(`✓ GitHub 加入 ${l.title}，檔案：${fs.readdirSync(dir).join("、")}`);
console.log("  issues.md 開頭：" + fs.readFileSync(path.join(dir, "issues.md"), "utf8").split("\n").slice(0, 4).join(" / ").slice(0, 200));
console.log("  commits.md 第一筆：" + (fs.readFileSync(path.join(dir, "commits.md"), "utf8").split("\n")[2] ?? "").slice(0, 150));
const again = await syncLinks(p, true);
assert.equal(again.changed, false, "第二次同步應該沒變（ETag 304）");
assert.deepEqual(again.errors, []);
console.log("✓ 第二次同步沒有變動（ETag 304）");
await assert.rejects(addLink(p, `https://github.com/${repo}`), /已經連過/);
await assert.rejects(addLink(p, "https://github.com/rlongdragon/this-repo-does-not-exist-xyz"), /找不到 repo/);
assert.equal(p.links?.length, 1, "失敗的不會加進去");
console.log("✓ 重複、不存在的 repo 會被擋下");
