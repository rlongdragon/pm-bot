import "dotenv/config";
const H = { Authorization: "Bot " + process.env.DISCORD_TOKEN };
const deadline = Date.now() + 15 * 60_000;
while (Date.now() < deadline) {
  const a = await (await fetch("https://discord.com/api/v10/applications/@me", { headers: H })).json().catch(() => ({}));
  const on = ((a.flags ?? 0) & ((1 << 18) | (1 << 19))) !== 0;
  if (on) { console.log(`INTENT_ON public_bot=${a.bot_public}`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 5000));
}
console.log("TIMEOUT intent still off"); process.exit(1);
