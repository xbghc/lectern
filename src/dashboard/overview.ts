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
import { icon, type IconName } from '../ui/icons.ts';
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
    el('strong', { class: 'metric-value' }, [value]), el('span', { class: 'metric-note' }, [note])]);
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
      el('div', { class: 'phone-continue-label' }, [el('span', {}, ['接着读']), icon('bookmark')]),
      el('h2', {}, [target.title]), el('p', {}, [target.source]),
      el('div', { class: 'progress' }, [el('i', { style: `width:${target.progress}%` })]),
      el('div', { class: 'phone-continue-bottom' }, [el('span', {}, [`已读 ${target.progress}%`]),
        el('a', { class: 'primary', href: `read.html?u=${encodeURIComponent(target.articleId)}&from=articles`, 'data-track': 'articles.open' }, ['继续阅读', icon('arrow')])]),
    ]));
    return;
  }
  const next = articles.filter(a => !a.finished && !parseChapterId(a.id)).sort((a,b) => b.lastSeenTs - a.lastSeenTs)[0];
  const continueBox = $('continue-reading');
  if (next) {
    const left = estimateArticle(next, speed);
    const ratio = next.trackedWords > 0 ? Math.min(100, Math.round(next.wordsRead / next.trackedWords * 100)) : 0;
    const link = el('a', { class: 'primary', href: next.url, target: '_blank', rel: 'noreferrer', 'data-track': 'articles.open' }, ['继续阅读', icon('arrow')]);
    // Uses the same reader routing as article titles in the Android host.
    const content = el('div', { class: 'continue-body' }, [el('span', { class: 'continue-label' }, ['上次停下的地方，仍在这里']),
      el('h2', {}, [next.title || hostnameOf(next.url)]), el('p', {}, [hostnameOf(next.url)]),
      el('div', { class: 'continue-bottom' }, [link, el('div', { class: 'continue-progress' }, [
        el('div', { class: 'progress' }, [el('i', { style: `width:${ratio}%` })]),
        el('span', {}, [`已读 ${ratio}%${left && left.words > 0 ? ` · 还需 ${formatEstimate(left.ms)}` : ''}`])])])]);
    const book = el('div', { class: 'book-art', 'aria-hidden': 'true' }, [el('div', { class: 'book-jacket' }, [icon('book'), el('span', {}, ['Lectern']), el('i')])]);
    continueBox.replaceChildren(el('div', { class: 'section-heading' }, [el('h2', {}, ['接着读'])]), el('div', { class: 'continue-card' }, [content, book]));
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
    const metrics = [metric('近 7 天专注', formatDuration(activity.totalMs), '留给阅读的时间', 'clock'),
      metric('近 7 天读完', `${finished} 篇`, '读过的每一页，都算数', 'book'),
      metric('近 7 天积累', `${newWords} 条`, '在阅读中，慢慢生长', 'words')];
    const rhythm = el('div', { class: 'reading-metric metric-rhythm' }, [el('span', { class: 'metric-label' }, [icon('chart'), '近 7 天阅读节奏']), weekChart(activity)]);
    $('reading-metrics').replaceChildren(...metrics, rhythm);
    $('nav-word-count').textContent = String(words.snippets.length);
    const due = review.dueNow + articleReview.stats.dueNow;
    const prompt = el('section', { class: 'review-prompt' }, [
      el('div', { class: 'section-heading' }, [el('h2', {}, ['让记忆，再深一点']), icon('review')]),
      el('div', { class: 'due-figure' }, [el('strong', { id: 'home-due-count' }, [String(due)]), el('span', {}, ['个待复习']), el('div', { class: 'flash-art', 'aria-hidden': 'true' }, [el('i'), el('i', {}, ['Aa'])])]),
      el('p', {}, [due ? '读过的词，值得再见一面。花几分钟，把它们留在记忆里。' : '今天的到期复习已完成。去读点文章，继续新的发现。']),
      action(due ? '开始复习' : '查看复习', () => navigate('review', !review.dueNow && articleReview.stats.dueNow ? 'articles' : 'words'), 'primary', 'nav.review'),
      el('small', {}, ['间隔重复 · 按你的记忆节奏']),
    ]);
    const week = el('section', { class: 'week-panel' }, [el('div', { class: 'section-heading' }, [el('h2', {}, ['这一周的阅读']), action('统计', () => navigate('stats'), 'text-btn', 'nav.stats')]),
      el('div', { class: 'week-total' }, [minutes(activity.totalMs), el('small', {}, [' 分钟，留给了自己。'])]), weekChart(activity)]);
    const latest = [...words.snippets].sort((a,b) => b.createdTs - a.createdTs)[0];
    const word = el('section', { class: 'word-panel' }, [el('div', { class: 'section-heading' }, [el('h2', {}, ['最近遇见的词'])])]);
    if (latest) word.append(el('h3', {}, [latest.text]), el('p', {}, [latest.translation]),
      ...(latest.context ? [el('blockquote', {}, [latest.context])] : []), action('去生词本看看', () => navigate('words'), 'text-btn', 'nav.words'));
    else word.append(el('p', {}, ['在文章中选中文字，留下你的第一条划词。']));
    $('reading-rail').replaceChildren(prompt, week, word);
  } catch {
    if (!disposed && typeof document !== 'undefined' && request === homeRequest) $('reading-metrics').replaceChildren(el('p', { class: 'muted small' }, ['阅读概览暂时无法读取。文章列表仍可使用。']));
  }
}

export async function renderStatistics(root: HTMLElement): Promise<void> {
  const [snapshot, overview, list] = await Promise.all([
    ask<{ sessions: ActivitySession[] }>({ type: 'stats:activity' }), ask<Overview>({ type: 'stats:overview' }),
    ask<{ articles: Article[] }>({ type: 'articles:list' }),
  ]);
  const activity = readingActivity(snapshot.sessions, Date.now());
  const metrics = el('div', { class: 'reading-metrics' }, [metric('近 7 天专注', formatDuration(activity.totalMs), '按本地日期统计', 'clock'),
    metric('今天', `${minutes(activity.today.totalMs)} 分钟`, `${activity.today.count} 段专注`, 'chart'),
    metric('今日最长连续', formatDuration(activity.longestMs), '同一片段内的专注时间', 'clock'),
    metric('阅读速度', `${Math.round(wordsPerMinute(overview.wordsRead, overview.readingMs))} 字/分`, '仅计读到新内容的时间', 'book')]);
  const trend = el('section', { class: 'stats-trend' }, [el('h2', {}, ['近 7 天的阅读节奏']), weekChart(activity), sessionTimeline(activity)]);
  const detail = el('details', { class: 'stats-detail' }, [el('summary', {}, ['回合与片段的明细'])]);
  const dl = el('dl', { class: 'kv' });
  for (const [label, value] of [['专注回合', `${overview.episodeCount} 回`], ['回合中位数', formatDuration(overview.episodeMedianMs)], ['最长回合', formatDuration(overview.longestEpisodeMs)], ['专注片段', `${overview.sessionCount} 段`], ['片段中位数', formatDuration(overview.medianMs)], ['片段 P90', formatDuration(overview.p90Ms)], ['回合 P90', formatDuration(overview.episodeP90Ms)], ['切换频率', `${Math.round(overview.switchesPerHour)} 次/时`]]) dl.append(el('dt', {}, [label!]), el('dd', {}, [value!]));
  detail.append(el('p', { class: 'muted small' }, [`同一篇文章内间隔不超过 ${formatDuration(overview.episodeGapMs)} 的片段合成一回合；以下按最近 168 小时计算。`]), dl);
  const history = el('section', { class: 'stats-history' }, [el('h2', {}, ['阅读历史'])]);
  const records = list.articles.filter(a => a.sessionCount > 0);
  for (const article of records) {
    const row = el('details', { class: 'stats-article' });
    row.append(el('summary', { 'data-track': 'stats.history' }, [el('span', {}, [article.title || hostnameOf(article.url)]), el('small', {}, [`${formatDuration(article.totalMs)} · ${article.sessionCount} 段`])]));
    row.addEventListener('toggle', () => {
      if (!row.open || row.childElementCount > 1) return;
      const body = el('div', { class: 'session-list' }, ['正在读取…']); row.append(body);
      const load = (): void => { void ask<{ sessions: ActivitySession[] }>({ type: 'article:sessions', articleId: article.id }).then(data => {
        body.replaceChildren(...data.sessions.map(s => el('div', {}, [el('span', {}, [`${new Date(s.startTs).toLocaleDateString('zh-CN')} ${time(s.startTs)}–${time(s.endTs)}`]), el('strong', {}, [formatDuration(s.endTs - s.startTs)])])));
      }).catch(() => { body.replaceChildren(action('读取失败，重试', load, 'text-btn')); }); }; load();
    });
    history.append(row);
  }
  if (!records.length) history.append(el('p', { class: 'empty' }, ['还没有阅读记录。打开一篇文章读一会儿，它就会出现在这里。']));
  root.replaceChildren(metrics, ...overviewInsights(overview).map(text => el('p', { class: 'insight' }, [text])), trend, detail, history);
}
