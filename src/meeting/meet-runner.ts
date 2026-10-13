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

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--lang=zh-TW",
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
  session.event("error", failure);
  await shutdown(1);
});

async function main() {
  emit("status", { message: "開啟會議頁面", dir: session.dir });
  const ctxOpts = { userAgent: UA, locale: "zh-TW", viewport: { width: 1280, height: 800 }, permissions: ["microphone", "camera"] as string[] };
  if (config.meetUserDataDir) {
    context = await chromium.launchPersistentContext(config.meetUserDataDir, { channel: "chromium", headless: !config.meetHeaded, args: ARGS, ...ctxOpts });
  } else {
    const browser = await chromium.launch({ channel: "chromium", headless: !config.meetHeaded, args: ARGS });
    context = await browser.newContext(ctxOpts);
  }
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

  if (await page.locator('a[href*="accounts.google.com"], text=/登入|Sign in/i').first().isVisible().catch(() => false)) {
    const nameBox = page.locator('input[type="text"]').first();
    if (!(await nameBox.isVisible().catch(() => false))) {
      throw new Error("這場會議要求 Google 帳號登入，訪客進不去。要用登入過的 profile：設 MEET_USER_DATA_DIR");
    }
  }

  const nameInput = page.locator('input[type="text"]').first();
  await nameInput.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error("30 秒內沒看到填名字的欄位。會議代碼可能錯了，或 Meet 改版");
  });
  await nameInput.fill(botName);
  session.event("name", botName);

  for (const re of [/關閉麥克風|Turn off microphone/i, /關閉攝影機|Turn off camera/i]) {
    const b = page.getByRole("button", { name: re }).first();
    if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
  }

  const joinBtn = page.getByRole("button", { name: /要求加入|立即加入|Ask to join|Join now|加入/i }).first();
  await joinBtn.waitFor({ state: "visible", timeout: 30_000 });
  await joinBtn.click();
  session.event("asked-to-join");
  emit("status", { message: `已要求加入，等主持人放行「${botName}」` });

  const admitted = await waitInCall(config.meetAdmitTimeoutSec * 1000);
  if (stopping) return;
  if (!admitted) throw new Error("等主持人放行逾時，或被拒絕");
  session.event("admitted");
  await page.evaluate("window.__rec_start()");
  session.manifest.files.tracks.push("tracks/meet.webm");
  session.save();
  emit("status", { message: "已進入會議，開始錄音", recording: true });

  let aloneSince: number | null = null;
  while (!stopping) {
    await page.waitForTimeout(5000);
    if (await callEnded()) {
      session.event("call-ended");
      break;
    }
    const n = await participantCount();
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

async function dismissPopups() {
  for (const re of [/關閉|Dismiss|Got it|知道了|繼續|Continue/i]) {
    const b = page.getByRole("button", { name: re }).first();
    if (await b.isVisible({ timeout: 1500 }).catch(() => false)) await b.click().catch(() => {});
  }
}

async function waitInCall(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !stopping) {
    if (await inCall()) return true;
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 4000);
    if (/拒絕|denied|無法加入|can't join|couldn't join/i.test(body)) return false;
    await page.waitForTimeout(2000);
  }
  return false;
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
  return page
    .evaluate(
      `(() => {
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
