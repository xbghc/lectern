import { handle } from '../src/background/handle.ts';
import { installChromeShim, memoryBackend } from '../src/app/shim.ts';
import { chapterId } from '../src/books/types.ts';
import { ARTICLE_URL, BOOK_ID, fixtures } from './fixtures.ts';
import { matchesUrlRules } from "../src/lib/url.ts";
import type { Settings } from "../src/types.ts";
import type { AnyMessage, PageState } from '../src/types.ts';
import type { SyncStatus } from '../src/sync/engine.ts';

declare global { interface Window { __PREVIEW__: { state: string; tab: string; page: string }; __previewErrors: string[]; __PREVIEW_SEARCH__: string } }
const options = window.__PREVIEW__;
window.__PREVIEW_SEARCH__ = options.tab === 'bookReader' ? `?u=${encodeURIComponent(chapterId(BOOK_ID, 0))}&from=books` : `?u=${encodeURIComponent(ARTICLE_URL)}`;
const seed = fixtures(options.state === 'empty');
let syncStatus: SyncStatus = {
  enabled: options.state !== 'empty', baseUrl: options.state === 'empty' ? '' : 'https://sync.example.com',
  tokenSet: options.state !== 'empty', deviceId: 'storybook-device', pending: options.state === 'error' ? 3 : 0,
  lastSuccess: options.state === 'empty' ? null : Date.now() - 60_000,
  error: options.state === 'error' ? "Server temporarily unreachable (preview)" : null, running: options.state === 'loading',
  blocked: options.state === 'error' ? 2 : 0, blockedReasons: options.state === 'error' ? ["Legacy article, https://example.com/legacy: missing or invalid trackedWords or reachedBottom fields; 1 associated focus session remains on this device"] : [],
  blockedMaterials: options.state === 'error' ? 1 : 0,
  ...(options.state === 'empty' ? {} : { userId: 'preview-user', serverId: 'preview-server' }),
};
const storage = memoryBackend();
void storage.set(seed.data);
window.__previewErrors = [];
window.addEventListener('error', event => window.__previewErrors.push(event.message));
window.addEventListener('unhandledrejection', event => window.__previewErrors.push(String(event.reason)));
// All persisted data belongs to this frame, including the App update preferences.
const preferences = new Map<string, string>([['fs:update:auto', 'off']]);
Object.defineProperty(window, 'localStorage', { value: {
  getItem: (key: string) => preferences.get(key) ?? null,
  setItem: (key: string, value: string) => preferences.set(key, value), removeItem: (key: string) => preferences.delete(key),
  clear: () => preferences.clear(), key: (index: number) => [...preferences.keys()][index] ?? null,
  get length() { return preferences.size; },
} });
window.fetch = async () => { throw new Error("Storybook uses local sample data and does not send requests to external services"); };
window.open = () => null;
window.close = () => undefined;
document.addEventListener('click', event => {
  const target = event.target as Element;
  const link = target?.closest?.('a[href]');
  if (link) event.preventDefault();
  // 页内锚点（设置页的分区目录）不能放行——预览页带着 <base>，#id 会解析成站外地址；就地滚过去
  const anchor = link?.getAttribute('href');
  if (anchor?.startsWith('#')) document.getElementById(anchor.slice(1))?.scrollIntoView();
  if (target?.closest?.('#refetch')) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);
document.addEventListener('submit', event => { if ((event.target as HTMLElement)?.id === 'chat-form') return; event.preventDefault(); event.stopImmediatePropagation(); }, true);

export const shim = installChromeShim({
  storage, version: '0.3.5', navigate: url => console.info('[Storybook navigation]', url),
  async handle(raw, sender) {
    const sync = raw as { type: string; baseUrl?: string; token?: string; enabled?: boolean };
    if (sync.type === 'sync:get') return { ...syncStatus };
    // 预览里没有真的同步库：三篇文章各摆一种处境，详情里三种说法都看得到
    if (sync.type === 'sync:material') {
      const at = seed.articles.findIndex(a => a.id === (raw as { articleId?: string }).articleId);
      return options.state === 'empty' || at < 0 ? { state: 'local', waiting: [], reasons: [] }
        : at === 0 ? { state: 'synced', waiting: [], reasons: [] }
        : at === 1 ? { state: 'pending', waiting: [["Focus sessions", 1], ["Paragraphs", 12]], reasons: [] }
        : { state: 'blocked', waiting: [["Article records", 1], ["Focus sessions", 2]], reasons: ["Missing or invalid trackedWords or reachedBottom fields"] };
    }
    if (sync.type.startsWith('sync:')) {
      if (sync.type === 'sync:disconnect') {
        syncStatus = { ...syncStatus, enabled: false, tokenSet: false, error: null, running: false };
        return { ok: true, status: { ...syncStatus } };
      }
      if (sync.type === 'sync:configure' && sync.enabled === false) {
        syncStatus = { ...syncStatus, enabled: false, running: false };
        return { ok: true, status: { ...syncStatus } };
      }
      if (options.state === 'error') return { ok: false, error: "Server temporarily unreachable (preview)" };
      if (sync.type === 'sync:configure') syncStatus = { ...syncStatus, enabled: true,
        baseUrl: sync.baseUrl ?? syncStatus.baseUrl, tokenSet: !!sync.token || syncStatus.tokenSet,
        userId: 'preview-user', serverId: 'preview-server', error: null };
      if (sync.type === 'sync:run') syncStatus = { ...syncStatus, pending: 0, lastSuccess: Date.now(), running: false };
      return { ok: true, userId: 'preview-user', serverId: 'preview-server', status: { ...syncStatus } };
    }
    const msg = raw as AnyMessage;
    switch (msg.type) {
      case 'article:classify-history':
        if (options.state === 'loading') return new Promise(() => {});
        await new Promise(resolve => setTimeout(resolve, 200));
        if (options.state === 'error' || msg.articleId.endsWith('article-2')) return { ok: false, reason: "Could not fetch the article (HTTP 403). Open the original page and try again." };
        return { ok: true, isArticle: msg.articleId !== ARTICLE_URL, source: 'saved',
          reason: msg.articleId === ARTICLE_URL ? '这是目录和推荐链接集合，不是独立文章。（模拟结果）' : '正文围绕同一主题展开说明，是独立文章。（模拟结果）' };
      case 'article:classify':
        if (options.state === 'loading') return new Promise(() => {});
        return options.state === 'error' ? { ok: false, reason: "Article detection failed: the model timed out. Refresh to try again." }
          : { ok: true, isArticle: options.state !== 'nonArticle', reason: '这是一篇完整文章' };
      case 'articles:blacklist-suggest': return options.state === 'error' ? { ok: false, error: "Model response timed out (preview)" }
        : { ok: true, suggestions: [{ pattern: msg.articleIds[0] || ARTICLE_URL, reason: '模拟建议：排除所选页面的具体路径。请核对该路径是否包含仍需记录的文章。' }] };
      case 'llm:test': return options.state === 'error' ? { ok: false, error: "Connection timed out (preview)" } : { ok: true, model: 'storybook-preview' };
      // 走真的读取，这样在预览里点「同意并开始」「撤回」能看到界面跟着变；只有「填没填过 Key」是按场景假装的
      case 'llm:get': return Promise.resolve(handle(msg, sender)).then(cfg => ({ ...(cfg as object), apiKeySet: options.state !== 'empty' }));
      case 'article:review': return { ok: true, review: seed.data[`r:${seed.articles[1]!.id}` as keyof typeof seed.data] };
      case 'review:assist': return { ok: true, text: '可以把 consolidate 和“把零散知识放在一起”联系起来。' };
      case 'page:capture': return { ok: false, error: "Screenshots require the browser extension or Android app. This is an interface preview." };
      default: return handle(msg, sender);
    }
  },
  connect(_name, port) {
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as { type: string };
      if (msg.type === 'vocab-chat') {
        if (options.state === 'error') port.postMessage({ type: 'vocab-chat-done', res: { ok: false, error: "Connection timed out (preview). You can edit your message and try again.", needsConfig: true } });
        else {
          const text = '我们先用 consolidate 练习一个真实的场景。\n\nWhat helps you consolidate what you learn from a book?\n\n用一两句英语回答，试着说明你的方法。';
          port.postMessage({ type: 'vocab-chat-partial', text: text.slice(0, 32) });
          if (options.state !== 'loading') setTimeout(() => port.postMessage({ type: 'vocab-chat-done', res: { ok: true, text } }), 80);
        }
      } else if (msg.type === 'ask') port.postMessage({ type: 'ask-done', res: { ok: true, text: '这里强调阅读后的主动回想。' } });
      else port.postMessage({ type: 'done', res: { ok: true, cached: true, snippet: seed.snippets[0]! } });
    });
  },
});
let pageState: PageState = options.state === 'nonArticle' || options.state === 'empty'
  ? { tracked: false, reason: "Not identified as an article", translateHere: 'available', screenshot: 'available' }
  : options.state === 'error' ? { tracked: false, reason: "Article detection failed: the model timed out", translateHere: 'available', screenshot: 'available' }
  : options.state === 'loading' ? { tracked: false, reason: "AI is checking whether this page is an article…", translateHere: 'available', screenshot: 'available' }
  : { tracked: true, articleId: ARTICLE_URL, title: seed.articles[0]!.title,
      totalWords: 1500, trackedWords: 1400, wordsRead: 560, paragraphCount: 18, readParagraphCount: 7, activeSince: Date.now() - 125_000,
      screenshot: 'available' };
let translationWanted = options.state === "populated";
let translationPaused = false;
Object.assign(chrome.tabs, {
  query: async () => [{ id: 1, windowId: 1, active: true, url: ARTICLE_URL, title: seed.articles[0]!.title }],
  sendMessage: async (_id: number, msg: { type: string; enabled?: boolean; paused?: boolean }) => {
    const settings = (await storage.get('settings')).settings as Settings;
    if (msg.type === 'page:translate-here') { translationWanted = true; translationPaused = false; }
    if (msg.type === 'page:translation-toggle') { translationPaused = !msg.enabled; if (msg.enabled) translationWanted = true; }
    if (msg.type === 'page:reading-pause') pageState = { ...pageState, readingPaused: msg.paused, activeSince: msg.paused ? null : Date.now() };
    const site = matchesUrlRules(ARTICLE_URL, settings.translationAllowedUrls);
    pageState.translation = { enabled: settings.translateEnabled && !translationPaused && (site || translationWanted), globallyEnabled: settings.translateEnabled, scope: site ? 'site' : 'page', paused: translationPaused };
    return pageState;
  },
});
Object.assign(chrome.sidePanel, { open: async () => undefined });
// Reader error/empty stories exercise the actual fetch error UI; the normal story uses its cache.
if (options.page === 'reader' && options.state === 'empty') void storage.remove(`rh:${ARTICLE_URL}`);
window.addEventListener('DOMContentLoaded', () => {
  const tab = options.tab === 'articleReview' ? 'review' : options.tab;
  document.querySelector<HTMLButtonElement>(`[data-tab="${tab}"]`)?.click();
  if (options.page === 'app' && tab === 'books') document.getElementById('show-books')?.click();
  if (options.page === 'app' && tab === 'stats') document.getElementById('reading-statistics')?.click();
  if (options.page === 'chat' && tab === 'conversation') setTimeout(() => document.querySelector<HTMLButtonElement>('#chat-starters button')?.click(), 100);
  if (options.page === 'app' && ['review', 'articleReview'].includes(options.tab)) document.getElementById('words-review')?.click();
  if (options.tab === 'classification') {
    const tools = document.getElementById('article-tools') as HTMLDetailsElement | null;
    if (tools) tools.open = true;
    setTimeout(() => {
      document.querySelector<HTMLButtonElement>('#manage-articles')?.click();
      document.querySelector<HTMLInputElement>('#select-articles')?.click();
      document.querySelector<HTMLButtonElement>('#classify-articles')?.click();
    }, 50);
  }
  if (options.tab === 'articleReview') document.querySelector<HTMLButtonElement>('[data-queue="articles"]')?.click();
});
