# pm-bot

Discord 上的專案記憶。團隊把東西丟進頻道，bot 整理成筆記、回答問題、提醒人。**不執行任務**。

腦袋是 Claude Code（Agent SDK），筆記是一個 git repo（`knowledge/`），bot 本身只是薄薄一層 Discord 膠水。

## 怎麼跑

```bash
cp .env.example .env     # 填 DISCORD_TOKEN / DISCORD_CLIENT_ID / DISCORD_GUILD_ID
npm install
npm run register         # 註冊 slash 指令
npm run dev              # 或 npm run build && npm run pm2:start
```

Discord Developer Portal → Bot：打開 **Message Content Intent**（只能在 Portal 手動開，API 改不了），關掉 **Public Bot**。
沒開 intent 時 bot 會降級啟動：@bot 和 slash 指令都能用，但 reply 時讀不到被回覆的那句和前後文。開了之後 `npm run pm2:restart`。

邀請連結（權限：看頻道、發訊息、讀歷史、在 thread 發訊息）：
`https://discord.com/oauth2/authorize?client_id=<CLIENT_ID>&scope=bot+applications.commands&permissions=274877975552`

登入用 Claude 訂閱：`CLAUDE_CONFIG_DIR` 指到有登入的 profile（留空自動讀 `~/.claude-profile`）。之後要換 API key：`PM_USE_API_KEY=1` 並設 `ANTHROPIC_API_KEY`（或 `ANTHROPIC_BASE_URL` 走 LiteLLM）。

## 怎麼用

**平常對話 bot 不聽、不存。** 只有被叫到才動：

| 怎麼叫 | 做什麼 |
|---|---|
| @bot 加問題 | 回答。不改筆記 |
| @bot「幫我記錄」「加入記憶」「加入追蹤」「更正」… | 記進筆記，回一句記了什麼 |
| reply 某句話再 @bot | 連那句和前後文一起看（前 `CONTEXT_BEFORE` 則、後 `CONTEXT_AFTER` 則） |
| reply bot 的回答再 @bot | 接著上一輪對話 |

記錄或回答由 agent 判斷，規則是使用者要明確說要記才記。沒明說但像要記的，它會反問。
被叫到的那則（含上下文）一律存成 raw，筆記裡的每一條都引用 raw id。

## 指令

| 指令 | 做什麼 | 誰能用 |
|---|---|---|
| `/project new <name>` | 開專案，給一組 6 碼 ID，目前頻道設主頻道 | admin |
| `/project info [id]` | ID、頻道、統計（記錄數、任務、決策、筆記、附件、成員、最後巡檢） | 所有人 |
| `/project join <id> [primary]` | 目前頻道加入既有專案（thread 自動跟父頻道） | admin |
| `/project exit` | 目前頻道離開專案，資料保留 | admin |
| `/project list` / `state` | 列出所有專案 / 貼 STATE.md | 所有人 |
| `/project close <id>` | 結束專案，打一次 ID 當確認 | admin |
| `/ask <q>` | 問問題，保證唯讀（沒有寫入工具） | ALLOWED_USER_IDS |
| `/note <text> [file]` | 直接記錄（會議結論、文字稿、研究成果） | ALLOWED_USER_IDS |
| `/review` | 立刻巡檢 | admin |
| `/link add <url>` / `list` / `remove <id>` / `sync` / `github` / `notion` | 連 GitHub repo、Notion 頁面或資料庫（唯讀）；`github` 給 GitHub App 授權頁面；`notion` 開 Notion 授權頁，勾的頁面自動連上 | admin（list、github 全部） |
| `/board set <Notion 頁面>` / `sync` / `off` | 在 Notion 建看板，STATE.md 有變就自動更新 | admin |
| `/meet voice [channel]` / `google <url>` / `stop` / `status` | 錄 Discord 語音或 Google Meet | ALLOWED_USER_IDS |

每天 `REVIEW_HOUR` 點自動巡檢：期限 2 天內、超過 7 天沒更新的任務在主頻道提醒負責人；之前處理失敗的記錄也會補整理。

## 知識庫結構

一個專案一個資料夾。agent 跑的時候工作目錄就是那個資料夾，碰不到別的專案。

```
knowledge/
  CLAUDE.md               PM 規則（從 knowledge-template/ 複製，可自己改；bot 每次讀進系統提示）
  .git/                   每次整理一個 commit
  <id>/                   專案 ID（6 碼）
    STATE.md              現況：進行中 / 阻塞 / 下一步        agent 可寫
    decisions.md          決策 append-only                     agent 可寫
    people.md             名字 ↔ Discord id ↔ 負責             agent 可寫
    notes/                研究成果、文字稿整理                  agent 可寫
    log/YYYY-MM-DD.md     每日摘要                              agent 可寫
    outbox.md             bot 要貼出去的話                      agent 可寫
    raw/YYYY-MM-DD.md     頻道原文 append-only                  只有 bot 寫
    files/                附件                                  只有 bot 寫
    pending.md            待整理緩衝                            只有 bot 寫
```

`git -C knowledge log -p` 看 bot 改了什麼，改壞了 revert。

## 權限隔離

兩層，任一層擋下就不執行：

1. **權限規則**：`permissionMode: dontAsk`，只允許寫上表標「agent 可寫」的路徑。工作目錄外的讀寫一律拒絕。
2. **PreToolUse hook**（`src/sandbox.ts`）：每次工具呼叫都解實際路徑（含 symlink），不在白名單就擋，並在 log 印 `[guard] DENY`。

另外：

- 整理回合工具只有 Read/Glob/Grep/Write/Edit/WebFetch。問答回合沒有 Write/Edit。沒有 Bash、沒有 subagent。
- `settingSources: []`：不讀任何 settings 檔，agent 就算寫了 `.claude/settings.json` 也不生效（而且寫不進去）。
- 測試：`npx tsx scripts/guard-test.ts`（路徑判斷，34 例，不花錢）、`scripts/escape-test.ts`（真 agent 嘗試越界，花錢）。

## 外部來源與看板

**來源（唯讀）**：bot 抓、agent 讀。`/link add` 之後，每次 agent 開跑前 bot 檢查有沒有更新（10 分鐘內不重抓），存成 `sources/<github|notion>/...` 的 markdown。agent 拿不到 token。

- GitHub：README、issues、PRs、最近 30 個 commit、`docs/*.md`。用 ETag，沒變回 304 不算額度。私有 repo 建議用 GitHub App：在安裝頁面勾 repo 就授權，設定見 [docs/github-app.md](docs/github-app.md)；也可以用 `GITHUB_TOKEN`（fine-grained、唯讀）。
- Notion：頁面轉 markdown（含子頁面），資料庫轉表格（最多 500 列）。
  - 建議用授權：在 Notion 建 OAuth 連接（勾讀取、更新、插入內容，重新導向 URI 填 `<PUBLIC_BASE_URL>/notion/callback`），把 client id / secret 填進 `.env`。`/link notion` 按按鈕、在 Notion 勾頁面，勾的最上層頁面自動連上（最多 10 個）。token 每個專案一組，存在 `data/notion-auth.json`（權限 600），過期自動換新。
  - callback 由 bot 自己的 HTTP 伺服器接（`HTTP_PORT`，只回 callback 和 `/healthz`）。`HTTP_HOST=0.0.0.0` 直接對外，`PUBLIC_BASE_URL` 填 `http://<主機 IP>:<port>`；要 https 的話前面放反向代理，`HTTP_HOST` 留 `127.0.0.1`。
  - 不用授權也可以：`NOTION_TOKEN` 填 internal integration，只勾「讀取內容」，在頁面 ••• > Connections 加入。

**看板（寫入）**：bot 把 STATE.md 的任務推到 Notion 資料庫，分進行中、待決、下一步、完成。單向：Notion 上手動改會被蓋掉。

- 有授權的專案，看板用授權的 token（寫得到你勾的所有頁面）。沒授權的話另開一個 integration 給看板（`NOTION_BOARD_TOKEN`），勾讀取、更新、插入，**只加入看板那一頁**，靠 Notion 權限保證它寫不到別頁。
- 卡片用任務標題對應，從進行中搬到完成會更新同一張；STATE 裡消失的未完成卡封存，完成的保留。

## 會議錄音

從 meeting-recorder 併進來的。音檔不進筆記 git，放 `data/recordings/<專案ID>/<時間>_<平台>_<名稱>/`（`manifest.json` 有參與者與時間軸）。錄完 bot 在下指令的頻道回報，並在專案記一筆 raw。**還不會轉文字稿**，有逐字稿用 `/note` 上傳。

- **Discord 語音**：`/meet voice`，錄你所在的語音頻道，每人一軌再混成 `mixed.ogg`。所有人離開自動停。bot 要有該頻道的「連線」權限。
- **Google Meet**：`/meet google <url>`，Chromium 在 Xvfb 虛擬螢幕上有畫面地跑（無頭模式會被 Meet 當自動程式擋），另開子程序，掛了不影響 bot。
  - **bot 要有自己的 Google 帳號**：Google 會自動拒絕沒登入的訪客 bot（主持人收不到要求），機房 IP 連 Open 會議也進不去。在伺服器跑 `npm run meet:login`，它印出一個網址（`<PUBLIC_BASE_URL>/login/<一次性代碼>`，由 bot 的 HTTP 轉給腳本），打開就是遠端的 Chromium 畫面，用 bot 的帳號登入（Ctrl+V 可以貼密碼）。登入完自動關閉，profile 存在 `data/meet-profile/`，之後 `/meet google` 自動用。要換帳號就刪掉那個資料夾再跑一次。
  - 會議維持預設的 Trusted：把 bot 帳號加進日曆邀請就直接進；臨時會議它會敲門，主持人按允許。
- 需要系統 `ffmpeg`、`npx playwright install chromium`。
- bot 停止或重啟時會先把錄音收尾存檔（pm2 `kill_timeout` 60 秒）。

## 之後

- HackMD、Google Drive 來源
- 會議錄音轉文字稿（ai.rlong.me 的 Gemini），自動當成 /note 進專案
- 每週 compaction：STATE 裡完成的搬 log
