// How long orders sat in each state (C-017, Success Metrics: "Time-in-state
// report matches hand-tallied values for the seeded rush").
//
// Derived from the APPEND-ONLY event log, never from `statusChangedAt`. That
// column holds one instant — the current status's — so it can answer "how long
// has this been ready?" and nothing else. The history is in the events, which
// is also why a revert has to be a logged row rather than a silent overwrite:
// an order that went `ready → preparing → ready` spent time in `preparing`
// twice, and only the log still knows that.
//
// Pure. `now` is a parameter, and the events arrive as data.
import { isTerminal, ORDER_STATUSES, type OrderStatus } from './state-machine';

/** Enough of an `OrderEvent` row to place it on a timeline. A database row
 *  satisfies it structurally, so nothing has to map. */
export type StatusEvent = {
  at: Date;
  /**
   * Null on events that did not move the order — `total_mismatch` and
   * `payment`. They are skipped: they mark the timeline, they do not divide
   * it.
   *
   * `refund` is the odd one out and this comment used to claim otherwise: the
   * engine gives it the `cancelled` it accompanied. That is harmless today —
   * the span it opens is zero-length because it shares an instant with the
   * transition it follows, and `visited` is a Set so the duplicate cannot
   * inflate an entry count — but it is inconsistent with the two kinds above,
   * and C-085 noticed it only by asserting the property this comment
   * promised. Left as it is rather than changed under an unrelated item;
   * PRD 3's payment rework is where the money events get settled together.
   */
  toStatus: OrderStatus | null;
};

/** Milliseconds spent in each status. Every status is a key, zeros included:
 *  "this rush never used `cancelled`" is information, and a map that omits it
 *  makes the reader guess. */
export type TimeInState = Record<OrderStatus, number>;

const emptyTally = (): TimeInState =>
  Object.fromEntries(ORDER_STATUSES.map((status) => [status, 0])) as TimeInState;

/**
 * One order's timeline.
 *
 * Each status-moving event opens a span that closes at the next one. The last
 * span runs to `now` — unless the order finished, because an order that was
 * picked up an hour ago has not been "in `picked_up`" for an hour, it is done.
 *
 * Events are sorted here rather than trusted in order: `createMany` gives no
 * ordering guarantee, and two events written in the same transaction can come
 * back either way.
 */
export function timeInState(events: readonly StatusEvent[], now: Date): TimeInState {
  const timeline = events
    .filter((event): event is StatusEvent & { toStatus: OrderStatus } => event.toStatus !== null)
    .slice()
    .sort((a, b) => a.at.getTime() - b.at.getTime());

  const tally = emptyTally();
  for (const [index, event] of timeline.entries()) {
    const next = timeline[index + 1];
    const until = next ? next.at : isTerminal(event.toStatus) ? event.at : now;
    // Never negative: a clock that went backwards between two writes must not
    // subtract time from a status.
    tally[event.toStatus] += Math.max(0, until.getTime() - event.at.getTime());
  }
  return tally;
}

export type TimeInStateRow = {
  status: OrderStatus;
  /** Orders that entered this status at all — the average's denominator. An
   *  order that never got there must not drag the mean toward zero. */
  orders: number;
  totalMs: number;
  /** `totalMs / orders`, or null when no order entered the status. Null, not
   *  0, for the same reason the no-show rate is (C-016): an average over
   *  nothing is unknown, and a screen printing "0 min" says something false. */
  averageMs: number | null;
};

export type TimeInStateReport = TimeInStateRow[];

/** The tally across a set of orders, one row per status, in lifecycle order. */
export function timeInStateReport(
  orders: readonly (readonly StatusEvent[])[],
  now: Date,
): TimeInStateReport {
  const tallies = orders.map((events) => timeInState(events, now));
  const visited = orders.map(
    (events) => new Set(events.map((event) => event.toStatus).filter((s) => s !== null)),
  );

  return ORDER_STATUSES.map((status) => {
    const count = visited.filter((statuses) => statuses.has(status)).length;
    const totalMs = tallies.reduce((sum, tally) => sum + tally[status], 0);
    return {
      status,
      orders: count,
      totalMs,
      averageMs: count === 0 ? null : Math.round(totalMs / count),
    };
  });
}
