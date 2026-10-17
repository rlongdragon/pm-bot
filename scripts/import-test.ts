// 外部錄音匯入：日期解析、ffmpeg 轉檔、manifest；用 ffmpeg 合成一段 5 秒的音檔測
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pm-import-"));
process.env.RECORDINGS_DIR = path.join(tmp, "rec");
const { importAudio, parseWhen } = await import("../src/meeting/import.js");

// 日期
const now = new Date(2026, 9, 14, 12, 0);
assert.equal(parseWhen("2026-10-13", now)?.toISOString(), new Date(2026, 9, 13).toISOString());
assert.equal(parseWhen("2026/10/13 14:30", now)?.getHours(), 14);
assert.equal(parseWhen("10/13", now)?.getMonth(), 9);
assert.equal(parseWhen("10/13 9:05", now)?.getMinutes(), 5);
assert.equal(parseWhen("昨天", now), null);
assert.equal(parseWhen("", now), null);
console.log("✓ 日期解析");

// 合成 5 秒 440Hz 的 m4a 當實體會議錄音
const src = path.join(tmp, "會議 錄音.m4a");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=5", "-c:a", "aac", src]);
const { dir, manifest } = await importAudio("abc123", src, { title: "第 3 次小組會議", startedAt: new Date(2026, 9, 13, 14, 30), people: ["Alice", "Bob"], filename: "會議 錄音.m4a" });
assert.ok(dir.includes("2026-10-13T14-30-00_upload_第_3_次小組會議"), dir);
assert.ok(fs.existsSync(path.join(dir, "mixed.ogg")));
assert.ok(fs.existsSync(path.join(dir, "tracks", "original.m4a")), "原檔留著");
assert.ok(!fs.existsSync(src), "暫存檔搬走了");
assert.equal(manifest.platform, "upload");
assert.equal(manifest.source, "第 3 次小組會議");
assert.ok(Math.abs((manifest.durationSec ?? 0) - 5) < 0.5, String(manifest.durationSec));
assert.deepEqual(manifest.participants.map((p) => p.name), ["Alice", "Bob"]);
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")).files.mixed, "mixed.ogg");
console.log("✓ 匯入轉檔");

// 不是音訊
const bad = path.join(tmp, "x.txt");
fs.writeFileSync(bad, "hello");
await assert.rejects(importAudio("abc123", bad, { title: "t", filename: "x.txt" }), /不是音訊檔/);
console.log("✓ 拒絕非音訊");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("all ok");
