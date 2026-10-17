/**
 * 一場會議一張卡：加入中 → 等放行 → 錄音中 → 錄完 → 轉逐字稿 → 會議紀錄，都編輯同一則 embed，不洗頻道。
 * 貼不進頻道（沒權限）就改私訊下指令的人，之後的更新也跟著改那一則。
 */
import { EmbedBuilder, type Client, type Message } from "discord.js";

export type Phase = "joining" | "waiting" | "recording" | "stopped" | "transcribing" | "done" | "failed" | "nosound";

const LOOK: Record<Phase, { color: number; title: string }> = {
  joining: { color: 0xf1c40f, title: "🟡 加入中" },
  waiting: { color: 0xe67e22, title: "🟠 等主持人放行" },
  recording: { color: 0xe74c3c, title: "🔴 錄音中" },
  stopped: { color: 0x95a5a6, title: "⏹ 錄完" },
  transcribing: { color: 0x9b59b6, title: "📝 轉逐字稿中" },
  done: { color: 0x2ecc71, title: "✅ 會議紀錄" },
  failed: { color: 0xc0392b, title: "⚠️ 沒有錄到" },
  nosound: { color: 0x95a5a6, title: "⏹ 停止了，沒錄到聲音" },
};

export interface CardState {
  phase: Phase;
  /** Google Meet xxx-yyyy-zzz / 🔊頻道名 */
  label: string;
  project: string;
  invokerId?: string;
  startedAt?: number;
  /** 一行說明，放 description */
  note?: string;
  durationSec?: number;
  participants?: string;
  /** 逐字稿句數、講者 */
  transcript?: string;
  /** agent 寫的摘要（done 時放 description） */
  summary?: string;
}

const ts = (ms: number, f: "t" | "R" | "f") => `<t:${Math.floor(ms / 1000)}:${f}>`;

export function fmtDur(sec: number) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} 小時 ${m} 分` : m ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

export function renderCard(s: CardState): EmbedBuilder {
  const look = LOOK[s.phase];
  const e = new EmbedBuilder().setColor(look.color).setTitle(`${look.title}　${s.label}`).setTimestamp(new Date());
  const desc = s.phase === "done" && s.summary ? s.summary : s.note;
  if (desc) e.setDescription(desc.slice(0, 4000));
  e.addFields({ name: "專案", value: s.project, inline: true });
  if (s.startedAt) e.addFields({ name: "開始", value: `${ts(s.startedAt, "t")}（${ts(s.startedAt, "R")}）`, inline: true });
  if (s.durationSec != null) e.addFields({ name: "長度", value: fmtDur(s.durationSec), inline: true });
  if (s.participants) e.addFields({ name: "與會者", value: s.participants.slice(0, 1000), inline: false });
  if (s.transcript) e.addFields({ name: "逐字稿", value: s.transcript.slice(0, 1000), inline: false });
  if (s.phase === "recording") e.setFooter({ text: "/meet stop 停止；所有人離開會自動停" });
  else if (s.phase === "waiting") e.setFooter({ text: "主持人按允許後開始錄；/meet stop 取消" });
  else if (s.phase === "failed" || s.phase === "nosound") e.setFooter({ text: "可以再 /meet 一次" });
  else if (s.invokerId) e.setFooter({ text: "由 /meet 啟動" });
  return e;
}

export class MeetingCard {
  private msg: Message | null = null;
  constructor(
    private client: Client,
    private channelId: string,
    public state: CardState,
  ) {}

  /** 第一次貼。貼不進頻道就私訊下指令的人 */
  async post(): Promise<Message | null> {
    const embeds = [renderCard(this.state)];
    const ch = await this.client.channels.fetch(this.channelId).catch(() => null);
    if (ch && ch.isTextBased() && "send" in ch) {
      this.msg = await ch.send({ embeds }).catch((e) => (console.warn(`[card] ${this.channelId}: ${e.message}`), null));
      if (this.msg) return this.msg;
    }
    if (this.state.invokerId) {
      const u = await this.client.users.fetch(this.state.invokerId).catch(() => null);
      this.msg = (await u?.send({ content: `（我在 <#${this.channelId}> 沒有發言權限，改私訊你）`, embeds }).catch(() => null)) ?? null;
    }
    return this.msg;
  }

  /** 改狀態並編輯同一則；那則不見了就重貼 */
  async update(patch: Partial<CardState>, extra: { files?: { attachment: string; name: string }[] } = {}): Promise<void> {
    Object.assign(this.state, patch);
    const payload = { embeds: [renderCard(this.state)], ...(extra.files ? { files: extra.files } : {}) };
    if (this.msg) {
      const ok = await this.msg.edit(payload).then(() => true, (e) => (console.warn(`[card] edit: ${e.message}`), false));
      if (ok) return;
      this.msg = null;
    }
    const posted = await this.post();
    if (extra.files && posted) await posted.edit(payload).catch(() => {});
  }

  get url(): string | undefined {
    return this.msg?.url;
  }
}
