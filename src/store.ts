import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { Link } from "./sources/types.js";

export interface Session {
  id: string;
  lastUsed: string;
}

export interface Project {
  /** 6 碼短亂碼，也是資料夾名 */
  id: string;
  /** 顯示名稱，可以中文 */
  name: string;
  status: "active" | "closed";
  createdAt: string;
  createdBy?: string;
  closedAt?: string;
  /** 綁定的 Discord 頻道 id（thread 走父頻道） */
  channels: string[];
  /** 主頻道：提醒貼這裡 */
  primaryChannel?: string;
  /** agent session，key = `${mode}:${channelId}` */
  sessions: Record<string, Session>;
  lastRecordAt?: string;
  lastReviewAt?: string;
  /** 每日巡檢跑過的日期，跟手動 /review 分開 */
  lastDailyReview?: string;
  /** 外部來源（GitHub、Notion），bot 抓、agent 讀 sources/ */
  links?: Link[];
  /** Notion 看板：bot 把 STATE.md 的任務推到這個資料庫 */
  board?: { databaseId: string; url: string; lastPushAt?: string; error?: string };
}

interface State {
  projects: Record<string, Project>;
}

let state: State = { projects: {} };

export function load() {
  try {
    state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  } catch {
    state = { projects: {} };
  }
  // 舊格式：key 是名稱、沒有 id
  for (const [k, p] of Object.entries(state.projects)) {
    p.id ??= k;
    p.sessions ??= {};
    delete (p as { askSessions?: unknown }).askSessions;
  }
}

export function save() {
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  const tmp = config.stateFile + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, config.stateFile);
}

/** 專案資料夾：knowledge/<id>/。agent 的 cwd，也是它唯一能碰的地方 */
export function projectDir(id: string) {
  return path.join(config.knowledgeDir, id);
}

export function projects(): Project[] {
  return Object.values(state.projects);
}
export function activeProjects(): Project[] {
  return projects().filter((p) => p.status === "active");
}
export function normalizeId(s: string) {
  return s.trim().toLowerCase();
}
export function getProject(id: string): Project | undefined {
  return state.projects[normalizeId(id)];
}
export function projectByChannel(channelId: string): Project | undefined {
  return activeProjects().find((p) => p.channels.includes(channelId));
}

/** 去掉容易看錯的 0/o/1/l/i */
const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
function newId(): string {
  for (;;) {
    let s = "";
    for (let i = 0; i < 6; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    if (!state.projects[s] && !fs.existsSync(projectDir(s))) return s;
  }
}

export function createProject(name: string, createdBy?: string): Project {
  name = name.trim();
  if (!name || name.length > 50) throw new Error("名稱要 1 到 50 字");
  const id = newId();
  const p: Project = { id, name, status: "active", createdAt: new Date().toISOString(), createdBy, channels: [], sessions: {} };
  state.projects[id] = p;
  const dir = projectDir(id);
  for (const d of ["raw", "files", "log", "notes"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "STATE.md"),
    `# ${name}（${id}）\n\n建立：${today()}\n\n## 目標\n\n（尚未記錄）\n\n## 進行中\n\n（無）\n\n## 阻塞 / 待決\n\n（無）\n\n## 下一步\n\n（無）\n\n## 最近完成\n\n（無）\n`,
  );
  fs.writeFileSync(path.join(dir, "decisions.md"), `# ${name} 決策紀錄\n\n`);
  fs.writeFileSync(path.join(dir, "people.md"), `# ${name} 成員\n\n| 名字 / 別名 | Discord | 負責 |\n|---|---|---|\n`);
  save();
  return p;
}

function mustGet(id: string): Project {
  const p = getProject(id);
  if (!p) throw new Error(`找不到專案 \`${id}\``);
  return p;
}

export function closeProject(id: string): Project {
  const p = mustGet(id);
  p.status = "closed";
  p.closedAt = new Date().toISOString();
  save();
  return p;
}

export function joinChannel(id: string, channelId: string, primary: boolean): Project {
  const p = mustGet(id);
  if (p.status !== "active") throw new Error(`專案 \`${p.id}\` 已結束`);
  const other = projectByChannel(channelId);
  if (other && other.id !== p.id) throw new Error(`這個頻道已經在專案 **${other.name}**（\`${other.id}\`）裡，先 \`/project exit\``);
  if (!p.channels.includes(channelId)) p.channels.push(channelId);
  if (primary || !p.primaryChannel) p.primaryChannel = channelId;
  save();
  return p;
}

export function exitChannel(channelId: string): Project | undefined {
  const p = projectByChannel(channelId);
  if (!p) return;
  p.channels = p.channels.filter((c) => c !== channelId);
  if (p.primaryChannel === channelId) p.primaryChannel = p.channels[0];
  for (const k of Object.keys(p.sessions)) if (k.endsWith(":" + channelId)) delete p.sessions[k];
  save();
  return p;
}

const SESSION_IDLE_MS = () => config.sessionIdleHours * 3600_000;

export function getSession(p: Project, key: string): string | undefined {
  const s = p.sessions[key];
  if (!s) return;
  if (Date.now() - Date.parse(s.lastUsed) > SESSION_IDLE_MS()) return;
  return s.id;
}
export function setSession(p: Project, key: string, id: string) {
  p.sessions[key] = { id, lastUsed: new Date().toISOString() };
  save();
}

export function touch(p: Project, field: "lastRecordAt" | "lastReviewAt") {
  p[field] = new Date().toISOString();
  save();
}

/* ---------- raw / pending / outbox ---------- */

export function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export function hhmm(d = new Date()) {
  return d.toLocaleTimeString("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

export interface RawEntry {
  project: string;
  channelName: string;
  author: string;
  authorId: string;
  text: string;
  attachments: string[];
  messageUrl: string;
  /** 被回覆的訊息、上下文等，每行一條 */
  context?: string[];
}

/** 寫一筆到 raw 日誌 + pending；回傳 raw id 和寫進去的內容 */
export function appendRaw(e: RawEntry): { id: string; block: string } {
  const date = today();
  const rawDir = path.join(projectDir(e.project), "raw");
  fs.mkdirSync(rawDir, { recursive: true });
  const file = path.join(rawDir, `${date}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# raw ${date}\n\n`);
  const n = (fs.readFileSync(file, "utf8").match(/^- \[/gm) ?? []).length + 1;
  const id = `${date}#${n}`;
  const ind = (s: string) => s.replace(/\n/g, "\n  ");
  let block = `- [${id}] ${hhmm()} #${e.channelName} **${e.author}**（<@${e.authorId}>）：${ind(e.text)}\n`;
  if (e.attachments.length) block += `  附件：${e.attachments.join("、")}\n`;
  for (const c of e.context ?? []) block += `  ${ind(c)}\n`;
  block += `  <${e.messageUrl}>\n`;
  fs.appendFileSync(file, block);
  fs.appendFileSync(pendingPath(e.project), block);
  return { id, block };
}

export function pendingPath(project: string) {
  return path.join(projectDir(project), "pending.md");
}
function readPending(project: string): string[] {
  try {
    const s = fs.readFileSync(pendingPath(project), "utf8");
    return s ? s.split(/\n(?=- \[)/).map((b) => (b.endsWith("\n") ? b : b + "\n")) : [];
  } catch {
    return [];
  }
}
export function pendingIds(project: string): string[] {
  return readPending(project)
    .map((b) => b.match(/^- \[([^\]]+)\]/)?.[1])
    .filter((x): x is string => !!x);
}
/** 只移除處理成功的那幾筆，避免把排隊中的新記錄一起清掉 */
export function removePending(project: string, ids: string[]) {
  const keep = readPending(project).filter((b) => !ids.includes(b.match(/^- \[([^\]]+)\]/)?.[1] ?? ""));
  fs.writeFileSync(pendingPath(project), keep.join(""));
}

/** 讀 outbox，不清空；確定送出去再 clearOutbox，避免發不出去時訊息不見 */
export function peekOutbox(project: string): string | null {
  try {
    return fs.readFileSync(path.join(projectDir(project), "outbox.md"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
export function clearOutbox(project: string) {
  try {
    fs.writeFileSync(path.join(projectDir(project), "outbox.md"), "");
  } catch {}
}

export function filesDir(project: string) {
  const d = path.join(projectDir(project), "files");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* ---------- 統計 ---------- */

export interface Stats {
  records: number;
  openTasks: number;
  doneTasks: number;
  decisions: number;
  notes: number;
  files: number;
  people: number;
  pending: number;
}

function readOr(p: string) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}
function countFiles(dir: string): number {
  try {
    return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
  } catch {
    return 0;
  }
}

export function stats(id: string): Stats {
  const dir = projectDir(id);
  let records = 0;
  try {
    for (const f of fs.readdirSync(path.join(dir, "raw"))) records += (readOr(path.join(dir, "raw", f)).match(/^- \[/gm) ?? []).length;
  } catch {}
  const st = readOr(path.join(dir, "STATE.md"));
  return {
    records,
    openTasks: (st.match(/^\s*- \[ \]/gm) ?? []).length,
    doneTasks: (st.match(/^\s*- \[x\]/gim) ?? []).length,
    decisions: (readOr(path.join(dir, "decisions.md")).match(/^- /gm) ?? []).length,
    notes: countFiles(path.join(dir, "notes")),
    files: countFiles(path.join(dir, "files")),
    people: Math.max(0, (readOr(path.join(dir, "people.md")).match(/^\|/gm) ?? []).length - 2),
    pending: pendingIds(id).length,
  };
}
