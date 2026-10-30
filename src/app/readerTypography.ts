export type EnglishFont = 'serif' | 'sans' | 'mono';
export type ChineseFont = 'serif' | 'sans' | 'kai';
export const ENGLISH_FONT_KEY = 'reader:font-english';
export const CHINESE_FONT_KEY = 'reader:font-chinese';
export const LEGACY_FONT_KEY = 'reader:font-family';

export function readerFonts(saved: Record<string, unknown>): { english: EnglishFont; chinese: ChineseFont } {
  const legacy = saved[LEGACY_FONT_KEY];
  const en = saved[ENGLISH_FONT_KEY], zh = saved[CHINESE_FONT_KEY];
  return {
    english: en === 'serif' || en === 'sans' || en === 'mono' ? en : legacy === 'sans' ? 'sans' : 'serif',
    chinese: zh === 'serif' || zh === 'sans' || zh === 'kai' ? zh : legacy === 'sans' || legacy === 'kai' ? legacy : 'serif',
  };
}

/** System Latin fonts can contain CJK glyphs too. Mark Han runs so each language
 * really uses its own family, including mixed text in the same paragraph.
 * Keep text and block elements intact for selection, translation and progress. */
export function prepareReaderTypography(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('[data-reader-script],pre,code,kbd,samp,script,style,textarea,svg,math')) continue;
    const matches = [...node.data.matchAll(/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]+/gu)];
    if (!matches.length) continue;
    const fragment = doc.createDocumentFragment();
    let offset = 0;
    for (const match of matches) {
      fragment.append(node.data.slice(offset, match.index));
      const span = doc.createElement('span');
      span.dataset.readerScript = 'zh';
      span.textContent = match[0];
      fragment.append(span);
      offset = match.index + match[0].length;
    }
    fragment.append(node.data.slice(offset));
    node.replaceWith(fragment);
  }
}
