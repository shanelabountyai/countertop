import { describe, expect, it } from 'vitest';
import {
  derivePaymentState,
  orderBalance,
  paymentTotals,
  type MoneyEvent,
} from './payment';
import { canCollectPayment } from './state-machine';

// PRD 3 P0-1 (C-063). The event stream is the truth; `Order.paymentState` is a
// derived cache over it. These prove the derivation. That the CACHE actually
// agrees with it is proved against a real service in packages/db/payment.test.ts,
// which is the assertion the decision was really about.

const payment = (amountCents: number): MoneyEvent => ({ kind: 'payment', amountCents });
const refund = (amountCents: number): MoneyEvent => ({ kind: 'refund', amountCents });
/** Every other kind: a status move, a mismatch. Money-less by construction —
 *  the column's CHECK requires their amount to be null. */
const move = (): MoneyEvent => ({ kind: 'transition', amountCents: null });
/** Money the restaurant chose not to ask for (C-065). A third direction, and
 *  deliberately its own field below rather than folded into either of the
 *  other two: nothing moved, so netting it against a capture would claim the
 *  till did something it did not. */
const adjustment = (amountCents: number): MoneyEvent => ({ kind: 'adjustment', amountCents });
/** The refund's own two kinds (C-067). Neither carries an amount: a request is
 *  a decision and a failure is a non-event, and the database's CHECK says the
 *  same thing. */
const requested = (): MoneyEvent => ({ kind: 'refund_requested', amountCents: null });
const failed = (): MoneyEvent => ({ kind: 'refund_failed', amountCents: null });

describe('paymentTotals', () => {
  it('sums each direction separately, never nets them into one number', () => {
    expect(paymentTotals([payment(3420), refund(300), adjustment(500)])).toEqual({
      capturedCents: 3420,
      refundedCents: 300,
      refundReversedCents: 0,
      adjustedCents: 500,
      authorizedCents: 0,
    });
  });

  it('ignores every event that did not move money', () => {
    expect(paymentTotals([move(), payment(1456), move()])).toEqual({
      capturedCents: 1456,
      refundedCents: 0,
      refundReversedCents: 0,
      adjustedCents: 0,
      authorizedCents: 0,
    });
  });

  it('is zeroes, not NaN, on an order with no events at all', () => {
    expect(paymentTotals([])).toEqual({
      capturedCents: 0,
      refundedCents: 0,
      refundReversedCents: 0,
      adjustedCents: 0,
      authorizedCents: 0,
    });
  });
});

describe('derivePaymentState', () => {
  it('is unpaid when nothing was ever taken', () => {
    expect(derivePaymentState([])).toBe('unpaid');
    expect(derivePaymentState([move(), move()])).toBe('unpaid');
  });

  it('is paid once money has arrived', () => {
    expect(derivePaymentState([payment(1456)])).toBe('paid');
  });

  it('is refunded when all of it went back', () => {
    expect(derivePaymentState([payment(3507), refund(3507)])).toBe('refunded');
  });

  it('reads a partial refund as paid, which is the enum being lossy', () => {
    // Not a defect in the derivation: `paid` is the only value the enum has
    // for "captured 3420, refunded 300". The honest answer is "3120 still
    // ours", and P0-2's balance is where that lives.
    expect(derivePaymentState([payment(3420), refund(300)])).toBe('paid');
  });

  it('treats a refund with no capture as unpaid rather than as money returned', () => {
    // A data error, not a state. `unpaid` is the least-wrong reading: no money
    // was ever recorded arriving, so none can have gone back.
    expect(derivePaymentState([refund(500)])).toBe('unpaid');
  });

  it('handles a payment taken in two parts', () => {
    // Nothing writes this yet — P1-1's auth-then-capture will. The sum is the
    // rule, not the count, so it needs no change when that lands.
    expect(derivePaymentState([payment(1000), payment(456)])).toBe('paid');
    expect(derivePaymentState([payment(1000), payment(456), refund(1456)])).toBe('refunded');
  });
});

// PRD 3 P0-2 (C-064). `paymentState` can say paid, unpaid or refunded; it
// cannot say "$31.20 of $34.20", which is the answer the moment anything is
// partial. This is the one function that answers "how much is still owed", and
// the staff receipt, the queue's unpaid badge and the report's outstanding
// list all ask it.
describe('orderBalance', () => {
  it('is the PRD acceptance case, to the cent', () => {
    // "A $34.20 order, captured in full then refunded $3.00, has a balance of
    // 3120 and an unchanged totalCents of 3420."
    const order = { totalCents: 3420, events: [payment(3420), refund(300)] };
    // The PRD pins the BALANCE — 3120 — and says nothing about what is owed.
    // C-127 answers that second half: nothing. The ticket was captured in
    // full, and the $3.00 that went back afterwards is not a debt.
    expect(orderBalance(order)).toEqual({ collectedCents: 3120, outstandingCents: 0 });
    // The snapshot is untouched. A balance is computed BESIDE the money, never
    // by editing it — the rule this whole project is built on.
    expect(order.totalCents).toBe(3420);
  });

  it('owes the whole ticket when nothing has been taken', () => {
    expect(orderBalance({ totalCents: 1456, events: [] })).toEqual({
      collectedCents: 0,
      outstandingCents: 1456,
    });
  });

  it('owes nothing once the ticket is settled', () => {
    expect(orderBalance({ totalCents: 1456, events: [payment(1456)] })).toEqual({
      collectedCents: 1456,
      outstandingCents: 0,
    });
  });

  it('owes nothing after a full refund, because a refund SETTLES (C-127)', () => {
    // This assertion used to read the other way, and the sentence defending it
    // was "the customer has the food and we hold nothing, that is money owed".
    // It is not. The customer paid; the restaurant chose to send it back.
    // Calling that a debt put the refunded ticket on the chase list for the
    // exact amount refunded and — because `canCollectPayment` reads this very
    // number — put a Collect control on the receipt of the person who had just
    // been refunded. The demo printed it at C-126; this is the fix.
    expect(orderBalance({ totalCents: 1456, events: [payment(1456), refund(1456)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 0,
    });
  });

  it('still owes the unpaid REMAINDER of a partly paid, partly refunded ticket', () => {
    // A refund settling is not a refund forgiving. $10 arrived on a $14.56
    // ticket and $3 went back: the $4.56 nobody ever paid is still owed, and
    // the $3 is not added to it.
    expect(
      orderBalance({ totalCents: 1456, events: [payment(1000), refund(300)] }),
    ).toEqual({ collectedCents: 700, outstandingCents: 456 });
  });

  it('never reports holding a negative amount', () => {
    // A refund exceeding capture is a data error, and "we hold minus three
    // dollars" is not something a screen should ever show.
    //
    // WHAT IS OWED MOVED IN C-127 and is stated here rather than left to be
    // discovered: 900, the part of the ticket nothing was ever captured for,
    // where it used to be the whole 1000 because the clamped `collectedCents`
    // was the subtrahend. Neither figure is correct — the data is wrong — and
    // this one is at least the same arithmetic every other case gets.
    expect(orderBalance({ totalCents: 1000, events: [payment(100), refund(500)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 900,
    });
  });

  it('never reports a negative debt on an overpayment', () => {
    // Money owed to the CUSTOMER is a refund this product cannot yet issue.
    // Showing it as a negative debt would invite somebody to collect it again.
    expect(orderBalance({ totalCents: 1000, events: [payment(1500)] })).toEqual({
      collectedCents: 1500,
      outstandingCents: 0,
    });
  });

  it('adds up a payment taken in parts', () => {
    expect(orderBalance({ totalCents: 3420, events: [payment(2000), payment(1000)] })).toEqual({
      collectedCents: 3000,
      outstandingCents: 420,
    });
  });
});

// THE SECOND READER (C-127). `canCollectPayment` is unit-tested in
// `state-machine.test.ts` against bare integers, which is right — the status
// module does not know the payment stream exists. What that cannot catch is
// the WIRING: the defect C-126's rush printed was not a wrong predicate, it
// was a correct predicate handed a wrong number. These assert the two together
// at the seam the screens actually use, so a future change to `orderBalance`
// that re-opens a refunded ticket fails here naming the button.
describe('the counter control over a refunded ticket', () => {
  it('does not offer to collect money that was just sent back', () => {
    const balance = orderBalance({ totalCents: 1505, events: [payment(1505), refund(495)] });
    expect(balance.outstandingCents).toBe(0);
    expect(canCollectPayment('picked_up', balance.outstandingCents)).toBe(false);
  });

  it('still offers to collect from a ticket nobody paid for', () => {
    const balance = orderBalance({ totalCents: 1430, events: [] });
    expect(canCollectPayment('picked_up', balance.outstandingCents)).toBe(true);
  });
});

// PRD 3 P0-4 (C-067), the half of it that is about the ENUM. Where a refund
// GOT TO moved to `refund.test.ts` in C-071, because it stopped being a
// question about the order and became one about each request; what stays here
// is the property that made the split safe to make — the customer-facing copy
// does not move until the money actually does.
describe('derivePaymentState under a refund in flight', () => {
  it('leaves the payment state alone until the money is actually back', () => {
    expect(derivePaymentState([payment(3420), requested(), failed()])).toBe('paid');
    expect(derivePaymentState([payment(3420), requested(), refund(3420)])).toBe('refunded');
  });

  // A PARTIAL refund is still `paid`, and this is the assertion C-071 turned
  // from a comment into a code path: `settleRefund` used to compare-and-set
  // this column to `refunded` as its race guard, which was only ever right
  // because every refund was total. It now writes what this function says.
  it('stays paid when only part of the money went back', () => {
    expect(derivePaymentState([payment(3420), requested(), refund(300)])).toBe('paid');
  });
});

// PRD 3 P0-6 (C-071). A reversal is a contradicting row, and `adjustedCents`
// is the net of the two.
describe('paymentTotals under a reversal', () => {
  const reversed = (amountCents: number): MoneyEvent => ({
    kind: 'adjustment_reversed',
    amountCents,
  });

  it('nets a reversal out of the adjusted total without touching the others', () => {
    expect(paymentTotals([payment(3420), adjustment(1000), reversed(400)])).toEqual({
      capturedCents: 3420,
      refundedCents: 0,
      refundReversedCents: 0,
      adjustedCents: 600,
      authorizedCents: 0,
    });
  });

  // The whole point of the shape: the comp is still in the log, still says who
  // made it and when. Nothing was deleted, and the balance is right anyway.
  it('restores what is owed when a comp is put back in full', () => {
    const order = { totalCents: 1375, events: [adjustment(1375), reversed(1375)] };
    expect(orderBalance(order).outstandingCents).toBe(1375);
    expect(order.events).toHaveLength(2);
  });

  // Reversing more than was ever comped is a data error, not a surcharge. The
  // clamp is what stops it inflating what the customer owes above the total
  // they were actually charged.
  it('clamps at zero rather than turning a reversal into a charge', () => {
    expect(paymentTotals([adjustment(500), reversed(900)]).adjustedCents).toBe(0);
    expect(orderBalance({ totalCents: 1375, events: [adjustment(500), reversed(900)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 1375,
    });
  });
});

// C-133. A refund reversal is the one deliberate re-inversion of C-127's
// "closed fact" stance: `refundedCents` stays RAW (the money really did
// leave), and `refundReversedCents` is a separate figure added back onto
// `outstandingCents` alone.
describe('paymentTotals under a refund reversal', () => {
  const reversedRefund = (amountCents: number): MoneyEvent => ({
    kind: 'refund_reversed',
    amountCents,
  });

  it('adds a new figure without touching refundedCents', () => {
    expect(paymentTotals([payment(3420), refund(300), reversedRefund(300)])).toEqual({
      capturedCents: 3420,
      refundedCents: 300,
      refundReversedCents: 300,
      adjustedCents: 0,
      authorizedCents: 0,
    });
  });

  // THE POINT: reopening what is owed without pretending the money is back in
  // the till. `collectedCents` — the pool available to refund again — does
  // NOT move, because the restaurant does not, in fact, hold this money; it
  // is `outstandingCents` — what the customer owes — that reopens.
  it('reopens outstandingCents without reopening collectedCents', () => {
    const order = { totalCents: 3420, events: [payment(3420), refund(3420), reversedRefund(3420)] };
    expect(orderBalance(order)).toEqual({ collectedCents: 0, outstandingCents: 3420 });
  });

  // THE THREE-BUCKET INVARIANT NOW HAS A FOURTH DOCUMENTED EXCEPTION
  // (`docs/WRITEUP.md`), the same shape the comp term and the hold term
  // already are: `refunded` (300, the honest fact it left) and `outstanding`
  // (300, it should come back) both count this same amount on purpose.
  it('double-counts the reversed slice across refunded and outstanding, on purpose', () => {
    const order = { totalCents: 3420, events: [payment(3420), refund(300), reversedRefund(300)] };
    const balance = orderBalance(order);
    const { refundedCents } = paymentTotals(order.events);
    expect(balance.collectedCents + balance.outstandingCents + refundedCents).toBe(3420 + 300);
  });
});

// PRD 3 P1-1 (C-069). A hold is a third thing the enum could not say: not
// collected, and not owed. The arithmetic is all here, because that is what
// keeps `MoneyEvent` two scalars — a capture and a void carry the amount they
// settle, so nothing has to follow a link to know what is held.
describe('a hold, held and settled', () => {
  const held = (amountCents: number): MoneyEvent => ({ kind: 'authorization', amountCents });
  const captured = (amountCents: number): MoneyEvent => ({ kind: 'capture', amountCents });
  const voided = (amountCents: number): MoneyEvent => ({
    kind: 'authorization_voided',
    amountCents,
  });

  it('is money the restaurant may take and has not taken', () => {
    expect(paymentTotals([held(3507)])).toEqual({
      capturedCents: 0,
      refundedCents: 0,
      refundReversedCents: 0,
      adjustedCents: 0,
      authorizedCents: 3507,
    });
  });

  it('reads as authorized, which is neither paid nor unpaid', () => {
    expect(derivePaymentState([held(3507)])).toBe('authorized');
  });

  // The whole point of the item. Nothing was charged, so nothing owes a
  // refund, and the balance says so without a single provider call.
  it('leaves nothing collected and nothing owed while it stands', () => {
    expect(orderBalance({ totalCents: 3507, events: [held(3507)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 0,
    });
  });

  it('becomes ordinary money once it is captured', () => {
    const events = [held(3507), captured(3507)];
    expect(paymentTotals(events).capturedCents).toBe(3507);
    expect(paymentTotals(events).authorizedCents).toBe(0);
    expect(derivePaymentState(events)).toBe('paid');
    expect(orderBalance({ totalCents: 3507, events })).toEqual({
      collectedCents: 3507,
      outstandingCents: 0,
    });
  });

  // The no-show, and the sentence this whole item exists for: the money never
  // left the card, so the order owes nothing back and the customer owes the
  // restaurant nothing either — the food was thrown away, not sold.
  it('leaves no refund to chase once it is released', () => {
    const events = [held(3507), voided(3507)];
    expect(paymentTotals(events)).toEqual({
      capturedCents: 0,
      refundedCents: 0,
      refundReversedCents: 0,
      adjustedCents: 0,
      authorizedCents: 0,
    });
    expect(derivePaymentState(events)).toBe('unpaid');
  });

  // A capture that the provider refused is written as a release naming why
  // (`settleAuthorization`), and this is what that leaves behind: the food is
  // gone and the money is owed at the counter, which is exactly the state
  // `canCollectPayment` serves.
  it('puts the order back to owing when the hold was released without a capture', () => {
    expect(orderBalance({ totalCents: 3507, events: [held(3507), voided(3507)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 3507,
    });
  });

  // A captured order is a paid order, and everything C-071 built still applies
  // to it — which is the seam holding: the deliberate refund control does not
  // know a capture from a counter payment, and does not need to.
  it('is refundable after capture exactly as a counter payment is', () => {
    const events = [held(3507), captured(3507), refund(300)];
    expect(orderBalance({ totalCents: 3507, events })).toEqual({
      collectedCents: 3207,
      outstandingCents: 0,
    });
    expect(derivePaymentState(events)).toBe('paid');
  });

  // Settling more than was ever held is a data error the constraint makes
  // unreachable; the clamp is what stops it reading as money owed on an order
  // nobody owes anything on.
  it('clamps a negative hold rather than inventing a debt', () => {
    expect(paymentTotals([held(500), voided(900)]).authorizedCents).toBe(0);
  });
});
