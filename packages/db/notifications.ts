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
 *
 * AT MOST ONE PER `(orderId, kind)`, AND THE INDEX IS THE MECHANISM (C-121).
 * This wrote a row on every transition into `ready`, so a cook who advanced
 * the wrong card and undid it put the ticket through `ready` twice and the
 * customer was queued the identical message twice, minutes apart, about one
 * bag of food.
 *
 * `createMany` WITH `skipDuplicates` — `ON CONFLICT DO NOTHING` — and not a
 * `create`, and not a read-then-write. The same two sentences C-102's earn
 * makes, for the same two reasons:
 *
 *   A `create` would raise P2002 against the unique index, INSIDE the status
 *   transaction, and roll the status change back — so a cook's correct second
 *   advance would fail because of a text message. The duplicate is not an
 *   error; it is a supported operation producing nothing.
 *
 *   A check-then-write would have a window between the read and the insert,
 *   and two cooks tapping one card is the normal case on this screen, not the
 *   edge case. The constraint closes the window; this line just declines to
 *   care about it.
 *
 * Returns whether a row was actually written, because "we told them" and "we
 * had already told them" are different facts and the caller may want to log
 * which — today none does.
 */
export async function queueReadyNotification(
  tx: Prisma.TransactionClient,
  orderId: string,
  seq: number,
): Promise<boolean> {
  const written = await tx.notificationOutbox.createMany({
    data: [{ orderId, kind: 'ready', message: readyMessage(seq) }],
    skipDuplicates: true,
  });
  return written.count > 0;
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
