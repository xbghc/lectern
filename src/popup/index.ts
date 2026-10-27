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
    if (!next) throw new Error("This page is closed or unavailable. Return to the page and try again.");
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
    el('div', {}, [el('h3', {}, ["Today's focus"]), el('div', { class: 'focus-total' }, [total, el('span', {}, ["minutes"])])]),
    el('div', { class: 'focus-comparison' }, [delta, el('span', {}, ["vs. yesterday"])]),
  ]);
  const facts = el('div', { class: 'focus-facts' }, [el('div', {}, [el('span', {}, ["Focus sessions"]), el('strong', {}, [String(activity.today.count), el('small', {}, [" sessions"])])]), el('div', {}, [el('span', {}, ["Longest session"]), longest])]);
  const live = !!state?.activeSince;
  const current = el('div', { class: `focus-current${live ? ' is-active' : ''}` }, [
    el('div', {}, [el('span', { class: 'current-label' }, ["Current session"]), clock]),
    el('div', { class: 'current-state' }, [el('span', {}, [el('i'), state?.readingPaused ? "Paused on this page" : live ? "Tracking focus" : state?.tracked ? "Waiting for you to resume reading" : "Not tracking"]),
      el('small', {}, [state?.tracked ? hostnameOf(activeTab?.url ?? state.articleId ?? '') : state?.reason ?? "This page cannot be tracked"])])]);
  if (state?.tracked) {
    const paused = state.readingPaused === true;
    const label = paused ? "Resume focus tracking on this page" : "Pause focus tracking on this page";
    const control = button('', () => void changePage({ type: 'page:reading-pause', paused: !paused }), 'icon-btn focus-control');
    control.setAttribute('aria-label', label); control.title = label; control.append(icon(paused ? 'play' : 'pause'));
    current.append(control);
  }
  const weekTotal = el('span', {}, [`Total: ${formatDuration(activity.totalMs)}`]);
  const trend = el('section', { class: 'focus-trend' }, [el('div', { class: 'focus-section-heading' }, [el('h3', {}, ["Last 7 days"]), weekTotal]), weekChart(activity)]);
  const overview = el('div', { class: 'focus-overview' }, [heading, facts, current, sessionTimeline(activity, selected), trend]);
  if (state?.tracked) {
    const detail = el('details', { class: 'page-detail' }, [el('summary', {}, ["Current article and reading progress"])]);
    detail.open = detailOpen;
    const pct = state.trackedWords ? Math.min(100, Math.round((state.wordsRead ?? 0) / state.trackedWords * 100)) : 0;
    detail.append(el('h2', {}, [state.title || "Current article"]), el('p', { class: 'muted small' }, [`Read ${pct}% · ${state.wordsRead ?? 0} / ${state.trackedWords ?? 0} words`]), archiveControl());
    const articleId = state.articleId;
    if (articleId) void ask<ArticleReviewState>({ type: 'article:review-state', articleId }).then(info => {
      if (info?.carded) detail.append(button("Review this article", () => openDashboard(`review:${encodeURIComponent(articleId)}`), 'text-btn'));
    }).catch(() => undefined);
    overview.append(detail);
  }
  root.replaceChildren(overview);
  paintLive = () => {
    const fresh = readingActivity(sessions, Date.now(), state);
    total.textContent = minutes(fresh.today.totalMs);
    const difference = fresh.today.totalMs - fresh.yesterday.totalMs;
    delta.replaceChildren(`${difference >= 0 ? '+' : '−'}${minutes(Math.abs(difference))}`, el('span', {}, [" min"]));
    longest.textContent = formatDuration(fresh.longestMs);
    const seconds = state?.activeSince ? Math.max(0, Math.floor((Date.now() - state.activeSince) / 1000)) : 0;
    clock.textContent = state?.activeSince ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '—';
    weekTotal.textContent = `Total: ${formatDuration(fresh.totalMs)}`;
  };
  paintLive();
}
function archiveControl(): HTMLElement {
  const status = el('p', { class: 'muted small', role: 'status' });
  const save = button("Save article for syncing", () => {
    save.disabled = true; status.textContent = "Saving text and images…";
    void (async () => {
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!current?.id) throw new Error("This page is unavailable");
      const result = await chrome.tabs.sendMessage(current.id, { type: 'page:archive' }) as { ok?: boolean; missing?: number; error?: string } | undefined;
      if (!result?.ok) throw new Error(result?.error ?? "Could not finish saving. Keep the original page open and try again.");
      status.textContent = result.missing ? `Saved; ${result.missing} images could not be downloaded. Try again later.` : "Saved on this device. Connect a sync server to read it on your phone.";
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
  toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(enabled)); toggle.setAttribute('aria-label', "Translation on this page");
  toggle.disabled = !state || !globallyEnabled;
  const scope = el('select', { id: 'translation-scope' }, [el('option', { value: 'page' }, ["This page only"]), el('option', { value: 'site' }, ["Always on for this site"])]);
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
    el('div', { class: 'translation-page-context' }, [icon('book'), host || "Current page"]),
    el('div', { class: 'feature-heading' }, [el('span', { class: 'feature-icon' }, [icon('words')]), el('div', { class: 'feature-title' }, [
      el('h3', {}, ["Text translation"]), el('span', { class: `feature-state${enabled ? ' is-on' : ''}` }, [el('i'), !state ? "Translation is unavailable on this page" : !globallyEnabled ? "Disabled in settings" : enabled ? "Select text to translate" : "Off on this page"])]), toggle]),
    el('div', { class: 'translation-scope' }, [el('label', { for: 'translation-scope' }, ["Enable for"]), scope]),
    el('p', { class: 'scope-explanation' }, [!globallyEnabled ? "Enable text translation in settings." : site ? "Enabled by this site's allowlist rule. Pausing this page does not change that rule. Manage sites in settings." : "Applies to this page load. Reloading restores this site's default settings."]),
  ]);
  const shortcuts = el('div', { class: 'translation-shortcuts' });
  if (state?.screenshot === 'available') shortcuts.append(button("Screenshot translation", () => { void askPage({ type: 'page:screenshot' }).finally(() => window.close()); }));
  shortcuts.append(button(globallyEnabled ? "Open vocabulary" : "Translation settings", () => globallyEnabled ? openDashboard('words') : void chrome.runtime.openOptionsPage(), 'text-btn'));
  feature.append(shortcuts);
  const panel = button("Words on this page", () => {
    if (currentWindowId === null) return;
    // sidePanel.open must stay in the synchronous user gesture.
    void chrome.sidePanel.open({ windowId: currentWindowId }).then(() => window.close()).catch(error => {
      feature.append(el('p', { role: 'alert' }, [reasonOf(error)]));
    });
  }, 'text-btn');
  panel.id = 'open-panel'; feature.append(panel);
  if (state && !state.tracked) feature.append(archiveControl());
  if (!rules) {
    rules = el('details', { class: 'rulechat-wrap', id: 'rule-chat' }, [el('summary', {}, ["Edit blocklists and allowlists in plain language"])]);
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
    panels[tab].replaceChildren(el('p', { role: 'alert' }, [`Could not load: ${reasonOf(error)}`]), button("Retry", () => void refresh()));
  }
}
function selectTab(next: keyof typeof panels): void {
  tab = next;
  for (const [key, root] of Object.entries(panels)) root.hidden = key !== tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const active = b.dataset.tab === tab;
    b.classList.toggle('is-active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
  }
  $('dashboard-label').textContent = tab === 'current' ? "View all statistics" : "Open Lectern";
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
