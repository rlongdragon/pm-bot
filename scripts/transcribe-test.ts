// 拿一場真的錄音跑轉錄：npx tsx scripts/transcribe-test.ts <錄音資料夾>
import fs from "node:fs";
import path from "node:path";
import { speakerTimeline, transcribe, hms, buildPrompt } from "../src/meeting/transcribe.js";

const dir = process.argv[2];
const m = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const tl = await speakerTimeline(dir, m);
console.log("講者時間線：\n" + tl.map((s) => `  ${hms(s.start, false)}–${hms(s.end, false)} ${s.name}`).join("\n"));
const t0 = Date.now();
const r = await transcribe(dir, m, "測試錄音", (msg) => console.log(msg));
console.log(`\n轉錄 ${((Date.now() - t0) / 1000).toFixed(1)}s，${r.lines} 句，講者：${r.speakers.join("、")}\n`);
console.log(r.markdown);
