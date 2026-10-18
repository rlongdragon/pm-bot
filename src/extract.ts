import zlib from "node:zlib";

/**
 * Office 檔（pptx / docx / xlsx）抽文字。agent 沒有 Bash，Read 讀不了 zip，
 * 所以存附件時先轉成 markdown 放旁邊。
 * 只認 zip 裡的 XML，不跑任何外部程式。
 */

export const OFFICE_EXT = /\.(pptx|docx|xlsx)$/i;
const MAX_ENTRY = 32 * 1024 * 1024;

/** 最小 zip 讀取：讀 central directory，只支援 stored / deflate（Office 檔夠用） */
function unzip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 zip 檔");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error("zip 目錄壞了");
    const method = buf.readUInt16LE(off + 10);
    const size = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const local = buf.readUInt32LE(off + 42);
    const name = buf.toString("utf8", off + 46, off + 46 + nameLen);
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY }));
  }
  return out;
}

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e.toLowerCase()]!;
  });
}

/** 依段落（<a:p> / <w:p>）取出 <x:t> 文字，一段一行 */
function paragraphs(xml: string, ns: "a" | "w"): string[] {
  const out: string[] = [];
  for (const p of xml.split(new RegExp(`</${ns}:p>`))) {
    const line = [...p.matchAll(new RegExp(`<${ns}:(t|tab|br)\\b[^>]*?(?:/>|>([^<]*)</${ns}:t>)`, "g"))]
      .map((m) => (m[1] === "t" ? decode(m[2] ?? "") : m[1] === "tab" ? "\t" : "\n"))
      .join("")
      .trim();
    if (line) out.push(line);
  }
  return out;
}

const num = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);

function pptx(z: Map<string, Buffer>): string {
  const slides = [...z.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  return slides
    .map((k, i) => {
      let s = `## 第 ${i + 1} 頁\n\n${paragraphs(z.get(k)!.toString("utf8"), "a").join("\n")}\n`;
      const rels = z.get(k.replace("slides/", "slides/_rels/") + ".rels")?.toString("utf8") ?? "";
      const note = rels.match(/Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/)?.[1];
      const noteXml = note && z.get(`ppt/notesSlides/${note}`)?.toString("utf8");
      // 備忘稿第一段通常是頁碼佔位，濾掉純數字
      const notes = noteXml ? paragraphs(noteXml, "a").filter((l) => !/^\d+$/.test(l)) : [];
      if (notes.length) s += `\n> 備忘稿：${notes.join("\n> ")}\n`;
      return s;
    })
    .join("\n");
}

function docx(z: Map<string, Buffer>): string {
  const xml = z.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new Error("找不到 word/document.xml");
  return paragraphs(xml, "w").join("\n\n") + "\n";
}

function xlsx(z: Map<string, Buffer>): string {
  const shared = [...(z.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((t) => decode(t[1])).join(""),
  );
  const book = z.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const names = [...book.matchAll(/<sheet\b[^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
  const sheets = [...z.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
  return sheets
    .map((k, i) => {
      const rows = [...z.get(k)!.toString("utf8").matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
        [...r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
          .map((c) => {
            const v = c[2]?.match(/<v>([^<]*)<\/v>/)?.[1];
            if (/t="s"/.test(c[1])) return v === undefined ? "" : (shared[Number(v)] ?? "");
            if (/t="inlineStr"/.test(c[1])) return decode(c[2]?.match(/<t\b[^>]*>([^<]*)<\/t>/)?.[1] ?? "");
            return v === undefined ? "" : decode(v);
          })
          .join("\t")
          .replace(/\t+$/, ""),
      );
      return `## ${names[i] ?? `工作表 ${i + 1}`}\n\n${rows.filter(Boolean).join("\n")}\n`;
    })
    .join("\n");
}

/** 抽出文字轉成 markdown；不認得的格式回 null，壞檔丟錯 */
export function officeToMarkdown(name: string, buf: Buffer): string | null {
  const ext = name.match(OFFICE_EXT)?.[1].toLowerCase();
  if (!ext) return null;
  const z = unzip(buf);
  const body = ext === "pptx" ? pptx(z) : ext === "docx" ? docx(z) : xlsx(z);
  return `# ${name}\n\n（從 ${ext} 抽出的文字，圖片、圖表、版面沒有保留）\n\n${body}`;
}
