const DISMISS_DISTANCE = 32;
const DRAG_SLOP = 6;

export interface ReadingToolsOptions {
  dialog: HTMLDialogElement;
  handle: HTMLButtonElement;
  heading: HTMLElement;
  trigger: HTMLButtonElement;
  fallbackFocus: HTMLElement;
  beforeOpen: () => void;
}

/** A single tool sheet, with dismissal gestures confined to its handle. */
export function setupReadingTools(options: ReadingToolsOptions) {
  const { dialog, handle, heading, trigger, fallbackFocus, beforeOpen } = options;
  const doc = dialog.ownerDocument;
  const host = doc.defaultView!;
  let active = false;
  let restoreScroll = true;
  let previousFocus: HTMLElement | null = null;
  let position = { left: 0, top: 0 };
  let drag: { id: number; x: number; y: number } | null = null;
  let suppressClick = false;

  const restorePosition = (): void => {
    if (host.scrollX !== position.left || host.scrollY !== position.top) host.scrollTo({ ...position, behavior: 'instant' });
  };
  const resetDrag = (): void => {
    const id = drag?.id;
    drag = null;
    if (id !== undefined && handle.hasPointerCapture?.(id)) handle.releasePointerCapture(id);
  };
  const finishClose = (): void => {
    if (!active || dialog.open) return;
    active = false;
    resetDrag();
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreScroll) restorePosition();
    // A handoff to another modal owns focus. The appearance toolbar is already
    // closed, so its former button is not a usable focus restoration target.
    if (doc.querySelector('dialog[open]')) return;
    const target = previousFocus?.isConnected && !previousFocus.closest('[hidden], [inert], dialog:not([open])')
      ? previousFocus : fallbackFocus;
    target.focus({ preventScroll: true });
  };
  const close = (settings: { restoreScroll?: boolean } = {}): void => {
    if (!dialog.open) return;
    restoreScroll = settings.restoreScroll !== false;
    dialog.close();
    // Complete before the caller opens a child panel or jumps to a bookmark.
    // Native close events are queued and must not restore the old position later.
    finishClose();
  };
  const open = (): void => {
    if (dialog.open) return;
    previousFocus = doc.activeElement as HTMLElement | null;
    position = { left: host.scrollX, top: host.scrollY };
    restoreScroll = true;
    beforeOpen();
    active = true;
    dialog.showModal();
    trigger.setAttribute('aria-expanded', 'true');
    heading.focus({ preventScroll: true });
    restorePosition();
  };
  const onBackdrop = (event: MouseEvent): void => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX >= rect.right || event.clientY < rect.top || event.clientY >= rect.bottom) close();
  };
  const onCancel = (event: Event): void => { event.preventDefault(); close(); };
  const onHandleClick = (): void => close();
  const onPointerStart = (): void => { suppressClick = false; };
  const onPointerDown = (event: PointerEvent): void => {
    if (!dialog.open || event.button !== 0 || event.isPrimary === false) return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
    handle.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || drag.id !== event.pointerId) return;
    const x = event.clientX - drag.x, y = event.clientY - drag.y;
    if (Math.hypot(x, y) >= DRAG_SLOP) suppressClick = true;
    if (y >= DISMISS_DISTANCE && y > Math.abs(x)) {
      event.preventDefault();
      close();
    }
  };
  const onPointerEnd = (event: PointerEvent): void => { if (drag?.id === event.pointerId) resetDrag(); };
  const onClick = (event: MouseEvent): void => {
    // Dragging the handle is not a click. Suppress the gesture's synthesized
    // click even if closing the dialog retargets it to the article underneath.
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault(); event.stopImmediatePropagation();
  };

  dialog.addEventListener('click', onBackdrop);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', finishClose);
  handle.addEventListener('click', onHandleClick);
  handle.addEventListener('pointerdown', onPointerDown);
  handle.addEventListener('pointermove', onPointerMove);
  handle.addEventListener('pointerup', onPointerEnd);
  handle.addEventListener('pointercancel', onPointerEnd);
  doc.addEventListener('pointerdown', onPointerStart, true);
  doc.addEventListener('click', onClick, true);

  return {
    open, close,
    dispose(): void {
      resetDrag();
      dialog.removeEventListener('click', onBackdrop);
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', finishClose);
      handle.removeEventListener('click', onHandleClick);
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('pointermove', onPointerMove);
      handle.removeEventListener('pointerup', onPointerEnd);
      handle.removeEventListener('pointercancel', onPointerEnd);
      doc.removeEventListener('pointerdown', onPointerStart, true);
      doc.removeEventListener('click', onClick, true);
    },
  };
}
