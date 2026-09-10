// P1-3: SMS-style status notifications, stubbed — the same convention as
// `mockPaymentProvider`. Nothing here calls a carrier; the outbox row is the
// visible seam a real provider swaps into later.
//
// NO PHONE ARGUMENT, NO PHONE COLUMN. The caller (`applyOrderAction`) already
// knows whether the order has one — that is the gate on whether this gets
// called at all — and the number itself is read live off `Order.customerPhone`
// wherever a row here renders, never copied. See the model's own comment in
// schema.prisma for why: a copy would be a second place "forget this
// customer" (PRD 6 P0-4) has to reach.
import { formatOrderNumber } from '@countertop/core';
import { Prisma, prisma } from './index';

/** The stub's one message. A function, not a template literal at the call
 *  site, so the wording has exactly one source once a second trigger (placed,
 *  picked up) ever wants its own. */
export const readyMessage = (seq: number): string => `${formatOrderNumber(seq)} is ready for pickup`;

/**
 * Log the stub. Called from INSIDE `applyOrderAction`'s transaction — a row
 * that says "texted" when the status change rolled back would be a message
 * about food that was never actually ready.
 */
export async function queueReadyNotification(
  tx: Prisma.TransactionClient,
  orderId: string,
  seq: number,
): Promise<void> {
  await tx.notificationOutbox.create({ data: { orderId, message: readyMessage(seq) } });
}

export type OutboxEntry = { id: string; message: string; createdAt: Date };

/** For the staff receipt (C-086's screen) — same shape as `loadOrderActivity`,
 *  a second small query rather than folded into `ORDER_RECEIPT`, because most
 *  orders never reach `ready` and most receipts have nothing here to show. */
export function listOrderNotifications(orderId: string): Promise<OutboxEntry[]> {
  return prisma.notificationOutbox.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, message: true, createdAt: true },
  });
}
