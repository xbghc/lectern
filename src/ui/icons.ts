const paths = {
  brand: '<path fill="currentColor" stroke="none" fill-rule="evenodd" transform="translate(-4 -4) scale(.25)" d="M20 32H40C48 32 54 35 60 40V89.5C60 91.9 58.8 92.3 56.8 90.9C51.8 87.4 46.6 86 40 86H20ZM68 40C74 35 80 32 88 32H108V86H88C81.4 86 76.2 87.4 71.2 90.9C69.2 92.3 68 91.9 68 89.5ZM88 32H100V62L94 56L88 62Z"/>',
  book: '<path d="M12 5C8 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-2-10 1Zm0 0v16M5 7l4 1M5 11l4 1m6-4 4-1m-4 5 4-1"/>',
  words: '<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 13l3-7 3 7m-5-2h4m-5 10h14V7"/>',
  review: '<rect x="7" y="5" width="14" height="17" rx="2"/><path d="M17 2H5a2 2 0 0 0-2 2v14m8-9h6m-6 4h6m-6 4h4"/>',
  chart: '<path d="M3 3v18h18M7 17v-5m5 5V7m5 10V4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chat: '<path d="M21 11a8 8 0 0 1-8 8H7l-5 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z"/><path d="M7 9h9M7 13h6"/>',
  send: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  settings: '<path d="m9 3-1 3-3 1-2 4 2 2v3l4 2 1 3h4l1-3 4-2v-3l2-2-2-4-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="m7 4 14 8-14 8Z"/>',
  shelf: '<path d="M3 4h4v16H3Zm6 0h4v16H9Zm6 1 4-1 4 15-4 1Z"/>',
  bookmark: '<path d="M6 3h12v19l-6-4-6 4Z"/>',
  type: '<path d="M3 5h12M9 5v14M6 19h6m3 0 3-8 3 8m-5-3h4"/>',
  back: '<path d="m14 5-7 7 7 7M7 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  filter: '<path d="M4 6h16M7 12h10m-7 6h4"/>',
  select: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true"); svg.classList.add("ui-icon");
  // Only the static paths above are inserted; page/model content always uses textContent.
  svg.innerHTML = paths[name];
  return svg;
}
export function decorateIcons(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = node.dataset.icon as IconName;
    if (name in paths) node.replaceChildren(icon(name));
  }
}

/** Icon actions always retain a name for touch, keyboard and screen-reader users. */
export function iconButton(name: IconName, label: string, className = 'icon-btn'): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button'; button.className = className;
  button.title = label; button.setAttribute('aria-label', label);
  button.append(icon(name));
  return button;
}
