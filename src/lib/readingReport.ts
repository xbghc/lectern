import type { Article, Snippet } from "../types.ts";
import { activityDays, type ActivitySession } from "./activity.ts";
import { parseChapterId } from "../books/types.ts";

export type ReportRange = 1 | 7 | 30;
export interface ReportGroup {
  startTs: number; endTs: number; totalMs: number; articleMs: number; bookMs: number;
  titles: { articles: string[]; books: string[] };
}
/** All ranges share local-calendar boundaries and clipped, deduplicated sessions. */
export function readingReport(sessions: readonly ActivitySession[], articles: readonly Article[], snippets: readonly Snippet[], now: number, range: ReportRange) {
  const days = activityDays(now, range);
  const start = days[0]!.startTs;
  const unique = [...new Map(sessions.map(s => [s.id, s])).values()].filter(s =>
    Number.isFinite(s.startTs) && Number.isFinite(s.endTs) && s.endTs > s.startTs && s.endTs > start && s.startTs < now);
  const size = range === 30 ? 5 : 1;
  const groups: ReportGroup[] = [];
  for (let i = 0; i < days.length; i += size) {
    const slice = days.slice(i, i + size);
    const group: ReportGroup = { startTs: slice[0]!.startTs, endTs: slice.at(-1)!.endTs, totalMs: 0, articleMs: 0, bookMs: 0, titles: { articles: [], books: [] } };
    for (const s of unique) {
      const ms = Math.max(0, Math.min(s.endTs, group.endTs, now) - Math.max(s.startTs, group.startTs));
      if (!ms) continue;
      const book = !!parseChapterId(s.articleId);
      group.totalMs += ms;
      if (book) group.bookMs += ms; else group.articleMs += ms;
      const titles = book ? group.titles.books : group.titles.articles;
      const title = s.title || (book ? "Local book" : s.url);
      if (!titles.includes(title)) titles.push(title);
    }
    groups.push(group);
  }
  const completed = articles.filter(a => !parseChapterId(a.id) && a.finished && a.finishedTs != null && a.finishedTs >= start && a.finishedTs <= now).length;
  const words = new Set(snippets.filter(s => s.kind !== "sentence" && s.createdTs >= start && s.createdTs <= now).map(s => s.text.trim().toLocaleLowerCase())).size;
  return { groups, completed, words,
    readingDays: days.filter(d => unique.some(s => Math.min(s.endTs, d.endTs, now) > Math.max(s.startTs, d.startTs))).length,
    totalMs: groups.reduce((n, g) => n + g.totalMs, 0), articleMs: groups.reduce((n, g) => n + g.articleMs, 0), bookMs: groups.reduce((n, g) => n + g.bookMs, 0) };
}
