import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from '../src/app/shim.ts';
import { DEFAULT_LLM, LEGACY_MINIMAX, DEFAULT_SETTINGS } from '../src/types.ts';
import { classifyHistoryArticle } from '../src/features/reading/articleFilter.ts';
import { bookkeepingSettled, getLlmLog } from '../src/background/llmLog.ts';

const id = 'https://example.com/article';
let area = memoryBackend();
let websiteCalls = 0;
let llmCalls = 0;
let decision: unknown;
let bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let llmStatus = 200;
const originalFetch = globalThis.fetch;
beforeEach(async () => {
  area = memoryBackend(); websiteCalls = 0; llmCalls = 0; bodies = []; llmStatus = 200;
  decision = { isArticle: false, reason: '目录页面' };
  (globalThis as Record<string, unknown>).chrome = { storage: { local: area } };
  await area.set({ articles: { [id]: { id, url: id, title: '示例' } }, settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: ['example.com'] }, llm: { ...DEFAULT_LLM, ...LEGACY_MINIMAX, apiKey: 'test-only', consentAt: 1 } });
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://example.com')) {
      websiteCalls++;
      return new Response('Source pages must not be fetched', { status: 403 });
    }
    llmCalls++;
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(decision) }], usage: { input_tokens: 50, output_tokens: 20 }, stop_reason: 'end_turn' }), { status: llmStatus });
  };
});
afterEach(async () => { await bookkeepingSettled(); globalThis.fetch = originalFetch; });

test('历史复查忽略存档标题和正文，也不会把黑名单当作 LLM 结论', async () => {
  await area.set({
    articles: { [id]: { id, url: 'https://private-user:private-password@example.com/article?token=private-query#private-fragment', title: 'private-title' } },
    [`t:${id}`]: { text: 'private-article-text' },
    [`rh:${id}`]: { html: '<p>private-archive-html</p>' },
  });
  decision = { isArticle: true, reason: '独立论述' };
  assert.deepEqual(await classifyHistoryArticle(id), { ok: true, isArticle: true, reason: '独立论述', source: 'url' });
  assert.equal(websiteCalls, 0); assert.equal(llmCalls, 1);
  assert.deepEqual(JSON.parse(bodies[0]!.messages[0]!.content), { url: id });
  assert.doesNotMatch(JSON.stringify(bodies), /private-/);
});

test('没有存档正文也仅使用 URL，不抓取原网页', async () => {
  assert.deepEqual(await classifyHistoryArticle(id), { ok: true, isArticle: false, reason: '目录页面', source: 'url' });
  assert.equal(websiteCalls, 0); assert.equal(llmCalls, 1);
  assert.deepEqual(JSON.parse(bodies[0]!.messages[0]!.content), { url: id });
});

test('模型失败只在诊断中保留清理后的 URL', async () => {
  await area.set({ articles: { [id]: { id, url: `${id}?token=private-query#private-fragment`, title: 'private-title' } } });
  llmStatus = 403;
  const result = await classifyHistoryArticle(id);
  assert.equal(result.ok, false); assert.match(result.reason, /403/); assert.equal(llmCalls, 1);
  assert.equal(websiteCalls, 0);
  await bookkeepingSettled();
  assert.deepEqual((await getLlmLog())[0]!.request, { url: id });
});

test('URL 信息不足和不合法模型输出都是失败，不归为非文章', async () => {
  for (const raw of [{ unavailable: true }, { isArticle: 'false', reason: '错误格式' }]) {
    decision = raw;
    assert.equal((await classifyHistoryArticle(id)).ok, false);
  }
  assert.equal(websiteCalls, 0);
  assert.equal(llmCalls, 2);
});

test('无效或本地地址不发送请求', async () => {
  for (const url of ['not a URL', 'file:///private/article', 'book:local-chapter']) {
    await area.set({ articles: { [id]: { id, url, title: 'private-title' } } });
    assert.equal((await classifyHistoryArticle(id)).ok, false);
  }
  assert.equal(websiteCalls, 0); assert.equal(llmCalls, 0);
});

test('已删除记录不抓取、不调用模型', async () => {
  assert.equal((await classifyHistoryArticle('missing')).ok, false);
  assert.equal(websiteCalls, 0); assert.equal(llmCalls, 0);
});
