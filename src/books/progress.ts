import { hostnameOf } from '../lib/url.ts';
import type { Article } from '../types.ts';
import { chapterId, nextChapter, parseChapterId, type Book } from './types.ts';

export function resumeChapter(book: Book, articles: readonly Article[]): number {
  const records = articles.filter(a => parseChapterId(a.id)?.bookId === book.id);
  const latest = records.filter(a => !a.finished).sort((a, b) => b.lastSeenTs - a.lastSeenTs)[0];
  const index = latest && parseChapterId(latest.id)?.index;
  if (index !== undefined && book.chapters.some(c => c.index === index)) return index;
  return nextChapter(book, new Set(records.filter(a => a.finished).map(a => parseChapterId(a.id)!.index)));
}

/** Derived from chapter records; never creates a second stored book progress value. */
export function bookProgress(book: Book, articles: readonly Pick<Article, "id" | "finished" | "trackedWords" | "wordsRead">[]): number {
  const records = new Map(articles.map(a => [a.id, a]));
  let read = 0, total = 0;
  for (const chapter of book.chapters) {
    const weight = Math.max(1, chapter.words);
    const record = records.get(chapterId(book.id, chapter.index));
    total += weight;
    const ratio = record?.finished ? 1 : record && record.trackedWords > 0 ? Math.max(0, Math.min(1, record.wordsRead / record.trackedWords)) : 0;
    read += weight * ratio;
  }
  return total ? Math.round(read / total * 100) : 0;
}

export interface ResumeTarget { articleId: string; title: string; source: string; progress: number; lastSeenTs: number }
export function readingResume(articles: readonly Article[], books: Record<string, Book>): ResumeTarget | null {
  const candidates: ResumeTarget[] = articles.filter(a => !a.finished && !parseChapterId(a.id)).map(a => ({
    articleId: a.id, title: a.title || a.url, source: `${hostnameOf(a.url)} · Article`,
    progress: a.trackedWords > 0 ? Math.round(Math.max(0, Math.min(1, a.wordsRead / a.trackedWords)) * 100) : 0, lastSeenTs: a.lastSeenTs,
  }));
  for (const book of Object.values(books)) {
    if (!book.chapters.length || book.chapters.every(c => articles.some(a => a.id === chapterId(book.id, c.index) && a.finished))) continue;
    const chapter = resumeChapter(book, articles);
    const records = articles.filter(a => parseChapterId(a.id)?.bookId === book.id);
    candidates.push({ articleId: chapterId(book.id, chapter), title: book.title,
      source: `Chapter ${chapter + 1} · ${book.chapters.find(c => c.index === chapter)?.title ?? "Local book"}`,
      progress: bookProgress(book, articles), lastSeenTs: Math.max(book.addedTs, ...records.map(a => a.lastSeenTs)) });
  }
  return candidates.sort((a, b) => b.lastSeenTs - a.lastSeenTs)[0] ?? null;
}
