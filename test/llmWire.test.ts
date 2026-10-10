import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmError, callMessages, callMessagesStream } from "../src/lib/llm.ts";
import { endpoint, requestBody, requestHeaders } from "../src/lib/llmWire.ts";
import type { LlmConfig } from "../src/types.ts";
import { DEFAULT_LLM, LEGACY_MINIMAX } from "../src/types.ts";

/*
 * 两套协议在线上的样子。Anthropic 那一路的行为由 llm.test.ts / stream.test.ts 里原有的用例守着，
 * 这里补的是：地址和请求头怎么按协议出、OpenAI 那套的请求体和响应怎么读。
 * 对面是假的——验的是我们发出去的东西和读回来的办法，不是哪家服务真会回什么。
 */
const OPENAI: LlmConfig = {
  ...DEFAULT_LLM, provider: "openai", protocol: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-x",
  apiKey: "sk-test", consentAt: 1, timeoutMs: 1_000,
};
const COMPAT: LlmConfig = { ...OPENAI, provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat" };
const ANTHROPIC: LlmConfig = { ...OPENAI, provider: "anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-x" };
const MINIMAX: LlmConfig = { ...OPENAI, ...LEGACY_MINIMAX };

interface Sent { url: string; headers: Headers; body: Record<string, unknown> }
function capture(reply: () => Response): { fetch: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return reply();
    }) as typeof fetch,
  };
}
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sse(lines: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= lines.length) return c.close();
      c.enqueue(enc.encode(lines[i++]!));
    },
  }), { status: 200 });
}
const data = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const chunk = (content: string): string => data({ choices: [{ index: 0, delta: { content } }] });

test("地址：OpenAI 协议接 /chat/completions；Anthropic 协议接 /messages，旧配置不带 /v1 的照旧补上", () => {
  assert.equal(endpoint(OPENAI), "https://api.openai.com/v1/chat/completions");
  assert.equal(endpoint(COMPAT), "https://api.deepseek.com/chat/completions");
  assert.equal(endpoint({ protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4/" }), "https://open.bigmodel.cn/api/paas/v4/chat/completions");
  assert.equal(endpoint(ANTHROPIC), "https://api.anthropic.com/v1/messages");
  assert.equal(endpoint(MINIMAX), "https://api.minimaxi.com/anthropic/v1/messages");
  assert.equal(endpoint({ protocol: "anthropic", baseUrl: "https://api.minimax.io/anthropic/v1" }), "https://api.minimax.io/anthropic/v1/messages");
});

test("请求头：OpenAI 协议用 Bearer，Anthropic 协议用 x-api-key；直连浏览器的那个头只发给 Anthropic 自己", () => {
  assert.deepEqual(requestHeaders(OPENAI), { "content-type": "application/json", authorization: "Bearer sk-test" });
  assert.equal(requestHeaders(ANTHROPIC)["x-api-key"], "sk-test");
  assert.equal(requestHeaders(ANTHROPIC)["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal("authorization" in requestHeaders(ANTHROPIC), false);
  assert.equal("anthropic-dangerous-direct-browser-access" in requestHeaders(MINIMAX), false);
  assert.equal("anthropic-dangerous-direct-browser-access" in requestHeaders({ ...ANTHROPIC, baseUrl: "https://notanthropic.com/v1" }), false);
});

test("请求体：OpenAI 协议把 system 放进 messages；输出上限的参数名按域名分；流式时要用量", () => {
  assert.deepEqual(requestBody(OPENAI, "S", "U", false), {
    model: "gpt-x",
    messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }],
    max_completion_tokens: 4096,
  });
  const compat = requestBody(COMPAT, "S", "U", true);
  assert.equal(compat.max_tokens, 4096);
  assert.equal("max_completion_tokens" in compat, false);
  assert.equal(compat.stream, true);
  assert.deepEqual(compat.stream_options, { include_usage: true });
  // Anthropic 协议的请求体和多提供商之前一字不差
  assert.deepEqual(requestBody(MINIMAX, "S", "U", true), {
    model: "MiniMax-M3-highspeed", max_tokens: 4096, system: "S", messages: [{ role: "user", content: "U" }], stream: true,
  });
});

test("OpenAI 非流式：发到 /chat/completions，读回文字、用量和结束原因", async () => {
  const { fetch, sent } = capture(() => json({
    choices: [{ index: 0, message: { role: "assistant", content: "你好" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  }));
  const res = await callMessages(OPENAI, "S", "U", { fetch });
  assert.equal(sent[0]!.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(sent[0]!.headers.get("authorization"), "Bearer sk-test");
  assert.equal(sent[0]!.headers.get("x-api-key"), null);
  assert.deepEqual([res.text, res.usage, res.stopReason, res.truncated], ["你好", { inputTokens: 12, outputTokens: 3 }, "stop", false]);
});

test("OpenAI 非流式：finish_reason 是 length 就是被截断；content 是分块数组也读得出", async () => {
  const cut = await callMessages(COMPAT, "S", "U", { fetch: capture(() => json({ choices: [{ message: { content: "半句" }, finish_reason: "length" }] })).fetch });
  assert.deepEqual([cut.truncated, cut.stopReason], [true, "length"]);
  const parts = await callMessages(COMPAT, "S", "U", {
    fetch: capture(() => json({ choices: [{ message: { content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }] }, finish_reason: "stop" }] })).fetch,
  });
  assert.equal(parts.text, "甲乙");
});

test("OpenAI 非流式：内容审核拒答认成 refused；HTTP 200 里带着 error 的照实报错", async () => {
  await assert.rejects(
    callMessages(OPENAI, "S", "U", { fetch: capture(() => json({ choices: [{ message: { content: "" }, finish_reason: "content_filter" }] })).fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "refused",
  );
  await assert.rejects(
    callMessages(OPENAI, "S", "U", { fetch: capture(() => json({ choices: [{ message: { content: null, refusal: "I can't help with that" }, finish_reason: "stop" }] })).fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "refused" && e.message.includes("can't help"),
  );
  await assert.rejects(
    callMessages(COMPAT, "S", "U", { fetch: capture(() => json({ error: { message: "No endpoints found", code: 404 } })).fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && e.message.includes("No endpoints found"),
  );
  // 错误体走的是和 Anthropic 一样的那条路：401 带出原文
  await assert.rejects(
    callMessages(OPENAI, "S", "U", { fetch: capture(() => json({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, 401)).fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && e.status === 401 && e.message.includes("Incorrect API key"),
  );
});

test("OpenAI 流式：增量拼成全文，用量从收尾那一块取，[DONE] 之后正常结束", async () => {
  const seen: string[] = [];
  const { fetch, sent } = capture(() => sse([
    data({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
    chunk("你"), chunk("好"),
    data({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    data({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 2 } }),
    "data: [DONE]\n\n",
  ]));
  const res = await callMessagesStream(OPENAI, "S", "U", { onDelta: (t) => seen.push(t) }, { fetch });
  assert.equal(sent[0]!.body.stream, true);
  assert.deepEqual(seen, ["你", "你好"]);
  assert.deepEqual([res.text, res.usage, res.stopReason, res.truncated], ["你好", { inputTokens: 20, outputTokens: 2 }, "stop", false]);
  assert.equal(res.stream?.messageStop, true);
});

test("OpenAI 流式：思考过程（reasoning_content）不算答案；分块边界切在 JSON 中间也拼得回来", async () => {
  const body = data({ choices: [{ delta: { reasoning_content: "让我想想" } }] }) + chunk("答案") + data({ choices: [{ delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
  const mid = Math.floor(body.length / 2);
  const res = await callMessagesStream(COMPAT, "S", "U", { onDelta: () => {} }, { fetch: capture(() => sse([body.slice(0, mid), body.slice(mid)])).fetch });
  assert.equal(res.text, "答案");
});

test("OpenAI 流式：没给 finish_reason 但等到了 [DONE] 算正常结束；两样都没有就是半路断了", async () => {
  const ok = await callMessagesStream(COMPAT, "S", "U", { onDelta: () => {} }, { fetch: capture(() => sse([chunk("完整"), "data: [DONE]\n\n"])).fetch });
  assert.deepEqual([ok.text, ok.stopReason], ["完整", "stop"]);
  await assert.rejects(
    callMessagesStream(COMPAT, "S", "U", { onDelta: () => {} }, { fetch: capture(() => sse([chunk("半截")])).fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "stream_interrupted" && e.raw?.text === "半截",
  );
});

test("OpenAI 流式：length 是截断；流里的 error 和 content_filter 各认各的", async () => {
  const cut = await callMessagesStream(COMPAT, "S", "U", { onDelta: () => {} }, {
    fetch: capture(() => sse([chunk("半句"), data({ choices: [{ delta: {}, finish_reason: "length" }] }), "data: [DONE]\n\n"])).fetch,
  });
  assert.equal(cut.truncated, true);
  await assert.rejects(
    callMessagesStream(COMPAT, "S", "U", { onDelta: () => {} }, { fetch: capture(() => sse([data({ error: { message: "Rate limit reached" } })])).fetch }),
    (e: unknown) => e instanceof LlmError && e.kind === "http" && e.message.includes("Rate limit"),
  );
  await assert.rejects(
    callMessagesStream(COMPAT, "S", "U", { onDelta: () => {} }, {
      fetch: capture(() => sse([chunk("开头"), data({ choices: [{ delta: {}, finish_reason: "content_filter" }] })])).fetch,
    }),
    (e: unknown) => e instanceof LlmError && e.kind === "refused",
  );
});

test("没选模型服务：不发请求，话里说的是去选，而不是去填 Key", async () => {
  let called = false;
  const fetchSpy = (async () => { called = true; return json({}); }) as unknown as typeof fetch;
  await assert.rejects(
    callMessages({ ...DEFAULT_LLM, apiKey: "k", consentAt: 1 }, "S", "U", { fetch: fetchSpy }),
    (e: unknown) => e instanceof LlmError && e.kind === "config" && e.message.includes("选模型服务"),
  );
  assert.equal(called, false);
});
