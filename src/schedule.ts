import crypto from "node:crypto";
import * as store from "./store.js";

/**
 * 排程：一次性或週期性，到時間 bot 貼提醒（remind）或用唯讀模式跑 agent 把結果貼出來（agent）。
 * 存在 state.json 的 project.schedules。時間一律用伺服器時區（跟每日巡檢一樣）。
 */
export interface Schedule {
  /** 4 碼，專案內唯一 */
  id: string;
  kind: "remind" | "agent";
  /** remind：要貼的話；agent：要 agent 做的事 */
  text: string;
  /** 一次性：ISO 時間 */
  at?: string;
  /** 週期性：5 欄 cron（分 時 日 月 週） */
  cron?: string;
  /** 建立時寫的時間（給人看），例如「每週一 9:00」 */
  when: string;
  channelId: string;
  createdBy: string;
  createdAt: string;
  nextAt: string;
  lastRunAt?: string;
  lastError?: string;
  /** 暫停中不觸發 */
  paused?: boolean;
}

/* ---------- cron ---------- */

interface Cron {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
  domAny: boolean;
  dowAny: boolean;
}

function field(s: string, lo: number, hi: number, name: string): Set<number> {
  const out = new Set<number>();
  for (const part of s.split(",")) {
    const m = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`cron 的${name}欄看不懂：${part}`);
    const step = m[4] ? +m[4] : 1;
    const a = m[1] === "*" ? lo : +m[2];
    const b = m[1] === "*" ? hi : m[3] ? +m[3] : m[4] ? hi : a;
    if (step < 1 || a < lo || b > hi || a > b) throw new Error(`cron 的${name}欄超出範圍（${lo}-${hi}）：${part}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error(`cron 要 5 欄（分 時 日 月 週），收到 ${f.length} 欄：${expr}`);
  const dow = field(f[4], 0, 7, "週");
  if (dow.delete(7)) dow.add(0);
  return {
    min: field(f[0], 0, 59, "分"),
    hour: field(f[1], 0, 23, "時"),
    dom: field(f[2], 1, 31, "日"),
    mon: field(f[3], 1, 12, "月"),
    dow,
    domAny: f[2] === "*",
    dowAny: f[4] === "*",
  };
}

/** after 之後（不含）第一個符合的分鐘。日跟週都有限制時是「或」，跟標準 cron 一樣 */
export function nextCron(expr: string | Cron, after: Date): Date {
  const c = typeof expr === "string" ? parseCron(expr) : expr;
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 86400_000;
  while (d.getTime() < limit) {
    if (!c.mon.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domOk = c.dom.has(d.getDate());
    const dowOk = c.dow.has(d.getDay());
    const dayOk = c.domAny && c.dowAny ? true : c.domAny ? dowOk : c.dowAny ? domOk : domOk || dowOk;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.min.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }
    return d;
  }
  throw new Error(`cron 五年內都不會觸發：${typeof expr === "string" ? expr : "?"}`);
}

/* ---------- 時間解析 ---------- */

const WEEK: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

function hm(s: string | undefined): [number, number] {
  if (!s) return [9, 0];
  const m = s.match(/^(\d{1,2})(?:[:：](\d{2}))?$/);
  if (!m || +m[1] > 23 || +(m[2] ?? 0) > 59) throw new Error(`時間看不懂：${s}`);
  return [+m[1], +(m[2] ?? 0)];
}

export type When = { at: Date } | { cron: string };

/**
 * 支援：
 *   一次性：2026-11-07 15:00、11/7 15:00、15:00（今天，過了就明天）、明天 9:00、後天 9:00、+30m / +2h / +1d
 *   週期性：每天 9:00、平日 9:00、每週一 9:00、每週一三五 9:00、每月 1 號 9:00、或 5 欄 cron
 * 沒寫時間的週期性預設 9:00。
 */
export function parseScheduleWhen(input: string, now = new Date()): When {
  const s = input.trim().replace(/／/g, "/").replace(/－/g, "-").replace(/：/g, ":").replace(/\s+/g, " ");
  if (!s) throw new Error("沒給時間");

  if (/^[\d*/,\-]+( [\d*/,\-]+){4}$/.test(s)) {
    parseCron(s);
    return { cron: s };
  }

  let m = s.match(/^\+(\d+)\s*(m|min|分鐘?|h|hr|小時|d|天)$/i);
  if (m) {
    const n = +m[1];
    const unit = /^(m|min|分)/i.test(m[2]) ? 60_000 : /^(h|hr|小時)/i.test(m[2]) ? 3600_000 : 86400_000;
    return { at: new Date(now.getTime() + n * unit) };
  }

  m = s.match(/^(?:每天|每日) ?(\d{1,2}(?::\d{2})?)?$/);
  if (m) {
    const [h, mi] = hm(m[1]);
    return { cron: `${mi} ${h} * * *` };
  }
  m = s.match(/^(?:平日|工作日|週間|每個?工作天) ?(\d{1,2}(?::\d{2})?)?$/);
  if (m) {
    const [h, mi] = hm(m[1]);
    return { cron: `${mi} ${h} * * 1-5` };
  }
  m = s.match(/^每(?:週|周|星期|禮拜)([一二三四五六日天、,]+) ?(\d{1,2}(?::\d{2})?)?$/);
  if (m) {
    const days = [...new Set([...m[1]].filter((c) => c in WEEK).map((c) => WEEK[c]))].sort();
    const [h, mi] = hm(m[2]);
    return { cron: `${mi} ${h} * * ${days.join(",")}` };
  }
  m = s.match(/^每月 ?(\d{1,2}) ?[號日] ?(\d{1,2}(?::\d{2})?)?$/);
  if (m) {
    const [h, mi] = hm(m[2]);
    if (+m[1] < 1 || +m[1] > 31) throw new Error(`日期超出範圍：${m[1]}`);
    return { cron: `${mi} ${h} ${+m[1]} * *` };
  }

  m = s.match(/^(今天|明天|後天) ?(\d{1,2}(?::\d{2})?)?$/);
  if (m) {
    const [h, mi] = hm(m[2]);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ["今天", "明天", "後天"].indexOf(m[1]), h, mi);
    return { at: d };
  }
  m = s.match(/^(\d{1,2}:\d{2})$/);
  if (m) {
    const [h, mi] = hm(m[1]);
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, mi);
    if (d <= now) d.setDate(d.getDate() + 1);
    return { at: d };
  }
  m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}(?::\d{2})?))?$/);
  if (m) {
    const [h, mi] = hm(m[4]);
    return { at: new Date(+m[1], +m[2] - 1, +m[3], h, mi) };
  }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}(?::\d{2})?))?$/);
  if (m) {
    const [h, mi] = hm(m[3]);
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2], h, mi);
    if (d <= now) d.setFullYear(d.getFullYear() + 1); // 沒寫年、已經過了 = 明年
    return { at: d };
  }
  throw new Error(
    `時間看不懂：${input}\n可以寫 \`2026-11-07 15:00\`、\`11/7 15:00\`、\`明天 9:00\`、\`+30m\`、\`每天 9:00\`、\`平日 9:00\`、\`每週一 9:00\`、\`每月 1 號 9:00\`，或 5 欄 cron`,
  );
}

/* ---------- 顯示 ---------- */

export function fmtTime(d: Date | string): string {
  return new Date(d).toLocaleString("zh-TW", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short", hour: "2-digit", minute: "2-digit" });
}

/** 短格式，給 autocomplete 這種只有 100 字的地方：11/09(一) 09:00 */
export function fmtShort(d: Date | string): string {
  const x = new Date(d);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(x.getMonth() + 1)}/${p2(x.getDate())}(${"日一二三四五六"[x.getDay()]}) ${p2(x.getHours())}:${p2(x.getMinutes())}`;
}

/** when 的預覽：「下次 11/09(一) 09:00」，看不懂就丟錯 */
export function previewWhen(when: string, now = new Date()): string {
  const w = parseScheduleWhen(when, now);
  if ("at" in w) {
    if (isNaN(w.at.getTime())) throw new Error("日期不存在");
    if (w.at <= now) throw new Error("已經過了");
    return `一次 ${fmtShort(w.at)}`;
  }
  return `🔁 下次 ${fmtShort(nextCron(w.cron, now))}`;
}

export function describe(s: Schedule): string {
  const icon = s.kind === "remind" ? "⏰" : "🤖";
  const rep = s.cron ? `🔁 ${s.when}（\`${s.cron}\`）` : "一次";
  const next = s.paused ? "⏸️ **暫停中**" : `下次 **${fmtTime(s.nextAt)}**`;
  const err = s.lastError ? `\n　⚠️ 上次失敗：${s.lastError.slice(0, 120)}` : "";
  return `${icon} \`${s.id}\` ${next}　${rep}　by <@${s.createdBy}>\n　${s.text.replace(/\n/g, " ").slice(0, 150)}${err}`;
}

/* ---------- 存取 ---------- */

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const MAX_PER_PROJECT = 30;

/** 時間字串 → 排程的時間欄位 */
function timing(when: string, now: Date): Pick<Schedule, "at" | "cron" | "when" | "nextAt"> {
  const w = parseScheduleWhen(when, now);
  if ("at" in w) {
    if (isNaN(w.at.getTime())) throw new Error(`日期不存在：${when}`);
    if (w.at.getTime() <= now.getTime()) throw new Error(`${fmtTime(w.at)} 已經過了`);
    return { at: w.at.toISOString(), cron: undefined, when: when.trim(), nextAt: w.at.toISOString() };
  }
  return { at: undefined, cron: w.cron, when: when.trim(), nextAt: nextCron(w.cron, now).toISOString() };
}

export function get(p: store.Project, id: string): Schedule | undefined {
  return p.schedules?.find((s) => s.id === id.trim().toLowerCase());
}
function mustGet(p: store.Project, id: string): Schedule {
  const s = get(p, id);
  if (!s) throw new Error(`找不到排程 \`${id}\`，\`/schedule list\` 看 id`);
  return s;
}

/** 改時間、內容或種類；沒給的欄位不動 */
export function edit(p: store.Project, id: string, o: { when?: string; text?: string; kind?: Schedule["kind"] }, now = new Date()): Schedule {
  const s = mustGet(p, id);
  const text = o.text?.trim();
  if (o.text !== undefined && !text) throw new Error("內容是空的");
  if (text && text.length > 1500) throw new Error("內容太長（上限 1500 字）");
  if (o.when) Object.assign(s, timing(o.when, now), { lastError: undefined });
  if (text) s.text = text;
  if (o.kind) s.kind = o.kind;
  store.save();
  return s;
}

export function pause(p: store.Project, id: string): Schedule {
  const s = mustGet(p, id);
  s.paused = true;
  store.save();
  return s;
}

/** 週期性從現在重算下一次；一次性的時間已經過了就不能恢復 */
export function resume(p: store.Project, id: string, now = new Date()): Schedule {
  const s = mustGet(p, id);
  if (s.cron) s.nextAt = nextCron(s.cron, now).toISOString();
  else if (Date.parse(s.nextAt) <= now.getTime()) throw new Error(`原定 ${fmtTime(s.nextAt)} 已經過了，用 \`/schedule edit\` 改時間`);
  s.paused = undefined;
  store.save();
  return s;
}

export function list(p: store.Project): Schedule[] {
  return [...(p.schedules ?? [])].sort((a, b) => a.nextAt.localeCompare(b.nextAt));
}

export function add(
  p: store.Project,
  o: { kind: Schedule["kind"]; when: string; text: string; channelId: string; createdBy: string },
  now = new Date(),
): Schedule {
  const text = o.text.trim();
  if (!text) throw new Error("內容是空的");
  if (text.length > 1500) throw new Error("內容太長（上限 1500 字）");
  p.schedules ??= [];
  if (p.schedules.length >= MAX_PER_PROJECT) throw new Error(`一個專案最多 ${MAX_PER_PROJECT} 個排程，先刪掉用不到的`);
  const t = timing(o.when, now);
  let id: string;
  do id = Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  while (p.schedules.some((s) => s.id === id));
  const s: Schedule = {
    id,
    kind: o.kind,
    text,
    ...t,
    channelId: o.channelId,
    createdBy: o.createdBy,
    createdAt: now.toISOString(),
  };
  p.schedules.push(s);
  store.save();
  return s;
}

export function remove(p: store.Project, id: string): Schedule {
  const s = mustGet(p, id);
  p.schedules = p.schedules!.filter((x) => x !== s);
  store.save();
  return s;
}

/**
 * 取出到期的排程，並先把狀態往前推（一次性刪掉、週期性算下一次）再存檔，
 * 這樣跑到一半當掉也不會重複觸發。錯過的週期不補跑，只跑一次。
 */
export function takeDue(p: store.Project, now = new Date()): Schedule[] {
  const due = (p.schedules ?? []).filter((s) => !s.paused && Date.parse(s.nextAt) <= now.getTime());
  if (!due.length) return [];
  const fired = due.map((s) => ({ ...s }));
  for (const s of due) {
    s.lastRunAt = now.toISOString();
    if (s.cron) {
      try {
        s.nextAt = nextCron(s.cron, now).toISOString();
      } catch (e) {
        s.lastError = (e as Error).message;
        s.nextAt = new Date(now.getTime() + 365 * 86400_000).toISOString();
      }
    }
  }
  p.schedules = p.schedules!.filter((s) => s.cron || !due.includes(s));
  store.save();
  return fired;
}

export function setError(p: store.Project, id: string, err: string | undefined) {
  const s = p.schedules?.find((x) => x.id === id);
  if (!s) return;
  s.lastError = err;
  store.save();
}
