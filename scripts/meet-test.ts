// 實際啟動 Meet 子程序：用不存在的會議代碼，確認錯誤回報、/meet stop 收尾、子程序會結束
import * as meeting from "../src/meeting/index.js";

const log: string[] = [];
let resolveDone: (f: meeting.Finished) => void;
meeting.setHandlers({
  status: (_a, msg) => log.push("status: " + msg),
  finished: (f) => resolveDone(f),
});
const wait = () => new Promise<meeting.Finished>((r) => (resolveDone = r));
const timeout = (ms: number) => new Promise<never>((_, rej) => setTimeout(() => rej(new Error("逾時")), ms));

let t0 = Date.now();
let done: Promise<meeting.Finished>;
let f: meeting.Finished;

// 2. 中途 /meet stop：子程序要收尾並結束
log.length = 0;
t0 = Date.now();
done = wait();
const a = meeting.startMeet("test02", "https://meet.google.com/abc-defg-hij", "0");
try {
  meeting.startMeet("test02", "https://meet.google.com/xyz-abcd-efg", "0");
  console.log("[2] ✗ 同專案第二場沒被擋");
} catch (e) {
  console.log("[2] ✓ 同專案第二場被擋：" + (e as Error).message);
}
await new Promise((r) => setTimeout(r, 8000));
await a.stop();
f = await Promise.race([done, timeout(70_000)]);
console.log(`[2] stop 後 ${((Date.now() - t0) / 1000).toFixed(0)}s 結束　error=${f.error ?? "（無）"}　active=${meeting.allActive().length}`);

for (const bad of ["https://zoom.us/j/123", "https://meet.google.com/"]) {
  try {
    meeting.startMeet("test03", bad, "0");
    console.log("✗ 沒擋：" + bad);
  } catch {
    console.log("✓ 擋下不合法網址：" + bad);
  }
}
process.exit(0);
