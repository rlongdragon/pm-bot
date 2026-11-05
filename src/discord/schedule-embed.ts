import { EmbedBuilder } from "discord.js";
import type { Schedule } from "../schedule.js";

const COLOR = { remind: 0x5865f2, agent: 0x9b59b6, paused: 0x95a5a6, removed: 0x4f545c, error: 0xed4245 };
const KIND = { remind: "⏰ 提醒", agent: "🤖 任務" };

/** Discord 時間戳：依看的人的時區顯示 */
export const ts = (iso: string, f: "F" | "R" | "f" | "t" = "F") => `<t:${Math.floor(Date.parse(iso) / 1000)}:${f}>`;
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** 文字裡的 @人、@身分組（放 content 才會通知） */
export function mentionsIn(text: string): string {
  return [...new Set(text.match(/<@[!&]?\d+>/g) ?? [])].join(" ");
}

/** 單一排程的卡片。action 例如「已排程」「已修改」 */
export function scheduleEmbed(s: Schedule, action?: string): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(s.paused ? COLOR.paused : s.lastError ? COLOR.error : COLOR[s.kind])
    .setTitle(`${action ? action + "　" : ""}${KIND[s.kind]} · ${s.id}`)
    .setDescription(clip(s.text, 4000))
    .addFields(
      { name: "下次", value: s.paused ? "⏸️ 暫停中" : `${ts(s.nextAt)}\n${ts(s.nextAt, "R")}`, inline: true },
      { name: "重複", value: s.cron ? `🔁 ${s.when}\n\`${s.cron}\`` : "一次", inline: true },
      { name: "貼到", value: `<#${s.channelId}>`, inline: true },
    );
  if (s.lastError) e.addFields({ name: "⚠️ 上次失敗", value: clip(s.lastError, 1000) });
  e.addFields({ name: "建立", value: `<@${s.createdBy}>　${ts(s.createdAt, "f")}${s.lastRunAt ? `　上次觸發 ${ts(s.lastRunAt, "R")}` : ""}` });
  return e.setFooter({ text: `/schedule edit · pause · remove · run ${s.id}` });
}

export function removedEmbed(s: Schedule): EmbedBuilder {
  return new EmbedBuilder().setColor(COLOR.removed).setTitle(`🗑️ 已取消　${KIND[s.kind]} · ${s.id}`).setDescription(clip(s.text, 4000));
}

/** /schedule list：每個排程一欄，每 10 個一個 embed（單則訊息 embed 總長上限 6000） */
export function listEmbeds(projectName: string, list: Schedule[]): EmbedBuilder[] {
  const out: EmbedBuilder[] = [];
  for (let i = 0; i < list.length; i += 10) {
    const e = new EmbedBuilder().setColor(COLOR.remind);
    if (i === 0) e.setTitle(`🗓️ ${projectName} 的排程（${list.length}）`);
    for (const s of list.slice(i, i + 10)) {
      const when = s.paused ? "⏸️ 暫停中" : `${ts(s.nextAt, "f")}（${ts(s.nextAt, "R")}）`;
      const rep = s.cron ? `🔁 ${s.when}` : "一次";
      e.addFields({
        name: clip(`${KIND[s.kind]} · ${s.id}${s.lastError ? " ⚠️" : ""}`, 256),
        value: clip(`${when}　${rep}　→ <#${s.channelId}>　by <@${s.createdBy}>\n${s.text.replace(/\n+/g, " ")}`, 400),
      });
    }
    out.push(e);
  }
  out.at(-1)?.setFooter({ text: "/schedule add 新增 · edit / pause / resume / remove / run <id> 管理" });
  return out;
}

/** 時間到時貼出的卡 */
export function firedEmbed(s: Schedule, body: string, o: { manual?: boolean; lateMin?: number; error?: boolean } = {}): EmbedBuilder {
  const e = new EmbedBuilder()
    .setColor(o.error ? COLOR.error : COLOR[s.kind])
    .setDescription(clip(body || "（沒有結果）", 4000))
    .setTimestamp(new Date());
  if (s.kind === "agent") e.setTitle(clip(`🤖 定時任務：${s.text.replace(/\s+/g, " ")}`, 256));
  else e.setTitle("⏰ 提醒");
  const foot = [`排程 ${s.id}`, s.cron ? `🔁 ${s.when}` : "一次"];
  if (o.manual) foot.push("手動觸發");
  if (o.lateMin && o.lateMin > 5) foot.push(`bot 當時沒在跑，晚了 ${o.lateMin} 分鐘`);
  return e.setFooter({ text: foot.join(" · ") });
}
