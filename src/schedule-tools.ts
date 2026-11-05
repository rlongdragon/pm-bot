import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import * as schedule from "./schedule.js";
import * as store from "./store.js";

/** agent 用的排程工具。名稱要跟 sandbox 的 SCHEDULE_TOOLS 對上 */
export const SCHEDULE_SERVER = "pm";

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** 每次 agent 回合建一個，綁定專案、頻道、誰叫的 */
export function scheduleServer(projectId: string, ctx: { channelId: string; userId: string }) {
  const proj = () => {
    const p = store.getProject(projectId);
    if (!p) throw new Error(`找不到專案 ${projectId}`);
    return p;
  };
  const run = (fn: () => string) => {
    try {
      return Promise.resolve(ok(fn()));
    } catch (e) {
      return Promise.resolve(fail((e as Error).message));
    }
  };
  return createSdkMcpServer({
    name: SCHEDULE_SERVER,
    tools: [
      tool(
        "schedule_add",
        "排一個定時提醒或定時任務。到時間 bot 會貼在這個頻道。remind = 原文貼出（可以寫 <@id> 來 @ 人）；agent = 到時你會在唯讀模式下讀筆記做這件事，把結果貼出來（例如整理週報）。",
        {
          kind: z.enum(["remind", "agent"]).describe("remind：到時貼出 text；agent：到時讓你讀筆記完成 text 描述的工作"),
          when: z
            .string()
            .describe(
              "一次性：'YYYY-MM-DD HH:MM'（伺服器時區）、'明天 9:00'、'+30m'；週期性：'每天 9:00'、'平日 9:00'、'每週一 9:00'、'每週一三五 18:00'、'每月 1 號 9:00'，或 5 欄 cron '0 9 * * 1'",
            ),
          text: z.string().describe("remind 要貼的話，或 agent 要做的事（寫清楚，到時候沒有現在的對話可看）"),
        },
        (a) =>
          run(() => {
            const s = schedule.add(proj(), { kind: a.kind, when: a.when, text: a.text, channelId: ctx.channelId, createdBy: ctx.userId });
            return `已排程 ${s.id}：${s.cron ? `週期 ${s.cron}，` : ""}下次 ${schedule.fmtTime(s.nextAt)}`;
          }),
      ),
      tool("schedule_list", "列出這個專案的所有排程（id、下次時間、內容）", {}, () =>
        run(() => {
          const l = schedule.list(proj());
          return l.length ? l.map(schedule.describe).join("\n") : "沒有排程";
        }),
      ),
      tool("schedule_remove", "取消一個排程", { id: z.string().describe("schedule_list 看得到的 4 碼 id") }, (a) =>
        run(() => {
          const s = schedule.remove(proj(), a.id);
          return `已取消 ${s.id}：${s.text.slice(0, 80)}`;
        }),
      ),
    ],
  });
}
