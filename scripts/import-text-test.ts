// 「回覆音檔 @bot 說一句」→ 標題、時間、與會者
import assert from "node:assert/strict";
import { parseImportText } from "../src/meeting/import.js";

let r = parseImportText("10/13 的小組會議，與會者 Alice、Bob，幫我轉逐字稿", "rec.m4a");
assert.equal(r.title, "小組會議");
assert.equal(r.startedAt?.getMonth(), 9);
assert.equal(r.startedAt?.getDate(), 13);
assert.deepEqual(r.people, ["Alice", "Bob"]);

r = parseImportText("轉逐字稿", "第三次會議 錄音.m4a");
assert.equal(r.title, "第三次會議 錄音", "只有指令字就用檔名");
assert.equal(r.startedAt, undefined);
assert.deepEqual(r.people, []);

r = parseImportText("", "voice-memo.mp3");
assert.equal(r.title, "voice-memo");

r = parseImportText("這是 2026-10-12 14:30 跟客戶的會議錄音 請整理成會議紀錄", "x.wav");
assert.equal(r.title, "跟客戶的會議");
assert.equal(r.startedAt?.getHours(), 14);

r = parseImportText("期中報告討論 參與者：小明, 小華, 小美", "a.m4a");
assert.equal(r.title, "期中報告討論");
assert.deepEqual(r.people, ["小明", "小華", "小美"]);
console.log("✓ 訊息文字解析");
