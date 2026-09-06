// Sending money back on purpose (PRD 3 P0-6, C-071).
//
// What was missing. Until this item the ONLY thing that could ask for a refund
// was cancelling a paid order, so the request was a by-product of a status
// change and there was exactly one of them per order. Everything downstream
// took that as an assumption: `deriveRefundState` said "where did the refund
// get to" about the ORDER, and `settleRefund` sent back everything the
// restaurant was holding because there was never a second claim on it.
//
// That left the money story with a hole the shape of a Friday. A comp on an
// order that has already paid reads as a zero balance — the customer owes
// nothing — when what is actually true is that the restaurant is holding
// $13.75 of their money and owes it BACK. `orderBalance`'s clamp has said so
// in a comment since C-064: "a refund the product cannot yet issue is C-067's
// problem". C-067 built the attempt; this builds the ask.
//
// THREE THINGS, and they are the same three the adjustment needed: a FORM (an
// amount in cents), a BOUND (what is actually held, recomputed at the attempt
// rather than frozen at the request), and its OWN REFUSAL over that bound —
// refused, never clamped, exactly as `adjustmentEvent` refuses.
//
// PURE, like everything else in this package. It takes the order's own money
// and returns an event to append; it reads no clock and no database.
import { MAX_CANCEL_NOTE_LENGTH, type OrderEventDraft } from './state-machine';
import { formatBoundCents, orderBalance, type MoneyEvent, type OrderMoney } from './payment';
import { isStaffAdjustmentReason, type AdjustmentReason } from './adjustment';

/**
 * Enough of a refund event to place it against its request.
 *
 * `MoneyEvent` plus the two columns that turn a flat log into a set of claims:
 * the row's own id — which IS the idempotency key, so a request is identified
 * by the same value the provider is given — and the link an attempt carries
 * back to the request it was made against.
 *
 * A database row satisfies it structurally, like every other input here.
 */
export type RefundEvent = MoneyEvent & {
  id: string;
  refundRequestId: string | null;
};

/** A refund the restaurant has asked for and not yet sent. */
export type PendingRefund = {
  /** The request row's id. The idempotency key, and what a retry names. */
  id: string;
  /**
   * What was asked for, or NULL for "everything the restaurant is holding".
   *
   * Null is what cancelling a paid order writes, and it is not laziness: the
   * cancellation cannot know what will be held at the moment of the attempt —
   * a comp or a counter payment can land in between — so it declines to say,
   * and `settleRefund` reads the balance instead. A deliberate refund is the
   * opposite case: somebody typed a number and that number is the ask.
   */
  amountCents: number | null;
  /** An attempt was made against this request and the provider refused it. */
  failed: boolean;
};

/**
 * Every refund asked for on this order that has not gone back yet.
 *
 * THE ONE ANSWER to "does this order owe money", and it replaced
 * `deriveRefundState` because that function answered it about the order rather
 * than about each request. Its own comment named this: *"ONE REFUND PER ORDER
 * is the assumption underneath... a partial refund would need the attempts
 * linked to their requests; it does not exist, and this function is where that
 * would be noticed."* This is where it was noticed.
 *
 * BY LINKAGE AND NOT BY ORDERING, which is what keeps the old function's best
 * property. `deriveRefundState` worked by precedence precisely because "last"
 * needs an ordering the receipt's select does not impose, and because a retry
 * succeeding in the same millisecond as its request shares an instant with it
 * — which every test with a frozen `now` does by construction. A set
 * membership test has no ties to break.
 *
 * Four readers, one answer: the staff receipt's panel, the customer's
 * "refund pending" line, the exceptions list, and the guard below that refuses
 * to stack a second ask on top of an unsettled one.
 */
export function pendingRefunds(events: readonly RefundEvent[]): PendingRefund[] {
  const linked = (kind: 'refund' | 'refund_failed'): Set<string | null> =>
    new Set(events.filter((event) => event.kind === kind).map((event) => event.refundRequestId));

  const settled = linked('refund');
  const failed = linked('refund_failed');

  return events
    .filter((event) => event.kind === 'refund_requested' && !settled.has(event.id))
    .map((event) => ({
      id: event.id,
      amountCents: event.amountCents,
      failed: failed.has(event.id),
    }));
}

/** Anything owed and unsent — the exceptions list's own predicate, so the
 *  screen and the query cannot disagree about what counts as needing a person.
 *  A request whose attempt never came back is on this side as well as a failed
 *  one: it is money owed with nothing chasing it, which is what a crash
 *  mid-call leaves behind, and it is invisible in the way a failure is not. */
export const refundNeedsAttention = (events: readonly RefundEvent[]): boolean =>
  pendingRefunds(events).length > 0;

export type RefundRefusalReason =
  | 'refund_amount_invalid'
  | 'refund_exceeds_balance'
  | 'nothing_to_refund'
  | 'refund_already_pending'
  | 'unknown_refund_reason'
  | 'refund_note_required'
  | 'refund_note_too_long';

export type RefundRequestInput = {
  /** Cents. Always the client's, always checked — unlike a comp, there is no
   *  "the whole thing" reading of a refund that the server could derive: the
   *  counter decides how much of what is held goes back. */
  amountCents: number;
  reason: AdjustmentReason;
  note?: string;
};

export type RefundRequestResult =
  | { ok: true; event: OrderEventDraft; amountCents: number }
  | { ok: false; reason: RefundRefusalReason; message: string };

/** Enough of an order to refund it: its money, and the events the balance and
 *  the pending set are both read from. */
export type RefundableOrder = OrderMoney & { events: readonly RefundEvent[] };

/**
 * How much of this order could be sent back right now.
 *
 * `collectedCents` — captured minus already refunded — and nothing else. It is
 * cumulative by construction rather than by a second subtraction: a settled
 * refund is inside the sum, so two $5 refunds against $10 held leave the third
 * one nothing to take. That is the same property `adjustableRemainingCents`
 * had to build explicitly, and the reason the bound here is one function call.
 *
 * Two readers, deliberately, like the adjustment's: the validation below, and
 * the screen, which needs the same number to decide whether to offer the
 * control at all and what maximum to show.
 */
export const refundableCents = (order: OrderMoney): number => orderBalance(order).collectedCents;

/**
 * Validate a deliberate refund and produce the request to append, or refuse it.
 *
 * ONE FUNCTION for both halves, exactly as `adjustmentEvent` is: there is no
 * way to hand a caller a validated amount and let them build the event
 * themselves, so there is no path that writes an amount nothing checked. The
 * server-is-the-price-authority rule, applied to money going the other way.
 *
 * Out of range is REFUSED, never clamped — the discipline `adjustmentEvent`
 * set and the reason it set it: a clamp turns "refund $50 of this $13.75
 * order" into a legal $13.75 refund and tells nobody a wrong number was typed.
 * On money leaving the till that is worse, not better.
 *
 * ONE PENDING REQUEST AT A TIME. Two unsettled asks against the same balance
 * are two claims on money that can only be sent once, and the second one would
 * be refused at the attempt anyway — after a provider call, on a screen nobody
 * is watching. Refusing it here says so where somebody can act on it, and it
 * is also what keeps `pendingRefunds` legible on the receipt: a stack of
 * competing asks is not a thing an operator can reason about at the pass.
 *
 * THE BOUND IS CHECKED TWICE and that is not redundancy. This is the check a
 * person sees; `settleRefund` re-reads the balance at the moment of the
 * attempt, because a comp or a counter payment can land in the seconds between
 * the ask and the send, and the amount that leaves has to be bounded by what
 * is held THEN.
 */
export function refundRequestEvent(
  order: RefundableOrder,
  input: RefundRequestInput,
  now: Date,
): RefundRequestResult {
  // The staff-pickable set, asked as a question — the same guard the
  // adjustment form uses, so `loyalty_reward` cannot arrive here either.
  if (!isStaffAdjustmentReason(input.reason)) {
    return refuse('unknown_refund_reason', `"${input.reason}" is not a refund reason.`);
  }
  if (input.reason === 'other' && !input.note?.trim()) {
    return refuse('refund_note_required', 'Say what happened.');
  }
  // The same cap every other free-text note about an order uses. A second
  // constant holding the same 140 would be a second thing to keep level.
  if ((input.note?.length ?? 0) > MAX_CANCEL_NOTE_LENGTH) {
    return refuse('refund_note_too_long', `Keep the note to ${MAX_CANCEL_NOTE_LENGTH} characters.`);
  }
  if (pendingRefunds(order.events).length > 0) {
    return refuse(
      'refund_already_pending',
      'A refund on this order has already been asked for and not sent. Settle that one first.',
    );
  }

  const heldCents = refundableCents(order);
  if (heldCents === 0) {
    return refuse('nothing_to_refund', 'There is no money on this order to send back.');
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return refuse('refund_amount_invalid', 'A refund is a whole number of cents above zero.');
  }
  if (input.amountCents > heldCents) {
    return refuse(
      'refund_exceeds_balance',
      `That is more than the ${formatBoundCents(heldCents)} this order is holding.`,
    );
  }

  return {
    ok: true,
    amountCents: input.amountCents,
    event: {
      at: now,
      kind: 'refund_requested',
      // Not a status change. Money marks the timeline, it does not divide it —
      // the same nulls `payment`, `adjustment` and the cancellation's own
      // request carry, so the time-in-state tally steps over all of them.
      fromStatus: null,
      toStatus: null,
      // Somebody decided. The cancellation's request is `system` because the
      // engine wrote it; this one is a person's tap on a money control, and it
      // is the row this product most needs a name on.
      actor: 'staff',
      reason: input.reason,
      // THE ASK, frozen — and the one place a refund amount is frozen at all.
      // The cancellation's request carries null because it cannot know what
      // will be held later; this one is a number a person typed, and changing
      // it between the ask and the send would be the product deciding how much
      // of somebody's money to return. `settleRefund` may refuse it against
      // the balance at the attempt. It may never revise it.
      amountCents: input.amountCents,
      ...(input.note?.trim() ? { detail: { note: input.note.trim() } } : {}),
    },
  };
}

const refuse = (reason: RefundRefusalReason, message: string): RefundRequestResult => ({
  ok: false,
  reason,
  message,
});
