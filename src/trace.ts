/**
 * Langfuse 監控（v4，走 OTLP）。沒設 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY 就整個關掉，startTrace 回 null。
 * agent 回合 = 一條 trace（root 是 agent observation）：每次 Claude 回覆一個 generation（token 用量），
 * 每個工具呼叫一個 tool observation；轉逐字稿 = 一條 trace，每次打模型一個 generation。
 * 自己的 TracerProvider，不註冊成全域，不會吃到其他套件的 span。送出失敗只會 warn，不影響 bot。
 */
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { setLangfuseTracerProvider, startObservation, type LangfuseObservation } from "@langfuse/tracing";
import { config } from "./config.js";

export type Obs = LangfuseObservation;

let provider: NodeTracerProvider | null | undefined;

function init(): boolean {
  if (provider !== undefined) return !!provider;
  if (!config.langfusePublicKey || !config.langfuseSecretKey) return !!(provider = null);
  const processor = new LangfuseSpanProcessor({
    publicKey: config.langfusePublicKey,
    secretKey: config.langfuseSecretKey,
    baseUrl: config.langfuseBaseUrl,
    flushAt: 20,
    flushInterval: 2,
    timeout: 10,
  });
  provider = new NodeTracerProvider({ spanProcessors: [processor] });
  setLangfuseTracerProvider(provider);
  console.log(`[trace] Langfuse → ${config.langfuseBaseUrl}`);
  return true;
}

export interface TraceAttrs {
  userId?: string;
  sessionId?: string;
  tags?: string[];
}

/** trace 層級的屬性要寫在每個 span 上，Langfuse 才篩得到、算得到 */
export function setTraceAttrs(o: Obs, a: TraceAttrs & { name?: string }) {
  const s = o.otelSpan;
  if (a.name) s.setAttribute("langfuse.trace.name", a.name);
  if (a.userId) s.setAttribute("user.id", a.userId);
  if (a.sessionId) s.setAttribute("session.id", a.sessionId);
  if (a.tags?.length) s.setAttribute("langfuse.trace.tags", a.tags);
}

/** 開一條新 trace。root observation 的 input/output 就是 trace 的 input/output */
export function startTrace(
  name: string,
  a: TraceAttrs & { input?: unknown; metadata?: Record<string, unknown>; asType?: "agent" | "chain" | "span" },
): { root: Obs; attrs: TraceAttrs & { name: string } } | null {
  if (!init()) return null;
  try {
    const root = startObservation(name, { input: a.input, metadata: a.metadata }, { asType: (a.asType ?? "agent") as "agent" });
    const attrs = { name, userId: a.userId, sessionId: a.sessionId, tags: a.tags };
    setTraceAttrs(root, attrs);
    return { root, attrs };
  } catch (e) {
    console.warn(`[trace] start: ${(e as Error).message}`);
    return null;
  }
}

/** 在 trace 底下開子 observation，順手補上 trace 屬性 */
export function child(
  t: { root: Obs; attrs: TraceAttrs & { name: string } },
  name: string,
  asType: "generation" | "tool" | "span",
  attrs: Record<string, unknown>,
  startTime?: Date,
): Obs {
  const o = (t.root as any).startObservation(name, attrs, { asType, startTime }) as Obs;
  setTraceAttrs(o, t.attrs);
  return o;
}

/** 等佇列送完；回合結束和關機用。永遠不丟錯 */
export async function flushTraces(): Promise<void> {
  try {
    await provider?.forceFlush();
  } catch (e) {
    console.warn(`[trace] flush: ${(e as Error).message}`);
  }
}

export async function shutdownTraces(): Promise<void> {
  try {
    await provider?.shutdown();
  } catch {}
}

/** 太長的 input/output 砍掉，免得單一欄位太大 */
export function clip<T>(v: T, max = 60_000): T | string {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + `\n…（略 ${v.length - max} 字）` : v;
  if (v == null) return v;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + `…（略 ${s.length - max} 字）` : v;
  } catch {
    return String(v);
  }
}
