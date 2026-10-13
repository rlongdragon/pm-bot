import assert from "node:assert/strict";
import { parseBlocks } from "../src/meeting/transcribe.js";
const out = `以下為音訊的完整 1:1 逐字稿：

[00:02 - 00:05]
rlongdragon 阿龍：所以 KTK 講一下話。

[00:41 - 00:46]
rlongdragon 阿龍：影片放投影片就好了吧？
影片是錄或是你可以現場 demo 就沒問題啊。
KTK：哦，好。

**[01:02:03 - 01:02:09]**
A: 時:分:秒格式

[00:53] KTK：單行格式`;
const b = parseBlocks(out, 1200);
assert.equal(b.length, 4);
assert.deepEqual([b[0].start, b[0].end], [1202, 1205], "加上 offset");
assert.equal(b[1].lines.length, 2);
assert.equal(b[1].lines[0].text, "影片放投影片就好了吧？影片是錄或是你可以現場 demo 就沒問題啊。", "換行接續同一人");
assert.equal(b[2].start, 1200 + 3723);
assert.equal(b[2].lines[0].speaker, "A");
assert.deepEqual(b[3].lines[0], { speaker: "KTK", text: "單行格式" });
console.log("✓ 段落解析");
