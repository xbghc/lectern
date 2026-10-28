import { test, beforeEach, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { freshState, memoryDriver, installStorage, localStorage, trackChanges, type StateDriver } from "../src/sync/storage.ts";
import { cacheBlob, cachedBlob, clearArchiveCache } from "../src/archive/cache.ts";
import { hashBytes, type ArchiveManifest } from "../src/archive/types.ts";
import { mergeRecord, recordKey, validateRecord, type SyncRecord, type SyncOperation } from "../src/sync/protocol.ts";
import { chapterId, type Book } from "../src/books/types.ts";

const realFetch = globalThis.fetch, g = globalThis as Record<string, unknown>;
const oldIdb = g.indexedDB, oldChrome = g.chrome;
g.indexedDB = new IDBFactory();
let driver: StateDriver;
let records = new Map<string, SyncRecord>(), changes: SyncRecord[] = [], blobs = new Set<string>();
let calls: Array<{ path: string; method: string; token: string | null }> = [];
let beforeRequest: ((path: string) => Promise<void>) | undefined;
const put = (record: SyncRecord): void => {
  const key = recordKey(record), next = mergeRecord(records.get(key), record);
  records.set(key, next); changes.push(next);
};
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input)), path = url.pathname, method = init.method ?? "GET";
  calls.push({ path, method, token: new Headers(init.headers).get("Authorization") });
  await beforeRequest?.(path);
  if (path === "/v1/info") return Response.json({ protocol: 1, serverId: "server", userId: "account-a" });
  if (path === "/v1/sync/pull") {
    const cursor = Number(url.searchParams.get("cursor"));
    return Response.json({ records: changes.slice(cursor), cursor: changes.length, hasMore: false });
  }
  if (path.startsWith("/v1/blobs/")) {
    const hash = path.slice("/v1/blobs/".length);
    if (method === "PUT") { blobs.add(hash); return Response.json({ hash }, { status: 201 }); }
    return blobs.has(hash) ? new Response(null) : Response.json({ error: "BLOB_NOT_FOUND" }, { status: 404 });
  }
  if (path === "/v1/archives") {
    const { stamp, generation, opId, ...manifest } = JSON.parse(String(init.body));
    assert.ok([manifest.htmlHash, ...manifest.resources.map((r: { hash: string }) => r.hash)].every(hash => blobs.has(hash)));
    const record = validateRecord({ type: "archive", id: manifest.articleId, articleId: manifest.articleId, value: manifest, stamp, generation, deleted: false });
    put(record); return Response.json({ accepted: [opId], head: changes.length, record });
  }
  if (path === "/v1/sync/push") {
    const { operations } = JSON.parse(String(init.body)) as { operations: SyncOperation[] };
    for (const operation of operations) put(validateRecord(operation.record));
    return Response.json({ accepted: operations.map(op => op.opId), head: changes.length });
  }
  return Response.json({ error: "NOT_FOUND" }, { status: 404 });
};
// The sync engine captures fetch once, just as it does before installing Android's bridge.
const { runSync, disconnectSync, materialSync } = await import("../src/sync/engine.ts");
const syncFetch = globalThis.fetch;
const { flushArchives, saveArchive } = await import("../src/archive/background.ts");
const { deleteBook } = await import("../src/books/local.ts");
const { handle } = await import("../src/background/handle.ts");
beforeEach(async () => {
  if (driver) await disconnectSync();
  await clearArchiveCache();
  records = new Map(); changes = []; blobs = new Set(); calls = []; beforeRequest = undefined;
  const state = freshState(); state.initializedRemote = true;
  state.config = { enabled: true, baseUrl: "https://sync.example", token: "synthetic-a", userId: "account-a", serverId: "server" };
  driver = memoryDriver(state); installStorage(driver);
  let open: Record<string, unknown> = {};
  g.chrome = { runtime: { sendMessage: (message: Parameters<typeof handle>[0]) => handle(message, {}) }, storage: { session: {
    get: async () => structuredClone(open), set: async (values: Record<string, unknown>) => { open = { ...open, ...structuredClone(values) }; },
  } } };
});
after(async () => {
  await disconnectSync(); globalThis.fetch = realFetch;
  if (oldIdb === undefined) delete g.indexedDB; else g.indexedDB = oldIdb;
  if (oldChrome === undefined) delete g.chrome; else g.chrome = oldChrome;
});
afterEach(() => { globalThis.fetch = syncFetch; });
async function resource(text: string) {
  const blob = new Blob([text], { type: "image/png" }), hash = await hashBytes(new Uint8Array(await blob.arrayBuffer()));
  return { blob, hash, mime: blob.type, size: blob.size };
}
async function archive(articleId: string): Promise<ArchiveManifest> {
  const body = new Blob([`<p>${articleId}</p>`], { type: "text/html" });
  const htmlHash = await hashBytes(new Uint8Array(await body.arrayBuffer())); await cacheBlob(htmlHash, body);
  return { articleId, url: articleId, title: "Article", version: crypto.randomUUID(), htmlHash, resources: [], missingResources: [], createdTs: 1 };
}
async function queue(manifest: ArchiveManifest) {
  await driver.update(state => {
    const before = structuredClone(state.data);
    state.data.archives = { ...state.data.archives, [manifest.articleId]: manifest };
    state.data.archivePending = { ...state.data.archivePending, [manifest.articleId]: manifest };
    trackChanges(state, before, state.data);
  });
}

test("a missing archive image does not block healthy archives or records, and a repaired archive retries successfully", async () => {
  const missing = await resource("not cached yet");
  const bad = await archive("https://example.com/bad"); bad.resources = [missing];
  const good = await archive("https://example.com/good");
  await queue(bad); await queue(good);
  await localStorage().set({ settings: { translateEnabled: false } });
  const first = await runSync();
  assert.equal(first.error, null); assert.equal(first.blocked, 1); assert.equal(first.pending, 1);
  assert.ok(records.has(recordKey({ type: "setting", id: "translateEnabled" })));
  assert.ok(records.has(recordKey({ type: "archive", id: good.articleId })));
  assert.equal(records.has(recordKey({ type: "archive", id: bad.articleId })), false);
  assert.equal((await materialSync(bad.articleId)).state, "blocked");
  assert.match(first.blockedReasons[0]!, /resources are missing/);
  await cacheBlob(missing.hash, missing.blob);
  const second = await runSync();
  assert.deepEqual([second.error, second.pending, second.blocked], [null, 0, 0]);
  assert.equal((await driver.read()).archiveErrors?.[bad.articleId], undefined);
});

test("deleting a book preserves images used by articles, pending uploads, cached old versions and other books", async () => {
  const refs = await Promise.all(["archive", "pending", "cached", "book", "unreferenced"].map(resource));
  for (const ref of refs) await cacheBlob(ref.hash, ref.blob);
  const id = "ab".repeat(32), otherId = "cd".repeat(32);
  const book: Book = { id, title: "Book", author: "", fileName: "book.epub", addedTs: 1, missingResources: 0,
    chapters: [{ index: 0, title: "Chapter", words: 10 }], resources: refs.map(ref => ref.hash) };
  const current = await archive("https://example.com/current"); current.resources = [refs[0]!];
  const pending = await archive("https://example.com/pending"); pending.resources = [refs[1]!];
  const cached = await archive("https://example.com/cached"); cached.resources = [refs[2]!];
  await queue(current); await queue(pending);
  await localStorage().set({ books: { [id]: book, [otherId]: { ...book, id: otherId, resources: [refs[3]!.hash] } },
    [`rh:${cached.articleId}`]: { archiveManifest: cached }, [`rh:${chapterId(id, 0)}`]: { book: { id } } });
  await deleteBook(id);
  for (const ref of refs.slice(0, 4)) assert.ok(await cachedBlob(ref.hash));
  assert.equal(await cachedBlob(refs[4]!.hash), undefined);
  const state = await driver.read();
  assert.equal(state.data.books[id], undefined); assert.ok(state.data.books[otherId]);
  assert.equal(state.data[`rh:${chapterId(id, 0)}`], undefined);
});

test("an archive request started before clearing cannot continue with a different account token", async () => {
  const manifest = await archive("https://example.com/private"); await queue(manifest);
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  beforeRequest = async path => { if (path.startsWith("/v1/blobs/")) { entered(); await new Promise<void>(resolve => { release = resolve; }); } };
  const work = flushArchives(); await ready;
  await driver.update(state => { const next = freshState(); next.config = { ...state.config, token: "synthetic-b", userId: "account-b" }; Object.assign(state, next); });
  release(); await assert.rejects(work, /Sync settings changed/);
  assert.equal(calls.some(call => call.token === "Bearer synthetic-b"), false);
  assert.equal((await driver.read()).data.archivePending, undefined);
});

test("clearing data rejects both active and queued captures and prevents late resource writes", async () => {
  const image = await resource('private image');
  let release!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); };
  const url = 'https://example.com/private-image';
  const payload = { articleId: 'https://example.com/capture', url: 'https://example.com/capture', title: 'Private article',
    html: `<p>Private text</p><img src="${url}">`, resources: [{ url }], missingResources: [], createdTs: 1 };
  const first = saveArchive(payload); await started;
  const queued = saveArchive({ ...payload, articleId: 'https://example.com/queued', url: 'https://example.com/queued', resources: [] });
  // Attach rejection handlers before resolving the simulated request.
  const results = Promise.allSettled([first, queued]);
  await handle({ type: 'data:clear' }, {});
  release(new Response(image.blob, { headers: { 'content-type': image.mime } }));
  const outcomes = await results;
  assert.deepEqual(outcomes.map(result => result.status), ['rejected', 'rejected']);
  assert.equal(await cachedBlob(image.hash), undefined);
  const state = await driver.read();
  assert.equal(Object.keys(state.data.archives ?? {}).length, 0);
  assert.equal(Object.keys(state.data.archivePending ?? {}).length, 0);
  assert.equal(state.outbox.some(op => op.record.type === 'archive'), false);
});
