import type {
  Article,
  ArticleCard,
  ArticleReview,
  FsrsState,
  ParagraphRecord,
  ReadingPosition,
  Session,
  Snippet,
  StoredCard,
} from "../types.ts";
import { isFinished } from "./finish.ts";
import { newFsrs } from "./review.ts";
import { mergeEpisodes } from "./stats.ts";
import { compareStamp } from "../sync/protocol.ts";

/**
 * 把另一台设备导出的记录合并进本机。
 *
 * 数据不走服务器：手机上读、划的东西导出成文件，回到电脑导进扩展；反过来也一样。
 * 所以这里的规则必须**幂等**（同一份文件导两次不多出任何东西）而且**对称**
 * （A 导给 B、B 再导回 A，两边收敛到同一份），否则来回几次就乱了。
 *
 * 逐类的规则：
 * - session 按 (articleId, startTs) 认身份，和 commitSession 一样：两边都有时取结束更晚的那份。
 * - 段落按指纹：`firstSeenTs` 取最早的非零值，`dwellMs` 取**最大值**而不是相加——
 *   相加在重复导入时会翻倍，而界面并不消费它。
 * - 阅读位置：`savedTs` 更晚的赢。
 * - 划词按 id 合并，已有的不动。
 * - 生词卡按 `key`（词元）合并成一张：出处并集；FSRS 状态取**最近复习过**的那份
 *   （从没复习过的排最早），另一份的复习次数就丢了——两台设备各自复习过同一张卡时
 *   总得选一个，"最近的那次"至少让排期是新鲜的。
 * - 文章卡按 articleId，同样的规则。
 * - 回顾材料按 articleId，生成时间更晚的赢。
 * - 文章记录：静态元信息取最近一次抽取的；触底、读完这两个 sticky 标记取"或"；
 *   聚合数字（已读字数、片段数、时长、回合）从合并后的 session 与段落**重算**，
 *   和 commitSession 同一套公式。读完判定也照跑一遍：手机上读了前半、电脑上读了后半，
 *   合起来才够阈值的情况就在这里置位并建回顾卡。
 * - 设置与 LLM 配置**不合并**：每台设备各有各的。
 */

/** 参与合并的全部记录。设置和 LLM 配置不在其中。 */
export interface DataSet {
  articles: Record<string, Article>;
  sessions: Session[];
  paragraphs: Record<string, ParagraphRecord[]>;
  positions: Record<string, ReadingPosition>;
  snippets: Snippet[];
  cards: StoredCard[];
  articleReviews: Record<string, ArticleReview>;
  articleCards: ArticleCard[];
}

export function emptyDataSet(): DataSet {
  return {
    articles: {},
    sessions: [],
    paragraphs: {},
    positions: {},
    snippets: [],
    cards: [],
    articleReviews: {},
    articleCards: [],
  };
}

export interface MergeOptions {
  now: number;
  /** 读完判定的阈值，本机设置里的。 */
  finishRatio: number;
  /** 回合合并间隔，本机设置里的。 */
  episodeGapMs: number;
}

/** 合并了什么，给界面上那一句「导入了 N 条…」用。 */
export interface MergeReport {
  sessionsAdded: number;
  sessionsUpdated: number;
  articlesAdded: number;
  articlesUpdated: number;
  snippetsAdded: number;
  cardsAdded: number;
  cardsMerged: number;
  articleCardsAdded: number;
  reviewsAdded: number;
  positionsUpdated: number;
}

const FSRS_KEYS: ReadonlyArray<keyof FsrsState> = [
  "due",
  "stability",
  "difficulty",
  "elapsed_days",
  "scheduled_days",
  "learning_steps",
  "reps",
  "lapses",
  "state",
  "lastReview",
];

/** 两份调度状态里更新鲜的那份：最近复习过的赢；都没复习过看谁复习次数多；再平就要本机的。 */
export function pickFsrs<T extends FsrsState>(mine: T, theirs: T): T {
  const a = mine.lastReview ?? -Infinity;
  const b = theirs.lastReview ?? -Infinity;
  if (b > a) return theirs;
  if (b < a) return mine;
  return theirs.reps > mine.reps ? theirs : mine;
}

/** 只取调度字段，身份字段（id / key / articleId / snippetIds）不带。 */
function fsrsOf(s: FsrsState): FsrsState {
  const out = {} as Record<keyof FsrsState, unknown>;
  for (const k of FSRS_KEYS) out[k] = s[k];
  return out as unknown as FsrsState;
}

function copyFsrs(into: FsrsState, from: FsrsState): void {
  Object.assign(into, fsrsOf(from));
}

const minPositive = (a: number, b: number): number => {
  if (a > 0 && b > 0) return Math.min(a, b);
  return a > 0 ? a : b;
};

const minNonNull = (a: number | null, b: number | null): number | null => {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
};

export function mergeData(local: DataSet, incoming: DataSet, opts: MergeOptions): { data: DataSet; report: MergeReport } {
  const report: MergeReport = {
    sessionsAdded: 0,
    sessionsUpdated: 0,
    articlesAdded: 0,
    articlesUpdated: 0,
    snippetsAdded: 0,
    cardsAdded: 0,
    cardsMerged: 0,
    articleCardsAdded: 0,
    reviewsAdded: 0,
    positionsUpdated: 0,
  };

  /* ---- session ---- */
  const sessions: Session[] = local.sessions.map((s) => ({ ...s }));
  const sessionAt = new Map<string, number>();
  const sessionKey = (s: Session): string => `${s.deviceId ?? "legacy"}\u0000${s.articleId}\u0000${s.startTs}`;
  sessions.forEach((s, i) => sessionAt.set(sessionKey(s), i));
  for (const s of incoming.sessions) {
    const at = sessionAt.get(sessionKey(s));
    if (at === undefined) {
      sessionAt.set(sessionKey(s), sessions.length);
      sessions.push({ ...s });
      report.sessionsAdded += 1;
      continue;
    }
    const prev = sessions[at]!;
    // 补记的 endTs 必然 <= 真实结束时刻：更晚结束的那份更完整
    if (s.endTs > prev.endTs) {
      sessions[at] = { ...s, id: prev.id };
      report.sessionsUpdated += 1;
    }
  }
  sessions.sort((a, b) => a.startTs - b.startTs);

  /* ---- 段落 ---- */
  const paragraphs: Record<string, ParagraphRecord[]> = {};
  for (const [id, list] of Object.entries(local.paragraphs)) paragraphs[id] = list.map((p) => ({ ...p }));
  for (const [id, list] of Object.entries(incoming.paragraphs)) {
    const byHash = new Map((paragraphs[id] ?? []).map((p) => [p.hash, p]));
    for (const p of list) {
      const prev = byHash.get(p.hash);
      if (!prev) {
        byHash.set(p.hash, { ...p });
        continue;
      }
      prev.firstSeenTs = minPositive(prev.firstSeenTs, p.firstSeenTs);
      prev.dwellMs = Math.max(prev.dwellMs, p.dwellMs);
      if (prev.words === 0) prev.words = p.words;
    }
    paragraphs[id] = [...byHash.values()].sort((a, b) => a.index - b.index);
  }

  /* ---- 阅读位置 ---- */
  const positions: Record<string, ReadingPosition> = { ...local.positions };
  for (const pos of Object.values(incoming.positions)) {
    const prev = positions[pos.articleId];
    if (prev && prev.savedTs >= pos.savedTs) continue;
    positions[pos.articleId] = { ...pos };
    report.positionsUpdated += 1;
  }

  /* ---- 生词卡与划词 ---- */
  const cards: StoredCard[] = local.cards.map((c) => ({ ...c, snippetIds: [...c.snippetIds] }));
  const cardByKey = new Map(cards.map((c) => [c.key, c]));
  /** 对方的卡 id → 合并后的卡 id。对方的划词记录挂的是对方的卡 id，得改成这边的。 */
  const cardIdMap = new Map<string, string>();
  for (const c of incoming.cards) {
    const mine = cardByKey.get(c.key);
    if (!mine) {
      const copy: StoredCard = { ...c, snippetIds: [...c.snippetIds] };
      cards.push(copy);
      cardByKey.set(copy.key, copy);
      cardIdMap.set(c.id, copy.id);
      report.cardsAdded += 1;
      continue;
    }
    cardIdMap.set(c.id, mine.id);
    const before = JSON.stringify(mine);
    copyFsrs(mine, pickFsrs(mine, c));
    for (const id of c.snippetIds) if (!mine.snippetIds.includes(id)) mine.snippetIds.push(id);
    // 只有真变了才算"合并"：同一份文件导第二次，报告里不该再说合并了几张
    if (JSON.stringify(mine) !== before) report.cardsMerged += 1;
  }

  const snippets: Snippet[] = local.snippets.map((s) => ({ ...s, vocab: [...(s.vocab ?? [])], usage: s.usage ?? null }));
  const snippetIds = new Set(snippets.map((s) => s.id));
  for (const s of incoming.snippets) {
    if (snippetIds.has(s.id)) continue;
    const copy: Snippet = {
      ...s,
      vocab: [...(s.vocab ?? [])],
      usage: s.usage ?? null,
      cardId: s.cardId ? (cardIdMap.get(s.cardId) ?? null) : null,
    };
    snippets.push(copy);
    snippetIds.add(copy.id);
    report.snippetsAdded += 1;
  }
  // 卡片那边说"这条划词是我的出处"，划词自己却还写着没入队——以卡片为准补上
  const snippetById = new Map(snippets.map((s) => [s.id, s]));
  for (const c of cards) {
    for (const id of c.snippetIds) {
      const s = snippetById.get(id);
      if (s && s.cardId === null) s.cardId = c.id;
    }
    // 出处按时间升序，复习时取最后一条当"最近的语境"；认不出的 id 排最后
    c.snippetIds.sort((a, b) => (snippetById.get(a)?.createdTs ?? Infinity) - (snippetById.get(b)?.createdTs ?? Infinity));
  }

  /* ---- 文章卡 ---- */
  const articleCards: ArticleCard[] = local.articleCards.map((c) => ({ ...c }));
  const articleCardById = new Map(articleCards.map((c) => [c.articleId, c]));
  for (const c of incoming.articleCards) {
    const mine = articleCardById.get(c.articleId);
    if (!mine) {
      const copy = { ...c };
      articleCards.push(copy);
      articleCardById.set(copy.articleId, copy);
      report.articleCardsAdded += 1;
      continue;
    }
    copyFsrs(mine, pickFsrs(mine, c));
  }

  /* ---- 回顾材料 ---- */
  const articleReviews: Record<string, ArticleReview> = { ...local.articleReviews };
  for (const r of Object.values(incoming.articleReviews)) {
    const prev = articleReviews[r.articleId];
    if (prev && prev.generatedTs >= r.generatedTs) continue;
    articleReviews[r.articleId] = { ...r, outline: [...r.outline], questions: [...r.questions] };
    if (!prev) report.reviewsAdded += 1;
  }

  /* ---- 文章 ---- */
  const articles: Record<string, Article> = {};
  for (const [id, a] of Object.entries(local.articles)) articles[id] = { ...a };
  /** 合并前的样子，最后用来判断哪些文章真的变了。 */
  const originals = new Map(Object.entries(local.articles).map(([id, a]) => [id, JSON.stringify(a)]));
  const touched = new Set<string>();
  for (const a of Object.values(incoming.articles)) {
    touched.add(a.id);
    const prev = articles[a.id];
    if (!prev) {
      articles[a.id] = { ...a };
      report.articlesAdded += 1;
      continue;
    }
    // 静态元信息（字数、段落数、标题）以最近一次抽取为准：站点改版后旧的就过时了
    const latest = a.lastSeenTs > prev.lastSeenTs ? a : prev;
    let manual = prev.manualFinished ?? a.manualFinished;
    if (prev.manualFinished?.stamp && a.manualFinished?.stamp) {
      manual = compareStamp(prev.manualFinished.stamp, a.manualFinished.stamp) >= 0 ? prev.manualFinished : a.manualFinished;
    }
    const finished = manual?.value ?? (prev.finished || a.finished);
    articles[a.id] = {
      ...prev,
      url: latest.url,
      title: latest.title || prev.title || a.title,
      totalWords: latest.totalWords,
      trackedWords: latest.trackedWords,
      paragraphCount: latest.paragraphCount,
      expectedMs: latest.expectedMs ?? prev.expectedMs ?? a.expectedMs,
      firstSeenTs: Math.min(prev.firstSeenTs, a.firstSeenTs),
      lastSeenTs: Math.max(prev.lastSeenTs, a.lastSeenTs),
      // 下面这几个数字随后会从 session / 段落重算；先取大者，是给没有明细的老记录兜底
      wordsRead: Math.max(prev.wordsRead, a.wordsRead),
      readParagraphCount: Math.max(prev.readParagraphCount, a.readParagraphCount),
      reachedBottom: prev.reachedBottom || a.reachedBottom,
      finished,
      finishedTs: finished ? minNonNull(prev.finishedTs, a.finishedTs) : null,
      ...(manual ? { manualFinished: { ...manual } } : {}),
    };
  }
  for (const s of incoming.sessions) touched.add(s.articleId);
  for (const id of Object.keys(incoming.paragraphs)) touched.add(id);

  for (const id of touched) {
    const a = articles[id];
    if (!a) continue;
    /*
     * 合并前算不算读完。回顾卡只在读完状态**在这次合并里翻转**时建：本机没读完、合起来读完了。
     * 两边本来就都读完却都没有卡的（这个功能上线前读完的老文章，正文没存）不建——
     * 和 ensureArticleCard 一个道理，没有正文的卡进队列只是一条看不了的东西。
     * 对方本来就读完的文章，它的卡在对方的 articleCards 里，上面已经并进来了。
     */
    const wasFinished = originals.has(id) ? (local.articles[id]?.finished ?? false) : a.finished;
    const records = paragraphs[id];
    if (records && records.length > 0) {
      // 与 commitSession 同一把尺子：已读 = 曾累计到阅读阈值的段落
      const read = records.filter((r) => r.firstSeenTs > 0);
      a.readParagraphCount = read.length;
      a.wordsRead = read.reduce((n, r) => n + r.words, 0);
    }
    const mine = sessions.filter((s) => s.articleId === id);
    if (mine.length > 0) {
      a.sessionCount = mine.length;
      a.totalMs = mine.reduce((n, s) => n + (s.endTs - s.startTs), 0);
      a.maxSessionMs = mine.reduce((n, s) => Math.max(n, s.endTs - s.startTs), 0);
      a.readingMs = mine.filter((s) => s.wordsRead > 0).reduce((n, s) => n + (s.endTs - s.startTs), 0);
      const episodes = mergeEpisodes(mine, opts.episodeGapMs);
      a.episodeCount = episodes.length;
      a.maxEpisodeMs = episodes.reduce((n, e) => Math.max(n, e.activeMs), 0);
      a.lastSeenTs = mine.reduce((n, s) => Math.max(n, s.endTs), a.lastSeenTs);
    }
    // 两台设备各读了一半，合起来才够读完：这里补上置位，和 session 结算时一样建回顾卡
    if (typeof a.manualFinished?.value === "boolean") {
      a.finished = a.manualFinished.value;
      if (!a.finished) a.finishedTs = null;
    }
    if (!a.finished && a.manualFinished?.value !== false && isFinished({ ...a, finishRatio: opts.finishRatio })) {
      a.finished = true;
      a.finishedTs = mine.reduce((n, s) => Math.max(n, s.endTs), 0) || opts.now;
    }
    if (a.finished && !wasFinished && !articleCardById.has(id)) {
      const card: ArticleCard = { articleId: id, ...newFsrs(a.finishedTs ?? opts.now) };
      articleCards.push(card);
      articleCardById.set(id, card);
      report.articleCardsAdded += 1;
    }
    const was = originals.get(id);
    if (was !== undefined && was !== JSON.stringify(a)) report.articlesUpdated += 1;
  }

  return {
    data: { articles, sessions, paragraphs, positions, snippets, cards, articleReviews,
      articleCards: articleCards.filter(card => articles[card.articleId]?.finished !== false) },
    report,
  };
}

/* ==================== 导出文件 → DataSet ==================== */

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok) : []);
const str = (v: unknown): v is string => typeof v === "string";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const isSession = (v: unknown): v is Session => isObj(v) && str(v["articleId"]) && num(v["startTs"]) && num(v["endTs"]);
const isArticle = (v: unknown): v is Article => isObj(v) && str(v["id"]) && num(v["lastSeenTs"]);
const isParagraph = (v: unknown): v is ParagraphRecord => isObj(v) && str(v["hash"]) && num(v["words"]);
const isPosition = (v: unknown): v is ReadingPosition => isObj(v) && str(v["articleId"]) && str(v["hash"]) && num(v["savedTs"]);
const isSnippet = (v: unknown): v is Snippet => isObj(v) && str(v["id"]) && str(v["text"]) && num(v["createdTs"]);
const isCard = (v: unknown): v is StoredCard =>
  isObj(v) && str(v["id"]) && str(v["key"]) && Array.isArray(v["snippetIds"]) && num(v["due"]);
const isArticleCard = (v: unknown): v is ArticleCard => isObj(v) && str(v["articleId"]) && num(v["due"]);
const isReview = (v: unknown): v is ArticleReview =>
  isObj(v) && str(v["articleId"]) && Array.isArray(v["outline"]) && num(v["generatedTs"]);

/** 认识的导出格式。3 是没有 positions 的老版本。 */
export const IMPORTABLE_SCHEMAS: ReadonlyArray<number> = [3, 4];

/**
 * 把一份导出文件解析成 DataSet。格式不对就抛 Error，消息可以直接给用户看。
 *
 * 逐条做最起码的形状检查、丢掉不合形的条目，而不是整份拒收：
 * 文件是这个工具自己写出来的，字段级的深度校验没有必要，
 * 但也不能让一条坏记录把导入搞崩。
 */
export function parseBundle(raw: unknown): DataSet {
  if (!isObj(raw)) throw new Error("This is not a valid export file");
  const schema = raw["schema"];
  if (!num(schema) || !IMPORTABLE_SCHEMAS.includes(schema)) {
    throw new Error(`Unsupported export format (schema ${String(schema)}); supported versions: ${IMPORTABLE_SCHEMAS.join(" / ")}`);
  }
  const data = emptyDataSet();
  for (const a of arr(raw["articles"], isArticle)) data.articles[a.id] = a;
  data.sessions = arr(raw["sessions"], isSession);
  if (isObj(raw["paragraphs"])) {
    for (const [id, list] of Object.entries(raw["paragraphs"])) data.paragraphs[id] = arr(list, isParagraph);
  }
  for (const p of arr(raw["positions"], isPosition)) data.positions[p.articleId] = p;
  data.snippets = arr(raw["snippets"], isSnippet);
  data.cards = arr(raw["cards"], isCard);
  data.articleCards = arr(raw["articleCards"], isArticleCard);
  for (const r of arr(raw["articleReviews"], isReview)) data.articleReviews[r.articleId] = r;
  return data;
}

/** 给界面的一句话。 */
export function describeReport(r: MergeReport): string {
  const parts: string[] = [];
  if (r.articlesAdded || r.articlesUpdated) parts.push(`Articles added: ${r.articlesAdded}, updated: ${r.articlesUpdated}`);
  if (r.sessionsAdded || r.sessionsUpdated) parts.push(`Sessions added: ${r.sessionsAdded}, updated: ${r.sessionsUpdated}`);
  if (r.snippetsAdded) parts.push(`Translations added: ${r.snippetsAdded}`);
  if (r.cardsAdded || r.cardsMerged) parts.push(`Word cards added: ${r.cardsAdded}, merged: ${r.cardsMerged}`);
  if (r.articleCardsAdded) parts.push(`Article cards added: ${r.articleCardsAdded}`);
  if (r.reviewsAdded) parts.push(`Reviews added: ${r.reviewsAdded}`);
  if (r.positionsUpdated) parts.push(`Reading positions updated: ${r.positionsUpdated}`);
  return parts.length ? `Merged: ${parts.join("; ")}` : "No new data. These records are already on your device.";
}
