// Moving an order through its lifecycle (P0-4). The write path the kitchen
// queue's buttons call.
//
// The DECISION is `applyTransition`'s, in packages/core — this file only does
// the two things a database has to: refuse to write a status the order has
// already moved out of, and put the new status and its event in ONE
// transaction. A status that changed without an event is a hole in the history
// the reports read.
import {
  applyTransition,
  salesRoleOf,
  type OrderAction,
  type TransitionRefusal,
} from '@countertop/core';
import { prisma } from './index';
import { earnForOrder } from './loyalty';
import { eventRow, ORDER_RECEIPT, type OrderReceipt } from './placement';
import { mockRefundProvider, settleRefund, type RefundProvider } from './refund';

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
  /**
   * Who tapped it (C-086). Optional, and null is a legitimate answer rather
   * than a failure: the seed, the rush and every db test drive this with no
   * shift signed on, and a required argument there would mean inventing a
   * person for a script. The screens pass it; what they get stamped is
   * whoever is on shift, and nobody is a permanent, honest null.
   */
  staffId?: string | null,
  /**
   * The refund processor, for the attempt a cancelled paid order triggers
   * (PRD 3 P0-4, C-067).
   *
   * A default parameter and nothing more. The db test and the e2e fixture hand
   * in one that throws, so the failure path is exercised through THIS function
   * rather than around it; no other caller passes it.
   */
  refundProvider: RefundProvider = mockRefundProvider,
): Promise<OrderActionResult> {
  const current = await prisma.order.findUnique({
    where: { id: orderId },
    // `subtotalCents` and `customerPhone` are the earn's two inputs (PRD 7
    // P0-3) and are read here rather than re-fetched: both are snapshot
    // columns, frozen at placement, and this row is already being read.
    select: {
      status: true,
      paymentState: true,
      totalCents: true,
      subtotalCents: true,
      customerPhone: true,
    },
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

  // The engine decided whether the money goes back — it pushed a
  // `refund_requested`, and that event IS the decision (P0-4). What it is NOT
  // is the refund: `paymentState` no longer moves here, because a column
  // saying `refunded` before anybody has called a processor is the defect this
  // item exists to remove. The attempt happens below, after the commit.
  const refundRequested = decision.events.some((event) => event.kind === 'refund_requested');

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
      data: decision.events.map((draft) => ({ orderId, ...eventRow(draft, staffId) })),
    });

    // Points, on the transition INTO a sold state (PRD 7 P0-3). Derived from
    // the SALES ROLE and never from `=== 'picked_up'`, so a second sold status
    // makes the compiler find this reader — the rule the whole status module
    // exists to enforce. In the transaction with the status change on purpose:
    // a pickup that committed without its ledger row has no later moment to
    // retry from. `earnForOrder` leans on the unique index rather than on this
    // path firing once, which is what makes the revert-and-re-advance safe.
    if (salesRoleOf(decision.status) === 'sold') {
      await earnForOrder(
        tx,
        { id: orderId, customerPhone: current.customerPhone, subtotalCents: current.subtotalCents },
        now,
      );
    }

    return tx.order.findUniqueOrThrow({ where: { id: orderId }, ...ORDER_RECEIPT });
  });

  // OUTSIDE the transaction, and only once it committed (P0-4): the status
  // change and the refund attempt are not one atomic write because they are not
  // one fact. The failure mode this ordering chooses is deliberate — a refund
  // that fails leaves a cancelled order and an entry on the exceptions list,
  // where the atomic version would roll the cancellation back and leave the
  // counter looking at an order they just cancelled. C-062's argument about
  // the shelf write, on money.
  //
  // NO STAFF ID: the cook cancelled, the system sent. Retrying is the tap that
  // gets a name on it, from the receipt.
  //
  // The result is deliberately not returned to the caller. A refusal here is
  // never the cancellation's refusal — the cancellation worked — and the one
  // outcome a person has to act on is on a list built for it.
  if (order && refundRequested) await settleRefund(orderId, now, null, refundProvider);

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
