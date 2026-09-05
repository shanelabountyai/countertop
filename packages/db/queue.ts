// The kitchen queue read (P0-4).
//
// One query, and the statuses it asks for come from THE status module — not a
// list spelled out here. That is the whole point of `QUEUE_STATUSES`: adding a
// state changes the screen without changing this file.
import {
  MAX_SHELF_LOCATION_LENGTH,
  QUEUE_STATUSES,
  UNDOABLE_EXIT_STATUSES,
} from '@countertop/core';
import { Prisma, prisma } from './index';
import { ORDER_RECEIPT } from './placement';

/**
 * The receipt shape, plus the ONE most recent event.
 *
 * The extra include lives here rather than in `ORDER_RECEIPT` because only the
 * queue needs it: it is what tells a forward advance from a revert, which is
 * what decides whether the 5-second undo is on offer (P0-4). Placement and the
 * customer's status page keep the smaller shape.
 */
/**
 * The card's read.
 *
 * `events` used to be `take: 1` — the newest, for the undo countdown. C-064
 * needs the money events too, and one `events` key cannot be two queries, so
 * it is now every event with the five scalars BOTH readers want: `at`,
 * `kind`, `fromStatus` and `toStatus` for `undoRemainingMs`, and `amountCents`
 * for `orderBalance`. Newest first, so `events[0]` still means what it did at
 * every existing call site.
 *
 * The cost is real and small: a queue is twenty-odd orders of a handful of
 * events each, and both answers now come from one round trip rather than the
 * card needing a second query for what it is owed.
 */
export const QUEUE_ORDER = {
  include: {
    ...ORDER_RECEIPT.include,
    events: {
      orderBy: { at: 'desc' },
      select: { at: true, kind: true, fromStatus: true, toStatus: true, amountCents: true },
    },
  },
} as const satisfies Prisma.OrderDefaultArgs;

export type QueueOrder = Prisma.OrderGetPayload<typeof QUEUE_ORDER>;

/**
 * Every order the kitchen still has something to do about, oldest first.
 *
 * Returns the full snapshot — lines, options, notes — because that is what a
 * card renders (P0-11), and it renders it WITHOUT touching a menu table.
 */
export function loadQueue(): Promise<QueueOrder[]> {
  return prisma.order.findMany({
    where: { status: { in: [...QUEUE_STATUSES] } },
    orderBy: { placedAt: 'asc' },
    ...QUEUE_ORDER,
  });
}

/**
 * The server-issued polling cursor (P0-5).
 *
 * It is the TIP of the append-only event log — `<events>.<newest instant>` —
 * and NOT a position to read forward from. A poll asks "is the tip still the
 * string you gave me", so an event that commits out of timestamp order still
 * moved the tip and is still noticed on the very next poll. A `WHERE at >
 * cursor` range query has a lost-update window; comparing the tip has none.
 *
 * The count is what makes two events in the same millisecond two changes. The
 * log is append-only (the trigger refuses DELETE), so it can only grow.
 *
 * Opaque to the client, which does nothing but echo it back. That is the whole
 * contract, and it is what lets a WebSocket push the same string later (P2) —
 * the transport swaps, the logic does not.
 *
 * Ceiling: a full-table count on every poll. Fine at one restaurant's event
 * volume with a 5s interval; a second location or a shorter interval wants a
 * sequence column instead of an aggregate.
 */
export async function queueCursor(): Promise<string> {
  const tip = await prisma.orderEvent.aggregate({ _count: true, _max: { at: true } });
  return `${tip._count}.${tip._max.at?.getTime() ?? 0}`;
}

/**
 * The orders that just left the queue and may still be inside their undo
 * window (P0-4).
 *
 * A separate query rather than a wider `loadQueue`, deliberately: the queue's
 * own list is what the leftover sweep, the un-acknowledged count and the
 * groupings are all derived from, and none of them mean the same thing with
 * finished orders mixed in.
 *
 * Ordered by `statusChangedAt` and capped rather than filtered by a cutoff
 * instant, so this file does no date arithmetic at all — an order inside a
 * five-second window is necessarily among the handful most recently moved.
 * `undoRemainingMs` still decides truthfully off the newest event, because
 * only a forward advance is undoable.
 *
 * Ceiling: ten. Eleven orders finished inside the same five seconds would cost
 * the eleventh its undo, which one kitchen screen with one pair of hands
 * cannot produce.
 */
export function loadRecentlyFinished(): Promise<QueueOrder[]> {
  return prisma.order.findMany({
    where: { status: { in: [...UNDOABLE_EXIT_STATUSES] } },
    orderBy: { statusChangedAt: 'desc' },
    take: 10,
    ...QUEUE_ORDER,
  });
}

/**
 * Where the bag is (PRD 2 P0-5). THE ONE WRITER of `shelfLocation`.
 *
 * Two call sites — the tap that marks an order ready, and the edit afterwards
 * because a bag gets moved — and one function, so the normalisation rule
 * cannot end up stated twice and differently. Trim, cap, and an empty string
 * means cleared rather than a row holding `""`.
 *
 * TRUNCATED, NOT REFUSED, which is the opposite of how this repo treats a
 * money bound. The precedent is `setOrderingPaused`'s pause message, and the
 * reason is the same: this is a free-text operational label typed mid-rush,
 * the column width is the only rule there is, and a cook who gets an error
 * instead of a shelf note writes the shelf on their hand.
 *
 * `updateMany`, not `update`: a card open on a second screen naming an order
 * that has since been deleted should change nothing, not throw at a cook.
 */
export async function setShelfLocation(orderId: string, input: string): Promise<void> {
  const trimmed = input.trim();
  await prisma.order.updateMany({
    where: { id: orderId },
    data: { shelfLocation: trimmed === '' ? null : trimmed.slice(0, MAX_SHELF_LOCATION_LENGTH) },
  });
}
