import path from "node:path";
import { config } from "../config.js";
import type { Link, SyncResult } from "./types.js";
import { oneLine, writeIfChanged } from "./write.js";

const API = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

/** 從 Notion 網址取出 32 碼 id（頁面或資料庫）。資料庫網址的 ?v= 是 view id，不要 */
export function parseNotion(input: string): string | null {
  const s = input.trim();
  let p = s;
  try {
    const u = new URL(s);
    if (!/(^|\.)notion\.(so|site)$/i.test(u.hostname)) return null;
    p = u.pathname;
  } catch {
    // 也接受直接貼 id
  }
  // 網址最後一段是「標題-<32碼>」或 dashed uuid；不能先去掉 - 再找，否則標題結尾的 a-f 會被算進去
  const seg = p.split("/").filter(Boolean).pop() ?? "";
  const m = seg.match(/([0-9a-f]{32})$/i) ?? seg.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  return m ? m[1].replace(/-/g, "").toLowerCase() : null;
}

export function dashed(id: string) {
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

let last = 0;
export async function notion(token: string, method: string, endpoint: string, body?: unknown): Promise<any> {
  // Notion 限制平均每秒 3 次
  const wait = last + 350 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const r = await fetch(API + endpoint, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": VERSION, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 429) {
    await new Promise((res) => setTimeout(res, Number(r.headers.get("retry-after") ?? 2) * 1000));
    return notion(token, method, endpoint, body);
  }
  if (!r.ok) {
    const e = new Error(`Notion ${r.status} ${j.code ?? ""}：${j.message ?? ""}`) as Error & { status: number; code?: string };
    e.status = r.status;
    e.code = j.code;
    throw e;
  }
  return j;
}

/* ---------- rich text / blocks 轉 markdown ---------- */

interface RichText {
  plain_text: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean };
}

export function rt(arr: RichText[] | undefined): string {
  return (arr ?? [])
    .map((t) => {
      let s = t.plain_text;
      if (!s) return "";
      const a = t.annotations ?? {};
      if (a.code) s = "`" + s + "`";
      if (a.bold) s = `**${s}**`;
      if (a.italic) s = `*${s}*`;
      if (a.strikethrough) s = `~~${s}~~`;
      if (t.href) s = `[${s}](${t.href})`;
      return s;
    })
    .join("");
}

export type FetchChildren = (blockId: string) => Promise<any[]>;

const MAX_BLOCKS = 3000;

/** blocks 轉 markdown。fetchChildren 注入，方便測試 */
export async function renderBlocks(blocks: any[], fetchChildren: FetchChildren, depth = 0, budget = { left: MAX_BLOCKS }): Promise<string> {
  const out: string[] = [];
  const ind = "  ".repeat(depth);
  let n = 0;
  for (const b of blocks) {
    if (budget.left-- <= 0) {
      out.push(`${ind}…（內容太長，後面省略）`);
      break;
    }
    const t = b.type as string;
    const d = b[t] ?? {};
    const text = rt(d.rich_text);
    n = t === "numbered_list_item" ? n + 1 : 0;
    let line: string | null = null;
    let childDepth = depth + 1;
    switch (t) {
      case "paragraph":
        line = text;
        childDepth = depth;
        break;
      case "heading_1":
      case "heading_2":
      case "heading_3":
        line = `${"#".repeat(Number(t.slice(-1)) + Math.min(depth, 2))} ${text}`;
        childDepth = depth;
        break;
      case "bulleted_list_item":
        line = `- ${text}`;
        break;
      case "numbered_list_item":
        line = `${n}. ${text}`;
        break;
      case "to_do":
        line = `- [${d.checked ? "x" : " "}] ${text}`;
        break;
      case "toggle":
        line = `- ${text}`;
        break;
      case "quote":
        line = `> ${text}`;
        break;
      case "callout":
        line = `> ${d.icon?.emoji ? d.icon.emoji + " " : ""}${text}`;
        break;
      case "code":
        line = "```" + (d.language ?? "") + "\n" + rt(d.rich_text) + "\n```";
        break;
      case "divider":
        line = "---";
        break;
      case "equation":
        line = `$${d.expression}$`;
        break;
      case "child_page":
        line = `\n## 📄 ${d.title}`;
        childDepth = depth;
        break;
      case "child_database":
        line = `📊 資料庫「${d.title}」（內容沒有展開，要看的話把它另外 /link）`;
        break;
      case "bookmark":
      case "embed":
      case "link_preview":
        line = `🔗 <${d.url}>${d.caption?.length ? " " + rt(d.caption) : ""}`;
        break;
      case "image":
      case "file":
      case "pdf":
      case "video":
      case "audio":
        line = `［${t}${d.caption?.length ? "：" + rt(d.caption) : d.name ? "：" + d.name : ""}］`;
        break;
      case "link_to_page":
        line = `↪ 連到另一頁（${d.page_id ?? d.database_id ?? ""}）`;
        break;
      case "table":
      case "column_list":
      case "column":
      case "synced_block":
        childDepth = depth;
        break;
      case "table_row":
        line = `| ${(d.cells ?? []).map((c: RichText[]) => rt(c).replace(/\|/g, "\\|")).join(" | ")} |`;
        break;
      default:
        break; // unsupported、breadcrumb、table_of_contents 等略過
    }
    if (line !== null) out.push(line.split("\n").map((l) => (l ? ind + l : l)).join("\n"));
    if (b.has_children && t !== "child_database") {
      const kids = await fetchChildren(b.id);
      let sub = await renderBlocks(kids, fetchChildren, t === "child_page" ? 0 : childDepth, budget);
      if (t === "table") {
        const rows = sub.split("\n");
        if (rows.length) rows.splice(1, 0, "|" + " --- |".repeat((rows[0].match(/\|/g)?.length ?? 2) - 1));
        sub = rows.join("\n");
      }
      if (sub) out.push(sub);
    }
  }
  return out.join("\n");
}

async function allChildren(token: string, id: string): Promise<any[]> {
  const res: any[] = [];
  let cursor: string | undefined;
  do {
    const j = await notion(token, "GET", `/blocks/${id}/children?page_size=100${cursor ? "&start_cursor=" + cursor : ""}`);
    res.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  return res;
}

/* ---------- 屬性轉文字（資料庫用） ---------- */

export function propText(p: any): string {
  if (!p) return "";
  switch (p.type) {
    case "title":
    case "rich_text":
      return oneLine(rt(p[p.type]), 200);
    case "select":
    case "status":
      return p[p.type]?.name ?? "";
    case "multi_select":
      return (p.multi_select ?? []).map((x: any) => x.name).join("、");
    case "people":
      return (p.people ?? []).map((x: any) => x.name ?? x.id).join("、");
    case "date":
      return p.date ? p.date.start + (p.date.end ? " ~ " + p.date.end : "") : "";
    case "checkbox":
      return p.checkbox ? "✓" : "";
    case "number":
      return p.number == null ? "" : String(p.number);
    case "url":
    case "email":
    case "phone_number":
      return p[p.type] ?? "";
    case "relation":
      return p.relation?.length ? `${p.relation.length} 筆關聯` : "";
    case "formula":
      return String(p.formula?.[p.formula?.type] ?? "");
    case "rollup":
      return p.rollup?.type === "number" ? String(p.rollup.number ?? "") : "";
    case "created_time":
    case "last_edited_time":
      return (p[p.type] ?? "").slice(0, 10);
    case "created_by":
    case "last_edited_by":
      return p[p.type]?.name ?? "";
    default:
      return "";
  }
}

function titleOf(props: Record<string, any>): string {
  const t = Object.values(props ?? {}).find((p: any) => p.type === "title");
  return t ? rt(t.title) : "";
}

/* ---------- 同步 ---------- */

export async function syncNotion(link: Link, dir: string): Promise<SyncResult> {
  const token = config.notionToken;
  if (!token) throw new Error("沒設 NOTION_TOKEN。到 notion.so/profile/integrations 建一個只有 Read content 權限的 integration");
  const id = dashed(link.target);
  const notShared = "找不到。要在那個 Notion 頁面右上角 ••• > Connections 加入你的 integration";

  let page: any = null;
  try {
    page = await notion(token, "GET", `/pages/${id}`);
  } catch (e: any) {
    if (e.status !== 404 && e.status !== 400) throw e;
  }

  let md: string;
  let title: string;
  if (page) {
    title = titleOf(page.properties) || "（無標題）";
    const body = await renderBlocks(await allChildren(token, id), (bid) => allChildren(token, bid));
    md = `# ${title}\n\n來源：<${page.url}>\n\n${body}\n`;
  } else {
    let db: any;
    try {
      db = await notion(token, "GET", `/databases/${id}`);
    } catch (e: any) {
      if (e.status === 404 || e.status === 400) throw new Error(notShared);
      throw e;
    }
    title = rt(db.title) || "（無標題資料庫）";
    const rows: any[] = [];
    let cursor: string | undefined;
    do {
      const j = await notion(token, "POST", `/databases/${id}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      rows.push(...j.results);
      cursor = j.has_more && rows.length < 500 ? j.next_cursor : undefined;
    } while (cursor);
    const names = Object.entries(db.properties as Record<string, any>)
      .sort(([, a], [, b]) => (a.type === "title" ? -1 : b.type === "title" ? 1 : 0))
      .map(([k]) => k)
      .slice(0, 10);
    const esc = (s: string) => s.replace(/\|/g, "\\|");
    const table = [
      `| ${names.map(esc).join(" | ")} |`,
      `|${" --- |".repeat(names.length)}`,
      ...rows.map((r) => `| ${names.map((n) => esc(propText(r.properties[n]))).join(" | ")} |`),
    ].join("\n");
    md = `# ${title}（資料庫，${rows.length} 筆${rows.length >= 500 ? "，只取前 500" : ""}）\n\n來源：<${db.url}>\n\n${table}\n`;
  }
  const changed = writeIfChanged(path.join(dir, "index.md"), md);
  return { changed, title, files: ["index.md"] };
}
