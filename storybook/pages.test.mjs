import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { compilePages } from '../.storybook/pages-plugin.mjs';

const pages = await compilePages();

test('compact reading controls keep filters, selection and book contents reachable', async () => {
  let close, confirmation = '';
  const dom = new JSDOM(pages.app.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"app",state:"populated",tab:"articles"}</script>'), {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      close = window.close.bind(window); window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.confirm = message => { confirmation = message; return false; };
    },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 60));
  try {
    await settle();
    const { document } = dom.window;
    const tools = document.getElementById('article-tools-toggle');
    tools.click(); await settle();
    assert.equal(tools.getAttribute('aria-expanded'), 'true');
    document.querySelector('#finish-filter [data-filter="done"]').click();
    assert.equal(document.querySelectorAll('#articles .article-card').length, 1);
    tools.click(); await settle();
    assert.equal(document.getElementById('article-tools').open, false);
    assert.equal(tools.dataset.filtered, 'true');
    assert.equal(document.querySelectorAll('#articles .article-card').length, 1, 'collapsing controls preserves an active filter');
    tools.click(); await settle();
    const manage = document.getElementById('manage-articles'); manage.click();
    assert.equal(manage.getAttribute('aria-label'), 'Done selecting');
    const select = document.querySelector('#articles input[type="checkbox"]'); select.checked = true;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(document.getElementById('delete-articles').disabled, false);
    tools.click(); await settle();
    assert.equal(manage.getAttribute('aria-pressed'), 'false', 'closing controls exits bulk selection');
    document.getElementById('show-books').click(); await settle();
    assert.equal(document.getElementById('pane-books').hidden, false);
    const book = document.querySelector('.book-card'), toc = book.querySelector('.book-toc');
    assert.equal(book.querySelector('[role="progressbar"]').getAttribute('aria-valuenow'), '37');
    assert.equal(book.querySelector('.shelf-cover').textContent, '', 'fallback covers do not repeat the title');
    const summary = toc.querySelector('summary');
    assert.match(summary.getAttribute('aria-label'), /Contents of/); assert.ok(summary.title);
    summary.click(); await settle();
    assert.equal(toc.open, true); assert.ok(toc.querySelectorAll('.chapter-row a').length > 0);
    const remove = book.querySelector('.book-delete');
    assert.ok(remove.getAttribute('aria-label')); assert.ok(remove.title);
    remove.click(); assert.match(confirmation, /The Art of Deep Reading/);
    assert.equal(document.querySelectorAll('.book-card').length, 1, 'cancelled deletion preserves the book');
    document.getElementById('reading-back').click(); await settle();
    assert.equal(document.getElementById('pane-articles').hidden, false);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});

test('EPUB import stays available from the shelf toolbar and its empty state', async () => {
  for (const state of ['populated', 'empty']) {
    let close, picks = 0;
    const dom = new JSDOM(pages.app.replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({page:'app',state,tab:'articles'})}</script>`), {
      url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        close = window.close.bind(window); window.structuredClone = structuredClone;
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        window.Native = { epubOpen() {}, epubPick(id) { picks++; window.__fsEpub.picked(id, '', ''); } };
      },
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 60));
    try {
      await settle();
      const { document } = dom.window, toolbar = document.getElementById('import-book');
      assert.equal(toolbar.hidden, true);
      document.getElementById('show-books').click(); await settle();
      assert.equal(toolbar.hidden, false);
      const trigger = state === 'empty' ? document.getElementById('import-book-empty') : toolbar;
      assert.equal(trigger.hidden, false); trigger.click(); await settle();
      assert.equal(picks, 1); assert.equal(toolbar.disabled, false);
      assert.equal(document.getElementById('book-status').textContent, '');
      document.getElementById('reading-back').click(); await settle();
      assert.equal(toolbar.hidden, true);
      assert.deepEqual(Array.from(dom.window.__previewErrors), []);
    } finally { close(); }
  }
});

const scenarios = [
  ['popup', 'populated', 'current', "Tracking focus"],
  ['popup', 'empty', 'current', "No focus sessions yet"],
  ['popup', 'error', 'current', "Article detection failed"],
  ['popup', 'populated', 'translation', "Text translation"],
  ['dashboard', 'populated', 'articles', "3 articles"],
  ['dashboard', 'empty', 'articles', "No reading history yet"],
  ['dashboard', 'populated', 'words', 'consolidate'],
  ['dashboard', 'populated', 'stats', "Longest session today"],
  ['app', 'populated', 'books', "The Art of Deep Reading"],
  ['dashboard', 'populated', 'review', "Show answer"],
  ['dashboard', 'populated', 'articleReview', 'Understanding the browser event loop'],
  ['dashboard', 'populated', 'classification', "AI: not an article"],
  ['dashboard', 'error', 'classification', "AI: classification failed"],
  ['app', 'populated', 'classification', "AI: not an article"],
  ['options', 'populated', 'articles', "Reading blocklist"],
  ['options', 'error', 'articles', "1 reading item (including 2 records) could not be uploaded and remain on this device"],
  ['appOptions', 'error', 'articles', "1 reading item (including 2 records) could not be uploaded and remain on this device"],
  ['sidepanel', 'populated', 'articles', 'consolidate'],
  ['app', 'populated', 'articles', "Read next"],
  ['app', 'populated', 'articles', "The Art of Deep Reading"],
  ['appOptions', 'populated', 'articles', "Settings"],
  ['app', 'populated', 'stats', "Last 30 days"],
  ['chat', 'populated', 'articles', "Put your reading into words."],
  ['chat', 'empty', 'articles', "No words to practice yet"],
  ['reader', 'populated', 'articles', 'Attention is a practice'],
  ['reader', 'populated', 'bookReader', "Introduction: Reading Faster, Remembering Less"],
  ['reader', 'loading', 'articles', "AI is checking"],
  ['reader', 'empty', 'articles', "Could not fetch this page"],
];
for (const [page, state, tab, expected] of scenarios) test(`${page}: ${state} / ${tab}`, async () => {
  const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state, tab })}</script>`);
  let closeWindow;
  const dom = new JSDOM(html, {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      closeWindow = window.close.bind(window);
      window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.scrollTo = () => {};
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, tab === 'classification' ? 450 : 100));
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
    dom.window.document.querySelectorAll("script").forEach(script => script.remove());
    assert.ok(dom.window.document.body.textContent.includes(expected), `missing ${expected}: ${dom.window.document.body.textContent.slice(0, 1200)}`);
    assert.equal(dom.window.localStorage.getItem('fs:update:auto'), 'off');
  } finally { closeWindow(); }
});

test('page bundles inline their assets and replace only the App platform boot', () => {
  assert.equal(Object.keys(pages).length, 8);
  for (const html of Object.values(pages)) {
    assert.ok(html.includes('connect-src'));
    assert.equal(/<script[^>]+src=/.test(html), false);
    assert.equal(/<link[^>]+rel="stylesheet"/.test(html), false);
    assert.ok(html.includes('data:font/woff2;base64,'));
  }
});

test('clearing records reports storage or messaging failures and permits retry without claiming success', async () => {
  const html = pages.appOptions.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"appOptions",state:"populated",tab:"articles"}</script>');
  let close;
  const dom = new JSDOM(html, { url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      close = window.close.bind(window); window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder; window.confirm = () => true;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  try {
    await settle();
    const { chrome, document } = dom.window, original = chrome.runtime.sendMessage;
    const button = document.getElementById('clear'), status = document.getElementById('data-status');
    const before = await original({ type: 'data:export' });
    chrome.runtime.sendMessage = message => message.type === 'data:clear' ? Promise.resolve({ ok: false, error: 'Resource storage is unavailable' }) : original(message);
    button.click(); await settle();
    assert.match(status.textContent, /Could not clear.*Resource storage is unavailable/);
    assert.equal(button.disabled, false);
    assert.equal((await original({ type: 'data:export' })).articles.length, before.articles.length);
    chrome.runtime.sendMessage = message => message.type === 'data:clear' ? Promise.reject(new Error('Message channel closed')) : original(message);
    button.click(); await settle();
    assert.match(status.textContent, /Could not clear.*Message channel closed/);
    assert.equal(button.disabled, false);
    chrome.runtime.sendMessage = original;
    button.click(); await settle();
    assert.equal(status.textContent, 'Cleared');
    assert.equal((await original({ type: 'data:export' })).articles.length, 0);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});

test('sync settings keep secrets out of status, require a new token for a new address, and preserve local records on disconnect', async () => {
  const html = pages.options.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"options",state:"populated",tab:"articles"}</script>');
  let closeWindow;
  const dom = new JSDOM(html, {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      closeWindow = window.close.bind(window);
      window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));
  try {
    await settle();
    const { document, chrome } = dom.window;
    const token = document.getElementById('sync-token');
    assert.equal(token.value, '');
    assert.ok(document.getElementById('sync-summary').textContent.includes("Sync enabled"));
    const before = await chrome.runtime.sendMessage({ type: 'data:export' });
    document.getElementById('sync-url').value = 'https://other.example.com';
    document.getElementById('sync-test').click();
    await settle();
    assert.ok(document.getElementById('sync-feedback').textContent.includes("Re-enter your token"));
    assert.equal((await chrome.runtime.sendMessage({ type: 'sync:get' })).baseUrl, 'https://sync.example.com');
    document.getElementById('sync-url').value = 'https://sync.example.com';
    token.value = 'preview-secret-never-rendered';
    document.getElementById('sync-save').click();
    await settle();
    assert.equal(token.value, '');
    assert.equal(document.getElementById('sync-summary').textContent.includes('preview-secret-never-rendered'), false);
    document.getElementById('sync-pause').click();
    await settle();
    assert.equal(document.getElementById('sync-run').disabled, true);
    document.getElementById('sync-disconnect').click();
    await settle();
    const status = await chrome.runtime.sendMessage({ type: 'sync:get' });
    assert.equal(status.tokenSet, false);
    assert.equal(status.enabled, false);
    const after = await chrome.runtime.sendMessage({ type: 'data:export' });
    assert.equal(after.articles.length, before.articles.length);
    assert.equal(after.snippets.length, before.snippets.length);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { closeWindow(); }
});

test('options form tracks unsaved changes, keeps blacklists on reset, and only the extension page gets a section index', async () => {
  const open = (page) => {
    const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state: 'populated', tab: 'articles' })}</script>`);
    let closeWindow;
    const dom = new JSDOM(html, {
      url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        closeWindow = window.close.bind(window);
        window.structuredClone = structuredClone;
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      },
    });
    return { dom, close: () => closeWindow() };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  const app = open('appOptions');
  try {
    await settle();
    const { document, chrome, Event } = app.dom.window;
    assert.equal(document.querySelector('.section-nav'), null);
    assert.equal(document.getElementById('save-llm'), null);
    const type = (id, value) => { const input = document.getElementById(id); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let modelTests = 0;
    chrome.runtime.sendMessage = msg => { if (msg.type === 'llm:test') modelTests++; return send(msg); };
    type('model', 'saved-from-global-button');
    type('apiKey', 'synthetic-unified-save-key');
    type('finishRatio', '85');
    assert.equal(document.getElementById('savebar').classList.contains('is-dirty'), true);
    assert.equal(document.getElementById('test-llm').disabled, false);
    assert.equal(document.getElementById('test-llm').textContent, 'Save changes and test');
    assert.equal(document.getElementById('model-advanced').open, false);
    assert.equal(document.getElementById('reset').closest('#savebar'), null);
    const leaving = new Event('beforeunload', { cancelable: true });
    app.dom.window.dispatchEvent(leaving);
    assert.equal(leaving.defaultPrevented, true);
    document.getElementById('save').click();
    await settle();
    assert.equal((await chrome.runtime.sendMessage({ type: 'llm:get' })).model, 'saved-from-global-button');
    assert.equal((await chrome.runtime.sendMessage({ type: 'settings:get' })).finishRatio, .85);
    assert.equal(document.getElementById('apiKey').value, '');
    assert.equal(document.getElementById('savebar').classList.contains('is-dirty'), false);
    assert.equal(modelTests, 0, 'Saving does not make a model request');
    document.getElementById('test-llm').click();
    await settle();
    assert.equal(modelTests, 1);
    type('model', 'saved-and-tested-together');
    document.getElementById('test-llm').click();
    await settle();
    assert.equal((await chrome.runtime.sendMessage({ type: 'llm:get' })).model, 'saved-and-tested-together');
    assert.equal(modelTests, 2);
    assert.match(document.getElementById('llm-status').textContent, /Connected/);
    assert.equal(document.getElementById('save').disabled, true);
    document.getElementById('consent-revoke').click();await settle();
    type('model', 'saved-without-consent');
    document.getElementById('test-llm').click();await settle();
    assert.equal((await chrome.runtime.sendMessage({type:'llm:get'})).model,'saved-without-consent');
    assert.equal(modelTests,2,'Saving and testing must not bypass consent');
    assert.match(document.getElementById('llm-status').textContent,/sharing notice/);
    type('model','saved-when-consenting');
    assert.equal(document.getElementById('consent-agree').textContent,'Save changes and agree');
    document.getElementById('consent-agree').click();await settle();
    assert.equal((await chrome.runtime.sendMessage({type:'llm:get'})).model,'saved-when-consenting');
    assert.equal(modelTests,2);
    type('apiKey', 'unsaved-key');
    document.getElementById('revert').click();
    assert.equal(document.getElementById('apiKey').value, '');
    assert.equal(document.getElementById('savebar').classList.contains('is-dirty'), false);
    assert.deepEqual(Array.from(app.dom.window.__previewErrors), []);
  } finally { app.close(); }

  const { dom, close } = open('options');
  try {
    await settle();
    const { document, chrome, Event } = dom.window;
    const type = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    const bar = document.getElementById('savebar');
    const status = document.getElementById('status');
    const revert = document.getElementById('revert');

    const links = [...document.querySelectorAll('.section-nav a')];
    assert.equal(links.length, document.querySelectorAll('body > fieldset').length);
    assert.ok(links.every(link => document.getElementById(link.getAttribute('href').slice(1))?.tagName === 'FIELDSET'));
    assert.deepEqual([...document.querySelectorAll('.section-nav p')].map(p => p.textContent), ["Connections", "Preferences", "Maintenance"]);

    // Model settings share the global Save and unsaved-change indicator.
    assert.equal(bar.classList.contains('is-dirty'), false);
    assert.equal(revert.hidden, true);
    type('model', 'another-model');
    assert.equal(bar.classList.contains('is-dirty'), true);
    assert.equal(status.textContent, "1 unsaved changes");

    type('finishRatio', '85');
    type('excluded', 'https://example.com/search\nnews.example.com');
    assert.equal(bar.classList.contains('is-dirty'), true);
    assert.equal(status.textContent, "3 unsaved changes");
    assert.equal(revert.hidden, false);

    // 恢复默认只动开关和阈值，名单原样留着
    type('idle', '45');
    document.getElementById('reset').click();
    assert.equal(document.getElementById('idle').value, '30');
    assert.equal(document.getElementById('finishRatio').value, '80');
    assert.equal(document.getElementById('excluded').value, 'https://example.com/search\nnews.example.com');

    revert.click();
    assert.equal(bar.classList.contains('is-dirty'), false);
    assert.equal(document.getElementById('excluded').value.includes('news.example.com'), false);

    // stall 不大于 idle：不保存，错标在那一对框上，改了就消
    const saved = await chrome.runtime.sendMessage({ type: 'settings:get' });
    type('idle', '100'); type('stall', '90');
    document.getElementById('save').click();
    await settle();
    assert.deepEqual(await chrome.runtime.sendMessage({ type: 'settings:get' }), saved);
    assert.equal(document.getElementById('idle').getAttribute('aria-invalid'), 'true');
    assert.equal(document.getElementById('stall').validity.customError, true);
    assert.equal(status.classList.contains('error'), true);
    type('stall', '200');
    assert.equal(document.getElementById('idle').hasAttribute('aria-invalid'), false);
    assert.equal(document.getElementById('stall').validity.customError, false);

    document.getElementById('save').click();
    await settle();
    assert.equal((await chrome.runtime.sendMessage({ type: 'settings:get' })).stallTimeoutMs, 200_000);
    assert.equal(bar.classList.contains('is-dirty'), false);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});

test('sync section keeps its explanation behind the title button and its diagnostics behind a one-line verdict', async () => {
  const open = (page, state) => {
    const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state, tab: 'articles' })}</script>`);
    let closeWindow;
    const dom = new JSDOM(html, {
      url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        closeWindow = window.close.bind(window);
        window.structuredClone = structuredClone;
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      },
    });
    return { dom, close: () => closeWindow() };
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 30));

  const healthy = open('options', 'populated');
  try {
    await settle();
    const { document, KeyboardEvent } = healthy.dom.window;
    const info = document.querySelector('#sync-settings legend button.info');
    const about = document.getElementById('sync-about');
    // The button's glyph is not part of the section's name.
    assert.equal(document.querySelector('.section-nav a').textContent, "Device sync");
    assert.equal(about.hidden, true);
    info.click();
    assert.equal(about.hidden, false);
    assert.equal(info.getAttribute('aria-expanded'), 'true');
    about.querySelector('p').click();
    assert.equal(about.hidden, false);
    document.querySelector('h1').click();
    assert.equal(about.hidden, true);
    info.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(about.hidden, true);
    assert.equal(info.getAttribute('aria-expanded'), 'false');

    assert.equal(document.getElementById('sync-details').open, false);
    assert.match(document.getElementById('sync-summary').textContent, /^Sync enabled · Last sync: /);
    assert.equal(document.getElementById('sync-dot').dataset.tone, 'ok');
    assert.deepEqual([...document.querySelectorAll('#sync-facts dt')].map(dt => dt.textContent), ["Last successful sync", "Pending upload", "Account", "Server", "This device"]);
    // The answer to a button press stays beside the buttons, outside the collapsed panel.
    document.getElementById('sync-test').click();
    await settle();
    const feedback = document.getElementById('sync-feedback');
    assert.ok(feedback.textContent.includes("Connection successful"));
    assert.equal(feedback.closest('details'), null);
    assert.deepEqual(Array.from(healthy.dom.window.__previewErrors), []);
  } finally { healthy.close(); }

  const failing = open('options', 'error');
  try {
    await settle();
    const { document } = failing.dom.window;
    assert.equal(document.getElementById('sync-summary').textContent, "Sync enabled · Server temporarily unreachable (preview)");
    assert.equal(document.getElementById('sync-dot').dataset.tone, 'error');
    assert.deepEqual([...document.querySelectorAll('#sync-facts dt')].map(dt => dt.textContent).slice(0, 4), ["Error", "Last successful sync", "Pending upload", "Could not upload"]);
    assert.equal(document.querySelectorAll('#sync-facts li').length, 1);
    assert.ok(document.querySelector('#sync-facts li').textContent.startsWith("Legacy article"));
  } finally { failing.close(); }

  const app = open('appOptions', 'populated');
  try {
    await settle();
    const { document } = app.dom.window;
    assert.equal(document.querySelector('button.info'), null);
    assert.equal(document.getElementById('sync-about').hidden, false);
    assert.equal(document.getElementById('sync-settings').closest('details').querySelector('summary strong').textContent, "Device sync");
  } finally { app.close(); }
});

test('an article card unfolds into its own focus sessions, looked-up words and sync standing, on the extension and in the App', async () => {
  for (const page of ['dashboard', 'app']) {
    const html = pages[page].replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__=${JSON.stringify({ page, state: 'populated', tab: 'articles' })}</script>`);
    let closeWindow;
    const dom = new JSDOM(html, {
      url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
      beforeParse(window) {
        closeWindow = window.close.bind(window);
        window.structuredClone = structuredClone;
        window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
        window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
        window.scrollTo = () => {};
        window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      },
    });
    const settle = () => new Promise(resolve => setTimeout(resolve, 60));
    try {
      await settle();
      const { document } = dom.window;
      const articleTools = document.getElementById("article-tools");
      if (articleTools) { articleTools.open = true; await settle(); }
      const toggle = index => document.querySelectorAll('#articles .article-card')[index].querySelector('button[aria-expanded]');
      assert.equal(document.querySelector('.material-detail'), null, page);
      for (const index of [0, 1, 2]) { toggle(index).click(); await settle(); }
      const details = [...document.querySelectorAll('.material-detail')];
      assert.equal(details.length, 3, page);
      assert.deepEqual([...details[0].querySelectorAll('h4')].map(h => h.textContent.split(' · ')[0]), ["Focus sessions", "Translations", "Sync"]);
      assert.ok(details[0].textContent.includes('consolidate'));
      assert.ok(details[0].querySelector('.sync-line').textContent.startsWith("Synced to the server"));
      assert.ok(details[1].textContent.includes("No saved translations for this article yet"));
      assert.ok(details[1].querySelector('.sync-line').textContent.includes("Focus sessions: 1, Paragraphs: 12"));
      assert.ok(details[2].querySelector('.sync-reason').textContent.includes('trackedWords'));
      // Survives the list being redrawn, and folds back.
      const search = document.getElementById('q-article');
      search.value = ''; search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      assert.equal(document.querySelectorAll('.material-detail').length, 3, page);
      assert.equal(toggle(0).textContent, "Collapse");
      toggle(0).click();
      assert.equal(document.querySelectorAll('.material-detail').length, 2, page);
      assert.deepEqual(Array.from(dom.window.__previewErrors), []);
    } finally { closeWindow(); }
  }
});

test('popup focus and translation controls stay independent, and tab changes preserve the rule draft', async () => {
  const html = pages.popup.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"popup",state:"populated",tab:"current"}</script>');
  let close;
  const dom = new JSDOM(html, {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      close = window.close.bind(window);
      window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  try {
    await settle();
    const { document, chrome, KeyboardEvent } = dom.window;
    const settings = await chrome.runtime.sendMessage({ type: 'settings:get' });
    assert.equal(document.getElementById('tab-focus').getAttribute('aria-selected'), 'true');
    document.getElementById('tab-focus').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    assert.equal(document.getElementById('tab-translation').getAttribute('aria-selected'), 'true');
    document.querySelector('[role=switch]').click();
    await settle();
    assert.equal(document.querySelector('[role=switch]').getAttribute('aria-checked'), 'false');
    const draft = document.querySelector('.rc-input');
    draft.value = "Stop tracking this site";
    document.getElementById('tab-focus').click();
    await settle();
    assert.ok(document.querySelector('.focus-current').classList.contains('is-active'));
    document.querySelector('.focus-control').click();
    await settle();
    assert.ok(document.querySelector('.current-state').textContent.includes("Paused on this page"));
    document.getElementById('tab-translation').click();
    await settle();
    assert.equal(document.querySelector('[role=switch]').getAttribute('aria-checked'), 'false');
    assert.equal(document.querySelector('.rc-input').value, "Stop tracking this site");
    assert.deepEqual(await chrome.runtime.sendMessage({ type: 'settings:get' }), settings);
    document.querySelector('[role=switch]').click();
    await settle();
    const scope = document.getElementById('translation-scope');
    scope.value = 'site'; scope.dispatchEvent(new dom.window.Event('change'));
    await settle();
    const changed = await chrome.runtime.sendMessage({ type: 'settings:get' });
    assert.ok(changed.translationAllowedUrls.includes('example.com'));
    assert.equal(changed.translateEnabled, settings.translateEnabled);
    document.getElementById('tab-focus').click();
    await settle();
    assert.ok(document.querySelector('.current-state').textContent.includes("Paused on this page"));
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});

test('Android reading entry, local reader preferences and chapter navigation use the real controls', async () => {
  const html = pages.reader.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"reader",state:"populated",tab:"bookReader"}</script>');
  let close;
  const dom = new JSDOM(html, {
    url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      close = window.close.bind(window); window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.scrollBy = window.scrollTo = () => {};
      window.matchMedia = query => ({ matches: query === '(max-width: 720px)', addEventListener() {}, removeEventListener() {} });
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
    },
  });
  const settle = () => new Promise(resolve => setTimeout(resolve, 40));
  try {
    await settle();
    const { document, chrome } = dom.window;
    assert.equal(document.getElementById('reader-intro').open, true);
    document.getElementById('reader-intro-done').click();
    await settle();
    assert.equal((await chrome.storage.local.get('reader:gestures-shown'))['reader:gestures-shown'], true);
    assert.ok(document.querySelector('.atitle').textContent.includes("Introduction"));
    assert.equal(document.querySelectorAll('.reader-chapter').length, 2);
    assert.equal(document.querySelector('.reader-chapter[aria-current]').textContent.includes("Introduction"), true);
    assert.equal(document.body.classList.contains('chrome-hidden'), true);
    assert.equal(document.getElementById('reader-toolbar').inert, true);
    assert.ok(document.querySelector('#article .chapter-nav'));
    assert.equal(document.querySelector('#reader-contents .chapter-nav'), null);
    assert.match(document.querySelector('#article .chapter-nav').textContent, /Next chapter/);
    assert.equal(document.querySelector('#reader-progress button'), null);
    assert.equal(document.querySelector('#lectern-focusbar, #lectern-position, #lectern-finish'), null);
    document.getElementById('article').click();
    assert.equal(document.getElementById('reader-toolbar').inert, false);
    const before = await chrome.runtime.sendMessage({ type: 'settings:get' });
    assert.equal(document.getElementById('reader-font-settings').open, true);
    assert.equal(document.getElementById('reader-progress').closest('header').id, 'reader-toolbar');
    assert.equal(document.querySelectorAll('#reader-size-steps button').length, 7);
    assert.equal(document.documentElement.style.getPropertyValue('--reader-font-size'), '18px');
    document.getElementById('reader-font-larger').click();
    document.getElementById('reader-font-larger').click();
    document.getElementById('reader-font-smaller').click();
    assert.equal(document.documentElement.style.getPropertyValue('--reader-font-size'), '20px');
    document.querySelector('#reader-size-steps [data-size="18"]').click();
    assert.equal(document.documentElement.style.getPropertyValue('--reader-font-size'), '18px');
    for (let i = 0; i < 20; i++) document.getElementById('reader-font-larger').click();
    assert.equal(document.documentElement.style.getPropertyValue('--reader-font-size'), '24px');
    assert.equal(document.getElementById('reader-font-larger').disabled, true);
    for (let i = 0; i < 20; i++) document.getElementById('reader-font-smaller').click();
    assert.equal(document.documentElement.style.getPropertyValue('--reader-font-size'), '15px');
    assert.equal(document.getElementById('reader-font-smaller').disabled, true);
    document.querySelector('#reader-size-steps [data-size="18"]').click();
    const sepia = document.querySelector('button[data-reader-theme="sepia"]');
    assert.equal(document.body.dataset.readerEnglish, 'literata');
    assert.equal(document.body.dataset.readerChinese, 'wenkai');
    const sans = document.querySelector('button[data-reader-language="en"][data-reader-font="sans"]');
    sepia.click(); sans.click();
    assert.equal(document.body.dataset.readerTheme, 'sepia');
    assert.equal(document.body.dataset.readerEnglish, 'sans');
    assert.equal(document.body.dataset.readerChinese, 'wenkai');
    assert.equal(sepia.getAttribute('aria-pressed'), 'true');
    assert.equal(sans.getAttribute('aria-pressed'), 'true');
    await settle();
    assert.equal((await chrome.storage.local.get('reader:theme'))['reader:theme'], 'sepia');
    assert.equal((await chrome.storage.local.get('reader:font-english'))['reader:font-english'], 'sans');
    assert.equal((await chrome.storage.local.get('reader:font-chinese'))['reader:font-chinese'], 'wenkai');
    const set = chrome.storage.local.set;
    chrome.storage.local.set = async () => { throw new Error('Device storage full'); };
    document.querySelector('button[data-reader-theme="dark"]').click();
    await settle();
    assert.equal(document.body.dataset.readerTheme, 'dark');
    assert.match(document.getElementById('reader-font-status').textContent, /could not be saved/);
    chrome.storage.local.set = set;
    // The same setting can be chosen again to retry a failed save.
    document.querySelector('button[data-reader-theme="dark"]').click();
    await settle();
    assert.equal(document.getElementById('reader-font-status').textContent, '');
    assert.equal((await chrome.storage.local.get('reader:theme'))['reader:theme'], 'dark');
    document.getElementById('reader-font-close').click();
    assert.equal(document.getElementById('reader-font-settings').open, false);
    document.getElementById('article').click();
    document.getElementById('reader-more').click();
    document.getElementById('reader-bookmark').click();
    await settle();
    assert.equal(document.documentElement.style.getPropertyValue('--reader-font-size'), '18px');
    assert.equal((await chrome.storage.local.get('reader:font-size'))['reader:font-size'], 18);
    assert.equal(document.getElementById('reader-bookmark').getAttribute('aria-pressed'), 'true');
    assert.equal(document.getElementById('bookmark-jump').hidden, false);
    assert.equal(document.getElementById('reader-bookmark').closest('dialog').id, 'reader-tools');
    document.getElementById('reader-tools-close').click();
    document.getElementById('article').click();
    document.getElementById('reader-toc').click();
    assert.equal(document.getElementById('reader-contents').open, true);
    document.getElementById('contents-close').click();
    assert.equal(document.getElementById('reader-contents').open, false);
    assert.equal(document.body.classList.contains('chrome-hidden'), true);
    document.getElementById('article').click();
    document.getElementById('reader-more').click();
    document.getElementById('reader-bookmark').click();
    await settle();
    assert.equal(document.getElementById('reader-bookmark').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(await chrome.runtime.sendMessage({ type: 'settings:get' }), before);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});

test('review undo restores both the visible card and its saved schedule, and failed ratings do not advance', async () => {
  const html = pages.app.replace('<!--PREVIEW_CONFIG-->', '<script>window.__PREVIEW__={page:"app",state:"populated",tab:"review"}</script>');
  const dom = new JSDOM(html, { url:'https://preview.invalid/', runScripts:'dangerously', pretendToBeVisual:true,
    beforeParse(window) {
      window.structuredClone=structuredClone; window.TextEncoder=TextEncoder; window.TextDecoder=TextDecoder;
      window.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
    },
  });
  const settle=()=>new Promise(resolve=>setTimeout(resolve,50));
  try {
    await settle();
    const {document,chrome}=dom.window;
    const original=chrome.runtime.sendMessage.bind(chrome.runtime);
    const firstWord=document.querySelector('#review-area .word').textContent;
    const before=(await original({type:'review:due'})).cards.find(item=>item.card.key===firstWord).card;
    document.querySelector('#review-area .reveal').click();
    document.querySelectorAll('.grades button')[2].click();await settle();
    assert.equal(document.getElementById('review-undo').hidden,false);
    assert.notEqual(document.querySelector('#review-area .word')?.textContent,firstWord);
    document.getElementById('review-undo').click();await settle();
    assert.equal(document.querySelector('#review-area .word').textContent,firstWord);
    assert.equal(document.querySelectorAll('.grades button').length,4);
    assert.equal(document.getElementById('review-undo').hidden,true);
    assert.deepEqual((await original({type:'review:due'})).cards.find(item=>item.card.key===firstWord).card,before);
    chrome.runtime.sendMessage=msg=>msg.type==='review:grade'?Promise.resolve({ok:false,error:'Card removed elsewhere'}):original(msg);
    document.querySelectorAll('.grades button')[2].click();await settle();
    assert.equal(document.querySelector('#review-area .word').textContent,firstWord);
    assert.match(document.getElementById('review-area').textContent,/Card removed elsewhere/);
    document.querySelector('.seg[data-queue="articles"]').click();await settle();
    const articleBefore=(await original({type:'article:review-due'})).items[0];
    document.querySelector('#review-area .reveal').click();
    document.querySelectorAll('.grades button')[3].click();await settle();
    assert.equal(document.getElementById('review-undo').hidden,false);
    document.getElementById('review-undo').click();await settle();
    assert.deepEqual((await original({type:'article:review-due'})).items.find(item=>item.article.id===articleBefore.article.id).card,articleBefore.card);
    assert.equal(document.querySelectorAll('.grades button').length,4);
    assert.deepEqual(Array.from(dom.window.__previewErrors),[]);
  } finally { dom.window.close(); }
});

function chatPreview(state = 'populated') {
  const html = pages.chat.replace('<!--PREVIEW_CONFIG-->', `<script>window.__PREVIEW__={page:"chat",state:${JSON.stringify(state)},tab:"articles"}</script>`);
  let close;
  const dom = new JSDOM(html, { url: 'https://preview.invalid/', runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(window) {
      close = window.close.bind(window); window.structuredClone = structuredClone;
      window.TextEncoder = TextEncoder; window.TextDecoder = TextDecoder;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
      window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    },
  });
  return { dom, close };
}
const chatSettle = () => new Promise(resolve => setTimeout(resolve, 150));
test('vocabulary chat selects actual words, streams a reply and keeps history and drafts local', async () => {
  const { dom, close } = chatPreview();
  try {
    await chatSettle();
    const { document, chrome, Event, KeyboardEvent } = dom.window;
    const before = await chrome.runtime.sendMessage({ type: 'settings:get' });
    const snippets = await chrome.runtime.sendMessage({ type: 'snippets:list' });
    document.getElementById('chat-select').click(); await chatSettle();
    assert.equal(document.getElementById('chat-picker').open, true);
    const choices = document.querySelectorAll('.chat-word-option');
    choices[0].click();
    document.querySelector('.chat-word-option[aria-pressed=true]').click();
    assert.match(document.getElementById('picker-count').textContent, /at least/);
    document.getElementById('picker-close').click();
    const input = document.getElementById('chat-input');
    input.value = 'I consolidate my knowledge by explaining it.'; input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    assert.equal(document.querySelectorAll('.chat-message').length, 0);
    document.getElementById('chat-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await chatSettle();
    assert.equal(document.querySelectorAll('.chat-message').length, 2);
    assert.match(document.querySelector('.is-assistant').textContent, /What helps you/);
    const saved = (await chrome.storage.local.get('vocabulary-chats'))['vocabulary-chats'];
    assert.equal(saved[0].snippetIds.length, 1);
    assert.equal(saved[0].messages[1].incomplete, undefined);
    input.value = 'draft remains'; input.dispatchEvent(new Event('input'));
    document.getElementById('chat-new').click(); await chatSettle();
    document.getElementById('chat-history').click();
    document.querySelector('.phone-chat-history-item').click();
    assert.equal(input.value, 'draft remains');
    assert.deepEqual(await chrome.runtime.sendMessage({ type: 'settings:get' }), before);
    assert.deepEqual(await chrome.runtime.sendMessage({ type: 'snippets:list' }), snippets);
    assert.deepEqual(Array.from(dom.window.__previewErrors), []);
  } finally { close(); }
});
test('failed or stopped vocabulary chat preserves input and marks partial answers incomplete', async () => {
  for (const state of ['loading', 'error']) {
    const { dom, close } = chatPreview(state);
    try {
      await chatSettle();
      const { document, Event, chrome } = dom.window;
      document.querySelector('#chat-starters button').click(); await chatSettle();
      if (state === 'loading') {
        const input = document.getElementById('chat-input');
        input.value = 'new draft'; input.dispatchEvent(new Event('input'));
        document.getElementById('chat-stop').click();
        assert.equal(input.value, 'new draft');
        assert.match(document.getElementById('chat-status').textContent, /stopped/);
      } else {
        assert.equal(document.getElementById('chat-config').hidden, false);
        assert.match(document.getElementById('chat-input').value, /role-play/);
      }
      await chatSettle();
      const saved = (await chrome.storage.local.get('vocabulary-chats'))['vocabulary-chats'];
      assert.equal(saved[0].messages[1].incomplete, true);
      assert.deepEqual(Array.from(dom.window.__previewErrors), []);
    } finally { close(); }
  }
});
