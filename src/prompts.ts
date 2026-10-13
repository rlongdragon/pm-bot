import type { Project } from "./store.js";

export function digestPrompt(p: Project): string {
  return `專案「${p.name}」整理回合。

1. 讀 \`pending.md\`，這是上次整理之後頻道新進的訊息。
2. 讀 \`STATE.md\`、\`decisions.md\`、\`people.md\` 了解現況。
3. 依規則更新這三個檔案。只改真的有變的部分。
4. 有需要向人確認或提醒的事，寫進 \`outbox.md\`。沒有就不要寫。
5. 若 pending 裡沒有任何值得記錄的內容，什麼都不改，回「無更新」。

最後用三行以內回報你改了什麼。不要貼整個檔案。`;
}

export function askPrompt(p: Project, user: string, question: string): string {
  return `專案「${p.name}」。<@${user}> 問：

${question}

先看 \`STATE.md\`，不夠再 grep \`raw/\` 和 \`notes/\`。引用時附 raw id（例如 2026-10-13#4）。不知道就說不知道，不要猜。精簡、Discord 可讀的 markdown，不超過 1500 字。`;
}

export function noteAckPrompt(p: Project, rawId: string): string {
  return `專案「${p.name}」。raw ${rawId} 是一則被標記為「重要」的訊息（會議結論、文字稿、研究成果等），附件在 \`files/\`。立刻讀它並依規則更新筆記；研究成果、文字稿的重點整理寫進 \`notes/\`。需要確認的寫 outbox。三行內回報改了什麼。`;
}
