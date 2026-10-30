import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { DEFAULT_LLM, DEFAULT_SETTINGS } from "../src/types.ts";
import { AdvancedConfigError, advancedModel, advancedReading, advancedTranslation, parseAdvancedPreferences } from "../src/options/advancedPreferences.ts";
import { AdvancedPreferencesEditor } from "../src/options/advancedEditor.ts";

const defaults = () => ({ reading: advancedReading(DEFAULT_SETTINGS), translation: advancedTranslation(DEFAULT_SETTINGS), model: advancedModel(DEFAULT_LLM) });

test("advanced JSON round-trips native values and excludes common fields, secrets and legacy keys", () => {
  const draft = defaults();
  draft.reading.idleTimeoutMs = 30_125;
  draft.reading.finishRatio = 0.875;
  draft.model.timeoutMs = 61_001;
  assert.deepEqual(parseAdvancedPreferences(JSON.stringify(draft)), draft);
  assert.equal("articleExcludedUrls" in draft.reading, false);
  assert.equal("excludedDomains" in draft.reading, false);
  assert.equal("translateEnabled" in draft.translation, false);
  assert.deepEqual(Object.keys(draft.model), ["maxTokens", "timeoutMs"]);

  for (const [group, key, value] of [
    ["reading", "excludedDomains", []], ["reading", "articleExcludedUrls", []],
    ["translation", "translateEnabled", false], ["model", "apiKey", "secret"],
    ["model", "consentAt", 123], ["model", "provider", "custom"],
  ] as const) {
    assert.throws(() => parseAdvancedPreferences(JSON.stringify({ ...draft, [group]: { ...draft[group], [key]: value } })), /Unknown setting/);
  }
});

test("advanced JSON rejects malformed, missing, mistyped and out-of-range settings with a location", () => {
  const draft = defaults();
  const invalid: Array<[unknown, RegExp]> = [
    [null, /Expected an object/], [[], /Expected an object/], [{ ...draft, unknown: true }, /unknown: Unknown setting/],
    [{ ...draft, model: { timeoutMs: 50_000 } }, /model.maxTokens: Required setting/],
    [{ ...draft, reading: { ...draft.reading, restorePositionEnabled: "false" } }, /reading.restorePositionEnabled: Expected true or false/],
    [{ ...draft, reading: { ...draft.reading, finishRatio: 90 } }, /reading.finishRatio: Expected a number from 0.1 to 1/],
    [{ ...draft, reading: { ...draft.reading, stallTimeoutMs: draft.reading.idleTimeoutMs } }, /Must be greater than reading.idleTimeoutMs/],
    [{ ...draft, translation: { ...draft.translation, minSelectionChars: 1.2 } }, /translation.minSelectionChars: Expected an integer/],
    [{ ...draft, translation: { ...draft.translation, maxAutoSelectionWords: 361 } }, /translation.maxAutoSelectionWords/],
    [{ ...draft, model: { ...draft.model, maxTokens: "4096" } }, /model.maxTokens: Expected an integer/],
    [{ ...draft, model: { ...draft.model, timeoutMs: 120_001 } }, /model.timeoutMs/],
  ];
  for (const [value, message] of invalid) {
    assert.throws(() => parseAdvancedPreferences(JSON.stringify(value, null, 2)), error => {
      assert.ok(error instanceof AdvancedConfigError);
      assert.match(error.message, message);
      assert.match(error.message, /line \d+, column \d+/);
      return true;
    });
  }
  for (const json of ['{"reading":', '{"reading": true,}', JSON.stringify(draft).replace('4096', '1e400')]) {
    assert.throws(() => parseAdvancedPreferences(json), AdvancedConfigError);
  }
  const mistyped = JSON.stringify({ ...draft, model: { ...draft.model, timeoutMs: "bad" } }, null, 2);
  assert.throws(() => parseAdvancedPreferences(mistyped), error => {
    assert.ok(error instanceof AdvancedConfigError);
    assert.equal(error.offset, mistyped.indexOf('"timeoutMs"'));
    return true;
  });
  const misplaced = JSON.stringify({ ...draft, model: { ...draft.model, reading: {} } }, null, 2);
  assert.throws(() => parseAdvancedPreferences(misplaced), error => {
    assert.ok(error instanceof AdvancedConfigError);
    assert.equal(error.offset, misplaced.lastIndexOf('"reading"'), "unknown nested keys point at their own group");
    return true;
  });
});

test("advanced editor preserves the valid draft across errors and model reloads, and reset/discard can restore it", () => {
  const dom = new JSDOM("<!doctype html><body></body>");
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { value: dom.window.document, configurable: true });
  try {
    let changes = 0;
    const editor = new AdvancedPreferencesEditor(() => changes++);
    dom.window.document.body.append(editor.section);
    const settings = { ...DEFAULT_SETTINGS, finishRatio: .875, idleTimeoutMs: 30_125 };
    editor.setModel({ ...DEFAULT_LLM, timeoutMs: 61_001 });
    assert.equal(editor.input.disabled, true);
    assert.equal(editor.ready, false);
    assert.equal(editor.validate(), false, "an editor missing either preference source cannot be saved");
    editor.setSettings(settings);
    assert.equal(editor.input.disabled, false);
    assert.equal(editor.ready, true);
    assert.deepEqual(Object.keys(JSON.parse(editor.input.value)), ["reading", "translation", "model"]);
    assert.equal(editor.settings().finishRatio, .875);
    assert.equal(editor.settings().idleTimeoutMs, 30_125);
    assert.equal(editor.model().timeoutMs, 61_001);

    const edited = JSON.parse(editor.input.value);
    edited.reading.finishRatio = .95;
    edited.model.maxTokens = 2048;
    editor.input.value = JSON.stringify(edited);
    editor.input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(changes, 1);
    assert.equal(editor.settings().finishRatio, .95);
    assert.equal(editor.model().maxTokens, 2048);

    editor.input.value = '{"reading":';
    editor.input.dispatchEvent(new dom.window.Event("input"));
    assert.equal(editor.validate(true), false);
    assert.equal(editor.input.getAttribute("aria-invalid"), "true");
    assert.equal(editor.section.querySelector("details")!.open, true);
    assert.equal(dom.window.document.activeElement, editor.input);
    assert.equal(editor.settings().finishRatio, .95, "invalid text must never enter the draft that saves");
    assert.equal(editor.model().maxTokens, 2048);

    editor.setModel({ ...DEFAULT_LLM, maxTokens: 2048 });
    assert.equal(editor.settings().finishRatio, .95, "a model save response must not overwrite pending reading preferences");
    editor.setSettings(settings);
    assert.equal(editor.error, null);
    assert.equal(editor.input.hasAttribute("aria-invalid"), false);
    assert.equal(editor.settings().finishRatio, .875);
    assert.equal(editor.model().maxTokens, 2048, "reading reset keeps model budgets");

    editor.input.value = JSON.stringify(JSON.parse(editor.input.value));
    editor.section.querySelector<HTMLButtonElement>("button")!.click();
    assert.match(editor.input.value, /\n  "reading"/);
    assert.equal(editor.input.validity.valid, true);
    editor.setBusy(true);
    assert.equal(editor.input.disabled, true);
    assert.equal(editor.section.querySelector<HTMLButtonElement>("button")!.disabled, true);
    editor.setBusy(false);
    assert.equal(editor.input.disabled, false);
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});
