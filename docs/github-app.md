# GitHub App 設定

一次性設定，大約兩分鐘。之後連私有 repo 只要在 GitHub 的安裝頁面勾 repo，不用複製 token。

## 1. 建 App

打開 https://github.com/settings/apps/new ，照下面填，沒提到的保持預設：

| 欄位 | 填什麼 |
|---|---|
| GitHub App name | 全 GitHub 唯一，例如 `rlong-pm-bot` |
| Homepage URL | 隨便一個網址，例如 `https://github.com/rlongdragon` |
| Webhook → Active | **取消勾選** |
| Repository permissions → Contents | Read-only |
| Repository permissions → Issues | Read-only |
| Repository permissions → Pull requests | Read-only |
| Repository permissions → Metadata | Read-only（會自動帶出來） |
| Where can this GitHub App be installed? | repo 都在你自己帳號底下選 **Only on this account**；有組員或組織的 repo 選 **Any account** |

按 **Create GitHub App**。

## 2. 拿 App ID 和私鑰

建好後會在 App 的設定頁：

1. 頁面上方的 **App ID**，是一串數字，記下來。
2. 往下捲到 **Private keys**，按 **Generate a private key**，瀏覽器會下載一個 `.pem` 檔。

## 3. 放到伺服器

把 `.pem` 放到 `/root/probjects/pm-bot/data/github-app.pem`，例如從你的電腦：

```bash
scp ~/Downloads/rlong-pm-bot.*.private-key.pem <伺服器>:/root/probjects/pm-bot/data/github-app.pem
ssh <伺服器> chmod 600 /root/probjects/pm-bot/data/github-app.pem
```

私鑰不要貼到聊天或 Discord 裡。

`.env` 加兩行，然後重啟：

```
GITHUB_APP_ID=<App ID>
GITHUB_APP_PRIVATE_KEY_FILE=./data/github-app.pem
```

```bash
cd /root/probjects/pm-bot && npm run pm2:restart
```

## 4. 授權 repo

在 Discord 打 `/link github`，bot 會給你安裝頁面的連結。在那頁勾要給它看的 repo、按 **Install**，再 `/link add url:<repo 網址>`。

之後要加 repo：GitHub → Settings → Applications → 你的 App → Configure，勾新的 repo 就好。

直接 `/link add` 一個還沒授權的私有 repo，bot 也會回這個連結。

## 權限說明

- App 只有唯讀權限，安裝頁面上看得到它要求了哪些權限。
- bot 每次用私鑰換一個一小時就過期的 token，伺服器上不會有長期有效的 token。
- 要撤銷：GitHub → Settings → Applications → 你的 App → Uninstall。
