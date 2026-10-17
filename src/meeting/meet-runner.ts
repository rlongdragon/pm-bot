/**
 * Google Meet 錄音子程序（搬自 meeting-recorder/src/meet/index.ts）。
 * 由 pm-bot 用 child_process 啟動，Chromium 掛了不會拖垮 bot。
 *   node meet-runner.js <project> <meet url> [--name 名字]
 * stdout 以「@@ {json}」回報進度：status / done / error。SIGTERM = 收尾並結束。
 */
import { chromium, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { RecordingSession, webmToOgg } from "./session.js";
import { INJECT } from "./inject.js";

const [project, url] = process.argv.slice(2);
const nameArg = process.argv.indexOf("--name");
const botName = nameArg > 0 ? process.argv[nameArg + 1] : config.meetBotName;

function emit(type: "status" | "done" | "error", data: Record<string, unknown>) {
  process.stdout.write("@@ " + JSON.stringify({ type, ...data }) + "\n");
}

if (!project || !url || !/^https:\/\/meet\.google\.com\//.test(url)) {
  emit("error", { message: "用法：meet-runner <project> https://meet.google.com/xxx-yyyy-zzz" });
  process.exit(1);
}

/**
 * headless 的 UA 會帶 HeadlessChrome，所以要自己給；但版本號一定要跟實際的瀏覽器一致，
 * 否則 Meet 比對 client hints 發現不符，直接給「你無法加入這場視訊通話」（實測：寫死 Chrome/131 必被擋）。
 */
function uaFor(version: string) {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version.split(".")[0]}.0.0.0 Safari/537.36`;
}
const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--lang=zh-TW",
  // 登入用的 profile（scripts/meet-login.ts）也用 basic，cookie 才解得開
  "--password-store=basic",
  // 畫面上少些干擾：翻譯列、上次沒正常關閉的還原泡泡
  "--disable-features=Translate,TranslateUI",
  "--hide-crash-restore-bubble",
];

const session = new RecordingSession(project, "meet", url, url.replace(/^https:\/\/meet\.google\.com\//, "").split("?")[0]);
const webmPath = path.join(session.dir, "tracks", "meet.webm");
const webm = fs.createWriteStream(webmPath);
let stopping = false;
let page: Page;
let context: BrowserContext;
let failure: string | null = null;

main().catch(async (e) => {
  if (stopping) return; // 使用者 /meet stop 時關掉瀏覽器，等待中的步驟會失敗，那不是錯誤
  failure = String(e?.message ?? e);
  console.error("[meet] fatal:", e);
  // 任何失敗都留畫面和文字，查 Meet 改版用
  if (page) {
    await page.screenshot({ path: path.join(session.dir, "failed.png"), fullPage: true }).catch(() => {});
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
    console.error("[meet] page url:", page.url(), "text:", body);
  }
  session.event("error", failure);
  await shutdown(1);
});

async function main() {
  emit("status", { message: "開啟會議頁面", dir: session.dir });
  const headless = !config.meetHeaded || !process.env.DISPLAY;
  if (headless) console.error("[meet] 無頭模式（沒有 DISPLAY）：Meet 很可能把它當自動程式擋下");
  const ctxOpts = (ua?: string) => ({ ...(ua ? { userAgent: ua } : {}), locale: "zh-TW", viewport: { width: 1280, height: 800 }, permissions: ["microphone", "camera"] as string[] });
  if (config.meetUserDataDir) {
    let ua: string | undefined;
    if (headless) {
      // persistent context 建立時就要給 UA，先開一個拿版本號
      const probe = await chromium.launch({ channel: "chromium", headless: true });
      ua = uaFor(probe.version());
      await probe.close();
    }
    context = await chromium.launchPersistentContext(config.meetUserDataDir, { channel: "chromium", headless, args: ARGS, ...ctxOpts(ua) });
  } else {
    const browser = await chromium.launch({ channel: "chromium", headless, args: ARGS });
    context = await browser.newContext(ctxOpts(headless ? uaFor(browser.version()) : undefined));
  }
  console.error(`[meet] ${headless ? "headless" : "headed"} profile=${config.meetUserDataDir || "(訪客)"} ua: ${await page_ua(context)}`);
  page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript(INJECT);
  await page.exposeFunction("__rec_chunk", (b64: string) => {
    webm.write(Buffer.from(b64, "base64"));
  });
  await page.exposeFunction("__rec_log", (s: string) => console.error("[page]", s));
  await page.exposeFunction("__rec_event", (kind: string, who: string) => {
    const t = /加入|join/i.test(kind) ? "join" : "leave";
    session.event(t, who);
    if (t === "join") session.addParticipant({ id: who, name: who });
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await dismissPopups();

  // 大廳有兩種：訪客要填名字；登入的帳號直接顯示「要求加入」。等到哪個先出現就走哪條
  const nameInput = page.locator('input[type="text"]').first();
  const joinBtn = page.getByRole("button", { name: /要求加入|立即加入|Ask to join|Join now|加入/i }).first();
  const first = await Promise.race([
    nameInput.waitFor({ state: "visible", timeout: 30_000 }).then(() => "name" as const),
    joinBtn.waitFor({ state: "visible", timeout: 30_000 }).then(() => "join" as const),
  ]).catch(() => null);
  if (!first) {
    if (await page.locator('a[href*="accounts.google.com"], text=/登入|Sign in/i').first().isVisible().catch(() => false))
      throw new Error("這場會議要求 Google 帳號登入。在伺服器跑 npm run meet:login 讓 bot 登入");
    throw new Error("30 秒內沒看到大廳（填名字或加入按鈕）。會議代碼可能錯了，或 Meet 改版");
  }
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill(botName);
    session.event("name", botName);
  } else {
    session.event("signed-in");
  }

  for (const re of [/關閉麥克風|Turn off microphone/i, /關閉攝影機|Turn off camera/i]) {
    const b = page.getByRole("button", { name: re }).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }

  await joinBtn.waitFor({ state: "visible", timeout: 30_000 });
  await joinBtn.click();
  session.event("asked-to-join");
  emit("status", { message: `已要求加入，等主持人放行「${botName}」` });

  const admitted = await waitInCall(config.meetAdmitTimeoutSec * 1000);
  if (stopping) return;
  if (admitted !== true) {
    // 留下畫面和文字，方便查是 Meet 改版還是真的被擋
    const shot = path.join(session.dir, "join-failed.png");
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    const body = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 600);
    console.error("[meet] join failed, page text:", body);
    throw new Error(admitted === false ? `被 Meet 擋下：「${rejectReason}」` : "等主持人放行逾時");
  }
  session.event("admitted");
  await page.evaluate("window.__rec_start()");
  session.manifest.files.tracks.push("tracks/meet.webm");
  session.save();
  emit("status", { message: "已進入會議，開始錄音", recording: true });

  let aloneSince: number | null = null;
  let lastDebug = 0;
  while (!stopping) {
    await page.waitForTimeout(5000);
    if (await callEnded()) {
      session.event("call-ended");
      break;
    }
    const n = await participantCount();
    if (Date.now() - lastDebug > 60_000) {
      // 每分鐘記一次人數判斷的依據，Meet 改版時才查得到為什麼沒自動離開
      lastDebug = Date.now();
      const labels = await page
        .evaluate(`[...document.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label')).filter(l => /\\d/.test(l) && /人|people|participant|與會|everyone/i.test(l)).slice(0, 6)`)
        .catch(() => []);
      console.error(`[meet] participants=${n} alone=${aloneSince ? Math.round((Date.now() - aloneSince) / 1000) + "s" : "no"} labels=${JSON.stringify(labels)}`);
    }
    if (n !== null) {
      if (n <= 1) {
        aloneSince ??= Date.now();
        if (config.meetAloneTimeoutSec > 0 && Date.now() - aloneSince > config.meetAloneTimeoutSec * 1000) {
          session.event("alone-timeout");
          break;
        }
      } else aloneSince = null;
    }
  }
  await shutdown(0);
}

async function page_ua(ctx: BrowserContext): Promise<string> {
  const p = ctx.pages()[0] ?? (await ctx.newPage());
  return p.evaluate("navigator.userAgent") as Promise<string>;
}

async function dismissPopups() {
  for (const re of [/關閉|Dismiss|Got it|知道了|繼續|Continue/i]) {
    const b = page.getByRole("button", { name: re }).first();
    if (await b.isVisible({ timeout: 1500 }).catch(() => false)) await b.click().catch(() => {});
  }
}

let rejectReason = "";
/** true = 進去了；false = 頁面出現被擋的字句（rejectReason 是那一句）；null = 逾時 */
async function waitInCall(timeoutMs: number): Promise<boolean | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    if (await inCall()) return true;
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
    const m = body.match(/[^\n]*(拒絕|denied|無法加入|can't join|couldn't join)[^\n]*/i);
    if (m) {
      rejectReason = m[0].trim().slice(0, 120);
      return false;
    }
    await page.waitForTimeout(2000);
  }
  return null;
}

async function inCall() {
  return page.locator('[aria-label*="離開通話"], [aria-label*="Leave call"], [aria-label*="退出通話"]').first().isVisible().catch(() => false);
}

async function callEnded() {
  if (await inCall()) return false;
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
  return /返回主畫面|Return to home screen|已離開通話|You've left|已將你移除|removed from the meeting|會議已結束|meeting has ended/i.test(body);
}

async function participantCount(): Promise<number | null> {
  // 新版 Meet 不一定把人數放在 aria-label；只剩自己時畫面會寫「你是唯一的與會者」，也當 1 個人
  const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 6000);
  if (/你是唯一|只有你一個|You're the only one|You are the only one/i.test(body)) return 1;
  return page
    .evaluate(
      `(() => {
    // 每個與會者的畫面格都有 data-participant-id，數不重複的 id 最準
    const ids = new Set([...document.querySelectorAll('[data-participant-id]')].map(e => e.getAttribute('data-participant-id')).filter(Boolean));
    if (ids.size) return ids.size;
    const els = document.querySelectorAll('button, [role="button"], div[aria-label]');
    for (const el of els) {
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
      const m = /(?:人員|participants?|people)[^0-9]{0,10}(\\d+)|(\\d+)\\s*(?:位)?(?:人員|participants?|people)/i.exec(label);
      if (m) return Number(m[1] ?? m[2]);
    }
    return null;
  })()`,
    )
    .catch(() => null) as Promise<number | null>;
}

async function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  try {
    await page?.evaluate("window.__rec_stop()");
  } catch {}
  try {
    const leave = page?.locator('[aria-label*="離開通話"], [aria-label*="Leave call"]').first();
    if (leave && (await leave.isVisible().catch(() => false))) await leave.click({ timeout: 3000 }).catch(() => {});
  } catch {}
  await new Promise<void>((r) => webm.end(r));
  try {
    await context?.close();
  } catch {}
  const size = fs.existsSync(webmPath) ? fs.statSync(webmPath).size : 0;
  if (size > 0) {
    try {
      await webmToOgg(webmPath, path.join(session.dir, "mixed.ogg"));
      session.manifest.files.mixed = "mixed.ogg";
    } catch (e) {
      console.error("[meet] remux failed, keeping webm:", (e as Error).message);
    }
  }
  session.finish();
  emit("done", { dir: session.dir, manifest: session.manifest, error: failure });
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(0));
