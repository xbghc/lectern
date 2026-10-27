import type { PageState, Session } from "../types.ts";

export interface ActivitySession {
  id: string;
  articleId: string;
  url: string;
  title: string;
  startTs: number;
  endTs: number;
  live?: boolean;
}
export interface ActivityDay { startTs: number; endTs: number; totalMs: number; count: number }
export interface ReadingActivity {
  days: ActivityDay[];
  today: ActivityDay;
  yesterday: ActivityDay;
  totalMs: number;
  longestMs: number;
  sessions: ActivitySession[];
}

/** Local calendar days, including DST. A midnight-spanning session contributes only its overlap. */
export function activityDays(now: number): ActivityDay[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const start = new Date(today); start.setDate(start.getDate() + i - 6);
    const end = new Date(start); end.setDate(end.getDate() + 1);
    return { startTs: start.getTime(), endTs: end.getTime(), totalMs: 0, count: 0 };
  });
}

export function readingActivity(saved: readonly ActivitySession[], now: number, page?: PageState | null): ReadingActivity {
  const days = activityDays(now);
  const unique = new Map(saved.map(s => [s.id, { ...s, endTs: Math.min(s.endTs, now) }]));
  // A session can finish while its last page snapshot is in flight. Never add it twice.
  if (page?.activeSince && page.articleId && !saved.some(s => s.articleId === page.articleId && s.startTs === page.activeSince)) {
    unique.set("current", { id: "current", articleId: page.articleId, url: page.articleId,
      title: page.title ?? "", startTs: page.activeSince, endTs: now, live: true });
  }
  const sessions = [...unique.values()].filter(s => Number.isFinite(s.startTs) && Number.isFinite(s.endTs) && s.endTs > s.startTs)
    .sort((a, b) => a.startTs - b.startTs);
  for (const day of days) for (const s of sessions) {
    const overlap = Math.min(s.endTs, day.endTs) - Math.max(s.startTs, day.startTs);
    if (overlap > 0) { day.totalMs += overlap; day.count++; }
  }
  const today = days[6]!;
  const todaySessions = sessions.filter(s => s.endTs > today.startTs && s.startTs < today.endTs)
    .map(s => ({ ...s, startTs: Math.max(s.startTs, today.startTs) }));
  return { days, today, yesterday: days[5]!, totalMs: days.reduce((n, d) => n + d.totalMs, 0),
    longestMs: Math.max(0, ...todaySessions.map(s => s.endTs - s.startTs)), sessions: todaySessions };
}

export function recentActivity(sessions: readonly Session[], now: number): ActivitySession[] {
  const start = activityDays(now)[0]!.startTs;
  return sessions.filter(s => s.endTs > start && s.startTs <= now).map(({ id, articleId, url, title, startTs, endTs }) =>
    ({ id, articleId, url, title, startTs, endTs }));
}
