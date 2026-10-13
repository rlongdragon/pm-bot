import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VoiceBasedChannel, VoiceState } from "discord.js";
import { DiscordRecorder } from "./discord-recorder.js";
import { fmtDuration, type Manifest } from "./session.js";

/** 一個專案同時只錄一場；Discord 一個伺服器只能有一條語音連線 */
export interface Active {
  kind: "voice" | "meet";
  projectId: string;
  guildId?: string;
  label: string;
  startedAt: number;
  reportChannelId: string;
  /** 下指令的人；頻道貼不出去時改私訊他 */
  invokerId?: string;
  state: string;
  stop(): Promise<void>;
}

export interface Finished {
  projectId: string;
  reportChannelId: string;
  invokerId?: string;
  kind: "voice" | "meet";
  label: string;
  dir: string;
  manifest?: Manifest;
  error?: string | null;
}

const active = new Map<string, Active>();
let onFinished: (f: Finished) => void = () => {};
let onStatus: (a: Active, msg: string) => void = () => {};

export function setHandlers(h: { finished: (f: Finished) => void; status: (a: Active, msg: string) => void }) {
  onFinished = h.finished;
  onStatus = h.status;
}

export function getActive(projectId: string) {
  return active.get(projectId);
}
export function allActive() {
  return [...active.values()];
}

function busy(projectId: string, guildId?: string) {
  const a = active.get(projectId);
  if (a) throw new Error(`這個專案已經在錄「${a.label}」，先 \`/meet stop\``);
  if (guildId) {
    const g = [...active.values()].find((x) => x.kind === "voice" && x.guildId === guildId);
    if (g) throw new Error(`這個伺服器已經在錄語音「${g.label}」（另一個專案），Discord 一次只能進一個語音頻道`);
  }
}

export async function startVoice(projectId: string, channel: VoiceBasedChannel, reportChannelId: string, invokerId?: string): Promise<Active> {
  busy(projectId, channel.guild.id);
  const me = channel.guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (!perms?.has("ViewChannel") || !perms.has("Connect")) throw new Error(`我在 🔊${channel.name} 沒有「檢視頻道」或「連線」權限`);
  const rec = new DiscordRecorder(projectId, channel);
  const a: Active = {
    kind: "voice",
    projectId,
    guildId: channel.guild.id,
    label: `🔊${channel.name}`,
    startedAt: Date.now(),
    reportChannelId,
    invokerId,
    state: "連線中",
    stop: async () => {
      await rec.stop();
    },
  };
  active.set(projectId, a);
  rec.onStopped = (s) => {
    active.delete(projectId);
    onFinished({ projectId, reportChannelId, invokerId, kind: "voice", label: a.label, dir: s.dir, manifest: s.manifest });
  };
  try {
    await rec.start();
  } catch (e) {
    active.delete(projectId);
    fs.rmSync(rec.session.dir, { recursive: true, force: true });
    throw e;
  }
  a.state = "錄音中";
  (a as Active & { rec: DiscordRecorder }).rec = rec;
  return a;
}

/** 語音頻道沒真人了就自動停 */
export function onVoiceStateUpdate(oldState: VoiceState) {
  for (const a of active.values()) {
    const rec = (a as Active & { rec?: DiscordRecorder }).rec;
    if (!rec || oldState.channelId !== rec.channel.id) continue;
    if (rec.humans() === 0) {
      rec.session.event("channel-empty");
      void a.stop();
    }
  }
}

const here = fileURLToPath(import.meta.url);
const runner = path.join(path.dirname(here), "meet-runner" + path.extname(here)); // dist 是 .js，tsx 是 .ts

export function startMeet(projectId: string, url: string, reportChannelId: string, invokerId?: string): Active {
  busy(projectId);
  if (!/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(url)) throw new Error("要是 https://meet.google.com/xxx-yyyy-zzz 這種連結");
  const child: ChildProcess = spawn(process.execPath, [...process.execArgv, runner, projectId, url], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const code = url.replace(/^https:\/\/meet\.google\.com\//, "").split("?")[0];
  let dir = "";
  let done = false;
  const a: Active = {
    kind: "meet",
    projectId,
    label: `Google Meet ${code}`,
    startedAt: Date.now(),
    reportChannelId,
    invokerId,
    state: "啟動中",
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const t = setTimeout(() => {
          child.kill("SIGKILL");
          r();
        }, 60_000);
        child.once("exit", () => {
          clearTimeout(t);
          r();
        });
      });
    },
  };
  active.set(projectId, a);

  let buf = "";
  child.stdout!.on("data", (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith("@@ ")) continue;
      try {
        const m = JSON.parse(line.slice(3));
        if (m.dir) dir = m.dir;
        if (m.type === "status") {
          a.state = m.message;
          onStatus(a, m.message);
        } else if (m.type === "done") {
          done = true;
          active.delete(projectId);
          onFinished({ projectId, reportChannelId, invokerId, kind: "meet", label: a.label, dir: m.dir, manifest: m.manifest, error: m.error });
        } else if (m.type === "error") {
          a.state = m.message;
        }
      } catch {}
    }
  });
  child.stderr!.on("data", (d: Buffer) => process.stderr.write(`[meet:${projectId}] ${d}`));
  child.on("exit", (code) => {
    if (done) return;
    active.delete(projectId);
    onFinished({ projectId, reportChannelId, invokerId, kind: "meet", label: a.label, dir, error: a.state && code ? `錄音程序異常結束（${code}）：${a.state}` : null });
  });
  return a;
}

export function describe(a: Active): string {
  return `${a.label}　${a.state}　已 ${fmtDuration((Date.now() - a.startedAt) / 1000)}`;
}

export async function stopAll() {
  await Promise.all([...active.values()].map((a) => a.stop().catch(() => {})));
}
