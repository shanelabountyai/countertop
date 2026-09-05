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
import { DEFAULT_AGING, elapsedMinutes, isOverdue, type AgingThresholds } from './queue';
import { isTerminal, ORDER_STATUSES, type OrderStatus } from './state-machine';

/** Enough of an `OrderEvent` row to place it on a timeline. A database row
 *  satisfies it structurally, so nothing has to map. */
export type StatusEvent = {
  at: Date;
  /**
   * Null on every event that did not move the order — `total_mismatch`,
   * `payment`, `adjustment`, `note` and all three refund kinds. They are
   * skipped: they mark the timeline, they do not divide it.
   *
   * `refund` used to be the odd one out, and C-085's comment here named PRD 3
   * as where it would be settled. C-067 settled it: the engine no longer
   * writes a refund at all — a `refund_requested` records the decision inside
   * the cancellation and the refund itself is written afterwards, outside the
   * transition, once a provider has answered. Both carry null statuses, so the
   * rule this comment describes now has no exception.
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
  /**
   * The distribution, not just its middle (P0-5).
   *
   * An average of 11 minutes hides twenty-four six-minute tickets and six
   * half-hour ones, and it is the six that a customer remembers and that a
   * staffing decision turns on. `p90Ms` is the nearest-rank ninetieth
   * percentile over the orders that ENTERED the status — the same denominator
   * the average uses, so the two numbers describe one set — and `worstMs` is
   * the single longest, which is the one an operator can go and look up.
   *
   * Null exactly when `averageMs` is: no order entered, so there is no
   * distribution rather than a flat one.
   */
  p90Ms: number | null;
  worstMs: number | null;
};

/**
 * Nearest-rank percentile: the smallest value at or above the given fraction
 * of the sample, by position.
 *
 * Nearest-rank rather than interpolated, deliberately. Every number this
 * returns is a duration some ticket actually took, so "p90 is 31 minutes"
 * names a real ticket somebody can go and find — an interpolated 28.4 names
 * nothing, and on the small samples a single service produces the
 * interpolation is invented precision.
 */
export function percentileMs(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

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
    // The per-order durations, over the orders that entered the status. The
    // average could be had from the total alone; p90 and the worst cannot —
    // they need the sample, and an order that never entered must not enter it
    // as a zero (it would drag the ninetieth percentile down by padding the
    // low end with fictions).
    const durations = tallies
      .map((tally, index) => (visited[index]!.has(status) ? tally[status] : null))
      .filter((ms): ms is number => ms !== null);
    const count = durations.length;
    const totalMs = tallies.reduce((sum, tally) => sum + tally[status], 0);
    return {
      status,
      orders: count,
      totalMs,
      averageMs: count === 0 ? null : Math.round(totalMs / count),
      p90Ms: percentileMs(durations, 0.9),
      worstMs: count === 0 ? null : Math.max(...durations),
    };
  });
}

/**
 * One ticket, as the service-time numbers need it (P0-5).
 *
 * `seq` and `businessDay` are here because the slowest-five list is something
 * an operator acts on: "#047 on the 14th" is a ticket they can go and find,
 * and "31 minutes" on its own is a number they can only feel bad about.
 */
export type TicketTimeline = {
  seq: number;
  businessDay: string;
  placedAt: Date;
  events: readonly StatusEvent[];
};

/** A ticket that took too long, said the way the queue card says it. */
export type SlowTicket = {
  seq: number;
  businessDay: string;
  minutes: number;
};

export type ServiceTimes = {
  /** Tickets that reached `ready` in the window — the denominator. */
  tickets: number;
  /** Of those, the ones past the threshold the queue card turns red at. */
  ranLate: number;
  /** Stated, not assumed: a count against an unnamed threshold is unreadable. */
  lateAfterMinutes: number;
  /** Longest first, `seq` breaking ties so the list is stable across reloads. */
  slowest: SlowTicket[];
};

/**
 * The LAST `ready`, in the one dialect the engine speaks.
 *
 * Last and not first, for `loadQuoteSamples`'s reason (C-042): an order
 * advanced by mistake and sent back was not ready the first time somebody
 * said so, and the append-only log is the only thing that still knows both
 * happened.
 *
 * This is also the TypeScript half of the pair `loadQuoteSamples` writes in
 * Prisma. The db test asserts the two select the same orders — a status
 * restated in a query language is the drift this codebase has already had to
 * come back and undo once.
 */
function readyAt(events: readonly StatusEvent[]): Date | null {
  const readies = events.filter((event) => event.toStatus === 'ready');
  if (readies.length === 0) return null;
  return readies.reduce((latest, event) => (event.at > latest.at ? event : latest)).at;
}

/**
 * How long tickets took from the counter to the shelf, and which ones ran late.
 *
 * Placed -> ready, floored to whole minutes by `elapsedMinutes` — the same
 * arithmetic the kitchen card ages a ticket by, so "18 min" on the card and
 * "18 min" here are one rule rather than two that agree today.
 *
 * A ticket that never reached `ready` is not in the sample at all. A cancelled
 * order and one still on the grill are not evidence that service was slow, in
 * exactly the way C-042 already refuses to grade them.
 */
export function serviceTimes(
  timelines: readonly TicketTimeline[],
  thresholds: AgingThresholds = DEFAULT_AGING,
  limit = 5,
): ServiceTimes {
  const finished = timelines.flatMap((ticket) => {
    const ready = readyAt(ticket.events);
    if (ready === null) return [];
    return [
      {
        seq: ticket.seq,
        businessDay: ticket.businessDay,
        minutes: elapsedMinutes(ticket.placedAt, ready),
      },
    ];
  });

  return {
    tickets: finished.length,
    ranLate: finished.filter((ticket) => isOverdue(ticket.minutes, thresholds)).length,
    lateAfterMinutes: thresholds.queueFlagMinutes,
    slowest: finished
      .slice()
      .sort(
        (a, b) =>
          b.minutes - a.minutes ||
          a.businessDay.localeCompare(b.businessDay) ||
          a.seq - b.seq,
      )
      .slice(0, limit),
  };
}
