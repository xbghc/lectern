import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_READING_SETTINGS, resolveReadingSettings, useAppReadingDefaults } from "../src/features/reading/settings.ts";
import { isFinished } from "../src/lib/finish.ts";
import { freshState, projectRecords, trackChanges } from "../src/sync/storage.ts";

test("Android automatic rules apply after sync without replacing stored extension preferences", async () => {
  const data: Record<string, unknown> = { settings: {
    finishRatio: 0.75, restorePositionEnabled: false, articleReviewEnabled: false,
    idleTimeoutMs: 60_000, paragraphDwellMs: 2_000, readFraction: 0.7,
    episodeGapMs: 420_000, articleExcludedUrls: ["example.org"],
  } };
  (globalThis as Record<string, unknown>)["chrome"] = { storage: { local: {
    async get(key: string) { return structuredClone({ [key]: data[key] }); },
    async set(patch: Record<string, unknown>) { Object.assign(data, structuredClone(patch)); },
  } } };
  const store = await import("../src/background/store.ts");
  assert.equal((await store.getSettings()).finishRatio, 0.75, "extension keeps its saved threshold");
  assert.equal(resolveReadingSettings({}).finishRatio, 0.8, "extension default is unchanged");

  useAppReadingDefaults();
  const app = await store.getSettings();
  assert.equal(app.finishRatio, 0.9);
  assert.equal(app.restorePositionEnabled, true);
  assert.equal(app.articleReviewEnabled, true);
  assert.equal(app.idleTimeoutMs, DEFAULT_READING_SETTINGS.idleTimeoutMs);
  assert.equal(app.paragraphDwellMs, DEFAULT_READING_SETTINGS.paragraphDwellMs);
  assert.equal(app.readFraction, DEFAULT_READING_SETTINGS.readFraction);
  assert.equal(app.episodeGapMs, 420_000, "remaining settings stay configurable");
  assert.equal(isFinished({ wordsRead: 899, trackedWords: 1000, reachedBottom: true, finishRatio: app.finishRatio }), false);
  assert.equal(isFinished({ wordsRead: 900, trackedWords: 1000, reachedBottom: true, finishRatio: app.finishRatio }), true);
  assert.equal(isFinished({ wordsRead: 900, trackedWords: 1000, reachedBottom: false, finishRatio: app.finishRatio }), false);

  await store.setSettings({ ...app, contextChars: 800 });
  const stored = data.settings as Record<string, unknown>;
  assert.equal(stored.finishRatio, 0.75);
  assert.equal(stored.restorePositionEnabled, false);
  assert.equal(stored.articleReviewEnabled, false);
  assert.equal(stored.idleTimeoutMs, 60_000);
  assert.equal(stored.contextChars, 800);
  await store.updateSettings(current => ({ ...current, episodeGapMs: 600_000 }));
  assert.equal((data.settings as Record<string, unknown>).finishRatio, 0.75);
  assert.equal((await store.getSettings()).episodeGapMs, 600_000);

  data.settings = { ...stored, finishRatio: 0.6, restorePositionEnabled: false };
  assert.equal((await store.getSettings()).finishRatio, 0.9, "sync/import cannot change Android's automatic threshold");
  assert.equal(resolveReadingSettings(data.settings as {}).restorePositionEnabled, true, "reader hot updates use the same automatic rules");

  const id = "https://example.com/reading";
  for (const wordsRead of [850, 900]) {
    const state = freshState({ settings: { finishRatio: 0.8 }, articles: { [id]: {
      id, url: id, title: "Reading", totalWords: 1000, trackedWords: 1000, paragraphCount: 2,
      wordsRead: 0, readParagraphCount: 0, sessionCount: 0, totalMs: 0, maxSessionMs: 0,
      firstSeenTs: 1000, lastSeenTs: 2000, reachedBottom: true, finished: false, finishedTs: null,
    } }, [`p:${id}`]: [{ hash: "read-paragraph", index: 0, words: wordsRead, firstSeenTs: 1000, dwellMs: 1000 }] });
    trackChanges(state, {}, state.data, true);
    projectRecords(state);
    assert.equal(state.data.articles[id].finished, wordsRead >= 900, "sync projection uses the same 90% threshold as the reader");
    assert.equal(state.data.settings.finishRatio, 0.8, "projection retains the synchronized preference");
  }
});
