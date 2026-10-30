import { readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

/** Use the same offline font files in Android, Storybook and the Site preview. */
export function readerFontBundle({ root = resolve(import.meta.dirname, '..'), inline = false } = {}) {
  const files = new Map();
  const styles = [
    ['@fontsource-variable/literata', 'standard.css'],
    ['@fontsource-variable/literata', 'standard-italic.css'],
    ['lxgw-wenkai-screen-webfont', 'lxgwwenkaiscreen.css'],
  ];
  const css = styles.map(([pkg, stylesheet]) => {
    const directory = resolve(root, 'node_modules', pkg);
    return readFileSync(resolve(directory, stylesheet), 'utf8').replace(
      /url\(['"]?(\.\/files\/[^'"\)]+)['"]?\)/g,
      (_match, path) => {
        const source = resolve(directory, path), name = basename(path);
        files.set(name, source);
        return inline ? `url(data:font/woff2;base64,${readFileSync(source).toString('base64')})` : `url(fonts/${name})`;
      },
    );
  }).join('\n');
  const licenses = [
    ['@fontsource-variable/literata/LICENSE', 'Literata-OFL.txt'],
    ['lxgw-wenkai-screen-webfont/OFL.txt', 'LXGW-WenKai-Screen-OFL.txt'],
    ['lxgw-wenkai-screen-webfont/LICENSE', 'LXGW-WenKai-Webfont-MIT.txt'],
    ['lxgw-wenkai-screen-webfont/README.md', 'LXGW-WenKai-Webfont-README.md'],
  ].map(([source, name]) => [resolve(root, 'node_modules', source), name]);
  return { css, files, licenses };
}
