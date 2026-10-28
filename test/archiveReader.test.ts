import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { JSDOM } from 'jsdom';
import { freshState, memoryDriver, installStorage, type StateDriver } from '../src/sync/storage.ts';
import { hashBytes, type ArchiveManifest } from '../src/archive/types.ts';
import { cacheBlob, cachedBlob } from '../src/archive/cache.ts';
import { clearData } from '../src/background/store.ts';

const g = globalThis as Record<string, unknown>, previous = { indexedDB: g.indexedDB, document: g.document, fetch: globalThis.fetch };
const dom = new JSDOM(); g.document = dom.window.document; g.indexedDB = new IDBFactory();
let driver: StateDriver;
let respond: (path: string) => Promise<Response>;
let requests: Array<{ path: string; token: string | null }>;
globalThis.fetch = async (input, init) => {
  const path = new URL(String(input)).pathname;
  requests.push({ path, token: new Headers(init?.headers).get('Authorization') });
  return respond(path);
};
const { loadArchivedArticle, hydrateArchiveImages } = await import('../src/archive/reader.ts');
beforeEach(async () => {
  const state = freshState();
  state.config = { enabled: true, token: 'synthetic-a', baseUrl: 'https://sync.example', userId: 'account-a', serverId: 'server' };
  driver = memoryDriver(state); installStorage(driver); requests = [];
  respond = async () => { throw new Error('Unexpected request'); };
});
after(() => {
  globalThis.fetch = previous.fetch; dom.window.close();
  for (const key of ['indexedDB', 'document'] as const) {
    if (previous[key] === undefined) delete g[key]; else g[key] = previous[key];
  }
});
async function bindNewAccount() {
  await clearData();
  await driver.update(state => { state.config = { enabled: true, token: 'synthetic-b', baseUrl: 'https://sync.example', userId: 'account-b', serverId: 'server' }; });
}
const base = (): ArchiveManifest => ({ articleId: 'https://example.com/private', url: 'https://example.com/private', title: 'Private',
  version: 'v1', htmlHash: 'a'.repeat(64), resources: [], missingResources: [], createdTs: 1 });

test('cached archives still open offline and strip image sources synchronously before hydration', async () => {
  const manifest = base(), blob = new Blob(['offline image'], { type: 'image/png' });
  const hash = await hashBytes(new Uint8Array(await blob.arrayBuffer()));
  manifest.resources = [{ hash, size: blob.size, mime: blob.type }];
  const html = `<p>Offline text</p><img src="fs-blob:${hash}">`;
  manifest.htmlHash = await hashBytes(new TextEncoder().encode(html));
  await cacheBlob(manifest.htmlHash, new Blob([html])); await cacheBlob(hash, blob);
  await driver.update(state => { state.config.enabled = false; state.data.archives = { [manifest.articleId]: manifest }; });
  const article = await loadArchivedArticle(manifest.url);
  assert.ok(article);
  const body = dom.window.document.createElement('div'); body.innerHTML = article.html;
  const pending = hydrateArchiveImages(body, manifest);
  assert.equal(body.querySelector('img')!.hasAttribute('src'), false);
  const hydrated = await pending;
  try { assert.equal(hydrated.missing, 0); assert.match(body.querySelector('img')!.src, /^blob:/); }
  finally { hydrated.release(); }
  assert.equal(requests.length, 0);
});

test('an article download cannot return or cache old content after clearing and rebinding', async () => {
  const html = '<p>Private article before account switch</p>', manifest = base();
  manifest.htmlHash = await hashBytes(new TextEncoder().encode(html));
  await driver.update(state => { state.data.archives = { [manifest.articleId]: manifest }; });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  respond = async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return new Response(html); };
  const download = loadArchivedArticle(manifest.url);
  const rejected = assert.rejects(download, /Local data was cleared|Sync settings changed/);
  await started; await bindNewAccount(); release(); await rejected;
  assert.equal(await cachedBlob(manifest.htmlHash), undefined);
  assert.equal(requests.some(request => request.token === 'Bearer synthetic-b'), false);
});

test('queued archive images never use credentials from a replacement account', async () => {
  const manifest = base(), images = await Promise.all(Array.from({ length: 6 }, async (_, n) => {
    const blob = new Blob([`image-${n}`], { type: 'image/png' });
    return { blob, hash: await hashBytes(new Uint8Array(await blob.arrayBuffer())), size: blob.size, mime: blob.type };
  }));
  manifest.resources = images;
  const body = dom.window.document.createElement('div');
  body.innerHTML = images.map(image => `<img src="fs-blob:${image.hash}">`).join('');
  let release!: () => void, entered!: () => void, count = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  respond = async path => {
    if (++count === 4) entered();
    await hold;
    return new Response(images.find(image => path.endsWith(image.hash))!.blob);
  };
  const hydration = hydrateArchiveImages(body, manifest);
  const rejected = assert.rejects(hydration, /Local data was cleared|Sync settings changed/);
  await started; await bindNewAccount(); release(); await rejected;
  assert.equal(requests.some(request => request.token === 'Bearer synthetic-b'), false);
  for (const image of images) assert.equal(await cachedBlob(image.hash), undefined);
});
