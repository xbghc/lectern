import { test } from "node:test";
import assert from "node:assert/strict";
import { classificationUrl, parseDecision, parseSuggestions } from "../src/lib/articleFilter.ts";
import { isUrlExcluded, matchesUrlRule } from "../src/lib/url.ts";

test("文章判断严格接受布尔值，错误响应不会默认收录", () => {
  assert.deepEqual(parseDecision({ isArticle: false, reason: "Contents" }), { isArticle: false, reason: "Contents" });
  assert.equal(parseDecision({ isArticle: true, reason: "短文" }).isArticle, true);
  for (const raw of [null, {}, { isArticle: "false", reason: "列表" }, { isArticle: true }]) {
    assert.throws(() => parseDecision(raw));
  }
});

test("分类 URL 去掉凭据、所有查询参数和片段，保留域名与路径", () => {
  assert.equal(classificationUrl("https://private-user:private-password@Example.com:8443/Articles/hello%20world?token=secret&q=private#access_token=secret"), "https://example.com:8443/Articles/hello%20world");
  assert.equal(classificationUrl("http://example.com/?unrecognized_secret=private"), "http://example.com/");
  assert.equal(classificationUrl("https://example.com/article"), "https://example.com/article");
});

test("不合法或非 HTTP(S) 地址不能直接回退为原串发给模型", () => {
  for (const raw of ["private text", "/relative/path", "file:///private/report", "data:text/plain,secret", "javascript:alert('secret')", "chrome://settings", "book:private-chapter"]) {
    assert.throws(() => classificationUrl(raw), /valid HTTP\(S\) URL/);
  }
});

test("URL 无法判断的结果不能归为文章或非文章", () => {
  assert.throws(() => parseDecision({ unavailable: true }), /URL alone is not enough/);
  assert.throws(() => parseDecision({ unavailable: true, isArticle: false, reason: "不确定" }), /URL alone is not enough/);
});

test("黑名单匹配域名边界、路径边界、协议，保留路径大小写", () => {
  assert.ok(matchesUrlRule("https://mail.example.com/a", "example.com"));
  assert.ok(matchesUrlRule("https://example.com/search/a?q=x", "https://example.com/search"));
  assert.ok(matchesUrlRule("https://example.com/a", "https://example.com/"));
  for (const url of ["https://evil-example.com/search", "https://example.com/searching", "https://example.com/Search", "http://example.com/search"]) {
    assert.equal(matchesUrlRule(url, "https://example.com/search"), false);
  }
  assert.equal(isUrlExcluded("https://example.com/a", ["*", "com", "https://example.com/?q=x"]), false);
});

test("LLM 建议去重，丢弃无关或无效规则", () => {
  const suggestions = parseSuggestions({ suggestions: [
    { pattern: "https://example.com/search", reason: "搜索页" },
    { pattern: "https://example.com/search", reason: "重复" },
    { pattern: "other.com", reason: "无关" },
    { pattern: "*", reason: "All" },
  ] }, ["https://example.com/search?q=abc"]);
  assert.deepEqual(suggestions, [{ pattern: "https://example.com/search", reason: "搜索页" }]);
});
