# User Stories

2026-10-13 PM 口述整理。狀態：✅ 已有、🟡 部分、⬜ 未做。

## 定位

- PM 用的專案記憶。**不對專案做任何操作**（不改程式、不開 issue、不動 repo），只記錄、整理、回答、提醒。
- 團隊記憶可以給其他 code agent 讀，由它們去做事。

## 1. 專案與頻道

| # | Story | 狀態 | 現在的樣子 / 差距 |
|---|---|---|---|
| 1.1 | 我可以開新專案 | ✅ | `/project new <name>`，目前頻道設主頻道 |
| 1.2 | 我可以看專案資訊：ID、統計 | ✅ | `/project info [id]` |
| 1.3 | 我可以用 ID 把頻道加入既有專案 | ✅ | `/project join <id>`，ID 是 6 碼短亂碼 |
| 1.4 | 我可以讓頻道離開專案 | ✅ | `/project exit` |
| 1.5 | 一個專案多個頻道 | ✅ | thread 自動跟父頻道 |

指令：`/project new`、`/project info`、`/project join <id>`、`/project exit`、`/project close <id>`、`/project list`、`/project state`。

## 2. 觸發方式：平常對話不聽

| # | Story | 狀態 | 差距 |
|---|---|---|---|
| 2.1 | 一般對話 bot 不需要知道 | ✅ | 只處理 @bot 或 reply bot 的訊息 |
| 2.2 | 我 reply 某句話並 @bot，bot 把那句和上下文抓進來 | ✅ | 被回覆的訊息＋前 10、後 5 則 |
| 2.3 | 我 @bot 叫它記錄 | ✅ | agent 看意圖判斷：丟事實、結論、分工就記，問問題就只答 |
| 2.4 | 我 @bot 問問題 | ✅ | |

改成被叫才記以後：

- raw 只有你明確餵的東西，量小、雜訊少、隱私問題小很多、也省額度。
- 記錄當下就整理，不再定時整理。
- 每日巡檢掃 STATE.md 提醒快到期、久未更新的任務。

## 3. 會議

| # | Story | 狀態 | 差距 |
|---|---|---|---|
| 3.1 | `/meet` 指定語音頻道，bot 進來錄 | ✅ | `/meet voice`，從 meeting-recorder 併入。還沒在真的語音頻道實測 |
| 3.2 | `/meet <Google Meet 連結>`，bot 進會議錄 | ✅ | `/meet google`，子程序跑 Chromium。還沒在真的會議實測 |
| 3.3 | 錄完的文字稿進專案 | ⬜ | 錄完會記一筆 raw，但還不會轉文字稿（計畫走 ai.rlong.me Gemini） |

## 4. 外部來源連結

| # | Story | 狀態 |
|---|---|---|
| 4.1 | `/link` 連 GitHub repo | ✅ |
| 4.2 | `/link` 連 Notion 頁面 / database | ✅ |
| 4.3 | `/link` 連 HackMD | ⬜ |

權限做法：你說的「虛擬帳號」就是業界標準做法，每個平台都有對應的 bot 身分：

| 平台 | bot 身分 | 怎麼給權限 |
|---|---|---|
| GitHub | GitHub App（唯讀：contents、issues、PRs） | 裝到要看的 repo |
| Notion | Internal integration | 在頁面上「Add connection」 |
| HackMD | bot 帳號 + API token | 加進團隊 workspace |
| Google Drive | Service account | 把資料夾分享給它的 email |

架構：**bot 抓，agent 讀**。bot 拿 token 去抓（先比對更新時間，有變才拉），存成快照放進專案資料夾 `sources/`。agent 只讀本地快照，永遠拿不到 token，沙箱不用動。

## 5. Dashboard

| # | Story | 狀態 |
|---|---|---|
| 5.1 | 有個地方看得到專案現況 | ✅ | `/board set` 推到 Notion 看板 |

做法選項：

1. **bot 用固定模板把 STATE.md 渲染成網頁**，放 w.rlong.me。agent 不碰 HTML，格式穩定。建議這個。
2. agent 自己寫網頁：彈性大但每次長得不一樣，也要開放寫 HTML 的權限。
3. 推到 Notion：要先做 4.2。

要決定：頁面公開還是要登入。w.rlong.me 目前是公開的，團隊資訊放上去要加密碼或用猜不到的網址。

## 6. 團隊記憶給其他 agent

| # | Story | 狀態 |
|---|---|---|
| 6.1 | 其他 code agent（Claude Code、Codex）可以讀團隊記憶 | ⬜ |
| 6.2 | 其他 agent 做完事可以回報進記憶 | ⬜ |

LiteLLM 查不到有團隊記憶功能，可能是記成別的產品（Letta、mem0 之類）。

做法：pm-bot 開一個 **MCP server**，每個專案一把 token，唯讀工具：

- `list_projects`
- `get_state(project)`：STATE.md
- `get_decisions(project)`
- `search(project, query)`：grep raw/notes
- （選用）`report(project, text)`：寫進 raw，標來源是哪個 agent，走正常整理流程

其他 agent 在自己的 MCP 設定加這個 server 就能查「這專案現在誰在做什麼、決定過什麼」。符合「PM 不做事」：記憶往外流，做事的是別的 agent。

## 建議順序

1. ~~**P0**：1.2–1.4 指令改名＋ID＋統計；2.1–2.3 改成被叫才記。~~ 2026-10-13 完成。
2. **P1**：5.1 Dashboard（模板渲染）；6.1 唯讀 MCP。
3. **P2**：3.x 併入 meeting-recorder；4.x 先 GitHub App，再 Notion，再 HackMD。

## 已決定

- 2026-10-13：專案 ID 用 6 碼短亂碼。
- 2026-10-13：@bot 時由 agent 判斷要記錄還是回答。規則是使用者要明確說要記（「幫我記錄」「加入記憶」「加入追蹤」…）才記，沒明說就只回答，像要記的會反問。
- 2026-10-14：改成看意圖：@bot 丟事實、結論、分工、期限、決定就直接記，不用說「記錄」；問問題才只回答。使用者覺得之前太嚴謹。
- 2026-10-13：拿掉被動全收，平常對話不聽不存。

- 2026-10-13：pm-bot 跟 meeting-recorder 合成一個 bot。

## 待決

- Dashboard 公開或登入？
