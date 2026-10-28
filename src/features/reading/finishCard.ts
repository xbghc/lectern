/**
 * 读完文章后贴在右下角的回顾入口。
 *
 * 和翻译浮层同一套中性配色，但**另起一个 host**：浮层的 `hide()` 会把自己的
 * 宿主整个 remove 掉，共用的话读完之后随手划一个词，按钮就跟着没了。
 *
 * 控件与提示使用系统无衬线字体，不需要额外字体请求。
 */

const HOST_ID = "lectern-finish";

const CSS = `
:host { all: initial; color-scheme: light dark; }
button:focus-visible, input:focus-visible { outline: 2px solid #a1a1aa; outline-offset: 2px; }
.card {
  position: fixed;
  /* 横屏时刘海在右边：和底边一样让开安全区 */
  right: calc(20px + max(env(safe-area-inset-right), var(--inset-right, 0px)));
  /* Android 15+ 把窗口铺满整块屏，离底 20px 正落在手势条底下。扩展里两个来源都是 0 */
  bottom: calc(20px + max(env(safe-area-inset-bottom), var(--inset-bottom, 0px)));
  z-index: 2147483646; /* 让翻译浮层压在上面：那个是当下的操作，这个只是常驻入口 */
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 10px 10px 14px;
  border-radius: 12px;
  border: 1px solid #e4e4e7;

  background: #ffffff;
  color: #09090b;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 10px 28px rgba(0, 0, 0, 0.14);
  font: 13px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  animation: rise 240ms cubic-bezier(0.2, 0.8, 0.3, 1);
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
}
.label { display: flex; flex-direction: column; gap: 1px; }
.title { font-weight: 600; letter-spacing: -0.01em; }
.sub { color: #71717a; font-size: 11.5px; }
button {
  font: inherit;
  cursor: pointer;
  border-radius: 6px;
  border: 1px solid #e4e4e7;
  background: #f4f4f5;
  color: #3f3f46;
  padding: 5px 11px;
  transition: color 120ms, border-color 120ms;
}
/* 触屏上点过之后 :hover 会一直挂着，所以只给真有悬停的设备；手指用 :active */
@media (hover: hover) { button:hover { color: #18181b; border-color: #18181b; } }
button:active { color: #18181b; border-color: #18181b; }
@media (pointer: coarse) { button { padding: 11px 14px; } }
.close {
  padding: 5px 8px;
  border-color: transparent;
  background: transparent;
  color: #71717a;
  font-size: 15px;
  line-height: 1;
}
@media (hover: hover) { .close:hover { color: #3f3f46; border-color: transparent; background: transparent; } }
.close:active { color: #3f3f46; border-color: transparent; background: transparent; }
@media (pointer: coarse) { .close { padding: 11px 13px; } }
@media (prefers-color-scheme: dark) {
  .card { background: #18181b; color: #fafafa; border-color: #27272a;  }
  .sub { color: #a1a1aa; }
  button { background: #09090b; color: #d4d4d8; border-color: #3f3f46; }
  button:active { background: #27272a; color: #fafafa; border-color: #fafafa; }
  @media (hover: hover) { button:hover { background: #27272a; color: #fafafa; border-color: #fafafa; } }
  .close { background: transparent; border-color: transparent; }
  .close:active { background: transparent; border-color: transparent; color: #fafafa; }
  @media (hover: hover) { .close:hover { background: transparent; border-color: transparent; color: #fafafa; } }
}
`;

export interface FinishCardActions {
  /** 点了「回顾这篇」。 */
  onOpen: () => void;
  /** 点了 ×。本次加载内不再弹。 */
  onDismiss: () => void;
}

export class FinishCard {
  private host: HTMLElement | null = null;
  private actions: FinishCardActions;

  constructor(actions: FinishCardActions) {
    this.actions = actions;
  }

  /** 宿主元素——测试断言用，也用来判断当前是不是已经挂着。 */
  get hostElement(): HTMLElement | null {
    return this.host;
  }

  /** 重复调用是安全的：已经挂着就什么都不做，不会重播入场动画。 */
  show(): void {
    if (this.host) return;
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:static;";
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = CSS;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `<div class="label"><span class="title">Article finished</span><span class="sub">Added to your review queue</span></div>
       <button data-act="go">Review article</button>
       <button class="close" data-act="x" aria-label="Close">×</button>`;
    card.querySelector('[data-act="go"]')!.addEventListener("click", () => this.actions.onOpen());
    card.querySelector('[data-act="x"]')!.addEventListener("click", () => {
      this.hide();
      this.actions.onDismiss();
    });

    root.append(style, card);
    document.documentElement.appendChild(host);
    this.host = host;
  }

  hide(): void {
    this.host?.remove();
    this.host = null;
  }
}
