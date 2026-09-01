// Collecting money at the counter (P1-8, and PRD 6 P0-3's event).
//
// This used to live inline in the kitchen's server action, which is why it had
// no test of its own and why the `ponytail:` comment there could go on naming
// the missing event for two items. It is here now for the reason every other
// write is: a column and its event have to move in ONE transaction, and that
// is a thing only a database module can promise.
import { canCollectPayment, paymentEvent } from '@countertop/core';
import { prisma } from './index';
import { eventRow } from './placement';

export type CollectPaymentResult = { ok: true } | { ok: false; message: string };

/**
 * Take the money owed on one order, and record that it was taken.
 *
 * The guard is `canCollectPayment` — the status module's, not a local
 * `paymentState === 'unpaid'` — because `unpaid` on a cancelled or abandoned
 * order is a completed fact rather than a debt, and collecting there would
 * book revenue against exactly the orders the no-show rate counts (C-048).
 */
export async function collectOrderPayment(
  orderId: string,
  now: Date,
): Promise<CollectPaymentResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true, paymentState: true, totalCents: true },
  });
  if (!order) return { ok: false, message: 'That order could not be found.' };
  if (!canCollectPayment(order.status, order.paymentState)) {
    return {
      ok: false,
      message:
        order.paymentState === 'unpaid'
          ? 'Nobody took this order, so there is nothing to collect on it.'
          : 'This order is already settled.',
    };
  }

  // The column and its event in ONE transaction, and the event ONLY if the
  // column actually moved. Two people tapping Collect at once is the ordinary
  // case at a counter, and it is one payment — `updateMany` matching zero rows
  // is that check, the same compare-and-set the queue's transitions use. A
  // second event here would be a second payment in every report that ever
  // reads the log.
  const collected = await prisma.$transaction(async (tx) => {
    const guard = await tx.order.updateMany({
      where: { id: orderId, paymentState: 'unpaid' },
      data: { paymentState: 'paid' },
    });
    if (guard.count === 0) return false;
    await tx.orderEvent.create({
      data: { orderId, ...eventRow(paymentEvent(now, order.totalCents, 'counter')) },
    });
    return true;
  });

  return collected ? { ok: true } : { ok: false, message: 'This order is already settled.' };
}
