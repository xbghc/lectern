import { openRenamedDb } from "../lib/renamedDb.ts";
import { ARCHIVE_HASH, hashBytes } from "./types.ts";
import { assertDataIdentity, withDataLock } from "../sync/storage.ts";

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  return opening ??= openRenamedDb("lectern-archive-blobs", "focus-session-archive-blobs", 1, db => { db.createObjectStore("blobs"); })
    .catch(error => { opening = null; throw error; });
}

export async function cachedBlob(hash: string): Promise<Blob | undefined> {
  if (!ARCHIVE_HASH.test(hash)) throw new Error("Invalid resource hash");
  const db = await open();
  return new Promise((resolve, reject) => {
    const request = db.transaction("blobs", "readonly").objectStore("blobs").get(hash);
    request.onsuccess = () => resolve(request.result as Blob | undefined);
    request.onerror = () => reject(request.error);
  });
}

/** Commit before publishing any manifest referencing these bytes. */
export async function cacheBlob(hash: string, blob: Blob, expectedIdentity?: string): Promise<void> {
  if (!ARCHIVE_HASH.test(hash) || await hashBytes(new Uint8Array(await blob.arrayBuffer())) !== hash) {
    throw new Error("Article resource verification failed");
  }
  const write = async (): Promise<void> => {
    if (expectedIdentity !== undefined) await assertDataIdentity(expectedIdentity);
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("blobs", "readwrite");
      tx.objectStore("blobs").put(blob, hash);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error("Saving article resources was interrupted"));
    });
  };
  if (expectedIdentity !== undefined) await withDataLock(write);
  else await write();
}

/** 删书时回收它独占的图片。别的书或文章还在引用的哈希由调用方先滤掉。 */
export async function dropBlobs(hashes: readonly string[]): Promise<void> {
  const valid = hashes.filter(hash => ARCHIVE_HASH.test(hash));
  if (valid.length === 0) return;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    for (const hash of valid) tx.objectStore("blobs").delete(hash);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Could not clear book resources"));
  });
}

/** Used by “clear this device”; no server deletion is generated. */
export async function clearArchiveCache(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("blobs", "readwrite");
    tx.objectStore("blobs").clear();
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Could not clear article resources"));
  });
}
