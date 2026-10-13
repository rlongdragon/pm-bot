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

Discord Developer Portal 要開 **Message Content Intent**。Bot 權限：Send Messages、Read Message History、View Channels。

登入用 Claude 訂閱：`CLAUDE_CONFIG_DIR` 指到有登入的 profile（留空自動讀 `~/.claude-profile`）。之後要換 API key：`PM_USE_API_KEY=1` 並設 `ANTHROPIC_API_KEY`（或 `ANTHROPIC_BASE_URL` 走 LiteLLM）。

## 指令

| 指令 | 做什麼 | 誰能用 |
|---|---|---|
| `/project new <name>` | 開專案，目前頻道設主頻道 | admin |
| `/project bind <name> [channel] [primary]` | 多綁一個頻道（thread 自動跟父頻道） | admin |
| `/project unbind` / `close` / `list` / `status` | 字面意思 | admin（list/status 全部） |
| `/ask <q>` 或 `@bot <q>` | 問專案現況，引用 raw id | ALLOWED_USER_IDS |
| `/note <text> [file]` | 丟重要內容（會議結論、文字稿、研究成果），**立刻**整理 | ALLOWED_USER_IDS |
| `/digest` | 立刻整理這專案的新訊息 | admin |

綁定頻道裡的每則訊息、附件都會自動進 `raw/`。每 `DIGEST_INTERVAL_MIN` 分鐘跑一次整理（有新訊息才跑）。bot 要說話（確認、提醒）寫到 `outbox/`，整理完貼到主頻道。

## 知識庫結構

一個專案一個資料夾。agent 跑的時候工作目錄就是那個資料夾，碰不到別的專案。

```
knowledge/
  CLAUDE.md               PM 規則（從 knowledge-template/ 複製，可自己改；bot 每次讀進系統提示）
  .git/                   每次整理一個 commit
  <project>/
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
