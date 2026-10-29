/**
 * 界面埋点：首页上每个能点的东西各被用了多少次。
 *
 * 为什么要有——改界面全凭感觉。搜索框占着一整行是不是值得、「黑名单建议」有没有人点过，
 * 以前只能猜。这里只记**次数**，按天分桶：不记点的是哪篇文章、搜了什么词、什么时刻点的，
 * 所以这份东西里没有阅读内容，只有「哪个按钮、哪天、几次」。
 *
 * 事件是一张写死的表而不是随手起的字符串，两个原因：
 * 一，要回答「哪些极少用到」就得知道**全集**——从没被点过的按钮在计数里根本不出现，
 * 只有拿这张表去对，才列得出那些零；二，表外的名字一律不收，存下来的东西有上限。
 *
 * 纯函数，不碰 storage；落盘在 background/uiUsage.ts，按天分桶是为了改完界面之后
 * 能比「改之前的三十天」和「改之后的七天」，只留一个总数的话这件事做不了。
 *
 * 启用了设备同步的话，计数还会传到同步服务器上（见 background/uiUsage.ts 的 uploadUiUsage），
 * 在那边跨设备、跨用户汇总；服务器的报表（server/src/usage.ts）用的也是下面这张表，
 * 所以这个文件不能引用任何浏览器才有的东西。
 */

/** 表里的顺序就是报表里同次数时的顺序：按页面从上到下、从左到右排。 */
export const UI_EVENTS = {
  "page.open": "Dashboard · Open",
  "nav.articles": "Navigation · Articles",
  "nav.review": "Navigation · Review",
  "nav.words": "Navigation · Vocabulary",
  "nav.stats": "Navigation · Statistics",
  "nav.books": "Navigation · Bookshelf",
  "nav.options": "Navigation · Settings",

  "articles.filter.all": "Articles · Filter · All",
  "articles.filter.reading": "Articles · Filter · Reading",
  "articles.filter.done": "Articles · Filter · Done",
  "articles.search.open": "Articles · Search · Open",
  "articles.search.query": "Articles · Search · Search",
  "articles.add": "Articles · Add",
  "articles.view.list": "Articles · View · List",
  "articles.view.grid": "Articles · View · Grid",
  "articles.menu": "Articles · Menu",
  "stats.history": "Statistics · History",
  "stats.range": "Statistics · Range",
  "stats.period": "Statistics · Period",
  "chat.open": "Vocabulary chat · Open",
  "chat.word": "Vocabulary chat · Word",
  "chat.send": "Vocabulary chat · Send",
  "chat.words": "Vocabulary chat · Vocabulary",
  "chat.new": "Vocabulary chat · New",
  "chat.history": "Vocabulary chat · History",
  "chat.delete": "Vocabulary chat · Delete",
  "chat.stop": "Vocabulary chat · Stop",
  "reader.size": "Reader · Text size",
  "reader.theme": "Reader · Background",
  "reader.font": "Reader · Font",
  "words.detail": "Vocabulary · Detail",
  "words.menu": "Vocabulary · More actions",
  "articles.manage": "Articles · Manage",
  "articles.open": "Articles · Open",
  "articles.detail": "Articles · Detail",
  "articles.detail.more": "Articles · Detail · More",
  "articles.review": "Articles · Review",
  "articles.finish": "Articles · Mark finished",
  "articles.unfinish": "Articles · Mark unfinished",
  "articles.select-all": "Articles · Select all",
  "articles.delete": "Articles · Delete",
  "articles.classify": "Articles · AI classification",
  "articles.classify.pick": "Articles · AI classification · Select non-articles",
  "articles.classify.retry": "Articles · AI classification · Retry",
  "articles.classify.stop": "Articles · AI classification · Stop",
  "articles.blacklist.suggest": "Articles · Blocklist · Suggest",
  "articles.blacklist.apply": "Articles · Blocklist · Apply",

  "review.queue.words": "Review · Queue · Vocabulary",
  "review.queue.articles": "Review · Queue · Articles",
  "review.words.reveal": "Review · Vocabulary · Show answer",
  "review.words.grade": "Review · Vocabulary · Rate",
  "review.undo": "Review · Undo last rating",
  "review.rating-help": "Review · Rating help",
  "review.assist.example": "Review · Assistant · Example",
  "review.assist.explain": "Review · Assistant · Explanation",
  "review.assist.quiz": "Review · Assistant · Quiz",
  "review.articles.reveal": "Review · Articles · Show answer",
  "review.articles.grade": "Review · Articles · Rate",
  "review.articles.source": "Review · Articles · Open source",
  "review.articles.generate": "Review · Articles · Generate",
  /** 和上面四个翻卡、评分的事件**叠着记**：占比 = 它 ÷ 那四个之和，看键盘流有没有人用。 */
  "review.by-key": "Review · Keyboard shortcuts",

  "words.search": "Vocabulary · Search",
  "words.kind": "Vocabulary · Kind",
  "words.enqueue": "Vocabulary · Add to review",
  "words.delete": "Vocabulary · Delete",
  "words.source": "Vocabulary · Open source",
  "speak": "Read aloud",
} as const;

export type UiEvent = keyof typeof UI_EVENTS;

export const isUiEvent = (name: unknown): name is UiEvent =>
  typeof name === "string" && Object.hasOwn(UI_EVENTS, name);

export interface UiUsageLog {
  /** 第一次记数的那天。装上才三天的话什么都是零，看报表得先知道统计了多久。 */
  since: string | null;
  /** 日期（本地，`2026-09-19`）→ 事件 → 次数。 */
  days: Record<string, Record<string, number>>;
  /** 服务器上还没有、或者传过之后又涨了的那几天。没启用同步就一直攒着，启用那天一起传。 */
  pending: string[];
  /** 这个时刻之前不上传：刚传过，或者上次没传成在等下一回。 */
  nextUploadAt: number;
}

export const emptyUiUsage = (): UiUsageLog => ({ since: null, days: {}, pending: [], nextUploadAt: 0 });

/** 留这么多天。一天一桶、一桶至多几十个数，整份也就几十 KB。 */
export const UI_USAGE_DAYS = 90;

const DAY_MS = 86_400_000;

/** 本地日期。按用户的「今天」分桶，不按 UTC——东八区早上八点之前点的不该算到昨天头上。 */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 存下来的东西不一定是这一版写的，也可能被手改过；形状不对的部分当没有。 */
export function normalizeUiUsage(value: unknown): UiUsageLog {
  const raw = (value ?? {}) as Partial<UiUsageLog>;
  const log = emptyUiUsage();
  if (typeof raw.since === "string") log.since = raw.since;
  if (raw.days && typeof raw.days === "object") {
    for (const [day, counts] of Object.entries(raw.days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !counts || typeof counts !== "object") continue;
      const kept: Record<string, number> = {};
      for (const [name, n] of Object.entries(counts)) {
        if (isUiEvent(name) && Number.isSafeInteger(n) && n > 0) kept[name] = n;
      }
      if (Object.keys(kept).length > 0) log.days[day] = kept;
    }
  }
  // 没有 pending 的是上传出现之前存下的：那时候的每一天服务器上都没有
  log.pending = Array.isArray(raw.pending) ? raw.pending.filter((day) => Object.hasOwn(log.days, day)) : Object.keys(log.days);
  if (typeof raw.nextUploadAt === "number" && Number.isFinite(raw.nextUploadAt)) log.nextUploadAt = raw.nextUploadAt;
  return log;
}

/** 记一批。表外的名字丢掉；顺手把过期的桶清了。返回新对象，不改传进来的。 */
export function bumpUiUsage(log: UiUsageLog, names: readonly unknown[], now: number): UiUsageLog {
  const today = dayKey(now);
  const oldest = dayKey(now - (UI_USAGE_DAYS - 1) * DAY_MS);
  const days: UiUsageLog["days"] = {};
  // 日期是补零的 ISO 形式，字符串比较就是日期比较
  for (const [day, counts] of Object.entries(log.days)) if (day >= oldest) days[day] = { ...counts };
  const valid = names.filter(isUiEvent);
  let pending = log.pending.filter((day) => Object.hasOwn(days, day));
  if (valid.length > 0) {
    const bucket = (days[today] ??= {});
    for (const name of valid) bucket[name] = (bucket[name] ?? 0) + 1;
    if (!pending.includes(today)) pending = [...pending, today];
  }
  return { since: log.since ?? (valid.length > 0 ? today : null), days, pending, nextUploadAt: log.nextUploadAt };
}

/** 刚传上去的那几天，如果传的过程中没再涨，就不用再传了；涨了的留着等下一回。不改传进来的。 */
export function settleUiUpload(log: UiUsageLog, sent: UiUsageLog["days"], nextUploadAt: number): UiUsageLog {
  const same = (day: string): boolean => JSON.stringify(log.days[day]) === JSON.stringify(sent[day]);
  return { ...log, pending: log.pending.filter((day) => !(Object.hasOwn(sent, day) && same(day))), nextUploadAt };
}

export interface UiUsageRow {
  name: UiEvent;
  label: string;
  last7: number;
  last30: number;
  /** 保留期（90 天）内的总数。 */
  total: number;
}

export interface UiUsageSummary {
  since: string | null;
  /** 有过记录的天数。「90 天里只用过 4 天」和「天天用」读数的方式不一样。 */
  activeDays: number;
  /** 表里的**每一个**事件都有一行，零也列；次数多的在前，同次数按表里的顺序。 */
  rows: UiUsageRow[];
}

export function summarizeUiUsage(log: UiUsageLog, now: number): UiUsageSummary {
  const from7 = dayKey(now - 6 * DAY_MS);
  const from30 = dayKey(now - 29 * DAY_MS);
  const oldest = dayKey(now - (UI_USAGE_DAYS - 1) * DAY_MS);
  const rows = (Object.keys(UI_EVENTS) as UiEvent[]).map((name): UiUsageRow => ({
    name, label: UI_EVENTS[name], last7: 0, last30: 0, total: 0,
  }));
  const byName = new Map(rows.map((row) => [row.name as string, row]));
  let activeDays = 0;
  for (const [day, counts] of Object.entries(log.days)) {
    if (day < oldest) continue;
    activeDays += 1;
    for (const [name, n] of Object.entries(counts)) {
      const row = byName.get(name);
      if (!row) continue;
      row.total += n;
      if (day >= from30) row.last30 += n;
      if (day >= from7) row.last7 += n;
    }
  }
  const order = new Map(rows.map((row, i) => [row.name, i]));
  rows.sort((a, b) => b.total - a.total || order.get(a.name)! - order.get(b.name)!);
  return { since: log.since, activeDays, rows };
}

/* ==================== 页面这一头：攒一攒再发 ==================== */

/**
 * 点一下发一条的话，每一下都是一次整库读改写（状态库是整个读出来、整个写回去的）。
 * 复习时两三秒翻一张卡，没必要这么勤。攒几秒一起发；页面要走的时候把手里的先交掉。
 */
export const UI_FLUSH_MS = 5_000;

export interface UiTracker {
  track(name: UiEvent): void;
  /** 立刻把攒着的发掉。页面隐藏、离开时调。 */
  flush(): void;
}

export function createUiTracker(deliver: (events: UiEvent[]) => void, delayMs = UI_FLUSH_MS): UiTracker {
  let pending: UiEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    // 埋点是附属品：发不出去就丢掉，不能反过来让按钮的正事报错
    try { deliver(batch); } catch { /* 见上 */ }
  };
  return {
    track(name) {
      pending.push(name);
      timer ??= setTimeout(flush, delayMs);
    },
    flush,
  };
}
