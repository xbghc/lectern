import { test } from "node:test";
import assert from "node:assert/strict";
import { freshState, installStorage, memoryDriver, localStorage, applyRemote } from "../src/sync/storage.ts";
import { exportAll, importBundle, getArticles } from "../src/background/store.ts";
import { addSnippet, getCards, gradeStoredCard } from "../src/features/translation/vocab.ts";
import { gradeCard, gradeFsrs } from "../src/lib/review.ts";
import { gradeArticleCard, getArticleCards } from "../src/features/reading/articleReview.ts";
import { upsertArticleMeta, setFinished } from "../src/background/store.ts";
import { chapterId } from "../src/books/types.ts";

const now = Date.UTC(2026, 9, 20), day = 86_400_000;
const book = chapterId("ab".repeat(32), 0), web = "https://example.com/reading";
const device = () => { const driver = memoryDriver(freshState()); installStorage(driver); return driver; };
const add = (articleId: string) => addSnippet({ articleId, url: articleId, articleTitle: "Reading", text: "margin", kind: "word",
  context: "In the margin.", now, result: { translation: "页边", contextNote: "", lemma: "margin", pos: "noun", phonetic: null, usage: null, vocab: [] } });

test("book-only word backups preserve their baseline and replay each review once across repeated imports", async () => {
  device();
  const { card } = await add(book);
  const expected = await gradeStoredCard(card!.id, 3, now + day);
  const bundle = JSON.parse(JSON.stringify(await exportAll()));
  assert.equal(bundle.reviewHistory.localWordBases.margin.reps, 0);
  assert.equal(bundle.reviewHistory.records.filter((r: { type: string }) => r.type === "card").length, 0, "book-only cards remain outside sync");
  const target = device();
  for (let i = 0; i < 2; i++) {
    assert.equal((await importBundle(bundle)).ok, true);
    await applyRemote(target, [], i);
    assert.deepEqual((await getCards())[0], expected);
  }
  const next = await gradeStoredCard(card!.id, 4, now + 2 * day);
  assert.deepEqual(next, gradeCard(expected!, 4, now + 2 * day));
});

test("early book backups without a baseline do not reapply history already included in the card", async () => {
  device(); const { card } = await add(book);
  const expected = await gradeStoredCard(card!.id, 3, now + day);
  const bundle = await exportAll(); delete bundle.reviewHistory!.localWordBases;
  device();
  await importBundle(bundle); await importBundle(bundle);
  assert.deepEqual((await getCards())[0], expected);
});

test("a newer legacy schedule replaces a web card baseline and remains stable through sync and later reviews", async () => {
  const source = device(); const { card } = await add(web);
  await gradeStoredCard(card!.id, 3, now + day);
  const legacy = await exportAll(); delete legacy.reviewHistory;
  const recent = gradeCard((await getCards())[0]!, 4, now + 2 * day);
  legacy.cards = [recent];
  for (let i = 0; i < 2; i++) {
    assert.equal((await importBundle(legacy)).ok, true);
    assert.deepEqual((await getCards())[0], recent);
  }
  const remote = device();
  await applyRemote(remote, Object.values((await source.read()).records), 1);
  assert.deepEqual((await getCards())[0], recent, "the adopted baseline also reaches another device");
  const next = await gradeStoredCard(card!.id, 3, now + 3 * day);
  assert.deepEqual(next, gradeCard(recent, 3, now + 3 * day));
  await importBundle(legacy);
  assert.deepEqual((await getCards())[0], next, "an older backup must not roll back new reviews");
});

test("malformed local baselines are rejected before changing any stored records", async () => {
  const driver = device(); await add(book);
  const before = await driver.read();
  const bundle = await exportAll();
  bundle.reviewHistory!.localWordBases = { margin: { due: "invalid" } } as never;
  assert.equal((await importBundle(bundle)).ok, false);
  assert.deepEqual(await driver.read(), before);
  await localStorage().set({ settings: { translateEnabled: false } });
  assert.equal((await getCards()).length, 1);
});

test("legacy article-card checkpoints also preserve newer schedules without replaying older local events", async () => {
  device();
  await upsertArticleMeta({ articleId: web, url: web, title: "Article", totalWords: 100, trackedWords: 100, paragraphCount: 1, now });
  await setFinished(web, true);
  const first = await gradeArticleCard(web, 3, now + day);
  assert.ok(first);
  const bundle = await exportAll(); delete bundle.reviewHistory;
  const expected = gradeFsrs(first, 4, now + 2 * day);
  bundle.articleCards = [expected];
  await importBundle(bundle); await importBundle(bundle);
  assert.deepEqual((await getArticleCards())[0], expected);
  assert.deepEqual(await gradeArticleCard(web, 3, now + 3 * day), gradeFsrs(expected, 3, now + 3 * day));
});

test("a failed import transaction rolls back both review history and ordinary records", async () => {
  device(); const { card } = await add(web); await gradeStoredCard(card!.id, 3, now + day);
  const bundle = await exportAll();
  const target = device(), before = await target.read();
  installStorage({ read: () => target.read(), update: fn => target.update(state => { fn(state); throw new Error("disk full"); }) });
  await assert.rejects(importBundle(bundle), /disk full/);
  assert.deepEqual(await target.read(), before);
});

test('imported manual completion choices survive merging and can be changed immediately afterward', async () => {
  const source = device();
  await upsertArticleMeta({ articleId: web, url: web, title: 'Article', totalWords: 100, trackedWords: 100, paragraphCount: 1, now });
  await source.update(state => { state.counter = 500; });
  await setFinished(web, false);
  const bundle = await exportAll();
  const target = device();
  await upsertArticleMeta({ articleId: web, url: web, title: 'Old article', totalWords: 100, trackedWords: 100, paragraphCount: 1, now: now - day });
  await setFinished(web, true);
  const old = await exportAll();
  assert.equal((await importBundle(bundle)).ok, true);
  assert.equal((await getArticles())[web]!.finished, false, 'the newer explicit unfinished choice overrides old completion');
  assert.equal((await getArticleCards()).length, 0);
  await importBundle(old);
  assert.equal((await getArticles())[web]!.finished, false, 'reimporting old completion cannot undo the newer choice');
  // Also repair a profile imported by a previous release that never observed the inner stamp.
  await target.update(state => { state.counter = 0; });
  await setFinished(web, true);
  assert.equal((await getArticles())[web]!.finished, true, 'the local logical clock must advance past the imported manual stamp');
  await applyRemote(target, [], 1);
  assert.equal((await getArticles())[web]!.finished, true);
});
