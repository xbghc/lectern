import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeLlmBaseUrl, sameLlmOrigin } from "../src/lib/llmUrl.ts";
import { endpoint } from "../src/lib/llmWire.ts";
import { LlmError, callMessages, callMessagesStream } from "../src/lib/llm.ts";
import { getLlmConfig, setLlmConfig } from "../src/core/background/llm.ts";
import { freshState, installStorage, memoryDriver, type StateDriver } from "../src/sync/storage.ts";
import { DEFAULT_LLM, LEGACY_MINIMAX, type LlmConfig } from "../src/types.ts";

// 只用合成密钥、内存事务和 mock fetch，不发真实模型请求。
const CFG: LlmConfig = { ...DEFAULT_LLM, provider: "custom", protocol: "openai", baseUrl: "https://model.example/v1", model: "test", apiKey: "synthetic-old-key", consentAt: 1 };
let driver: StateDriver;
beforeEach(() => { driver = memoryDriver(freshState({ llm: CFG })); installStorage(driver); });

const INVALID = [
  "model.example", "https:model.example", "https:///model.example", "https://", "https://model.example:bad/v1",
  "ftp://model.example", "javascript:alert(1)", "https://user:pass@model.example/v1", "https://model.example/v1?key=x",
  "https://model.example/v1#frag", "https://model.example/v1?", "https://model.example/v1#", "https://model.example/\nnext",
  "https://model.example\\@other.example/v1", "http://model.example/v1", "http://192.168.1.2/v1", "http://localhost.evil.example/v1",
  "http://foo.localhost/v1",
];

test("地址规范化：路径不参与 origin；协议与非默认端口参与，默认端口和主机大小写等价", () => {
  assert.equal(normalizeLlmBaseUrl(" HTTPS://MODEL.EXAMPLE:443/v1/// "), "https://model.example/v1");
  assert.ok(sameLlmOrigin(CFG.baseUrl, "https://MODEL.EXAMPLE:443/v2"));
  assert.equal(sameLlmOrigin(CFG.baseUrl, "https://model.example:8443/v1"), false);
  assert.equal(sameLlmOrigin("https://localhost/v1", "http://localhost/v1"), false);
  assert.equal(sameLlmOrigin(CFG.baseUrl, "model.example"), false);
  assert.equal(sameLlmOrigin("model.example", "model.example"), false);
  for (const url of INVALID) assert.throws(() => normalizeLlmBaseUrl(url), Error, url);
});

test("HTTP 只保留已有的回环例外，且提供商和最终端点共用校验", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const baseUrl = `http://${host}:1234/v1`;
    assert.equal(normalizeLlmBaseUrl(baseUrl), baseUrl);
    assert.equal(endpoint({ protocol: "openai", baseUrl }), `${baseUrl}/chat/completions`);
  }
  assert.throws(() => endpoint({ protocol: "anthropic", baseUrl: "http://192.168.1.2" }));
});

test("保存：同 origin 路径和默认端口变化保留 Key；非默认端口变化清空", async () => {
  await setLlmConfig({ baseUrl: " HTTPS://MODEL.EXAMPLE:443/v2/// " });
  assert.equal((await getLlmConfig()).apiKey, CFG.apiKey);
  assert.equal((await getLlmConfig()).baseUrl, "https://model.example/v2");
  await setLlmConfig({ baseUrl: "https://model.example:8443/v2" });
  assert.equal((await getLlmConfig()).apiKey, "");
});

test("保存：UI 回填原 Key 不算新 Key，显式不同的新 Key 才能用于新 origin", async () => {
  await setLlmConfig({ baseUrl: "https://other.example/v1", apiKey: ` ${CFG.apiKey} ` });
  assert.equal((await getLlmConfig()).apiKey, "");
  await setLlmConfig({ baseUrl: CFG.baseUrl, apiKey: "synthetic-new-key" });
  assert.equal((await getLlmConfig()).apiKey, "synthetic-new-key");
  await setLlmConfig({ apiKey: "same-origin-replacement" });
  assert.equal((await getLlmConfig()).apiKey, "same-origin-replacement");
});

test("HTTPS 降级、非法地址保存失败不污染存储，失败后的队列仍能保存", async () => {
  const before = await driver.read();
  for (const baseUrl of INVALID) {
    await assert.rejects(setLlmConfig({ baseUrl, apiKey: "synthetic-new-key" }), Error, baseUrl);
    assert.deepEqual(await driver.read(), before);
  }
  await setLlmConfig({ baseUrl: "https://other.example/v1" });
  assert.equal((await getLlmConfig()).apiKey, "");
});

test("旧无效地址不阻止独立撤回同意，但仍拒绝同意、混合保存和模型请求", async () => {
  let requests = 0;
  const deps = { fetch: (async () => { requests++; throw new Error("不该发请求"); }) as typeof fetch };
  for (const baseUrl of INVALID) {
    for (const legacy of [false, true]) {
      const stored: Partial<LlmConfig> = { ...CFG, baseUrl };
      if (legacy) delete stored.provider;
      await driver.update(s => { s.data.llm = stored; });
      const current = await getLlmConfig();
      const before = await driver.read();
      for (const patch of [{ consentAt: 2 }, { consentAt: null, model: "changed" }, { consentAt: null, baseUrl }]) {
        await assert.rejects(setLlmConfig(patch), Error, baseUrl);
        assert.deepEqual(await driver.read(), before, "失败保存不能暗中改变同意状态");
      }
      const revoked = await setLlmConfig({ consentAt: null });
      assert.deepEqual(revoked, { ...current, consentAt: null });
      assert.deepEqual((await driver.read()).data.llm, revoked);
      await assert.rejects(callMessages(revoked, "s", "u", deps), LlmError);
      await assert.rejects(callMessagesStream(revoked, "s", "u", { onDelta() {} }, deps), LlmError);
      await assert.rejects(setLlmConfig({ consentAt: 3 }), Error, baseUrl);
      assert.equal((await getLlmConfig()).consentAt, null);
    }
  }
  assert.equal(requests, 0);
});

test("旧无效地址撤回写入失败时保留已同意状态，队列恢复后可以重试", async () => {
  await driver.update(s => { s.data.llm = { ...CFG, baseUrl: "http://model.example/v1" }; });
  const before = await driver.read();
  installStorage({ read: driver.read, update: async () => { throw new Error("synthetic quota failure"); } });
  try {
    await assert.rejects(setLlmConfig({ consentAt: null }), /quota/);
    assert.deepEqual(await driver.read(), before);
    assert.equal((await getLlmConfig()).consentAt, CFG.consentAt);
  } finally {
    installStorage(driver);
  }
  assert.equal((await setLlmConfig({ consentAt: null })).consentAt, null);
});

test("回环 HTTP 也是不同 origin，不能携带原 HTTPS Key", async () => {
  await setLlmConfig({ baseUrl: "https://localhost:1234/v1", apiKey: "synthetic-local-key" });
  await setLlmConfig({ baseUrl: "http://localhost:1234/v1", apiKey: "synthetic-local-key" });
  assert.equal((await getLlmConfig()).apiKey, "");
});

test("写入失败不改变当前配置，没有会缓存未提交配置的旁路", async () => {
  const before = await driver.read();
  const working = driver;
  installStorage({ read: working.read, update: async () => { throw new Error("synthetic quota failure"); } });
  await assert.rejects(setLlmConfig({ baseUrl: "https://other.example/v1", apiKey: "synthetic-new-key" }), /quota/);
  assert.deepEqual(await driver.read(), before);
  assert.equal((await getLlmConfig()).baseUrl, CFG.baseUrl);
  installStorage(working);
  await setLlmConfig({ model: "after-failure" });
  assert.equal((await getLlmConfig()).apiKey, CFG.apiKey);
});

test("迁移：旧 MiniMax 保持兼容；历史无效地址不经字符串回退继承密钥", async () => {
  await driver.update(s => { s.data.llm = { apiKey: "synthetic-legacy-key" }; });
  assert.equal((await getLlmConfig()).baseUrl, LEGACY_MINIMAX.baseUrl);
  await driver.update(s => { s.data.llm = { apiKey: "synthetic-legacy-key", baseUrl: "model.example" }; });
  await setLlmConfig({ baseUrl: CFG.baseUrl, apiKey: "synthetic-legacy-key" });
  assert.equal((await getLlmConfig()).apiKey, "");
  const read = await getLlmConfig();
  read.apiKey = "mutated-snapshot";
  assert.equal((await getLlmConfig()).apiKey, "", "读取结果不是共享的可变配置缓存");
  assert.equal((await driver.read()).outbox.length, 0, "密钥不能进入同步队列");
});

test("流式/非流式、两种协议：包括从旧存储读出的非法地址都在 fetch 前拒绝", async () => {
  let calls = 0;
  const deps = { fetch: (async () => { calls++; throw new Error("不该发请求"); }) as typeof fetch };
  for (const protocol of ["openai", "anthropic"] as const) {
    for (const baseUrl of INVALID) {
      await driver.update(s => { s.data.llm = { ...CFG, protocol, baseUrl }; });
      const config = await getLlmConfig();
      const configError = (err: unknown) => err instanceof LlmError && err.kind === "config";
      await assert.rejects(callMessages(config, "s", "u", deps), configError, baseUrl);
      await assert.rejects(callMessagesStream(config, "s", "u", { onDelta() {} }, deps), configError, baseUrl);
    }
  }
  assert.equal(calls, 0);
});

test("两种协议、流式/非流式都禁止重定向和隐式 Cookie，最终地址经过规范化", async () => {
  for (const protocol of ["openai", "anthropic"] as const) {
    for (const stream of [false, true]) {
      const deps = { fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        assert.match(String(url), /^https:\/\/model\.example\/v1\//);
        assert.equal(init?.redirect, "error");
        assert.equal(init?.credentials, "omit");
        throw new TypeError("synthetic redirect blocked");
      }) as typeof fetch };
      const cfg = { ...CFG, protocol, baseUrl: "HTTPS://MODEL.EXAMPLE:443/v1///" };
      await assert.rejects(stream ? callMessagesStream(cfg, "s", "u", { onDelta() {} }, deps) : callMessages(cfg, "s", "u", deps),
        (e: unknown) => e instanceof LlmError && e.kind === "network");
    }
  }
});
