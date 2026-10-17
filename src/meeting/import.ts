/**
 * 外部錄音（實體會議的手機錄音、別的工具錄的檔）匯入成一場「錄音」：
 * 存進 data/recordings/<專案>/<日期>_upload_<標題>/，轉成 mixed.ogg、寫 manifest，之後走跟 /meet 一樣的轉錄與整理。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { config } from "../config.js";
import { sanitize, type Manifest } from "./session.js";

const exec = promisify(execFile);

/** 500 MB 夠放 8 小時的手機錄音 */
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

export interface ImportOpts {
  /** 會議標題，當資料夾名和卡片標題 */
  title: string;
  /** 會議時間；沒給就用現在 */
  startedAt?: Date;
  /** 與會者名字，給轉錄模型當提示 */
  people?: string[];
  /** 原始檔名（取副檔名用） */
  filename: string;
}

/** 解析使用者打的日期：2026-10-14、2026/10/14 14:30、10/14 都接受 */
export function parseWhen(s: string | null | undefined, now = new Date()): Date | null {
  if (!s) return null;
  const t = s.trim().replace(/／/g, "/").replace(/－/g, "-");
  let m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0);
  m = t.match(/^(\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (m) return new Date(now.getFullYear(), +m[1] - 1, +m[2], m[3] ? +m[3] : 0, m[4] ? +m[4] : 0);
  return null;
}

/** 抓網址（Discord 附件或任何直接連結）到檔案，超過上限就中斷 */
export async function download(url: string, dest: string): Promise<number> {
  const r = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000), redirect: "follow" });
  if (!r.ok || !r.body) throw new Error(`下載失敗（${r.status}）`);
  const len = Number(r.headers.get("content-length") ?? 0);
  if (len > MAX_UPLOAD_BYTES) throw new Error(`檔案 ${(len / 1048576).toFixed(0)} MB，超過上限 ${MAX_UPLOAD_BYTES / 1048576} MB`);
  const ct = r.headers.get("content-type") ?? "";
  if (/^text\/html/i.test(ct)) throw new Error("這個連結回的是網頁不是檔案。要用直接下載的連結");
  let got = 0;
  const limiter = new (await import("node:stream")).Transform({
    transform(chunk, _enc, cb) {
      got += chunk.length;
      if (got > MAX_UPLOAD_BYTES) return cb(new Error(`超過上限 ${MAX_UPLOAD_BYTES / 1048576} MB`));
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(r.body as import("stream/web").ReadableStream), limiter, fs.createWriteStream(dest));
  return got;
}

async function probe(file: string): Promise<{ durationSec: number; hasAudio: boolean }> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file]);
  const j = JSON.parse(stdout);
  return { durationSec: Number(j.format?.duration ?? 0), hasAudio: (j.streams ?? []).some((s: any) => s.codec_type === "audio") };
}

/**
 * 把已經在本機的檔案匯入。回傳錄音資料夾和 manifest。
 * 檔案會搬進資料夾的 tracks/ 底下留著，mixed.ogg 是轉錄用的統一格式。
 */
export async function importAudio(project: string, srcFile: string, o: ImportOpts): Promise<{ dir: string; manifest: Manifest }> {
  const info = await probe(srcFile).catch(() => null);
  if (!info || !info.hasAudio) throw new Error("這不是音訊檔，或 ffmpeg 讀不懂");
  if (info.durationSec < 3) throw new Error("錄音不到 3 秒");
  const started = o.startedAt ?? new Date();
  const stamp = new Date(started.getTime() - started.getTimezoneOffset() * 60000).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(config.recordingsDir, project, `${stamp}_upload_${sanitize(o.title)}`);
  fs.mkdirSync(path.join(dir, "tracks"), { recursive: true });
  const ext = (path.extname(o.filename) || ".bin").toLowerCase().slice(0, 8);
  const original = path.join(dir, "tracks", `original${ext}`);
  fs.renameSync(srcFile, original);
  await exec("ffmpeg", ["-v", "error", "-y", "-i", original, "-vn", "-c:a", "libopus", "-b:a", "64k", path.join(dir, "mixed.ogg")]);
  const manifest: Manifest = {
    platform: "upload",
    project,
    source: o.title,
    startedAt: started.toISOString(),
    endedAt: new Date(started.getTime() + info.durationSec * 1000).toISOString(),
    durationSec: Math.round(info.durationSec * 100) / 100,
    participants: (o.people ?? []).map((name) => ({ id: name, name })),
    files: { mixed: "mixed.ogg", tracks: [`tracks/original${ext}`] },
    events: [{ t: 0, type: "upload", detail: o.filename }],
  };
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { dir, manifest };
}

/**
 * 「@bot 10/13 的小組會議，與會者 Alice、Bob，幫我轉逐字稿」→ 標題、時間、與會者。
 * 抓不到的就用檔名、現在、空。
 */
export function parseImportText(text: string, filename: string): { title: string; startedAt?: Date; people: string[] } {
  let t = text;
  let startedAt: Date | undefined;
  const dm = t.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?|\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?/);
  if (dm) {
    startedAt = parseWhen(dm[0]) ?? undefined;
    t = t.replace(dm[0], " ");
  }
  let people: string[] = [];
  const pm = t.match(/(?:與會者|參加者|參與者|講者|出席)[:：是有]?\s*([^。;；\n]+)/);
  if (pm) {
    // 名單用 、,，/ 空白分隔；後面接的指令字（幫我轉逐字稿）不算人
    const cmd = /逐字稿|文字稿|紀錄|記錄|轉錄|轉文字|整理|幫我|請|麻煩/;
    people = pm[1].split(/[、,，/／\s]+/).map((x) => x.trim()).filter((x) => x && x.length <= 20 && !cmd.test(x));
    t = t.replace(pm[0], " ");
  }
  t = t
    .replace(/(幫我|請|麻煩|順便)?(轉|做|弄|整理|產生|生)?(成)?(逐字稿|文字稿|會議紀錄|會議記錄|紀錄|記錄|轉錄|轉文字)/g, " ")
    .replace(/(這是|這個是|的錄音|錄音檔|錄音|音檔)/g, " ")
    .replace(/[，,。、\s]+/g, " ")
    .trim()
    .replace(/^的\s*/, "") // 「10/13 的小組會議」拿掉日期後剩「的小組會議」
    .replace(/\s*的$/, "");
  const title = t.length >= 2 ? t.slice(0, 60) : filename.replace(/\.[^.]+$/, "");
  return { title, startedAt, people };
}
