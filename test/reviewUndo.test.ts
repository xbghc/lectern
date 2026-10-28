import { test } from 'node:test';
import assert from 'node:assert/strict';
import { undoReview } from '../src/background/reviewUndo.ts';
import { upsertArticleMeta, setFinished } from '../src/background/store.ts';
import { addSnippet, getCards, gradeStoredCard } from '../src/features/translation/vocab.ts';
import { getArticleCards, gradeArticleCard } from '../src/features/reading/articleReview.ts';
import { freshState, memoryDriver, installStorage, localStorage, applyRemote } from '../src/sync/storage.ts';
import { recordKey, validateRecord } from '../src/sync/protocol.ts';
import { chapterId } from '../src/books/types.ts';

const now = Date.UTC(2026, 9, 28), day = 86_400_000;
const web = 'https://example.com/reading', book = chapterId('ab'.repeat(32), 0);
const device = () => { const driver = memoryDriver(freshState()); installStorage(driver); return driver; };
const add = (text = 'margin', articleId = web) => addSnippet({ articleId, url: articleId, articleTitle: 'Reading', text, kind: 'word',
  context: `Read ${text} in context.`, now, result: { translation: '语境', contextNote: '', lemma: text, pos: 'noun', phonetic: null, usage: null, vocab: [] } });

test('undo restores the schedule, keeps newer vocabulary sources, and synchronizes a rating tombstone', async () => {
  const source = device(); const { card } = await add();
  const eventId = crypto.randomUUID();
  await gradeStoredCard(card!.id, 4, now + day, eventId);
  const remote = memoryDriver(freshState());
  await applyRemote(remote, Object.values((await source.read()).records), 1);
  await add();
  const before = (await getCards())[0]!;
  const result = await undoReview(eventId);
  assert.equal(result.ok, true);
  const restored = (await getCards())[0]!;
  assert.deepEqual(restored, { ...card, snippetIds: before.snippetIds });
  const state = await source.read();
  const tombstone = state.records[recordKey({ type: 'reviewEvent', id: eventId })]!;
  assert.equal(tombstone.deleted, true); validateRecord(tombstone);
  await applyRemote(remote, Object.values(state.records), 2);
  assert.deepEqual((await remote.read()).data.cards[0], restored);
  const repeat = await undoReview(eventId);
  assert.equal(repeat.ok, false);
  assert.deepEqual((await getCards())[0], restored);
});

test('undo targets the last rating of that card and preserves ratings on other cards', async () => {
  device(); const a = (await add('margin')).card!, b = (await add('context')).card!;
  const first = crypto.randomUUID(), latest = crypto.randomUUID(), other = crypto.randomUUID();
  const earlier = await gradeStoredCard(a.id, 3, now + day, first);
  await gradeStoredCard(a.id, 4, now + 2 * day, latest);
  const expectedOther = await gradeStoredCard(b.id, 2, now + 3 * day, other);
  assert.equal((await undoReview(first)).ok, false, 'a stale action cannot remove an earlier rating');
  assert.equal((await undoReview(latest)).ok, true);
  const cards = await getCards();
  assert.deepEqual(cards.find(c => c.id === a.id), earlier);
  assert.deepEqual(cards.find(c => c.id === b.id), expectedOther);
});

for (const articleId of [web, book]) test(`article review undo restores ${articleId === web ? 'web' : 'local EPUB'} scheduling`, async () => {
  const source = device();
  await upsertArticleMeta({ articleId, url: articleId, title: 'Reading', totalWords: 100, trackedWords: 100, paragraphCount: 1, now });
  await setFinished(articleId, true);
  const original = (await getArticleCards())[0]!; assert.ok(original);
  const eventId = crypto.randomUUID();
  await gradeArticleCard(articleId, 4, now + day, eventId);
  assert.equal((await undoReview(eventId)).ok, true);
  assert.deepEqual((await getArticleCards())[0], original);
  await applyRemote(source, [], 1);
  assert.deepEqual((await getArticleCards())[0], original, 'projection must not reapply the undone event');
});

test('book-only word undo survives projection without dropping the local card', async () => {
  const source = device(); const original = (await add('margin', book)).card!;
  const eventId = crypto.randomUUID(); await gradeStoredCard(original.id, 2, now + day, eventId);
  assert.equal((await undoReview(eventId)).ok, true);
  await applyRemote(source, [], 1);
  assert.deepEqual((await getCards())[0], original);
});

test('failed undo writes leave the card, event and sync queue unchanged', async () => {
  const driver = device(); const { card } = await add();
  const eventId = crypto.randomUUID(); await gradeStoredCard(card!.id, 4, now + day, eventId);
  const before = await driver.read();
  installStorage({ read: () => driver.read(), update: fn => driver.update(state => { fn(state); throw new Error('disk full'); }) });
  await assert.rejects(undoReview(eventId), /disk full/);
  assert.deepEqual(await driver.read(), before);
});

test('undo refuses a rating already folded into an imported scheduling baseline', async () => {
  device(); const { card } = await add();
  const eventId = crypto.randomUUID(); const latest = await gradeStoredCard(card!.id, 4, now + day, eventId);
  await localStorage().set({ reviewBases: { [`word:${card!.key}`]: latest } });
  const before = await getCards();
  assert.equal((await undoReview(eventId)).ok, false);
  assert.deepEqual(await getCards(), before);
});
