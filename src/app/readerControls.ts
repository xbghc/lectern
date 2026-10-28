import { icon, decorateIcons } from '../ui/icons.ts';
import { chapterId, type Book } from '../books/types.ts';

const FONT_KEY = 'reader:font-size';
const BOOKMARK_PREFIX = 'reader:bookmark:';
const MIN_SIZE = 14, MAX_SIZE = 28, DEFAULT_SIZE = 18;
interface Bookmark { ratio: number; savedTs: number; paragraph?: number; offset?: number }
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
export function scrollRatio(top: number, height: number, viewport: number): number {
  return height > viewport ? clamp(top / (height - viewport)) : 0;
}
export function fontSize(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_SIZE && value <= MAX_SIZE ? value : DEFAULT_SIZE;
}

/** Device-local reading preferences. Neither font size nor bookmarks enter the sync protocol. */
export async function setupReaderControls(options: {
  articleId: string; body: HTMLElement; book: Book | null; chapter: number | null;
  openChapter: (url: string) => void;
}): Promise<void> {
  const { body, articleId, book, chapter } = options;
  const doc = body.ownerDocument;
  const sizeButton = doc.getElementById('reader-font') as HTMLButtonElement;
  const markButton = doc.getElementById('reader-bookmark') as HTMLButtonElement;
  const dialog = doc.getElementById('reader-contents') as HTMLDialogElement;
  const tools = doc.getElementById('reader-tools') as HTMLDialogElement;
  const fontDialog = doc.getElementById('reader-font-settings') as HTMLDialogElement;
  const smaller = doc.getElementById('reader-font-smaller') as HTMLButtonElement;
  const larger = doc.getElementById('reader-font-larger') as HTMLButtonElement;
  const resetSize = doc.getElementById('reader-font-reset') as HTMLButtonElement;
  const fontStatus = doc.getElementById('reader-font-status')!;
  const jump = doc.getElementById('bookmark-jump') as HTMLButtonElement;
  const key = BOOKMARK_PREFIX + articleId;
  let size = 18, mark: Bookmark | null = null;
  let busy = false;
  let fontSaves = Promise.resolve();
  const status = doc.getElementById('reader-feedback')!;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string): void => { clearTimeout(feedbackTimer); status.textContent = text; feedbackTimer = setTimeout(() => { status.textContent = ""; }, 3000); };
  window.addEventListener('pagehide', () => clearTimeout(feedbackTimer), { once: true });
  const paint = (): void => {
    doc.documentElement.style.setProperty('--reader-font-size', `${size}px`);
    sizeButton.setAttribute('aria-label', `Open text size settings; currently ${size}px`);
    sizeButton.title = `Font size: ${size}px`;
    doc.getElementById('reader-font-value')!.textContent = `${size} px`;
    doc.getElementById('reader-font-preview')!.style.fontSize = `${size}px`;
    smaller.disabled = size <= MIN_SIZE;
    larger.disabled = size >= MAX_SIZE;
    resetSize.disabled = size === DEFAULT_SIZE;
    markButton.setAttribute('aria-pressed', String(!!mark));
    markButton.setAttribute('aria-label', mark ? "Remove reading bookmark" : "Add reading bookmark");
    markButton.classList.toggle('bookmarked', !!mark);
    doc.getElementById('reader-bookmark-label')!.textContent = mark ? 'Remove bookmark' : 'Add bookmark here';
    jump.hidden = !mark;
    if (mark) jump.textContent = `Go to bookmark · ${Math.round(mark.ratio * 100)}%`;
  };
  // Optional preferences must not prevent the article and its tracker from opening.
  const saved = await chrome.storage.local.get([FONT_KEY, key]).catch(() => {
    say("Could not load reading preferences. Using the default font size.");
    return {} as Record<string, unknown>;
  });
  size = fontSize(saved[FONT_KEY]);
  const raw = saved[key] as Partial<Bookmark> | undefined;
  if (typeof raw?.ratio === 'number' && Number.isFinite(raw.ratio)) mark = { ratio: clamp(raw.ratio), savedTs: raw.savedTs ?? 0,
    ...(Number.isInteger(raw.paragraph) && raw.paragraph! >= 0 && typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? { paragraph: raw.paragraph, offset: raw.offset } : {}) };
  paint(); sizeButton.disabled = markButton.disabled = false;
  sizeButton.addEventListener('click', () => fontDialog.showModal());
  doc.getElementById('reader-font-close')!.addEventListener('click', () => fontDialog.close());
  const changeSize = (next: number): void => {
    next = Math.max(MIN_SIZE, Math.min(MAX_SIZE, next));
    if (next === size) return;
    // Preserve the visible paragraph, not a percentage that moves when text reflows.
    const anchor = [...body.querySelectorAll<HTMLElement>('p,h2,h3,li')].find(node => node.getBoundingClientRect().bottom > 80);
    const before = anchor?.getBoundingClientRect().top;
    size = next; paint();
    if (anchor && before !== undefined) window.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'instant' });
    fontStatus.textContent = '';
    fontSaves = fontSaves.then(() => chrome.storage.local.set({ [FONT_KEY]: next })).catch(() => {
      if (size === next) fontStatus.textContent = 'Text size changed, but could not be saved on this device. Try changing it again.';
    });
  };
  smaller.addEventListener('click', () => changeSize(size - 1));
  larger.addEventListener('click', () => changeSize(size + 1));
  resetSize.addEventListener('click', () => changeSize(DEFAULT_SIZE));
  markButton.addEventListener('click', () => {
    if (busy) return;
    busy = true; markButton.disabled = true;
    const paragraphs = [...body.querySelectorAll<HTMLElement>('p,h2,h3,li')];
    const index = paragraphs.findIndex(node => node.getBoundingClientRect().bottom > 80);
    const next: Bookmark | null = mark ? null : { ratio: scrollRatio(window.scrollY, doc.documentElement.scrollHeight, window.innerHeight), savedTs: Date.now(),
      ...(index >= 0 ? { paragraph: index, offset: paragraphs[index]!.getBoundingClientRect().top } : {}) };
    void (next ? chrome.storage.local.set({ [key]: next }) : chrome.storage.local.remove(key)).then(() => {
      mark = next; paint(); say(mark ? "Reading bookmark added" : "Reading bookmark removed");
    }).catch(() => say("Could not save the bookmark. Try again.")).finally(() => { busy = false; markButton.disabled = false; });
  });
  jump.addEventListener('click', () => {
    if (!mark) return;
    tools.close();
    const paragraph = mark.paragraph === undefined ? null : body.querySelectorAll<HTMLElement>('p,h2,h3,li')[mark.paragraph];
    if (paragraph && mark.offset !== undefined) window.scrollBy({ top: paragraph.getBoundingClientRect().top - mark.offset, behavior: 'instant' });
    else window.scrollTo({ top: mark.ratio * Math.max(0, doc.documentElement.scrollHeight - window.innerHeight), behavior: 'instant' });
  });
  const contents = doc.getElementById('chapter-list')!;
  if (book) {
    doc.getElementById('contents-book-title')!.textContent = book.title;
    const toc = doc.getElementById('reader-toc')!;
    toc.hidden = false;
    const location = `Chapter ${(chapter ?? 0) + 1} / ${book.chapters.length}`;
    toc.setAttribute('aria-label', `Open contents, ${location}`);
    toc.title = `Contents · ${location}`;
    doc.getElementById('reader-location')!.textContent = location;
    for (const item of book.chapters) {
      const button = doc.createElement('button'); button.type = 'button'; button.className = 'reader-chapter';
      const number = doc.createElement('span'); number.textContent = String(item.index + 1).padStart(2, '0');
      const title = doc.createElement('span'); title.textContent = item.title;
      button.append(number, title, icon('chevron'));
      if (item.index === chapter) button.setAttribute('aria-current', 'page');
      button.addEventListener('click', () => { dialog.close(); options.openChapter(chapterId(book.id, item.index)); });
      contents.append(button);
    }
  }
  decorateIcons(dialog);
}
