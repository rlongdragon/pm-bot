import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  PermissionFlagsBits,
  type Attachment,
  type ChatInputCommandInteraction,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { config, isAdmin, isAllowed } from "../config.js";
import * as store from "../store.js";
import { commitKnowledge, enqueue, ensureKnowledgeRepo, runAgent, type AgentResult } from "../agent.js";
import { askPrompt, meetingPrompt, mentionPrompt, notePrompt, reviewPrompt } from "../prompts.js";
import { addLink, removeLink, syncLinks } from "../sources/index.js";
import { createBoard, pushBoard } from "../board.js";
import * as meeting from "../meeting/index.js";
import { fmtDuration, sanitize, type Manifest } from "../meeting/session.js";
import { transcribe, transcribeEnabled } from "../meeting/transcribe.js";
import type { Mode } from "../sandbox.js";

if (!config.discordToken) {
  console.error("缺 DISCORD_TOKEN，先填 .env");
  process.exit(1);
}

if (!process.env.PM_USE_API_KEY && config.allowedUserIds.length === 0) {
  console.warn(
    "[warn] 正在用 Claude 訂閱登入，但 ALLOWED_USER_IDS 是空的：任何人都能觸發 agent。\n" +
      "       官方政策不允許替其他人透過 Free/Pro/Max 訂閱發送請求。請把 ALLOWED_USER_IDS 設成你自己的 Discord user id。",
  );
}

const here = path.dirname(fileURLToPath(import.meta.url));
store.load();
await ensureKnowledgeRepo(path.resolve(here, "../../knowledge-template"));

/**
 * Message Content Intent 要在 Developer Portal 手動打開。沒開時 Discord 仍會給「有 @bot 的訊息」內容，
 * 所以先試完整權限，被拒（4014 Used disallowed intents）就降級啟動，只是 reply 時讀不到被回覆的那句和前後文。
 */
async function probeContentIntent(): Promise<boolean> {
  const probe = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("clientReady", () => resolve());
      probe.login(config.discordToken).catch(reject);
    });
    return true;
  } catch (e) {
    if (/disallowed intents/i.test((e as Error).message)) return false;
    throw e;
  } finally {
    await probe.destroy();
  }
}

const hasContentIntent = await probeContentIntent();
if (!hasContentIntent) {
  console.warn(
    "[warn] Message Content Intent 沒開，降級啟動：@bot 記錄、問問題、slash 指令都能用，但 reply 時讀不到被回覆的訊息和前後文。\n" +
      "       到 Developer Portal → Bot → Privileged Gateway Intents 打開後重啟。",
  );
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates, // /meet voice：知道誰在語音頻道、沒人時自動停
    ...(hasContentIntent ? [GatewayIntentBits.MessageContent] : []),
  ],
  partials: [Partials.Channel],
});

client.once("clientReady", () => {
  console.log(
    `[discord] logged in as ${client.user?.tag}, content-intent=${hasContentIntent ? "on" : "OFF"}, allowed=${config.allowedUserIds.join(",") || "ALL"}, knowledge=${config.knowledgeDir}, claude=${config.claudeConfigDir}`,
  );
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

/** 把 outbox 貼到主頻道（可以 @ 人）；主頻道發不出去就私訊管理員。都失敗就留著，下次再送 */
async function flushOutbox(p: store.Project) {
  const text = store.peekOutbox(p.id);
  if (!text) return;
  const chunks = splitDiscord(text);
  let sent = 0;
  for (const c of chunks) {
    if (!(await say(p.primaryChannel, c, config.adminUserIds[0], undefined, { ping: true }))) break;
    sent++;
  }
  if (sent === chunks.length) store.clearOutbox(p.id);
  else console.warn(`[outbox] ${p.id} 只送出 ${sent}/${chunks.length} 則，留到下次`);
}

/** 跑 agent；成功就把這幾筆移出 pending 並 commit */
async function runAndCommit(p: store.Project, mode: Mode, prompt: string, label: string, opts: { session?: string; rawIds?: string[] } = {}) {
  const r: AgentResult = await enqueue(async () => {
    // 先同步外部來源（有變才抓），讓 agent 看到最新的 sources/
    const synced = await syncLinks(p);
    if (synced.changed) await commitKnowledge(`sync sources ${p.id}`);
    const res = await runAgent(prompt, { project: p.id, mode, label: `${label}:${p.id}`, resume: opts.session ? store.getSession(p, opts.session) : undefined });
    if (!res.error && mode === "digest") {
      if (opts.rawIds?.length) store.removePending(p.id, opts.rawIds);
      const changed = await commitKnowledge(`${label} ${p.id}${opts.rawIds?.length ? " " + opts.rawIds.join(",") : ""}`);
      if (changed && p.board) {
        try {
          const b = await pushBoard(p);
          if (b.created + b.updated + b.archived) console.log(`[board] ${p.id} +${b.created} ~${b.updated} -${b.archived}`);
        } catch (e) {
          p.board.error = (e as Error).message;
          store.save();
          console.warn(`[board] ${p.id} ${p.board.error}`);
        }
      }
    }
    return res;
  });
  if (opts.session && r.sessionId) store.setSession(p, opts.session, r.sessionId);
  await flushOutbox(p);
  return r;
}

/* ---------- 會議錄音 ---------- */

/** 貼到頻道；bot 在那個頻道沒權限時改私訊 fallbackUserId。回傳有沒有送到 */
async function say(
  channelId: string | undefined,
  content: string,
  fallbackUserId?: string,
  files?: { attachment: string; name: string }[],
  opts: { ping?: boolean } = {},
): Promise<boolean> {
  const allowedMentions = opts.ping ? undefined : { users: [] as string[] };
  const ch = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (ch && ch.isTextBased() && "send" in ch) {
    const ok = await ch.send({ content, files, allowedMentions }).then(() => true, (e) => (console.warn(`[say] ${channelId}: ${e.message}`), false));
    if (ok) return true;
  }
  if (fallbackUserId) {
    const u = await client.users.fetch(fallbackUserId).catch(() => null);
    const prefix = channelId ? `（我在 <#${channelId}> 沒有發言權限，改私訊你）\n` : "";
    const ok = await u
      ?.send({ content: (prefix + content).slice(0, 2000), files })
      .then(() => true, (e) => (console.warn(`[say] DM ${fallbackUserId}: ${e.message}`), false));
    if (ok) return true;
  }
  console.warn(`[say] 發不出去：${content.slice(0, 80)}`);
  return false;
}

meeting.setHandlers({
  status: (a, msg) => {
    if (/已要求加入|開始錄音/.test(msg)) void say(a.reportChannelId, `🎙 ${a.label}：${msg}`, a.invokerId);
  },
  finished: (f) => void onMeetingFinished(f),
});

async function onMeetingFinished(f: meeting.Finished) {
  const m = f.manifest;
  const rel = f.dir ? path.relative(process.cwd(), f.dir) : "";
  if (!m?.files.mixed) {
    if (f.dir) fs.rmSync(f.dir, { recursive: true, force: true }); // 沒有聲音就不留空資料夾
    await say(
      f.reportChannelId,
      f.error ? `⚠️ ${f.label} 沒有錄到：${f.error}` : `⏹ ${f.label} 停止了，還沒錄到聲音（可能還在等主持人放行，或沒有人講話）。`,
      f.invokerId,
    );
    return;
  }
  const dur = fmtDuration(m.durationSec ?? 0);
  const names = m.participants.map((x) => x.name).join("、") || "（沒有人講話）";
  const p = store.getProject(f.projectId);
  let rawNote = "";
  if (p) {
    const started = new Date(m.startedAt).toLocaleString("zh-TW", { hour12: false });
    const { id } = store.appendRaw({
      project: p.id,
      channelName: "會議",
      author: client.user?.username ?? "bot",
      authorId: client.user?.id ?? "0",
      text: `【會議錄音】${f.label}，${started} 開始，長度 ${dur}，參與者：${names}。音檔在伺服器 ${rel}/mixed.ogg（不在筆記資料夾裡），還沒有文字稿。`,
      attachments: [],
      messageUrl: `https://discord.com/channels/@me`,
    });
    store.removePending(p.id, [id]);
    await enqueue(() => commitKnowledge(`meeting ${p.id} ${id}`));
    rawNote = `已記在專案（raw ${id}）。`;
  }
  const auto = !!p && transcribeEnabled() && config.transcribeAuto;
  await say(
    f.reportChannelId,
    `⏹ ${f.label} 錄完：長度 ${dur}，參與者 ${names}。${rawNote}\n` +
      `音檔在伺服器 \`${rel}/mixed.ogg\`${m.platform === "discord" ? "，另有每人一軌" : ""}。` +
      (auto ? "📝 開始轉逐字稿，好了會貼在這裡。" : "沒有設定自動轉錄，可以用 `/meet transcribe`。"),
    f.invokerId,
  );
  if (auto) void transcribeAndRecord(p!, f.dir, m, f.label, f.reportChannelId, f.invokerId);
}

/** agent 寫的會議紀錄：先找指定路徑，找不到就找這次 agent 跑之後 notes/ 底下最新改過的 .md */
function findMeetingNotes(projectId: string, notesRel: string, since: number): string | null {
  const dir = store.projectDir(projectId);
  const exact = path.join(dir, notesRel);
  if (fs.existsSync(exact)) return exact;
  try {
    const cands = fs
      .readdirSync(path.join(dir, "notes"), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => path.join(d.parentPath, d.name))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .filter((x) => x.t >= since)
      .sort((a, b) => b.t - a.t);
    return cands[0]?.f ?? null;
  } catch {
    return null;
  }
}

/** 轉逐字稿 → 存成專案附件 → raw 一筆 → Claude 寫會議紀錄、更新 STATE → 貼回 Discord（附逐字稿檔） */
async function transcribeAndRecord(p: store.Project, dir: string, m: Manifest, label: string, reportChannelId: string, invokerId?: string): Promise<void> {
  try {
    const t0 = Date.now();
    const r = await transcribe(dir, m, label, (msg) => console.log(`[transcribe] ${p.id} ${msg}`));
    console.log(`[transcribe] ${p.id} ${label} ${r.lines} 句 ${((Date.now() - t0) / 1000).toFixed(0)}s ${r.models.join(",")}`);
    const date = new Date(m.startedAt);
    const day = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const hhmm = store.hhmm(date).replace(":", "");
    const fname = `${day}_${hhmm}_會議逐字稿_${sanitize(label.replace(/^🔊/, ""))}.md`;
    fs.copyFileSync(r.file, path.join(store.filesDir(p.id), fname));
    const notesRel = `notes/meetings/${day}_${hhmm}_${sanitize(label.replace(/^🔊/, ""))}.md`;
    const idMap = m.platform === "discord" ? m.participants.map((x) => `${x.name}=<@${x.id}>`).join("、") : "";
    const { id: rawId, block } = store.appendRaw({
      project: p.id,
      channelName: "會議",
      author: client.user?.username ?? "bot",
      authorId: client.user?.id ?? "0",
      text: `【會議逐字稿】${label}，${r.lines} 句，講者：${r.speakers.join("、")}。`,
      attachments: [`files/${fname}`],
      messageUrl: "https://discord.com/channels/@me",
    });
    const agentStart = Date.now();
    const res = await runAndCommit(p, "digest", meetingPrompt(p, rawId, block, `files/${fname}`, notesRel, idMap), "meeting", { rawIds: [rawId] });
    const notesFile = findMeetingNotes(p.id, notesRel, agentStart);
    const files = [{ attachment: r.file, name: fname }];
    if (notesFile) files.unshift({ attachment: notesFile, name: `${day}_${hhmm}_會議紀錄_${sanitize(label.replace(/^🔊/, ""))}.md` });
    await say(
      reportChannelId,
      `📝 ${label} 會議紀錄${notesFile ? "和逐字稿" : "（逐字稿）"}好了。逐字稿 ${r.lines} 句，講者 ${r.speakers.join("、")}。\n` +
        (res.error ? `整理時出錯，巡檢會再試：${res.error}` : res.text).slice(0, 1500) +
        (notesFile ? "" : "\n⚠️ 沒找到會議紀錄檔，只附逐字稿。"),
      invokerId,
      files,
    );
  } catch (e) {
    console.error(`[transcribe] ${p.id} failed:`, e);
    await say(reportChannelId, `⚠️ ${label} 轉逐字稿失敗：${(e as Error).message.slice(0, 500)}\n之後可以用 \`/meet transcribe\` 再試一次。`, invokerId);
  }
}

client.on("voiceStateUpdate", (oldState) => meeting.onVoiceStateUpdate(oldState));

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
  if (!hasContentIntent) {
    return { lines: [`（bot 沒有 Message Content 權限，讀不到被回覆的訊息內容和前後文。被回覆的是 ${displayName(ref)} 的訊息：${ref.url}）`], atts };
  }

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
      case "link":
        return await cmdLink(i);
      case "board":
        return await cmdBoard(i);
      case "meet":
        return await cmdMeet(i);
    }
  } catch (e) {
    console.error("[discord] command error:", e);
    const msg = `錯誤：${(e as Error).message}`;
    if (i.deferred || i.replied) await i.editReply(msg).catch(() => {});
    else await i.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

/** bot 在這個頻道缺哪些權限。slash 指令不需要檢視權限，所以指令能用不代表 bot 收得到訊息 */
function missingPerms(i: ChatInputCommandInteraction): string[] {
  const need: [bigint, string][] = [
    [PermissionFlagsBits.ViewChannel, "檢視頻道"],
    [PermissionFlagsBits.SendMessages, "發送訊息"],
    [PermissionFlagsBits.ReadMessageHistory, "讀取訊息紀錄"],
  ];
  if (i.channel && "isThread" in i.channel && i.channel.isThread()) need.push([PermissionFlagsBits.SendMessagesInThreads, "在討論串中傳送訊息"]);
  return need.filter(([f]) => !i.appPermissions.has(f)).map(([, n]) => n);
}
function permWarning(i: ChatInputCommandInteraction): string {
  const miss = missingPerms(i);
  if (!miss.length) return "";
  return `\n\n⚠️ **我在這個頻道缺權限，收不到你的訊息**：${miss.join("、")}。\n頻道設定 > 權限 > 新增「${i.client.user.username}」，把上面這幾項打開。`;
}

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
    `外部來源 ${p.links?.length ?? 0} 個${p.links?.some((l) => l.error) ? "（⚠️ 有錯誤，看 \`/link list\`）" : ""}　看板 ${p.board ? `[Notion](<${p.board.url}>)　更新 ${fmtDate(p.board.lastPushAt)}${p.board.error ? `　⚠️ ${p.board.error}` : ""}` : "未設定"}`,
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
    return i.reply({ content: infoText(p) + (id ? "" : permWarning(i)), ...quiet });
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
      content: `🟢 開了專案 **${p.name}**，ID \`${p.id}\`。<#${ch}> 是主頻道。\n平常對話我不會聽。@我 並說「幫我記錄」「加入追蹤」才會記；直接 @我 問問題我只回答。reply 某句話再 @我，我會連前後文一起看。\n其他頻道加入：\`/project join id:${p.id}\`` + permWarning(i),
      ...quiet,
    });
  }
  if (sub === "join") {
    const p = store.joinChannel(i.options.getString("id", true), ch, i.options.getBoolean("primary") ?? false);
    return i.reply({ content: `🔗 <#${ch}> 加入 **${p.name}**（\`${p.id}\`）${p.primaryChannel === ch ? "，設為主頻道" : ""}` + permWarning(i), ...quiet });
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

async function cmdLink(i: ChatInputCommandInteraction) {
  const p = needProject(i);
  const sub = i.options.getSubcommand();
  const quiet = { allowedMentions: { users: [] as string[] } };
  if (sub === "list") {
    const ls = p.links ?? [];
    if (!ls.length) return i.reply({ content: "還沒有外部來源。`/link add url:<GitHub repo 或 Notion 網址>`", flags: MessageFlags.Ephemeral });
    const lines = ls.map(
      (l) =>
        `\`${l.id}\` ${l.type === "github" ? "🐙" : "📝"} [${l.title}](<${l.url}>)　同步 ${fmtDate(l.lastSyncAt)}　更新 ${fmtDate(l.lastChangeAt)}${l.error ? `\n　⚠️ ${l.error}` : ""}`,
    );
    return i.reply({ content: lines.join("\n"), ...quiet });
  }
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  if (sub === "add") {
    await i.deferReply();
    const l = await enqueue(async () => {
      const added = await addLink(p, i.options.getString("url", true), i.user.id);
      await commitKnowledge(`link ${p.id} ${added.type} ${added.target}`);
      return added;
    });
    return i.editReply({
      content: `🔗 連上 ${l.type === "github" ? "GitHub" : "Notion"}：[${l.title}](<${l.url}>)（\`${l.id}\`）。之後有人 @我 時會先檢查有沒有更新。`,
      ...quiet,
    });
  }
  if (sub === "remove") {
    const l = removeLink(p, i.options.getString("id", true));
    await commitKnowledge(`unlink ${p.id} ${l.type} ${l.target}`);
    return i.reply({ content: `移除 ${l.title}（\`${l.id}\`），抓下來的副本也刪了。`, ...quiet });
  }
  if (sub === "sync") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await enqueue(async () => {
      const res = await syncLinks(p, true);
      if (res.changed) await commitKnowledge(`sync sources ${p.id}`);
      return res;
    });
    return i.editReply(`同步完成，${r.changed ? "有更新" : "沒有變動"}。${r.errors.length ? "\n⚠️ " + r.errors.join("\n⚠️ ") : ""}`.slice(0, 2000));
  }
}

async function cmdBoard(i: ChatInputCommandInteraction) {
  const p = needProject(i);
  const sub = i.options.getSubcommand();
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  if (sub === "set") {
    await i.deferReply();
    const r = await enqueue(async () => {
      p.board = await createBoard(p, i.options.getString("url", true));
      store.save();
      return pushBoard(p);
    });
    return i.editReply(
      `📋 在 Notion 建好看板：<${p.board!.url}>，放了 ${r.created} 張卡。\n` +
        "之後每次筆記有變就自動更新。想看成看板，在 Notion 那個資料庫新增 Board 檢視，依「狀態」分組。\n" +
        "看板只是 STATE.md 的顯示：在 Notion 上手動改會被下次同步蓋掉，要改請 @我 說「更正」。",
    );
  }
  if (sub === "sync") {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await enqueue(() => pushBoard(p));
    return i.editReply(`看板更新：新增 ${r.created}、更新 ${r.updated}、封存 ${r.archived}`);
  }
  if (sub === "off") {
    const had = p.board;
    p.board = undefined;
    store.save();
    return i.reply(had ? `停止更新看板。Notion 上的資料庫還在：<${had.url}>` : "這個專案本來就沒設看板");
  }
}

async function cmdMeet(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  if (!i.inCachedGuild()) return i.reply({ content: "只能在伺服器內用", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  const sub = i.options.getSubcommand();
  if (sub === "transcribe") {
    if (!transcribeEnabled()) return i.reply({ content: "沒有設定轉錄：要 TRANSCRIBE_MODEL 和 TRANSCRIBE_API_KEY（或 _FILE）", flags: MessageFlags.Ephemeral });
    const base = path.join(config.recordingsDir, p.id);
    const dirs = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, "mixed.ogg"))).sort() : [];
    const nth = i.options.getInteger("nth") ?? 1;
    const pick = dirs[dirs.length - nth];
    if (!pick) return i.reply({ content: dirs.length ? `只有 ${dirs.length} 場錄音` : "這個專案還沒有錄音", flags: MessageFlags.Ephemeral });
    const dir = path.join(base, pick);
    const m: Manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    const label = m.platform === "discord" ? `🔊${m.source.match(/#(.+?) \(/)?.[1] ?? "語音"}` : `Google Meet ${m.source.replace(/^https:\/\/meet\.google\.com\//, "")}`;
    await i.reply(`📝 開始轉 ${label}（${new Date(m.startedAt).toLocaleString("zh-TW", { hour12: false })}，${fmtDuration(m.durationSec ?? 0)}），好了會貼在這裡。` + permWarning(i));
    void transcribeAndRecord(p, dir, m, label, i.channelId, i.user.id);
    return;
  }
  if (sub === "status") {
    const a = meeting.getActive(p.id);
    return i.reply({ content: a ? `🔴 ${meeting.describe(a)}` : "沒有在錄", flags: MessageFlags.Ephemeral });
  }
  if (sub === "stop") {
    const a = meeting.getActive(p.id);
    if (!a) return i.reply({ content: "沒有在錄", flags: MessageFlags.Ephemeral });
    await i.deferReply();
    await a.stop();
    return i.editReply(`⏹ 停止 ${a.label}。存檔結果會貼在 <#${a.reportChannelId}>。`);
  }
  if (sub === "voice") {
    const opt = i.options.getChannel("channel");
    const ch = opt ? i.guild.channels.cache.get(opt.id) : i.member.voice.channel;
    if (!ch || !ch.isVoiceBased()) return i.reply({ content: "你要先進語音頻道，或在指令裡指定一個語音頻道", flags: MessageFlags.Ephemeral });
    await i.deferReply();
    const a = await meeting.startVoice(p.id, ch, i.channelId, i.user.id);
    return i.editReply(`🔴 開始錄 ${a.label}，每人一軌。\`/meet stop\` 或所有人離開後自動停止，錄完會貼在這裡。` + permWarning(i));
  }
  if (sub === "google") {
    const a = meeting.startMeet(p.id, i.options.getString("url", true).trim(), i.channelId, i.user.id);
    return i.reply(
      `🟡 正在加入 ${a.label}，名字是「${config.meetBotName}」。主持人放行後開始錄，\`/meet stop\` 停止。\n` +
        `會議要求 Google 帳號登入的話訪客進不去，我會在這裡回報。` +
        permWarning(i),
    );
  }
}

async function cmdReview(i: ChatInputCommandInteraction) {
  if (!isAdmin(i.user.id)) return i.reply({ content: "沒權限", flags: MessageFlags.Ephemeral });
  const p = needProject(i);
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await i.editReply(`巡檢 **${p.name}**：${await reviewProject(p, "manual")}`.slice(0, 2000));
}

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const n = meeting.allActive().length;
    console.log(`[discord] ${sig}${n ? `，先把 ${n} 場錄音存好` : ""}`);
    await meeting.stopAll();
    store.save();
    await client.destroy();
    process.exit(0);
  });
}

client.login(config.discordToken);
