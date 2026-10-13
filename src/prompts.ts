import { today, type Project } from "./store.js";

const head = (p: Project) => `專案「${p.name}」（${p.id}）。今天是 ${today()}。`;

export function mentionPrompt(p: Project, rawId: string, block: string): string {
  return `${head(p)}有人在頻道 @ 了你。這則已經存成 raw ${rawId}：

${block}
**只有對方明確要你記錄時才改筆記**，例如「幫我記錄」「加入記憶」「加入追蹤」「記一下」「更正」這類說法：
- 要記錄：依規則更新筆記，回一兩句說你記了什麼。
- 要追蹤：在 STATE.md 進行中開一條任務。
- 要更正：改掉對應的那一條，並說改了什麼。

其他情況都當成問題：只回答，**不要改任何檔案**。先看 STATE.md，不夠再 grep raw/ 和 notes/，回答附 raw id。
如果看起來像是想讓你記、但沒有明說（例如只丟一句「Alice 做登入頁」），回答完問一句「要幫你記錄嗎？」，不要自己記。

附件在 files/。需要提醒別人或向人確認的寫 outbox.md。回覆用 Discord markdown，精簡，不超過 1500 字。`;
}

export function askPrompt(p: Project, user: string, question: string): string {
  return `${head(p)}<@${user}> 問：

${question}

先看 STATE.md，不夠再 grep raw/ 和 notes/。引用時附 raw id。不知道就說不知道，不要猜。精簡、Discord markdown，不超過 1500 字。`;
}

export function notePrompt(p: Project, rawId: string, block: string): string {
  return `${head(p)}這則被明確標為「要記錄」（會議結論、文字稿、研究成果等），已存成 raw ${rawId}：

${block}
依規則更新筆記；研究成果、文字稿的重點整理寫進 notes/<主題>.md。附件在 files/。需要確認的寫 outbox.md。三行內回報改了什麼。`;
}

export function reviewPrompt(p: Project, pending: string[]): string {
  return `${head(p)}每日巡檢。
${pending.length ? `\n1. pending.md 裡有 ${pending.length} 筆之前沒處理成功的記錄（${pending.join("、")}），依規則整理進筆記。` : ""}
${pending.length ? "2" : "1"}. 看 STATE.md 的進行中任務：期限在 2 天內的，以及超過 7 天沒更新的，寫進 outbox.md 提醒負責人。
沒有要做的就什麼都不改，回「無事」。三行內回報。`;
}
