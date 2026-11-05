// 真 agent：@bot 用自然語言建排程，看它有沒有呼叫 schedule_add、種類和時間對不對。用 KNOWLEDGE_DIR 指到暫存目錄跑
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureKnowledgeRepo, runAgent } from "../src/agent.js";
import { mentionPrompt } from "../src/prompts.js";
import * as store from "../src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
await ensureKnowledgeRepo(path.resolve(here, "../knowledge-template"));
store.load();
const p = store.createProject("排程");
const ask = async (text: string) => {
  const { id, block } = store.appendRaw({ project: p.id, channelName: "test", author: "PM", authorId: "999", text, attachments: [], messageUrl: "https://discord.com/channels/x" });
  const r = await runAgent(mentionPrompt(p, id, block), { project: p.id, mode: "digest", label: "sched-test", schedule: { channelId: "c1", userId: "999" } });
  console.log(`> ${text}\n${r.error ?? r.text}\n`);
  return store.getProject(p.id)!.schedules ?? [];
};

let l = await ask("下週五下午三點提醒 <@111> 交期中報告");
assert.equal(l.length, 1, "建了一個");
assert.equal(l[0].kind, "remind");
assert.equal(new Date(l[0].nextAt).getDay(), 5);
assert.equal(new Date(l[0].nextAt).getHours(), 15);
assert.equal(l[0].createdBy, "999");

l = await ask("每週一早上九點幫我整理上週進度貼出來");
const a = l.find((s) => s.kind === "agent");
assert.ok(a?.cron, "週期性 agent 任務");
assert.match(a!.cron!, /^0 9 \* \* 1$/);

l = await ask("把交報告那個提醒取消");
assert.ok(!l.some((s) => s.kind === "remind"), "提醒被取消");
console.log("schedule-agent-test ok");
