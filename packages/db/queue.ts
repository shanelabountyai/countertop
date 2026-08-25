// The kitchen queue read (P0-4).
//
// One query, and the statuses it asks for come from THE status module — not a
// list spelled out here. That is the whole point of `QUEUE_STATUSES`: adding a
// state changes the screen without changing this file.
import { QUEUE_STATUSES } from '@countertop/core';
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
export const QUEUE_ORDER = {
  include: {
    ...ORDER_RECEIPT.include,
    events: { orderBy: { at: 'desc' }, take: 1 },
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
