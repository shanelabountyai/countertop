// The payment stream (PRD 3 P0-1, C-063).
//
// Decision 5 of 2026-09-01: the EVENT STREAM is the truth about money, and
// `Order.paymentState` becomes a derived cache over it. Both halves of that
// sentence matter. The enum does not go away — it is one indexed column every
// existing surface already reads, and rewriting the queue card, the receipt
// and the report to sum a log on every render would be a worse product for no
// gain. What changes is which one is allowed to be wrong: if they disagree,
// the events are right and the column is stale.
//
// PURE, like everything else here. It takes the events and returns a state; it
// reads no clock, no database and no order row — which is what lets the
// agreement test drive it over a whole seeded rush.
import type { OrderEventKind, PaymentState } from './state-machine';

/** Enough of an `OrderEvent` to sum. A database row satisfies it structurally,
 *  so nothing has to map and no shape can drift between them. */
export type MoneyEvent = {
  kind: OrderEventKind;
  /** Cents, never signed. Direction is the kind. Null on every event that did
   *  not move money, which the column's CHECK also requires. */
  amountCents: number | null;
};

const sumOf = (events: readonly MoneyEvent[], kind: OrderEventKind): number =>
  events.reduce((sum, event) => (event.kind === kind ? sum + (event.amountCents ?? 0) : sum), 0);

/**
 * What was taken, what went back, and what was written off.
 *
 * The numbers the enum is a lossy summary of, exposed because C-064's balance
 * is built from exactly these. `adjustedCents` (C-065) is the third and is a
 * different KIND of number from the other two: nothing moved. A comp is a
 * record of a decision the counter made — money the restaurant chose not to
 * ask for — which is why it reduces what is owed below and never touches what
 * was collected.
 *
 * `adjustedCents` is a NET since C-071: a reversal is a contradicting row, not
 * a delete, so a comp written on the wrong ticket is taken back by subtracting
 * it here and both rows stay in the log. Clamped at zero for the same reason
 * the balance's figures are — reversals exceeding adjustments is a data error,
 * and letting it go negative would inflate what the customer owes above the
 * total they were charged.
 */
export function paymentTotals(events: readonly MoneyEvent[]): {
  capturedCents: number;
  refundedCents: number;
  adjustedCents: number;
  authorizedCents: number;
} {
  return {
    // TWO KINDS, ONE SUM (C-069). A capture is money arriving exactly as a
    // counter payment is; what makes it its own kind is that it settles a
    // hold, and that is a fact about the log rather than about the till. Every
    // reader that wanted "what was taken" wanted both, and this is the one
    // place that has to know there are two of them — which is the whole reason
    // nothing outside this file sums the log by hand.
    capturedCents: sumOf(events, 'payment') + sumOf(events, 'capture'),
    refundedCents: sumOf(events, 'refund'),
    adjustedCents: Math.max(
      0,
      sumOf(events, 'adjustment') - sumOf(events, 'adjustment_reversed'),
    ),
    // Money the restaurant may take and has not (C-069). NOT collected and NOT
    // owed — the third thing the enum could never say, and the reason a
    // no-show costs a void rather than a refund.
    //
    // ARITHMETIC OVER AMOUNTS, not a walk over links, and that is what keeps
    // `MoneyEvent` at two scalars: a capture and a void each carry the amount
    // they settle, so the held figure is a subtraction rather than a join.
    // `heldAuthorization` does follow the links, because the WRITER has to
    // name the hold it is settling — but nothing that only needs the number
    // pays for that.
    //
    // Clamped for the reason the balance's figures are: settling more than was
    // ever held is a data error, and a negative hold would show up as money
    // owed on an order nobody owes anything on.
    authorizedCents: Math.max(
      0,
      sumOf(events, 'authorization') -
        sumOf(events, 'capture') -
        sumOf(events, 'authorization_voided'),
    ),
  };
}

/**
 * The state `Order.paymentState` should be holding, computed from the log.
 *
 * THE ENUM IS LOSSY AND THIS FUNCTION IS WHERE THAT SHOWS. A partially
 * refunded order — captured 3420, refunded 300 — is `paid` here, because
 * `paid` is the only value the enum has for it. That is not a bug in the
 * derivation, it is the reason P0-2 introduces a balance: the honest answer is
 * "3120 still ours", and no enum can say it. When the balance lands, this
 * function keeps its job (agreeing with a cache) and stops being the thing
 * anybody asks about money.
 *
 * ONE LIMITATION, stated because a test will otherwise find it and look like a
 * defect: an order paid before C-085 has a `paid` column and no `payment`
 * event, so this returns `unpaid` for it. That is the migration being honest
 * rather than the function being wrong — nothing recorded when that money
 * arrived, and inventing an event for it would be a lie about a payment. The
 * agreement test is scoped to orders written since the events existed.
 */
export function derivePaymentState(events: readonly MoneyEvent[]): PaymentState {
  // `adjustedCents` is deliberately not read here. An adjustment moves no
  // money, so a comped order that was never paid is still honestly `unpaid` —
  // the enum's job is what the till did, and the balance's job is what is
  // owed. Folding comps in would make the cache disagree with the column for
  // every order the counter ever made right, and the agreement test over the
  // seeded rush is the thing that would fail.
  const { capturedCents, refundedCents, authorizedCents } = paymentTotals(events);
  // Checked first, so a refund with no capture — which is a data error, not a
  // state — reads as `unpaid` rather than as money that went back.
  //
  // `authorized` is the fourth value, and it sits inside this branch rather
  // than above it because a capture ENDS it (C-069): once anything has been
  // taken the order is paid, and the hold that produced it is spent by
  // definition. An order with a live hold and nothing taken is the one case
  // the enum had no word for, and it used to be spelled `paid` — which told
  // the customer money had left their card before it had, and told the report
  // it had collected revenue it was only holding a promise of.
  if (capturedCents === 0) return authorizedCents > 0 ? 'authorized' : 'unpaid';
  return refundedCents >= capturedCents ? 'refunded' : 'paid';
}

/** Enough of an order to say what is still owed on it. A database row
 *  satisfies it structurally, like every other input in this package. */
export type OrderMoney = {
  /** The snapshot's total. NEVER modified by anything in this file — a balance
   *  is computed beside the money, never by editing it (the snapshot rule). */
  totalCents: number;
  events: readonly MoneyEvent[];
};

export type OrderBalance = {
  /** Money received and kept: captured minus refunded. A hold is NOT in here —
   *  it is not received (C-069). */
  collectedCents: number;
  /** What the customer still owes. Zero once the order is settled. */
  outstandingCents: number;
};

/**
 * A balance, not a boolean (PRD 3 P0-2, C-064).
 *
 * `paymentState` can say paid, unpaid or refunded. It cannot say "$31.20 of
 * $34.20", which is the answer as soon as anything partial exists — a partial
 * refund today, a comp or a partial payment when C-065 lands. This is the one
 * function that answers "how much is still owed", and the staff receipt, the
 * queue's unpaid badge and the report's outstanding list all ask it.
 *
 * INTEGER CENTS THROUGHOUT, no float anywhere in the arithmetic (CLAUDE.md).
 *
 * Both figures are clamped at zero, and the clamps mean different things.
 * `collectedCents` clamps because a refund exceeding capture is a data error
 * and "we hold minus three dollars" is not a thing a screen should ever show.
 * `outstandingCents` clamps because an overpayment is money owed to the
 * CUSTOMER, which is a refund the product cannot yet issue — showing it as a
 * negative debt would invite somebody to collect it again.
 *
 * THE COMP TERM LANDED IN C-065, and it is subtracted from what is OWED rather
 * than from what was collected. Those are two different sentences: comping a
 * $13.75 order the customer never paid means the restaurant collected nothing
 * and is owed nothing; comping one they already paid means the restaurant
 * collected $13.75 and owes it BACK. Only the first is expressible today, and
 * `outstandingCents`' existing clamp is what makes the second read as zero
 * rather than as a negative debt somebody could collect twice — a refund the
 * product cannot yet issue is C-067's problem, and quietly showing it as owed
 * would be the wrong answer in the customer's disfavour.
 *
 * One consequence worth stating, because C-064's entry claims the opposite:
 * `collected + outstanding` is no longer exactly the revenue booked once an
 * order is comped. That is correct rather than broken — a comped order booked
 * no revenue — and it is the reason the report's comps line (P1-3) is a line
 * of its own rather than an adjustment to net sales.
 */
export function orderBalance(order: OrderMoney): OrderBalance {
  const { capturedCents, refundedCents, adjustedCents, authorizedCents } = paymentTotals(
    order.events,
  );
  const collectedCents = Math.max(0, capturedCents - refundedCents);
  return {
    collectedCents,
    // THE HOLD COMES OFF WHAT IS OWED, not off what was collected (C-069), and
    // the two are different sentences for the same reason the comp term is:
    // an authorized order has given the restaurant nothing, and asking its
    // customer for the total at the counter would charge them twice. It is
    // `outstandingCents` that `canCollectPayment` reads, so subtracting here
    // is what structurally closes that door rather than a new check on a new
    // enum value that three screens would have to remember.
    outstandingCents: Math.max(
      0,
      order.totalCents - collectedCents - adjustedCents - authorizedCents,
    ),
  };
}

/**
 * Dollars for a refusal message. Integer arithmetic, even here.
 *
 * NOT the app's `formatCents` — this package has no currency formatter and
 * does not want one; a refusal needs a number a person recognises, not a
 * locale. `(cents / 100).toFixed(2)` would read the same on every value this
 * can be handed, and CLAUDE.md's rule is that there is no float in the money
 * path INCLUDING the part of it a person reads, because a formatter is exactly
 * where a float gets reintroduced by somebody sure it is only for display.
 *
 * Here rather than beside either caller because both the adjustment's bound
 * and the refund's bound quote a figure back, and two copies of a money
 * formatter is how the two of them end up rounding differently.
 */
export const formatBoundCents = (cents: number): string =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
