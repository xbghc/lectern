import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityDays, readingActivity, type ActivitySession } from '../src/lib/activity.ts';

const now = new Date(2026, 9, 26, 12).getTime();
const midnight = new Date(2026, 9, 26).getTime();
const session = (id: string, startTs: number, endTs: number): ActivitySession => ({ id, articleId: 'https://example.com/a', url: 'https://example.com/a', title: 'Article', startTs, endTs });

test('activity uses seven local calendar days and splits sessions at midnight', () => {
  const result = readingActivity([session('overnight', midnight - 60_000, midnight + 120_000)], now);
  assert.equal(result.days.length, 7);
  assert.equal(result.today.totalMs, 120_000);
  assert.equal(result.yesterday.totalMs, 60_000);
  assert.equal(result.totalMs, 180_000);
  assert.equal(result.today.count, 1);
  assert.equal(result.longestMs, 120_000);
  assert.equal(result.sessions[0]?.startTs, midnight);
});

test('current session contributes once, and a completed session wins over a stale live snapshot', () => {
  const page = { tracked: true, articleId: 'https://example.com/a', activeSince: now - 30_000 };
  const live = readingActivity([], now, page);
  assert.equal(live.today.totalMs, 30_000);
  assert.equal(live.sessions[0]?.live, true);
  const completed = session('saved', now - 30_000, now - 5_000);
  const result = readingActivity([completed, completed], now, page);
  assert.equal(result.today.count, 1);
  assert.equal(result.today.totalMs, 25_000);
  assert.equal(result.sessions[0]?.live, undefined);
});

test('empty, invalid, future and out-of-window records do not inflate totals', () => {
  const first = activityDays(now)[0]!.startTs;
  const result = readingActivity([session('old', first - 1000, first), session('reverse', now, now - 1000),
    session('invalid', NaN, now), session('future', now + 1000, now + 2000), session('long', now - 1000, now + 1000)], now);
  assert.equal(result.today.totalMs, 1000);
  assert.equal(result.today.count, 1);
  assert.equal(readingActivity([], now).longestMs, 0);
});

test('calendar boundaries honor a daylight-saving transition', () => {
  const old = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    const date = new Date(2026, 2, 10, 12).getTime();
    const days = activityDays(date);
    const spring = days.find(d => new Date(d.startTs).getDate() === 8)!;
    assert.equal(spring.endTs - spring.startTs, 23 * 3_600_000);
    assert.ok(days.every(d => new Date(d.startTs).getHours() === 0));
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old; }
});
