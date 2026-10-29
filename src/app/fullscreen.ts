/**
 * 阅读默认只留正文。轻触正文两侧的留白同时调出顶栏和设置面板；
 * 面板的遮罩、关闭手柄与返回键回到阅读，排版和阅读位置不变。
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
  panel?: HTMLDialogElement;
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
  const { body, bar, panel, article, toggle, host, systemBars } = options;
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
    const restoreFocus = !shown && (bar.contains(doc.activeElement) || panel?.contains(doc.activeElement));
    bar.inert = !shown;
    toggle.setAttribute("aria-expanded", String(shown));
    toggle.textContent = shown ? "Hide reading tools" : "Show reading tools";
    if (panel) {
      if (shown && !panel.open) panel.showModal();
      else if (!shown && panel.open) panel.close();
    }
    if (restoreFocus) toggle.focus({ preventScroll: true });
  };

  const onScroll = (): void => {
    // Typography changes adjust scroll to preserve the visible paragraph while the modal stays open.
    if (shown && !panel?.open && Math.abs(host.scrollY - origin) >= HIDE_AT) apply(false);
  };
  const onToggle = (): void => apply(!shown);
  const onMarginClick = (event: MouseEvent): void => {
    if (panel && event.target === panel) { apply(false); return; }
    if (event.defaultPrevented || body.ownerDocument.getSelection()?.isCollapsed === false) return;
    if (doc.querySelector('dialog[open]')) return;
    // 只认容器自身的留白，不认段落内部的行间、文字、图片、链接或翻译浮层。
    const target = event.composedPath()[0];
    if (target === article || target === body || target === doc.documentElement) onToggle();
  };
  const onPanelClose = (): void => { if (!panel?.open) apply(false); };
  const onPanelCancel = (event: Event): void => { event.preventDefault(); apply(false); };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !event.defaultPrevented && shown && !doc.querySelector('dialog[open]')) apply(false);
  };

  body.classList.add("immersive");
  apply(false);
  systemBars?.(true);
  host.addEventListener("scroll", onScroll, { passive: true });
  // Delegating on document avoids making the entire WebView body a clickable surface.
  doc.addEventListener("click", onMarginClick);
  body.addEventListener("keydown", onKey);
  toggle.addEventListener("click", onToggle);
  panel?.addEventListener("close", onPanelClose);
  panel?.addEventListener("cancel", onPanelCancel);

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
      panel?.removeEventListener("close", onPanelClose);
      panel?.removeEventListener("cancel", onPanelCancel);
      if (panel?.open) panel.close();
      body.classList.remove("immersive", "chrome-hidden");
      bar.inert = false;
      shown = true;
      toggle.setAttribute("aria-expanded", "false");
      systemBars?.(false);
    },
  };
}
