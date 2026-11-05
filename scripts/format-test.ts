// Discord 表格轉換：窄表 → code block，其他 → 列點
import assert from "node:assert/strict";
import { formatTables, width } from "../src/discord/format.js";

assert.equal(width("abc"), 3);
assert.equal(width("阿龍"), 4);
assert.equal(width("１２"), 4, "全形");
assert.equal(width("✅"), 1, "BMP 符號算 1（Discord 字型多半也是）");
assert.equal(width("🎉"), 2);

// 截圖那張：太寬 → 列點
const wide = `已記下：小逗確認重分。

| 負責人 | Stories | 期限 |
|---|---|---|
| H4RRY- | US-18 | 11/13 |
| 阿龍 | US-10、US-11、US-12 | 11/13（忙到 11/11） |
| **KTK** | US-09 → US-20 | |

- 其他四人還沒回覆`;
assert.equal(
  formatTables(wide),
  `已記下：小逗確認重分。

-# 負責人 · Stories · 期限
- **H4RRY-**　US-18 · 11/13
- **阿龍**　US-10、US-11、US-12 · 11/13（忙到 11/11）
- **KTK**　US-09 → US-20

- 其他四人還沒回覆`,
);

// 小統計表 → code block，中文兩格寬對齊，數字欄自動靠右，粗體記號拿掉
const narrow = `本週完成：
| 成員 | 完成 | 進行中 |
|---|---|---|
| 阿龍 | 5 | 2 |
| **KTK** | 12 | 0 |
| H4RRY- | 3 | 1 |`;
assert.equal(
  formatTables(narrow),
  "本週完成：\n```\n" +
    ["成員    完成  進行中", "------  ----  ------", "阿龍       5       2", "KTK       12       0", "H4RRY-     3       1"].join("\n") +
    "\n```",
);

// 有 mention 或連結 → 就算很窄也走列點
assert.equal(formatTables("| 誰 | 數 |\n|---|---|\n| <@123> | 1 |"), "-# 誰 · 數\n- **<@123>**　1");
assert.equal(formatTables("| a | b |\n|---|---|\n| [x](https://e.com) | 1 |"), "-# a · b\n- **[x](https://e.com)**　1");

// 分隔線指定對齊
assert.equal(formatTables("| 名 | 說明 |\n|--:|:--|\n| 10 | x |\n| 2 | 12 |"), "```\n名  說明\n--  ----\n10  x\n 2  12\n```");

// 跳脫的 |
assert.equal(formatTables("| a | b |\n|:--|--:|\n| 1 | x \\| y |"), "```\na      b\n-  -----\n1  x | y\n```");
// 沒有前後 | 的不當表格（太容易誤判）
assert.equal(formatTables("a | b\n:-- | --:\n1 | 2"), "a | b\n:-- | --:\n1 | 2");
// code block 裡不動
const code = "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```";
assert.equal(formatTables(code), code);
// 不是表格的 | 不動
assert.equal(formatTables("A | B 都可以"), "A | B 都可以");
console.log("format-test ok");
