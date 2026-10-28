import { assertDataIdentity, dataIdentity, hasSyncStorage, localStorage, syncDriver } from "../sync/storage.ts";
import { syncRequest, type SyncBinding } from "../sync/engine.ts";
import { sanitizeArticle } from "../app/sanitize.ts";
import { normalizeUrl } from "../lib/url.ts";
import { cacheBlob, cachedBlob } from "./cache.ts";
import { ARCHIVES_KEY, ARCHIVE_HASH, ARCHIVE_SRC, imageMime, readArchiveBytes, MAX_RESOURCE_BYTES, type ArchiveManifest } from "./types.ts";

export interface ArchivedArticle {
  url: string;
  finalUrl: string;
  title: string;
  html: string;
  savedTs: number;
  archiveManifest: ArchiveManifest;
}

async function readerState() {
  if (hasSyncStorage()) return syncDriver().read();
  return { data: await localStorage().get(ARCHIVES_KEY), deviceId: await dataIdentity(), config: { enabled: false, baseUrl: "", token: "" } };
}

async function blobFor(hash: string, binding: SyncBinding): Promise<Blob> {
  if (!ARCHIVE_HASH.test(hash)) throw new Error("Invalid article resource index");
  const existing = await cachedBlob(hash);
  if (existing) return existing;
  const response = await syncRequest(`/v1/blobs/${hash}`, {}, binding);
  if (!response.ok) throw new Error(`Article resource download failed: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > MAX_RESOURCE_BYTES) throw new Error("Article resources exceed the size limit");
  const blob = new Blob([new Uint8Array(await readArchiveBytes(response))], { type: response.headers.get("content-type") ?? "application/octet-stream" });
  await cacheBlob(hash, blob, binding.deviceId);
  return blob;
}

/** No source-site request occurs when an archive is available. */
export async function loadArchivedArticle(url: string, expectedIdentity?: string): Promise<ArchivedArticle | null> {
  const { data, config, deviceId } = await readerState();
  if (expectedIdentity !== undefined && expectedIdentity !== deviceId) throw new Error("Local data was cleared. Reopen the article.");
  const archives = (data[ARCHIVES_KEY] ?? {}) as Record<string, ArchiveManifest>;
  const id = normalizeUrl(url);
  const manifest = archives[id] ?? Object.values(archives).find(item => normalizeUrl(item.url) === id);
  if (!manifest) return null;
  if (!/^https?:\/\//i.test(manifest.url) || !Array.isArray(manifest.resources)) throw new Error("Invalid article manifest");
  const html = await (await blobFor(manifest.htmlHash, { config, deviceId })).text();
  await assertDataIdentity(deviceId);
  return {
    url, finalUrl: manifest.url, title: manifest.title, savedTs: manifest.createdTs,
    html: sanitizeArticle(html, manifest.url, document, true), archiveManifest: manifest,
  };
}

/** Create transient URLs only after sanitizing; never persist those URLs. */
export async function hydrateArchiveImages(body: HTMLElement, manifest: ArchiveManifest, expectedIdentity?: string): Promise<{ missing: number; release: () => void }> {
  // Strip URLs before the first await: the caller can attach the body immediately.
  const resources = new Map(manifest.resources.map(resource => [resource.hash, resource]));
  const urls = new Map<string, Promise<string>>();
  const allocated = new Set<string>();
  let missing = manifest.missingResources?.length ?? 0;
  const images = [...body.querySelectorAll("img")];
  // Strip URLs synchronously, before this element enters the live document.
  const pending = images.map(img => {
    const hash = ARCHIVE_SRC.exec(img.getAttribute("src") ?? "")?.[1];
    img.removeAttribute("src");
    return { img, hash };
  });
  const { config, deviceId } = await readerState();
  if (expectedIdentity !== undefined && expectedIdentity !== deviceId) throw new Error("Local data was cleared. Reopen the article.");
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const { img, hash } = pending.shift()!;
      try {
        const resource = hash ? resources.get(hash) : undefined;
        if (!hash || !resource || !imageMime(resource.mime)) throw new Error("Unknown image resource");
        let loaded = urls.get(hash);
        if (!loaded) {
          loaded = (async () => {
            const blob = await blobFor(hash, { config, deviceId });
            if (blob.size !== resource.size) throw new Error("Image size verification failed");
            const url = URL.createObjectURL(new Blob([blob], { type: resource.mime }));
            allocated.add(url);
            return url;
          })();
          urls.set(hash, loaded);
        }
        img.src = await loaded;
      } catch {
        missing++;
        const placeholder = document.createElement("span");
        placeholder.textContent = img.alt ? `(Image not downloaded: ${img.alt})` : "(Image not downloaded. Reopen while online to retry.)";
        img.replaceWith(placeholder);
      }
    }
  }));
  const release = (): void => { for (const url of allocated) URL.revokeObjectURL(url); };
  try { await assertDataIdentity(deviceId); }
  catch (error) { release(); throw error; }
  return { missing, release };
}
