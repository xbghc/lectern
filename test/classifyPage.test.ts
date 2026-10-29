import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { memoryBackend } from '../src/app/shim.ts';
import { DEFAULT_LLM, LEGACY_MINIMAX, DEFAULT_SETTINGS, type LlmFailure } from '../src/types.ts';
import { classifyPage, NETWORK_RETRY_MS, REFUSAL_TTL_MS, type FilterDeps } from '../src/features/reading/articleFilter.ts';
import { bookkeepingSettled, getLlmLog } from '../src/background/llmLog.ts';
import { readingHandlers } from '../src/features/reading/background.ts';

/*
 * 打开页面时的文章判别：失败现场认得出是哪一页；断网隔几秒重发；内容审核拒掉的页一小时内不再去问。
 */

const URL_A = 'https://news.example.com/a';
const REFUSAL = JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'input new_sensitive (1026)' }, request_id: 'x' });
const ARTICLE = JSON.stringify({ content: [{ type: 'text', text: '{"isArticle":true,"reason":"独立论述"}' }], usage: { input_tokens: 50, output_tokens: 20 }, stop_reason: 'end_turn' });

let local = memoryBackend();
let session = memoryBackend();
/** 每次调用模型时按顺序取一个回应；函数是抛出去的（断网）。 */
let replies: Array<() => Response> = [];
let calls = 0;
let bodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
let clock = 1_000_000;
let waits: number[] = [];
const deps: FilterDeps = { wait: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock };
const offline = (): Response => { throw new TypeError('Failed to fetch'); };
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  local = memoryBackend(); session = memoryBackend(); calls = 0; bodies = []; waits = []; replies = []; clock = 1_000_000;
  (globalThis as Record<string, unknown>).chrome = { storage: { local, session } };
  await local.set({ settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: [] }, llm: { ...DEFAULT_LLM, ...LEGACY_MINIMAX, apiKey: 'test-only', consentAt: 1 } });
  globalThis.fetch = async (_input, init) => {
    calls++;
    bodies.push(JSON.parse(String(init?.body)));
    const next = replies.shift();
    if (!next) throw new Error('多调了一次模型');
    return next();
  };
});
afterEach(async () => { await bookkeepingSettled(); globalThis.fetch = originalFetch; });

async function failures(): Promise<LlmFailure[]> {
  await bookkeepingSettled();
  return getLlmLog();
}

test('内容审核拒掉：诊断和拒答缓存只保留清理后的网址', async () => {
  replies = [() => new Response(REFUSAL, { status: 500 })];
  const got = await classifyPage('https://private-user:private-pass@news.example.com/a?token=private-query#private-fragment', deps);
  assert.deepEqual(got, { ok: false, reason: "The model provider's content filter rejected this text (input new_sensitive (1026)); this page is not tracked" });
  assert.equal(calls, 1, '拒答不重发');
  const [f] = await failures();
  assert.equal(f!.kind, 'refused');
  assert.deepEqual(f!.request, { url: URL_A });
  assert.deepEqual(JSON.parse(bodies[0]!.messages[0]!.content), { url: URL_A });
  assert.doesNotMatch(JSON.stringify(await session.get(null)), /private-/);
});

test('拒掉的页一小时内再打开不再去问，过了一小时、换一页都照常问', async () => {
  replies = [() => new Response(REFUSAL, { status: 500 })];
  const first = await classifyPage(URL_A, deps);
  clock += REFUSAL_TTL_MS - 1;
  assert.deepEqual(await classifyPage(URL_A, deps), first);
  assert.equal(calls, 1);
  assert.equal((await failures()).length, 1, '也不在诊断日志里多占一格');

  replies = [() => new Response(ARTICLE)];
  assert.equal((await classifyPage('https://news.example.com/b', deps)).ok, true);
  clock += 1;
  replies = [() => new Response(ARTICLE)];
  assert.equal((await classifyPage(URL_A, deps)).ok, true);
  assert.equal(calls, 3);
});

test('别的失败不记住：普通的 HTTP 500 刷新就再问', async () => {
  replies = [() => new Response('{"error":{"message":"internal"}}', { status: 500 }), () => new Response(ARTICLE)];
  const got = await classifyPage(URL_A, deps);
  assert.equal(got.ok, false);
  assert.match(got.reason, /^Article classification failed: HTTP 500/);
  assert.equal((await classifyPage(URL_A, deps)).ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(waits, [], 'HTTP 错误不重发');
});

test('断网：隔几秒重发，成了的话之前那几次记成人没看见的失败', async () => {
  replies = [offline, offline, () => new Response(ARTICLE)];
  const got = await classifyPage(URL_A, deps);
  assert.deepEqual(got, { ok: true, isArticle: true, reason: '独立论述' });
  assert.deepEqual(waits, NETWORK_RETRY_MS);
  const log = await failures();
  assert.deepEqual(log.map((f) => [f.kind, f.recovered, f.request['retry']]), [['network', 'retry', undefined], ['network', 'retry', 1]]);
});

test('一直断网：重发两次后照实报错，三次失败都是人撞上的', async () => {
  replies = [offline, offline, offline];
  const got = await classifyPage(URL_A, deps);
  assert.equal(got.ok, false);
  assert.match(got.reason, /^Article classification failed: Network error/);
  assert.equal(calls, 3);
  const log = await failures();
  assert.deepEqual(log.map((f) => [f.kind, f.recovered, f.request['retry']]), [['network', undefined, undefined], ['network', undefined, 1], ['network', undefined, 2]]);
  assert.equal(log[2]!.request['url'], URL_A);
});

test('没有 storage.session 也照常判别，只是记不住', async () => {
  (globalThis as Record<string, unknown>).chrome = { storage: { local } };
  replies = [() => new Response(REFUSAL, { status: 500 }), () => new Response(REFUSAL, { status: 500 })];
  assert.equal((await classifyPage(URL_A, deps)).ok, false);
  assert.equal((await classifyPage(URL_A, deps)).ok, false);
  assert.equal(calls, 2);
});

test('后台消息即使夹带旧版标题和正文也只把清理后的 URL 发给模型', async () => {
  replies = [() => new Response(ARTICLE)];
  const oldMessage = { type: 'article:classify' as const, url: `${URL_A}?private-query#private-fragment`, title: 'private-title', text: 'private-body' };
  const result = await readingHandlers['article:classify'](oldMessage);
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(bodies[0]!.messages[0]!.content), { url: URL_A });
  assert.doesNotMatch(JSON.stringify(bodies), /private-/);
});

test('黑名单、无效 URL、未同意或未配置模型均不发送请求', async () => {
  await local.set({ settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: ['news.example.com'] } });
  assert.equal((await classifyPage(URL_A, deps)).ok, true);
  assert.equal(calls, 0);
  await local.set({ settings: { ...DEFAULT_SETTINGS, articleExcludedUrls: [] } });
  assert.equal((await classifyPage('file:///private/page', deps)).ok, false);
  for (const config of [{ consentAt: null }, { apiKey: '' }]) {
    await local.set({ llm: { ...DEFAULT_LLM, ...LEGACY_MINIMAX, apiKey: 'test-only', consentAt: 1, ...config } });
    assert.equal((await classifyPage(URL_A, deps)).ok, false);
    await bookkeepingSettled();
  }
  assert.equal(calls, 0);
});

test('旧正文拒答缓存不影响新的 URL 判断', async () => {
  await session.set({ articleRefused: { [URL_A]: { until: clock + REFUSAL_TTL_MS, reason: '旧正文被拒' } } });
  replies = [() => new Response(ARTICLE)];
  assert.equal((await classifyPage(URL_A, deps)).ok, true);
  assert.equal(calls, 1);
});

test('URL 信息不足返回失败，不补发标题、正文或抓取网页', async () => {
  replies = [() => new Response(JSON.stringify({ content: [{ type: 'text', text: '{"unavailable":true}' }], stop_reason: 'end_turn' }))];
  const result = await classifyPage(URL_A, deps);
  assert.equal(result.ok, false);
  assert.match(result.reason, /URL alone is not enough/);
  assert.equal(calls, 1);
  assert.deepEqual(JSON.parse(bodies[0]!.messages[0]!.content), { url: URL_A });
});
