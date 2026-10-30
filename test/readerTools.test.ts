import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setupReadingTools } from '../src/app/readerTools.ts';

function harness() {
  const dom = new JSDOM(`<!doctype html><body>
    <button id="fallback">Reading controls</button><article id="article">Text</article>
    <dialog id="appearance"><button id="trigger">Tools</button></dialog>
    <dialog id="tools"><button id="handle">Close tools</button><h2 id="heading" tabindex="-1">Reading tools</h2><div id="content"><button id="action">Article vocabulary</button></div></dialog>
    <dialog id="help"><button id="help-close">Close help</button></dialog>
  </body>`);
  const doc = dom.window.document, host = dom.window;
  const byId = <T extends HTMLElement>(id: string): T => doc.getElementById(id) as T;
  const dialog = byId<HTMLDialogElement>('tools'), appearance = byId<HTMLDialogElement>('appearance');
  const help = byId<HTMLDialogElement>('help'), handle = byId<HTMLButtonElement>('handle');
  const trigger = byId<HTMLButtonElement>('trigger'), fallback = byId<HTMLButtonElement>('fallback');
  let top = 420, left = 0;
  Object.defineProperty(host, 'scrollY', { get: () => top });
  Object.defineProperty(host, 'scrollX', { get: () => left });
  host.scrollTo = ((options: ScrollToOptions) => { top = options.top ?? top; left = options.left ?? left; }) as typeof host.scrollTo;
  for (const item of [dialog, appearance, help]) {
    item.showModal = () => { item.open = true; };
    item.close = () => { item.open = false; queueMicrotask(() => item.dispatchEvent(new host.Event('close'))); };
  }
  dialog.getBoundingClientRect = () => new host.DOMRect(0, 400, 390, 400);
  appearance.showModal(); trigger.focus();
  const sheet = setupReadingTools({ dialog, handle, heading: byId('heading'), trigger, fallbackFocus: fallback,
    beforeOpen: () => appearance.close() });
  const click = (element: HTMLElement, x = 30, y = 430): MouseEvent => {
    const event = new host.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, clientX: x, clientY: y });
    element.dispatchEvent(event); return event;
  };
  const pointer = (element: HTMLElement, type: string, x: number, y: number): Event => {
    const event = new host.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true } });
    element.dispatchEvent(event); return event;
  };
  return { dom, doc, host, byId, dialog, appearance, help, handle, trigger, fallback, sheet, click, pointer,
    scroll: (next: number) => { top = next; }, cleanup: () => { sheet.dispose(); dom.window.close(); } };
}

test('tools replace the appearance dialog and close to a usable focus target without moving the article', async () => {
  const h = harness();
  try {
    h.sheet.open();
    assert.equal(h.appearance.open, false);
    assert.equal(h.doc.querySelectorAll('dialog[open]').length, 1);
    assert.equal(h.doc.activeElement, h.byId('heading'));
    assert.equal(h.trigger.getAttribute('aria-expanded'), 'true');
    h.scroll(0); h.click(h.handle);
    assert.equal(h.dialog.open, false);
    assert.equal(h.host.scrollY, 420);
    assert.equal(h.doc.activeElement, h.fallback);
    assert.equal(h.trigger.getAttribute('aria-expanded'), 'false');
    await Promise.resolve();
    assert.equal(h.doc.activeElement, h.fallback);
  } finally { h.cleanup(); }
});

test('only backdrop clicks dismiss; blank sheet space, content taps and scrolling keep the sheet open', () => {
  const h = harness();
  try {
    h.sheet.open();
    h.click(h.dialog, 200, 550);
    h.click(h.byId('action'));
    h.byId('content').dispatchEvent(new h.host.Event('scroll', { bubbles: true }));
    h.pointer(h.byId('content'), 'pointerdown', 80, 550);
    h.pointer(h.byId('content'), 'pointermove', 80, 650);
    h.pointer(h.byId('content'), 'pointerup', 80, 650);
    assert.equal(h.dialog.open, true);
    h.click(h.dialog, 200, 350);
    assert.equal(h.dialog.open, false);
  } finally { h.cleanup(); }
});

test('a small or horizontal handle drag does not become a close click', () => {
  const h = harness();
  try {
    h.sheet.open();
    h.pointer(h.handle, 'pointerdown', 120, 420);
    h.pointer(h.handle, 'pointermove', 120, 440);
    h.pointer(h.handle, 'pointerup', 120, 440);
    assert.equal(h.click(h.handle).defaultPrevented, true);
    assert.equal(h.dialog.open, true);
    h.pointer(h.handle, 'pointerdown', 120, 420);
    h.pointer(h.handle, 'pointermove', 200, 460);
    h.pointer(h.handle, 'pointerup', 200, 460);
    h.click(h.handle);
    assert.equal(h.dialog.open, true);
    h.pointer(h.handle, 'pointerdown', 120, 420);
    h.pointer(h.handle, 'pointerup', 120, 420);
    h.click(h.handle);
    assert.equal(h.dialog.open, false, 'a fresh tap still closes normally');
  } finally { h.cleanup(); }
});

test('a downward handle drag closes at the threshold and consumes its click-through', () => {
  const h = harness();
  try {
    let articleClicks = 0;
    h.byId('article').addEventListener('click', () => { articleClicks++; });
    h.sheet.open();
    h.pointer(h.handle, 'pointerdown', 120, 420);
    h.pointer(h.handle, 'pointermove', 120, 451);
    assert.equal(h.dialog.open, true);
    h.pointer(h.handle, 'pointermove', 120, 452);
    assert.equal(h.dialog.open, false);
    assert.equal(h.click(h.byId('article')).defaultPrevented, true);
    assert.equal(articleClicks, 0);
    h.pointer(h.byId('article'), 'pointerdown', 10, 200);
    h.click(h.byId('article'));
    assert.equal(articleClicks, 1, 'the next intentional article tap is not swallowed');
  } finally { h.cleanup(); }
});

test('Escape cancellation and native close both restore the reading position and focus', async () => {
  const h = harness();
  try {
    h.sheet.open(); h.scroll(650);
    const cancel = new h.host.Event('cancel', { cancelable: true });
    h.dialog.dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true);
    assert.equal(h.dialog.open, false);
    assert.equal(h.host.scrollY, 420);
    await Promise.resolve();
    h.sheet.open(); h.scroll(100); h.dialog.close();
    await Promise.resolve();
    assert.equal(h.host.scrollY, 420);
    assert.equal(h.doc.activeElement, h.fallback);
  } finally { h.cleanup(); }
});

test('queued close events do not undo a bookmark jump or steal focus from the next modal', async () => {
  const h = harness();
  try {
    h.sheet.open();
    h.sheet.close({ restoreScroll: false });
    h.scroll(850);
    await Promise.resolve();
    assert.equal(h.host.scrollY, 850);
    h.sheet.open(); h.sheet.close();
    h.help.showModal(); h.byId('help-close').focus();
    await Promise.resolve();
    assert.equal(h.doc.activeElement, h.byId('help-close'));
    assert.equal(h.doc.querySelectorAll('dialog[open]').length, 1);
    assert.equal(h.host.scrollY, 850);
  } finally { h.cleanup(); }
});

test('an externally initiated handoff keeps the new modal in charge of focus', async () => {
  const h = harness();
  try {
    h.sheet.open(); h.dialog.close();
    h.help.showModal(); h.byId('help-close').focus();
    await Promise.resolve();
    assert.equal(h.doc.activeElement, h.byId('help-close'));
  } finally { h.cleanup(); }
});
