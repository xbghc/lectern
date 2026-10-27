import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { normalizeChatRequest, buildVocabularyChatPrompt, readChatThreads, CHAT_STORAGE_KEY } from "../src/lib/vocabularyChat.ts";
import { streamVocabularyChat } from "../src/features/translation/translate.ts";
import { attachTranslatePort, type PortLike } from "../src/features/translation/background.ts";
import { bookkeepingSettled } from "../src/background/llmLog.ts";
import { DEFAULT_LLM, LEGACY_MINIMAX, type Snippet, type VocabularyChatRequest } from "../src/types.ts";
import { freshState, installStorage, memoryDriver, localStorage } from "../src/sync/storage.ts";

let data: Record<string, unknown> = {};
(globalThis as Record<string, unknown>).chrome = { storage: { local: {
  async get(keys: string | string[] | null) { return structuredClone(keys === null ? data : Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(k => [k, data[k]]))); },
  async set(values: Record<string, unknown>) { Object.assign(data, structuredClone(values)); },
  async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
} } };
const originalFetch = globalThis.fetch;
after(async () => { await bookkeepingSettled(); globalThis.fetch = originalFetch; });
const word = { id: "word-1", text: "deliberate", kind: "word", translation: "深思熟虑的", context: "A deliberate choice.", contextNote: "描述经过考虑的决定", articleTitle: "Choices" } as Snippet;
const req: VocabularyChatRequest = { snippetIds: [word.id], question: "帮助我练习造句", history: [] };
beforeEach(async () => {
  await bookkeepingSettled();
  data = { snippets: [word], llm: { ...DEFAULT_LLM, ...LEGACY_MINIMAX, consentAt: 1, apiKey: "private-test-key" } };
});
test("vocabulary requests reject invalid selection and bound history and context", () => {
  assert.throws(() => normalizeChatRequest({ ...req, snippetIds: [] }));
  assert.throws(() => normalizeChatRequest({ ...req, snippetIds: ["a", "b", "c", "d"] }));
  assert.throws(() => normalizeChatRequest({ ...req, question: "x".repeat(1001) }));
  const normalized = normalizeChatRequest({ ...req, history: Array.from({ length: 20 }, (_, i) => ({ question: String(i), answer: "a".repeat(8000) })) });
  assert.equal(normalized.history.length, 6);
  assert.equal(normalized.history[0]!.question, "14");
  const prompt = JSON.parse(buildVocabularyChatPrompt(normalized, [{ ...word, context: "x".repeat(9000) }]));
  assert.equal(prompt.selectedWords[0].originalContext.length, 1800);
  assert.equal(prompt.history[0].answer.length, 2000);
  assert.equal(JSON.stringify(prompt).includes("private-test-key"), false);
});
test("no consent, deleted words and cancelled requests never contact the model", async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
  (data.llm as Record<string, unknown>).consentAt = null;
  const consent = await streamVocabularyChat(req, () => {}).done;
  assert.ok(!consent.ok && consent.needsConfig);
  (data.llm as Record<string, unknown>).consentAt = 1;
  const missing = await streamVocabularyChat({ ...req, snippetIds: ["missing"] }, () => {}).done;
  assert.ok(!missing.ok && /no longer exists/.test(missing.error));
  const handle = streamVocabularyChat(req, () => {}); handle.cancel();
  const cancelled = await handle.done;
  assert.ok(!cancelled.ok && /Canceled/.test(cancelled.error));
  assert.equal(calls, 0);
});
test("conversation streams real model text with stored word context and records usage without changing vocabulary", async () => {
  let sent = "";
  globalThis.fetch = async (_url, init) => {
    sent = String(init?.body);
    const event = (value: unknown) => `event: x\ndata: ${JSON.stringify(value)}\n\n`;
    return new Response(event({ type: "content_block_delta", delta: { type: "text_delta", text: "Use deliberate in a sentence." } }) +
      event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 10, output_tokens: 8 } }));
  };
  const chunks: string[] = [];
  const response = await streamVocabularyChat(req, text => chunks.push(text)).done;
  assert.deepEqual(response, { ok: true, text: "Use deliberate in a sentence." });
  assert.ok(chunks.some(text => text.includes("deliberate")));
  assert.ok(sent.includes("A deliberate choice."));
  assert.equal(sent.includes("private-test-key"), false);
  assert.deepEqual(data.snippets, [word]);
  await bookkeepingSettled();
  assert.equal((data.llmUsage as { requests: number }).requests, 1);
});
test("disconnecting a vocabulary conversation port aborts the in-flight model request", async () => {
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let aborted!: () => void;
  const requestAborted = new Promise<void>(resolve => { aborted = resolve; });
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => { aborted(); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
    started();
  });
  let receive!: Parameters<PortLike["onMessage"]["addListener"]>[0];
  let disconnect!: () => void;
  const output: unknown[] = [];
  attachTranslatePort({ postMessage: message => output.push(message), disconnect: () => disconnect(),
    onMessage: { addListener: fn => { receive = fn; } }, onDisconnect: { addListener: fn => { disconnect = fn; } } });
  receive({ type: "vocab-chat", req });
  await requestStarted;
  disconnect();
  await requestAborted;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(output, [], "a closed page must not receive a late reply");
});
test("local conversation storage is bounded and never enters the synchronization outbox", async () => {
  const raw = [{ id: "chat", title: "Practice", snippetIds: [word.id], words: [word.text], draft: "draft", updatedTs: 1,
    messages: [{ role: "system", text: "untrusted role" }, { role: "assistant", text: "a".repeat(9000), incomplete: true }] }];
  const kept = readChatThreads(raw);
  assert.equal(kept[0]!.messages.length, 1);
  assert.equal(kept[0]!.messages[0]!.text.length, 6000);
  const driver = memoryDriver(freshState());
  installStorage(driver);
  try {
    await localStorage().set({ [CHAT_STORAGE_KEY]: kept });
    const state = await driver.read();
    assert.equal(state.outbox.length, 0);
    assert.deepEqual(state.data[CHAT_STORAGE_KEY], kept);
  } finally { installStorage(memoryDriver(freshState())); }
});
