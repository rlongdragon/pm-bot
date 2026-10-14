// 讓 bot 的 Google 帳號登入一次，之後 /meet google 用這個 profile 進會議。
//
//   npm run meet:login
//
// 做法：在虛擬螢幕（Xvfb）上開一個有畫面的 Chromium（直接跑本體，不經 Playwright，不改 user agent），
// 用 Chrome 內建的 DevTools 畫面串流把畫面送到你的瀏覽器，滑鼠鍵盤和 Ctrl+V 貼上都轉回去。
// 腳本自己開 HTTP + WebSocket，只聽 127.0.0.1:LOGIN_PORT；bot 的 HTTP 伺服器會把 /login/* 轉過來，
// 所以網址是 <PUBLIC_BASE_URL>/login/<一次性代碼>。bot 沒開的話 ssh -L 8791:127.0.0.1:8791 也能用。
// 偵測到跳回 meet.google.com（登入完成）就關瀏覽器、存 profile。密碼只在你的瀏覽器 → 這裡 → Chrome，不落地。
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { chromium } from "playwright";
import { config } from "../src/config.js";

const dir = config.meetUserDataDir || path.resolve("data/meet-profile");
const port = config.loginPort;
const timeoutMin = Number(process.env.LOGIN_TIMEOUT_MIN ?? 30);
const token = crypto.randomBytes(18).toString("base64url");
const start = "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fmeet.google.com%2F&hl=zh-TW";
const W = 1280;
const H = 800;

/* ---------- Xvfb + Chromium ---------- */

function startXvfb(): Promise<{ proc: ChildProcess; display: string }> {
  return new Promise((resolve, reject) => {
    // -displayfd 3：Xvfb 自己挑一個沒用的 display 號碼，寫到 fd 3
    const proc = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
    let buf = "";
    proc.stdio[3]!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/(\d+)\n/);
      if (m) resolve({ proc, display: `:${m[1]}` });
    });
    proc.on("exit", (c) => reject(new Error(`Xvfb 起不來（exit ${c}）。要裝 xvfb`)));
    proc.on("error", reject);
  });
}

async function startChrome(display: string): Promise<{ proc: ChildProcess; cdpPort: number }> {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["DevToolsActivePort", "SingletonLock", "SingletonSocket", "SingletonCookie"]) fs.rmSync(path.join(dir, f), { force: true });
  const proc = spawn(
    chromium.executablePath(),
    [
      `--user-data-dir=${dir}`,
      "--remote-debugging-port=0",
      "--no-sandbox", // 以 root 跑一定要
      "--password-store=basic", // 跟 /meet 錄音時一樣，cookie 才解得開
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=TranslateUI",
      "--lang=zh-TW",
      `--window-size=${W},${H}`,
      "--window-position=0,0",
      start,
    ],
    { stdio: "ignore", env: { ...process.env, DISPLAY: display } },
  );
  const file = path.join(dir, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (proc.exitCode !== null) throw new Error(`Chromium 起不來（exit ${proc.exitCode}）`);
    if (fs.existsSync(file)) {
      const p = Number(fs.readFileSync(file, "utf8").split("\n")[0]);
      if (p) return { proc, cdpPort: p };
    }
  }
  throw new Error("20 秒內沒拿到 Chromium 的 DevTools 埠");
}

/* ---------- CDP ---------- */

interface Target {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

async function listPages(cdpPort: number): Promise<Target[]> {
  try {
    const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`, { signal: AbortSignal.timeout(3000) });
    return ((await r.json()) as Target[]).filter((t) => t.type === "page" && !t.url.startsWith("devtools://") && !t.url.startsWith("chrome://"));
  } catch {
    return [];
  }
}

class Cdp {
  private ws!: WebSocket;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: any) => void; err: (e: Error) => void }>();
  onEvent: (method: string, params: any) => void = () => {};
  onClose: () => void = () => {};
  constructor(public target: Target) {}
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.target.webSocketDebuggerUrl, { perMessageDeflate: false });
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
      this.ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.id) {
          const w = this.waiting.get(m.id);
          this.waiting.delete(m.id);
          if (w) m.error ? w.err(new Error(m.error.message)) : w.ok(m.result);
        } else if (m.method) this.onEvent(m.method, m.params);
      });
      this.ws.on("close", () => {
        for (const w of this.waiting.values()) w.err(new Error("cdp closed"));
        this.waiting.clear();
        this.onClose();
      });
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("cdp not open"));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, err) => this.waiting.set(id, { ok, err }));
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/* ---------- 瀏覽器端頁面 ---------- */

const PAGE = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PM bot 登入</title><style>
:root{color-scheme:dark;--bg:#111;--fg:#eee;--muted:#999;--bar:#1c1c1c;--accent:#4c8bf5}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Noto Sans TC",sans-serif;display:flex;flex-direction:column;height:100vh}
header{display:flex;gap:8px;align-items:center;padding:8px 12px;background:var(--bar);flex-wrap:wrap}
header .url{flex:1;min-width:160px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px}
button{background:#2a2a2a;color:var(--fg);border:1px solid #444;border-radius:6px;padding:6px 12px;cursor:pointer}button.primary{background:var(--accent);border-color:var(--accent)}
#view{flex:1;display:grid;place-items:center;overflow:hidden;background:#000;touch-action:none}
#screen{max-width:100%;max-height:100%;cursor:default;user-select:none;-webkit-user-drag:none;outline:none}
footer{display:flex;gap:8px;padding:8px 12px;background:var(--bar);align-items:center;flex-wrap:wrap}
footer input{flex:1;min-width:160px;background:#222;color:var(--fg);border:1px solid #444;border-radius:6px;padding:6px 8px}
#status{color:var(--muted);font-size:12px}
</style></head><body>
<header><strong>PM bot 登入</strong><span class="url" id="url">連線中…</span><button id="reload">重新整理</button><button id="done" class="primary">完成</button></header>
<div id="view"><img id="screen" alt="" tabindex="0" draggable="false"></div>
<footer><span id="status">在畫面上直接點、打字；Ctrl+V 會貼進遠端的欄位。</span><input id="paste" placeholder="手機用：在這裡貼上，按送出"><button id="send">送出</button></footer>
<script>
const TOKEN = location.pathname.split("/").filter(Boolean).pop();
const img = document.getElementById("screen"), status = document.getElementById("status"), urlEl = document.getElementById("url");
let W = ${W}, H = ${H}, ws;
function connect(){
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + location.pathname.replace(/\\/$/, "") + "/ws");
  ws.onopen = () => status.textContent = "已連線。在畫面上直接點、打字；Ctrl+V 會貼進遠端的欄位。";
  ws.onclose = () => status.textContent = "連線結束。";
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === "frame") { img.src = "data:image/jpeg;base64," + m.data; W = m.w; H = m.h; }
    else if (m.t === "url") urlEl.textContent = m.url;
    else if (m.t === "bye") { status.textContent = m.message; img.style.opacity = .4; }
  };
}
connect();
const send = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const mods = (e) => (e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
function pos(e){ const r = img.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * W / r.width), y: Math.round((e.clientY - r.top) * H / r.height) }; }
const btn = (e) => ["left","middle","right"][e.button] || "none";
img.addEventListener("mousedown", (e) => { e.preventDefault(); img.focus(); send({ t:"mouse", type:"mousePressed", ...pos(e), button: btn(e), clickCount: e.detail || 1, modifiers: mods(e) }); });
img.addEventListener("mouseup", (e) => { e.preventDefault(); send({ t:"mouse", type:"mouseReleased", ...pos(e), button: btn(e), clickCount: e.detail || 1, modifiers: mods(e) }); });
let lastMove = 0;
img.addEventListener("mousemove", (e) => { const now = Date.now(); if (now - lastMove < 30) return; lastMove = now; send({ t:"mouse", type:"mouseMoved", ...pos(e), button: e.buttons & 1 ? "left" : "none", modifiers: mods(e) }); });
img.addEventListener("wheel", (e) => { e.preventDefault(); send({ t:"mouse", type:"mouseWheel", ...pos(e), deltaX: Math.round(e.deltaX), deltaY: Math.round(e.deltaY), modifiers: mods(e) }); }, { passive: false });
img.addEventListener("contextmenu", (e) => e.preventDefault());
// 手機：點一下 = 左鍵
img.addEventListener("touchstart", (e) => { const t = e.touches[0]; const p = pos(t); send({ t:"mouse", type:"mousePressed", ...p, button:"left", clickCount:1 }); send({ t:"mouse", type:"mouseReleased", ...p, button:"left", clickCount:1 }); e.preventDefault(); }, { passive:false });
function key(e, type){
  if (document.activeElement && document.activeElement.id === "paste") return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return; // 交給 paste 事件
  e.preventDefault();
  const text = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey ? e.key : "";
  send({ t:"key", type, key: e.key, code: e.code, keyCode: e.keyCode, text, modifiers: mods(e) });
}
document.addEventListener("keydown", (e) => key(e, "keyDown"));
document.addEventListener("keyup", (e) => key(e, "keyUp"));
document.addEventListener("paste", (e) => {
  if (document.activeElement && document.activeElement.id === "paste") return;
  const text = e.clipboardData && e.clipboardData.getData("text");
  if (text) { e.preventDefault(); send({ t:"paste", text }); status.textContent = "已貼上 " + text.length + " 個字"; }
});
document.getElementById("send").onclick = () => { const b = document.getElementById("paste"); if (b.value) { send({ t:"paste", text: b.value }); b.value = ""; img.focus(); } };
document.getElementById("reload").onclick = () => send({ t:"reload" });
document.getElementById("done").onclick = () => { if (confirm("結束登入並關閉瀏覽器？")) send({ t:"done" }); };
</script></body></html>`;

/* ---------- 主流程 ---------- */

let finished = false;
const clients = new Set<WebSocket>();
const broadcast = (o: unknown) => {
  const s = JSON.stringify(o);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};

const xvfb = await startXvfb();
const chrome = await startChrome(xvfb.display);
let cdp: Cdp | null = null;

async function attach(t: Target) {
  cdp?.close();
  const c = new Cdp(t);
  await c.connect();
  c.onEvent = (method, params) => {
    if (method === "Page.screencastFrame") {
      broadcast({ t: "frame", data: params.data, w: params.metadata.deviceWidth, h: params.metadata.deviceHeight });
      c.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
    } else if (method === "Page.frameNavigated" && !params.frame.parentId) {
      broadcast({ t: "url", url: params.frame.url });
    }
  };
  c.onClose = () => {
    if (cdp === c) cdp = null;
  };
  await c.send("Page.enable");
  await c.send("Page.bringToFront").catch(() => {});
  await c.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  cdp = c;
  broadcast({ t: "url", url: t.url });
}

/** 使用者的操作 → CDP */
async function handle(m: any) {
  if (!cdp) return;
  if (m.t === "mouse") {
    await cdp.send("Input.dispatchMouseEvent", {
      type: m.type,
      x: m.x,
      y: m.y,
      button: m.button ?? "none",
      clickCount: m.clickCount ?? 0,
      modifiers: m.modifiers ?? 0,
      deltaX: m.deltaX,
      deltaY: m.deltaY,
    });
  } else if (m.t === "key") {
    const base = { key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, modifiers: m.modifiers ?? 0 };
    if (m.type === "keyDown") {
      if (m.text) await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...base, text: m.text, unmodifiedText: m.text });
      else await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    } else await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  } else if (m.t === "paste") {
    await cdp.send("Input.insertText", { text: String(m.text).slice(0, 2000) });
  } else if (m.t === "reload") {
    await cdp.send("Page.reload");
  } else if (m.t === "done") {
    await finish(false, "你按了完成，瀏覽器已關閉");
  }
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", "http://local");
  if (req.method === "GET" && u.pathname === `/login/${token}`) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex" });
    res.end(PAGE);
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("沒有這個登入頁，代碼不對或已結束");
});
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
server.on("upgrade", (req, socket, head) => {
  if (new URL(req.url ?? "/", "http://local").pathname !== `/login/${token}/ws`) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    if (cdp) ws.send(JSON.stringify({ t: "url", url: cdp.target.url }));
    ws.on("message", (d) => handle(JSON.parse(d.toString())).catch((e) => console.error("[login]", (e as Error).message)));
    ws.on("close", () => clients.delete(ws));
  });
});
await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));

const pages = await listPages(chrome.cdpPort);
if (!pages.length) throw new Error("Chromium 沒有頁面");
await attach(pages[0]);

console.log(`profile: ${dir}`);
console.log(`登入頁：${config.publicBaseUrl ? `${config.publicBaseUrl}/login/${token}` : `http://127.0.0.1:${port}/login/${token}`}`);
if (config.publicBaseUrl) console.log(`（bot 沒在跑的話：ssh -L ${port}:127.0.0.1:${port} 之後開 http://127.0.0.1:${port}/login/${token}）`);
console.log(`等你登入，最多 ${timeoutMin} 分鐘…`);

async function finish(ok: boolean, message: string) {
  if (finished) return;
  finished = true;
  broadcast({ t: "bye", message });
  await new Promise((r) => setTimeout(r, 300));
  for (const c of clients) c.close();
  cdp?.close();
  if (chrome.proc.exitCode === null) {
    chrome.proc.kill("SIGTERM");
    await Promise.race([new Promise((r) => chrome.proc.once("exit", r)), new Promise((r) => setTimeout(r, 10_000))]);
    if (chrome.proc.exitCode === null) chrome.proc.kill("SIGKILL");
  }
  xvfb.proc.kill("SIGTERM");
  server.close();
  console.log(`${ok ? "✅" : "⏹"} ${message}`);
  if (ok) console.log(`之後 /meet google 會用這個 profile。要換帳號就刪掉 ${dir} 再跑一次。`);
  process.exit(ok ? 0 : 1);
}

const deadline = Date.now() + timeoutMin * 60_000;
while (!finished) {
  await new Promise((r) => setTimeout(r, 3000));
  if (chrome.proc.exitCode !== null) {
    await finish(false, "瀏覽器被關掉了，沒偵測到登入");
    break;
  }
  const ps = await listPages(chrome.cdpPort);
  // 使用者點到新分頁、或 Google 開了新視窗：跟著切過去
  if (ps.length && (!cdp || !ps.some((p) => p.id === cdp!.target.id))) await attach(ps[ps.length - 1]).catch(() => {});
  const meet = ps.find((p) => /^https:\/\/meet\.google\.com\//.test(p.url));
  if (meet && !ps.some((p) => /accounts\.google\.com\/(v3\/)?signin/.test(p.url))) {
    await new Promise((r) => setTimeout(r, 5000)); // 讓 cookie 寫進磁碟
    await finish(true, `登入成功，已回到 Meet（${meet.title}）`);
    break;
  }
  if (Date.now() > deadline) await finish(false, "逾時，沒偵測到登入");
}
