// store 單元測試，不呼叫模型。用 KNOWLEDGE_DIR 指到暫存目錄跑
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as store from "../src/store.js";

store.load();
const a = store.createProject("登入系統 v2", "u1");
const b = store.createProject("後端");
assert.match(a.id, /^[2-9a-hjkmnp-z]{6}$/, "ID 格式");
assert.notEqual(a.id, b.id);
assert.ok(fs.existsSync(path.join(store.projectDir(a.id), "STATE.md")));
assert.equal(store.getProject(a.id.toUpperCase() + " ")?.id, a.id, "ID 不分大小寫、會 trim");

store.joinChannel(a.id, "c1", true);
store.joinChannel(a.id, "c2", false);
assert.equal(store.projectByChannel("c2")?.id, a.id);
assert.throws(() => store.joinChannel(b.id, "c1", false), /已經在專案/, "一個頻道只能在一個專案");
store.setSession(a, "mention:c2", "s1");
assert.equal(store.getSession(a, "mention:c2"), "s1");
store.exitChannel("c2");
assert.equal(store.projectByChannel("c2"), undefined);
assert.equal(a.sessions["mention:c2"], undefined, "離開頻道清掉 session");
assert.equal(a.primaryChannel, "c1");
assert.throws(() => store.joinChannel("zzzzzz", "c9", false), /找不到/);

const base = { project: a.id, channelName: "general", author: "Alice", authorId: "111", attachments: [], messageUrl: "https://x" };
const r1 = store.appendRaw({ ...base, text: "第一則" });
const r2 = store.appendRaw({ ...base, text: "第二則\n換行", context: ["被回覆的訊息：", "> 10:00 **Bob**：原句"] });
const r3 = store.appendRaw({ ...base, text: "第三則" });
assert.deepEqual(store.pendingIds(a.id), [r1.id, r2.id, r3.id]);
assert.match(r2.block, /被回覆的訊息/);
store.removePending(a.id, [r2.id]);
assert.deepEqual(store.pendingIds(a.id), [r1.id, r3.id], "只移除處理過的那筆");
store.removePending(a.id, [r1.id, r3.id]);
assert.deepEqual(store.pendingIds(a.id), []);

fs.appendFileSync(path.join(store.projectDir(a.id), "STATE.md"), "\n- [ ] 任務一\n- [ ] 任務二\n- [x] 完成一\n");
fs.appendFileSync(path.join(store.projectDir(a.id), "decisions.md"), "- 2026-10-13 用 FastAPI\n");
fs.writeFileSync(path.join(store.projectDir(a.id), "notes", "r.md"), "x");
const s = store.stats(a.id);
assert.deepEqual(
  { records: s.records, open: s.openTasks, done: s.doneTasks, dec: s.decisions, notes: s.notes, pending: s.pending },
  { records: 3, open: 2, done: 1, dec: 1, notes: 1, pending: 0 },
);

store.closeProject(a.id);
assert.equal(store.projectByChannel("c1"), undefined, "結束的專案不再回應");
assert.throws(() => store.joinChannel(a.id, "c3", false), /已結束/);
store.load();
assert.equal(store.getProject(a.id)?.status, "closed", "重載後狀態保留");
console.log(`store 測試全過（ID 範例：${a.id}、${b.id}）`);
