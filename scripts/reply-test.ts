// 用正式專案資料的複本，測 @bot 回覆的範圍與長度
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureKnowledgeRepo, runAgent } from "../src/agent.js";
import { mentionPrompt } from "../src/prompts.js";
import * as store from "../src/store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
await ensureKnowledgeRepo(path.resolve(here, "../knowledge-template"));
store.load();
const p = store.createProject("軟體工程");
const dir = store.projectDir(p.id);
fs.cpSync(path.resolve(here, "../knowledge/nece42"), dir, { recursive: true });
fs.writeFileSync(path.join(dir, "pending.md"), "");
const base = { project: p.id, channelName: "root", author: "rlongdragon 阿龍", authorId: "601819508943880193", attachments: [], messageUrl: "https://x" };

const cases = [
  { name: "讀不到被回覆的網址", text: "記錄這個網址", context: ["（bot 沒有 Message Content 權限，讀不到被回覆的訊息內容和前後文。被回覆的是 小逗 的訊息：https://discord.com/channels/1/2/3）"] },
];
for (const c of cases) {
  const { id, block } = store.appendRaw({ ...base, text: c.text, context: c.context });
  const r = await runAgent(mentionPrompt(p, id, block), { project: p.id, mode: "digest", label: `reply-test:${c.name}` });
  const t = (r.error ?? r.text).trim();
  console.log(`\n===== ${c.name}（${t.length} 字，${r.turns} 輪）=====\n${t}`);
}
