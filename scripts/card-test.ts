// 會議狀態卡：每個階段都要能 render，欄位長度不超過 Discord 限制
import assert from "node:assert/strict";
import { renderCard, fmtDur, type Phase } from "../src/discord/meeting-card.js";

const phases: Phase[] = ["joining", "waiting", "recording", "stopped", "transcribing", "done", "failed", "nosound"];
for (const phase of phases) {
  const e = renderCard({
    phase,
    label: "Google Meet abc-defg-hij",
    project: "軟體工程",
    invokerId: "1",
    startedAt: Date.now() - 90_000,
    durationSec: 103,
    participants: "Alice、Bob",
    transcript: "3 句，講者 A、B",
    note: "x".repeat(5000),
    summary: "y".repeat(5000),
  }).toJSON();
  assert.ok(e.title?.includes("Google Meet"), phase);
  assert.ok((e.description?.length ?? 0) <= 4096, `${phase} description 太長`);
  assert.ok((e.fields?.length ?? 0) <= 25);
  for (const f of e.fields ?? []) assert.ok(f.value.length <= 1024, `${phase} ${f.name} 太長`);
  if (phase === "done") assert.ok(e.description?.startsWith("y"), "done 顯示摘要");
  else assert.ok(e.description?.startsWith("x"), `${phase} 顯示 note`);
}
assert.equal(renderCard({ phase: "joining", label: "L", project: "P" }).toJSON().fields?.length, 1, "沒資料就只有專案欄");
assert.equal(fmtDur(103), "1 分 43 秒");
assert.equal(fmtDur(3661), "1 小時 1 分");
assert.equal(fmtDur(9), "9 秒");
console.log("✓ 會議狀態卡");
