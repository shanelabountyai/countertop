import { describe, expect, it } from 'vitest';
import { feedPage } from './feed';

const NOW = new Date(Date.UTC(2026, 8, 21, 19, 0, 0));
const secondsAgo = (s: number): Date => new Date(Date.UTC(2026, 8, 21, 19, 0, -s));
const row = (seq: number, ageSeconds: number) => ({ seq, at: secondsAgo(ageSeconds) });

describe('feedPage (PRD 6 P1-1, C-161)', () => {
  it('returns a contiguous run and the cursor to ask from next', () => {
    const page = feedPage([row(4, 1), row(5, 1), row(6, 1)], 3, NOW);
    expect(page.events.map((e) => e.seq)).toEqual([4, 5, 6]);
    expect(page.next).toBe(6);
  });

  it('stops at a young gap — 41 may still commit after 42 did', () => {
    const page = feedPage([row(40, 1), row(42, 1), row(43, 1)], 39, NOW);
    expect(page.events.map((e) => e.seq)).toEqual([40]);
    expect(page.next).toBe(40);
  });

  it('steps over an old gap — that number was rolled back and is never coming', () => {
    const page = feedPage([row(40, 30), row(42, 30), row(43, 1)], 39, NOW);
    expect(page.events.map((e) => e.seq)).toEqual([40, 42, 43]);
  });

  it('holds even the first row when it is not after + 1 and young', () => {
    expect(feedPage([row(12, 1)], 10, NOW)).toEqual({ events: [], next: 10 });
  });

  it('echoes the cursor when there is nothing new', () => {
    expect(feedPage([], 7, NOW)).toEqual({ events: [], next: 7 });
  });
});
