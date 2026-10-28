import type { ArticleCard, FsrsState, StoredCard, ReviewUndoResult } from '../types.ts';
import { fromFsrs, gradeFsrs, toFsrs, type GradeValue } from '../lib/review.ts';
import { localStorage } from '../sync/storage.ts';
import { serialize } from './store.ts';

interface ReviewEvent {
  id: string;
  kind: 'word' | 'article';
  cardKey: string;
  grade: GradeValue;
  ts: number;
}

/** Remove the exact rating and replay its schedule. The deletion syncs as a tombstone. */
export async function undoReview(eventId: string): Promise<ReviewUndoResult> {
  return serialize(async () => {
    const local = localStorage();
    const data = await local.get(['cards', 'articleCards', 'reviewEvents', 'reviewBases']);
    const events = (data.reviewEvents ?? []) as ReviewEvent[];
    const event = events.find(e => e.id === eventId);
    if (!event) return { ok: false, error: 'This rating is no longer available to undo.' };
    const sameCard = (e: ReviewEvent): boolean => e.kind === event.kind && e.cardKey === event.cardKey;
    if (events.filter(sameCard).at(-1)?.id !== eventId) {
      return { ok: false, error: 'This card has a newer rating. Refresh the review queue before continuing.' };
    }
    const base = (data.reviewBases as Record<string, FsrsState> | undefined)?.[`${event.kind}:${event.cardKey}`];
    if (!base || (base.lastReview !== null && event.ts <= base.lastReview)) {
      return { ok: false, error: 'This rating is already included in an imported schedule and cannot be undone.' };
    }
    const remaining = events.filter(e => e.id !== eventId);
    let schedule = toFsrs(fromFsrs(base));
    for (const e of remaining.filter(sameCard)) {
      if (base.lastReview !== null && e.ts <= base.lastReview) continue;
      schedule = gradeFsrs(schedule, e.grade, Math.max(e.ts, schedule.lastReview ?? 0));
    }
    if (event.kind === 'word') {
      const cards = (data.cards ?? []) as StoredCard[];
      const at = cards.findIndex(c => c.key === event.cardKey);
      if (at < 0) return { ok: false, error: 'This vocabulary card was removed.' };
      cards[at] = { ...cards[at]!, ...schedule };
      await local.set({ cards, reviewEvents: remaining });
      return { ok: true, kind: 'word', card: cards[at]! };
    }
    const cards = (data.articleCards ?? []) as ArticleCard[];
    const at = cards.findIndex(c => c.articleId === event.cardKey);
    if (at < 0) return { ok: false, error: 'This article review card was removed.' };
    cards[at] = { ...cards[at]!, ...schedule };
    await local.set({ articleCards: cards, reviewEvents: remaining });
    return { ok: true, kind: 'article', card: cards[at]! };
  });
}
