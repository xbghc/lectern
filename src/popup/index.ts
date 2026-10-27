import type { ArticleReviewState, PageState, PopupToContent } from '../types.ts';
import { readingActivity, type ActivitySession } from '../lib/activity.ts';
import { hostnameOf } from '../lib/url.ts';
import { reasonOf } from '../lib/reason.ts';
import { onSyncUpdated } from '../lib/syncUpdated.ts';
import { icon, decorateIcons } from '../ui/icons.ts';
import { minutes, sessionTimeline, weekChart, duration as formatDuration } from '../ui/activity.ts';
import { el } from './dom.ts';
import { ruleChatBox } from './ruleChat.ts';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const ask = <T,>(message: unknown): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>;
const panels = { current: $('panel-current'), translation: $('panel-translation') };
let tab: keyof typeof panels = 'current';
let state: PageState | null = null;
let activeTab: chrome.tabs.Tab | undefined;
let sessions: ActivitySession[] = [];
let refreshId = 0;
let controlBusy = false;
let currentWindowId: number | null = null;
let paintLive: (() => void) | null = null;
let rules: HTMLDetailsElement | null = null;
decorateIcons();
void chrome.windows.getCurrent().then(w => { currentWindowId = w.id ?? null; });

async function askPage(message: PopupToContent): Promise<PageState | null> {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = current;
  if (!current?.id) return null;
  try { return await chrome.tabs.sendMessage(current.id, message) as PageState; }
  catch { return null; }
}
function openDashboard(pane: string): void {
  void chrome.tabs.create({ url: `${chrome.runtime.getURL('dashboard.html')}#${pane}` });
}
function button(label: string, action: () => void, className = 'secondary'): HTMLButtonElement {
  const b = el('button', { type: 'button', class: className }, [label]);
  b.addEventListener('click', action);
  return b;
}
async function changePage(message: PopupToContent): Promise<void> {
  if (controlBusy) return;
  controlBusy = true;
  try {
    const next = await askPage(message);
    if (!next) throw new Error('页面已关闭或不支持此操作，请回到网页重试');
    state = next;
    await refresh();
  } catch (error) { panels[tab].append(el('p', { class: 'error', role: 'alert' }, [reasonOf(error)])); }
  finally { controlBusy = false; }
}
function renderFocus(): void {
  const root = panels.current;
  const selected = root.querySelector<HTMLElement>('.focus-segment[aria-pressed="true"]')?.dataset.session;
  const detailOpen = root.querySelector<HTMLDetailsElement>('.page-detail')?.open ?? false;
  const activity = readingActivity(sessions, Date.now(), state);
  const total = el('b', {}, [minutes(activity.today.totalMs)]);
  const delta = el('strong');
  const longest = el('strong', {}, [formatDuration(activity.longestMs)]);
  const clock = el('strong', { id: 'current-clock' });
  const heading = el('div', { class: 'focus-hero' }, [
    el('div', {}, [el('h3', {}, ['今日专注']), el('div', { class: 'focus-total' }, [total, el('span', {}, ['分钟'])])]),
    el('div', { class: 'focus-comparison' }, [delta, el('span', {}, ['较昨日'])]),
  ]);
  const facts = el('div', { class: 'focus-facts' }, [el('div', {}, [el('span', {}, ['专注片段']), el('strong', {}, [String(activity.today.count), el('small', {}, [' 段'])])]), el('div', {}, [el('span', {}, ['最长连续']), longest])]);
  const live = !!state?.activeSince;
  const current = el('div', { class: `focus-current${live ? ' is-active' : ''}` }, [
    el('div', {}, [el('span', { class: 'current-label' }, ['本次连续']), clock]),
    el('div', { class: 'current-state' }, [el('span', {}, [el('i'), state?.readingPaused ? '本页已暂停' : live ? '正在计时' : state?.tracked ? '等待继续阅读' : '未在计时']),
      el('small', {}, [state?.tracked ? hostnameOf(activeTab?.url ?? state.articleId ?? '') : state?.reason ?? '此页面无法追踪'])])]);
  if (state?.tracked) {
    const paused = state.readingPaused === true;
    const label = paused ? '继续本页专注统计' : '暂停本页专注统计';
    const control = button('', () => void changePage({ type: 'page:reading-pause', paused: !paused }), 'icon-btn focus-control');
    control.setAttribute('aria-label', label); control.title = label; control.append(icon(paused ? 'play' : 'pause'));
    current.append(control);
  }
  const weekTotal = el('span', {}, [`共 ${formatDuration(activity.totalMs)}`]);
  const trend = el('section', { class: 'focus-trend' }, [el('div', { class: 'focus-section-heading' }, [el('h3', {}, ['近 7 天']), weekTotal]), weekChart(activity)]);
  const overview = el('div', { class: 'focus-overview' }, [heading, facts, current, sessionTimeline(activity, selected), trend]);
  if (state?.tracked) {
    const detail = el('details', { class: 'page-detail' }, [el('summary', {}, ['当前文章与阅读进度'])]);
    detail.open = detailOpen;
    const pct = state.trackedWords ? Math.min(100, Math.round((state.wordsRead ?? 0) / state.trackedWords * 100)) : 0;
    detail.append(el('h2', {}, [state.title || '当前文章']), el('p', { class: 'muted small' }, [`已读 ${pct}% · ${state.wordsRead ?? 0} / ${state.trackedWords ?? 0} 字`]), archiveControl());
    const articleId = state.articleId;
    if (articleId) void ask<ArticleReviewState>({ type: 'article:review-state', articleId }).then(info => {
      if (info?.carded) detail.append(button('回顾这篇文章', () => openDashboard(`review:${encodeURIComponent(articleId)}`), 'text-btn'));
    }).catch(() => undefined);
    overview.append(detail);
  }
  root.replaceChildren(overview);
  paintLive = () => {
    const fresh = readingActivity(sessions, Date.now(), state);
    total.textContent = minutes(fresh.today.totalMs);
    const difference = fresh.today.totalMs - fresh.yesterday.totalMs;
    delta.replaceChildren(`${difference >= 0 ? '+' : '−'}${minutes(Math.abs(difference))}`, el('span', {}, [' 分钟']));
    longest.textContent = formatDuration(fresh.longestMs);
    const seconds = state?.activeSince ? Math.max(0, Math.floor((Date.now() - state.activeSince) / 1000)) : 0;
    clock.textContent = state?.activeSince ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '—';
    weekTotal.textContent = `共 ${formatDuration(fresh.totalMs)}`;
  };
  paintLive();
}
function archiveControl(): HTMLElement {
  const status = el('p', { class: 'muted small', role: 'status' });
  const save = button('保存文章到同步库', () => {
    save.disabled = true; status.textContent = '正在保存正文和图片…';
    void (async () => {
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!current?.id) throw new Error('当前页面不可用');
      const result = await chrome.tabs.sendMessage(current.id, { type: 'page:archive' }) as { ok?: boolean; missing?: number; error?: string } | undefined;
      if (!result?.ok) throw new Error(result?.error ?? '保存未完成，请保持原网页打开后重试');
      status.textContent = result.missing ? `已保存；${result.missing} 项图片未能获取，可稍后重试。` : '已保存在本机，连接同步服务器后可在手机阅读。';
    })().catch(error => { status.textContent = reasonOf(error); }).finally(() => { save.disabled = false; });
  });
  return el('div', { class: 'archive-control' }, [save, status]);
}
function renderTranslation(): void {
  paintLive = null;
  const root = panels.translation;
  const translation = state?.translation;
  const enabled = translation?.enabled ?? state?.translateHere === 'on';
  const globallyEnabled = translation?.globallyEnabled ?? !!state?.translateHere;
  const site = translation?.scope === 'site';
  const host = hostnameOf(activeTab?.url ?? '');
  const toggle = button('', () => void changePage({ type: 'page:translation-toggle', enabled: !enabled }), `toggle${enabled ? ' on' : ''}`);
  toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(enabled)); toggle.setAttribute('aria-label', '本页划词翻译');
  toggle.disabled = !state || !globallyEnabled;
  const scope = el('select', { id: 'translation-scope' }, [el('option', { value: 'page' }, ['仅此页面']), el('option', { value: 'site' }, ['本站始终开启'])]);
  scope.value = site ? 'site' : 'page'; scope.disabled = !globallyEnabled || !host || !enabled;
  // Broader whitelist rules must not be silently removed by a page-specific control.
  scope.options[0]!.disabled = site;
  scope.addEventListener('change', () => {
    if (scope.value !== 'site' || !activeTab?.url) return;
    scope.disabled = true;
    void ask({ type: 'translation:allow-site', url: activeTab.url }).then(() => changePage({ type: 'page:translation-toggle', enabled: true }))
      .catch(error => { scope.disabled = false; root.append(el('p', { role: 'alert' }, [reasonOf(error)])); });
  });
  const feature = el('div', { class: 'popup-feature' }, [
    el('div', { class: 'translation-page-context' }, [icon('book'), host || '当前页面']),
    el('div', { class: 'feature-heading' }, [el('span', { class: 'feature-icon' }, [icon('words')]), el('div', { class: 'feature-title' }, [
      el('h3', {}, ['划词翻译']), el('span', { class: `feature-state${enabled ? ' is-on' : ''}` }, [el('i'), !state ? '此页面不支持翻译' : !globallyEnabled ? '全局已关闭' : enabled ? '选中文字即可翻译' : '本页未开启'])]), toggle]),
    el('div', { class: 'translation-scope' }, [el('label', { for: 'translation-scope' }, ['启用范围']), scope]),
    el('p', { class: 'scope-explanation' }, [!globallyEnabled ? '可在设置中开启划词翻译。' : site ? '本站按白名单自动开启；本页暂停不改变站点规则。范围可在设置中管理。' : '仅对此次页面加载有效，刷新后恢复本站默认设置。']),
  ]);
  const shortcuts = el('div', { class: 'translation-shortcuts' });
  if (state?.screenshot === 'available') shortcuts.append(button('截图翻译', () => { void askPage({ type: 'page:screenshot' }).finally(() => window.close()); }));
  shortcuts.append(button(globallyEnabled ? '打开生词本' : '翻译设置', () => globallyEnabled ? openDashboard('words') : void chrome.runtime.openOptionsPage(), 'text-btn'));
  feature.append(shortcuts);
  const panel = button('本页生词', () => {
    if (currentWindowId === null) return;
    // sidePanel.open must stay in the synchronous user gesture.
    void chrome.sidePanel.open({ windowId: currentWindowId }).then(() => window.close()).catch(error => {
      feature.append(el('p', { role: 'alert' }, [reasonOf(error)]));
    });
  }, 'text-btn');
  panel.id = 'open-panel'; feature.append(panel);
  if (state && !state.tracked) feature.append(archiveControl());
  if (!rules) {
    rules = el('details', { class: 'rulechat-wrap', id: 'rule-chat' }, [el('summary', {}, ['用一句话改黑名单、白名单'])]);
    rules.append(ruleChatBox({ pageUrl: async () => activeTab?.url, onApplied: () => { setTimeout(() => void refresh(), 400); } }));
  }
  root.replaceChildren(feature, rules);
}
async function refresh(): Promise<void> {
  const id = ++refreshId;
  try {
    const [page, activity] = await Promise.all([askPage({ type: 'page:state' }), ask<{ sessions: ActivitySession[] }>({ type: 'stats:activity' })]);
    if (id !== refreshId) return;
    state = page; sessions = activity.sessions;
    if (tab === 'current') renderFocus(); else renderTranslation();
  } catch (error) {
    if (id !== refreshId) return;
    panels[tab].replaceChildren(el('p', { role: 'alert' }, [`读取失败：${reasonOf(error)}`]), button('重试', () => void refresh()));
  }
}
function selectTab(next: keyof typeof panels): void {
  tab = next;
  for (const [key, root] of Object.entries(panels)) root.hidden = key !== tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const active = b.dataset.tab === tab;
    b.classList.toggle('is-active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
  }
  $('dashboard-label').textContent = tab === 'current' ? '查看完整统计' : '打开读书台';
  void refresh();
}
const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
tabs.forEach((b, i) => {
  b.addEventListener('click', () => selectTab(b.dataset.tab as keyof typeof panels));
  b.addEventListener('keydown', e => {
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i + tabs.length - 1) % tabs.length : -1;
    if (next < 0) return; e.preventDefault(); tabs[next]!.focus(); tabs[next]!.click();
  });
});
$('open-home').addEventListener('click', e => { e.preventDefault(); openDashboard('articles'); });
$('open-dashboard').addEventListener('click', e => { e.preventDefault(); openDashboard(tab === 'current' ? 'stats' : 'articles'); });
$('open-options').addEventListener('click', () => void chrome.runtime.openOptionsPage());
onSyncUpdated(() => { if (!panels[tab].contains(document.activeElement)) void refresh(); });
void refresh();
let tick = 0;
const timer = setInterval(() => {
  paintLive?.();
  if (++tick % 3 === 0 && !controlBusy && !panels[tab].contains(document.activeElement)) void refresh();
}, 1000);
window.addEventListener('pagehide', () => { clearInterval(timer); refreshId++; });
