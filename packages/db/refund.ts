// Sending the money back (PRD 3 P0-4, C-067).
//
// What this replaces: cancelling a paid order used to push a `refund` event
// inside the cancellation's own transaction and flip `paymentState` to
// `refunded` beside it. No provider was ever called, so the refund could not
// fail, so the product had three terminal facts about money and no way to say
// the one that matters on a Friday — "we tried and it did not go through".
//
// THE SPLIT IS THE REQUIREMENT. The status change and the refund attempt are
// not one atomic write, because they are not one fact: deciding to refund is
// part of cancelling (the engine writes `refund_requested` in the transaction),
// and sending the money is what happens afterwards, outside it, where it is
// allowed to fail without taking the cancellation down with it.
//
// The idempotency key is the REQUEST EVENT'S OWN ROW ID. It is a uuid, it is
// unique because it is a primary key, and it is durable before the first
// provider call is made — so a retry after a lost response presents the same
// key and the provider, not this code, is what stops the customer being paid
// twice. A second key column with a second unique index would be a second
// thing to keep true.
import {
  deriveRefundState,
  orderBalance,
  type EventActor,
} from '@countertop/core';
import { prisma } from './index';
import { eventRow, ORDER_RECEIPT, type OrderReceipt } from './placement';

/**
 * The processor, as a function (P0-4's "the provider call").
 *
 * It RESOLVES with the provider's reference or it THROWS. One failure channel,
 * not two: a returned error object and a rejected promise are the same fact
 * wearing different clothes, and a caller that has to handle both eventually
 * handles one of them wrong. Every real SDK in this space throws.
 *
 * There is no real processor and the master PRD's Non-Goal says there will not
 * be one. What matters is that the SEAM is here and that everything on this
 * side of it — the request, the attempt, the failed state, the retry — is real.
 */
export type RefundProvider = (idempotencyKey: string, amountCents: number) => Promise<string>;

/** The mock. Always succeeds, and the reference it returns is the idempotency
 *  key it was given, which is the honest record of what was actually sent. */
export const mockRefundProvider: RefundProvider = async (idempotencyKey) =>
  `mock_${idempotencyKey}`;

export type SettleRefundResult =
  | { ok: true; amountCents: number }
  | {
      ok: false;
      reason:
        | 'order_not_found'
        | 'no_refund_requested'
        | 'already_refunded'
        | 'nothing_to_refund'
        | 'provider_failed'
        | 'raced';
      message: string;
    };

const refuse = (
  reason: Extract<SettleRefundResult, { ok: false }>['reason'],
  message: string,
): SettleRefundResult => ({ ok: false, reason, message });

/**
 * Attempt the refund this order has asked for, and record what happened.
 *
 * ONE FUNCTION, TWO CALLERS, and that is what makes the retry trustworthy: the
 * automatic attempt that follows a cancellation and the staff tap on a failed
 * one run exactly the same code with exactly the same key. A separate "retry"
 * path is a second implementation of the thing that already went wrong once.
 *
 * THE AMOUNT IS RECOMPUTED, never carried from the request. What is refundable
 * is what the restaurant is actually holding — `orderBalance`'s
 * `collectedCents`, captured minus already refunded — read from this order's
 * own log at the moment of the attempt. Two consequences, both wanted: a comp
 * or a counter payment landing between the request and the attempt cannot make
 * the figure stale, and a duplicate attempt after a success refunds ZERO
 * rather than twice, because the first refund is in the sum it reads.
 *
 * Safe to call on an order with nothing to settle. Every caller reaches it on
 * a screen or a code path that may be a few seconds behind, and "there was
 * nothing to do" is an answer rather than a failure.
 */
export async function settleRefund(
  orderId: string,
  now: Date,
  /**
   * Who tapped Retry (C-086), and NULL from the automatic path on purpose.
   *
   * `eventRow`'s comment has parked this question since C-086: the cook who
   * cancelled an order did not decide to send the money, so putting their name
   * on the refund the engine triggered would be a name on a row that person did
   * not write. A retry is different — it is somebody's deliberate tap on a
   * money control — and it is the one this product most needs a name on.
   */
  staffId?: string | null,
  /** The processor. A default parameter rather than a module, a registry or an
   *  environment variable: the db test hands in one that throws, the e2e
   *  fixture hands in the same, and nothing else in the product ever passes
   *  it. That is the whole of the dependency injection this needs. */
  provider: RefundProvider = mockRefundProvider,
): Promise<SettleRefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      totalCents: true,
      // `id` beside the two `MoneyEvent` scalars: the request row's id IS the
      // idempotency key, so the read that computes the amount is also the read
      // that finds the key.
      events: { select: { id: true, kind: true, amountCents: true } },
    },
  });
  if (!order) return refuse('order_not_found', 'That order could not be found.');

  const state = deriveRefundState(order.events);
  if (state === null) return refuse('no_refund_requested', 'Nothing was refunded on this order.');
  if (state === 'succeeded') return refuse('already_refunded', 'This refund has already gone through.');

  // Non-null by construction: `deriveRefundState` returns non-null only when
  // one of these exists, and `failed` implies the request that preceded it.
  const request = order.events.find((event) => event.kind === 'refund_requested')!;

  const amountCents = orderBalance(order).collectedCents;
  if (amountCents <= 0) {
    return refuse('nothing_to_refund', 'There is no money on this order to send back.');
  }

  // WHO the log says did it. A retry is a person's tap; the attempt that
  // follows a cancellation is not, and passes null above to say so.
  const actor: EventActor = staffId ? 'staff' : 'system';

  let providerRef: string;
  try {
    // OUTSIDE the transaction, and outside every transaction — this is a
    // network call, and a network call inside a database transaction holds a
    // row lock for as long as somebody else's server feels like taking.
    providerRef = await provider(request.id, amountCents);
  } catch (error) {
    // The one place this product writes down that it tried and failed. The
    // provider's own words go in `detail.note`, where `readNote` already lifts
    // them onto the receipt — no new channel, no new column, and the message
    // is rendered by React, which escapes it.
    await prisma.orderEvent.create({
      data: {
        orderId,
        ...eventRow(
          {
            at: now,
            kind: 'refund_failed',
            fromStatus: null,
            toStatus: null,
            actor,
            reason: null,
            detail: { note: describeFailure(error) },
          },
          staffId,
        ),
      },
    });
    return refuse('provider_failed', 'The refund did not go through. It is on the exceptions list.');
  }

  // The column and its event in ONE transaction, guarded on the state the
  // amount was computed against — `collectOrderPayment`'s compare-and-set,
  // applied to the other direction. Two people tapping Retry at once present
  // the same key, so the provider refunds once; this is what stops the log
  // recording it twice.
  const settled = await prisma.$transaction(async (tx) => {
    const guard = await tx.order.updateMany({
      where: { id: orderId, paymentState: 'paid' },
      data: { paymentState: 'refunded' },
    });
    if (guard.count === 0) return false;
    await tx.orderEvent.create({
      data: {
        orderId,
        ...eventRow(
          {
            at: now,
            kind: 'refund',
            // Null on both, like `payment` and `adjustment`: money marks the
            // timeline, it does not divide it. The old draft carried the
            // cancellation's statuses, which `time-in-state.ts` has called the
            // odd one out since C-085 and named PRD 3 as the place to settle.
            fromStatus: null,
            toStatus: null,
            actor,
            reason: null,
            amountCents,
            providerRef,
            detail: { amountCents, provider: 'mock' },
          },
          staffId,
        ),
      },
    });
    return true;
  });

  return settled
    ? { ok: true, amountCents }
    : refuse('raced', 'Someone else settled this refund. Reload the receipt.');
}

/** A message from something thrown across a boundary this code does not own.
 *  A provider may reject with anything at all, and `String(undefined)` on a
 *  receipt is worse than saying so. */
const describeFailure = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() === '' ? 'The provider gave no reason.' : message.slice(0, 140);
};

/** A lookup, like the history search's cap and for the same reason: this list
 *  should be short, and if it is ever long the cap is not what is wrong. */
const REFUND_EXCEPTION_LIMIT = 50;

/**
 * Refunds the restaurant owes and has not sent (P0-4's exceptions list).
 *
 * ASKED OF THE LOG, not of a column. There is no `refundState` cache here on
 * purpose: `paymentState` earned one because eleven screens read it on every
 * render, and this list is read by one screen and is bounded by the number of
 * cancelled paid orders, which is a handful a week. A cache would be a third
 * thing that can disagree with the events for no query it makes cheaper.
 *
 * `requested` is on this list as well as `failed`, which `refundNeedsAttention`
 * says in one place for both the query and the screen: a request whose attempt
 * never came back — the process died mid-call — is money owed with nothing
 * chasing it, and it is invisible in exactly the way a failure is not.
 */
export function loadRefundExceptions(): Promise<OrderReceipt[]> {
  return prisma.order.findMany({
    where: {
      events: { some: { kind: 'refund_requested' } },
      NOT: { events: { some: { kind: 'refund' } } },
    },
    orderBy: { placedAt: 'desc' },
    take: REFUND_EXCEPTION_LIMIT,
    ...ORDER_RECEIPT,
  });
}
