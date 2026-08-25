// Moving an order through its lifecycle (P0-4). The write path the kitchen
// queue's buttons call.
//
// The DECISION is `applyTransition`'s, in packages/core — this file only does
// the two things a database has to: refuse to write a status the order has
// already moved out of, and put the new status and its event in ONE
// transaction. A status that changed without an event is a hole in the history
// the reports read.
import { applyTransition, type OrderAction, type TransitionRefusal } from '@countertop/core';
import { prisma } from './index';
import { eventRow, ORDER_RECEIPT, type OrderReceipt } from './placement';

export type OrderActionFailure =
  | { kind: 'unknown_order'; message: string }
  /** Someone else moved the card between the read and the write. */
  | { kind: 'stale_status'; message: string }
  | { kind: 'refused'; message: string; refusal: TransitionRefusal };

export type OrderActionResult =
  | { ok: true; order: OrderReceipt }
  | { ok: false; failure: OrderActionFailure };

/**
 * Apply a staff action to one order.
 *
 * Two cooks tapping the same card is the normal case, not the edge case. The
 * engine catches the second tap when it names a target (`unexpected_target`);
 * this catches it when it does not, by writing against the status that was
 * read — `updateMany` matching zero rows IS the concurrency check, with no
 * lock held across a round trip.
 */
export async function applyOrderAction(
  orderId: string,
  action: OrderAction,
  now: Date,
): Promise<OrderActionResult> {
  const current = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, paymentState: true, totalCents: true },
  });
  if (!current) {
    return {
      ok: false,
      failure: { kind: 'unknown_order', message: 'That order is no longer on the queue.' },
    };
  }

  const decision = applyTransition(current, action, now);
  if (!decision.ok) {
    return {
      ok: false,
      failure: { kind: 'refused', message: decision.refusal.message, refusal: decision.refusal },
    };
  }

  const order = await prisma.$transaction(async (tx) => {
    const guard = await tx.order.updateMany({
      where: { id: orderId, status: current.status },
      data: {
        status: decision.status,
        statusChangedAt: now,
        ...(action.kind === 'cancel' && {
          cancelReason: action.reason,
          cancelNote: action.note ?? null,
        }),
      },
    });
    if (guard.count === 0) return null;

    await tx.orderEvent.createMany({
      data: decision.events.map((draft) => ({ orderId, ...eventRow(draft) })),
    });
    return tx.order.findUniqueOrThrow({ where: { id: orderId }, ...ORDER_RECEIPT });
  });

  return order
    ? { ok: true, order }
    : {
        ok: false,
        failure: {
          kind: 'stale_status',
          message: 'Someone else moved this order. Check the queue.',
        },
      };
}
