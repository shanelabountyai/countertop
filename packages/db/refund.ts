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
// WHAT C-071 CHANGED. This file was written when the only thing that could ask
// for a refund was cancelling a paid order, so there was exactly one request
// per order and this function could take "the refund" as a definite article:
// it found the order's single request, and it sent back everything the
// restaurant was holding because nothing else had a claim on it. A deliberate
// refund breaks both halves. There can now be several requests over an order's
// life, each for part of the balance, so an attempt names the request it is
// for — and the amount comes from that request when it has one.
//
// STILL ONE ATTEMPT. There are now three callers — the automatic one after a
// cancellation, the staff retry from the receipt, and a deliberate refund —
// and the reason they all land here is the reason C-067 gave for the first
// two: a path that differs from the path that failed is a second thing to get
// right, and the one that gets exercised least.
//
// The idempotency key is the REQUEST EVENT'S OWN ROW ID. It is a uuid, it is
// unique because it is a primary key, and it is durable before the first
// provider call is made — so a retry after a lost response presents the same
// key and the provider, not this code, is what stops the customer being paid
// twice. A second key column with a second unique index would be a second
// thing to keep true.
import {
  derivePaymentState,
  formatBoundCents,
  orderBalance,
  pendingRefunds,
  refundRequestEvent,
  type EventActor,
  type PendingRefund,
  type RefundRefusalReason,
  type RefundRequestInput,
} from '@countertop/core';
import { Prisma, prisma } from './index';
import { mockPaymentProvider, type PaymentProvider } from './provider';
import { eventRow, ORDER_RECEIPT, type OrderReceipt } from './placement';

export type SettleRefundReason =
  | 'order_not_found'
  | 'no_refund_requested'
  | 'already_refunded'
  | 'nothing_to_refund'
  /** The ask is bigger than what the restaurant is still holding (C-071).
   *
   *  REFUSED, NEVER CLAMPED — the discipline `adjustmentEvent` set and the one
   *  `refundRequestEvent` repeats. This is its second sighting, at the attempt
   *  rather than at the ask, and it is not redundancy: a comp or a counter
   *  payment can land in the seconds between somebody typing $10 and the
   *  provider being called, and what leaves has to be bounded by what is held
   *  THEN. Quietly sending the smaller figure would tell the counter a $10
   *  refund went out when $6 did. */
  | 'refund_exceeds_balance'
  | 'provider_failed'
  | 'raced';

export type SettleRefundResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: SettleRefundReason; message: string };

const refuse = (reason: SettleRefundReason, message: string): SettleRefundResult => ({
  ok: false,
  reason,
  message,
});

/**
 * Attempt a refund this order has asked for, and record what happened.
 *
 * ONE FUNCTION, THREE CALLERS, and that is what makes the retry trustworthy:
 * the automatic attempt after a cancellation, the staff tap on a failed one,
 * and a deliberate refund all run exactly the same code with exactly the same
 * key. A separate "retry" path is a second implementation of the thing that
 * already went wrong once, and a separate "issue a refund" path would be a
 * second implementation of the thing money leaves through.
 *
 * THE AMOUNT IS BOUNDED BY WHAT IS HELD, always, and comes from the request
 * only when the request named one. `orderBalance`'s `collectedCents` —
 * captured minus already refunded — is read from this order's own log at the
 * moment of the attempt, and it is the ceiling in both cases:
 *
 *   * A request with NO amount is the cancellation's, and it means "all of
 *     it". It cannot know what will be held when the attempt runs, so it
 *     declines to say and this reads the balance instead.
 *   * A request WITH an amount is somebody's deliberate ask. It is refused
 *     against the ceiling, never trimmed to fit it (C-071).
 *
 * Two consequences of recomputing, both wanted: a comp or a counter payment
 * landing between the request and the attempt cannot make the figure stale,
 * and an attempt against an already-settled request never reaches the provider
 * at all — the unique index behind the link is what says the request is spent.
 *
 * Safe to call on an order with nothing to settle. Every caller reaches it on
 * a screen or a code path that may be a few seconds behind, and "there was
 * nothing to do" is an answer rather than a failure.
 */
export async function settleRefund(
  orderId: string,
  now: Date,
  /**
   * Who tapped Send, and NULL from the automatic path on purpose.
   *
   * The cook who cancelled an order did not decide to send the money, so
   * putting their name on the refund the engine triggered would be a name on a
   * row that person did not write. A retry and a deliberate refund are
   * different — they are somebody's tap on a money control — and they are the
   * rows this product most needs a name on.
   */
  staffId?: string | null,
  /** The processor. A default parameter rather than a module, a registry or an
   *  environment variable: the db test hands in one that throws, the e2e
   *  fixture hands in the same, and nothing else in the product ever passes
   *  it. That is the whole of the dependency injection this needs. */
  provider: PaymentProvider = mockPaymentProvider,
  /**
   * WHICH request to settle, where the caller knows (C-071).
   *
   * Omitted from the automatic path and from the retry button, because both
   * of those mean "the one thing this order is waiting on" and
   * `refundRequestEvent` refuses to let a second ask stack on top of an
   * unsettled one — so there is at most one, and naming it would be the caller
   * repeating what the log already says.
   *
   * Passed by `requestRefund`, which has just written the request and must
   * settle THAT one: reading it back out of the log would work today and would
   * be a race the moment two people refund the same order at once.
   */
  requestId?: string,
): Promise<SettleRefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      totalCents: true,
      // `id` and `refundRequestId` beside the two `MoneyEvent` scalars: this
      // is the `RefundEvent` shape, and it is the read that finds the request
      // as well as the read that computes the balance.
      events: {
        select: { id: true, kind: true, amountCents: true, refundRequestId: true },
      },
    },
  });
  if (!order) return refuse('order_not_found', 'That order could not be found.');

  const pending = pendingRefunds(order.events);
  const request: PendingRefund | undefined =
    requestId === undefined ? pending[0] : pending.find((entry) => entry.id === requestId);

  if (!request) {
    // Two different facts, and a screen five seconds behind needs to be told
    // which. Nothing was ever asked for on this order, or the thing that was
    // asked for has already gone back — and only the second one means the
    // customer has their money.
    return order.events.some((event) => event.kind === 'refund_requested')
      ? refuse('already_refunded', 'This refund has already gone through.')
      : refuse('no_refund_requested', 'Nothing was refunded on this order.');
  }

  const heldCents = orderBalance(order).collectedCents;
  if (heldCents <= 0) {
    return refuse('nothing_to_refund', 'There is no money on this order to send back.');
  }
  // Null is "all of it" — the cancellation's request. A number is somebody's
  // ask, and it is refused rather than trimmed.
  const amountCents = request.amountCents ?? heldCents;
  if (amountCents > heldCents) {
    return refuse(
      'refund_exceeds_balance',
      `This order is only holding ${formatBoundCents(heldCents)} now. Ask for the refund again.`,
    );
  }

  // WHO the log says did it. A retry and a deliberate refund are a person's
  // tap; the attempt that follows a cancellation is not, and passes null above
  // to say so.
  const actor: EventActor = staffId ? 'staff' : 'system';

  let providerRef: string;
  try {
    // OUTSIDE the transaction, and outside every transaction — this is a
    // network call, and a network call inside a database transaction holds a
    // row lock for as long as somebody else's server feels like taking.
    providerRef = await provider('refund', request.id, amountCents);
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
            // WHICH request failed (C-071). Without it a retry on one request
            // would read as a failure on every request the order has.
            refundRequestId: request.id,
            detail: { note: describeFailure(error) },
          },
          staffId,
        ),
      },
    });
    return refuse('provider_failed', 'The refund did not go through. It is on the exceptions list.');
  }

  // THE CONSTRAINT IS THE GUARD (C-071), where this used to be a compare-and-set
  // on `paymentState` going `paid` -> `refunded`. That worked only while every
  // refund was total: a partial one leaves the column at `paid`, so the guard
  // would have silently stopped guarding and two taps at the same instant
  // would have written two `refund` rows against one provider call. The unique
  // index on the link cannot be talked out of it.
  //
  // The column is written from the log rather than to a literal, for the same
  // reason: `refunded` is only true once everything captured has gone back,
  // and a $3 refund on a $34.20 order leaves it `paid`. `derivePaymentState`
  // is the one function that decides that, and it is re-read INSIDE the
  // transaction so a payment landing mid-attempt cannot leave a stale answer.
  try {
    await prisma.$transaction(async (tx) => {
      await tx.orderEvent.create({
        data: {
          orderId,
          ...eventRow(
            {
              at: now,
              kind: 'refund',
              // Null on both, like `payment` and `adjustment`: money marks the
              // timeline, it does not divide it.
              fromStatus: null,
              toStatus: null,
              actor,
              reason: null,
              amountCents,
              providerRef,
              refundRequestId: request.id,
              detail: { amountCents, provider: 'mock' },
            },
            staffId,
          ),
        },
      });
      const settled = await tx.orderEvent.findMany({
        where: { orderId },
        select: { kind: true, amountCents: true },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { paymentState: derivePaymentState(settled) },
      });
    });
  } catch (error) {
    // P2002 is the partial unique index: somebody else settled this exact
    // request while the provider was thinking. Their `refund` row is the one
    // that counts, and it carries the same key, so the customer was paid once.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return refuse('raced', 'Someone else settled this refund. Reload the receipt.');
    }
    throw error;
  }

  return { ok: true, amountCents };
}

export type RequestRefundResult =
  | { ok: true; amountCents: number }
  | { ok: false; reason: RefundRefusalReason | SettleRefundReason; message: string };

/**
 * Send money back because somebody decided to (PRD 3 P0-6, C-071).
 *
 * THE MISSING HALF OF THE MONEY STORY, and C-067 and C-068 both left it here.
 * A comp on an order that has already paid reads as a zero balance — the
 * customer owes nothing — when what is true is that the restaurant is holding
 * their money and owes it BACK. `orderBalance`'s clamp has said so in a comment
 * since C-064. Cancelling was the only way to ask for a refund, and the state
 * machine correctly refuses to cancel cooked food, so the orders where this is
 * most needed were exactly the ones it could not reach.
 *
 * TWO WRITES, NOT ONE, and the split is the same one C-067 argued for: the ask
 * and the send are not one fact. The request lands first and durably, because
 * its row id is the idempotency key the provider is handed — a key invented
 * after the call has already failed at its job. If the process dies between
 * them, the request is on the exceptions list with the retry button beside it,
 * which is precisely the failure mode that machinery was built for.
 *
 * NOT A SECOND REFUND PATH. Everything after the request is `settleRefund`:
 * the same bound, the same key, the same constraint, the same failure row.
 * The one thing this adds is the ask.
 */
export async function requestRefund(
  orderId: string,
  input: RefundRequestInput,
  now: Date,
  /** Who decided. This is the row PRD 6 P0-2 exists to put a name on — a
   *  person choosing to send a customer's money back — and unlike the
   *  cancellation's automatic attempt there is no honest reading of it as
   *  `system`. */
  staffId?: string | null,
  provider: PaymentProvider = mockPaymentProvider,
): Promise<RequestRefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      totalCents: true,
      events: {
        select: { id: true, kind: true, amountCents: true, refundRequestId: true },
      },
    },
  });
  if (!order) return { ok: false, reason: 'order_not_found', message: 'That order could not be found.' };

  // The amount is validated against the order's OWN log, re-read here — the
  // screen's idea of what is held is never an input, exactly as the cart's
  // total is never an input to placement (CLAUDE.md: the server is the price
  // authority). `refundRequestEvent` validates and builds in one call, so
  // there is no path through this module that asks for an amount nothing
  // checked.
  const asked = refundRequestEvent(order, input, now);
  if (!asked.ok) return asked;

  const request = await prisma.orderEvent.create({
    data: { orderId, ...eventRow(asked.event, staffId) },
    select: { id: true },
  });

  // OUTSIDE the write above, and after it committed. Same ordering and same
  // argument as the cancellation's: a provider call inside a transaction holds
  // a lock on somebody else's timetable, and a refund that fails must leave
  // the ask standing rather than rolling it back into nothing.
  return settleRefund(orderId, now, staffId, provider, request.id);
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
 *
 * ASKED PER REQUEST since C-071, and the old shape is now a live bug rather
 * than a simplification. It read "the order has a request AND the order has no
 * refund", which was the same question while an order could only ever have one
 * of each. With a deliberate refund it is not: an order refunded $3 in the
 * afternoon and asked for $5 back in the evening has a `refund` on it, so the
 * old predicate would drop the outstanding $5 off the exceptions list and
 * nothing anywhere would be chasing it. `refundAttempts` is the reverse of the
 * link, so the question is asked of the REQUEST — has anything settled THIS
 * one — which is the same question `pendingRefunds` asks of the same rows.
 */
export function loadRefundExceptions(): Promise<OrderReceipt[]> {
  return prisma.order.findMany({
    where: {
      events: {
        some: { kind: 'refund_requested', refundAttempts: { none: { kind: 'refund' } } },
      },
    },
    orderBy: { placedAt: 'desc' },
    take: REFUND_EXCEPTION_LIMIT,
    ...ORDER_RECEIPT,
  });
}
