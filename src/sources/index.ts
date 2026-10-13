import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { config } from "../config.js";
import * as store from "../store.js";
import { parseGithub, syncGithub } from "./github.js";
import { parseNotion, syncNotion } from "./notion.js";
import type { Link, LinkType } from "./types.js";

export type { Link } from "./types.js";

export function parseLink(input: string): { type: LinkType; target: string } | null {
  if (/notion\.(so|site)/i.test(input)) {
    const t = parseNotion(input);
    return t ? { type: "notion", target: t } : null;
  }
  const g = parseGithub(input);
  return g ? { type: "github", target: g } : null;
}

export function linkDir(projectId: string, l: Link) {
  const slug = l.type === "github" ? l.target.replace("/", "__") : l.target;
  return path.join(store.projectDir(projectId), "sources", l.type, slug);
}

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function newLinkId(p: store.Project) {
  for (;;) {
    let s = "";
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!(p.links ?? []).some((l) => l.id === s)) return s;
  }
}

async function syncOne(p: store.Project, l: Link): Promise<boolean> {
  const dir = linkDir(p.id, l);
  try {
    const r = l.type === "github" ? await syncGithub(l, dir) : await syncNotion(l, dir);
    l.title = r.title;
    l.error = undefined;
    if (r.changed) l.lastChangeAt = new Date().toISOString();
    return r.changed;
  } finally {
    l.lastSyncAt = new Date().toISOString();
  }
}

/** 新增連結：先實際抓一次，抓不到就不加，回傳錯誤讓使用者知道要做什麼 */
export async function addLink(p: store.Project, input: string, by?: string): Promise<Link> {
  const parsed = parseLink(input);
  if (!parsed) throw new Error("看不懂這個連結。支援 GitHub repo（github.com/owner/repo）和 Notion 頁面或資料庫網址");
  p.links ??= [];
  const dup = p.links.find((l) => l.type === parsed.type && l.target === parsed.target);
  if (dup) throw new Error(`已經連過了（\`${dup.id}\` ${dup.title}）`);
  const l: Link = {
    id: newLinkId(p),
    ...parsed,
    title: parsed.target,
    url: parsed.type === "github" ? `https://github.com/${parsed.target}` : `https://www.notion.so/${parsed.target}`,
    addedAt: new Date().toISOString(),
    addedBy: by,
  };
  await syncOne(p, l); // 失敗會丟錯，不會加進去
  p.links.push(l);
  store.save();
  return l;
}

export function removeLink(p: store.Project, id: string): Link {
  const l = (p.links ?? []).find((x) => x.id === id.trim().toLowerCase());
  if (!l) throw new Error(`找不到連結 \`${id}\``);
  p.links = p.links!.filter((x) => x !== l);
  fs.rmSync(linkDir(p.id, l), { recursive: true, force: true });
  store.save();
  return l;
}

/**
 * 同步這個專案所有連結。force=false 時，SOURCE_MIN_INTERVAL_MIN 內同步過的跳過。
 * 不會丟錯：錯誤記在 link.error，回傳給呼叫端顯示。
 */
export async function syncLinks(p: store.Project, force = false): Promise<{ changed: boolean; errors: string[] }> {
  let changed = false;
  const errors: string[] = [];
  const minMs = config.sourceMinIntervalMin * 60_000;
  for (const l of p.links ?? []) {
    if (!force && l.lastSyncAt && Date.now() - Date.parse(l.lastSyncAt) < minMs) continue;
    try {
      if (await syncOne(p, l)) changed = true;
    } catch (e) {
      l.error = (e as Error).message;
      errors.push(`\`${l.id}\` ${l.title}：${l.error}`);
      console.warn(`[sources] ${p.id}/${l.id} ${l.error}`);
    }
  }
  if (p.links?.length) store.save();
  return { changed, errors };
}
