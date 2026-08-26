import { describe, expect, it } from 'vitest';
import { instantMinutesAfter } from './business-day';
import { timeInState, timeInStateReport, type StatusEvent } from './time-in-state';

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
