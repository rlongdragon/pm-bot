/**
 * bot 自己的小 HTTP 伺服器，只接 Notion OAuth 的 callback 和 /healthz，其他一律 404。
 * HTTP_HOST=0.0.0.0 直接對外；前面有反向代理掛在 /pm-bot 底下時，前綴有沒有被拿掉都接受。
 */
import http from "node:http";
import { config } from "./config.js";

export type CallbackHandler = (q: URLSearchParams) => Promise<{ ok: boolean; message: string }>;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(ok: boolean, message: string) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PM bot 授權</title><style>
:root{color-scheme:light dark;--bg:#f6f6f4;--fg:#1f1f1f;--card:#fff;--muted:#6b6b6b}
@media (prefers-color-scheme:dark){:root{--bg:#191919;--fg:#e8e8e8;--card:#242424;--muted:#9b9b9b}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Noto Sans TC",sans-serif;padding:16px;box-sizing:border-box}
main{background:var(--card);border-radius:12px;padding:28px 32px;max-width:420px;box-shadow:0 1px 3px #0002}
h1{font-size:20px;margin:0 0 8px}p{margin:0;color:var(--muted)}
</style></head><body><main><h1>${ok ? "✅ 授權完成" : "⚠️ 授權沒有成功"}</h1><p>${esc(message)}</p></main></body></html>`;
}

export function startHttp(onNotion: CallbackHandler): http.Server | null {
  if (!config.httpPort) return null;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://local");
    const p = u.pathname.replace(/^\/pm-bot(?=\/)/, "");
    if (req.method === "GET" && p === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
      return;
    }
    if (req.method === "GET" && p === "/notion/callback") {
      let r: { ok: boolean; message: string };
      try {
        r = await onNotion(u.searchParams);
      } catch (e) {
        r = { ok: false, message: (e as Error).message };
      }
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(page(r.ok, r.message));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });
  server.on("error", (e) => console.warn(`[http] ${(e as Error).message}`));
  server.listen(config.httpPort, config.httpHost, () => console.log(`[http] listening ${config.httpHost}:${config.httpPort}`));
  return server;
}
