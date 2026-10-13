import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import * as store from "./store.js";
import { dashed, notion, parseNotion, propText } from "./sources/notion.js";

/**
 * Notion 看板 = STATE.md 的顯示。bot 單向推，agent 碰不到。
 * 在 Notion 上手動改會在下次同步被蓋掉；要改請 @bot 說「更正」。
 */

export type Status = "進行中" | "待決" | "下一步" | "完成";

export interface Card {
  key: string;
  title: string;
  status: Status;
  owner: string;
  due: string | null; // YYYY-MM-DD
  note: string;
  source: string;
  updated: string | null;
}

const SECTIONS: [RegExp, Status][] = [
  [/進行中/, "進行中"],
  [/阻塞|待決/, "待決"],
  [/下一步/, "下一步"],
  [/完成/, "完成"],
];

const DATE = /\d{4}-\d{2}-\d{2}/;

/** 解析 STATE.md。格式見 knowledge-template/CLAUDE.md，但盡量容忍 agent 的寫法差異 */
export function parseState(md: string): Card[] {
  const cards: Card[] = [];
  let status: Status | null = null;
  for (const raw of md.split("\n")) {
    const h = raw.match(/^##\s+(.+)/);
    if (h) {
      status = SECTIONS.find(([re]) => re.test(h[1]))?.[1] ?? null;
      continue;
    }
    if (!status) continue;
    const m = raw.match(/^\s*[-*]\s+(?:\[([ xX])\]\s+)?(.+)$/);
    if (!m) continue;
    const body = m[2].trim();
    if (/^（.*）$/.test(body)) continue; // （無）
    const parts = body.split(/\s+[—–]\s+/);
    const title = parts.shift()!.trim();
    const c: Card = { key: "", title, status: m[1]?.toLowerCase() === "x" ? "完成" : status, owner: "", due: null, note: "", source: "", updated: null };
    const notes: string[] = [];
    for (const p of parts) {
      if (/^@/.test(p)) c.owner = p.replace(/@/g, "").trim();
      else if (/^期限/.test(p)) {
        const d = p.match(DATE)?.[0] ?? null;
        c.due = d;
        const rest = p.replace(/^期限\s*/, "").replace(DATE, "").replace(/[（）()]/g, " ").trim();
        if (rest) notes.push(rest);
      } else if (/raw\s+\S+/.test(p)) c.source = p.match(/raw\s+(\S+)/)![1];
      else if (/^更新/.test(p)) c.updated = p.match(DATE)?.[0] ?? null;
      else if (DATE.test(p) && p.trim().length <= 12) c.updated = p.match(DATE)![0];
      else notes.push(p.trim());
    }
    c.note = notes.join("；");
    // key 用標題雜湊：任務從「進行中」搬到「完成」標題不變，同一張卡會被更新而不是重開
    c.key = crypto.createHash("sha1").update(title.replace(/\s+/g, "")).digest("hex").slice(0, 12);
    cards.push(c);
  }
  // 同標題重複出現時只留最後一個（通常是較新的狀態）
  return [...new Map(cards.map((c) => [c.key, c])).values()];
}

/* ---------- Notion ---------- */

const text = (s: string) => (s ? [{ type: "text", text: { content: s.slice(0, 1900) } }] : []);

function rowProps(c: Card) {
  return {
    任務: { title: text(c.title) },
    狀態: { select: { name: c.status } },
    負責人: { rich_text: text(c.owner) },
    期限: { date: c.due ? { start: c.due } : null },
    備註: { rich_text: text(c.note) },
    來源: { rich_text: text(c.source ? `raw ${c.source}` : "") },
    更新: { date: c.updated ? { start: c.updated } : null },
    ID: { rich_text: text(c.key) },
  };
}

function sig(c: Card) {
  return JSON.stringify([c.title, c.status, c.owner, c.due ?? "", c.note, c.source ? `raw ${c.source}` : "", c.updated ?? ""]);
}
function rowSig(r: any) {
  const p = r.properties;
  const d = (x: any) => (x?.date?.start ?? "").slice(0, 10);
  return JSON.stringify([propText(p["任務"]), propText(p["狀態"]), propText(p["負責人"]), d(p["期限"]), propText(p["備註"]), propText(p["來源"]), d(p["更新"])]);
}

function token(): string {
  const t = config.notionBoardToken;
  if (!t) throw new Error("沒設 NOTION_BOARD_TOKEN（或 NOTION_TOKEN）。看板用的 integration 要勾「讀取、更新、插入內容」");
  return t;
}

/** 在使用者給的頁面底下建一個看板資料庫 */
export async function createBoard(p: store.Project, pageUrl: string): Promise<{ databaseId: string; url: string }> {
  const pageId = parseNotion(pageUrl);
  if (!pageId) throw new Error("看不懂這個 Notion 網址");
  const t = token();
  try {
    await notion(t, "GET", `/pages/${dashed(pageId)}`);
  } catch (e: any) {
    if (e.status === 404 || e.status === 400)
      throw new Error("找不到這個頁面，或它是資料庫。請給一個一般頁面，並在那頁 ••• > Connections 加入看板用的 integration");
    throw e;
  }
  const db = await notion(t, "POST", "/databases", {
    parent: { type: "page_id", page_id: dashed(pageId) },
    is_inline: true,
    title: text(`${p.name} 看板`),
    properties: {
      任務: { title: {} },
      狀態: {
        select: {
          options: [
            { name: "進行中", color: "blue" },
            { name: "待決", color: "red" },
            { name: "下一步", color: "yellow" },
            { name: "完成", color: "green" },
          ],
        },
      },
      負責人: { rich_text: {} },
      期限: { date: {} },
      備註: { rich_text: {} },
      來源: { rich_text: {} },
      更新: { date: {} },
      ID: { rich_text: {} },
    },
  });
  return { databaseId: db.id.replace(/-/g, ""), url: db.url };
}

export interface PushResult {
  created: number;
  updated: number;
  archived: number;
}

/** 把 STATE.md 推到看板：新增、更新有變的、STATE 裡沒了的未完成卡片封存（完成的保留當歷史） */
export async function pushBoard(p: store.Project): Promise<PushResult> {
  if (!p.board) throw new Error("這個專案還沒設看板。`/board set url:<Notion 頁面>`");
  const t = token();
  const dbId = dashed(p.board.databaseId);
  const cards = parseState(fs.readFileSync(path.join(store.projectDir(p.id), "STATE.md"), "utf8"));

  const rows: any[] = [];
  let cursor: string | undefined;
  do {
    const j = await notion(t, "POST", `/databases/${dbId}/query`, { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : undefined;
  } while (cursor);
  const byKey = new Map(rows.map((r) => [propText(r.properties["ID"]), r]));

  const res: PushResult = { created: 0, updated: 0, archived: 0 };
  for (const c of cards) {
    const row = byKey.get(c.key);
    byKey.delete(c.key);
    if (!row) {
      await notion(t, "POST", "/pages", { parent: { database_id: dbId }, properties: rowProps(c) });
      res.created++;
    } else if (rowSig(row) !== sig(c)) {
      await notion(t, "PATCH", `/pages/${row.id}`, { properties: rowProps(c) });
      res.updated++;
    }
  }
  for (const [, row] of byKey) {
    if (propText(row.properties["狀態"]) === "完成") continue;
    await notion(t, "PATCH", `/pages/${row.id}`, { archived: true });
    res.archived++;
  }
  p.board.lastPushAt = new Date().toISOString();
  p.board.error = undefined;
  store.save();
  return res;
}
