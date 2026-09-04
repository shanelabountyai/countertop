import { describe, expect, it } from 'vitest';
import { instantMinutesAfter } from './business-day';
import { DEFAULT_AGING } from './queue';
import {
  serviceTimes,
  timeInState,
  timeInStateReport,
  type StatusEvent,
  type TicketTimeline,
} from './time-in-state';

// A frozen clock and whole minutes, so every expectation below is arithmetic
// you can do on paper — which is the point: the Success Metric is that the
// report matches a HAND tally, and a fixture computed the same way the code
// computes it would agree with a bug.
const T0 = new Date(Date.UTC(2026, 6, 14, 18, 0, 0));
const min = (m: number) => instantMinutesAfter(T0, m);
const MIN = 60_000;

const at = (m: number, toStatus: StatusEvent['toStatus']): StatusEvent => ({
  at: min(m),
  toStatus,
});

describe('timeInState', () => {
  it('spans each status from its event to the next one', () => {
    const tally = timeInState(
      [at(0, 'placed'), at(2, 'accepted'), at(5, 'preparing'), at(14, 'ready'), at(20, 'picked_up')],
      min(60),
    );

    expect(tally).toEqual({
      placed: 2 * MIN,
      accepted: 3 * MIN,
      preparing: 9 * MIN,
      ready: 6 * MIN,
      // Terminal: the order stopped, so it does not keep accruing until `now`.
      picked_up: 0,
      cancelled: 0,
      abandoned: 0,
    });
  });

  it('runs the last span of an UNFINISHED order up to now', () => {
    const tally = timeInState([at(0, 'placed'), at(3, 'accepted')], min(11));
    expect(tally.placed).toBe(3 * MIN);
    expect(tally.accepted).toBe(8 * MIN);
  });

  it('counts a status twice when a revert sent the order back through it', () => {
    // The wrong-advance case: ready at 10, undone at 11, ready again at 18.
    // `preparing` is entered twice and the log is the only thing that knows.
    const tally = timeInState(
      [
        at(0, 'placed'),
        at(1, 'accepted'),
        at(4, 'preparing'),
        at(10, 'ready'),
        at(11, 'preparing'),
        at(18, 'ready'),
        at(22, 'picked_up'),
      ],
      min(60),
    );

    expect(tally.preparing).toBe(6 * MIN + 7 * MIN);
    expect(tally.ready).toBe(1 * MIN + 4 * MIN);
  });

  it('ignores events that did not move the order', () => {
    const withNoise = timeInState(
      [at(0, 'placed'), { at: min(1), toStatus: null }, at(4, 'accepted')],
      min(4),
    );
    expect(withNoise.placed).toBe(4 * MIN);
  });

  it('sorts the events rather than trusting the order they arrive in', () => {
    const shuffled = timeInState([at(5, 'preparing'), at(0, 'placed'), at(2, 'accepted')], min(9));
    expect(shuffled).toEqual(timeInState([at(0, 'placed'), at(2, 'accepted'), at(5, 'preparing')], min(9)));
  });

  it('never subtracts time when two events share an instant', () => {
    const tally = timeInState([at(0, 'placed'), at(0, 'accepted')], min(3));
    expect(tally.placed).toBe(0);
    expect(tally.accepted).toBe(3 * MIN);
  });
});

describe('timeInStateReport', () => {
  const finished = [at(0, 'placed'), at(2, 'accepted'), at(6, 'preparing'), at(10, 'picked_up')];
  const stillOpen = [at(0, 'placed'), at(4, 'accepted')];

  it('averages over the orders that ENTERED the status, not over all of them', () => {
    const rows = timeInStateReport([finished, stillOpen], min(10));
    const row = (status: string) => rows.find((r) => r.status === status)!;

    // Two orders were `placed`: 2 min and 4 min.
    expect(row('placed')).toMatchObject({ orders: 2, totalMs: 6 * MIN, averageMs: 3 * MIN });
    // Only one reached `preparing` — 4 minutes — and the other must not halve it.
    expect(row('preparing')).toMatchObject({ orders: 1, totalMs: 4 * MIN, averageMs: 4 * MIN });
  });

  it('reports an unvisited status as unknown, not as zero', () => {
    const rows = timeInStateReport([finished], min(10));
    expect(rows.find((r) => r.status === 'cancelled')).toMatchObject({
      orders: 0,
      totalMs: 0,
      averageMs: null,
    });
  });

  it('gives every status a row, in lifecycle order', () => {
    expect(timeInStateReport([], min(0)).map((r) => r.status)).toEqual([
      'placed',
      'accepted',
      'preparing',
      'ready',
      'picked_up',
      'cancelled',
      'abandoned',
    ]);
  });
});

// P0-5 (C-056). The fixture the PRD names: twenty-four six-minute tickets and
// six thirty-one-minute ones. Hand arithmetic, so an implementation that
// agrees with the test because both do the same wrong thing has nowhere to
// hide — (24 x 6 + 6 x 31) / 30 = 11 exactly, and the six long tickets are
// the entire point of the p90 sitting beside that 11.
const MINUTES = [...Array(24).fill(6), ...Array(6).fill(31)] as number[];

/** Placed at 0, ready after `m`. One span in `placed`, which makes the
 *  time-in-state row and the ticket's own elapsed time the same number. */
const ticket = (seq: number, m: number): TicketTimeline => ({
  seq,
  businessDay: '2026-07-14',
  placedAt: min(0),
  events: [at(0, 'placed'), at(m, 'ready')],
});

const TICKETS: TicketTimeline[] = MINUTES.map((m, index) => ticket(index + 1, m));

describe('the distribution beside the average (P0-5)', () => {
  const rows = timeInStateReport(
    TICKETS.map((t) => t.events),
    min(31),
  );
  const placed = rows.find((row) => row.status === 'placed')!;

  it('averages 11 minutes and calls the p90 31', () => {
    expect(placed.orders).toBe(30);
    expect(placed.averageMs).toBe(11 * MIN);
    // Nearest-rank: ceil(0.9 x 30) = 27, and the 27th shortest is a long one.
    // An average-only screen reports "11 min" and says nothing about the six.
    expect(placed.p90Ms).toBe(31 * MIN);
    expect(placed.worstMs).toBe(31 * MIN);
  });

  it('leaves p90 and worst unknown where the average is unknown', () => {
    const cancelled = rows.find((row) => row.status === 'cancelled')!;
    expect(cancelled).toMatchObject({ orders: 0, averageMs: null, p90Ms: null, worstMs: null });
  });

  it('takes the percentile over the orders that entered, not over all of them', () => {
    // One order reached `ready` and sat there 5 minutes; twenty-nine never did.
    // Padding the sample with 29 zeroes would put the p90 at zero.
    const one = [at(0, 'placed'), at(1, 'ready')];
    const rest = Array.from({ length: 29 }, () => [at(0, 'placed')]);
    const ready = timeInStateReport([one, ...rest], min(6)).find((r) => r.status === 'ready')!;
    expect(ready).toMatchObject({ orders: 1, p90Ms: 5 * MIN, worstMs: 5 * MIN });
  });
});

describe('serviceTimes (P0-5)', () => {
  const service = serviceTimes(TICKETS);

  it('counts the tickets that ran past the queue card\'s own threshold', () => {
    expect(service.tickets).toBe(30);
    expect(service.lateAfterMinutes).toBe(DEFAULT_AGING.queueFlagMinutes);
    // Exactly the six. 6 min is under 15 and 31 is over it, so a mistake in
    // either direction moves this number.
    expect(service.ranLate).toBe(6);
  });

  it('lists the slowest tickets by number, and every one of them is a long one', () => {
    expect(service.slowest).toHaveLength(5);
    // The six 31-minute tickets are seq 25..30; the list must be drawn from
    // them and from nowhere else, and ties break on seq so it is stable.
    expect(service.slowest.map((t) => t.seq)).toEqual([25, 26, 27, 28, 29, 30].slice(0, 5));
    for (const slow of service.slowest) expect(slow.minutes).toBe(31);
    // All six ARE late; the list is capped at five, which is a screen decision
    // and not a claim that only five ran late.
    expect(service.ranLate).toBeGreaterThan(service.slowest.length);
  });

  it('counts a ticket that landed exactly ON the threshold', () => {
    // `>=`, the same way the card turns red at fifteen and not at sixteen. The
    // boundary is the only case that distinguishes the two comparisons, and
    // the 6/31 fixture above passes under either.
    const onTheMark = serviceTimes([ticket(1, DEFAULT_AGING.queueFlagMinutes)]);
    expect(onTheMark.ranLate).toBe(1);
    expect(serviceTimes([ticket(1, DEFAULT_AGING.queueFlagMinutes - 1)]).ranLate).toBe(0);
  });

  it('reads the threshold it is given, so a stricter shop counts more', () => {
    const strict = serviceTimes(TICKETS, { ...DEFAULT_AGING, queueFlagMinutes: 6 });
    expect(strict.ranLate).toBe(30);
  });

  it('does not grade a ticket that never reached ready', () => {
    const openTicket: TicketTimeline = {
      seq: 99,
      businessDay: '2026-07-14',
      placedAt: min(0),
      events: [at(0, 'placed'), at(1, 'preparing')],
    };
    const service = serviceTimes([openTicket, ticket(1, 31)]);
    expect(service.tickets).toBe(1);
    expect(service.slowest.map((t) => t.seq)).toEqual([1]);
  });

  it('takes the LAST ready, so a wrong advance that was undone does not count', () => {
    // Ready at 3 by mistake, sent back, ready again at 28. The customer waited
    // 28 minutes; the first tap was wrong and the log kept both.
    const reverted: TicketTimeline = {
      seq: 7,
      businessDay: '2026-07-14',
      placedAt: min(0),
      events: [at(0, 'placed'), at(3, 'ready'), at(4, 'preparing'), at(28, 'ready')],
    };
    expect(serviceTimes([reverted]).slowest).toEqual([
      { seq: 7, businessDay: '2026-07-14', minutes: 28 },
    ]);
  });

  it('orders ties by day and then by number, not by arrival', () => {
    const monday = { ...ticket(9, 31), businessDay: '2026-07-13' };
    const tuesday = { ...ticket(2, 31), businessDay: '2026-07-14' };
    expect(serviceTimes([tuesday, monday]).slowest.map((t) => [t.businessDay, t.seq])).toEqual([
      ['2026-07-13', 9],
      ['2026-07-14', 2],
    ]);
  });
});
