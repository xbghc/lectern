import type { AppError, CharsetSource, LlmProviderStats, LlmTiming, LlmUsage, ReaderFetch } from "../types.ts";
import { CUSTOM_PROVIDER, findProvider } from "./providers.ts";

/**
 * 诊断日志里那几行摘要的文案。
 *
 * 放在 lib 而不是设置页里，是因为"怎么概括一堆耗时"是有判断的（见 median），
 * 而设置页那个模块一 import 就往 DOM 上挂监听，测不了。
 */

/** 各条路径在界面上的名字。 */
export const SOURCE_LABEL: Record<LlmTiming["source"], string> = {
  translate: "Text translation",
  test: "Test connection",
  assist: "Review assistant",
  ask: "Popover follow-up",
  articleReview: "Article review",
  articleFilter: "Article classification",
  blacklistSuggestion: "Blocklist suggestions",
  ruleChat: "List assistant",
};

/** 毫秒折成人看的。秒以上给一位小数——1.4s 比 1437ms 更容易一眼比较。 */
export const secs = (ms: number): string => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** 端到端输出速度（tokens/s）。缺少输出或耗时无效时返回 null。 */
export function tokensPerSecond(outputTokens: number, totalMs: number): number | null {
  if (!Number.isFinite(outputTokens) || !Number.isFinite(totalMs) || outputTokens <= 0 || totalMs <= 0) return null;
  return (outputTokens * 1000) / totalMs;
}

/** 速度折成人看的写法，保留一位小数。 */
export const formatTokPerSec = (tps: number | null): string => (tps === null ? "—" : `${tps.toFixed(1)} tok/s`);

/**
 * 中位数。
 *
 * 用它不用均值：一次 60 秒的超时能把二十次调用的均值整个拖走，
 * 而"偶尔有点慢"要看的恰恰是平时多快、最坏多坏——均值两头都答不上。
 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

/**
 * 耗时那一行。几个数字各回答一个问题：
 * 平时多快（中位）、最坏多坏（最慢那次是谁）、真正让人等的那一段多久（看到译文）、
 * 以及慢是不是自己退避出来的（重试次数）。
 */
export function timingLine(ts: LlmTiming[]): string {
  if (ts.length === 0) return "No request timings recorded yet.";
  const slowest = ts.reduce((a, b) => (b.totalMs > a.totalMs ? b : a));
  const parts = [
    `Recent calls: ${ts.length}; median ${secs(median(ts.map((t) => t.totalMs)))}`,
    `slowest ${secs(slowest.totalMs)} (${SOURCE_LABEL[slowest.source]}${slowest.failedKind ? ", " + slowest.failedKind : ""})`,
  ];
  // 划词真正让人等的是"译文什么时候出现"，不是整条流跑完——后面的生词讲解晚到没人在意
  const shown = ts.map((t) => t.firstFieldMs).filter((v): v is number => v !== null);
  if (shown.length > 0) parts.push(`median time to visible translation ${secs(median(shown))}`);
  const speeds = ts.map((t) => tokensPerSecond(t.outputTokens, t.totalMs)).filter((v): v is number => v !== null);
  if (speeds.length > 0) parts.push(`median output speed ${formatTokPerSec(median(speeds))}`);
  // 不点破的话，一次重试过的调用看起来就是"模型慢了 1.5 秒"
  const retried = ts.filter((t) => t.attempts > 1).length;
  if (retried > 0) parts.push(`including ${retried} overload retries (backoff time, not model latency)`);
  return parts.join(", ") + ".";
}

/** 服务商 id 折成界面上可读的名字。 */
export function providerName(providerId: string): string {
  const id = providerId.trim();
  if (!id) return "";
  if (id === CUSTOM_PROVIDER) return "Custom endpoint";
  return findProvider(id)?.name ?? id;
}

export interface ProviderSpeedRow {
  provider: string;
  providerLabel: string;
  model: string;
  label: string;
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  timedCalls: number;
  timedOutputTokens: number;
  outputMs: number;
  tokensPerSecond: number | null;
  lastTs: number | null;
}

export interface ProviderSpeedSummary {
  totalRequests: number;
  totalOutputTokens: number;
  overallTokensPerSecond: number | null;
  rows: ProviderSpeedRow[];
}

function safeNonNeg(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 汇总各提供商与模型的累计 token 速度。
 *
 * 优先取 `llmUsage.providers` 的持久化累计值（跨提供商切换和清空诊断日志仍保留历史对比）；
 * 若某模型尚无持久化分组记录（如升级前留下的 `llmTiming` 或仅跑过「测试连接」），则用 `timings` 补齐。
 */
export function summarizeProviderSpeed(
  usage?: Partial<LlmUsage> | null,
  timings: readonly LlmTiming[] = [],
): ProviderSpeedSummary {
  const buckets = new Map<string, LlmProviderStats>();
  const modelsInUsage = new Set<string>();

  if (usage?.providers && typeof usage.providers === "object") {
    for (const raw of Object.values(usage.providers)) {
      if (!raw || typeof raw !== "object") continue;
      const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
      const model = typeof raw.model === "string" ? raw.model.trim() : "";
      if (!provider && !model) continue;
      const requests = Math.floor(safeNonNeg(raw.requests));
      if (requests === 0) continue;
      const key = `${provider}::${model}`;
      const prev = buckets.get(key);
      const errors = Math.floor(safeNonNeg(raw.errors));
      const inputTokens = Math.floor(safeNonNeg(raw.inputTokens));
      const outputTokens = Math.floor(safeNonNeg(raw.outputTokens));
      const timedCalls = Math.floor(safeNonNeg(raw.timedCalls));
      const timedOutputTokens = Math.floor(safeNonNeg(raw.timedOutputTokens));
      const outputMs = safeNonNeg(raw.outputMs);
      const lastTs = typeof raw.lastTs === "number" && Number.isFinite(raw.lastTs) ? raw.lastTs : null;
      if (model) modelsInUsage.add(model);
      buckets.set(key, {
        provider,
        model,
        requests: (prev?.requests ?? 0) + requests,
        errors: (prev?.errors ?? 0) + errors,
        inputTokens: (prev?.inputTokens ?? 0) + inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + outputTokens,
        timedCalls: (prev?.timedCalls ?? 0) + timedCalls,
        timedOutputTokens: (prev?.timedOutputTokens ?? 0) + timedOutputTokens,
        outputMs: (prev?.outputMs ?? 0) + outputMs,
        lastTs: lastTs !== null && prev?.lastTs != null ? Math.max(prev.lastTs, lastTs) : (lastTs ?? prev?.lastTs ?? null),
      });
    }
  }

  const persistedKeys = new Set(buckets.keys());
  for (const t of timings) {
    if (!t || typeof t !== "object") continue;
    const provider = typeof t.provider === "string" ? t.provider.trim() : "";
    const model = typeof t.model === "string" ? t.model.trim() : "";
    if (!provider && !model) continue;
    const key = `${provider}::${model}`;
    if (persistedKeys.has(key) || (!provider && modelsInUsage.has(model))) continue;
    const prev = buckets.get(key);
    const out = Math.floor(safeNonNeg(t.outputTokens));
    const ms = safeNonNeg(t.totalMs);
    const timed = out > 0 && ms > 0;
    const ts = typeof t.ts === "number" && Number.isFinite(t.ts) ? t.ts : null;
    buckets.set(key, {
      provider,
      model,
      requests: (prev?.requests ?? 0) + 1,
      errors: (prev?.errors ?? 0) + (t.failedKind ? 1 : 0),
      inputTokens: (prev?.inputTokens ?? 0) + Math.floor(safeNonNeg(t.inputTokens)),
      outputTokens: (prev?.outputTokens ?? 0) + out,
      timedCalls: (prev?.timedCalls ?? 0) + (timed ? 1 : 0),
      timedOutputTokens: (prev?.timedOutputTokens ?? 0) + (timed ? out : 0),
      outputMs: (prev?.outputMs ?? 0) + (timed ? ms : 0),
      lastTs: ts !== null && prev?.lastTs != null ? Math.max(prev.lastTs, ts) : (ts ?? prev?.lastTs ?? null),
    });
  }

  const rows: ProviderSpeedRow[] = [...buckets.values()].map((b) => {
    const pName = providerName(b.provider);
    const providerLabel = pName || "Unknown provider";
    const label = pName && b.model ? `${pName} · ${b.model}` : b.model || providerLabel;
    return {
      ...b,
      providerLabel,
      label,
      tokensPerSecond: tokensPerSecond(b.timedOutputTokens, b.outputMs),
    };
  });

  rows.sort((a, b) => {
    if (a.tokensPerSecond !== null && b.tokensPerSecond !== null && b.tokensPerSecond !== a.tokensPerSecond) {
      return b.tokensPerSecond - a.tokensPerSecond;
    }
    if (a.tokensPerSecond !== null && b.tokensPerSecond === null) return -1;
    if (a.tokensPerSecond === null && b.tokensPerSecond !== null) return 1;
    return b.requests - a.requests || (b.lastTs ?? 0) - (a.lastTs ?? 0) || a.label.localeCompare(b.label);
  });

  const totalRequests = rows.reduce((s, r) => s + r.requests, 0);
  const totalOutputTokens = rows.reduce((s, r) => s + r.outputTokens, 0);
  const totalTimedTokens = rows.reduce((s, r) => s + r.timedOutputTokens, 0);
  const totalOutputMs = rows.reduce((s, r) => s + r.outputMs, 0);

  return {
    totalRequests,
    totalOutputTokens,
    overallTokensPerSecond: tokensPerSecond(totalTimedTokens, totalOutputMs),
    rows,
  };
}

/** 诊断区里提供商速度面板的标题摘要。 */
export function providerSpeedLine(summary: ProviderSpeedSummary): string {
  if (summary.rows.length === 0) return "No provider token speed recorded yet.";
  const count = summary.rows.length;
  const modelsLabel = count === 1 ? "1 provider/model" : `${count} providers/models`;
  const overall = summary.overallTokensPerSecond !== null
    ? `overall ${formatTokPerSec(summary.overallTokensPerSecond)}`
    : "no output tokens timed yet";
  const parts = [
    `Provider token speed: ${modelsLabel}; ${overall} (${summary.totalOutputTokens} output tokens, ${summary.totalRequests} requests)`,
  ];
  const fastest = summary.rows[0];
  if (summary.rows.length > 1 && fastest && fastest.tokensPerSecond !== null) {
    parts.push(`fastest: ${fastest.label} (${formatTokPerSec(fastest.tokensPerSecond)})`);
  }
  return parts.join("; ");
}

/** 编码是谁定的，给人看的说法。 */
const FROM_LABEL: Record<CharsetSource, string> = {
  header: "Response header",
  meta: "Page declaration",
  default: "Fallback",
};

/**
 * 阅读器抓取与运行时错误那一行。只有 App 会有记录，扩展里这两样恒为空。
 *
 * 挑出来说的是"不对劲的次数"而不是总数：一切正常时这行不该占人注意力，
 * 一旦有掉字节的就得显眼——那正是编码挑错了的样子。
 */
export function appLogLine(fetches: ReaderFetch[], errors: AppError[]): string {
  if (fetches.length === 0 && errors.length === 0) return "No fetch or runtime error logs yet. These are recorded only in the Android app.";
  const parts: string[] = [];
  const last = fetches.at(-1);
  if (last) {
    const failed = fetches.filter((f) => f.error !== null).length;
    const garbled = fetches.filter((f) => (f.replacementChars ?? 0) > 0).length;
    const bad = [failed > 0 ? `failed: ${failed}` : "", garbled > 0 ? `decoding errors: ${garbled}` : ""].filter(Boolean);
    const how = last.charset ? `; last decoded as ${last.charset} (${FROM_LABEL[last.charsetFrom ?? "default"]})` : "";
    parts.push(`Fetches: ${fetches.length}${bad.length > 0 ? ", " + bad.join(", ") : "; all successful"}${how}`);
  }
  parts.push(errors.length > 0 ? `Runtime errors: ${errors.length}` : "No unhandled runtime errors");
  return parts.join("; ") + ".";
}
