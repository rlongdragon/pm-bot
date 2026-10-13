import fs from "node:fs";
import path from "node:path";

/** 內容沒變就不寫，避免每次同步都產生 commit */
export function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

export function oneLine(s: string | null | undefined, max = 300): string {
  const t = (s ?? "").replace(/\r?\n+/g, " ").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}
