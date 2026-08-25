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
