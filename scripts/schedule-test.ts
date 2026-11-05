// 排程單元測試，不呼叫模型、不連 Discord。用 KNOWLEDGE_DIR / STATE_FILE 指到暫存目錄跑
import assert from "node:assert/strict";
import * as store from "../src/store.js";
import { add, edit, list, nextCron, parseScheduleWhen, pause, remove, resume, takeDue } from "../src/schedule.js";
import { checkToolCall } from "../src/sandbox.js";

// 2026-11-05（四）14:55，伺服器時區
const now = new Date(2026, 10, 5, 14, 55, 30);
const at = (s: string) => {
  const w = parseScheduleWhen(s, now);
  assert.ok("at" in w, `${s} 應該是一次性`);
  return w.at;
};
const cron = (s: string) => {
  const w = parseScheduleWhen(s, now);
  assert.ok("cron" in w, `${s} 應該是週期性`);
  return w.cron;
};
const ymdhm = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

/* 時間解析 */
assert.equal(ymdhm(at("2026-11-07 15:00")), "2026-11-7 15:00");
assert.equal(ymdhm(at("11/7 15:00")), "2026-11-7 15:00");
assert.equal(ymdhm(at("11／7 15：00")), "2026-11-7 15:00", "全形");
assert.equal(ymdhm(at("1/3 9:00")), "2027-1-3 9:00", "沒寫年、已經過了 = 明年");
assert.equal(ymdhm(at("16:00")), "2026-11-5 16:00", "今天還沒過");
assert.equal(ymdhm(at("9:00")), "2026-11-6 9:00", "今天已過 = 明天");
assert.equal(ymdhm(at("明天 9:00")), "2026-11-6 9:00");
assert.equal(ymdhm(at("後天")), "2026-11-7 9:00", "沒寫時間預設 9:00");
assert.equal(at("+30m").getTime() - now.getTime(), 30 * 60_000);
assert.equal(at("+2h").getTime() - now.getTime(), 2 * 3600_000);
assert.equal(cron("每天 9:00"), "0 9 * * *");
assert.equal(cron("平日 18:30"), "30 18 * * 1-5");
assert.equal(cron("每週一 9:00"), "0 9 * * 1");
assert.equal(cron("每週一三五 9:00"), "0 9 * * 1,3,5");
assert.equal(cron("每週日"), "0 9 * * 0");
assert.equal(cron("每月 1 號 10:00"), "0 10 1 * *");
assert.equal(cron("*/15 9-18 * * 1-5"), "*/15 9-18 * * 1-5");
assert.throws(() => parseScheduleWhen("下禮拜某天", now), /看不懂/);
assert.throws(() => parseScheduleWhen("25:00", now), /看不懂/);
assert.throws(() => parseScheduleWhen("0 9 * * 8", now), /超出範圍/);

/* cron 下一次 */
const n = (c: string, d = now) => ymdhm(nextCron(c, d));
assert.equal(n("0 9 * * *"), "2026-11-6 9:00");
assert.equal(n("0 15 * * *"), "2026-11-5 15:00");
assert.equal(n("0 9 * * 1"), "2026-11-9 9:00", "下週一");
assert.equal(n("0 9 * * 1-5", new Date(2026, 10, 6, 10)), "2026-11-9 9:00", "週五過後跳到週一");
assert.equal(n("0 9 31 * *"), "2026-12-31 9:00", "11 月沒有 31 號");
assert.equal(n("*/15 * * * *"), "2026-11-5 15:00");
assert.equal(n("0 9 1 * 1"), "2026-11-9 9:00", "日跟週都有限制時是「或」");
assert.equal(n("0 9 * * 7"), "2026-11-8 9:00", "7 = 週日");
assert.equal(n("0 0 29 2 *"), "2028-2-29 0:00", "閏年");

/* 存取 */
store.load();
const p = store.createProject("排程測試");
const r1 = add(p, { kind: "remind", when: "15:00", text: "交報告 <@1>", channelId: "c1", createdBy: "u1" }, now);
const r2 = add(p, { kind: "agent", when: "每天 9:00", text: "整理昨天進度", channelId: "c1", createdBy: "u1" }, now);
assert.match(r1.id, /^[2-9a-hjkmnp-z]{4}$/);
assert.ok(r1.at && !r1.cron);
assert.ok(r2.cron && !r2.at);
assert.deepEqual(list(p).map((s) => s.id), [r1.id, r2.id], "依下次時間排序");
assert.throws(() => add(p, { kind: "remind", when: "+0m", text: "x", channelId: "c1", createdBy: "u1" }, now), /已經過了/);
assert.throws(() => add(p, { kind: "remind", when: "15:00", text: "  ", channelId: "c1", createdBy: "u1" }, now), /空/);

// 還沒到
assert.equal(takeDue(p, new Date(2026, 10, 5, 14, 59)).length, 0);
// 15:00 到：一次性觸發後刪掉
const due = takeDue(p, new Date(2026, 10, 5, 15, 0, 10));
assert.deepEqual(due.map((s) => s.id), [r1.id]);
assert.equal(due[0].nextAt, r1.nextAt, "回傳的是觸發前的副本（算遲到用）");
assert.ok(!p.schedules!.some((s) => s.id === r1.id), "一次性觸發後刪掉");
assert.equal(takeDue(p, new Date(2026, 10, 5, 15, 0, 40)).length, 0, "不重複觸發");

// bot 停了兩天：週期性只跑一次，下一次從現在算
const late = takeDue(p, new Date(2026, 10, 8, 12, 0));
assert.deepEqual(late.map((s) => s.id), [r2.id]);
assert.equal(ymdhm(new Date(p.schedules![0].nextAt)), "2026-11-9 9:00");

// 暫停、恢復、修改
pause(p, r2.id);
assert.equal(takeDue(p, new Date(2026, 10, 10, 9, 0)).length, 0, "暫停中不觸發");
resume(p, r2.id, new Date(2026, 10, 10, 10, 0));
assert.equal(ymdhm(new Date(p.schedules![0].nextAt)), "2026-11-11 9:00", "恢復從現在重算");
edit(p, r2.id, { when: "每週五 17:00", text: "週報" }, new Date(2026, 10, 10, 10, 0));
assert.equal(p.schedules![0].cron, "0 17 * * 5");
assert.equal(p.schedules![0].text, "週報");
assert.equal(ymdhm(new Date(p.schedules![0].nextAt)), "2026-11-13 17:00");
edit(p, r2.id, { when: "2026-11-20 10:00" }, new Date(2026, 10, 10, 10, 0));
assert.ok(p.schedules![0].at && !p.schedules![0].cron, "週期改一次性");
const r3 = add(p, { kind: "remind", when: "+1h", text: "x", channelId: "c1", createdBy: "u1" }, now);
pause(p, r3.id);
assert.throws(() => resume(p, r3.id, new Date(2026, 10, 6)), /已經過了/, "一次性過期不能恢復");
remove(p, r3.id);
assert.throws(() => remove(p, r3.id), /找不到/);

/* sandbox：排程工具只有 digest 能用 */
assert.ok(checkToolCall("/x", "digest", "mcp__pm__schedule_add", {}).ok);
assert.ok(!checkToolCall("/x", "ask", "mcp__pm__schedule_add", {}).ok);
assert.ok(!checkToolCall("/x", "digest", "mcp__other__thing", {}).ok);

console.log("schedule-test ok");
