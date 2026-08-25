// What the kitchen queue shows (P0-4, P0-11). Pure: no clock, no database.
//
// The groupings come from THE status module's `QUEUE_STATUSES` — this file
// does not know which statuses belong on the screen, it asks. Adding a state
// means the queue grows a section, without an edit here (CLAUDE.md, "One
// status module").
import {
  previousStatus,
  QUEUE_STATUSES,
  type OrderEventKind,
  type OrderStatus,
} from './state-machine';

/**
 * When a card starts shouting. Configurable per P0-4; these are the defaults.
 *
 * Two different clocks, deliberately:
 *   - `queueFlagMinutes` runs from PLACEMENT. It is how long the customer has
 *     been waiting, which is the number an expo is judged on, and it does not
 *     reset because a cook tapped "preparing".
 *   - `readyFlagMinutes` runs from the moment the food became READY. Cooked
 *     food going cold on a shelf is a different problem from a slow ticket,
 *     and it escalates: 10, 20, 30 minutes is a no-show taking shape.
 */
export type AgingThresholds = {
  queueFlagMinutes: number;
  readyFlagMinutes: readonly [number, number, number];
};

export const DEFAULT_AGING: AgingThresholds = {
  queueFlagMinutes: 15,
  readyFlagMinutes: [10, 20, 30],
};

/** Whole minutes, floored, never negative. A clock skewed a second into the
 *  future must read "0 min", not "-1". */
export function elapsedMinutes(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / 60_000));
}

/** Enough of an order to age it. A row, not an ORM object. */
export type AgeableOrder = {
  status: OrderStatus;
  placedAt: Date;
  /** When it entered its current status — what the `ready` clock runs from. */
  statusChangedAt: Date;
};

export type QueueAging = {
  /** Since placement. What the card shows, in every status. */
  waitingMinutes: number;
  /** Past `queueFlagMinutes`: this ticket has taken too long. */
  overdue: boolean;
  /** Minutes since the food became ready. Null in every other status. */
  readyMinutes: number | null;
  /** 0 = fresh; 1, 2, 3 as it passes the three no-show marks. */
  noShowLevel: 0 | 1 | 2 | 3;
};

export function queueAging(
  order: AgeableOrder,
  now: Date,
  thresholds: AgingThresholds = DEFAULT_AGING,
): QueueAging {
  const waitingMinutes = elapsedMinutes(order.placedAt, now);
  const readyMinutes = order.status === 'ready' ? elapsedMinutes(order.statusChangedAt, now) : null;

  // `>=`, not `>`: a threshold of 15 means "flag it at fifteen minutes". A
  // card that waits until 16 is a threshold nobody can verify against a clock
  // on the wall.
  const noShowLevel =
    readyMinutes === null
      ? 0
      : (thresholds.readyFlagMinutes.filter((mark) => readyMinutes >= mark).length as 0 | 1 | 2 | 3);

  return {
    waitingMinutes,
    overdue: waitingMinutes >= thresholds.queueFlagMinutes,
    readyMinutes,
    noShowLevel,
  };
}

export type QueueGroup<T> = { status: OrderStatus; orders: T[] };

/**
 * Group by state, oldest first within each group (P0-4).
 *
 * Every queue status gets a group, empty ones included: a section that
 * disappears when it empties makes the screen jump under someone's hand
 * mid-tap, and "no orders ready" is information.
 */
export function groupQueue<T extends { status: OrderStatus; placedAt: Date }>(
  orders: readonly T[],
): QueueGroup<T>[] {
  return QUEUE_STATUSES.map((status) => ({
    status,
    orders: orders
      .filter((order) => order.status === status)
      .sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime()),
  }));
}

/**
 * The "I'm here, where's my food" lookup (P0-11): name or order number, one
 * box. It accepts every shape `formatOrderNumber` prints — "#047", "047" and
 * "47" are the same order — because the number a cook reads off the screen is
 * the number they type into the box.
 *
 * An empty query matches everything, so the queue is not something you have to
 * clear a filter to see again.
 */
export function matchesLookup(
  order: { seq: number; customerName: string },
  query: string,
): boolean {
  const trimmed = query.trim();
  if (trimmed === '') return true;

  const digits = trimmed.replace(/^#/, '');
  // Digits alone are a number lookup AND a name lookup — a customer called
  // "47" is not a thing, but a partial number typed while the cook is still
  // typing should not fall through to matching nothing.
  if (/^\d+$/.test(digits) && Number(digits) === order.seq) return true;

  return order.customerName.toLowerCase().includes(trimmed.toLowerCase());
}

/** How long a forward advance stays undoable (P0-4). */
export const UNDO_WINDOW_MS = 5_000;

/** The order's most recent log entry — enough to tell an advance from a revert. */
export type LastOrderEvent = {
  kind: OrderEventKind;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  at: Date;
};

/**
 * Milliseconds left on the undo, or 0 when there is nothing to undo.
 *
 * Derived from the event log rather than from a client-side "I just tapped
 * advance" flag, for the same reason the new-order alert is derived from state
 * (P0-12): a card that moves between sections on the next render, or a screen
 * that gets reloaded, must not lose the undo the cook is reaching for.
 *
 * Only a FORWARD advance is undoable. Offering "undo" after a revert would
 * walk the order further back, which is not what the word means; the always-on
 * "move back" control is the explicit, logged way to do that (P0-4).
 */
export function undoRemainingMs(
  status: OrderStatus,
  lastEvent: LastOrderEvent | undefined,
  now: Date,
  windowMs: number = UNDO_WINDOW_MS,
): number {
  if (!lastEvent || lastEvent.kind !== 'transition') return 0;
  const previous = previousStatus(status);
  // A placed order has nothing behind it — and its placement event reads
  // `fromStatus: null`, which would otherwise look like a match.
  if (previous === null) return 0;
  if (lastEvent.toStatus !== status || lastEvent.fromStatus !== previous) return 0;

  return Math.max(0, windowMs - (now.getTime() - lastEvent.at.getTime()));
}
