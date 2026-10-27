import { test } from "node:test";
import assert from "node:assert/strict";
import { readingReport } from "../src/lib/readingReport.ts";
import { activityDays, recentActivity, type ActivitySession } from "../src/lib/activity.ts";
import { chapterId } from "../src/books/types.ts";
import type { Article, Session, Snippet } from "../src/types.ts";
const now = new Date(2026, 9, 27, 12).getTime();
const midnight = new Date(2026, 9, 27).getTime();
const session = (id: string, startTs: number, endTs: number, book = false): ActivitySession => ({ id, startTs, endTs,
  articleId: book ? chapterId("ab".repeat(32), 0) : "https://example.com/article", title: book ? "Chapter 1" : "Article", url: "" });

test("reading report splits midnight, deduplicates sessions and separates books from articles", () => {
  const article = session("article", midnight - 60_000, midnight + 120_000);
  const book = session("book", midnight + 120_000, midnight + 180_000, true);
  const report = readingReport([article, article, book], [], [], now, 7);
  assert.equal(report.totalMs, 240_000);
  assert.equal(report.articleMs, 180_000);
  assert.equal(report.bookMs, 60_000);
  assert.equal(report.groups[5]!.totalMs, 60_000);
  assert.equal(report.groups[6]!.totalMs, 180_000);
  assert.equal(report.readingDays, 2);
  assert.deepEqual(report.groups[6]!.titles, { articles: ["Article"], books: ["Chapter 1"] });
});
test("30 days includes older sessions and groups five local dates, while today clips future time", () => {
  const start = activityDays(now, 30)[0]!.startTs;
  const old = session("old", start + 1000, start + 2000);
  const future = session("live", now - 2000, now + 60_000);
  assert.equal(recentActivity([old as Session], now).length, 0);
  assert.equal(recentActivity([old as Session], now, 30).length, 1);
  const report = readingReport([old, future, session("bad", NaN, now)], [], [], now, 30);
  assert.equal(report.groups.length, 6);
  assert.equal(report.totalMs, 3000);
  assert.equal(report.groups[0]!.totalMs, 1000);
  assert.equal(readingReport([old, future], [], [], now, 1).totalMs, 2000);
});
test("summary uses completion dates, excludes EPUB chapters and deduplicates collected words", () => {
  const articles = [
    { id: "https://example.com/a", finished: true, finishedTs: midnight },
    { id: "https://example.com/b", finished: false, finishedTs: midnight },
    { id: chapterId("ab".repeat(32), 0), finished: true, finishedTs: midnight },
    { id: "https://example.com/c", finished: true, finishedTs: midnight - 1 },
  ] as Article[];
  const words = [{ text: "Word", kind: "word", createdTs: midnight }, { text: "word", kind: "word", createdTs: midnight },
    { text: "Sentence.", kind: "sentence", createdTs: midnight }, { text: "old", kind: "word", createdTs: midnight - 1 }] as Snippet[];
  const report = readingReport([], articles, words, now, 1);
  assert.deepEqual([report.completed, report.words, report.readingDays, report.totalMs], [1, 1, 0, 0]);
});
