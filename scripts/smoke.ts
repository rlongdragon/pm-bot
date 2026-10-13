// 不開 Discord，直接驗證 agent 能在知識庫裡跑、能寫檔、能 commit
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../src/config.js";
import { commitKnowledge, ensureKnowledgeRepo, runAgent } from "../src/agent.js";
import * as store from "../src/store.js";
import { digestPrompt } from "../src/prompts.js";

const here = path.dirname(fileURLToPath(import.meta.url));
await ensureKnowledgeRepo(path.resolve(here, "../knowledge-template"));
store.load();
const name = "smoke";
if (!store.getProject(name)) store.createProject(name);
const p = store.getProject(name)!;
store.appendRaw({ project: name, channelName: "general", author: "Alice", authorId: "111", text: "登入頁 UI 我來做，下週三前交", attachments: [], messageUrl: "https://discord.com/x" });
store.appendRaw({ project: name, channelName: "general", author: "Bob", authorId: "222", text: "那後端 API 就決定用 FastAPI 了，不用 Express", attachments: [], messageUrl: "https://discord.com/y" });
console.log("config dir:", config.claudeConfigDir);
const r = await runAgent(digestPrompt(p), { label: "smoke" });
console.log("---- result ----\n" + (r.error ?? r.text));
if (!r.error) { store.clearPending(name); console.log("committed:", await commitKnowledge("smoke digest")); }
console.log("outbox:", store.takeOutbox(name));
