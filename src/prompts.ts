import { today, type Project } from "./store.js";

const head = (p: Project) => `專案「${p.name}」（${p.id}）。今天是 ${today()}。`;

export function mentionPrompt(p: Project, rawId: string, block: string): string {
  return `${head(p)}有人在頻道 @ 了你。這則已經存成 raw ${rawId}：

${block}
先判斷對方的意圖是**要你記**還是**在問你**，看意思就好，不用等對方說出「記錄」兩個字：
- 丟給你的是事實、結論、分工、期限、決定（例如「Alice 做登入頁」「下週三 demo」「決定用 FastAPI」「這個做完了」），就是要你記：依規則更新筆記，回一句說你記了什麼。
- 「幫我記錄」「加入追蹤」「記一下」「更正」這類當然也是要記。要追蹤的在 STATE.md 進行中開一條任務；更正就改掉對應那一條，並說改了什麼。
- 在問東西（有問號、問進度、問誰負責、問之前講過什麼）就只回答，**不要改任何檔案**。先看 STATE.md，不夠再 grep raw/、notes/、sources/，回答附 raw id。
- 真的看不出來是哪一種才問「要幫你記錄嗎？」，不要常問。

附件在 files/；Office 檔（pptx、docx、xlsx）旁邊有抽好的文字版 files/<檔名>.md，直接讀那份。專案連結的 GitHub（PR、issue、commit）和 Notion 內容在 sources/，問到這些先看 sources/。需要提醒別人或向人確認的寫 outbox.md。

回覆規則：
- 只處理這一則。不要提起其他舊訊息、之前的問題或別的頻道。
- 要短。記錄就一句說記了什麼；回答就直接講答案。不要列「原因」「建議」「另外」這類額外段落。
- 被回覆的訊息讀不到時（上面括號會寫），**什麼都不要記**，一句話說讀不到、請對方把內容直接貼出來。
- 「訊息連結」是這則 Discord 訊息本身的位置，不是對方要你記的內容。
- Discord markdown，最多 800 字。`;
}

export function askPrompt(p: Project, user: string, question: string): string {
  return `${head(p)}<@${user}> 問：

${question}

先看 STATE.md，不夠再 grep raw/、notes/、sources/（GitHub、Notion 的副本）。引用時附 raw id。不知道就說不知道，不要猜。直接講答案，不要額外段落，Discord markdown，最多 800 字。`;
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

export function meetingPrompt(p: Project, rawId: string, block: string, transcriptRel: string, notesRel: string, idMap: string): string {
  return `${head(p)}剛開完一場會，逐字稿已存成 raw ${rawId}：

${block}
逐字稿全文在 \`${transcriptRel}\`。與會者的 Discord id：${idMap || "（沒有）"}。
會議錄音本身就是記錄要求，請：
1. 讀完逐字稿，寫會議紀錄到 \`${notesRel}\`：與會者、摘要（5 行內）、決定、待辦（誰、做什麼、期限）、未決問題。每條附逐字稿時間戳，例如 [00:12:34]。
2. 依規則更新 STATE.md、decisions.md、people.md。有明確負責人的待辦開成進行中任務，來源寫 raw ${rawId}；負責人或期限不明確的標「未定」，並在 outbox.md 問。
3. 閒聊和玩笑不要記。逐字稿是自動轉的，可能有錯字，人名或專有名詞看起來怪的照原樣留，不要自己改。
4. 回覆三到五行：這場會的重點，以及你開了哪些任務。`;
}
