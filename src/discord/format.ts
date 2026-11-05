/**
 * Discord 不渲染 markdown 表格。送出前轉換：
 *   - 窄表（手機不會折行）而且沒有 mention、連結 → code block，中文算兩格寬補空白對齊
 *   - 其他 → 列點：
 *       -# 欄1 · 欄2 · 欄3
 *       - **第一欄**　第二欄 · 第三欄
 * 原本就在 code block 裡的不動。
 */

/** 手機上 code block 一行大約放得下這麼多半形字 */
export const CODE_MAX_WIDTH = 36;
const CODE_MAX_ROWS = 20;
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, "|").trim());
}

function render(rows: string[][], header?: string[]): string[] {
  const out: string[] = [];
  if (header?.some(Boolean)) out.push(`-# ${header.filter(Boolean).join(" · ")}`);
  for (const r of rows) {
    const [first, ...rest] = r;
    const tail = rest.filter((c) => c && c !== "-" && c !== "—").join(" · ");
    const lead = first ? (/^\*\*.*\*\*$/.test(first) ? first : `**${first}**`) : "";
    out.push(`- ${[lead, tail].filter(Boolean).join("　")}`);
  }
  return out;
}

/** 顯示寬度：中日韓、全形、emoji 算 2 */
export function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue; // ZWJ、變體選擇符
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff) ||
      (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

/** code block 裡 markdown 不會生效，把粗體、斜體、inline code 的記號拿掉 */
const plain = (c: string) => c.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/`([^`]+)`/g, "$1");
/** code block 裡會壞掉的東西：mention、頻道、連結、自訂表情、時間戳 */
const RICH = /<[@#][!&]?\d+>|<a?:\w+:\d+>|<t:\d+(:\w)?>|https?:\/\/|\]\(/;

/** 試著排成等寬表；不適合就回 null */
function asCode(header: string[], rows: string[][], align: ("l" | "r")[]): string[] | null {
  if (rows.length > CODE_MAX_ROWS) return null;
  const all = [header, ...rows];
  if (all.some((r) => r.some((c) => RICH.test(c)))) return null;
  const n = Math.max(...all.map((r) => r.length));
  const grid = all.map((r) => Array.from({ length: n }, (_, k) => plain(r[k] ?? "")));
  const colW = Array.from({ length: n }, (_, k) => Math.max(...grid.map((r) => width(r[k]))));
  const GAP = 2;
  if (colW.reduce((a, b) => a + b, 0) + GAP * (n - 1) > CODE_MAX_WIDTH) return null;
  const pad = (c: string, k: number) => {
    const sp = " ".repeat(colW[k] - width(c));
    return align[k] === "r" ? sp + c : c + sp;
  };
  const line = (r: string[]) => r.map(pad).join(" ".repeat(GAP)).trimEnd();
  return ["```", line(grid[0]), colW.map((w) => "-".repeat(w)).join(" ".repeat(GAP)), ...grid.slice(1).map(line), "```"];
}

/** 分隔線決定對齊：--: 靠右；沒標的話整欄都是數字也靠右 */
function alignOf(sep: string, rows: string[][], n: number): ("l" | "r")[] {
  const marks = cells(sep);
  return Array.from({ length: n }, (_, k) => {
    const m = marks[k] ?? "";
    if (/-:$/.test(m) && !/^:/.test(m)) return "r";
    if (/^:/.test(m)) return "l";
    const vals = rows.map((r) => r[k] ?? "").filter(Boolean);
    return vals.length && vals.every((v) => /^[-+]?[\d,.]+%?$/.test(v)) ? "r" : "l";
  });
}

export function formatTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) fence = !fence;
    // 表格 = 一行表頭 + 分隔線 + 若干列
    if (!fence && isRow(l) && SEP.test(lines[i + 1] ?? "")) {
      const header = cells(l);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && isRow(lines[j])) rows.push(cells(lines[j++]));
      const n = Math.max(header.length, ...rows.map((r) => r.length));
      out.push(...(asCode(header, rows, alignOf(lines[i + 1], rows, n)) ?? render(rows, header)));
      i = j - 1;
      continue;
    }
    out.push(l);
  }
  return out.join("\n");
}
