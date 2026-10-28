import { quantity } from "../ui/text.ts";
import type { HistoryArticleDecision } from "../lib/articleFilter.ts";
import type { BlacklistSuggestion } from "../lib/articleFilter.ts";
import { matchesUrlRule } from "../lib/url.ts";
import type { Settings } from "../types.ts";
import type {
  Article,
  ArticleReviewOutcome,
  ArticleReviewState,
  ArticleReviewView,
  ReviewCardView,
  ReviewStats,
  ReviewUndoResult,
  Session,
  Snippet,
  SpeedSummary,
} from "../types.ts";
import type { MaterialSync } from "../sync/engine.ts";
import { formatDuration } from "../lib/stats.ts";
import { describeBasis, estimateArticle, formatEstimate } from "../lib/readingTime.ts";
import { hostnameOf } from "../lib/url.ts";
import { reasonOf as reason } from "../lib/reason.ts";
import { coarsePointer } from "../lib/pointer.ts";
import { fillMeta } from "../lib/speak.ts";
import { BOOKS_KEY, parseChapterId, type Book } from "../books/types.ts";
import { localStorage } from "../sync/storage.ts";
import { createUiTracker, isUiEvent, type UiEvent } from "../lib/uiUsage.ts";
import { onSyncUpdated } from "../lib/syncUpdated.ts";
import { decorateIcons, icon } from "../ui/icons.ts";
import { renderReadingHome, renderStatistics } from "./overview.ts";
import { renderMobileStatistics } from "./mobileStatistics.ts";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const send = <T,>(msg: unknown): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;

/* ==================== 埋点 ==================== */

/*
 * 记的是「哪个按钮被点了几次」，别的一概不记，见 lib/uiUsage.ts。
 * 能点的东西挂一个 data-track，由下面这一个监听统一记：渲染出来的按钮每次重画都是新的，
 * 逐个在回调里写 track() 的话，三十个回调里各多一行和它正事无关的代码。
 * 不是「点一下」的（键盘评分、输入搜索词）和要看状态的（只记进入批量管理、只记确认后的删除）才直接调 track。
 */
const tracker = createUiTracker((events) => void send({ type: "ui:track", events }).catch(() => undefined));
const track = (name: UiEvent): void => tracker.track(name);
const tracked = <T extends HTMLElement>(node: T, name: UiEvent): T => { node.dataset["track"] = name; return node; };

function trackClick(e: MouseEvent): void {
  // 事件目标不一定是元素：派在 document 上的没有 closest
  const target = e.target as Partial<Element> | null;
  // 音标是 lib/speak.ts 画的，散在生词本和复习卡各处，按类名认
  if (target?.closest?.(".ph")) track("speak");
  const name = target?.closest?.<HTMLElement>("[data-track]")?.dataset["track"];
  if (isUiEvent(name)) track(name);
}
// 捕获阶段记：回调里一重画，被点的那个节点就不在文档里了
document.addEventListener("click", trackClick, true);
// 中键在新标签页打开不触发 click。不记的话「点标题打开原文」在桌面上会被系统性地少算
document.addEventListener("auxclick", (e) => { if (e.button === 1) trackClick(e); }, true);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") tracker.flush(); });
window.addEventListener("pagehide", () => tracker.flush());
track("page.open");

/** 文本一律走 textContent 写入：标题和译文都来自网页/模型，绝不能拼进 innerHTML。 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * 取数的壳：空面板先说一声「正在读取」，取不到就说原因并给重试。
 * 后台刚醒或重启时 sendMessage 会直接拒掉；不接的话面板就是一片空白，分不清是没数据还是坏了。
 * 已经有内容时不插「正在读取」——刷新不该闪一下。
 */
async function guarded(box: HTMLElement, load: () => Promise<void>): Promise<void> {
  if (!box.hasChildNodes()) box.append(el("div", "empty", "Loading…"));
  try { await load(); }
  catch (err) {
    const note = el("div", "empty", `Could not load: ${reason(err)}`);
    const retry = el("button", "mini", "Retry");
    retry.addEventListener("click", () => void guarded(box, load));
    note.append(document.createElement("br"), retry);
    box.replaceChildren(note);
  }
}

const fmtDate = (ts: number): string =>
  new Date(ts).toLocaleDateString("en-US", { month: "numeric", day: "numeric" });

/* ==================== 标签页切换 ==================== */

const PANES = ["articles", "review", "words", "stats", "books"] as const;
type Pane = (typeof PANES)[number];

/** load=false 用于「队列已经装好了，只是切个面板」，见 openArticleReview。 */
function show(pane: Pane, load = true): void {
  for (const p of PANES) {
    const panel = $(`pane-${p}`);
    if (!panel) continue;
    panel.hidden = p !== pane;
    const active = p === pane || (document.body.classList.contains("app") && ((pane === "review" && p === "words") || (["books", "stats"].includes(pane) && p === "articles")));
    document.querySelector(`.tab[data-tab="${p}"]`)?.classList.toggle("active", active);
    document.querySelector(`.tab[data-tab="${p}"]`)?.setAttribute("aria-current", active ? "page" : "false");
  }
  const titles = { articles: "My reading", words: "Vocabulary", review: "Spaced review", stats: "Reading statistics", books: "My bookshelf" };
  if ($("workspace-title")) $("workspace-title").textContent = titles[pane];
  if ($("app-page-title")) $("app-page-title").textContent = { articles: "Reading", books: "Bookshelf", words: "Vocabulary", review: "Review", stats: "Reading statistics" }[pane];
  if ($("reading-back")) $("reading-back").hidden = !["books", "stats"].includes(pane);
  if ($("reading-statistics")) {
    $("reading-statistics").hidden = pane !== "articles";
    $("workspace-search").hidden = pane !== "articles";
    $("words-chat").hidden = pane !== "words";
  }
  document.body.dataset.pane = pane;
  if (document.body.classList.contains("app") && ["articles", "books", "words"].includes(pane)) {
    try { window.sessionStorage.setItem("lectern:home-pane", pane); } catch { /* Reading remains usable without browser preferences. */ }
  }
  if (location.hash !== `#${pane}`) window.history.pushState(null, "", `${location.href.split("#")[0]}#${pane}`);
  document.documentElement.scrollTop = 0;
  if (!load) return;
  if (pane === "review") void loadReview();
  if (pane === "words") void loadWords();
  if (pane === "articles") void loadArticles();
  if (pane === "stats") void guarded($("statistics"), () => document.body.classList.contains("app") ? renderMobileStatistics($("statistics")) : renderStatistics($("statistics")));
}

function navigateHome(pane: "review" | "words" | "stats", queue?: "words" | "articles"): void {
  if (queue) setQueue(queue, false);
  show(pane);
}

// show() 改 hash 会留一条历史；不听 hashchange 的话按后退只有地址变、面板不动
window.addEventListener("hashchange", () => {
  const name = location.hash.slice(1).split(":")[0] as Pane;
  if (PANES.includes(name) && $(`pane-${name}`)?.hidden) show(name);
});

for (const btn of document.querySelectorAll<HTMLButtonElement>(".tab")) {
  tracked(btn, `nav.${btn.dataset["tab"] as Pane}`);
  btn.addEventListener("click", () => show(btn.dataset["tab"] as Pane));
}
tracked($("to-options"), "nav.options");
$("to-options").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.runtime.openOptionsPage();
});

/* ==================== 文章 ==================== */

let articles: Article[] = [];
/**
 * 书目。App 里才有；扩展那边这个键永远是空的，下面那段分组也就永远不进。
 * 章的阅读记录和文章是同一种东西，只是列表上折成一行，免得一本书把整页刷满。
 */
let books: Record<string, Book> = {};
const selectedArticles = new Set<string>();
let managingArticles = false;
let visibleArticles: Article[] = [];
let articleActionBusy = false;
type Classification = HistoryArticleDecision | { status: "pending" | "running" | "stopped" };
const classifications = new Map<string, Classification>();
let classificationRunning = false;
let stopClassification = false;
/**
 * 按读完状态筛。三个并排的键而不是下拉框：下拉要点两下，而「只看没读完的」是这一页最常用的筛法。
 * 状态放在变量里，不去读哪个键按着——列表重画得很勤，不该每画一次查一遍 DOM。
 */
type FinishFilter = "" | "reading" | "done";
let finishFilter: FinishFilter = "";
const searchBox = $("search-box");
const searchToggle = $<HTMLButtonElement>("search-toggle");
const searchInput = $<HTMLInputElement>("q-article");
$("manage-articles").addEventListener("click", () => {
  managingArticles = !managingArticles;
  // 进去才算一次：退出（「完成」）是同一个键，两下都记的话次数平白翻倍
  if (managingArticles) track("articles.manage");
  if (!managingArticles) selectedArticles.clear();
  // 批量管理时卡片是用来勾的不是用来读的：详情在状态里收掉，而不是拿 CSS 藏——藏着的时候按钮还写着「收起」
  if (managingArticles && expandedArticles.size) { expandedArticles.clear(); renderArticles(); }
  updateArticleSelection();
  for (const checkbox of document.querySelectorAll<HTMLInputElement>('#articles .row1 > input[type="checkbox"]')) {
    checkbox.hidden = !managingArticles;
    checkbox.inert = !managingArticles;
    if (!managingArticles) {
      checkbox.checked = false;
      checkbox.closest(".article-card")?.classList.remove("selected");
    }
  }
});
/** 个人阅读速度的摘要，和文章列表一起取回，估每篇「还需多久」用。 */
let speed: SpeedSummary | null = null;

/*
 * 单篇阅读材料的详情：卡片上只有「3 段专注」「共 12 分钟」这种合计，想知道是哪几段、
 * 在这篇里划过哪些词、它同步上去了没有，以前无处可看。展开才去取，取回来的留着——
 * 列表为了筛选、标记读完会整个重画，不能每画一次就重新问一遍。
 */
interface MaterialDetail { sessions: Session[]; snippets: Snippet[]; /** null：没问到。和「只在本机」是两回事，不能混着说。 */ sync: MaterialSync | null }
const expandedArticles = new Set<string>();
const materialDetails = new Map<string, MaterialDetail | "loading" | { error: string }>();
/** 长列表先给最近的几条；全摆出来的话，一篇读了三十回的文章能把下面的卡片全挤出屏幕。 */
const DETAIL_PREVIEW = 8;
const showAll = new Set<string>();

async function loadMaterialDetail(id: string): Promise<void> {
  materialDetails.set(id, "loading");
  renderArticles();
  try {
    const [s, w, sync] = await Promise.all([
      send<{ sessions: Session[] }>({ type: "article:sessions", articleId: id }),
      send<{ snippets: Snippet[] }>({ type: "snippets:list", articleId: id }),
      // 同步处境问不到不该连累前两样：专注时段和划词照样看得了
      send<MaterialSync | { ok: false }>({ type: "sync:material", articleId: id }).catch(() => null),
    ]);
    materialDetails.set(id, {
      sessions: [...(s.sessions ?? [])].sort((a, b) => b.startTs - a.startTs),
      snippets: w.snippets ?? [],
      sync: sync && "state" in sync ? sync : null,
    });
  } catch (err) {
    materialDetails.set(id, { error: err instanceof Error ? err.message : String(err) });
  }
  renderArticles();
}

const clock = (ts: number): string => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
const spellCounts = (counts: [string, number][]): string => counts.map(([label, n]) => `${label}: ${n}`).join(", ");

function renderMaterialDetail(a: Article): HTMLElement {
  const box = el("div", "material-detail");
  const detail = materialDetails.get(a.id);
  if (!detail || detail === "loading") { box.append(el("p", "muted", "Loading…")); return box; }
  if ("error" in detail) {
    const retry = el("button", "mini", "Retry");
    retry.addEventListener("click", () => void loadMaterialDetail(a.id));
    box.append(el("p", "muted", `Could not load: ${detail.error}`), retry);
    return box;
  }

  /** 一节：标题带总数，超过预览条数时给一个「显示全部」。 */
  const section = <T,>(key: string, heading: string, items: T[], empty: string, row: (item: T) => HTMLElement): void => {
    const part = el("section");
    part.append(el("h4", undefined, heading));
    if (items.length === 0) { part.append(el("p", "muted", empty)); box.append(part); return; }
    const all = showAll.has(`${a.id}:${key}`);
    const list = el("ul");
    for (const item of all ? items : items.slice(0, DETAIL_PREVIEW)) list.append(row(item));
    part.append(list);
    if (!all && items.length > DETAIL_PREVIEW) {
      const more = tracked(el("button", "mini", `Show all ${quantity(items.length, "record")}`), "articles.detail.more");
      more.addEventListener("click", () => { showAll.add(`${a.id}:${key}`); renderArticles(); });
      part.append(more);
    }
    box.append(part);
  };

  const total = detail.sessions.reduce((n, s) => n + s.endTs - s.startTs, 0);
  section("sessions", `Focus sessions · ${detail.sessions.length}${detail.sessions.length ? ` · Total: ${formatDuration(total)}` : ""}`,
    detail.sessions, "No focus sessions recorded yet.", (s) => {
      const li = el("li");
      li.append(el("span", "when", `${fmtDate(s.startTs)} ${clock(s.startTs)}–${clock(s.endTs)}`),
        el("span", "meta", `${formatDuration(s.endTs - s.startTs)}${s.wordsRead > 0 ? ` · Newly read: ${quantity(s.wordsRead, "word")}` : " · No new content read"}`));
      return li;
    });
  section("snippets", `Translations · ${quantity(detail.snippets.length, "record")}`, detail.snippets, "No saved translations for this article yet.", (w) => {
    const li = el("li");
    li.append(el("span", "word", w.text), el("span", "gloss", w.translation));
    return li;
  });

  const sync = el("section");
  sync.append(el("h4", undefined, "Sync"));
  const line = el("p", "sync-line");
  const state = detail.sync?.state ?? "unknown";
  const dot = el("span", "dot");
  dot.dataset.tone = state === "synced" ? "ok" : state === "pending" ? "busy" : state === "blocked" ? "warn" : "";
  const waiting = detail.sync?.waiting.length ? spellCounts(detail.sync.waiting) : "";
  line.append(dot, el("span", undefined,
    state === "synced" ? "Synced to the server, including focus sessions, paragraphs and translations"
      : state === "pending" ? `Changes waiting for the next sync: ${waiting}`
      : state === "blocked" ? `Could not upload; kept on this device: ${waiting}`
      : state === "local" ? "Only on this device: sync is disabled or this content is kept local"
      : "Sync status is temporarily unavailable"));
  if (state === "unknown") {
    const retry = el("button", "mini", "Retry");
    retry.addEventListener("click", () => void loadMaterialDetail(a.id));
    line.append(retry);
  }
  sync.append(line);
  if (state === "blocked") for (const reason of detail.sync?.reasons ?? []) sync.append(el("p", "sync-reason", reason));
  box.append(sync);
  return box;
}

async function loadArticles(): Promise<void> {
  await guarded($("articles"), fetchArticles);
}
/** onlyIfChanged：后台刷新用。取回来的和手里这份一样就什么都不动——重画会收起正选着的字、打断正要点下去的那一下。 */
async function fetchArticles(onlyIfChanged = false): Promise<void> {
  const res = await send<{ articles: Article[]; speed?: SpeedSummary | null }>({ type: "articles:list" });
  // 走 localStorage() 而不是 chrome.storage.local：App 里数据在同步库那一份下，
  // 扩展的这个页面没装过垫片，退回真正的 chrome.storage.local——那边本来就没有书。
  const shelf = ((await localStorage().get(BOOKS_KEY))[BOOKS_KEY] ?? {}) as Record<string, Book>;
  // 速度摘要的 updatedTs 每次落库都是「现在」，带着它比的话永远不一样
  const face = (a: Article[], sp: SpeedSummary | null, b: Record<string, Book>): string => JSON.stringify([a, sp && { ...sp, updatedTs: 0 }, b]);
  if (onlyIfChanged && face(res.articles ?? [], res.speed ?? null, shelf) === face(articles, speed, books)) return;
  articles = res.articles ?? [];
  books = shelf;
  for (const id of selectedArticles) if (!articles.some(a => a.id === id)) selectedArticles.delete(id);
  for (const id of classifications.keys()) if (!articles.some(a => a.id === id)) classifications.delete(id);
  for (const id of expandedArticles) if (!articles.some(a => a.id === id)) expandedArticles.delete(id);
  for (const id of materialDetails.keys()) if (!articles.some(a => a.id === id)) materialDetails.delete(id);
  speed = res.speed ?? null;
  void renderReadingHome(articles, speed, navigateHome, books);
  renderArticles();
}

/*
 * 别的设备上刚读的文章要自己冒出来：在手机上读完、关了屏、走到电脑前，这一页多半早就开着。
 * 两个时机再取一次列表——同步拉到了让本机数据变样的东西（lib/syncUpdated.ts），以及这一页重新回到眼前
 * （取列表本身会催后台同步一轮，见 background/handle.ts 的 articles:list；拉到了就回到前一种）。
 *
 * 只管文章这一栏：复习翻到一半的卡不能被换掉，另外两栏每次切过去本来就重新取。
 * 批量删除、逐篇判别正跑着时不动，它们结束时自己会重画。
 */
function refreshArticles(): void {
  if ($("pane-articles").hidden || articleActionBusy || classificationRunning) return;
  // 后台刷新取不到不说话：画着的那份还是好的，轮不到拿一条报错把它换掉
  void fetchArticles(true).catch(() => undefined);
}
onSyncUpdated(refreshArticles);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshArticles(); });

function renderArticles(): void {
  const q = searchInput.value.trim().toLowerCase();
  // 有搜索词，框就得开着：框收着而筛选还在生效的话，列表少了一半都不知道为什么。
  // 浏览器后退时会把输入框里的字填回来，那时候没人点过搜索键
  if (q && !searchBox.classList.contains("open")) setSearchOpen(true);
  const filter = finishFilter;
  /*
   * 书里的章不在这份列表里露面——它们在书架那一栏按书折成一行，
   * 否则一本四十节的书能把整页刷满。记录本身还是一章一条，只是不在这儿逐条摆出来。
   * 扩展里 books 永远是空的，这几行等于不存在。
   */
  const shelved = (a: Article): boolean => Boolean(books[parseChapterId(a.id)?.bookId ?? ""]);
  const loose = articles.filter((a) => !shelved(a));
  const queueOnly = document.body.classList.contains("app") && !$<HTMLDetailsElement>("article-tools")?.open && !q && !managingArticles;
  const list = loose.filter((a) => {
    if (queueOnly && (a.finished || a.id === document.body.dataset.resumeArticle)) return false;
    if (filter === "done" && !a.finished) return false;
    if (filter === "reading" && a.finished) return false;
    if (!q) return true;
    return a.title.toLowerCase().includes(q) || a.url.toLowerCase().includes(q);
  });

  visibleArticles = list;
  updateArticleSelection();
  const done = loose.filter((a) => a.finished).length;
  const chapters = articles.length - loose.length;
  $("article-summary").textContent = `Articles: ${loose.length} · Finished: ${done}`
    // 筛过之后说一声剩几篇：三个键和搜索框叠着用的时候，光看列表分不清是筛没了还是本来就没有
    + (list.length !== loose.length ? ` · Showing ${list.length}` : "")
    + (chapters > 0 ? ` · Also ${quantity(chapters, "chapter")} on your bookshelf` : "");

  const box = $("articles");
  box.textContent = "";
  if (list.length === 0) {
    box.append(el("div", "empty", loose.length ? "No matching articles" : "No reading history yet. Read an article for a while and it will appear here."));
    return;
  }

  for (const a of list) {
    const card = el("div", "card article-card");
    const source = el("div", "article-source", (a.title || hostnameOf(a.url)).slice(0, 1).toUpperCase());
    source.setAttribute("aria-hidden", "true");
    card.append(source);
    const row = el("div", "row1");

    const title = el("div", "title");
    const link = tracked(el("a", undefined, a.title || a.url), "articles.open");
    link.href = a.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    title.append(link);

    const ratio = a.trackedWords > 0 ? Math.min(1, a.wordsRead / a.trackedWords) : 0;
    const pill = el("span", `pill${a.finished ? " done" : ""}`, a.finished ? "Finished" : `${Math.round(ratio * 100)}%`);

    const toggle = tracked(el("button", "mini", a.finished ? "Mark unfinished" : "Mark finished"), a.finished ? "articles.unfinish" : "articles.finish");
    toggle.addEventListener("click", async () => {
      toggle.disabled = true;
      try {
        const r = await send<{ ok: boolean; article: Article | null }>({
          type: "article:finish",
          articleId: a.id,
          finished: !a.finished,
        });
        if (!r.article) throw new Error("This article record no longer exists");
        // 按 id 找现在那一份：等应答的工夫列表可能被后台刷新换过一遍，手里这个 a 已经不在 articles 里了
        Object.assign(articles.find((x) => x.id === a.id) ?? a, r.article);
        renderArticles();
        void renderReadingHome(articles, speed, navigateHome, books);
      } catch (err) {
        // 就写在按钮上：批量操作那行状态在列表最顶上，离这儿可能隔着几十张卡片
        toggle.disabled = false;
        toggle.textContent = "Update failed. Try again.";
        toggle.title = reason(err);
      }
    });

    const select = el("input");
    select.type = "checkbox";
    select.hidden = !managingArticles;
    select.inert = !managingArticles;
    select.checked = selectedArticles.has(a.id);
    select.disabled = articleActionBusy;
    select.setAttribute("aria-label", "Select " + (a.title || a.url));
    select.addEventListener("change", () => {
      if (select.checked) selectedArticles.add(a.id); else selectedArticles.delete(a.id);
      card.classList.toggle("selected", select.checked);
      updateArticleSelection();
    });
    row.append(select, title, pill);
    // 正在逐篇判别的卡片被压成了两行摘要，不在这时候展开详情
    const open = expandedArticles.has(a.id) && !classifications.has(a.id);
    const more = el("button", "mini detail-toggle", open ? "Collapse" : "Details");
    more.hidden = classifications.has(a.id);
    // 只记展开：收起是同一个键
    if (!open) tracked(more, "articles.detail");
    more.setAttribute("aria-expanded", String(open));
    more.addEventListener("click", () => {
      if (expandedArticles.delete(a.id)) { renderArticles(); return; }
      expandedArticles.add(a.id);
      // 每次展开都重新取：同步处境和专注时段是会变的，留着的那份只为扛住列表重画
      void loadMaterialDetail(a.id);
    });
    const menu = el("details", "article-menu");
    const menuToggle = tracked(el("summary", undefined, "•••"), "articles.menu");
    menuToggle.setAttribute("aria-label", `Article actions: ${a.title || a.url}`);
    const menuBody = el("div", "article-menu-body");
    menuBody.append(more); menu.append(menuToggle, menuBody); row.append(menu);
    // 读完了才有回顾卡；没读完的文章连正文都未必存下来了
    if (a.finished) {
      const rev = tracked(el("button", "mini", "Review"), "articles.review");
      rev.addEventListener("click", () => void openArticleReview(a.id));
      menuBody.append(rev);
    }
    toggle.classList.add("reading-action");
    menuBody.append(toggle);

    const sub = el("div", "sub");
    sub.append(
      el("span", undefined, hostnameOf(a.url)),
      el("span", undefined, `${a.wordsRead} / ${quantity(a.trackedWords, "word")}`),
      el("span", undefined, formatDuration(a.totalMs)),
      el("span", undefined, `${quantity(a.sessionCount, "focus session")}`),
      el("span", undefined, `Last read: ${fmtDate(a.lastSeenTs)}`),
    );
    if (!a.reachedBottom && !a.finished) sub.append(el("span", undefined, "End not reached"));
    // 没读完的说一句还需多久；依据挂在 title 上，悬停可见
    if (!a.finished) {
      const left = estimateArticle(a, speed);
      if (left && left.words > 0) {
        const span = el("span", undefined, "Remaining: " + formatEstimate(left.ms));
        span.title = describeBasis(left);
        sub.append(span);
      }
    }

    const bar = el("div", "progress");
    const fill = el("i");
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    bar.append(fill);

    card.append(row, sub, bar);
    const classification = classifications.get(a.id);
    if (classification) {
      const result = el("div", "classification-result");
      card.classList.add("has-classification");
      if ("status" in classification) result.textContent = classification.status === "pending" ? "AI: waiting to classify" : classification.status === "running" ? "AI: classifying…" : "AI: stopped before classification";
      else {
        result.classList.add(classification.ok ? classification.isArticle ? "is-article" : "not-article" : "failed");
        result.append(el("strong", undefined, classification.ok ? classification.isArticle ? "AI: article" : "AI: not an article" : "AI: classification failed"),
          el("p", undefined, classification.reason));
        if (classification.ok) result.append(el("span", "muted small", classification.source === "saved" ? "Source: saved article text" : "Source: fetched page"));
      }
      card.append(result);
    }
    if (open) card.append(renderMaterialDetail(a));
    card.classList.toggle("selected", selectedArticles.has(a.id));
    box.append(card);
  }
}

/* ---- 筛选与搜索 ---- */

for (const btn of document.querySelectorAll<HTMLButtonElement>("#finish-filter button")) {
  const value = (btn.dataset["filter"] ?? "") as FinishFilter;
  tracked(btn, `articles.filter.${value || "all"}`);
  btn.addEventListener("click", () => {
    finishFilter = value;
    for (const b of document.querySelectorAll<HTMLButtonElement>("#finish-filter button")) {
      b.setAttribute("aria-pressed", String(b === btn));
    }
    renderArticles();
  });
}

/** 每展开一次只记一回「输入了搜索词」：按键数没有意义，要知道的是展开之后到底搜没搜。 */
let searchCounted = false;

function setSearchOpen(open: boolean): void {
  searchBox.classList.toggle("open", open);
  searchInput.toggleAttribute("inert", !open);
  searchToggle.setAttribute("aria-expanded", String(open));
  const label = open ? "Close search" : "Search articles";
  searchToggle.setAttribute("aria-label", label);
  searchToggle.title = label;
}

/** 收起来就把词清掉，理由见 renderArticles 开头。 */
function closeSearch(): void {
  const had = searchInput.value !== "";
  searchInput.value = "";
  searchCounted = false;
  setSearchOpen(false);
  if (had) renderArticles();
}

searchToggle.addEventListener("click", () => {
  if (searchBox.classList.contains("open")) { closeSearch(); return; }
  setSearchOpen(true);
  track("articles.search.open");
  searchInput.focus();
});
searchInput.addEventListener("input", () => {
  if (!searchCounted && searchInput.value.trim()) { searchCounted = true; track("articles.search.query"); }
  renderArticles();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  e.preventDefault();
  closeSearch();
  searchToggle.focus();
});
// 空着走开就自己收起来。焦点是落到搜索键上的不算——那一下交给键自己的 click 去收，
// 这儿先收了的话 click 看到的是「收着」，会反手再打开
searchBox.addEventListener("focusout", (e) => {
  if (searchBox.contains(e.relatedTarget as Node | null)) return;
  if (!searchInput.value.trim()) closeSearch();
});

function updateArticleSelection(): void {
  $("article-search").hidden = managingArticles;
  $("article-search").inert = managingArticles;
  $("article-actions").hidden = !managingArticles;
  $("article-actions").inert = !managingArticles;
  $("pane-articles").classList.toggle("managing-articles", managingArticles);
  $("manage-articles").textContent = managingArticles ? "Done" : "Manage articles";
  $("manage-articles").setAttribute("aria-pressed", String(managingArticles));
  $("selection-count").textContent = `Selected: ${selectedArticles.size}`;
  const all = $<HTMLInputElement>("select-articles");
  const n = visibleArticles.filter(a => selectedArticles.has(a.id)).length;
  all.checked = n > 0 && n === visibleArticles.length;
  all.indeterminate = n > 0 && n < visibleArticles.length;
  all.disabled = articleActionBusy || !visibleArticles.length;
  for (const id of ["delete-articles", "suggest-blacklist", "classify-articles"]) {
    $<HTMLButtonElement>(id).disabled = articleActionBusy || !selectedArticles.size;
  }
  renderClassificationProgress();
}

function renderClassificationProgress(): void {
  $("classification-panel").hidden = classifications.size === 0;
  const values = [...classifications.values()];
  const done = values.filter(v => "ok" in v);
  const nonarticles = done.filter(v => "ok" in v && v.ok && !v.isArticle).length;
  const failed = done.filter(v => "ok" in v && !v.ok).length;
  const stopped = values.filter(v => "status" in v && v.status === "stopped").length;
  $("classification-progress").textContent = `${classificationRunning ? "Classifying" : "Classification complete"}: processed ${done.length} / ${quantity(values.length, "article")}; non-articles: ${nonarticles}; failed: ${failed}${stopped ? `; pending: ${stopped}` : ""}.`;
  $<HTMLButtonElement>("select-nonarticles").disabled = articleActionBusy || !visibleArticles.some(a => {
    const result = classifications.get(a.id); return result && "ok" in result && result.ok && !result.isArticle;
  });
  $<HTMLButtonElement>("retry-classification").disabled = articleActionBusy || !failed;
  $("stop-classification").hidden = !classificationRunning;
  $<HTMLButtonElement>("stop-classification").disabled = stopClassification;
}

async function classifySelected(ids: string[]): Promise<void> {
  if (articleActionBusy || !ids.length) return;
  classificationRunning = true;
  stopClassification = false;
  for (const id of ids) classifications.set(id, { status: "pending" });
  await articleAction(async () => {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopClassification && next < ids.length) {
        const id = ids[next++]!;
        classifications.set(id, { status: "running" }); renderArticles();
        try {
          const result = await send<HistoryArticleDecision>({ type: "article:classify-history", articleId: id });
          if (!result || typeof result.ok !== "boolean" || (result.ok && typeof result.isArticle !== "boolean")) throw new Error("Invalid classification response. Try again.");
          classifications.set(id, result);
        } catch (err) { classifications.set(id, { ok: false, reason: err instanceof Error ? err.message : String(err) }); }
        renderArticles();
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker)); }
    finally {
      for (const id of ids) if ((classifications.get(id) as { status?: string })?.status === "pending") classifications.set(id, { status: "stopped" });
      classificationRunning = false;
    }
  });
}

const TRACKED_IDS: Record<string, UiEvent> = {
  "select-articles": "articles.select-all",
  "delete-articles": "articles.delete",
  "classify-articles": "articles.classify",
  "select-nonarticles": "articles.classify.pick",
  "retry-classification": "articles.classify.retry",
  "stop-classification": "articles.classify.stop",
  "suggest-blacklist": "articles.blacklist.suggest",
};
for (const [id, name] of Object.entries(TRACKED_IDS)) tracked($(id), name);

$("classify-articles").addEventListener("click", () => void classifySelected([...selectedArticles]));
$("stop-classification").addEventListener("click", () => { stopClassification = true; renderClassificationProgress(); });
$("retry-classification").addEventListener("click", () => void classifySelected([...classifications].flatMap(([id, result]) => "ok" in result && !result.ok ? [id] : [])));
$("select-nonarticles").addEventListener("click", () => {
  managingArticles = true;
  selectedArticles.clear();
  for (const a of visibleArticles) {
    const result = classifications.get(a.id);
    if (result && "ok" in result && result.ok && !result.isArticle) selectedArticles.add(a.id);
  }
  renderArticles();
});

$("select-articles").addEventListener("change", () => {
  const checked = $<HTMLInputElement>("select-articles").checked;
  for (const a of visibleArticles) {
    if (checked) selectedArticles.add(a.id); else selectedArticles.delete(a.id);
  }
  renderArticles();
});

async function articleAction(work: () => Promise<void>): Promise<void> {
  articleActionBusy = true;
  // 上一次的「已删除 3 篇」不该陪着这一次的操作一直挂着
  $("article-action-status").textContent = "";
  renderArticles();
  try { await work(); }
  catch (err) { $("article-action-status").textContent = "Action failed: " + reason(err); }
  finally { articleActionBusy = false; renderArticles(); }
}

$("delete-articles").addEventListener("click", () => {
  const ids = [...selectedArticles];
  if (!ids.length || !confirm(`Delete the selected ${quantity(ids.length, "article")} with their reading history, saved text and review cards? Translations and vocabulary cards will be kept. This cannot be undone.`)) return;
  void articleAction(async () => {
    const res = await send<{ ok: boolean; deleted: number }>({ type: "articles:delete", articleIds: ids });
    if (!res.ok) throw new Error((res as { error?: string }).error || "Could not delete");
    for (const id of ids) selectedArticles.delete(id);
    $("article-action-status").textContent = `Deleted ${quantity(res.deleted, "article")}`;
    await loadArticles();
  });
});

$("suggest-blacklist").addEventListener("click", () => {
  const ids = [...selectedArticles];
  void articleAction(async () => {
    $("article-action-status").textContent = "AI is suggesting rules based on the selected URLs and titles…";
    const res = await send<{ ok: boolean; suggestions?: BlacklistSuggestion[]; error?: string }>({ type: "articles:blacklist-suggest", articleIds: ids });
    if (!res.ok) throw new Error(res.error || "Generation failed");
    const box = $("blacklist-suggestions");
    const section = $<HTMLDetailsElement>("blacklist-section");
    section.hidden = false; section.open = true;
    box.textContent = "";
    const choices: { input: HTMLInputElement; pattern: string }[] = [];
    for (const suggestion of res.suggestions ?? []) {
      const row = el("label", "card suggestion");
      const input = el("input"); input.type = "checkbox";
      const matches = articles.filter(a => matchesUrlRule(a.url, suggestion.pattern)).length;
      row.append(input, el("strong", undefined, suggestion.pattern), el("p", undefined, suggestion.reason),
        el("p", "muted small", `Matches ${matches} existing records. Applying this rule stops future tracking without deleting articles or disabling translation.`));
      choices.push({ input, pattern: suggestion.pattern });
      box.append(row);
    }
    $("article-action-status").textContent = choices.length ? "Select the suggestions you want to apply." : "Not enough evidence to suggest blocklist rules.";
    if (!choices.length) return;
    const apply = el("button", undefined, "Apply selected suggestions");
    apply.addEventListener("click", () => {
      const rules = choices.filter(c => c.input.checked).map(c => c.pattern);
      if (!rules.length) return;
      // 一条没勾的那一下什么都没发生，不算采用
      track("articles.blacklist.apply");
      apply.disabled = true;
      void articleAction(async () => {
        const settings = await send<Settings>({ type: "settings:get" });
        await send({ type: "settings:set", settings: { articleExcludedUrls: [...new Set([...settings.articleExcludedUrls, ...rules])] } });
        box.textContent = "";
        section.hidden = true;
        $("article-action-status").textContent = `Applied ${rules.length} reading blocklist suggestions`;
      }).finally(() => { apply.disabled = false; });
    });
    box.append(apply);
  });
});


/* ==================== 生词本 ==================== */

let snippets: Snippet[] = [];

async function loadWords(): Promise<void> {
  await guarded($("words"), async () => {
    const res = await send<{ snippets: Snippet[] }>({ type: "snippets:list" });
    snippets = res.snippets ?? [];
    renderWords();
  });
}

const KIND_LABEL: Record<Snippet["kind"], string> = { word: "Word", phrase: "Phrase", sentence: "Sentence" };

function renderWords(): void {
  const q = $<HTMLInputElement>("q-word").value.trim().toLowerCase();
  const kind = $<HTMLSelectElement>("kind-filter").value;
  const list = snippets.filter((s) => {
    if (kind && s.kind !== kind) return false;
    if (!q) return true;
    return (
      s.text.toLowerCase().includes(q) ||
      s.translation.toLowerCase().includes(q) ||
      s.articleTitle.toLowerCase().includes(q)
    );
  });

  const queued = snippets.filter((s) => s.cardId).length;
  if ($("nav-word-count")) $("nav-word-count").textContent = String(snippets.length);
  $("word-summary").textContent = `Total: ${quantity(snippets.length, "record")}; ${queued} in the review queue`;

  const box = $("words");
  box.textContent = "";
  if (list.length === 0) {
    box.append(el("div", "empty", snippets.length ? "No matching records" : "No saved translations yet. Select a word or sentence in an article to save it here with its explanation."));
    return;
  }

  for (const s of list) {
    const card = el("div", "card word-card");
    const row = el("div", "row1");
    row.append(el("div", "title", s.text), el("span", "pill", KIND_LABEL[s.kind]));

    if (s.cardId) {
      row.append(el("span", "pill done", "In review"));
    } else {
      // 整句默认不排期，但用户可以手动捞进来
      const add = tracked(el("button", "mini", "Add to review"), "words.enqueue");
      add.addEventListener("click", async () => {
        add.disabled = true;
        try {
          const res = await send<{ ok: boolean }>({ type: "snippet:enqueue", id: s.id });
          if (!res?.ok) throw new Error("This vocabulary record no longer exists");
          await loadWords();
        } catch (err) {
          add.disabled = false;
          add.textContent = "Could not add. Try again.";
          add.title = reason(err);
        }
      });
      row.append(add);
    }

    /*
     * 删除要点两下。这一条没了，它名下那张复习卡（连同排期和复习进度）可能跟着没，后台没有撤销；
     * 弹 confirm 又太重——一屏几十条，逐条清理时每条都弹窗会逼人不看就点确定。
     */
    const del = el("button", "mini danger", "Delete");
    let armed: ReturnType<typeof setTimeout> | null = null;
    del.addEventListener("click", async () => {
      if (armed === null) {
        del.textContent = s.cardId ? "Delete with review progress?" : "Confirm deletion";
        armed = setTimeout(() => { armed = null; del.textContent = "Delete"; }, 4000);
        return;
      }
      clearTimeout(armed);
      armed = null;
      del.disabled = true;
      // 确认的那一下才算：头一下只是把键扳上，两下都记的话删一条算两次
      track("words.delete");
      try {
        await send({ type: "snippet:delete", id: s.id });
        await loadWords();
      } catch (err) {
        del.disabled = false;
        del.textContent = "Could not delete. Try again.";
        del.title = reason(err);
      }
    });
    row.append(del);

    const tr = el("div", "word-translation", s.translation);

    const sub = el("div", "sub");
    const meta = el("span");
    if (fillMeta(meta, { phonetic: s.phonetic, pos: s.pos, word: s.text })) sub.append(meta);
    const from = tracked(el("a", undefined, s.articleTitle || hostnameOf(s.url)), "words.source");
    from.href = s.url;
    from.target = "_blank";
    from.rel = "noreferrer";
    from.style.color = "inherit";
    sub.append(from, el("span", undefined, fmtDate(s.createdTs)));

    const controls = el("div", "word-controls");
    while (row.children.length > 1) controls.append(row.children[1]!);
    const actions = el("details", "word-actions");
    const actionsToggle = tracked(el("summary"), "words.menu");
    actionsToggle.setAttribute("aria-label", `More actions for ${s.text}`);
    actionsToggle.append(icon("more"));
    actions.append(actionsToggle, controls);
    const summary = el("div", "word-summary-row");
    summary.append(row, tr);
    if (s.context) summary.append(el("p", "word-context-preview", s.context));
    summary.append(sub);
    if (document.body.classList.contains("app") && s.kind !== "sentence") {
      const chat = tracked(el("a", "icon-btn word-chat-entry"), "chat.word");
      chat.href = `chat.html?word=${encodeURIComponent(s.id)}`;
      chat.setAttribute("aria-label", `Practice with AI: ${s.text}`); chat.append(icon("chat"));
      row.append(chat);
    }
    row.append(actions);
    const detail = el("details", "word-detail");
    detail.append(tracked(el("summary", undefined, "Context and explanation"), "words.detail"));
    if (s.context) detail.append(el("blockquote", undefined, s.context));
    card.append(summary, detail);
    if (s.contextNote) {
      const note = el("div", "sub", s.contextNote);
      note.style.display = "block";
      detail.append(note);
    }
    if (s.usage) detail.append(el("div", "usage", s.usage));
    if (s.vocab.length > 0) {
      const box = el("div", "vocab");
      for (const v of s.vocab) {
        const one = el("div", "v");
        const head = el("div");
        head.append(el("span", "vw", v.word));
        const m = el("span", "vm");
        if (fillMeta(m, { phonetic: v.phonetic, pos: v.pos, word: v.word })) head.append(m);
        one.append(head, el("div", "vd", v.meaning));
        if (v.note) one.append(el("div", "vn", v.note));
        box.append(one);
      }
      detail.append(box);
    }
    box.append(card);
  }
}

document.addEventListener("click", event => {
  const target = event.target as Node | null;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(".word-actions[open]")) {
    if (!target || !menu.contains(target)) menu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  for (const menu of document.querySelectorAll<HTMLDetailsElement>(".word-actions[open]")) {
    menu.open = false;
    menu.querySelector("summary")?.focus();
  }
});

/** 从空到有字算一次搜索，清空之后再输才算下一次——和文章那边「每展开一次记一回」是同一个意思。 */
let wordSearchCounted = false;
$("q-word").addEventListener("input", () => {
  const typed = $<HTMLInputElement>("q-word").value.trim() !== "";
  if (typed && !wordSearchCounted) track("words.search");
  wordSearchCounted = typed;
  renderWords();
});
$("kind-filter").addEventListener("change", () => { track("words.kind"); renderWords(); });

/* ==================== 复习 ==================== */

/**
 * 复习页下面挂着两个独立队列。刻意不交错渲染：
 * 生词卡是一个词，文章卡是一整篇，翻卡的节奏完全不同，混在一起两边都难受。
 */
type Queue = "words" | "articles";
let queueKind: Queue = "words";

/** 导航上的红点是两个队列之和。 */
let dueWords = 0;
let dueArticles = 0;

function paintBadge(): void {
  const total = dueWords + dueArticles;
  const badge = $("due-badge");
  badge.textContent = String(total);
  badge.hidden = total === 0 && !document.body.classList.contains("app");
  if ($("home-due-count")) $("home-due-count").textContent = String(total);
  $("seg-words-n").textContent = dueWords > 0 ? String(dueWords) : "";
  $("seg-articles-n").textContent = dueArticles > 0 ? String(dueArticles) : "";
}

function setQueue(k: Queue, load = true): void {
  queueKind = k;
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg")) {
    b.classList.toggle("active", b.dataset["queue"] === k);
  }
  if (load) void loadReview();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>(".seg")) {
  tracked(btn, `review.queue.${btn.dataset["queue"] as Queue}`);
  btn.addEventListener("click", () => setQueue(btn.dataset["queue"] as Queue));
}

let queue: ReviewCardView[] = [];
let cursor = 0;
let revealed = false;
type LastRating = { eventId: string; index: number } & (
  | { kind: "words"; queue: ReviewCardView[] }
  | { kind: "articles"; queue: ArticleReviewView[] }
);
let lastRating: LastRating | null = null;

function paintReviewUndo(): void {
  const button = $<HTMLButtonElement>("review-undo");
  button.hidden = !lastRating || lastRating.kind !== queueKind;
  button.disabled = grading;
}
function clearReviewUndo(): void {
  lastRating = null;
  $("review-action-status").textContent = "";
  paintReviewUndo();
}

async function loadReview(): Promise<void> {
  clearReviewUndo();
  if (queueKind === "articles") return loadArticleQueue();
  await guarded($("review-area"), async () => {
    const res = await send<{ cards: ReviewCardView[]; stats: ReviewStats }>({ type: "review:due", limit: 60 });
    queue = res.cards ?? [];
    cursor = 0;
    revealed = false;
    renderStats(res.stats, "words");
    renderReview();
  });
}

function renderStats(s: ReviewStats, kind: Queue): void {
  const box = $("review-stats");
  box.textContent = "";
  const add = (n: number | string, label: string): void => {
    const stat = el("div", "stat");
    stat.append(el("b", undefined, String(n)), el("span", undefined, label));
    box.append(stat);
  };
  add(s.dueNow, kind === "words" ? "Due words" : "Due articles");
  add(s.total, kind === "words" ? "Total cards" : "Total articles");
  add(s.newCount, "New");
  add(s.learningCount, "Learning");
  add(s.reviewCount, "Reviewing");
  add(s.forecast.slice(1).reduce((a, b) => a + b, 0), "Due in the next 6 days");

  if (kind === "words") dueWords = s.dueNow;
  else dueArticles = s.dueNow;
  paintBadge();
}

function renderReview(): void {
  paintReviewUndo();
  if (queueKind === "articles") {
    renderArticleReview();
    return;
  }
  const area = $("review-area");
  area.textContent = "";

  const item = queue[cursor];
  if (!item) {
    area.append(
      el("div", "empty", queue.length === 0 ? "No cards due now. Read an article and discover some new words." : "Review complete 🎉"),
    );
    return;
  }

  const wrap = el("div", "reviewer");
  const progress = el("div", "review-progress");
  progress.append(el("span", undefined, `Reviewed this session: ${cursor + 1} / ${queue.length}`));
  const progressBar = el("div", "progress");
  const progressFill = el("i"); progressFill.style.width = `${cursor / queue.length * 100}%`; progressBar.append(progressFill);
  progress.append(progressBar); wrap.append(progress);
  const face = el("div", "face");
  const s = item.snippet;

  face.append(el("div", "word", item.card.key));
  if (s?.phonetic) {
    const phon = el("div", "phon");
    // 念 s.text 而不是卡面上的 item.card.key：卡面是词元（leak），音标配的是原形式（leaks）
    fillMeta(phon, { phonetic: s.phonetic, pos: s.pos, word: s.text }, "  ");
    face.append(phon);
  }

  if (!revealed) {
    face.append(el("div", "note", `Appears in ${quantity(item.articleCount, "article")} · Reviews: ${item.card.reps}`));
    wrap.append(face);
    const showBtn = el("button", "mini reveal", coarsePointer() ? "Show answer" : "Show answer (Space)");
    showBtn.style.marginTop = "14px";
    showBtn.addEventListener("click", () => reveal());
    wrap.append(showBtn);
  } else {
    face.append(el("div", "answer", s?.translation ?? "(This record was deleted.)"));
    if (s?.contextNote) face.append(el("div", "note", s.contextNote));
    if (s) {
      const src = el("div", "src");
      src.append(...highlight(s.context || s.text, s.text));
      const from = el("div");
      from.style.marginTop = "5px";
      from.append(el("span", undefined, `—— ${s.articleTitle || hostnameOf(s.url)}`));
      src.append(from);
      face.append(src);
    }
    wrap.append(face, gradeBar(item), assistBar(item));
  }

  area.append(wrap);
}

/** 在原句里把当初划中的部分标出来，比单看一个词更容易想起当时的语境。 */
function highlight(context: string, term: string): Node[] {
  const at = context.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return [document.createTextNode(context)];
  const em = el("em", undefined, context.slice(at, at + term.length));
  return [
    document.createTextNode(context.slice(0, at)),
    em,
    document.createTextNode(context.slice(at + term.length)),
  ];
}

const GRADES: Array<{ g: 1 | 2 | 3 | 4; label: string; key: string; hint: string }> = [
  { g: 1, label: "Again", key: "1", hint: "I could not recall the answer" },
  { g: 2, label: "Hard", key: "2", hint: "I recalled it with effort" },
  { g: 3, label: "Good", key: "3", hint: "I recalled it correctly" },
  { g: 4, label: "Easy", key: "4", hint: "I recalled it immediately" },
];

function ratingControls(rate: (g: 1 | 2 | 3 | 4) => void): HTMLElement {
  const wrap = el("div", "rating-controls");
  const bar = el("div", "grades");
  const help = el("details", "rating-help");
  help.append(tracked(el("summary", undefined, "How to rate your recall"), "review.rating-help"));
  for (const { g, label, key, hint } of GRADES) {
    const btn = el("button");
    btn.title = hint; btn.setAttribute("aria-label", `${label}: ${hint}`);
    // 键位提示只给有键盘的：手机上那个小数字按不了，徒增一行字
    btn.append(document.createTextNode(label), ...(coarsePointer() ? [] : [el("small", undefined, key)]));
    btn.addEventListener("click", () => rate(g));
    bar.append(btn);
    help.append(el("p", undefined, `${label} — ${hint}.`));
  }
  wrap.append(bar, help);
  return wrap;
}
const gradeBar = (item: ReviewCardView): HTMLElement => ratingControls(g => void grade(item, g));

/**
 * 评分在路上的时候不认第二下。连按两下「3」（或者按住不放）会让游标走两格：
 * 下一张卡一眼没看就被跳过去，而它的排期根本没动。
 */
let grading = false;
async function graded(event: UiEvent, byKey: boolean, work: () => Promise<void>): Promise<void> {
  if (grading) return;
  grading = true;
  paintReviewUndo();
  $("review-action-status").textContent = "";
  // 记在这道闸后面：被挡掉的第二下不是一次评分
  track(event);
  if (byKey) track("review.by-key");
  const buttons = [...document.querySelectorAll<HTMLButtonElement>(".grades button")];
  for (const b of buttons) b.disabled = true;
  try { await work(); }
  catch (err) {
    // 没记上就留在这张卡上，让人再评一次；评分条重画之前先把按钮放开
    for (const b of buttons) b.disabled = false;
    $("review-area").append(el("p", "muted small", `Could not save your rating: ${reason(err)}`));
  } finally { grading = false; paintReviewUndo(); }
}

async function grade(item: ReviewCardView, g: 1 | 2 | 3 | 4, byKey = false): Promise<void> {
  await graded("review.words.grade", byKey, () => gradeWord(item, g));
}
async function gradeWord(item: ReviewCardView, g: 1 | 2 | 3 | 4): Promise<void> {
  const currentQueue = queue, index = cursor;
  const result = await send<{ ok: boolean; eventId?: string; error?: string }>({ type: "review:grade", cardId: item.card.id, grade: g });
  if (!result?.ok) throw new Error(result?.error ?? "This card no longer exists. Refresh the review queue.");
  if (queue !== currentQueue || cursor !== index || queueKind !== "words") return;
  lastRating = result.eventId ? { kind: "words", queue, index, eventId: result.eventId } : null;
  cursor += 1;
  revealed = false;
  renderReview();
  // 评分会改变到期分布，顺手刷新一下顶部统计
  await refreshReviewStats("words");
}

async function refreshReviewStats(kind: Queue): Promise<void> {
  try {
    const stats = kind === "words" ? await send<ReviewStats>({ type: "review:stats" })
      : (await send<{ stats: ReviewStats }>({ type: "article:review-due", limit: 0 })).stats;
    if (kind === queueKind) renderStats(stats, kind);
  } catch { $("review-action-status").textContent = "Your review was saved, but totals could not refresh."; }
}

$("review-undo").addEventListener("click", async () => {
  if (grading || !lastRating) return;
  const prior = lastRating;
  grading = true; paintReviewUndo();
  $("review-action-status").textContent = "Undoing rating…";
  try {
    const result = await send<ReviewUndoResult>({ type: "review:undo", eventId: prior.eventId });
    if (!result.ok) throw new Error(result.error);
    track("review.undo");
    lastRating = null;
    if (prior.kind === "words" && result.kind === "word" && queue === prior.queue && queueKind === "words") {
      queue[prior.index] = { ...queue[prior.index]!, card: result.card };
      cursor = prior.index; revealed = true; renderReview();
    } else if (prior.kind === "articles" && result.kind === "article" && aQueue === prior.queue && queueKind === "articles") {
      aQueue[prior.index] = { ...aQueue[prior.index]!, card: result.card };
      aCursor = prior.index; aRevealed = true; renderArticleReview();
    }
    $("review-action-status").textContent = "Rating undone. Choose the rating you intended.";
    await refreshReviewStats(prior.kind);
  } catch (err) { $("review-action-status").textContent = `Could not undo: ${reason(err)}`; }
  finally { grading = false; paintReviewUndo(); }
});

/** 翻卡本身不花 token（用的是划词时存下的内容），这几个按钮才会调 LLM。 */
function assistBar(item: ReviewCardView): HTMLElement {
  const box = el("div", "assist");
  const bar = el("div", "bar");
  const out = el("div", "out");
  out.hidden = true;

  const modes: Array<{ mode: "example" | "explain" | "quiz"; label: string }> = [
    { mode: "example", label: "Another example" },
    { mode: "explain", label: "Explain differently" },
    { mode: "quiz", label: "Quiz me" },
  ];
  for (const { mode, label } of modes) {
    const btn = tracked(el("button", "mini", label), `review.assist.${mode}`);
    btn.addEventListener("click", async () => {
      out.hidden = false;
      out.textContent = "Asking the model…";
      for (const b of bar.querySelectorAll("button")) b.disabled = true;
      // 后台拒掉请求（刚重启、还没醒）时也得把按钮放开，不然「正在问…」和一排死按钮要挂到刷新为止
      try {
        const res = await send<{ ok: boolean; text?: string; error?: string; needsConfig?: boolean }>({
          type: "review:assist",
          cardId: item.card.id,
          mode,
        });
        out.textContent = res.ok
          ? (res.text ?? "")
          : res.needsConfig
            ? (res.error ?? "Configure your model connection in Settings first.")
            : `Failed: ${res.error ?? "Unknown error"}`;
      } catch (err) {
        out.textContent = `Failed: ${reason(err)}. Select again to retry.`;
      } finally {
        for (const b of bar.querySelectorAll("button")) b.disabled = false;
      }
    });
    bar.append(btn);
  }
  box.append(bar, out);
  return box;
}

/** byKey：这一下是空格按出来的。键盘和鼠标走的是同一条路，只在这儿分得开。 */
function reveal(byKey = false): void {
  track("review.words.reveal");
  if (byKey) track("review.by-key");
  revealed = true;
  renderReview();
}

// 键盘流：空格翻面，1-4 评分。复习时手不用离开键盘。
document.addEventListener("keydown", (e) => {
  if ($("pane-review").hidden) return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const onArticles = queueKind === "articles";
  const item = onArticles ? aQueue[aCursor] : queue[cursor];
  if (!item) return;
  const open = onArticles ? aRevealed : revealed;

  if (e.code === "Space") {
    e.preventDefault();
    if (!open) (onArticles ? revealArticle : reveal)(true);
    return;
  }
  if (!open) return;
  // 按住不放的自动重复不算数
  if (e.repeat) return;
  const hit = GRADES.find((x) => x.key === e.key);
  if (!hit) return;
  e.preventDefault();
  if (onArticles) void gradeArticle(item as ArticleReviewView, hit.g, true);
  else void grade(item as ReviewCardView, hit.g, true);
});

/* ==================== 文章回顾 ==================== */

let aQueue: ArticleReviewView[] = [];
let aCursor = 0;
let aRevealed = false;

async function loadArticleQueue(): Promise<void> {
  clearReviewUndo();
  await guarded($("review-area"), async () => {
    const res = await send<{ items: ArticleReviewView[]; stats: ReviewStats }>({
      type: "article:review-due",
      limit: 30,
    });
    aQueue = res.items ?? [];
    aCursor = 0;
    aRevealed = false;
    renderStats(res.stats, "articles");
    renderArticleReview();
  });
}

/** 打开某一篇的回顾：装好这一篇就切过去，不要被队列的自动加载覆盖。 */
async function openArticleReview(articleId: string): Promise<void> {
  clearReviewUndo();
  const res = await send<{ items: ArticleReviewView[]; stats: ReviewStats }>({
    type: "article:review-due",
    articleId,
  });
  if (res.items.length === 0) {
    // 没有卡的原因不止一种，问清楚再说——直接退回队列会让人一头雾水
    setQueue("articles", false);
    show("review", false);
    const st = await send<ArticleReviewState>({ type: "article:review-state", articleId });
    renderNoCard(st);
    return;
  }
  aQueue = res.items;
  aCursor = 0;
  aRevealed = false;
  setQueue("articles", false);
  show("review", false);
  renderStats(res.stats, "articles");
  renderArticleReview();
}

/** 点了「回顾」却没有卡：说清是哪一种情况，以及该怎么办。 */
function renderNoCard(st: ArticleReviewState): void {
  const area = $("review-area");
  area.textContent = "";
  aQueue = [];
  const msg = !st.finished
    ? "Finish this article to add it to the review queue automatically."
    : st.hasText
      ? "Review materials are still being prepared. Try again shortly."
      : "This article was finished before article reviews were available, so its text was not saved. Read it again to the completion threshold to prepare review materials.";
  area.append(el("div", "empty", msg));
}

function renderArticleReview(): void {
  paintReviewUndo();
  const area = $("review-area");
  area.textContent = "";

  const item = aQueue[aCursor];
  if (!item) {
    const msg =
      aQueue.length === 0 ? "No articles due now. Finish an article and it will appear here for review in a few days." : "Article review complete 🎉";
    area.append(el("div", "empty", msg));
    return;
  }

  const a = item.article;
  const wrap = el("div", "reviewer wide");
  const face = el("div", "face");

  face.append(el("div", "atitle", a.title || a.url));
  const bits = [hostnameOf(a.url)];
  if (a.finishedTs) bits.push(`Finished on ${fmtDate(a.finishedTs)}`);
  bits.push(`${quantity(a.sessionCount, "focus session")}`, formatDuration(a.totalMs));
  if (item.card.reps > 0) bits.push(`Reviews: ${item.card.reps}`);
  face.append(el("div", "ameta", bits.join(" · ")));

  const r = item.review;
  if (!r) {
    face.append(el("div", "note", "No review materials for this article yet."));
    wrap.append(face, articleTools(item, false));
  } else if (!aRevealed) {
    // 先自己想，再翻开对答案——比直接读摘要记得牢
    if (r.questions.length > 0) {
      face.append(el("div", "lead", "Try recalling it first"));
      const ol = el("ol", "qs");
      for (const q of r.questions) ol.append(el("li", undefined, q));
      face.append(ol);
    } else {
      face.append(el("div", "note", "No recall questions were generated. You can view the outline."));
    }
    wrap.append(face);
    const btn = el("button", "mini reveal", coarsePointer() ? "Show outline" : "Show outline (Space)");
    btn.style.marginTop = "14px";
    btn.addEventListener("click", () => revealArticle());
    wrap.append(btn);
  } else {
    face.append(el("div", "lead", "What was this article about?"));
    const ol = el("ol", "ol");
    for (const line of r.outline) ol.append(el("li", undefined, line));
    face.append(ol);
    wrap.append(face, articleGradeBar(item), articleTools(item, true));
  }

  area.append(wrap);
}

function revealArticle(byKey = false): void {
  track("review.articles.reveal");
  if (byKey) track("review.by-key");
  aRevealed = true;
  renderArticleReview();
}

function articleGradeBar(item: ArticleReviewView): HTMLElement {
  return ratingControls(g => void gradeArticle(item, g));
}

async function gradeArticle(item: ArticleReviewView, g: 1 | 2 | 3 | 4, byKey = false): Promise<void> {
  await graded("review.articles.grade", byKey, () => gradeArticleCard(item, g));
}
async function gradeArticleCard(item: ArticleReviewView, g: 1 | 2 | 3 | 4): Promise<void> {
  const currentQueue = aQueue, index = aCursor;
  const result = await send<{ ok: boolean; eventId?: string; error?: string }>({ type: "article:review-grade", articleId: item.article.id, grade: g });
  if (!result?.ok) throw new Error(result?.error ?? "This article no longer exists. Refresh the review queue.");
  if (aQueue !== currentQueue || aCursor !== index || queueKind !== "articles") return;
  lastRating = result.eventId ? { kind: "articles", queue: aQueue, index, eventId: result.eventId } : null;
  aCursor += 1;
  aRevealed = false;
  renderArticleReview();
  // 评分改变了到期分布，重取统计而不是自己减——和生词那边一致
  await refreshReviewStats("articles");
}

/** 打开原文 + 生成/重新生成。这两个按钮是这一页唯一会花 token 的地方。 */
function articleTools(item: ArticleReviewView, has: boolean): HTMLElement {
  const box = el("div", "assist");
  const bar = el("div", "bar");
  const out = el("div", "out");
  out.hidden = true;

  const open = tracked(el("button", "mini", "Open original"), "review.articles.source");
  open.addEventListener("click", () => window.open(item.article.url, "_blank", "noreferrer"));

  const gen = tracked(el("button", "mini", has ? "Regenerate" : "Generate review"), "review.articles.generate");
  gen.addEventListener("click", async () => {
    out.hidden = false;
    out.textContent = "Reading the article and preparing your review… This may take a moment.";
    for (const b of bar.querySelectorAll("button")) b.disabled = true;
    let res: ArticleReviewOutcome;
    try {
      res = await send<ArticleReviewOutcome>({
        type: "article:review",
        articleId: item.article.id,
        regenerate: has,
      });
    } catch (err) {
      out.textContent = `Failed: ${reason(err)}. Select again to retry.`;
      return;
    } finally {
      for (const b of bar.querySelectorAll("button")) b.disabled = false;
    }
    if (res.ok && res.review) {
      item.review = res.review;
      aRevealed = false;
      renderArticleReview();
      return;
    }
    out.textContent = res.noText
      ? "The article text was not saved because article reviews were added later. Read it again to save the text."
      : res.needsConfig
        ? (res.error ?? "Configure your model connection in Settings first.")
        : `Failed: ${res.error ?? "Unknown error"}`;
  });

  bar.append(open, gen);
  box.append(bar, out);
  return box;
}

/* ==================== 启动 ==================== */
decorateIcons();
const addDialog = $<HTMLDialogElement>("article-dialog");
$("add-article")?.addEventListener("click", () => { track("articles.add"); $("add-hint").hidden = true; addDialog.showModal(); });
$("close-add")?.addEventListener("click", () => addDialog.close());
addDialog?.addEventListener("click", event => {
  if (event.target === addDialog) {
    const bounds = addDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) addDialog.close();
  }
});
if (!document.body.classList.contains("app")) $("add")?.addEventListener("submit", event => {
  event.preventDefault();
  const input = $<HTMLInputElement>("add-url");
  try {
    const url = new URL(input.value.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("Enter an article URL starting with http:// or https://");
    const go = $<HTMLButtonElement>("add-go"); go.disabled = true;
    void chrome.tabs.create({ url: url.href }).then(() => { addDialog.close(); input.value = ""; }).catch(error => {
      $("add-hint").hidden = false; $("add-hint").textContent = reason(error);
    }).finally(() => { go.disabled = false; });
  } catch (error) { $("add-hint").hidden = false; $("add-hint").textContent = reason(error); }
});
window.addEventListener("load", () => { document.documentElement.scrollTop = 0; }, { once: true });
document.querySelector(".app-sidebar .brand")?.addEventListener("click", e => { e.preventDefault(); show("articles"); });
$("words-review")?.addEventListener("click", () => { track("nav.review"); setQueue("words", false); show("review"); });
const openSearch = (): void => { show("articles"); if ($("article-tools")) $<HTMLDetailsElement>("article-tools").open = true; setSearchOpen(true); searchInput.focus(); };
$("show-books")?.addEventListener("click", () => { track("nav.books"); show("books"); });
$("reading-back")?.addEventListener("click", () => { track("nav.articles"); show("articles"); });
$("reading-statistics")?.addEventListener("click", () => { track("nav.stats"); show("stats"); });
$("review-back")?.addEventListener("click", () => show("words"));
$("article-tools")?.addEventListener("toggle", () => renderArticles());
$("workspace-search")?.addEventListener("click", openSearch);
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); }
});
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
  button.addEventListener("click", () => {
    track(button.dataset.view === "grid" ? "articles.view.grid" : "articles.view.list");
    $("articles").classList.toggle("grid-view", button.dataset.view === "grid");
    for (const other of document.querySelectorAll("[data-view]")) other.setAttribute("aria-pressed", String(other === button));
  });
}

/*
 * hash 形如 `#review` 或 `#review:<articleId>`——后者是 popup 的「去回顾」直达。
 * articleId 本身是 URL，里面就有冒号，所以只按**第一个**冒号切。
 */
const raw = location.hash.slice(1);
const sep = raw.indexOf(":");
const initial = (sep < 0 ? raw : raw.slice(0, sep)) as Pane;
const target = sep < 0 ? "" : decodeURIComponent(raw.slice(sep + 1));

if (initial === "review" && target) {
  show("review", false);
  void openArticleReview(target);
} else {
  show(PANES.includes(initial) && $(`pane-${initial}`) ? initial : "articles");
}
// 无论进哪个标签页，先把两个队列的待办数取回来标在导航上
void (async () => {
  const [w, a] = await Promise.all([
    send<ReviewStats>({ type: "review:stats" }),
    // limit 0：只要统计，不必把整个队列拖回来
    send<{ items: ArticleReviewView[]; stats: ReviewStats }>({ type: "article:review-due", limit: 0 }),
  ]);
  dueWords = w.dueNow;
  dueArticles = a.stats.dueNow;
  paintBadge();
})();
