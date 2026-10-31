import { icon, decorateIcons } from '../ui/icons.ts';
import { chapterId, type Book } from '../books/types.ts';
import { createUiTracker } from '../lib/uiUsage.ts';
import { ENGLISH_FONT_KEY, CHINESE_FONT_KEY, LEGACY_FONT_KEY, readerFonts, prepareReaderTypography, type EnglishFont, type ChineseFont } from './readerTypography.ts';

const FONT_KEY = 'reader:font-size';
const THEME_KEY = 'reader:theme';
const BOOKMARK_PREFIX = 'reader:bookmark:';
export const FONT_SIZES = [15, 16, 17, 18, 20, 22, 24] as const;
const DEFAULT_SIZE = 18;
type ReaderTheme = 'auto' | 'white' | 'sepia' | 'dark';
interface Bookmark { ratio: number; savedTs: number; paragraph?: number; offset?: number }
const clamp = (value: number): number => Math.max(0, Math.min(1, value));
export function scrollRatio(top: number, height: number, viewport: number): number {
  return height > viewport ? clamp(top / (height - viewport)) : 0;
}
export function fontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 14 || value > 28) return DEFAULT_SIZE;
  // Older versions allowed every integer from 14 to 28. Keep the closest design step.
  return FONT_SIZES.reduce<number>((nearest, size) => Math.abs(size - value) < Math.abs(nearest - value) ? size : nearest, DEFAULT_SIZE);
}

/** Device-local reading preferences and bookmarks never enter the sync protocol. */
export async function setupReaderControls(options: {
  articleId: string; body: HTMLElement; book: Book | null; chapter: number | null;
  openChapter: (url: string) => void;
  closeTools?: (settings: { restoreScroll: boolean }) => void;
}): Promise<void> {
  const { body, articleId, book, chapter } = options;
  const doc = body.ownerDocument;
  const host = doc.defaultView!;
  const preferences = doc.getElementById('reader-preferences') as HTMLFieldSetElement;
  const markButton = doc.getElementById('reader-bookmark') as HTMLButtonElement;
  const dialog = doc.getElementById('reader-contents') as HTMLDialogElement;
  const tools = doc.getElementById('reader-tools') as HTMLDialogElement;
  const smaller = doc.getElementById('reader-font-smaller') as HTMLButtonElement;
  const larger = doc.getElementById('reader-font-larger') as HTMLButtonElement;
  const fontStatus = doc.getElementById('reader-font-status')!;
  const jump = doc.getElementById('bookmark-jump') as HTMLButtonElement;
  const key = BOOKMARK_PREFIX + articleId;
  let size = DEFAULT_SIZE, theme: ReaderTheme = 'auto', mark: Bookmark | null = null;
  let english: EnglishFont = 'literata', chinese: ChineseFont = 'wenkai';
  prepareReaderTypography(body);
  const title = doc.querySelector<HTMLElement>('.article h1.atitle');
  if (title) prepareReaderTypography(title);
  let busy = false;
  let preferenceSaves = Promise.resolve();
  let saveRevision = 0;
  const tracker = createUiTracker(events => void chrome.runtime.sendMessage({ type: 'ui:track', events }).catch(() => undefined));
  const status = doc.getElementById('reader-feedback')!;
  const toolStatus = doc.getElementById('reader-tools-status')!;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  const say = (text: string): void => {
    clearTimeout(feedbackTimer);
    status.textContent = tools.open ? '' : text;
    toolStatus.textContent = tools.open ? text : '';
    feedbackTimer = setTimeout(() => { status.textContent = ''; toolStatus.textContent = ''; }, 3000);
  };
  host.addEventListener('pagehide', () => { clearTimeout(feedbackTimer); tracker.flush(); }, { once: true });
  const steps = FONT_SIZES.map(value => {
    const button = doc.createElement('button');
    button.type = 'button'; button.dataset.size = String(value);
    button.setAttribute('aria-label', `Text size ${value}`);
    button.title = `Text size ${value}`;
    button.append(doc.createElement('span'));
    doc.getElementById('reader-size-steps')!.append(button);
    return button;
  });
  const themes = [...doc.querySelectorAll<HTMLButtonElement>('.reader-themes button')];
  const fonts = [...doc.querySelectorAll<HTMLButtonElement>('.reader-fonts button')];
  const paint = (): void => {
    const index = FONT_SIZES.findIndex(value => value === size);
    const style = doc.documentElement.style;
    style.setProperty('--reader-font-size', `${size}px`);
    style.setProperty('--reader-line-height', (1.9 - index * .04).toFixed(2));
    style.setProperty('--reader-margin', `${26 - index}px`);
    style.setProperty('--reader-paragraph-gap', `${Math.round(size * .55)}px`);
    style.colorScheme = theme === 'auto' ? 'light dark' : theme === 'dark' ? 'dark' : 'light';
    doc.body.dataset.readerTheme = theme;
    doc.body.dataset.readerEnglish = english;
    doc.body.dataset.readerChinese = chinese;
    doc.getElementById('reader-font-value')!.textContent = `${size} px`;
    smaller.disabled = index === 0;
    larger.disabled = index === FONT_SIZES.length - 1;
    for (const [i, button] of steps.entries()) {
      button.setAttribute('aria-pressed', String(i === index));
      button.classList.toggle('is-filled', i <= index);
    }
    for (const button of themes) button.setAttribute('aria-pressed', String(button.dataset.readerTheme === theme));
    for (const button of fonts) button.setAttribute('aria-pressed', String(button.dataset.readerFont === (button.dataset.readerLanguage === 'en' ? english : chinese)));
    markButton.setAttribute('aria-pressed', String(!!mark));
    markButton.setAttribute('aria-label', mark ? "Remove reading bookmark" : "Add reading bookmark");
    markButton.title = mark ? "Remove reading bookmark" : "Add reading bookmark";
    markButton.classList.toggle('bookmarked', !!mark);
    doc.getElementById('reader-bookmark-label')!.textContent = mark ? 'Remove bookmark' : 'Add bookmark here';
    jump.hidden = !mark;
    if (mark) {
      const position = `${book ? `Chapter ${(chapter ?? 0) + 1} · ` : ''}${Math.round(mark.ratio * 100)}%`;
      doc.getElementById('bookmark-position')!.textContent = position;
      jump.setAttribute('aria-label', `Go to bookmark, ${position}`);
      jump.title = `Go to bookmark · ${position}`;
    }
  };
  // Optional preferences must not prevent the article and its tracker from opening.
  const saved = await chrome.storage.local.get([FONT_KEY, THEME_KEY, LEGACY_FONT_KEY, ENGLISH_FONT_KEY, CHINESE_FONT_KEY, key]).catch(() => {
    fontStatus.textContent = "Could not load reading preferences. Using the defaults.";
    return {} as Record<string, unknown>;
  });
  size = fontSize(saved[FONT_KEY]);
  if (['white', 'sepia', 'dark'].includes(saved[THEME_KEY] as string)) theme = saved[THEME_KEY] as ReaderTheme;
  ({ english, chinese } = readerFonts(saved));
  const raw = saved[key] as Partial<Bookmark> | undefined;
  if (typeof raw?.ratio === 'number' && Number.isFinite(raw.ratio)) mark = { ratio: clamp(raw.ratio), savedTs: raw.savedTs ?? 0,
    ...(Number.isInteger(raw.paragraph) && raw.paragraph! >= 0 && typeof raw.offset === 'number' && Number.isFinite(raw.offset) ? { paragraph: raw.paragraph, offset: raw.offset } : {}) };
  paint(); preferences.disabled = markButton.disabled = false;
  const save = (): void => {
    const revision = ++saveRevision;
    const snapshot = { [FONT_KEY]: size, [THEME_KEY]: theme, [ENGLISH_FONT_KEY]: english, [CHINESE_FONT_KEY]: chinese };
    fontStatus.textContent = '';
    preferenceSaves = preferenceSaves.then(() => chrome.storage.local.set(snapshot)).then(() => {
      if (revision === saveRevision) fontStatus.textContent = '';
    }).catch(() => {
      if (revision === saveRevision) fontStatus.textContent = 'Appearance changed, but could not be saved on this device. Try choosing a setting again.';
    });
  };
  const reflow = (change: () => void): void => {
    // Preserve the visible paragraph, not a percentage that moves when text reflows.
    const anchor = [...body.querySelectorAll<HTMLElement>('p,h2,h3,li')].find(node => node.getBoundingClientRect().bottom > 80);
    const before = anchor?.getBoundingClientRect().top;
    change(); paint();
    if (anchor && before !== undefined) host.scrollBy({ top: anchor.getBoundingClientRect().top - before, behavior: 'instant' });
  };
  const changeSize = (next: number): void => {
    if (next !== size) {
      reflow(() => { size = next; });
      tracker.track('reader.size');
    }
    save();
  };
  smaller.addEventListener('click', () => changeSize(FONT_SIZES[Math.max(0, FONT_SIZES.findIndex(value => value === size) - 1)]!));
  larger.addEventListener('click', () => changeSize(FONT_SIZES[Math.min(FONT_SIZES.length - 1, FONT_SIZES.findIndex(value => value === size) + 1)]!));
  for (const button of steps) button.addEventListener('click', () => changeSize(Number(button.dataset.size)));
  for (const button of themes) button.addEventListener('click', () => {
    const next = button.dataset.readerTheme as ReaderTheme;
    if (theme !== next) { theme = next; paint(); tracker.track('reader.theme'); }
    save();
  });
  for (const button of fonts) button.addEventListener('click', () => {
    reflow(() => {
      if (button.dataset.readerLanguage === 'en') english = button.dataset.readerFont as EnglishFont;
      else chinese = button.dataset.readerFont as ChineseFont;
    });
    tracker.track('reader.font');
    save();
  });
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
    if (options.closeTools) options.closeTools({ restoreScroll: false });
    else tools.close();
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
