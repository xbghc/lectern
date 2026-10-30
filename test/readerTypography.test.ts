import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { prepareReaderTypography, readerFonts, ENGLISH_FONT_KEY, CHINESE_FONT_KEY } from '../src/app/readerTypography.ts';
import { setupReaderControls } from '../src/app/readerControls.ts';

test('font preferences migrate legacy values and validate each language independently', () => {
  assert.deepEqual(readerFonts({}), { english: 'serif', chinese: 'serif' });
  assert.deepEqual(readerFonts({ 'reader:font-family': 'kai' }), { english: 'serif', chinese: 'kai' });
  assert.deepEqual(readerFonts({ 'reader:font-family': 'sans' }), { english: 'sans', chinese: 'sans' });
  assert.deepEqual(readerFonts({ [ENGLISH_FONT_KEY]: 'mono', [CHINESE_FONT_KEY]: 'sans' }), { english: 'mono', chinese: 'sans' });
  assert.deepEqual(readerFonts({ [ENGLISH_FONT_KEY]: 'bad', [CHINESE_FONT_KEY]: 'kai' }), { english: 'serif', chinese: 'kai' });
});

test('mixed-script typography preserves text, inline markup, block identity and native selection', () => {
  const dom = new JSDOM('<article><p>Read <em>學而時習之</em>，React 文档。𠮷！</p><pre>代码 code</pre><p><a href="#next">下一章</a></p></article>');
  const root = dom.window.document.querySelector('article')!;
  const text = root.textContent, paragraph = root.querySelector('p');
  prepareReaderTypography(root);
  assert.equal(root.textContent, text);
  assert.equal(root.querySelector('p'), paragraph);
  assert.equal(root.querySelector('em > span')?.textContent, '學而時習之');
  assert.equal(root.querySelector('pre span'), null);
  assert.ok([...root.querySelectorAll('[data-reader-script]')].every(span => !/[A-Za-z]/.test(span.textContent!)));
  const markup = root.innerHTML;
  prepareReaderTypography(root);
  assert.equal(root.innerHTML, markup, 'preparation is idempotent');
  const range = dom.window.document.createRange(); range.selectNodeContents(paragraph!);
  const selection = dom.window.getSelection()!; selection.addRange(range);
  assert.equal(selection.toString(), 'Read 學而時習之，React 文档。𠮷！');
  dom.window.close();
});

test('reader controls save both languages without changing the other selection', async () => {
  const dom = new JSDOM(readFileSync(new URL('../src/app/read.html', import.meta.url), 'utf8'));
  const doc = dom.window.document;
  const root = doc.createElement('div'); root.className = 'body'; root.innerHTML = '<p>Read 中文.</p>';
  doc.getElementById('article')!.replaceChildren(root);
  dom.window.scrollBy = () => undefined;
  const g = globalThis as Record<string, unknown>, previous = g.chrome;
  let saved: Record<string, unknown> = { 'reader:font-family': 'kai' };
  g.chrome = { storage: { local: { get: async () => saved, set: async (next: Record<string, unknown>) => { saved = { ...saved, ...next }; } } }, runtime: { sendMessage: async () => ({}) } };
  try {
    await setupReaderControls({ articleId: 'test', body: root, book: null, chapter: null, openChapter: () => undefined });
    assert.equal(doc.body.dataset.readerChinese, 'kai');
    doc.querySelector<HTMLButtonElement>('[data-reader-language=en][data-reader-font=mono]')!.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(doc.body.dataset.readerEnglish, 'mono');
    assert.equal(doc.body.dataset.readerChinese, 'kai');
    assert.equal(saved[ENGLISH_FONT_KEY], 'mono'); assert.equal(saved[CHINESE_FONT_KEY], 'kai');
    doc.querySelector<HTMLButtonElement>('[data-reader-language=zh][data-reader-font=sans]')!.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(saved[ENGLISH_FONT_KEY], 'mono'); assert.equal(saved[CHINESE_FONT_KEY], 'sans');
    assert.equal(doc.querySelectorAll('.reader-fonts [aria-pressed=true]').length, 2);
  } finally { dom.window.dispatchEvent(new dom.window.Event('pagehide')); dom.window.close(); g.chrome = previous; }
});
