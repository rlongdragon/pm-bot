/**
 * 會議錄音轉逐字稿：mixed.ogg 切段丟 Gemini（經 ai.rlong.me，OpenAI 相容 API 的 input_audio）。
 * 講者標註：Discord 錄音每人一軌，用 ffmpeg silencedetect 算出每個人講話的時間段，附在 prompt 當線索；
 * Google Meet 只有混音，交給 Gemini 從聲音和內容判斷。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Manifest } from "./session.js";

export interface Speech {
  start: number;
  end: number;
  name: string;
}
export interface Line {
  t: number;
  speaker: string;
  text: string;
}

function ffmpeg(args: string[], cmd = "ffmpeg"): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exit ${code}: ${out.slice(-300)}`))));
  });
}

async function duration(file: string): Promise<number> {
  return Number((await ffmpeg(["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], "ffprobe")).trim());
}

/** 一軌裡有聲音的時間段：silencedetect 的補集，間隔 <0.8 秒合併，<0.3 秒的丟掉 */
export async function speechIntervals(file: string): Promise<[number, number][]> {
  const dur = await duration(file);
  const out = await ffmpeg(["-hide_banner", "-i", file, "-af", "silencedetect=noise=-35dB:d=0.6", "-f", "null", "-"]);
  const silences: [number, number][] = [];
  let s: number | null = null;
  for (const m of out.matchAll(/silence_(start|end): ([0-9.]+)/g)) {
    if (m[1] === "start") s = Number(m[2]);
    else if (s !== null) {
      silences.push([s, Number(m[2])]);
      s = null;
    }
  }
  if (s !== null) silences.push([s, dur]);
  const speech: [number, number][] = [];
  let cur = 0;
  for (const [a, b] of silences) {
    if (a > cur) speech.push([cur, a]);
    cur = b;
  }
  if (cur < dur) speech.push([cur, dur]);
  const merged: [number, number][] = [];
  for (const iv of speech) {
    const last = merged[merged.length - 1];
    if (last && iv[0] - last[1] < 0.8) last[1] = iv[1];
    else merged.push([...iv]);
  }
  return merged.filter(([a, b]) => b - a >= 0.3);
}

export async function speakerTimeline(dir: string, m: Manifest): Promise<Speech[]> {
  if (m.platform !== "discord") return [];
  const all: Speech[] = [];
  for (const p of m.participants) {
    if (!p.file || !fs.existsSync(path.join(dir, p.file))) continue;
    for (const [start, end] of await speechIntervals(path.join(dir, p.file))) all.push({ start, end, name: p.name });
  }
  return all.sort((a, b) => a.start - b.start);
}

export function hms(sec: number, withHours = true) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return withHours || h ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function makeChunks(dir: string): Promise<{ file: string; offset: number; dur: number }[]> {
  const out = path.join(dir, "transcribe");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const seg = config.transcribeChunkMin * 60;
  await ffmpeg([
    "-hide_banner", "-loglevel", "error", "-y", "-i", path.join(dir, "mixed.ogg"),
    "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k",
    "-f", "segment", "-segment_time", String(seg), "-reset_timestamps", "1",
    path.join(out, "chunk_%03d.mp3"),
  ]);
  const files = fs.readdirSync(out).filter((f) => f.endsWith(".mp3")).sort();
  const chunks = [];
  let offset = 0;
  for (const f of files) {
    const d = await duration(path.join(out, f));
    chunks.push({ file: path.join(out, f), offset, dur: d });
    offset += d;
  }
  return chunks;
}

export function buildPrompt(o: { m: Manifest; index: number; total: number; offset: number; dur: number; timeline: Speech[]; prevTail: Line[] }): string {
  const names = o.m.participants.map((p) => p.name);
  const discord = o.m.platform === "discord";
  const parts = [
    `這是一場會議錄音的第 ${o.index + 1}/${o.total} 段（從會議開始後 ${hms(o.offset)} 起，長 ${hms(o.dur)}）。`,
    "語言以台灣華語為主，夾雜英文；英文詞保留原文。",
    "",
    `與會者${discord ? "" : "（從入會通知抓的，可能不完整）"}：${names.join("、") || "（不知道）"}`,
  ];
  const tl = o.timeline
    .filter((s) => s.end > o.offset && s.start < o.offset + o.dur)
    .slice(0, 600)
    .map((s) => `${hms(Math.max(0, s.start - o.offset), false)}–${hms(Math.min(o.dur, s.end - o.offset), false)} ${s.name}`);
  if (tl.length) {
    parts.push(
      "",
      "這一段每個人實際在講話的時間（從這一段開頭起算，來自各自的麥克風，很準）：",
      ...tl,
      "請依這份時間表決定每句話是誰說的。兩人同時講話時依內容判斷。",
    );
  } else {
    parts.push("", "請從聲音和對話內容判斷講者。能對到與會者名字就用名字；對不到就用「講者A」「講者B」，同一個人前後要一致。");
  }
  if (o.prevTail.length) {
    parts.push("", "上一段最後幾句（讓你接續講者，不要重複輸出）：", ...o.prevTail.map((l) => `${l.speaker}：${l.text}`));
  }
  parts.push(
    "",
    "輸出逐字稿，每行一句，格式嚴格如下：",
    "[MM:SS] 名字：內容",
    "- 時間從這一段開頭起算。",
    "- 用繁體中文。聽不清楚的地方寫［聽不清］，不要猜。",
    "- 不要摘要、不要改寫、不要補充，只轉寫實際講的話。語助詞和口頭禪可以省略。",
    "- 長時間沒有人講話就跳過。",
    "- 只輸出逐字稿，不要任何說明或標題。",
  );
  return parts.join("\n");
}

async function apiKey(): Promise<string> {
  if (config.transcribeApiKey) return config.transcribeApiKey;
  if (config.transcribeApiKeyFile) return fs.readFileSync(config.transcribeApiKeyFile, "utf8").trim();
  throw new Error("沒設 TRANSCRIBE_API_KEY 或 TRANSCRIBE_API_KEY_FILE");
}

export function transcribeEnabled(): boolean {
  return !!config.transcribeModel && !!(config.transcribeApiKey || (config.transcribeApiKeyFile && fs.existsSync(config.transcribeApiKeyFile)));
}

/** 依序試主模型和備援模型；每個模型重試 2 次。回傳文字和實際用的模型 */
async function callModel(prompt: string, mp3: string): Promise<{ text: string; model: string }> {
  const key = await apiKey();
  const audio = fs.readFileSync(mp3).toString("base64");
  const errors: string[] = [];
  for (const model of [config.transcribeModel, ...config.transcribeFallbackModels].filter((x, i, a) => x && a.indexOf(x) === i)) {
    const body = JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "input_audio", input_audio: { data: audio, format: "mp3" } }] }],
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(config.transcribeBaseUrl.replace(/\/$/, "") + "/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(10 * 60_000),
        });
        const j: any = await r.json().catch(() => ({}));
        if (r.ok) {
          const text = j.choices?.[0]?.message?.content;
          if (typeof text === "string" && text.trim()) return { text, model };
          errors.push(`${model}：回了空的內容`);
        } else {
          const msg = j.error?.message ?? JSON.stringify(j);
          errors.push(`${model} ${r.status}：${String(msg).replace(/\s+/g, " ").slice(0, 120)}`);
          if (r.status < 500 && r.status !== 429) break; // 4xx 重試沒用，換下一個模型
        }
      } catch (e) {
        errors.push(`${model}：${(e as Error).message}`);
      }
      await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
    }
    console.warn(`[transcribe] ${model} 失敗，換下一個`);
  }
  throw new Error("所有轉錄模型都失敗：\n" + errors.slice(-4).join("\n"));
}

export function parseLines(text: string, offset: number): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    const m = raw.trim().match(/^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s*([^：:\]]{1,40}?)\s*[：:]\s*(.+)$/);
    if (!m) continue;
    const sec = m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
    lines.push({ t: offset + sec, speaker: m[4].trim(), text: m[5].trim() });
  }
  return lines;
}

export interface TranscriptResult {
  file: string;
  markdown: string;
  lines: number;
  speakers: string[];
  models: string[];
}

export async function transcribe(dir: string, m: Manifest, label: string, onProgress?: (msg: string) => void): Promise<TranscriptResult> {
  if (!fs.existsSync(path.join(dir, "mixed.ogg"))) throw new Error("這場錄音沒有 mixed.ogg");
  const timeline = await speakerTimeline(dir, m);
  const chunks = await makeChunks(dir);
  const all: Line[] = [];
  const used = new Set<string>();
  for (const [i, c] of chunks.entries()) {
    if (chunks.length > 1) onProgress?.(`轉錄第 ${i + 1}/${chunks.length} 段`);
    const prompt = buildPrompt({ m, index: i, total: chunks.length, offset: c.offset, dur: c.dur, timeline, prevTail: all.slice(-6) });
    const { text, model } = await callModel(prompt, c.file);
    used.add(model);
    const lines = parseLines(text, c.offset);
    if (!lines.length && text.trim()) all.push({ t: c.offset, speaker: "（格式無法解析）", text: text.trim().slice(0, 4000) });
    all.push(...lines);
  }
  fs.rmSync(path.join(dir, "transcribe"), { recursive: true, force: true });

  const speakers = [...new Set(all.map((l) => l.speaker))];
  const started = new Date(m.startedAt).toLocaleString("zh-TW", { hour12: false });
  const md = [
    `# 會議逐字稿：${label}`,
    "",
    `- 開始：${started}`,
    `- 長度：${hms(m.durationSec ?? chunks.reduce((s, c) => s + c.dur, 0))}`,
    `- 與會者：${m.participants.map((p) => p.name).join("、") || "（不知道）"}`,
    `- 講者標註：${timeline.length ? "依每個人自己的麥克風（Discord 每人一軌），準確" : "由模型從聲音判斷，可能有誤"}`,
    `- 轉錄：${[...used].join("、")}，自動產生，可能有錯字`,
    "",
    ...all.map((l) => `[${hms(l.t)}] ${l.speaker}：${l.text}`),
    "",
  ].join("\n");
  const file = path.join(dir, "transcript.md");
  fs.writeFileSync(file, md);
  return { file, markdown: md, lines: all.length, speakers, models: [...used] };
}
