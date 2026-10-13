// 真 agent 跑四種 @ 情境，看它是否只在明確要求時改筆記。用 KNOWLEDGE_DIR 指到暫存目錄跑
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureKnowledgeRepo, runAgent, commitKnowledge } from "../src/agent.js";
import { mentionPrompt } from "../src/prompts.js";
import * as store from "../src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
await ensureKnowledgeRepo(path.resolve(here, "../knowledge-template"));
store.load();
const p = store.createProject("登入系統");
const dir = store.projectDir(p.id);
const notesHash = () => {
  const h = crypto.createHash("sha1");
  for (const f of ["STATE.md", "decisions.md", "people.md"]) h.update(fs.readFileSync(path.join(dir, f)));
  for (const f of fs.readdirSync(path.join(dir, "notes"))) h.update(f + fs.readFileSync(path.join(dir, "notes", f)));
  return h.digest("hex");
};

const cases: { name: string; text: string; context?: string[]; expectChange: boolean }[] = [
  { name: "明確記錄", text: "幫我記錄：後端 API 確定用 FastAPI，Bob 拍板的", expectChange: true },
  {
    name: "reply + 加入追蹤",
    text: "加入追蹤",
    context: ["被回覆的訊息：", "> 14:02 **Alice**（<@111>）：登入頁 UI 我來做，下週三前交", "前後文：", "> 14:01 **PM**（<@999>）：登入頁誰要接？"],
    expectChange: true,
  },
  { name: "純問題", text: "登入頁現在誰在做？期限是？", expectChange: false },
  { name: "像要記但沒說", text: "Bob 也會負責部署", expectChange: false },
];

let pass = 0;
for (const c of cases) {
  const { id, block } = store.appendRaw({ project: p.id, channelName: "general", author: "PM", authorId: "999", text: c.text, attachments: [], messageUrl: "https://x", context: c.context });
  const before = notesHash();
  const r = await runAgent(mentionPrompt(p, id, block), { project: p.id, mode: "digest", label: `mention-test:${c.name}` });
  store.removePending(p.id, [id]);
  await commitKnowledge(`test ${c.name}`);
  const changed = notesHash() !== before;
  const ok = changed === c.expectChange;
  if (ok) pass++;
  console.log(`\n${ok ? "✓" : "✗"} ${c.name}：筆記${changed ? "有改" : "沒改"}（預期${c.expectChange ? "要改" : "不改"}）`);
  console.log("  回覆：" + (r.error ?? r.text).replace(/\n/g, "\n        ").slice(0, 400));
}
console.log(`\n==== STATE.md 進行中 ====\n` + fs.readFileSync(path.join(dir, "STATE.md"), "utf8").split("## 阻塞")[0].split("## 進行中")[1]?.trim());
console.log(`==== decisions.md ====\n` + fs.readFileSync(path.join(dir, "decisions.md"), "utf8").trim());
console.log(`==== outbox ====\n` + (store.peekOutbox(p.id) ?? "（空）"));
console.log(`\n${pass}/${cases.length} 符合預期`);
