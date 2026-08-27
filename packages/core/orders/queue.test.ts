import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES, QUEUE_STATUSES, type OrderStatus } from './state-machine';
import { formatOrderNumber } from './placement';
import {
  DEFAULT_AGING,
  elapsedMinutes,
  groupQueue,
  isLeftOver,
  matchesLookup,
  queueAging,
  undoRemainingMs,
} from './queue';

// Every instant is built with Date.UTC — the one form that provably cannot
// read the process timezone. Nothing here reads a clock: `now` is a parameter.
// Offsets are expressed as UTC FIELD arithmetic — `Date.UTC(..., 0 - minutes)`,
// which normalises — rather than as millisecond subtraction on an instant.
// `new Date(<a number>)` is banned repo-wide, and the ban is worth more than
// the convenience: `Date.UTC(...)` is the only argument form that provably
// cannot read the process timezone, so it is the only one the rule exempts.
const NOON = new Date(Date.UTC(2026, 6, 4, 19, 0, 0));
const minutesBefore = (minutes: number): Date => new Date(Date.UTC(2026, 6, 4, 19, 0 - minutes, 0));
const secondsBefore = (seconds: number): Date => new Date(Date.UTC(2026, 6, 4, 19, 0, 0 - seconds));

const order = (over: Partial<{ status: OrderStatus; placedAt: Date; statusChangedAt: Date }> = {}) => ({
  status: 'preparing' as OrderStatus,
  placedAt: minutesBefore(5),
  statusChangedAt: minutesBefore(1),
  ...over,
});

describe('elapsed minutes', () => {
  it('floors to whole minutes', () => {
    expect(elapsedMinutes(secondsBefore(119), NOON)).toBe(1);
    expect(elapsedMinutes(secondsBefore(120), NOON)).toBe(2);
  });

  it('never goes negative — a second of clock skew is not "-1 min"', () => {
    expect(elapsedMinutes(secondsBefore(-30), NOON)).toBe(0);
  });
});

describe('queue aging (P0-4)', () => {
  it('counts the wait from PLACEMENT, not from the current status', () => {
    // Accepted a moment ago, placed twenty minutes ago. The customer has been
    // waiting twenty minutes; a clock that reset on the cook's tap would say
    // one, which is the number that hides a slow ticket.
    const aging = queueAging(order({ status: 'accepted', placedAt: minutesBefore(20), statusChangedAt: minutesBefore(1) }), NOON);
    expect(aging.waitingMinutes).toBe(20);
    expect(aging.overdue).toBe(true);
  });

  it('flags AT the threshold, not a minute after it', () => {
    expect(queueAging(order({ placedAt: minutesBefore(14) }), NOON).overdue).toBe(false);
    expect(queueAging(order({ placedAt: minutesBefore(15) }), NOON).overdue).toBe(true);
    expect(DEFAULT_AGING.queueFlagMinutes).toBe(15);
  });

  it('takes the threshold as configuration', () => {
    const strict = { ...DEFAULT_AGING, queueFlagMinutes: 5 };
    expect(queueAging(order({ placedAt: minutesBefore(6) }), NOON, strict).overdue).toBe(true);
  });

  it('escalates a ready order through the three no-show marks', () => {
    const ready = (minutes: number) =>
      queueAging(order({ status: 'ready', placedAt: minutesBefore(60), statusChangedAt: minutesBefore(minutes) }), NOON);

    expect(ready(9).noShowLevel).toBe(0);
    expect(ready(10).noShowLevel).toBe(1);
    expect(ready(20).noShowLevel).toBe(2);
    expect(ready(45).noShowLevel).toBe(3);
    expect(ready(12).readyMinutes).toBe(12);
  });

  it('has no no-show clock outside `ready` — the shelf is the only place food goes cold', () => {
    const preparing = queueAging(order({ status: 'preparing', statusChangedAt: minutesBefore(40) }), NOON);
    expect(preparing.readyMinutes).toBeNull();
    expect(preparing.noShowLevel).toBe(0);
  });
});

describe('grouping (P0-4)', () => {
  it('gives every queue status a group, in the status module\'s order', () => {
    expect(groupQueue([]).map((group) => group.status)).toEqual([...QUEUE_STATUSES]);
  });

  it('keeps empty groups — a section vanishing mid-tap moves the screen', () => {
    const groups = groupQueue([order({ status: 'placed' })]);
    expect(groups.find((group) => group.status === 'ready')?.orders).toEqual([]);
  });

  it('orders each group oldest first', () => {
    const old = order({ status: 'placed', placedAt: minutesBefore(30) });
    const recent = order({ status: 'placed', placedAt: minutesBefore(2) });
    const groups = groupQueue([recent, old]);
    expect(groups[0]?.orders).toEqual([old, recent]);
  });

  it('leaves terminal orders off the screen entirely', () => {
    const groups = groupQueue([order({ status: 'picked_up' }), order({ status: 'cancelled' })]);
    expect(groups.every((group) => group.orders.length === 0)).toBe(true);
  });
});

describe('the walk-up lookup (P0-11)', () => {
  const dana = { seq: 47, customerName: 'Dana Reyes' };

  it('accepts the number in the shape the screen prints it', () => {
    expect(formatOrderNumber(47)).toBe('#047');
    for (const query of ['#047', '047', '47']) {
      expect(matchesLookup(dana, query)).toBe(true);
    }
  });

  it('matches a partial name, in any case', () => {
    expect(matchesLookup(dana, 'rey')).toBe(true);
    expect(matchesLookup(dana, 'DANA')).toBe(true);
    expect(matchesLookup(dana, 'Morgan')).toBe(false);
  });

  it('does not match a different order that merely starts with the digits', () => {
    expect(matchesLookup({ seq: 470, customerName: 'Sam' }, '47')).toBe(false);
  });

  it('matches everything when the box is empty', () => {
    expect(matchesLookup(dana, '')).toBe(true);
    expect(matchesLookup(dana, '   ')).toBe(true);
  });
});

describe('the five-second undo (P0-4)', () => {
  const advanceTo = (to: OrderStatus, from: OrderStatus, at: Date) =>
    ({ kind: 'transition', fromStatus: from, toStatus: to, at }) as const;

  it('runs from the event, so a re-render or a reload cannot lose it', () => {
    const event = advanceTo('preparing', 'accepted', secondsBefore(2));
    expect(undoRemainingMs('preparing', event, NOON)).toBe(3_000);
  });

  it('expires', () => {
    expect(undoRemainingMs('preparing', advanceTo('preparing', 'accepted', secondsBefore(5)), NOON)).toBe(0);
    expect(undoRemainingMs('preparing', advanceTo('preparing', 'accepted', secondsBefore(60)), NOON)).toBe(0);
  });

  it('is not offered after a REVERT — undo means back, not further back', () => {
    const revert = { kind: 'revert', fromStatus: 'ready', toStatus: 'preparing', at: secondsBefore(1) } as const;
    expect(undoRemainingMs('preparing', revert, NOON)).toBe(0);
  });

  it('is not offered on a freshly placed order, whose event reads from-nothing', () => {
    const placement = { kind: 'transition', fromStatus: null, toStatus: 'placed', at: secondsBefore(1) } as const;
    expect(undoRemainingMs('placed', placement, NOON)).toBe(0);
  });

  it('is not offered when the last event does not explain the current status', () => {
    // The card advanced again in the meantime: the event names a move that
    // ended somewhere else.
    expect(undoRemainingMs('ready', advanceTo('preparing', 'accepted', secondsBefore(1)), NOON)).toBe(0);
    expect(undoRemainingMs('preparing', undefined, NOON)).toBe(0);
  });
});

describe('left over from an earlier service (P1-6)', () => {
  const TODAY = '2026-07-04';
  const left = (over: Partial<{ status: OrderStatus; businessDay: string }> = {}) => ({
    status: 'preparing' as OrderStatus,
    businessDay: '2026-07-03',
    ...over,
  });

  it('flags every queue status from an earlier day', () => {
    for (const status of QUEUE_STATUSES) {
      expect(isLeftOver(left({ status }), TODAY), status).toBe(true);
    }
  });

  it('leaves today alone', () => {
    for (const status of QUEUE_STATUSES) {
      expect(isLeftOver(left({ status, businessDay: TODAY }), TODAY), status).toBe(false);
    }
  });

  it('ignores terminal orders — history is not a chore', () => {
    for (const status of ORDER_STATUSES.filter((s) => !QUEUE_STATUSES.includes(s))) {
      expect(isLeftOver(left({ status }), TODAY), status).toBe(false);
    }
  });

  it('compares days as strings, and that ordering holds across the boundaries', () => {
    // The month and year rollovers are where a lexicographic shortcut would
    // fail if the format were not zero-padded. It is, so they do not.
    expect(isLeftOver(left({ businessDay: '2026-06-30' }), '2026-07-01')).toBe(true);
    expect(isLeftOver(left({ businessDay: '2025-12-31' }), '2026-01-01')).toBe(true);
    expect(isLeftOver(left({ businessDay: '2026-01-01' }), '2025-12-31')).toBe(false);
  });

  it('does not flag a day in the future — a clock that went backwards is not a chore', () => {
    expect(isLeftOver(left({ businessDay: '2026-07-05' }), TODAY)).toBe(false);
  });
});
