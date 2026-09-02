import { describe, expect, it } from 'vitest';
import { derivePaymentState, paymentTotals, type MoneyEvent } from './payment';

// PRD 3 P0-1 (C-063). The event stream is the truth; `Order.paymentState` is a
// derived cache over it. These prove the derivation. That the CACHE actually
// agrees with it is proved against a real service in packages/db/payment.test.ts,
// which is the assertion the decision was really about.

const payment = (amountCents: number): MoneyEvent => ({ kind: 'payment', amountCents });
const refund = (amountCents: number): MoneyEvent => ({ kind: 'refund', amountCents });
/** Every other kind: a status move, a mismatch. Money-less by construction —
 *  the column's CHECK requires their amount to be null. */
const move = (): MoneyEvent => ({ kind: 'transition', amountCents: null });

describe('paymentTotals', () => {
  it('sums each direction separately, never nets them into one number', () => {
    expect(paymentTotals([payment(3420), refund(300)])).toEqual({
      capturedCents: 3420,
      refundedCents: 300,
    });
  });

  it('ignores every event that did not move money', () => {
    expect(paymentTotals([move(), payment(1456), move()])).toEqual({
      capturedCents: 1456,
      refundedCents: 0,
    });
  });

  it('is zeroes, not NaN, on an order with no events at all', () => {
    expect(paymentTotals([])).toEqual({ capturedCents: 0, refundedCents: 0 });
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
