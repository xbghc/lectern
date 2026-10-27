import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Article } from '../src/types.ts';
import { chapterId, type Book } from '../src/books/types.ts';
import { bookProgress, readingResume, resumeChapter } from '../src/books/progress.ts';
const book: Book = { id: 'ab'.repeat(32), title: 'A book', author: '', fileName: 'book.epub', addedTs: 10, resources: [], missingResources: 0,
  chapters: [100, 200, 300].map((words, index) => ({ words, index, title: `Chapter ${index}` })) };
const record = (index: number, wordsRead: number, lastSeenTs: number, finished = false): Article => ({
  id: chapterId(book.id, index), url: chapterId(book.id, index), title: '', trackedWords: book.chapters[index]!.words, wordsRead, lastSeenTs, finished,
} as Article);

test('book progress is derived and weighted by chapter size, and clamps excess read counts', () => {
  assert.equal(bookProgress(book, [record(0, 100, 10, true), record(1, 100, 20)]), 33);
  assert.equal(bookProgress(book, [record(0, 900, 10), record(1, -10, 20)]), 17);
  assert.equal(bookProgress({ ...book, chapters: [] }, []), 0);
});
test('resume honors the latest unfinished chapter, including nonsequential reading', () => {
  const records = [record(0, 100, 50, true), record(2, 50, 100)];
  assert.equal(resumeChapter(book, records), 2);
  assert.equal(readingResume(records, { [book.id]: book })?.articleId, chapterId(book.id, 2));
  assert.equal(resumeChapter(book, [record(0, 100, 50, true)]), 1);
});
test('a finished book does not replace an unfinished article in the continue card', () => {
  const web = { id: 'https://example.com/a', url: 'https://example.com/a', title: 'Article', wordsRead: 25, trackedWords: 100, finished: false, lastSeenTs: 40 } as Article;
  const done = book.chapters.map(c => record(c.index, c.words, 100, true));
  assert.equal(readingResume([...done, web], { [book.id]: book })?.articleId, web.id);
  assert.equal(readingResume(done, { [book.id]: book }), null);
});
