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
 */
export function paymentTotals(events: readonly MoneyEvent[]): {
  capturedCents: number;
  refundedCents: number;
  adjustedCents: number;
} {
  return {
    capturedCents: sumOf(events, 'payment'),
    refundedCents: sumOf(events, 'refund'),
    adjustedCents: sumOf(events, 'adjustment'),
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
  const { capturedCents, refundedCents } = paymentTotals(events);
  // Checked first, so a refund with no capture — which is a data error, not a
  // state — reads as `unpaid` rather than as money that went back.
  if (capturedCents === 0) return 'unpaid';
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
  /** Money received and kept: captured minus refunded. */
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
  const { capturedCents, refundedCents, adjustedCents } = paymentTotals(order.events);
  const collectedCents = Math.max(0, capturedCents - refundedCents);
  return {
    collectedCents,
    outstandingCents: Math.max(0, order.totalCents - collectedCents - adjustedCents),
  };
}
