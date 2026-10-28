import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { startFullscreen, type FullscreenHost, type FullscreenReading } from "../src/app/fullscreen.ts";

const dom = new JSDOM(`<!doctype html><body class="reader">
  <button id="toggle">Show reading tools</button>
  <header class="rbar"><button id="back">Back</button></header>
  <main id="article"><div class="body"><p>Reading text <a href="#">link</a></p></div></main>
</body>`);

/** JSDOM 不排版也不滚动，位置由测试自己说。 */
class Host implements FullscreenHost {
  scrollY = 0;
  private listeners = new Set<() => void>();
  addEventListener(_type: "scroll", fn: () => void): void { this.listeners.add(fn); }
  removeEventListener(_type: "scroll", fn: () => void): void { this.listeners.delete(fn); }
  scrollTo(y: number): void {
    this.scrollY = y;
    for (const fn of this.listeners) fn();
  }
  count(): number { return this.listeners.size; }
}

let body: HTMLElement;
let bar: HTMLElement;
let article: HTMLElement;
let toggle: HTMLButtonElement;
let host: Host;
let bars: boolean[];
let full: FullscreenReading;

beforeEach(() => {
  body = dom.window.document.body;
  body.className = "reader";
  bar = body.querySelector<HTMLElement>(".rbar")!;
  article = body.querySelector<HTMLElement>("#article")!;
  toggle = body.querySelector<HTMLButtonElement>("#toggle")!;
  dom.window.getSelection()?.removeAllRanges();
  host = new Host();
  bars = [];
  full = startFullscreen({ body, bar, article, toggle, host, systemBars: hidden => void bars.push(hidden) });
});
afterEach(() => full.stop());

const hidden = (): boolean => body.classList.contains("chrome-hidden");
const click = (el: Element): void => { el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 })); };

test("进入全屏就收起系统栏和工具，隐藏按钮不参与焦点顺序", () => {
  assert.ok(body.classList.contains("immersive"));
  assert.deepEqual(bars, [true]);
  assert.equal(full.shown(), false);
  assert.equal(hidden(), true);
  assert.equal(bar.inert, true);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
});

test("向下读、向上回读、回到篇首，都不自动露出工具", () => {
  for (const y of [400, 380, 600, 0, 6, -4]) {
    host.scrollTo(y);
    assert.equal(full.shown(), false);
    assert.equal(hidden(), true);
  }
});

test("只点正文两侧容器留白才切换，段落、行间、链接和按钮不触发", () => {
  for (const selector of [".body", "p", "a", "#back"]) {
    click(body.querySelector(selector)!);
    assert.equal(hidden(), true);
  }
  click(article);
  assert.equal(hidden(), false);
  assert.equal(bar.inert, false);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  click(body);
  assert.equal(hidden(), true);
});

test("保留文字选区时点击留白不打开工具", () => {
  const range = dom.window.document.createRange();
  range.selectNodeContents(article.querySelector("p")!);
  dom.window.getSelection()!.addRange(range);
  click(article);
  assert.equal(hidden(), true);
});

test("触屏连续点留白即使带着双击计数，仍可在关闭面板后再次调出工具", () => {
  click(article);
  full.hide();
  article.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 2 }));
  assert.equal(hidden(), false);
});

test("工具打开后，继续朝任意方向阅读都会收起，微小抖动不收", () => {
  host.scrollTo(400);
  full.reveal();
  for (const y of [395, 402, 396, 403]) host.scrollTo(y);
  assert.equal(hidden(), false);
  host.scrollTo(425);
  assert.equal(hidden(), true);
  full.reveal();
  host.scrollTo(400);
  assert.equal(hidden(), true);
});

test("键盘与读屏入口可调出工具，Escape 收起时焦点返回入口", () => {
  toggle.click();
  assert.equal(hidden(), false);
  body.querySelector<HTMLButtonElement>("#back")!.focus();
  body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(hidden(), true);
  assert.equal(dom.window.document.activeElement, toggle);
  assert.equal(toggle.textContent, "Show reading tools");
});

test("关闭工具后回到纯阅读，不需要再滚动一次", () => {
  full.reveal();
  full.hide();
  assert.equal(hidden(), true);
  assert.equal(bar.inert, true);
});

test("退出全屏还原系统栏并撤掉全部监听，重复退出无害", () => {
  full.stop();
  assert.deepEqual(bars, [true, false]);
  assert.equal(body.classList.contains("immersive"), false);
  assert.equal(hidden(), false);
  assert.equal(bar.inert, false);
  assert.equal(host.count(), 0);
  click(article);
  toggle.click();
  host.scrollTo(400);
  full.hide();
  assert.equal(hidden(), false);
  full.stop();
  assert.deepEqual(bars, [true, false]);
});

test("老宿主没有系统栏桥时仍可用留白调出工具", () => {
  full.stop();
  full = startFullscreen({ body, bar, article, toggle, host });
  assert.equal(hidden(), true);
  click(article);
  assert.equal(hidden(), false);
});
