// 搬自 meeting-recorder/src/common/session.ts
import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "../config.js";

export type Platform = "discord" | "meet" | "upload";

export interface Participant {
  id: string;
  name: string;
  file?: string; // 相對 session 目錄
}

export interface Manifest {
  platform: Platform;
  project: string;
  source: string; // guild/channel 或 meet url
  startedAt: string;
  endedAt?: string;
  durationSec?: number;
  participants: Participant[];
  files: { mixed?: string; tracks: string[] };
  events: { t: number; type: string; detail?: string }[]; // t = 秒，相對開始
}

/** 一場錄音 = 一個目錄 + manifest.json */
export class RecordingSession {
  readonly dir: string;
  readonly startedAt = Date.now();
  readonly manifest: Manifest;

  constructor(project: string, platform: Platform, source: string, slug: string) {
    const d = new Date(this.startedAt);
    const stamp = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.dir = path.join(config.recordingsDir, project, `${stamp}_${platform}_${sanitize(slug)}`);
    fs.mkdirSync(path.join(this.dir, "tracks"), { recursive: true });
    this.manifest = { platform, project, source, startedAt: d.toISOString(), participants: [], files: { tracks: [] }, events: [] };
    this.save();
  }

  elapsedSec(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  event(type: string, detail?: string) {
    this.manifest.events.push({ t: round(this.elapsedSec()), type, detail });
    this.save();
  }

  addParticipant(p: Participant) {
    const cur = this.manifest.participants.find((x) => x.id === p.id);
    if (cur) {
      if (p.file && !cur.file) cur.file = p.file;
      this.save();
      return;
    }
    this.manifest.participants.push(p);
    this.event("join", `${p.name} (${p.id})`);
  }

  finish() {
    this.manifest.endedAt = new Date().toISOString();
    this.manifest.durationSec = round(this.elapsedSec());
    this.save();
  }

  save() {
    fs.writeFileSync(path.join(this.dir, "manifest.json"), JSON.stringify(this.manifest, null, 2));
  }
}

export function sanitize(s: string): string {
  return s.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "unnamed";
}

function round(n: number) {
  return Math.round(n * 100) / 100;
}

/** 啟動 ffmpeg 把 stdin 的 s16le 48k 2ch PCM 即時壓成 ogg/opus */
export function spawnPcmToOgg(outFile: string): ChildProcess {
  return spawn(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0", "-c:a", "libopus", "-b:a", config.opusBitrate, "-application", "voip", outFile],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
}

/** 多軌混音成單一 ogg。輸入軌長度不同時以最長為準。 */
export function mixTracks(tracks: string[], outFile: string): Promise<void> {
  if (tracks.length === 0) return Promise.resolve();
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  for (const t of tracks) args.push("-i", t);
  if (tracks.length === 1) args.push("-c:a", "copy", outFile);
  else
    args.push(
      "-filter_complex",
      `amix=inputs=${tracks.length}:duration=longest:normalize=0,alimiter=limit=0.95`,
      "-c:a", "libopus", "-b:a", config.opusBitrate, outFile,
    );
  return run("ffmpeg", args);
}

/** webm/opus → ogg/opus（不重編碼） */
export function webmToOgg(inFile: string, outFile: string): Promise<void> {
  return run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", inFile, "-c:a", "copy", outFile]);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`))));
  });
}

export function fmtDuration(sec: number) {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
