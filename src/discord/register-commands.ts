import { ChannelType, REST, Routes, SlashCommandBuilder } from "discord.js";
import { config } from "../config.js";

if (!config.discordToken || !config.discordClientId) {
  console.error("缺 DISCORD_TOKEN / DISCORD_CLIENT_ID");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("project")
    .setDescription("專案管理")
    .addSubcommand((s) =>
      s
        .setName("new")
        .setDescription("開新專案，目前頻道設為主頻道")
        .addStringOption((o) => o.setName("name").setDescription("專案名稱，可以中文").setRequired(true).setMaxLength(50)),
    )
    .addSubcommand((s) =>
      s
        .setName("info")
        .setDescription("專案資訊：ID、頻道、統計")
        .addStringOption((o) => o.setName("id").setDescription("留空 = 目前頻道的專案")),
    )
    .addSubcommand((s) =>
      s
        .setName("join")
        .setDescription("把目前頻道加入既有專案")
        .addStringOption((o) => o.setName("id").setDescription("專案 ID（/project info 看得到）").setRequired(true))
        .addBooleanOption((o) => o.setName("primary").setDescription("設為主頻道（提醒貼這裡）")),
    )
    .addSubcommand((s) => s.setName("exit").setDescription("目前頻道離開專案"))
    .addSubcommand((s) => s.setName("list").setDescription("列出所有專案"))
    .addSubcommand((s) => s.setName("state").setDescription("貼出目前專案的 STATE.md"))
    .addSubcommand((s) =>
      s
        .setName("close")
        .setDescription("結束專案（資料保留）")
        .addStringOption((o) => o.setName("id").setDescription("要結束的專案 ID，打一次當確認").setRequired(true)),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("問專案助理（唯讀，不會記錄）")
    .addStringOption((o) => o.setName("q").setDescription("問題").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("記錄重要內容（會議結論、文字稿、研究成果）")
    .addStringOption((o) => o.setName("text").setDescription("內容；長文可以上傳檔案，這裡寫標題").setRequired(true))
    .addAttachmentOption((o) => o.setName("file").setDescription("附件"))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("link")
    .setDescription("外部來源：GitHub repo、Notion 頁面或資料庫（唯讀）")
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("連一個來源到這個專案")
        .addStringOption((o) => o.setName("url").setDescription("github.com/owner/repo 或 Notion 網址").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("列出這個專案的來源"))
    .addSubcommand((s) =>
      s
        .setName("remove")
        .setDescription("移除來源")
        .addStringOption((o) => o.setName("id").setDescription("/link list 看得到的 4 碼 id").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("sync").setDescription("立刻重新抓全部來源"))
    .addSubcommand((s) => s.setName("github").setDescription("GitHub 授權頁面：勾要給我看的 repo"))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("board")
    .setDescription("Notion 看板：把 STATE.md 的任務推到 Notion")
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("在這個 Notion 頁面底下建看板")
        .addStringOption((o) => o.setName("url").setDescription("Notion 頁面網址（要先在那頁加入看板用的 integration）").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("sync").setDescription("立刻更新看板"))
    .addSubcommand((s) => s.setName("off").setDescription("停止更新看板（Notion 上的資料庫保留）"))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("meet")
    .setDescription("會議錄音：Discord 語音或 Google Meet")
    .addSubcommand((s) =>
      s
        .setName("voice")
        .setDescription("錄 Discord 語音頻道（每人一軌）")
        .addChannelOption((o) => o.setName("channel").setDescription("留空 = 你現在所在的語音頻道").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)),
    )
    .addSubcommand((s) =>
      s
        .setName("google")
        .setDescription("以訪客身分加入 Google Meet 錄音")
        .addStringOption((o) => o.setName("url").setDescription("https://meet.google.com/xxx-yyyy-zzz").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("stop").setDescription("停止錄音並存檔"))
    .addSubcommand((s) => s.setName("status").setDescription("目前錄音狀態"))
    .addSubcommand((s) =>
      s
        .setName("transcribe")
        .setDescription("把錄音轉成逐字稿並整理成會議紀錄（預設最近一場）")
        .addIntegerOption((o) => o.setName("nth").setDescription("倒數第幾場，1 = 最近一場").setMinValue(1)),
    )
    .toJSON(),
  new SlashCommandBuilder().setName("review").setDescription("立刻跑一次巡檢（期限、久未更新提醒）").toJSON(),
];

const rest = new REST().setToken(config.discordToken);
const route = config.discordGuildId
  ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
  : Routes.applicationCommands(config.discordClientId);
await rest.put(route, { body: commands });
console.log(`registered ${commands.length} command(s) ${config.discordGuildId ? `to guild ${config.discordGuildId}` : "globally"}`);
