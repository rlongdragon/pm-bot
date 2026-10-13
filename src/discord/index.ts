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
import { commitKnowledge, enqueue, ensureKnowledgeRepo, runAgent, type AgentResult } from "../agent.js";
import { askPrompt, mentionPrompt, notePrompt, reviewPrompt } from "../prompts.js";
import type { Mode } from "../sandbox.js";

if (!config.discordToken) {
  console.error("缺 DISCORD_TOKEN，先填 .env");
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
store.load();
await ensureKnowledgeRepo(path.resolve(here, "../../knowledge-template"));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once("clientReady", () => {
  console.log(`[discord] logged in as ${client.user?.tag}, knowledge=${config.knowledgeDir}, claude=${config.claudeConfigDir}`);
  if (config.reviewHour >= 0) {
    setInterval(() => void reviewDue(), 10 * 60_000);
    console.log(`[review] daily at ${config.reviewHour}:00`);
  }
});

/* ---------- 工具 ---------- */

function resolveChannelId(ch: TextBasedChannel): string {
  return "isThread" in ch && ch.isThread() && ch.parentId ? ch.parentId : ch.id;
}
function channelName(ch: TextBasedChannel): string {
  return "name" in ch && ch.name ? ch.name : ch.id;
}
function displayName(m: Message): string {
  return m.member?.displayName ?? m.author.globalName ?? m.author.username;
}
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
}

const TEXT_EXT = /\.(md|txt|csv|json|log|srt|vtt|yaml|yml|html?)$/i;
const MAX_ATTACH = 8 * 1024 * 1024;

async function saveAttachments(project: string, atts: Iterable<Attachment>): Promise<string[]> {
  const out: string[] = [];
  const hint = stamp();
  for (const a of atts) {
    if (a.size > MAX_ATTACH) {
      out.push(`${a.name}（${(a.size / 1048576).toFixed(1)}MB，太大沒存）<${a.url}>`);
      continue;
    }
    try {
      const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer());
      const fname = `${hint}_${a.name.replace(/[^\w.\-一-鿿]/g, "_")}`;
      fs.writeFileSync(path.join(store.filesDir(project), fname), buf);
      out.push(`files/${fname}${TEXT_EXT.test(a.name) ? "" : "（非文字）"}`);
    } catch {
      out.push(`${a.name}（下載失敗）<${a.url}>`);
    }
  }
  return out;
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

async function flushOutbox(p: store.Project) {
  const text = store.takeOutbox(p.id);
  if (!text || !p.primaryChannel) return;
  const ch = await client.channels.fetch(p.primaryChannel).catch(() => null);
  if (!ch || !ch.isTextBased() || !("send" in ch)) return;
  for (const c of splitDiscord(text)) await ch.send({ content: c });
}

/** 跑 agent；成功就把這幾筆移出 pending 並 commit */
async function runAndCommit(p: store.Project, mode: Mode, prompt: string, label: string, opts: { session?: string; rawIds?: string[] } = {}) {
  const r: AgentResult = await enqueue(async () => {
    const res = await runAgent(prompt, { project: p.id, mode, label: `${label}:${p.id}`, resume: opts.session ? store.getSession(p, opts.session) : undefined });
    if (!res.error && mode === "digest") {
      if (opts.rawIds?.length) store.removePending(p.id, opts.rawIds);
      await commitKnowledge(`${label} ${p.id}${opts.rawIds?.length ? " " + opts.rawIds.join(",") : ""}`);
    }
    return res;
  });
  if (opts.session && r.sessionId) store.setSession(p, opts.session, r.sessionId);
  await flushOutbox(p);
  return r;
}

/* ---------- 被叫才處理 ---------- */

function isCalled(msg: Message<true>): boolean {
  const me = client.user;
  if (!me) return false;
  if (msg.mentions.users.has(me.id)) return true; // 直接 @，或 reply bot 的訊息
  const role = msg.guild.members.me?.roles.botRole; // 有人不小心 @ 到 bot 的身分組
  return !!role && msg.mentions.roles.has(role.id);
}

function stripMention(msg: Message<true>): string {
  const me = client.user!.id;
  const role = msg.guild.members.me?.roles.botRole?.id;
  let t = msg.content.replace(new RegExp(`<@!?${me}>`, "g"), "");
  if (role) t = t.replace(new RegExp(`<@&${role}>`, "g"), "");
  return t.trim();
}

function quote(m: Message): string {
  const att = m.attachments.size ? `［附件 ${m.attachments.size}］` : "";
  const body = (m.content || "").replace(/\n/g, " ").slice(0, 500);
  return `> ${store.hhmm(m.createdAt)} **${displayName(m)}**（<@${m.author.id}>）：${body}${att}`;
}

/** reply 某句話時：抓被回覆的訊息＋前後幾則。reply 的是 bot 自己的回答就只抓那一則 */
async function gatherContext(msg: Message<true>): Promise<{ lines: string[]; atts: Attachment[] }> {
  if (!msg.reference?.messageId) return { lines: [], atts: [] };
  const ref = await msg.fetchReference().catch(() => null);
  if (!ref) return { lines: [], atts: [] };
  const atts = [...ref.attachments.values()];
  if (ref.author.id === client.user?.id) return { lines: ["回覆 bot 先前的回答：", quote(ref)], atts };

  const ch = msg.channel;
  const [before, after] = await Promise.all([
    config.contextBefore > 0 ? ch.messages.fetch({ before: ref.id, limit: config.contextBefore }).catch(() => null) : null,
    config.contextAfter > 0 ? ch.messages.fetch({ after: ref.id, limit: config.contextAfter + 1 }).catch(() => null) : null,
  ]);
  const ctx = [...(before?.values() ?? []), ...(after?.values() ?? [])]
    .filter((m) => m.id !== msg.id && m.createdTimestamp < msg.createdTimestamp)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  const lines = ["被回覆的訊息：", quote(ref)];
  if (ctx.length) lines.push("前後文：", ...ctx.map(quote));
  return { lines, atts };
}

client.on("messageCreate", async (msg) => {
  if (msg.author.bot || !msg.inGuild()) return;
  const p = store.projectByChannel(resolveChannelId(msg.channel));
  if (!p || !isCalled(msg)) return; // 平常對話不聽、不存
  if (!isAllowed(msg.author.id)) {
    await msg.reply("這個 bot 目前只回 PM，請直接找 PM。");
    return;
  }
  const ch = msg.channel;
  const typing = setInterval(() => void ch.sendTyping().catch(() => {}), 8000);
  void ch.sendTyping().catch(() => {});
  try {
    const text = stripMention(msg);
    const ctx = await gatherContext(msg);
    const allAtts = [...msg.attachments.values(), ...ctx.atts];
    if (!text && !allAtts.length && !ctx.lines.length) {
      await msg.reply("要我做什麼？要記錄就說「幫我記錄」或「加入追蹤」，要問就直接問。");
      return;
    }
    const attachments = allAtts.length ? await saveAttachments(p.id, allAtts) : [];
    const { id: rawId, block } = store.appendRaw({
      project: p.id,
      channelName: channelName(ch),
      author: displayName(msg),
      authorId: msg.author.id,
      text: text || "（沒有附文字）",
      attachments,
      messageUrl: msg.url,
      context: ctx.lines,
    });
    store.touch(p, "lastRecordAt");
    const chId = resolveChannelId(ch);
    const r = await runAndCommit(p, "digest", mentionPrompt(p, rawId, block), "mention", { session: `mention:${chId}`, rawIds: [rawId] });
    await replyChunked(msg, r.error ? `出錯了，這則已經存成 raw ${rawId}，巡檢時會再整理一次。\n\`${r.error}\`` : r.text || "（沒有回覆）");
  } catch (e) {
    console.error("[mention] failed:", e);
    await msg.reply(`出錯：${(e as Error).message}`).catch(() => {});
  } finally {
    clearInterval(typing);
  }
});

async function replyChunked(msg: Message, text: string) {
  const chunks = splitDiscord(text);
  await msg.reply({ content: chunks[0], allowedMentions: { repliedUser: true, users: [] } });
  for (const c of chunks.slice(1)) if ("send" in msg.channel) await msg.channel.send({ content: c, allowedMentions: { users: [] } });
}

/* ---------- 巡檢 ---------- */

async function reviewProject(p: store.Project, reason: string): Promise<string> {
  const pending = store.pendingIds(p.id);
  const st = store.stats(p.id);
  store.touch(p, "lastReviewAt");
  if (!pending.length && st.openTasks === 0) return "沒有進行中任務，也沒有待整理的記錄";
  const r = await runAndCommit(p, "digest", reviewPrompt(p, pending), `review-${reason}`, { rawIds: pending });
  return r.error ? `出錯：${r.error}` : r.text || "完成";
}

async function reviewDue() {
  if (new Date().getHours() !== config.reviewHour) return;
  const t = store.today();
  for (const p of store.activeProjects()) {
    if (p.lastDailyReview === t) continue;
    p.lastDailyReview = t;
    store.save();
    try {
      console.log(`[review] ${p.id}: ${(await reviewProject(p, "daily")).split("\n")[0]}`);
    } catch (e) {
      console.error(`[review] ${p.id} failed:`, e);
    }
  }
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
      case "note":
        return await cmdNote(i);
      case "review":
        return await cmdReview(i);
    }
  } catch (e) {
    console.error("[discord] command error:", e);
    const msg = `錯誤：${(e as Error).message}`;
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

function hereId(i: ChatInputCommandInteraction): string {
  if (!i.channel) throw new Error("只能在頻道內用");
  return resolveChannelId(i.channel);
}
function needProject(i: ChatInputCommandInteraction): store.Project {
  const p = store.projectByChannel(hereId(i));
  if (!p) throw new Error("這個頻道不在任何專案裡。`/project new` 開新的，或 `/project join <id>` 加入既有的");
  return p;
}
const fmtDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleString("zh-TW", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

function infoText(p: store.Project): string {
  const s = store.stats(p.id);
  const status = p.status === "active" ? "🟢 進行中" : `⚫ 已結束（${fmtDate(p.closedAt)}）`;
  return [
    `**${p.name}**　ID \`${p.id}\`　${status}`,
    `建立 ${p.createdAt.slice(0, 10)}${p.createdBy ? ` by <@${p.createdBy}>` : ""}`,
    `頻道：${p.channels.map((c) => (c === p.primaryChannel ? `<#${c}>（主）` : `<#${c}>`)).join(" ") || "（沒有）"}`,
    "",
    `記錄 **${s.records}** 則　最後 ${fmtDate(p.lastRecordAt)}${s.pending ? `　⚠️ 待整理 ${s.pending}` : ""}`,
    `任務 進行中 **${s.openTasks}**　完成 **${s.doneTasks}**`,
    `決策 **${s.decisions}**　筆記 **${s.notes}**　附件 **${s.files}**　成員 **${s.people}**`,
    `最後巡檢 ${fmtDate(p.lastReviewAt)}`,
    "",
    `其他頻道加入：\`/project join id:${p.id}\``,
  ].join("\n");
}

async function cmdProject(i: ChatInputCommandInteraction) {
  const sub = i.options.getSubcommand();
  const quiet = { allowedMentions: { users: [] as string[] } };

  if (sub === "list") {
    const ps = store.projects();
    if (!ps.length) return i.reply({ content: "還沒有專案", flags: MessageFlags.Ephemeral });
    const lines = ps.map((p) => `${p.status === "active" ? "🟢" : "⚫"} \`${p.id}\` **${p.name}**　${p.channels.map((c) => `<#${c}>`).join(" ") || "（沒有頻道）"}`);
    return i.reply({ content: lines.join("\n"), flags: MessageFlags.Ephemeral });
  }
  if (sub === "info") {
    const id = i.options.getString("id");
    const p = id ? store.getProject(id) : needProject(i);
    if (!p) throw new Error(`找不到專案 \`${id}\``);
    return i.reply({ content: infoText(p), ...quiet });
  }
  if (sub === "state") {
    const p = needProject(i);
    const md = fs.readFileSync(path.join(store.projectDir(p.id), "STATE.md"), "utf8");
    return i.reply({ content: splitDiscord(md)[0], ...quiet });
  }

  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  const ch = hereId(i);

  if (sub === "new") {
    const cur = store.projectByChannel(ch);
    if (cur) throw new Error(`這個頻道已經在專案 **${cur.name}**（\`${cur.id}\`）裡，先 \`/project exit\``);
    const p = store.createProject(i.options.getString("name", true), i.user.id);
    store.joinChannel(p.id, ch, true);
    await commitKnowledge(`new project ${p.id} ${p.name}`);
    return i.reply({
      content: `🟢 開了專案 **${p.name}**，ID \`${p.id}\`。<#${ch}> 是主頻道。\n平常對話我不會聽。@我 並說「幫我記錄」「加入追蹤」才會記；直接 @我 問問題我只回答。reply 某句話再 @我，我會連前後文一起看。\n其他頻道加入：\`/project join id:${p.id}\``,
      ...quiet,
    });
  }
  if (sub === "join") {
    const p = store.joinChannel(i.options.getString("id", true), ch, i.options.getBoolean("primary") ?? false);
    return i.reply({ content: `🔗 <#${ch}> 加入 **${p.name}**（\`${p.id}\`）${p.primaryChannel === ch ? "，設為主頻道" : ""}`, ...quiet });
  }
  if (sub === "exit") {
    const p = store.exitChannel(ch);
    return i.reply(p ? `🔓 <#${ch}> 離開 **${p.name}**（\`${p.id}\`）。已記錄的資料保留。` : "這個頻道本來就不在專案裡");
  }
  if (sub === "close") {
    const p = store.closeProject(i.options.getString("id", true));
    await commitKnowledge(`close project ${p.id}`);
    return i.reply({ content: `⚫ **${p.name}**（\`${p.id}\`）已結束。不再回應、不再提醒，資料保留在 \`knowledge/${p.id}/\`。`, ...quiet });
  }
}

async function cmdAsk(i: ChatInputCommandInteraction) {
  if (!isAllowed(i.user.id)) return i.reply({ content: "這個 bot 目前只回 PM，請直接找 PM。", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  const q = i.options.getString("q", true);
  await i.deferReply();
  const r = await runAndCommit(p, "ask", askPrompt(p, i.user.id, q), "ask", { session: `ask:${hereId(i)}` });
  const chunks = splitDiscord(r.error ? `出錯：${r.error}` : r.text || "（沒有回覆）");
  await i.editReply({ content: `> ${q.slice(0, 200)}\n\n${chunks[0]}`.slice(0, 2000), allowedMentions: { users: [] } });
  for (const c of chunks.slice(1)) await i.followUp({ content: c, allowedMentions: { users: [] } });
}

async function cmdNote(i: ChatInputCommandInteraction) {
  if (!isAllowed(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  const text = i.options.getString("text", true);
  const file = i.options.getAttachment("file");
  await i.deferReply();
  const attachments = file ? await saveAttachments(p.id, [file]) : [];
  const { id: rawId, block } = store.appendRaw({
    project: p.id,
    channelName: i.channel ? channelName(i.channel) : "?",
    author: (i.member && "displayName" in i.member ? i.member.displayName : null) ?? i.user.username,
    authorId: i.user.id,
    text: `【記錄】${text}`,
    attachments,
    messageUrl: `https://discord.com/channels/${i.guildId}/${i.channelId}`,
  });
  store.touch(p, "lastRecordAt");
  const r = await runAndCommit(p, "digest", notePrompt(p, rawId, block), "note", { rawIds: [rawId] });
  await i.editReply({ content: `📝 raw ${rawId}　${r.error ? "整理出錯，巡檢時會再試：" + r.error : r.text}`.slice(0, 2000), allowedMentions: { users: [] } });
}

async function cmdReview(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply(`巡檢 **${p.name}**：${await reviewProject(p, "manual")}`.slice(0, 2000));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[discord] ${sig}`);
    store.save();
    client.destroy();
    process.exit(0);
  });
}

client.login(config.discordToken);
