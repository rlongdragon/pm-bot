import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface Project {
  name: string;
  status: "active" | "closed";
  createdAt: string;
  closedAt?: string;
  /** 綁定的 Discord 頻道 id（thread 走父頻道） */
  channels: string[];
  /** 主頻道：digest / 提醒貼這裡 */
  primaryChannel?: string;
  /** 問答 session，每頻道一個 */
  askSessions: Record<string, string>;
  lastDigestAt?: string;
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
}

export function save() {
  fs.mkdirSync(path.dirname(config.stateFile), { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

export function projects(): Project[] {
  return Object.values(state.projects);
}
export function activeProjects(): Project[] {
  return projects().filter((p) => p.status === "active");
}
export function getProject(name: string): Project | undefined {
  return state.projects[name];
}
export function projectByChannel(channelId: string): Project | undefined {
  return activeProjects().find((p) => p.channels.includes(channelId));
}

export function createProject(name: string): Project {
  if (state.projects[name]) throw new Error(`專案 ${name} 已存在`);
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(name)) throw new Error("名稱只能用英數、- 、_");
  const p: Project = { name, status: "active", createdAt: new Date().toISOString(), channels: [], askSessions: {} };
  state.projects[name] = p;
  for (const d of ["projects/" + name, "raw/" + name + "/files", "pending", "outbox"]) {
    fs.mkdirSync(path.join(config.knowledgeDir, d), { recursive: true });
  }
  const stateMd = path.join(config.knowledgeDir, "projects", name, "STATE.md");
  if (!fs.existsSync(stateMd)) {
    fs.writeFileSync(
      stateMd,
      `# ${name}\n\n建立：${p.createdAt.slice(0, 10)}\n\n## 目標\n\n（尚未記錄）\n\n## 進行中\n\n（無）\n\n## 阻塞 / 待決\n\n（無）\n\n## 下一步\n\n（無）\n`,
    );
    fs.writeFileSync(path.join(config.knowledgeDir, "projects", name, "decisions.md"), `# ${name} 決策紀錄\n\n`);
    fs.writeFileSync(path.join(config.knowledgeDir, "projects", name, "people.md"), `# ${name} 成員\n\n| 名字 / 別名 | Discord | 負責 |\n|---|---|---|\n`);
  }
  save();
  return p;
}

export function closeProject(name: string) {
  const p = getProject(name);
  if (!p) throw new Error(`沒有專案 ${name}`);
  p.status = "closed";
  p.closedAt = new Date().toISOString();
  save();
}

export function bindChannel(name: string, channelId: string, primary: boolean) {
  const p = getProject(name);
  if (!p) throw new Error(`沒有專案 ${name}`);
  const other = projectByChannel(channelId);
  if (other && other.name !== name) throw new Error(`這個頻道已綁 ${other.name}`);
  if (!p.channels.includes(channelId)) p.channels.push(channelId);
  if (primary || !p.primaryChannel) p.primaryChannel = channelId;
  save();
}

export function unbindChannel(channelId: string) {
  const p = projectByChannel(channelId);
  if (!p) return;
  p.channels = p.channels.filter((c) => c !== channelId);
  if (p.primaryChannel === channelId) p.primaryChannel = p.channels[0];
  save();
}

export function setAskSession(name: string, channelId: string, sessionId: string) {
  const p = getProject(name);
  if (!p) return;
  p.askSessions[channelId] = sessionId;
  save();
}

/* ---------- raw / pending / outbox ---------- */

function today() {
  const d = new Date();
  const tz = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return tz.toISOString().slice(0, 10);
}
function hhmm() {
  return new Date().toLocaleTimeString("zh-TW", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

export interface RawEntry {
  project: string;
  channelName: string;
  author: string;
  authorId: string;
  text: string;
  attachments: string[];
  messageUrl: string;
}

/** 寫一筆到 raw 日誌 + pending 緩衝；回傳 raw 引用 id */
export function appendRaw(e: RawEntry): string {
  const date = today();
  const rawDir = path.join(config.knowledgeDir, "raw", e.project);
  fs.mkdirSync(rawDir, { recursive: true });
  const file = path.join(rawDir, `${date}.md`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${e.project} raw ${date}\n\n`);
  const existing = fs.readFileSync(file, "utf8");
  const n = (existing.match(/^- \[/gm) ?? []).length + 1;
  const id = `${date}#${n}`;
  const att = e.attachments.length ? `\n  附件：${e.attachments.join("、")}` : "";
  const line = `- [${id}] ${hhmm()} #${e.channelName} **${e.author}**（<@${e.authorId}>）：${e.text.replace(/\n/g, "\n  ")}${att}\n  <${e.messageUrl}>\n`;
  fs.appendFileSync(file, line);
  fs.appendFileSync(path.join(config.knowledgeDir, "pending", `${e.project}.md`), line);
  return id;
}

export function pendingPath(project: string) {
  return path.join(config.knowledgeDir, "pending", `${project}.md`);
}
export function hasPending(project: string) {
  try {
    return fs.statSync(pendingPath(project)).size > 0;
  } catch {
    return false;
  }
}
export function clearPending(project: string) {
  try {
    fs.writeFileSync(pendingPath(project), "");
  } catch {}
}

export function takeOutbox(project: string): string | null {
  const f = path.join(config.knowledgeDir, "outbox", `${project}.md`);
  try {
    const s = fs.readFileSync(f, "utf8").trim();
    fs.writeFileSync(f, "");
    return s || null;
  } catch {
    return null;
  }
}

export function filesDir(project: string) {
  const d = path.join(config.knowledgeDir, "raw", project, "files");
  fs.mkdirSync(d, { recursive: true });
  return d;
}
