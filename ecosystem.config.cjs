module.exports = {
  apps: [
    {
      name: "pm-bot",
      script: "dist/discord/index.js",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      out_file: "logs/pm-bot.out.log",
      error_file: "logs/pm-bot.err.log",
      time: true,
    },
  ],
};
