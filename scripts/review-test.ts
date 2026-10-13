// reviewer 狀態彙整單元測試 + 真實 repo 同步（用 .env 的 GitHub App）
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { summarizeReviews } from "../src/sources/github.js";
import * as store from "../src/store.js";
import { addLink, linkDir, syncLinks } from "../src/sources/index.js";

const R = (who: string, state: string, at: string, body = "") => ({ user: { login: who }, state, submitted_at: at, body });
const s = summarizeReviews([
  R("a", "COMMENTED", "2026-10-01"), R("a", "APPROVED", "2026-10-02"),
  R("b", "APPROVED", "2026-10-01"), R("b", "COMMENTED", "2026-10-03", "nit"),
  R("c", "CHANGES_REQUESTED", "2026-10-01"), R("c", "APPROVED", "2026-10-04"),
  R("d", "APPROVED", "2026-10-01"), R("d", "CHANGES_REQUESTED", "2026-10-05", "要改"),
  R("e", "COMMENTED", "2026-10-02"),
  R("f", "PENDING", "2026-10-02"),
]);
const m = Object.fromEntries(s.map((x) => [x.who, x.state]));
assert.deepEqual(m, { a: "APPROVED", b: "APPROVED", c: "APPROVED", d: "CHANGES_REQUESTED", e: "COMMENTED" });
console.log("✓ 審查狀態彙整：留言不會蓋掉核准或要求修改、草稿審查略過");

const repo = process.argv[2];
store.load();
const p = store.createProject("review 測試");
const l = await addLink(p, `https://github.com/${repo}`);
const md = fs.readFileSync(path.join(linkDir(p.id, l), "pulls.md"), "utf8");
console.log("\n" + md.split("## 全部 PR")[0].trim() + "\n");
const t0 = Date.now();
const again = await syncLinks(p, true);
assert.equal(again.changed, false, "第二次同步沒變動");
assert.deepEqual(again.errors, []);
console.log(`✓ 第二次同步沒有變動（${Date.now() - t0}ms，走 304 + 暫存）`);
