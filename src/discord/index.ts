import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type Attachment,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { config, isAdmin, isAllowed } from "../config.js";
import * as store from "../store.js";
import { commitKnowledge, enqueue, ensureKnowledgeRepo, runAgent } from "../agent.js";
import { askPrompt, digestPrompt, noteAckPrompt } from "../prompts.js";

if (!config.discordToken) {
  console.error("缺 DISCORD_TOKEN，先填 .env");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const templateDir = path.resolve(here, "../../knowledge-template");

store.load();
await ensureKnowledgeRepo(templateDir);

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once("clientReady", () => {
  console.log(`[discord] logged in as ${client.user?.tag}, knowledge=${config.knowledgeDir}, claude=${config.claudeConfigDir}`);
  if (config.digestIntervalMin > 0) {
    setInterval(() => void digestAll("timer"), config.digestIntervalMin * 60_000);
    console.log(`[digest] every ${config.digestIntervalMin} min`);
  }
});

/* ---------- 收訊 ---------- */

function resolveChannelId(ch: TextBasedChannel): string {
  return "isThread" in ch && ch.isThread() && ch.parentId ? ch.parentId : ch.id;
}
function channelName(ch: TextBasedChannel): string {
  return "name" in ch && ch.name ? ch.name : ch.id;
}

const TEXT_EXT = /\.(md|txt|csv|json|log|srt|vtt|yaml|yml|html?)$/i;
const MAX_ATTACH = 8 * 1024 * 1024;

async function saveAttachments(project: string, atts: Iterable<Attachment>, rawHint: string): Promise<string[]> {
  const out: string[] = [];
  for (const a of atts) {
    if (a.size > MAX_ATTACH) {
      out.push(`${a.name}（${(a.size / 1048576).toFixed(1)}MB，太大沒存）<${a.url}>`);
      continue;
    }
    try {
      const res = await fetch(a.url);
      const buf = Buffer.from(await res.arrayBuffer());
      const safe = a.name.replace(/[^\w.\-一-鿿]/g, "_");
      const fname = `${rawHint}_${safe}`;
      fs.writeFileSync(path.join(store.filesDir(project), fname), buf);
      out.push(`files/${fname}${TEXT_EXT.test(a.name) ? "" : "（非文字）"}`);
    } catch (e) {
      out.push(`${a.name}（下載失敗）<${a.url}>`);
    }
  }
  return out;
}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.guildId) return;
  const chId = resolveChannelId(msg.channel);
  const p = store.projectByChannel(chId);
  if (!p) return;

  const mentioned = client.user ? msg.mentions.has(client.user) : false;
  const text = mentioned && client.user ? msg.content.replace(new RegExp(`<@!?${client.user.id}>`, "g"), "").trim() : msg.content;
  if (!text && msg.attachments.size === 0) return;

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const attachments = msg.attachments.size ? await saveAttachments(p.name, msg.attachments.values(), stamp) : [];
  const rawId = store.appendRaw({
    project: p.name,
    channelName: channelName(msg.channel),
    author: msg.member?.displayName ?? msg.author.username,
    authorId: msg.author.id,
    text: text || "（只有附件）",
    attachments,
    messageUrl: msg.url,
  });

  if (mentioned && text) await handleAsk(p, msg, text);
});

/* ---------- 問答 ---------- */

async function handleAsk(p: store.Project, msg: Message, question: string) {
  if (!isAllowed(msg.author.id)) {
    await msg.reply("這個 bot 目前只回 PM 的問題，請直接找 PM。");
    return;
  }
  const chId = resolveChannelId(msg.channel);
  const ch = msg.channel;
  const typing = "sendTyping" in ch ? setInterval(() => void ch.sendTyping().catch(() => {}), 8000) : undefined;
  if ("sendTyping" in ch) void ch.sendTyping().catch(() => {});
  try {
    const r = await enqueue(() => runAgent(askPrompt(p, msg.author.id, question), { project: p.name, mode: "ask", resume: p.askSessions[chId], label: `ask:${p.name}` }));
    if (r.sessionId) store.setAskSession(p.name, chId, r.sessionId);
    await replyChunked(msg, r.error ? `出錯：${r.error}` : r.text || "（沒有回覆）");
  } catch (e) {
    await msg.reply(`出錯：${(e as Error).message}`);
  } finally {
    if (typing) clearInterval(typing);
  }
}

async function replyChunked(msg: Message, text: string) {
  const chunks = splitDiscord(text);
  let first = true;
  for (const c of chunks) {
    if (first) await msg.reply({ content: c, allowedMentions: { repliedUser: true, users: [] } });
    else if ("send" in msg.channel) await msg.channel.send({ content: c, allowedMentions: { users: [] } });
    first = false;
  }
}

export function splitDiscord(text: string, limit = 1900): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > limit) {
      if (cur) out.push(cur);
      cur = line.length > limit ? line.slice(0, limit) : line;
    } else cur = cur ? cur + "\n" + line : line;
  }
  if (cur) out.push(cur);
  return out.length ? out : ["（空）"];
}

/* ---------- 整理 ---------- */

async function digestProject(p: store.Project, reason: string): Promise<string> {
  if (!store.hasPending(p.name)) return "無新訊息";
  const r = await enqueue(async () => {
    const res = await runAgent(digestPrompt(p), { project: p.name, mode: "digest", label: `digest:${p.name}:${reason}` });
    if (!res.error) {
      store.clearPending(p.name);
      await commitKnowledge(`digest ${p.name} (${reason})`);
    }
    return res;
  });
  p.lastDigestAt = new Date().toISOString();
  store.save();
  await flushOutbox(p);
  return r.error ? `出錯：${r.error}` : r.text || "完成";
}

async function digestAll(reason: string) {
  for (const p of store.activeProjects()) {
    if (!store.hasPending(p.name)) continue;
    try {
      const s = await digestProject(p, reason);
      console.log(`[digest] ${p.name}: ${s.split("\n")[0]}`);
    } catch (e) {
      console.error(`[digest] ${p.name} failed:`, e);
    }
  }
}

async function flushOutbox(p: store.Project) {
  const text = store.takeOutbox(p.name);
  if (!text || !p.primaryChannel) return;
  const ch = await client.channels.fetch(p.primaryChannel).catch(() => null);
  if (!ch || !ch.isTextBased() || !("send" in ch)) return;
  for (const c of splitDiscord(text)) await ch.send({ content: c });
}

/* ---------- 指令 ---------- */

client.on("interactionCreate", async (i) => {
  if (!i.isChatInputCommand()) return;
  try {
    switch (i.commandName) {
      case "project":
        return await cmdProject(i);
      case "ask":
        return await cmdAsk(i);
      case "digest":
        return await cmdDigest(i);
      case "note":
        return await cmdNote(i);
    }
  } catch (e) {
    console.error("[discord] command error:", e);
    const msg = `錯誤：${(e as Error).message}`;
    if (i.deferred || i.replied) await i.editReply(msg);
    else await i.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }
});

function needProject(i: ChatInputCommandInteraction): store.Project {
  if (!i.channel) throw new Error("只能在頻道內用");
  const p = store.projectByChannel(resolveChannelId(i.channel));
  if (!p) throw new Error("這個頻道沒綁專案。先 `/project new` 或 `/project bind`");
  return p;
}

async function cmdProject(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();
  if (sub === "list") {
    const ps = store.projects();
    if (!ps.length) return i.reply({ content: "還沒有專案", flags: MessageFlags.Ephemeral });
    const lines = ps.map((p) => `${p.status === "active" ? "🟢" : "⚫"} **${p.name}** — ${p.channels.map((c) => `<#${c}>`).join(" ") || "（沒綁頻道）"}`);
    return i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }
  if (sub === "status") {
    const p = needProject(i);
    const md = fs.readFileSync(path.join(store.projectDir(p.name), "STATE.md"), "utf8");
    await i.reply({ content: splitDiscord(md)[0], allowedMentions: { users: [] } });
    return;
  }
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  if (!i.channel) return i.reply({ content: "只能在頻道內用", flags: MessageFlags.Ephemeral });
  const here = resolveChannelId(i.channel);

  if (sub === "new") {
    const name = i.options.getString("name", true);
    store.createProject(name);
    store.bindChannel(name, here, true);
    await commitKnowledge(`new project ${name}`);
    return i.reply(`🟢 開了專案 **${name}**，<#${here}> 設為主頻道。從現在起這裡的訊息都會進筆記。`);
  }
  if (sub === "close") {
    const name = i.options.getString("name", true);
    store.closeProject(name);
    return i.reply(`⚫ 專案 **${name}** 已結束。停止收訊與提醒，資料保留，\`/ask\` 不能用但可以直接看 repo。`);
  }
  if (sub === "bind") {
    const name = i.options.getString("name", true);
    const ch = i.options.getChannel("channel")?.id ?? here;
    const primary = i.options.getBoolean("primary") ?? false;
    store.bindChannel(name, ch, primary);
    return i.reply(`🔗 <#${ch}> → **${name}**${primary ? "（主頻道）" : ""}`);
  }
  if (sub === "unbind") {
    const p = store.projectByChannel(here);
    store.unbindChannel(here);
    return i.reply(p ? `🔓 <#${here}> 解除與 **${p.name}** 的綁定` : "這頻道本來就沒綁");
  }
}

async function cmdAsk(i: ChatInputCommandInteraction) {
  if (!isAllowed(i.user.id)) return i.reply({ content: "這個 bot 目前只回 PM 的問題，請直接找 PM。", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  const q = i.options.getString("q", true);
  await i.deferReply();
  const chId = resolveChannelId(i.channel!);
  const r = await enqueue(() => runAgent(askPrompt(p, i.user.id, q), { project: p.name, mode: "ask", resume: p.askSessions[chId], label: `ask:${p.name}` }));
  if (r.sessionId) store.setAskSession(p.name, chId, r.sessionId);
  const chunks = splitDiscord(r.error ? `出錯：${r.error}` : r.text || "（沒有回覆）");
  await i.editReply({ content: `> ${q}\n\n${chunks[0]}`.slice(0, 2000), allowedMentions: { users: [] } });
  for (const c of chunks.slice(1)) await i.followUp({ content: c, allowedMentions: { users: [] } });
}

async function cmdDigest(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const s = await digestProject(p, "manual");
  await i.editReply(`整理 **${p.name}**：${s}`.slice(0, 2000));
}

async function cmdNote(i: ChatInputCommandInteraction) {
  if (!isAllowed(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  const text = i.options.getString("text", true);
  const file = i.options.getAttachment("file");
  await i.deferReply();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13);
  const attachments = file ? await saveAttachments(p.name, [file], stamp) : [];
  const rawId = store.appendRaw({
    project: p.name,
    channelName: i.channel ? channelName(i.channel) : "?",
    author: (i.member && "displayName" in i.member ? i.member.displayName : null) ?? i.user.username,
    authorId: i.user.id,
    text: `【重要】${text}`,
    attachments,
    messageUrl: `https://discord.com/channels/${i.guildId}/${i.channelId}`,
  });
  const r = await enqueue(async () => {
    const res = await runAgent(noteAckPrompt(p, rawId), { project: p.name, mode: "digest", label: `note:${p.name}` });
    if (!res.error) await commitKnowledge(`note ${p.name} ${rawId}`);
    return res;
  });
  await flushOutbox(p);
  await i.editReply({ content: `📝 收到（raw ${rawId}）。${r.error ? "整理出錯：" + r.error : r.text}`.slice(0, 2000), allowedMentions: { users: [] } });
}

/* ---------- 收尾 ---------- */

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[discord] ${sig}`);
    store.save();
    client.destroy();
    process.exit(0);
  });
}

client.login(config.discordToken);
