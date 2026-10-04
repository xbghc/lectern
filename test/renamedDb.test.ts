import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory } from "fake-indexeddb";
import { openRenamedDb } from "../src/lib/renamedDb.ts";
import { indexedDriver } from "../src/sync/storage.ts";

/** 每个用例一个干净的假 IndexedDB；跑完把全局的还回去。 */
async function withFactory(run: (factory: IDBFactory) => Promise<void>): Promise<void> {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
  const factory = new IDBFactory();
  Object.defineProperty(globalThis, "indexedDB", { value: factory, writable: true, configurable: true });
  try { await run(factory); }
  finally {
    if (previous) Object.defineProperty(globalThis, "indexedDB", previous);
    else delete (globalThis as { indexedDB?: unknown }).indexedDB;
  }
}

const done = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function seedDb(factory: IDBFactory, name: string, store: string, rows: Record<string, unknown>): Promise<void> {
  const r = factory.open(name, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(store);
  const db = await done(r);
  const tx = db.transaction(store, "readwrite");
  for (const [k, v] of Object.entries(rows)) tx.objectStore(store).put(v, k);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  db.close();
}

const names = async (factory: IDBFactory) => (await factory.databases()).map((d) => d.name).sort();
const get = (db: IDBDatabase, store: string, key: string) => done(db.transaction(store).objectStore(store).get(key));
const mk = (store: string) => (db: IDBDatabase) => { db.createObjectStore(store); };

test("改名后第一次打开：旧库的内容搬进新库，旧库删掉", async () => {
  await withFactory(async (factory) => {
    await seedDb(factory, "old", "blobs", { a: "甲", b: { n: 2 } });
    const db = await openRenamedDb("new", "old", 1, mk("blobs"));
    assert.equal(await get(db, "blobs", "a"), "甲");
    assert.deepEqual(await get(db, "blobs", "b"), { n: 2 });
    db.close();
    assert.deepEqual(await names(factory), ["new"]);
  });
});

test("没有旧库：照常建一个空的新库", async () => {
  await withFactory(async (factory) => {
    const db = await openRenamedDb("new", "old", 1, mk("blobs"));
    assert.equal(await get(db, "blobs", "a"), undefined);
    db.close();
    assert.deepEqual(await names(factory), ["new"]);
  });
});

test("新旧都在（上次搬完没删成）：新库原样不动，只把旧库删掉", async () => {
  await withFactory(async (factory) => {
    await seedDb(factory, "old", "blobs", { a: "旧" });
    await seedDb(factory, "new", "blobs", { a: "新" });
    const db = await openRenamedDb("new", "old", 1, mk("blobs"));
    assert.equal(await get(db, "blobs", "a"), "新");
    db.close();
    assert.deepEqual(await names(factory), ["new"]);
  });
});

test("两处同时来开：只搬一次，谁都不会看到空的新库", async () => {
  await withFactory(async (factory) => {
    await seedDb(factory, "old", "blobs", { a: "甲" });
    const [x, y] = await Promise.all([openRenamedDb("new", "old", 1, mk("blobs")), openRenamedDb("new", "old", 1, mk("blobs"))]);
    assert.equal(await get(x, "blobs", "a"), "甲");
    assert.equal(await get(y, "blobs", "a"), "甲");
    x.close(); y.close();
  });
});

test("同步库改名后接着用原来的状态：设备号不变，也不重新播种", async () => {
  await withFactory(async () => {
    const before = indexedDriver(async () => ({ articles: {} }), "focus-session-sync-v1", "none");
    const deviceId = (await before.read()).deviceId;
    await before.update((s) => { s.counter = 41; });
    const after = indexedDriver(async () => { throw new Error("不该重新播种"); });
    const state = await after.read();
    assert.equal(state.deviceId, deviceId);
    assert.equal(state.counter, 41);
  });
});
