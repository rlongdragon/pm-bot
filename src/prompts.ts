import type { Project } from "./store.js";

export function digestPrompt(p: Project): string {
  return `你是專案「${p.name}」的 PM 助理。現在是整理回合。

1. 讀 \`pending/${p.name}.md\`，這是上次整理之後頻道新進的訊息。
2. 讀 \`projects/${p.name}/STATE.md\`、\`decisions.md\`、\`people.md\` 了解現況。
3. 依 CLAUDE.md 的規則更新這三個檔案。只改真的有變的部分。
4. 有需要向人確認或提醒的事，寫進 \`outbox/${p.name}.md\`（格式見 CLAUDE.md）。沒有就不要寫。
5. 若 pending 裡沒有任何值得記錄的內容，什麼都不改，回「無更新」。

最後用三行以內回報你改了什麼。不要貼整個檔案。`;
}

export function askPrompt(p: Project, user: string, question: string): string {
  return `專案「${p.name}」。<@${user}> 問：

${question}

回答規則：先看 \`projects/${p.name}/STATE.md\`，不夠再 grep \`raw/${p.name}/\`。引用時附 raw id（例如 2026-10-13#4）。不知道就說不知道，不要猜。用繁體中文、精簡、Discord 可讀的 markdown，不要超過 1500 字。這是問答，不要改任何檔案。`;
}

export function noteAckPrompt(p: Project, rawId: string): string {
  return `專案「${p.name}」。raw ${rawId} 是一則被標記為「重要」的訊息（會議結論、文字稿、研究成果等）。立刻讀它並依 CLAUDE.md 更新 \`projects/${p.name}/\` 下的檔案，附件在 \`raw/${p.name}/files/\`。需要確認的寫 outbox。三行內回報改了什麼。`;
}
