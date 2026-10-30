/**
 * 书目在本机的存取。
 *
 * 三处落盘，都在本机：书目在 `books` 这个键下，每章正文借用阅读器自己的正文缓存
 * （`rh:<章 id>`，再打开秒开、断网也能看），图片在文章存档共用的资源库里。
 * 都不进同步——书是用户自己拿来的文件，正文多半有版权，不该上传到服务器
 * （拦在 sync/storage.ts 的 entries 里，那儿只放 http(s) 的记录出去）。
 */

import { cacheBlob, cachedBlob, dropBlobs } from "../archive/cache.ts";
import { ARCHIVE_SRC, hashBytes, imageMime, type ArchiveResource, type ArchiveManifest } from "../archive/types.ts";
import { READER_PREFIX, serialize } from "../background/store.ts";
import { localStorage } from "../sync/storage.ts";
import type { BookSink } from "./import.ts";
import { BOOKS_KEY, BOOK_ID, chapterId, type Book, type BookChapterContent } from "./types.ts";

const read = async (): Promise<Record<string, Book>> => {
  const data = await localStorage().get(BOOKS_KEY);
  const books = data[BOOKS_KEY];
  return books && typeof books === "object" ? books as Record<string, Book> : {};
};

export async function listBooks(): Promise<Book[]> {
  return Object.values(await read()).sort((a, b) => b.addedTs - a.addedTs);
}

export async function getBook(id: string): Promise<Book | null> {
  return (await read())[id] ?? null;
}

export async function saveBook(book: Book): Promise<Book> {
  if (!BOOK_ID.test(book.id)) throw new Error("Invalid book identifier");
  return serialize(async () => {
    const books = await read();
    const previous = books[book.id];
    // Re-importing an identical EPUB repairs its cover without replacing its
    // existing bookshelf metadata or any chapter reading records.
    const saved = previous ? { ...previous,
      ...(book.coverHash ? { coverHash: book.coverHash } : {}),
      resources: [...new Set([...previous.resources, ...book.resources])],
    } : book;
    await localStorage().set({ [BOOKS_KEY]: { ...books, [book.id]: saved } });
    return saved;
  });
}

/** 正文与图片都存本机，没有网络这一步；写完才算导入成功。 */
export function localSink(): BookSink {
  return {
    chapter: async (id, content) => { await localStorage().set({ [READER_PREFIX + id]: content }); },
    resource: async (hash, bytes, mime) => { await cacheBlob(hash, new Blob([new Uint8Array(bytes)], { type: mime })); },
  };
}

export const importHash = (bytes: Uint8Array): Promise<string> => hashBytes(bytes);

/**
 * 删一本书：章的阅读记录走和文章一样的那条路（片段、段落、位置、正文缓存一起清），
 * 图片只回收这本书独占的那些，最后才从书架上摘掉。
 */
export async function deleteBook(id: string): Promise<void> {
  const books = await read();
  const book = books[id];
  if (!book) return;
  const ids = book.chapters.map(c => chapterId(id, c.index));
  for (let i = 0; i < ids.length; i += 200) {
    const result = await chrome.runtime.sendMessage({ type: "articles:delete", articleIds: ids.slice(i, i + 200) }) as { ok?: boolean; error?: string };
    if (!result?.ok) throw new Error(result?.error || "Could not delete reading records");
  }
  await serialize(async () => {
    const data = await localStorage().get(null);
    const rest = { ...data[BOOKS_KEY] as Record<string, Book> };
    delete rest[id];
    const referenced = new Set(Object.values(rest).flatMap(b => b.resources));
    const keepArchive = (manifest?: ArchiveManifest): void => {
      if (!manifest) return;
      referenced.add(manifest.htmlHash);
      for (const resource of manifest.resources) referenced.add(resource.hash);
    };
    // A cached older version can still be the only offline copy while a new version downloads.
    for (const collection of [data.archives, data.archivePending]) {
      for (const manifest of Object.values((collection ?? {}) as Record<string, ArchiveManifest>)) keepArchive(manifest);
    }
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith(READER_PREFIX)) keepArchive((value as { archiveManifest?: ArchiveManifest } | undefined)?.archiveManifest);
    }
    await dropBlobs(book.resources.filter(hash => !referenced.has(hash)));
    await localStorage().set({ [BOOKS_KEY]: rest });
    // Unvisited chapters have a cache entry but no reading record for deleteArticles to remove.
    await localStorage().remove(ids.map(chapter => READER_PREFIX + chapter));
  });
}

/**
 * 把正文里的 `fs-blob:<哈希>` 换成临时的 blob 地址。
 *
 * 和插件存档那条路径的区别只有一个：书的图片一定在本机，找不到就是找不到，
 * 不去服务器要——所以这里不碰同步，断网也是这个结果。
 */
export async function hydrateBookImages(body: HTMLElement, resources: readonly ArchiveResource[]): Promise<{ missing: number; release: () => void }> {
  const known = new Map(resources.map(resource => [resource.hash, resource]));
  const urls = new Map<string, string>();
  const allocated = new Set<string>();
  let missing = 0;
  // 先同步把地址摘掉：这段 DOM 还没进文档，摘干净才不会有任何一次外部请求
  const pending = [...body.querySelectorAll("img")].map(img => {
    const hash = ARCHIVE_SRC.exec(img.getAttribute("src") ?? "")?.[1];
    img.removeAttribute("src");
    return { img, hash };
  });
  for (const { img, hash } of pending) {
    try {
      const resource = hash ? known.get(hash) : undefined;
      if (!hash || !resource || !imageMime(resource.mime)) throw new Error("Unknown image resource");
      let url = urls.get(hash);
      if (!url) {
        const blob = await cachedBlob(hash);
        if (!blob || blob.size !== resource.size) throw new Error("This image is not on your device");
        url = URL.createObjectURL(new Blob([blob], { type: resource.mime }));
        urls.set(hash, url);
        allocated.add(url);
      }
      img.src = url;
    } catch {
      missing++;
      const placeholder = document.createElement("span");
      placeholder.textContent = img.alt ? `(Image not saved: ${img.alt})` : "(Image not saved)";
      img.replaceWith(placeholder);
    }
  }
  return { missing, release: () => { for (const url of allocated) URL.revokeObjectURL(url); } };
}

/** 书架上的封面：拿不到就不显示，不必报错。 */
export async function coverUrl(book: Book): Promise<string | null> {
  if (!book.coverHash) return null;
  try {
    const blob = await cachedBlob(book.coverHash);
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export type { BookChapterContent };
