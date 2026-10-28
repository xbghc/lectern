/**
 * 手机阅读默认只留正文和贴底进度线。轻触正文两侧的留白才调出工具，
 * 继续滚动就收起；回读和回到篇首都不自动展示界面。
 * 正文内的点击仍交给点词 / 点句翻译，不和阅读工具共用手势。
 */
const HIDE_AT = 24;

export interface FullscreenHost {
  readonly scrollY: number;
  addEventListener(type: "scroll", fn: () => void, options?: { passive?: boolean }): void;
  removeEventListener(type: "scroll", fn: () => void): void;
}

export interface FullscreenOptions {
  body: HTMLElement;
  bar: HTMLElement;
  article: HTMLElement;
  /** 键盘与读屏入口；平常不占视觉空间，键盘聚焦时才显示。 */
  toggle: HTMLButtonElement;
  host: FullscreenHost;
  systemBars?: (hidden: boolean) => void;
}

export interface FullscreenReading {
  shown(): boolean;
  reveal(): void;
  hide(): void;
  /** 换页时由宿主判断是否还原系统栏；此方法用于不换页退出全屏。 */
  stop(): void;
}

export function startFullscreen(options: FullscreenOptions): FullscreenReading {
  const { body, bar, article, toggle, host, systemBars } = options;
  const doc = body.ownerDocument;
  let shown = false;
  let stopped = false;
  let origin = host.scrollY;

  const apply = (next: boolean): void => {
    if (stopped) return;
    shown = next;
    origin = host.scrollY;
    body.classList.toggle("chrome-hidden", !shown);
    // 收起的按钮不能还留在键盘和读屏的焦点顺序中。
    if (!shown && bar.contains(body.ownerDocument.activeElement)) toggle.focus({ preventScroll: true });
    bar.inert = !shown;
    toggle.setAttribute("aria-expanded", String(shown));
    toggle.textContent = shown ? "Hide reading tools" : "Show reading tools";
  };

  const onScroll = (): void => {
    if (shown && Math.abs(host.scrollY - origin) >= HIDE_AT) apply(false);
  };
  const onToggle = (): void => apply(!shown);
  const onMarginClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.detail > 1 || body.ownerDocument.getSelection()?.isCollapsed === false) return;
    // 只认容器自身的留白，不认段落内部的行间、文字、图片、链接或翻译浮层。
    const target = event.composedPath()[0];
    if (target === article || target === body || target === doc.documentElement) onToggle();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !event.defaultPrevented && shown) apply(false);
  };

  body.classList.add("immersive");
  apply(false);
  systemBars?.(true);
  host.addEventListener("scroll", onScroll, { passive: true });
  // Delegating on document avoids making the entire WebView body a clickable surface.
  doc.addEventListener("click", onMarginClick);
  body.addEventListener("keydown", onKey);
  toggle.addEventListener("click", onToggle);

  return {
    shown: () => shown,
    reveal: () => apply(true),
    hide: () => apply(false),
    stop() {
      if (stopped) return;
      stopped = true;
      host.removeEventListener("scroll", onScroll);
      doc.removeEventListener("click", onMarginClick);
      body.removeEventListener("keydown", onKey);
      toggle.removeEventListener("click", onToggle);
      body.classList.remove("immersive", "chrome-hidden");
      bar.inert = false;
      shown = true;
      toggle.setAttribute("aria-expanded", "false");
      systemBars?.(false);
    },
  };
}
