import type { AppError, CharsetSource, LlmTiming, ReaderFetch } from "../types.ts";

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
  // 不点破的话，一次重试过的调用看起来就是"模型慢了 1.5 秒"
  const retried = ts.filter((t) => t.attempts > 1).length;
  if (retried > 0) parts.push(`including ${retried} overload retries (backoff time, not model latency)`);
  return parts.join(", ") + ".";
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
