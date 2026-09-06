import { describe, expect, it } from 'vitest';
import { pendingRefunds, refundNeedsAttention, refundRequestEvent, type RefundEvent } from './refund';

// PRD 3 P0-4 (C-067) and P0-6 (C-071). Where a refund got to used to be a
// question about the ORDER, because cancelling was the only thing that could
// ask for one and it can only happen once. These prove the per-request shape
// that replaced it; that the real write paths produce these sequences is
// proved against a live database in packages/db/refund.test.ts.

// A fixed instant, built the only way the lint allows (CLAUDE.md time rules).
const NOW = new Date(Date.UTC(2026, 8, 6, 19, 41, 0));

let next = 0;
const id = (): string => `event-${(next += 1)}`;

const money = (kind: RefundEvent['kind'], amountCents: number | null): RefundEvent => ({
  id: id(),
  kind,
  amountCents,
  refundRequestId: null,
});

const payment = (amountCents: number): RefundEvent => money('payment', amountCents);
const adjustment = (amountCents: number): RefundEvent => money('adjustment', amountCents);
/** The cancellation's request: no amount, meaning "everything held at the
 *  moment of the attempt". */
const requested = (amountCents: number | null = null): RefundEvent =>
  money('refund_requested', amountCents);
const against = (
  kind: 'refund' | 'refund_failed',
  request: RefundEvent,
  amountCents: number | null,
): RefundEvent => ({ ...money(kind, amountCents), refundRequestId: request.id });

describe('pendingRefunds', () => {
  it('is empty when nobody ever asked for one', () => {
    expect(pendingRefunds([payment(3420)])).toEqual([]);
  });

  it('reports the cancellations request as an unbounded ask', () => {
    const request = requested();
    expect(pendingRefunds([payment(3420), request])).toEqual([
      { id: request.id, amountCents: null, failed: false },
    ]);
  });

  it('carries the amount a deliberate ask named', () => {
    const request = requested(500);
    expect(pendingRefunds([payment(3420), request])).toEqual([
      { id: request.id, amountCents: 500, failed: false },
    ]);
  });

  it('marks a request whose attempt came back refused', () => {
    const request = requested();
    const events = [payment(3420), request, against('refund_failed', request, null)];
    expect(pendingRefunds(events)).toEqual([{ id: request.id, amountCents: null, failed: true }]);
  });

  it('drops a request once the money actually went back', () => {
    const request = requested();
    expect(pendingRefunds([payment(3420), request, against('refund', request, 3420)])).toEqual([]);
  });

  // THE PROPERTY THE OLD SHAPE COULD NOT HAVE, and the defect it would have
  // shipped. `deriveRefundState` answered by precedence over the whole order:
  // any `refund` on it meant `succeeded`. So an order refunded $3 in the
  // afternoon and asked for $5 back in the evening read as fully settled — the
  // customer is told their money is on the way, the exceptions list is quiet,
  // and nothing anywhere is chasing the $5.
  it('keeps a second ask pending even though a first refund already landed', () => {
    const first = requested(300);
    const second = requested(500);
    const events = [payment(3420), first, against('refund', first, 300), second];
    expect(pendingRefunds(events)).toEqual([{ id: second.id, amountCents: 500, failed: false }]);
  });

  // The same defect in the other direction: a failure on a settled request
  // must not make a fresh, untried one read as already refused. The panel's
  // two sentences are different instructions to the person reading them.
  it('does not carry one requests failure onto another request', () => {
    const first = requested(300);
    const second = requested(500);
    const events = [
      payment(3420),
      first,
      against('refund_failed', first, null),
      against('refund', first, 300),
      second,
    ];
    expect(pendingRefunds(events)).toEqual([{ id: second.id, amountCents: 500, failed: false }]);
  });

  // ORDER-INDEPENDENT, which is what the old function bought with precedence
  // and this one gets from set membership. The receipt's select imposes no
  // ordering, and a retry succeeding in the same millisecond as its request
  // shares an instant with it — which every test with a frozen `now` does by
  // construction.
  it('reads the same whatever order the log comes back in', () => {
    const request = requested();
    const events = [
      payment(3420),
      request,
      against('refund_failed', request, null),
      against('refund', request, 3420),
    ];
    expect(pendingRefunds(events)).toEqual([]);
    expect(pendingRefunds([...events].reverse())).toEqual([]);
  });

  // A pre-C-067 `refund` was written with no request at all — the cancellation
  // pushed it straight into its own transaction. The migration deliberately
  // left those unlinked rather than inventing a request nobody recorded, and
  // this is what that reads as: money that went back, nothing owed.
  it('ignores a legacy refund that never had a request', () => {
    expect(pendingRefunds([payment(3420), money('refund', 3420)])).toEqual([]);
  });
});

describe('refundNeedsAttention', () => {
  // One predicate for the exceptions query and the receipt's panel, so the
  // screen and the list cannot disagree about which orders still owe money.
  it('is true for an unsent ask and false once it is sent', () => {
    const request = requested();
    expect(refundNeedsAttention([payment(3420), request])).toBe(true);
    expect(refundNeedsAttention([payment(3420), request, against('refund_failed', request, null)])).toBe(
      true,
    );
    expect(refundNeedsAttention([payment(3420), request, against('refund', request, 3420)])).toBe(
      false,
    );
    expect(refundNeedsAttention([payment(3420)])).toBe(false);
  });
});

describe('refundRequestEvent', () => {
  /** $34.20 paid at checkout and nothing sent back yet. */
  const paidOrder = (...extra: RefundEvent[]) => ({
    totalCents: 3420,
    events: [payment(3420), ...extra],
  });

  const ask = (amountCents: number, extra: Partial<Parameters<typeof refundRequestEvent>[1]> = {}) =>
    refundRequestEvent(paidOrder(), { amountCents, reason: 'quality', ...extra }, NOW);

  it('writes a request carrying the amount somebody asked for', () => {
    const result = ask(500);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.amountCents).toBe(500);
    expect(result.event).toMatchObject({
      at: NOW,
      kind: 'refund_requested',
      amountCents: 500,
      reason: 'quality',
      // A person decided, where the cancellation's request is `system`.
      actor: 'staff',
      // Money marks the timeline, it does not divide it.
      fromStatus: null,
      toStatus: null,
    });
  });

  // REFUSED, NEVER CLAMPED — the discipline `adjustmentEvent` set. A clamp
  // turns "$50 back on this $34.20 order" into a legal $34.20 refund and tells
  // nobody a wrong number was typed; on money leaving the till that is worse.
  it('refuses an amount larger than what is held, and names the bound', () => {
    const result = ask(5000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('refund_exceeds_balance');
    expect(result.message).toContain('$34.20');
  });

  it('refuses anything that is not a whole number of cents above zero', () => {
    for (const amount of [0, -100, 12.5, Number.NaN]) {
      const result = ask(amount);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('refund_amount_invalid');
    }
  });

  // THE BOUND IS WHAT IS HELD, not what was charged. A comp reduces what the
  // customer OWES and moves nothing, so it must not enlarge what can be sent
  // back — and a refund already sent must reduce it.
  it('bounds on money held rather than on the order total', () => {
    const comped = refundRequestEvent(
      { totalCents: 3420, events: [payment(3420), adjustment(1000)] },
      { amountCents: 3420, reason: 'quality' },
      NOW,
    );
    expect(comped.ok).toBe(true);

    const request = requested(300);
    const partlyRefunded = refundRequestEvent(
      { totalCents: 3420, events: [payment(3420), request, against('refund', request, 300)] },
      { amountCents: 3200, reason: 'quality' },
      NOW,
    );
    expect(partlyRefunded.ok).toBe(false);
    if (!partlyRefunded.ok) expect(partlyRefunded.reason).toBe('refund_exceeds_balance');
  });

  it('refuses when the restaurant is holding nothing', () => {
    const result = refundRequestEvent(
      { totalCents: 3420, events: [] },
      { amountCents: 100, reason: 'quality' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nothing_to_refund');
  });

  // Two unsettled asks are two claims on money that can only be sent once. The
  // second would be refused at the attempt anyway — after a provider call, on
  // a screen nobody is watching. Refusing here says so where somebody can act.
  it('refuses to stack a second ask on an unsettled one', () => {
    const result = refundRequestEvent(
      paidOrder(requested(300)),
      { amountCents: 500, reason: 'quality' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('refund_already_pending');
  });

  it('allows a second ask once the first one settled', () => {
    const first = requested(300);
    const result = refundRequestEvent(
      { totalCents: 3420, events: [payment(3420), first, against('refund', first, 300)] },
      { amountCents: 500, reason: 'quality' },
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('requires a note for "other" and caps its length', () => {
    const bare = ask(500, { reason: 'other' });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.reason).toBe('refund_note_required');

    const long = ask(500, { note: 'x'.repeat(141) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.reason).toBe('refund_note_too_long');
  });

  // `loyalty_reward` is written by the redemption and is deliberately not
  // staff-pickable. A hand-crafted POST must not reach it here either — a
  // reward's reason on a refund would put a punch card's words on money
  // leaving the till.
  it('refuses a reason no person may pick', () => {
    const result = refundRequestEvent(
      { totalCents: 3420, events: [payment(3420)] },
      { amountCents: 500, reason: 'loyalty_reward' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_refund_reason');
  });
});
