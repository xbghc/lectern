import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LLM, type TranslateRequest } from "../src/types.ts";
import { freshState, memoryDriver, installStorage, applyRemote } from "../src/sync/storage.ts";
import { clearData } from "../src/background/store.ts";
import { streamTranslate } from "../src/features/translation/translate.ts";
import { deleteSnippet, getSnippets } from "../src/features/translation/vocab.ts";
import { bookkeepingSettled } from "../src/background/llmLog.ts";
import { ensureArticleReview, saveArticleText } from "../src/features/reading/articleReview.ts";

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });
beforeEach(async () => { await bookkeepingSettled(); });
const config = { ...DEFAULT_LLM, provider: "custom", protocol: "openai", baseUrl: "https://model.example/v1", model: "test", apiKey: "synthetic", consentAt: 1 };
const request: TranslateRequest = { articleId: "https://example.com/private", url: "https://example.com/private", articleTitle: "Private article",
  text: "margin", kind: "word", context: "In the margin", explainVocab: false };
function device() {
  const state = freshState({ llm: config });
  state.config = { enabled: false, baseUrl: "https://sync.example", token: "synthetic-a", userId: "account-a", serverId: "server" };
  const driver = memoryDriver(state); installStorage(driver); return driver;
}
const response = () => new Response([
  { choices: [{ delta: { content: JSON.stringify({ translation: "页边", context_note: "", lemma: "margin" }) } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }] },
].map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n");
function heldRequest() {
  let release!: (value: Response) => void, started!: () => void;
  let signal: AbortSignal | undefined;
  const ready = new Promise<void>(resolve => { started = resolve; });
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined; started();
    return new Promise<Response>(resolve => { release = resolve; });
  };
  return { ready, finish: () => release(response()), signal: () => signal };
}

test("clearing data cancels old translations and old completion cannot affect a new account or its new request", async () => {
  const driver = device(), held = heldRequest();
  const old = streamTranslate(request, () => {}); await held.ready;
  await driver.update(state => { state.blocked = { count: 1 }; state.archiveErrors = { private: { version: "v1", reason: "old private URL" } }; });
  await clearData();
  assert.equal(held.signal()?.aborted, true);
  await driver.update(state => { state.config.userId = "account-b"; state.config.token = "synthetic-b"; });
  const nextHeld = heldRequest(), next = streamTranslate(request, () => {}); await nextHeld.ready;
  held.finish();
  assert.equal((await old.done).ok, false);
  assert.equal((await getSnippets()).length, 0);
  const joined = streamTranslate(request, () => {});
  nextHeld.finish();
  assert.equal((await next.done).ok, true);
  assert.equal((await joined.done).diagnostics?.cache, "shared");
  await bookkeepingSettled();
  const state = await driver.read();
  assert.equal(state.data.snippets.length, 1, "only the request initiated after reset is saved");
  assert.equal(state.data.llmLog?.length ?? 0, 0, "old failure diagnostics cannot return after clear");
  assert.equal(state.blocked, undefined); assert.equal(state.archiveErrors, undefined);
  assert.equal(state.outbox.filter(op => op.record.type === "snippet").length, 1);
});

test("article-review output and its diagnostics cannot restore cleared article text into another profile", async () => {
  const driver = device();
  await saveArticleText(request.articleId, "Private reading text.", 21);
  let release!: (response: Response) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  globalThis.fetch = async () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); };
  const work = ensureArticleReview(request.articleId); await started;
  await clearData();
  release(Response.json({ choices: [{ message: { content: JSON.stringify({ outline: ["Private outline"], questions: ["One?", "Two?", "Three?"] }) }, finish_reason: "stop" }] }));
  const result = await work;
  assert.ok(!result.ok);
  assert.match(result.error, /Local data was cleared/);
  await bookkeepingSettled();
  const state = await driver.read();
  assert.equal(state.data[`r:${request.articleId}`], undefined);
  assert.equal(state.data.llmLog?.length ?? 0, 0);
  assert.equal(state.outbox.some(op => op.record.type === "articleReview"), false);
});

test("a reset from another context is detected at the durable write even without a local cancellation event", async () => {
  const driver = device(), held = heldRequest();
  const pending = streamTranslate({ ...request, text: "other" }, () => {}); await held.ready;
  await driver.update(state => { Object.assign(state, freshState({ llm: config })); });
  held.finish();
  assert.equal((await pending.done).ok, false);
  await bookkeepingSettled();
  const state = await driver.read();
  assert.equal(state.data.snippets?.length ?? 0, 0);
  assert.equal(state.data.llmLog?.length ?? 0, 0);
  assert.equal(state.outbox.length, 0);
});

test("local and remotely synced deletion invalidate cached translations and allow saving the word again", async () => {
  const driver = device(); let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  const first = await streamTranslate(request, () => {}).done;
  assert.ok(first.ok);
  const cached = await streamTranslate(request, () => {}).done;
  assert.ok(cached.ok && cached.cached);
  assert.equal(calls, 1);
  await deleteSnippet(first.snippet.id);
  const second = await streamTranslate(request, () => {}).done;
  assert.ok(second.ok); assert.notEqual(second.snippet.id, first.snippet.id); assert.equal(calls, 2);
  const record = Object.values((await driver.read()).records).find(r => r.type === "snippet" && r.id === second.snippet.id)!;
  await applyRemote(driver, [{ ...record, deleted: true, value: null }], 1);
  const third = await streamTranslate(request, () => {}).done;
  assert.ok(third.ok); assert.notEqual(third.snippet.id, second.snippet.id); assert.equal(calls, 3);
  assert.equal((await getSnippets()).length, 1);
});
