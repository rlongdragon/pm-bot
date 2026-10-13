import { REST, Routes, SlashCommandBuilder } from "discord.js";
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
  new SlashCommandBuilder().setName("review").setDescription("立刻跑一次巡檢（期限、久未更新提醒）").toJSON(),
];

const rest = new REST().setToken(config.discordToken);
const route = config.discordGuildId
  ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
  : Routes.applicationCommands(config.discordClientId);
await rest.put(route, { body: commands });
console.log(`registered ${commands.length} command(s) ${config.discordGuildId ? `to guild ${config.discordGuildId}` : "globally"}`);
