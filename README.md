<img src="assets/avatar.png" width="96" align="right" alt="pm-bot">

# pm-bot

Discord 上的專案記憶。團隊把東西丟進頻道，bot 整理成筆記、回答問題、提醒到期的任務。**不執行任務**。

腦袋是 Claude Code（Agent SDK），筆記是一個 git repo（`knowledge/`），bot 本身是一層薄薄的 Discord 膠水。

- @bot 丟事實、分工、期限、決定 → 記進筆記；@bot 問問題 → 從筆記、GitHub、Notion 副本找答案，附來源
- 錄 Discord 語音、Google Meet，或上傳實體會議錄音 → 自動轉逐字稿、寫會議紀錄、開任務
- 連 GitHub repo、Notion 頁面當唯讀來源；STATE.md 可以推到 Notion 看板
- 每個專案一個資料夾，agent 讀寫不出自己的專案

## 需求

- Node 24、npm
- 系統 `ffmpeg`（錄音、轉檔）
- 要錄 Google Meet：`npx playwright install chromium`、`xvfb`
- Claude 訂閱登入的 Claude Code profile，或 Anthropic API key

## 安裝

```bash
cp .env.example .env     # 至少填 DISCORD_TOKEN / DISCORD_CLIENT_ID / DISCORD_GUILD_ID
npm install
npm run register         # 註冊 slash 指令
npm run dev              # 開發；正式跑用 npm run build && npm run pm2:start
```

Discord Developer Portal → Bot：打開 **Message Content Intent**（只能在 Portal 手動開），關掉 **Public Bot**。
沒開 intent 時 bot 會降級啟動：@bot 和 slash 指令都能用，但讀不到被回覆的那句和前後文。開了之後 `npm run pm2:restart`。

邀請連結（權限：看頻道、發訊息、讀歷史、在 thread 發訊息）：

```
https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=274877975552
```

**登入**：`CLAUDE_CONFIG_DIR` 指到有登入的 Claude Code profile（留空讀 `~/.claude-profile`）。要換 API key：`PM_USE_API_KEY=1` 並設 `ANTHROPIC_API_KEY`（或 `ANTHROPIC_BASE_URL` 走 LiteLLM）。

> [!WARNING]
> 用 Claude 訂閱登入時，`ALLOWED_USER_IDS` 只放你自己。官方不允許替其他人透過 Free/Pro/Max 訂閱發請求；留空等於伺服器上任何人都能用你的額度跑 agent，啟動 log 會一直警告。要給整個團隊用請改 API key。

其他設定都在 [.env.example](.env.example)，每一項都有註解。

## 開始用

1. 開一個頻道給專案。不想公開就開**私密頻道**，只加要的人，再把 bot 的身分組加進頻道權限（檢視頻道、傳送訊息、讀取訊息歷史；要錄語音另外給語音頻道「連線」）。bot 進不了 Discord 的群組私訊，用私密頻道代替。
2. 在頻道裡 `/project new <名稱>`，拿到 6 碼專案 ID。其他頻道要共用同一份筆記就 `/project join <id>`。
3. 開始 @bot。

bot 只在它看得到、而且綁了專案的頻道工作。

## 怎麼用

**平常對話 bot 不聽、不存。** 只有被叫到才動：

| 怎麼叫 | 做什麼 |
|---|---|
| @bot 丟事實、分工、期限、決定（「Alice 做登入頁」「下週三 demo」） | 記進筆記，回一句記了什麼 |
| @bot「幫我記錄」「加入追蹤」「更正」… | 記錄、開追蹤任務或改掉對應那條 |
| @bot 問問題 | 只回答，不改筆記 |
| reply 某句話再 @bot | 連那句和前後文一起看（前 `CONTEXT_BEFORE` 則、後 `CONTEXT_AFTER` 則） |
| reply bot 的回答再 @bot | 接著上一輪對話 |
| 帶附件 @bot | 附件存進 `files/`；pptx、docx、xlsx 會抽成文字版給 agent 讀 |

要記還是在問，由 agent 看意圖判斷，不用講出「記錄」兩個字；真的分不出來才會反問。被叫到的那則（含上下文）一律存成 raw，筆記裡每一條都引用 raw id。

## 指令

| 指令 | 做什麼 | 誰能用 |
|---|---|---|
| `/project new <name>` | 開專案，給 6 碼 ID，目前頻道設為主頻道 | admin |
| `/project info [id]` | ID、頻道、統計（記錄、任務、決策、筆記、附件、成員、最後巡檢） | 所有人 |
| `/project join <id> [primary]` | 目前頻道加入既有專案（thread 自動跟父頻道） | admin |
| `/project exit` | 目前頻道離開專案，資料保留 | admin |
| `/project list` / `state` | 列出所有專案 / 貼 STATE.md | 所有人 |
| `/project close <id>` | 結束專案，再打一次 ID 當確認 | admin |
| `/ask <q>` | 問問題，保證唯讀（沒有寫入工具） | ALLOWED_USER_IDS |
| `/note <text> [file]` | 直接記錄（會議結論、文字稿、研究成果） | ALLOWED_USER_IDS |
| `/review` | 立刻巡檢 | admin |
| `/link add <url>` / `list` / `remove <id>` / `sync` / `github` / `notion` | 連 GitHub repo、Notion 頁面或資料庫（唯讀）；`github` 給 GitHub App 授權頁；`notion` 開 Notion 授權頁，勾的頁面自動連上 | admin（list、github 所有人） |
| `/board set <Notion 頁面>` / `sync` / `off` | 在 Notion 建看板，STATE.md 有變就自動更新 | admin |
| `/meet voice [channel]` / `google <url>` / `upload <file\|url>` / `stop` / `status` / `transcribe [nth]` | 錄會議、轉逐字稿 | ALLOWED_USER_IDS |

admin 是 `ADMIN_USER_IDS`，留空等於 `ALLOWED_USER_IDS`。

## 巡檢與提醒

每天 `REVIEW_HOUR` 點自動巡檢（`-1` 關閉），先補整理之前失敗的記錄，再看進行中任務。只有三種會提醒：

- 有**確定日期**且 2 天內到期
- 已經逾期
- 超過 7 天沒更新

期限是「未定」「待確認」的不提醒；同一條任務提醒過，3 天內不再提醒。一次巡檢的提醒合併成一則，只 @ 今天到期或逾期的負責人。要向人確認的事，bot 直接寫在回覆裡，不會另外洗頻道。大多數日子巡檢結果是「無事」。

## 知識庫結構

一個專案一個資料夾。agent 跑的時候工作目錄就是那個資料夾，碰不到別的專案。

```
knowledge/
  CLAUDE.md               PM 規則（從 knowledge-template/ 複製，可自己改；每次讀進系統提示）
  .git/                   每次整理一個 commit
  <id>/                   專案 ID（6 碼）
    STATE.md              現況：進行中 / 阻塞 / 下一步        agent 可寫
    decisions.md          決策 append-only                     agent 可寫
    people.md             名字 ↔ Discord id ↔ 負責             agent 可寫
    notes/                研究成果、文字稿、會議紀錄            agent 可寫
    log/YYYY-MM-DD.md     每日摘要                              agent 可寫
    outbox.md             bot 要貼出去的話                      agent 可寫
    raw/YYYY-MM-DD.md     頻道原文 append-only                  只有 bot 寫
    files/                附件（含 Office 檔的文字版）          只有 bot 寫
    pending.md            待整理緩衝                            只有 bot 寫
    sources/              GitHub、Notion 副本                   只有 bot 寫
```

`git -C knowledge log -p` 看 bot 改了什麼，改壞了 revert。

## 權限隔離

兩層，任一層擋下就不執行：

1. **權限規則**：`permissionMode: dontAsk`，只允許寫上表標「agent 可寫」的路徑，工作目錄外的讀寫一律拒絕。
2. **PreToolUse hook**（`src/sandbox.ts`）：每次工具呼叫都解出實際路徑（含 symlink），不在白名單就擋，log 印 `[guard] DENY`。

另外：

- 整理回合的工具只有 Read、Glob、Grep、Write、Edit、WebFetch；問答回合沒有 Write、Edit。沒有 Bash、沒有 subagent。
- `settingSources: []`：不讀任何 settings 檔，agent 就算寫了 `.claude/settings.json` 也不生效（而且寫不進去）。
- 外部來源的 token 都在 bot 手上，agent 拿不到。

## 外部來源與看板

**來源（唯讀）**：`/link add` 之後，每次 agent 開跑前 bot 檢查有沒有更新（`SOURCE_MIN_INTERVAL_MIN` 分鐘內不重抓），存成 `sources/` 底下的 markdown。

- **GitHub**：README、issues、PR（含 reviewer 與審查紀錄）、最近 30 個 commit、`docs/*.md`。用 ETag，沒變不算額度。私有 repo 建議用 GitHub App，在安裝頁勾 repo 就授權，設定見 [docs/github-app.md](docs/github-app.md)；也可以用唯讀的 fine-grained `GITHUB_TOKEN`。
- **Notion**：頁面轉 markdown，每個子頁面一檔（`sources/notion/<根頁面id>/pages/<頁面id>.md`），所以貼 Notion 網址問 bot，它用網址裡的 32 碼 id 就找得到；資料庫轉表格（最多 500 列）。
  - 建議用授權：在 Notion 建 OAuth 連接（勾讀取、更新、插入內容，重新導向 URI 填 `<PUBLIC_BASE_URL>/notion/callback`），client id / secret 填進 `.env`。`/link notion` 按按鈕、在 Notion 勾頁面，勾的最上層頁面自動連上（最多 10 個）。token 每個專案一組，存在 `data/notion-auth.json`（權限 600），過期自動換新。
  - callback 由 bot 自己的 HTTP 伺服器接（`HTTP_PORT`，只回 callback、Meet 登入頁和 `/healthz`）。`HTTP_HOST=0.0.0.0` 直接對外；要 https 就前面放反向代理，`HTTP_HOST` 留 `127.0.0.1`。
  - 不用授權也可以：`NOTION_TOKEN` 填 internal integration，只勾「讀取內容」，在頁面 ••• > Connections 加入。

**看板（寫入）**：bot 把 STATE.md 的任務推到 Notion 資料庫，分進行中、待決、下一步、完成。單向同步，Notion 上手動改會被蓋掉。

- 有授權的專案用授權的 token。沒授權就另開一個 integration（`NOTION_BOARD_TOKEN`），勾讀取、更新、插入，**只加入看板那一頁**，靠 Notion 權限保證它寫不到別頁。
- 卡片用任務標題對應，從進行中搬到完成會更新同一張；STATE 裡消失的未完成卡封存，完成的保留。

## 會議錄音

音檔不進筆記 git，放 `data/recordings/<專案ID>/<時間>_<平台>_<名稱>/`（`manifest.json` 有參與者與時間軸）。頻道裡有一張狀態卡顯示錄音、轉錄、整理進度。錄完自動轉逐字稿（`TRANSCRIBE_AUTO=0` 改成手動 `/meet transcribe`），agent 讀逐字稿寫會議紀錄到 `notes/`，有明確負責人的待辦開成任務。

- **Discord 語音**：`/meet voice`，錄你所在的語音頻道，每人一軌再混成 `mixed.ogg`。所有人離開自動停。bot 要有該頻道的「連線」權限。
- **實體會議錄音**：把錄音檔丟到頻道，回覆它並 @bot 說「轉逐字稿」（可以順便寫標題、日期、與會者）；或 `/meet upload file:<錄音檔>`（或 `url:` 直接下載連結，上限 500 MB），可加 `title`、`date`、`people`。
- **Google Meet**：`/meet google <url>`，Chromium 在 Xvfb 虛擬螢幕上有畫面地跑（無頭模式會被 Meet 擋），子程序掛了不影響 bot。房內只剩 bot 超過 `MEET_ALONE_TIMEOUT_SEC` 秒自動離開。
  - **bot 要有自己的 Google 帳號**：Google 會拒絕沒登入的訪客 bot。在伺服器跑 `npm run meet:login`，它印出 `<PUBLIC_BASE_URL>/login/<一次性代碼>`，打開是遠端 Chromium 畫面，用 bot 的帳號登入（Ctrl+V 可貼密碼）。profile 存在 `data/meet-profile/`，要換帳號就刪掉再跑一次。
  - 把 bot 帳號加進日曆邀請就直接進；臨時會議它會敲門，主持人按允許。
- **轉逐字稿**：走 OpenAI 相容 API（`TRANSCRIBE_BASE_URL`，模型要能吃音訊），主模型失敗依序改用 `TRANSCRIBE_FALLBACK_MODELS`。長錄音每 `TRANSCRIBE_CHUNK_MIN` 分鐘切一段。逐字稿格式是 `[時間段落] 名字：內容`，完整如實不刪改，可以用 `TRANSCRIBE_PROMPT_FILE` 換 prompt。
- bot 停止或重啟時會先把錄音收尾存檔（pm2 `kill_timeout` 60 秒）。

## 監控

設 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY` 就會用 OpenTelemetry（OTLP）把每次 agent 回合送到 Langfuse，Langfuse v4 也收得到：

- 一回合一條 trace，名稱是 mention / ask / review…，tag 是專案 ID 和模式，userId 是觸發的 Discord 使用者，sessionId 是 Claude 的 session。
- 每次 Claude 回覆一個 generation（input、output、cache token、耗時），每個工具呼叫一個 span（輸入、輸出、有沒有被擋）。
- 轉逐字稿也是一條 trace，每次打模型一個 generation。

不設就完全不送。

## 開發

```bash
npm run typecheck
npm run pm2:logs
```

`scripts/` 裡是測試腳本。會動到檔案的測試請指到暫存資料夾，別碰正式資料：

```bash
T=$(mktemp -d)
STATE_FILE=$T/state.json KNOWLEDGE_DIR=$T/k RECORDINGS_DIR=$T/r node --import tsx scripts/store-test.ts
```

- 不花錢：`guard-test`（路徑白名單）、`store-test`、`parse-test`、`card-test`、`board-test`（假 Notion API）、`import-test`。
- 要網路、用 `.env` 的憑證：`link-test`、`review-test`（GitHub reviewer）、`github-app-test`、`notion-oauth-test`。
- 會跑真的 agent 或模型、花錢：`escape-test`（嘗試越界）、`mention-test`、`reply-test`、`transcribe-test <錄音資料夾>`。

## 之後

- HackMD、Google Drive 來源
- 每週 compaction：STATE 裡完成的搬去 log
