import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, type Article, type ParagraphRecord, type ReadingPosition, type Session } from '../src/types.ts';
import { chapterId, type Book } from '../src/books/types.ts';
import { resumeChapter } from '../src/books/progress.ts';
import { freshState, memoryDriver, installStorage, localStorage, applyRemote } from '../src/sync/storage.ts';
import { savePosition, deleteArticles, getArticles, commitSession, exportAll, upsertArticleMeta, setFinished, markFinished } from '../src/background/store.ts';
import { newCard, newFsrs, gradeCard } from '../src/lib/review.ts';
import { gradeStoredCard } from '../src/features/translation/vocab.ts';
import { gradeArticleCard } from '../src/features/reading/articleReview.ts';
import { saveBook, getBook } from '../src/books/local.ts';

const book: Book = { id: 'ab'.repeat(32), title: 'Local book', author: '', fileName: 'book.epub', addedTs: 1, resources: [], missingResources: 0,
  chapters: [0, 1].map(index => ({ index, title: `Chapter ${index}`, words: 200 })) };
const id = chapterId(book.id, 1), web = 'https://example.com/reading';
const now = 1_790_000_000_000;
const article = (articleId = id): Article => ({ id: articleId, url: articleId, title: 'Chapter', totalWords: 200, trackedWords: 200,
  paragraphCount: 2, wordsRead: 0, readParagraphCount: 0, sessionCount: 0, totalMs: 0, maxSessionMs: 0,
  firstSeenTs: now, lastSeenTs: now, reachedBottom: false, finished: false, finishedTs: null });
const position: ReadingPosition = { articleId: id, hash: 'p1', index: 1, offset: 180, paragraphCount: 2, savedTs: now };
const paragraph: ParagraphRecord = { hash: 'p1', index: 1, words: 100, firstSeenTs: now, dwellMs: 3000 };

test('re-importing a book repairs its cover and preserves shelf metadata, chapter progress and bookmarks', async () => {
  const driver = memoryDriver(freshState()); installStorage(driver);
  const original = { ...book, resources: ['old-resource'] };
  await saveBook(original);
  await localStorage().set({ articles: { [id]: article() }, [`pos:${id}`]: position, [`reader:bookmark:${id}`]: { ratio: .4 } });
  const before = await localStorage().get(null);
  const updated = await saveBook({ ...book, addedTs: now, title: 'Imported again', coverHash: 'cd'.repeat(32), resources: ['cd'.repeat(32)] });
  assert.equal(updated.title, original.title); assert.equal(updated.addedTs, original.addedTs);
  assert.equal(updated.coverHash, 'cd'.repeat(32));
  assert.deepEqual(updated.resources, ['old-resource', 'cd'.repeat(32)]);
  const saved = await localStorage().get(null);
  assert.deepEqual(saved.articles, before.articles); assert.deepEqual(saved[`pos:${id}`], position);
  assert.deepEqual(saved[`reader:bookmark:${id}`], { ratio: .4 });
  assert.equal(JSON.stringify((await driver.read()).outbox).includes(updated.coverHash!), false);
  await saveBook(book);
  assert.equal((await getBook(book.id))?.coverHash, updated.coverHash, 'failed extraction does not clear a saved cover');
});

// Exercise actual local writes: simply checking the outbound queue misses destructive projection.
test('book position and chapter progress survive local writes, remote projection and reopening storage', async () => {
  const driver = memoryDriver(freshState()); installStorage(driver);
  await localStorage().set({ articles: { [id]: article() } });
  await savePosition(position);
  const session: Session = { id: 'book-session', articleId: id, url: id, title: 'Chapter', startTs: now, endTs: now + 10000, wordsRead: 100, endReason: 'hidden' };
  await commitSession(session, [paragraph]);
  await localStorage().set({ settings: DEFAULT_SETTINGS });
  await applyRemote(driver, [], 0);
  installStorage(memoryDriver(await driver.read()));
  const saved = await localStorage().get(null);
  assert.deepEqual(saved[`pos:${id}`], position);
  assert.deepEqual(saved[`p:${id}`], [paragraph]);
  assert.equal(saved.articles[id].wordsRead, 100);
  assert.equal(saved.sessions[0].id, session.id);
  assert.equal(resumeChapter(book, Object.values(saved.articles)), 1);
  assert.equal(JSON.stringify((await driver.read()).outbox).includes('epub:'), false);
  const exported = await exportAll();
  assert.equal(exported.articles.length, 0);
  assert.equal(exported.sessions.length, 0);
  assert.equal(exported.positions.length, 0);
  assert.deepEqual(exported.paragraphs, {});
});

test('book review, private vocabulary sources and review schedules survive repeated projection', async () => {
  const driver = memoryDriver(freshState()); installStorage(driver);
  const card = newCard('word-card', 'practice', ['book-word', 'web-word'], now);
  const localCard = newCard('local-card', 'margin', ['book-only'], now);
  await localStorage().set({
    articles: { [id]: { ...article(), finished: true, finishedTs: now }, [web]: article(web) },
    snippets: [{ id: 'book-word', articleId: id }, { id: 'web-word', articleId: web }, { id: 'book-only', articleId: id }],
    cards: [card, localCard], articleCards: [{ articleId: id, ...newFsrs(now) }],
    [`t:${id}`]: { text: 'Private text' }, [`r:${id}`]: { outline: ['Private outline'] },
  });
  const wordGrade = await gradeStoredCard(localCard.id, 3, now + 1000);
  const chapterGrade = await gradeArticleCard(id, 3, now + 1000);
  await localStorage().set({ settings: { ...DEFAULT_SETTINGS, idleTimeoutMs: 45000 } });
  await applyRemote(driver, [], 0);
  const data = await localStorage().get(null);
  assert.equal(data.snippets.length, 3);
  assert.deepEqual(data.cards.find((c: { key: string }) => c.key === card.key).snippetIds.sort(), ['book-word', 'web-word']);
  assert.deepEqual(data.cards.find((c: { id: string }) => c.id === localCard.id), wordGrade);
  assert.deepEqual(wordGrade, gradeCard(localCard, 3, now + 1000));
  assert.deepEqual(data.articleCards[0], chapterGrade);
  assert.deepEqual(data[`r:${id}`], { outline: ['Private outline'] });
  assert.deepEqual(data[`t:${id}`], { text: 'Private text' });
  const outbox = (await driver.read()).outbox;
  assert.equal(JSON.stringify(outbox).includes('epub:'), false);
  const shared = outbox.find(op => op.record.type === 'card' && op.record.id === card.key)!;
  assert.deepEqual((shared.record.value as { snippetIds: string[] }).snippetIds, ['web-word']);
});

test('deleting a book chapter removes its saved position permanently while preserving vocabulary', async () => {
  const driver = memoryDriver(freshState()); installStorage(driver);
  await localStorage().set({ articles: { [id]: article() }, [`pos:${id}`]: position, [`p:${id}`]: [paragraph],
    snippets: [{ id: 'book-word', articleId: id }], cards: [newCard('card', 'word', ['book-word'], now)] });
  await deleteArticles([id]);
  await localStorage().set({ settings: DEFAULT_SETTINGS });
  assert.equal((await getArticles())[id], undefined);
  const data = await localStorage().get(null);
  assert.equal(data[`pos:${id}`], undefined);
  assert.equal(data[`p:${id}`], undefined);
  assert.equal(data.snippets.length, 1);
  assert.equal(data.cards.length, 1);
  await savePosition(position);
  assert.equal((await localStorage().get(`pos:${id}`))[`pos:${id}`], undefined);
});

test('reopening a chapter preserves an explicit unfinished choice through automatic completion and projection', async () => {
  const driver = memoryDriver(freshState()); installStorage(driver);
  const meta = { articleId: id, url: id, title: 'Chapter', totalWords: 200, trackedWords: 200, paragraphCount: 2, now };
  await upsertArticleMeta(meta);
  await setFinished(id, true);
  await setFinished(id, false);
  await upsertArticleMeta({ ...meta, now: now + 1000 });
  assert.equal(await markFinished(id, now + 2000), false);
  await commitSession({ id: 'reopened', articleId: id, url: id, title: 'Chapter', startTs: now, endTs: now + 10000,
    wordsRead: 200, endReason: 'hidden' }, [{ ...paragraph, words: 200 }], true);
  await applyRemote(driver, [], 0);
  const saved = (await getArticles())[id]!;
  assert.equal(saved.manualFinished?.value, false);
  assert.equal(saved.finished, false);
  assert.equal(saved.finishedTs, null);
  assert.equal((await driver.read()).data.articleCards.length, 0);
  await setFinished(id, true);
  await upsertArticleMeta({ ...meta, now: now + 3000 });
  assert.equal((await getArticles())[id]!.manualFinished?.value, true);
});
