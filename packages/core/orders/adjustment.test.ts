// PRD 3 P0-3 (C-065). The amounts are hand-calculated and the frozen `now` is
// a constant, per CLAUDE.md's test rules.
import { describe, expect, it } from 'vitest';
import {
  ADJUSTMENT_KINDS,
  ADJUSTMENT_REASONS,
  ADJUSTMENT_REVERSAL_REASON,
  adjustableRemainingCents,
  adjustmentEvent,
  isStaffAdjustmentReason,
  type AdjustableOrder,
} from './adjustment';
import { orderBalance, paymentTotals, derivePaymentState, type MoneyEvent } from './payment';
import { MAX_CANCEL_NOTE_LENGTH } from './state-machine';

// A fixed instant, built the only way the lint allows (CLAUDE.md time rules).
const NOW = new Date(Date.UTC(2026, 8, 2, 19, 20, 0));

/** The PRD's own figure: a $13.75 order. */
const TOTAL = 1375;

const order = (...events: MoneyEvent[]): AdjustableOrder => ({ totalCents: TOTAL, events });
const paid = (amountCents: number): MoneyEvent => ({ kind: 'payment', amountCents });
const comped = (amountCents: number): MoneyEvent => ({ kind: 'adjustment', amountCents });

describe('adjustableRemainingCents', () => {
  it('is the whole total on an untouched order', () => {
    expect(adjustableRemainingCents(order())).toBe(1375);
  });

  it('does not count money that was PAID as money that was adjusted', () => {
    expect(adjustableRemainingCents(order(paid(1375)))).toBe(1375);
  });

  it('is cumulative — the second adjustment sees what the first left', () => {
    expect(adjustableRemainingCents(order(comped(500)))).toBe(875);
    expect(adjustableRemainingCents(order(comped(500), comped(875)))).toBe(0);
  });

  it('never goes negative, whatever the log holds', () => {
    expect(adjustableRemainingCents(order(comped(9999)))).toBe(0);
  });
});

describe('adjustmentEvent — the comp', () => {
  it("derives its own amount and never takes the client's", () => {
    // The client's number is deliberately absurd AND deliberately present: a
    // comp must ignore it rather than validate it.
    const result = adjustmentEvent(order(), { kind: 'comp', amountCents: 999999, reason: 'quality' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.amountCents).toBe(1375);
  });

  it('comps only what is LEFT on a partly adjusted order', () => {
    const result = adjustmentEvent(order(comped(500)), { kind: 'comp', reason: 'late' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.amountCents).toBe(875);
  });

  it('writes the preset in the column and the free text in detail', () => {
    const result = adjustmentEvent(
      order(),
      { kind: 'comp', reason: 'other', note: '  dropped it  ' },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.reason).toBe('other');
    expect(result.event.detail).toEqual({ amountCents: 1375, adjustment: 'comp', note: 'dropped it' });
  });

  it('is not a status change, so the time-in-state tally steps over it', () => {
    const result = adjustmentEvent(order(), { kind: 'comp', reason: 'quality' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.fromStatus).toBeNull();
    expect(result.event.toStatus).toBeNull();
    expect(result.event.at).toBe(NOW);
    expect(result.event.actor).toBe('staff');
  });
});

describe('adjustmentEvent — the partial', () => {
  it('accepts an amount inside the total', () => {
    const result = adjustmentEvent(order(), { kind: 'partial', amountCents: 300, reason: 'late' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.amountCents).toBe(300);
  });

  it('accepts exactly the total, which is the boundary and not an error', () => {
    const result = adjustmentEvent(order(), { kind: 'partial', amountCents: 1375, reason: 'late' }, NOW);
    expect(result.ok).toBe(true);
  });

  it('REFUSES one cent over, by name, rather than clamping', () => {
    const result = adjustmentEvent(order(), { kind: 'partial', amountCents: 1376, reason: 'late' }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adjustment_exceeds_total');
    expect(result.message).toContain('$13.75');
  });

  it('refuses a second adjustment that fits alone but not cumulatively', () => {
    // $5.00 already comped; $10.00 more is under the total and over what is
    // left. The single-amount reading of the requirement lets this through.
    const result = adjustmentEvent(
      order(comped(500)),
      { kind: 'partial', amountCents: 1000, reason: 'quality' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adjustment_exceeds_total');
    expect(result.message).toContain('$8.75');
  });

  it.each([
    ['a missing amount', undefined],
    ['zero', 0],
    ['a negative', -100],
    ['a fraction of a cent', 12.5],
    ['not a number at all', Number.NaN],
  ])('refuses %s', (_label, amountCents) => {
    const result = adjustmentEvent(
      order(),
      { kind: 'partial', ...(amountCents === undefined ? {} : { amountCents }), reason: 'late' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adjustment_amount_invalid');
  });
});

describe('adjustmentEvent — the refusals', () => {
  it('refuses an unknown kind', () => {
    const result = adjustmentEvent(
      order(),
      { kind: 'remake' as never, amountCents: 100, reason: 'late' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_adjustment_kind');
  });

  it('refuses an unknown reason', () => {
    const result = adjustmentEvent(order(), { kind: 'comp', reason: 'because' as never }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_adjustment_reason');
  });

  it('refuses "other" with no note, and with a whitespace note', () => {
    for (const note of [undefined, '   ']) {
      const result = adjustmentEvent(
        order(),
        { kind: 'comp', reason: 'other', ...(note === undefined ? {} : { note }) },
        NOW,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('adjustment_note_required');
    }
  });

  it('refuses a note past the cap', () => {
    const result = adjustmentEvent(
      order(),
      { kind: 'comp', reason: 'quality', note: 'x'.repeat(MAX_CANCEL_NOTE_LENGTH + 1) },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adjustment_note_too_long');
  });

  it('refuses anything at all on an order already adjusted in full', () => {
    const result = adjustmentEvent(order(comped(1375)), { kind: 'comp', reason: 'late' }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('nothing_left_to_adjust');
  });
});

describe('what an adjustment does to the money', () => {
  // The PRD's own acceptance case, to the cent.
  it("comps a picked-up $13.75 order: the total is untouched and the balance is 0", () => {
    const result = adjustmentEvent(order(), { kind: 'comp', reason: 'quality' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const after = { totalCents: TOTAL, events: [comped(result.event.amountCents!)] };
    expect(after.totalCents).toBe(1375);
    expect(orderBalance(after)).toEqual({ collectedCents: 0, outstandingCents: 0 });
  });

  it('a partial reduces what is owed and nothing else', () => {
    const after = { totalCents: TOTAL, events: [comped(300)] };
    expect(orderBalance(after)).toEqual({ collectedCents: 0, outstandingCents: 1075 });
  });

  it('a comp on an order that already PAID leaves the collected money alone', () => {
    // The restaurant took $13.75 and then decided not to have asked for it.
    // What it holds is unchanged; what it owes BACK is a refund this product
    // cannot issue yet, which is why outstanding clamps to zero rather than
    // reading as a negative debt somebody could try to collect.
    const after = { totalCents: TOTAL, events: [paid(1375), comped(1375)] };
    expect(orderBalance(after)).toEqual({ collectedCents: 1375, outstandingCents: 0 });
  });

  it('does not move the payment enum — an unpaid comped order is still unpaid', () => {
    expect(derivePaymentState([comped(1375)])).toBe('unpaid');
    expect(paymentTotals([comped(1375)])).toEqual({
      capturedCents: 0,
      refundedCents: 0,
      adjustedCents: 1375,
    });
  });
});

// PRD 3 P0-6 (C-071). A mistaken comp is corrected by a CONTRADICTING ROW,
// never a delete — C-065 and C-066 both deferred this and both gave the same
// reason: the log is append-only, and a decision that vanishes is one nobody
// can be asked about at close.
describe('adjustmentEvent — reversal', () => {
  const reverse = (amountCents: number, note = 'comped the wrong ticket') =>
    adjustmentEvent(
      order(comped(1000)),
      { kind: 'reversal', amountCents, reason: ADJUSTMENT_REVERSAL_REASON, note },
      NOW,
    );

  it('writes its own kind, not a negative adjustment', () => {
    const result = reverse(400);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event).toMatchObject({
      kind: 'adjustment_reversed',
      // Unsigned, always. Direction is the kind — a comp of -400 and a
      // reversal of 400 would be the same row twice over.
      amountCents: 400,
      reason: ADJUSTMENT_REVERSAL_REASON,
      actor: 'staff',
      fromStatus: null,
      toStatus: null,
    });
  });

  // THE BOUND IS THE MIRROR of the other two kinds: they spend what is left of
  // the order, this spends what has already been given away.
  it('is bounded by what was adjusted, not by the order total', () => {
    const result = reverse(1001);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('reversal_exceeds_adjusted');
    expect(result.message).toContain('$10.00');
  });

  it('is cumulative — reversing twice cannot take back more than was comped', () => {
    const result = adjustmentEvent(
      order(comped(1000), { kind: 'adjustment_reversed', amountCents: 600 }),
      { kind: 'reversal', amountCents: 500, reason: ADJUSTMENT_REVERSAL_REASON, note: 'again' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('reversal_exceeds_adjusted');
  });

  it('refuses when there is nothing to take back', () => {
    const result = adjustmentEvent(
      order(paid(1375)),
      { kind: 'reversal', amountCents: 100, reason: ADJUSTMENT_REVERSAL_REASON, note: 'oops' },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('nothing_to_reverse');
  });

  // ALWAYS a note, whatever the reason says. The other two kinds are a
  // decision about the customer's food; this is a decision about a colleague's
  // decision, and it puts money back onto a bill somebody has already been
  // told they do not owe.
  it('always requires a note', () => {
    const result = adjustmentEvent(
      order(comped(1000)),
      { kind: 'reversal', amountCents: 400, reason: ADJUSTMENT_REVERSAL_REASON },
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('adjustment_note_required');
  });

  // The whole shape, end to end: the comp is still there, the correction is
  // beside it, and the balance is the net of the two.
  it('leaves both decisions in the log and restores what is owed', () => {
    const result = reverse(1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const after = order(comped(1000), {
      kind: result.event.kind,
      amountCents: result.event.amountCents ?? 0,
    });
    expect(after.events).toHaveLength(2);
    expect(paymentTotals(after.events).adjustedCents).toBe(0);
    expect(orderBalance(after).outstandingCents).toBe(TOTAL);
  });
});

describe('the vocabulary', () => {
  it('carries the three kinds the counter reaches for', () => {
    expect([...ADJUSTMENT_KINDS]).toEqual(['comp', 'partial', 'reversal']);
  });

  // Neither is staff-pickable, and for the same reason: the preset answers
  // "why were things comped on Friday", and a reward's reason or a
  // correction's reason on that list would make the GROUP BY lie.
  it('keeps the written reasons out of the pickable preset', () => {
    expect(ADJUSTMENT_REASONS).not.toContain(ADJUSTMENT_REVERSAL_REASON);
    expect(isStaffAdjustmentReason(ADJUSTMENT_REVERSAL_REASON)).toBe(false);
  });

  it('keeps `other` in the preset, because it is the one that needs the note', () => {
    expect(ADJUSTMENT_REASONS).toContain('other');
  });
});
