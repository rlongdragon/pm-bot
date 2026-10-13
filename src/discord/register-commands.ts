import { REST, Routes, SlashCommandBuilder, ChannelType } from "discord.js";
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
      s.setName("new").setDescription("開新專案，並把目前頻道綁為主頻道").addStringOption((o) => o.setName("name").setDescription("英數、-、_").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("close").setDescription("結束專案（資料保留可查）").addStringOption((o) => o.setName("name").setDescription("專案名").setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName("bind")
        .setDescription("把頻道綁到專案")
        .addStringOption((o) => o.setName("name").setDescription("專案名").setRequired(true))
        .addChannelOption((o) => o.setName("channel").setDescription("留空 = 目前頻道").addChannelTypes(ChannelType.GuildText))
        .addBooleanOption((o) => o.setName("primary").setDescription("設為主頻道（digest/提醒貼這）")),
    )
    .addSubcommand((s) => s.setName("unbind").setDescription("解除目前頻道的綁定"))
    .addSubcommand((s) => s.setName("list").setDescription("列出所有專案"))
    .addSubcommand((s) => s.setName("status").setDescription("貼出目前專案的 STATE.md"))
    .toJSON(),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("問專案助理")
    .addStringOption((o) => o.setName("q").setDescription("問題").setRequired(true))
    .toJSON(),
  new SlashCommandBuilder().setName("digest").setDescription("立刻整理這個專案的新訊息").toJSON(),
  new SlashCommandBuilder()
    .setName("note")
    .setDescription("丟一則重要內容（會議結論、文字稿、研究成果），立刻整理")
    .addStringOption((o) => o.setName("text").setDescription("內容；長文可以改用上傳檔案 + 這裡寫標題").setRequired(true))
    .addAttachmentOption((o) => o.setName("file").setDescription("附件（文字稿、文件）"))
    .toJSON(),
];

const rest = new REST().setToken(config.discordToken);
const route = config.discordGuildId
  ? Routes.applicationGuildCommands(config.discordClientId, config.discordGuildId)
  : Routes.applicationCommands(config.discordClientId);
await rest.put(route, { body: commands });
console.log(`registered ${commands.length} command(s) ${config.discordGuildId ? `to guild ${config.discordGuildId}` : "globally"}`);
