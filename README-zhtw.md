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

## 之後

- Notion 單向推看板（MCP）
- GitHub webhook → raw
- Drive / HackMD 讀（MCP）
- 每週 compaction：STATE 裡完成的搬 log
