import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { DEFAULT_LLM, DEFAULT_SETTINGS, type LlmConfig } from "../src/types.ts";
import { freshState, installStorage, memoryDriver } from "../src/sync/storage.ts";
import { getLlmConfig, setLlmConfig } from "../src/core/background/llm.ts";

test("设置页与后台共同保护原 Key：同 origin 可保持、跨 origin 必须重填，回填旧值也不继承，保存失败不测试", async () => {
  const dom = new JSDOM(readFileSync(new URL("../src/options/options.html", import.meta.url), "utf8"), { url: "https://extension.example/options.html" });
  const doc = dom.window.document;
  // 与模型无关的同步表单不启动轮询。
  doc.getElementById("sync-settings")?.remove();
  const g = globalThis as Record<string, unknown>;
  const previous = Object.fromEntries(["window", "document", "Event", "location", "chrome"].map(k => [k, g[k]]));
  Object.assign(g, { window: dom.window, document: doc, Event: dom.window.Event, location: dom.window.location });
  const initial = { ...DEFAULT_LLM, provider: "custom", protocol: "openai", baseUrl: "https://model.example/v1", model: "test", apiKey: "synthetic-ui-key" };
  const driver = memoryDriver(freshState({ llm: initial }));
  installStorage(driver);
  let saves = 0, tests = 0;
  let failSave: false | "reply" | "throw" = false;
  g["chrome"] = { runtime: { sendMessage: async (m: { type: string; config: Partial<LlmConfig> }) => {
    switch (m.type) {
      case "settings:get": return DEFAULT_SETTINGS;
      case "llm:get": {
        const cfg = await getLlmConfig();
        return { ...cfg, apiKey: "", apiKeySet: !!cfg.apiKey };
      }
      case "llm:set":
        saves++;
        if (failSave === "throw") throw new Error("synthetic transport failure");
        if (failSave === "reply") return { ok: false, error: "synthetic save failure" };
        await setLlmConfig(m.config);
        return { ok: true };
      case "llm:usage": return { requests: 0 };
      case "llm:test": tests++; return { ok: true, model: "test" };
      case "llm:log": return { failures: [], timings: [], translations: [], fetches: [], errors: [], usage: { days: {} } };
      default: return {};
    }
  } } };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const input = (id: string, value: string) => { (doc.getElementById(id) as HTMLInputElement).value = value; };
  const save = async () => { (doc.getElementById("save-llm") as HTMLButtonElement).click(); await tick(); };
  try {
    await import("../src/options/form.ts");
    await tick();
    assert.equal((doc.getElementById("apiKey") as HTMLInputElement).value, "", "原密钥不回显到设置页");
    input("baseUrl", "HTTPS://MODEL.EXAMPLE:443/v2");
    await save();
    assert.equal(saves, 1);
    assert.equal((await getLlmConfig()).apiKey, initial.apiKey);
    input("baseUrl", "https://model.example:8443/v2");
    await save();
    assert.equal(saves, 1);
    assert.match(doc.getElementById("llm-status")!.textContent!, /换了服务地址/);
    input("apiKey", initial.apiKey); // 模拟自动回填/过时 UI 带回旧值，后台仍必须拒绝继承。
    await save();
    assert.equal((await getLlmConfig()).apiKey, "");
    input("apiKey", "synthetic-ui-new-key");
    await save();
    assert.equal((await getLlmConfig()).apiKey, "synthetic-ui-new-key");
    input("baseUrl", "http://model.example/v2");
    const beforeInvalid = saves;
    await save();
    assert.equal(saves, beforeInvalid);
    assert.match(doc.getElementById("llm-status")!.textContent!, /HTTPS/);
    const beforeFailure = await driver.read();
    input("baseUrl", "https://model.example:8443/v3");
    failSave = "reply";
    await save();
    assert.match(doc.getElementById("llm-status")!.textContent!, /保存失败：synthetic save failure/);
    assert.deepEqual(await driver.read(), beforeFailure);
    failSave = "throw";
    await save();
    assert.match(doc.getElementById("llm-status")!.textContent!, /保存失败：synthetic transport failure/);
    assert.deepEqual(await driver.read(), beforeFailure);
    assert.equal(tests, 0, "未同意和保存失败都不能触发测试请求");
  } finally {
    dom.window.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete g[key]; else g[key] = value;
    }
  }
});
