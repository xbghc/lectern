import { test } from "node:test";
import assert from "node:assert/strict";
import { CUSTOM_PROVIDER, PINNED, findProvider, searchProviders } from "../src/lib/providers.ts";
import { PROVIDERS } from "../src/lib/providers.generated.ts";
import { endpoint } from "../src/lib/llmWire.ts";
import { toPreset } from "../scripts/update-providers.ts";

/* 清单是 models.dev 的快照。这里守两件事：快照本身能用（重新生成之后也得过），和搜索、裁剪的规矩。 */

test("快照：两家协议的本家都在，地址和协议是对的", () => {
  assert.deepEqual([findProvider("openai")?.protocol, findProvider("openai")?.baseUrl], ["openai", "https://api.openai.com/v1"]);
  assert.deepEqual([findProvider("anthropic")?.protocol, findProvider("anthropic")?.baseUrl], ["anthropic", "https://api.anthropic.com/v1"]);
  assert.equal(endpoint(findProvider("openai")!), "https://api.openai.com/v1/chat/completions");
  assert.equal(endpoint(findProvider("anthropic")!), "https://api.anthropic.com/v1/messages");
});

test("快照：每一家都拼得出一个合法的请求地址，id 不重复，也没有谁占了「自定义」这个名字", () => {
  assert.ok(PROVIDERS.length > 100, `只有 ${PROVIDERS.length} 家，像是没取全`);
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
  for (const p of PROVIDERS) {
    assert.ok(p.name && (p.protocol === "openai" || p.protocol === "anthropic"), p.id);
    assert.match(new URL(endpoint(p)).protocol, /^https?:$/, p.id);
    assert.equal(/[${}\s]/.test(p.baseUrl), false, `${p.id} 的地址里有占位符`);
    assert.notEqual(p.id, CUSTOM_PROVIDER);
  }
});

test("快照：置顶的几家都还在清单里（models.dev 改了 id 的话这里会先知道）", () => {
  for (const id of PINNED) assert.ok(findProvider(id), id);
});

test("搜索：空着时置顶的在前、其余按名字；有输入时按名字、id、中文别名、地址找，多个词都得命中", () => {
  const all = searchProviders("");
  assert.deepEqual(all.pinned.map((p) => p.id), [...PINNED]);
  assert.equal(all.pinned.length + all.others.length, PROVIDERS.length);
  assert.equal(all.others.some((p) => PINNED.includes(p.id)), false);

  assert.deepEqual(searchProviders("OPENAI").pinned.map((p) => p.id), ["openai"]);
  assert.deepEqual(searchProviders("智谱").pinned.map((p) => p.id), ["zhipuai"]);
  assert.deepEqual(searchProviders("通义").pinned.map((p) => p.id), ["alibaba-cn"]);
  assert.deepEqual(searchProviders("bigmodel.cn").pinned.map((p) => p.id), ["zhipuai"]);
  assert.deepEqual(searchProviders("minimax 国内").pinned.map((p) => p.id), ["minimax-cn"]);
  const none = searchProviders("这家肯定没有 zzzz");
  assert.equal(none.pinned.length + none.others.length, 0);
});

test("裁剪：协议认不出的、地址要按账号拼的不收；模型只留能出文字、没下线的，新的在前", () => {
  assert.equal(toPreset({ id: "amazon-bedrock", npm: "@ai-sdk/amazon-bedrock" }), null);
  assert.equal(toPreset({ id: "cf", npm: "@ai-sdk/openai-compatible", api: "https://api.cloudflare.com/accounts/${ACCOUNT_ID}/ai/v1" }), null);
  assert.equal(toPreset({ id: "x", npm: "@ai-sdk/openai-compatible" }), null, "没给地址又不在手补的表里");
  const p = toPreset({
    id: "acme", name: "Acme", npm: "@ai-sdk/openai-compatible", api: "https://api.acme.test/v1/", doc: "https://acme.test/docs",
    models: {
      old: { id: "old", release_date: "2024-01-01" },
      gone: { id: "gone", release_date: "2026-01-01", status: "deprecated" },
      image: { id: "image", release_date: "2026-02-01", modalities: { output: ["image"] } },
      fresh: { id: "fresh", release_date: "2026-03-01", modalities: { output: ["text"] } },
    },
  });
  assert.deepEqual(p, { id: "acme", name: "Acme", protocol: "openai", baseUrl: "https://api.acme.test/v1", doc: "https://acme.test/docs", models: ["fresh", "old"] });
  // 官方两家在 models.dev 里没有地址，靠脚本里手补的那张表
  assert.equal(toPreset({ id: "openai", npm: "@ai-sdk/openai" })?.baseUrl, "https://api.openai.com/v1");
  assert.equal(toPreset({ id: "anthropic", npm: "@ai-sdk/anthropic" })?.protocol, "anthropic");
});
