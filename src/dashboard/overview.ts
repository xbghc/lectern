import { quantity } from "../ui/text.ts";
import type { Article, ArticleReviewView, Overview, ReviewStats, Snippet, SpeedSummary } from '../types.ts';
import { readingActivity, type ActivitySession } from '../lib/activity.ts';
import { overviewInsights, wordsPerMinute } from '../lib/stats.ts';
import { estimateArticle, formatEstimate } from '../lib/readingTime.ts';
import { hostnameOf } from '../lib/url.ts';
import { readingResume } from '../books/progress.ts';
import type { Book } from '../books/types.ts';
import { parseChapterId } from '../books/types.ts';
import { el } from '../popup/dom.ts';
import type { UiEvent } from '../lib/uiUsage.ts';
import { icon, iconButton, type IconName } from '../ui/icons.ts';
import { minutes, sessionTimeline, weekChart, time, duration as formatDuration } from '../ui/activity.ts';

const ask = <T,>(message: unknown): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>;
const $ = (id: string): HTMLElement => document.getElementById(id)!;
let disposed = false;
window.addEventListener('pagehide', () => { disposed = true; homeRequest++; });
const action = (label: string, run: () => void, className = 'primary', event?: UiEvent): HTMLButtonElement => {
  const b = el('button', { type: 'button', class: className }, [label, icon('arrow')]); b.addEventListener('click', run); if (event) b.dataset.track = event; return b;
};
function metric(label: string, value: string, note: string, name: IconName): HTMLElement {
  return el('div', { class: 'reading-metric' }, [el('span', { class: 'metric-label' }, [icon(name), label]),
    el('strong', { class: 'metric-value' }, [value]), ...(note ? [el('span', { class: 'metric-note' }, [note])] : [])]);
}
let homeRequest = 0;
export async function renderReadingHome(articles: Article[], speed: SpeedSummary | null, navigate: (pane: 'review' | 'words' | 'stats', queue?: 'words' | 'articles') => void, books: Record<string, Book> = {}): Promise<void> {
  const request = ++homeRequest;
  if (document.body.classList.contains('app')) {
    const target = readingResume(articles, books);
    document.body.dataset.resumeArticle = target?.articleId ?? '';
    const root = $('continue-reading');
    if (!target) { root.replaceChildren(); return; }
    root.replaceChildren(el('section', { class: 'phone-continue' }, [
      el('h2', { title: target.title }, [el('span', { class: 'phone-continue-title-fill', style: `--reading-progress:${target.progress}%` }, [target.title])]),
      el('p', { title: target.source }, [parseChapterId(target.articleId) ? target.source : hostnameOf(target.articleId)]),
      el('span', { class: 'visually-hidden', role: 'progressbar', 'aria-label': 'Reading progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(target.progress) }),
      el('div', { class: 'phone-continue-bottom' }, [
        el('a', { class: 'primary', href: `read.html?u=${encodeURIComponent(target.articleId)}&from=articles`, 'data-track': 'articles.open' }, ["Continue reading", icon('arrow')])]),
    ]));
    return;
  }
  const next = articles.filter(a => !a.finished && !parseChapterId(a.id)).sort((a,b) => b.lastSeenTs - a.lastSeenTs)[0];
  const continueBox = $('continue-reading');
  if (next) {
    const left = estimateArticle(next, speed);
    const ratio = next.trackedWords > 0 ? Math.min(100, Math.round(next.wordsRead / next.trackedWords * 100)) : 0;
    const link = el('a', { class: 'primary', href: next.url, target: '_blank', rel: 'noreferrer', 'data-track': 'articles.open' }, ["Continue reading", icon('arrow')]);
    // Uses the same reader routing as article titles in the Android host.
    const content = el('div', { class: 'continue-body' }, [
      el('h2', {}, [next.title || hostnameOf(next.url)]), el('p', {}, [hostnameOf(next.url)]),
      el('div', { class: 'continue-bottom' }, [link, el('div', { class: 'continue-progress' }, [
        el('div', { class: 'progress' }, [el('i', { style: `width:${ratio}%` })]),
        el('span', {}, [`${ratio}%${left && left.words > 0 ? ` · ${formatEstimate(left.ms)} left` : ''}`])])])]);
    const book = el('div', { class: 'book-art', 'aria-hidden': 'true' }, [el('div', { class: 'book-jacket' }, [icon('book'), el('span', {}, ['Lectern']), el('i')])]);
    continueBox.replaceChildren(el('div', { class: 'continue-card' }, [content, book]));
  } else continueBox.replaceChildren();
  try {
    const [data, words, review, articleReview] = await Promise.all([
      ask<{ sessions: ActivitySession[] }>({ type: 'stats:activity' }), ask<{ snippets: Snippet[] }>({ type: 'snippets:list' }),
      ask<ReviewStats>({ type: 'review:stats' }), ask<{ items: ArticleReviewView[]; stats: ReviewStats }>({ type: 'article:review-due', limit: 0 }),
    ]);
    if (disposed || typeof document === 'undefined' || request !== homeRequest) return;
    const activity = readingActivity(data.sessions, Date.now());
    const start = activity.days[0]!.startTs;
    const finished = articles.filter(a => !parseChapterId(a.id) && a.finished && a.finishedTs && a.finishedTs >= start).length;
    const newWords = words.snippets.filter(s => s.createdTs >= start).length;
    const metrics = [metric("Focus this week", formatDuration(activity.totalMs), "", 'clock'),
      metric("Finished this week", `${quantity(finished, "article")}`, "", 'book'),
      metric("Words this week", `${quantity(newWords, "record")}`, "", 'words')];
    $('reading-metrics').replaceChildren(...metrics);
    $('nav-word-count').textContent = String(words.snippets.length);
    const due = review.dueNow + articleReview.stats.dueNow;
    const prompt = el('section', { class: 'review-prompt' }, [
      el('div', { class: 'section-heading' }, [el('h2', {}, ["Review"]), icon('review')]),
      el('div', { class: 'due-figure' }, [el('strong', { id: 'home-due-count' }, [String(due)]), el('span', {}, [" due for review"]), el('div', { class: 'flash-art', 'aria-hidden': 'true' }, [el('i'), el('i', {}, ['Aa'])])]),
      ...(!due ? [el('p', {}, ["All caught up"])] : []),
      action(due ? "Start review" : "View review", () => navigate('review', !review.dueNow && articleReview.stats.dueNow ? 'articles' : 'words'), 'primary', 'nav.review'),
    ]);
    const statistics = iconButton('chart', 'Reading statistics');
    statistics.dataset.track = 'nav.stats'; statistics.addEventListener('click', () => navigate('stats'));
    const week = el('section', { class: 'week-panel' }, [el('div', { class: 'section-heading' }, [el('h2', {}, ["This week"]), statistics]), weekChart(activity)]);
    const latest = [...words.snippets].sort((a,b) => b.createdTs - a.createdTs)[0];
    const word = el('section', { class: 'word-panel' }, [el('div', { class: 'section-heading' }, [el('h2', {}, ["Recent word"])])]);
    if (latest) word.append(el('h3', {}, [latest.text]), el('p', {}, [latest.translation]),
      ...(latest.context ? [el('blockquote', {}, [latest.context])] : []), action("View vocabulary", () => navigate('words'), 'text-btn', 'nav.words'));
    else word.append(el('p', {}, ["Select text in an article to save your first word."]));
    $('reading-rail').replaceChildren(prompt, week, word);
  } catch {
    if (!disposed && typeof document !== 'undefined' && request === homeRequest) $('reading-metrics').replaceChildren(el('p', { class: 'muted small' }, ["The reading overview is unavailable. Your article list is still available."]));
  }
}

export async function renderStatistics(root: HTMLElement): Promise<void> {
  const [snapshot, overview, list] = await Promise.all([
    ask<{ sessions: ActivitySession[] }>({ type: 'stats:activity' }), ask<Overview>({ type: 'stats:overview' }),
    ask<{ articles: Article[] }>({ type: 'articles:list' }),
  ]);
  const activity = readingActivity(snapshot.sessions, Date.now());
  const metrics = el('div', { class: 'reading-metrics' }, [metric("Focus this week", formatDuration(activity.totalMs), "Based on local dates", 'clock'),
    metric("Today", `${minutes(activity.today.totalMs)} min`, `${quantity(activity.today.count, "focus session")}`, 'chart'),
    metric("Longest session today", formatDuration(activity.longestMs), "Focused time in one session", 'clock'),
    metric("Reading speed", `${Math.round(wordsPerMinute(overview.wordsRead, overview.readingMs))} words/min`, "Time spent reading new content only", 'book')]);
  const trend = el('section', { class: 'stats-trend' }, [el('h2', {}, ["Reading over the last 7 days"]), weekChart(activity), sessionTimeline(activity)]);
  const detail = el('details', { class: 'stats-detail' }, [el('summary', {}, ["Episodes and sessions"])]);
  const dl = el('dl', { class: 'kv' });
  for (const [label, value] of [["Focus episodes", `${quantity(overview.episodeCount, "episode")}`], ["Median episode", formatDuration(overview.episodeMedianMs)], ["Longest episode", formatDuration(overview.longestEpisodeMs)], ["Focus sessions", `${quantity(overview.sessionCount, "session")}`], ["Median session", formatDuration(overview.medianMs)], ["Session P90", formatDuration(overview.p90Ms)], ["Episode P90", formatDuration(overview.episodeP90Ms)], ["Switching frequency", `${Math.round(overview.switchesPerHour)} switches/hour`]]) dl.append(el('dt', {}, [label!]), el('dd', {}, [value!]));
  detail.append(el('p', { class: 'muted small' }, [`Sessions on the same article separated by at most ${formatDuration(overview.episodeGapMs)} form one episode. The figures below cover the last 168 hours.`]), dl);
  const history = el('section', { class: 'stats-history' }, [el('h2', {}, ["Reading history"])]);
  const records = list.articles.filter(a => a.sessionCount > 0);
  for (const article of records) {
    const row = el('details', { class: 'stats-article' });
    row.append(el('summary', { 'data-track': 'stats.history' }, [el('span', {}, [article.title || hostnameOf(article.url)]), el('small', {}, [`${formatDuration(article.totalMs)} · ${quantity(article.sessionCount, "session")}`])]));
    row.addEventListener('toggle', () => {
      if (!row.open || row.childElementCount > 1) return;
      const body = el('div', { class: 'session-list' }, ["Loading…"]); row.append(body);
      const load = (): void => { void ask<{ sessions: ActivitySession[] }>({ type: 'article:sessions', articleId: article.id }).then(data => {
        body.replaceChildren(...data.sessions.map(s => el('div', {}, [el('span', {}, [`${new Date(s.startTs).toLocaleDateString('zh-CN')} ${time(s.startTs)}–${time(s.endTs)}`]), el('strong', {}, [formatDuration(s.endTs - s.startTs)])])));
      }).catch(() => { body.replaceChildren(action("Could not load. Retry", load, 'text-btn')); }); }; load();
    });
    history.append(row);
  }
  if (!records.length) history.append(el('p', { class: 'empty' }, ["No reading history yet. Read an article for a while and it will appear here."]));
  root.replaceChildren(metrics, ...overviewInsights(overview).map(text => el('p', { class: 'insight' }, [text])), trend, detail, history);
}
