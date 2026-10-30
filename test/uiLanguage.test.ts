import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { JSDOM } from "jsdom";
import { UI_EVENTS } from "../src/lib/uiUsage.ts";
import { duration, weekChart } from "../src/ui/activity.ts";
import { readingActivity } from "../src/lib/activity.ts";

const han = /\p{Script=Han}/u;

test("static interface text and accessible labels are English", () => {
  const root = new URL("../src/", import.meta.url);
  for (const file of readdirSync(root, { recursive: true }).filter(f => String(f).endsWith(".html"))) {
    const dom = new JSDOM(readFileSync(new URL(String(file), root), "utf8"));
    try {
      const doc = dom.window.document;
      assert.equal(doc.documentElement.lang, "en", String(file));
      doc.querySelectorAll("script, style").forEach(el => el.remove());
      const walker = doc.createTreeWalker(doc, dom.window.NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        // Native font names double as glyph previews; the surrounding interface and labels stay English.
        if (String(file) === 'app/read.html' && walker.currentNode.parentElement?.closest('.reader-fonts[lang="zh"]')) continue;
        assert.equal(han.test(walker.currentNode.textContent ?? ""), false, `${file}: ${walker.currentNode.textContent}`);
      }
      for (const el of doc.querySelectorAll("*")) {
        for (const name of ["title", "aria-label", "placeholder", "alt", "data-nav-group"]) {
          assert.equal(han.test(el.getAttribute(name) ?? ""), false, `${file}: ${name}`);
        }
      }
    } finally { dom.window.close(); }
  }
  const manifest = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"));
  assert.equal(han.test(manifest.name + manifest.description), false);
  assert.ok(manifest.description.length <= 132);
  for (const label of Object.values(UI_EVENTS)) assert.equal(han.test(label), false, label);
});

test("activity durations and weekday labels use complete English units", () => {
  assert.equal(duration(60_000), "1 min");
  assert.equal(duration(61_000), "1 min 1 s");
  assert.equal(duration(3_600_000), "1 h 0 min");
  const dom = new JSDOM("<!doctype html>");
  const previous = globalThis.document;
  globalThis.document = dom.window.document;
  try {
    const chart = weekChart(readingActivity([], new Date(2026, 9, 27, 12).getTime()));
    assert.deepEqual([...chart.querySelectorAll("small")].map(el => el.textContent), ["Wed", "Thu", "Fri", "Sat", "Sun", "Mon", "Today"]);
    assert.equal(han.test(chart.getAttribute("aria-label") ?? ""), false);
  } finally { globalThis.document = previous; dom.window.close(); }
});
