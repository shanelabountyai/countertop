import { describe, expect, it } from 'vitest';
import {
  derivePaymentState,
  deriveRefundState,
  orderBalance,
  paymentTotals,
  refundNeedsAttention,
  type MoneyEvent,
} from './payment';

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
      adjustedCents: 500,
    });
  });

  it('ignores every event that did not move money', () => {
    expect(paymentTotals([move(), payment(1456), move()])).toEqual({
      capturedCents: 1456,
      refundedCents: 0,
      adjustedCents: 0,
    });
  });

  it('is zeroes, not NaN, on an order with no events at all', () => {
    expect(paymentTotals([])).toEqual({ capturedCents: 0, refundedCents: 0, adjustedCents: 0 });
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
    expect(orderBalance(order)).toEqual({ collectedCents: 3120, outstandingCents: 300 });
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

  it('owes the whole ticket again after a full refund', () => {
    // The customer has the food and we hold nothing. That is money owed, and
    // saying anything else would drop the order off the chase list.
    expect(orderBalance({ totalCents: 1456, events: [payment(1456), refund(1456)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 1456,
    });
  });

  it('never reports holding a negative amount', () => {
    // A refund exceeding capture is a data error, and "we hold minus three
    // dollars" is not something a screen should ever show.
    expect(orderBalance({ totalCents: 1000, events: [payment(100), refund(500)] })).toEqual({
      collectedCents: 0,
      outstandingCents: 1000,
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

// PRD 3 P0-4 (C-067). The state `PaymentState` could not hold — three terminal
// facts and none of them "we tried". These prove the derivation; that the real
// write paths produce these event sequences is proved in packages/db.
describe('deriveRefundState', () => {
  it('is null when nobody ever asked for one', () => {
    expect(deriveRefundState([payment(3420), move()])).toBeNull();
  });

  it('is requested once the cancellation recorded the debt', () => {
    expect(deriveRefundState([payment(3420), requested()])).toBe('requested');
  });

  it('is failed once an attempt came back refused', () => {
    expect(deriveRefundState([payment(3420), requested(), failed()])).toBe('failed');
  });

  it('is succeeded once the money actually went back', () => {
    expect(deriveRefundState([payment(3420), requested(), refund(3420)])).toBe('succeeded');
  });

  // THE PROPERTY THAT MAKES THIS SAFE. The obvious version reads the last
  // refund-ish event, and "last" needs an ordering the receipt's event select
  // does not impose — worse, a retry that succeeds in the same millisecond as
  // the failure before it shares an instant with it, which every test with a
  // frozen `now` does by construction. Precedence has no such tie.
  it('reads succeeded whatever order a retry lands in', () => {
    const events = [payment(3420), requested(), failed(), refund(3420)];
    expect(deriveRefundState(events)).toBe('succeeded');
    expect(deriveRefundState([...events].reverse())).toBe('succeeded');
  });

  it('reads failed after a second attempt also failed', () => {
    expect(deriveRefundState([payment(3420), requested(), failed(), failed()])).toBe('failed');
  });

  // The enum stays honest through all of it: a refund that has not landed is
  // money the restaurant is still holding, so the customer-facing copy says
  // `paid` and never `refunded` (P0-4's third bullet).
  it('leaves the payment state alone until the money is actually back', () => {
    expect(derivePaymentState([payment(3420), requested(), failed()])).toBe('paid');
    expect(derivePaymentState([payment(3420), requested(), refund(3420)])).toBe('refunded');
  });
});

describe('refundNeedsAttention', () => {
  // One predicate for the exceptions query and the receipt's panel, so the
  // screen and the list cannot disagree about which orders still owe money.
  it('names both unsettled states and neither settled one', () => {
    expect(refundNeedsAttention('requested')).toBe(true);
    expect(refundNeedsAttention('failed')).toBe(true);
    expect(refundNeedsAttention('succeeded')).toBe(false);
    expect(refundNeedsAttention(null)).toBe(false);
  });
});
