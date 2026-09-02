// Making it right (PRD 3 P0-3, C-065).
//
// The operator's complaint, word for word: there is no way to make an order
// right. A burrito goes out wrong at 7:20 and the only controls the product
// has are `cancel` — which the state machine correctly refuses on cooked food
// — and collecting the full amount anyway. So the counter does the honest
// thing off-system, and the till and the report disagree by an amount nobody
// wrote down.
//
// THE SHAPE IS THE WHOLE DESIGN, and it is decision 6 of 2026-09-01: an
// adjustment is an append-only RECORD OF A DECISION THE COUNTER MADE. It moves
// no money, calls no processor, and — this is the part that is not negotiable —
// it never touches `subtotalCents`, `taxCents` or `totalCents`. The obvious
// version ("comp it, subtract from the total") mutates a snapshot column and
// is refused: `Order.totalCents` is what the customer was charged at
// placement, forever, and the balance is a computation beside it rather than
// an edit to it.
//
// PURE, like everything else in this package. It takes the order's own money
// and returns an event to append; it reads no clock and no database.
import { MAX_CANCEL_NOTE_LENGTH, type OrderEventDraft } from './state-machine';
import { paymentTotals, type MoneyEvent } from './payment';

/**
 * The two kinds the counter actually reaches for.
 *
 * `remake` is the third in P0-3 and is deliberately NOT here: it carries a
 * link to the order it replaces (`relatedOrderId`), and a remake kind with no
 * link is a word on a screen rather than the number "we remade six tickets
 * Friday". C-066 adds the column and the kind together.
 */
export const ADJUSTMENT_KINDS = ['comp', 'partial'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/** The short preset, in the shape `CANCEL_REASONS` established. `other`
 *  requires free text, for the same reason it does there: "other" with no note
 *  is the row nobody can act on in a week.
 *
 *  THE STAFF-PICKABLE SET, and after C-104 that is narrower than the set of
 *  reasons an adjustment may carry — see `LOYALTY_REWARD_REASON`. Both
 *  dropdowns and the form action read THIS one. */
export const ADJUSTMENT_REASONS = ['wrong_item', 'late', 'quality', 'other'] as const;

/**
 * The reason a punch-card redemption writes (PRD 7 P0-4, C-104).
 *
 * DELIBERATELY NOT IN `ADJUSTMENT_REASONS`, and that is the whole point of the
 * split rather than a naming preference. The lists have different jobs: this
 * is a reason the SYSTEM writes when points were actually spent, and the
 * preset above is what a person may choose. Folding it into one list would
 * put "punch card reward" in the Make-it-right dropdown, where picking it
 * takes ten dollars off an order and moves no points — the redemption's money
 * without its ledger row, which is the one thing P0-4 exists to keep paired.
 *
 * The form action keeps validating against `ADJUSTMENT_REASONS`, so a
 * hand-crafted POST cannot reach it either.
 */
export const LOYALTY_REWARD_REASON = 'loyalty_reward';

export type AdjustmentReason =
  | (typeof ADJUSTMENT_REASONS)[number]
  | typeof LOYALTY_REWARD_REASON;

/**
 * Whether a PERSON may pick this reason (C-104).
 *
 * The same list the dropdowns render, asked as a question, so the options on
 * the screen and the guard in the form action cannot drift. `loyalty_reward`
 * fails it — which is what stops a hand-crafted POST writing a reward's money
 * without the ledger row that pays for it.
 */
export const isStaffAdjustmentReason = (
  value: string,
): value is (typeof ADJUSTMENT_REASONS)[number] =>
  (ADJUSTMENT_REASONS as readonly string[]).includes(value);

/** What the ENGINE accepts. One list, so a fifth reason is added in one place
 *  and `ADJUSTMENT_REASON_LABEL`'s `Record` still forces a word for it. */
const WRITABLE_REASONS: readonly AdjustmentReason[] = [
  ...ADJUSTMENT_REASONS,
  LOYALTY_REWARD_REASON,
];

export type AdjustmentRefusalReason =
  | 'unknown_adjustment_kind'
  | 'unknown_adjustment_reason'
  | 'adjustment_note_required'
  | 'adjustment_note_too_long'
  | 'adjustment_amount_invalid'
  | 'adjustment_exceeds_total'
  | 'nothing_left_to_adjust';

export type AdjustmentInput = {
  kind: AdjustmentKind;
  /** Cents. Ignored for `comp`, where the server computes the amount rather
   *  than trusting one — see `adjustmentEvent`. */
  amountCents?: number;
  reason: AdjustmentReason;
  note?: string;
};

export type AdjustmentResult =
  | { ok: true; event: OrderEventDraft }
  | { ok: false; reason: AdjustmentRefusalReason; message: string };

/** Enough of an order to adjust it. A database row satisfies it structurally,
 *  like every other input here. */
export type AdjustableOrder = {
  /** The snapshot's total. Read, never written. */
  totalCents: number;
  events: readonly MoneyEvent[];
};

/**
 * How much of this order has not been adjusted away yet.
 *
 * THE BOUND IS CUMULATIVE, not per-adjustment, and that is the whole point of
 * this function existing separately. "An adjustment larger than the order
 * total is refused" is easy to read as a single-amount check — and a
 * single-amount check lets two $10 comps land on a $13.75 order, which is a
 * restaurant giving away more than it ever charged and no constraint noticing.
 *
 * Two readers, deliberately: the validation below, and the screen, which needs
 * the same number to decide whether to offer the control at all and what
 * maximum to show. One answer to "how much is left", like every other
 * single-source rule in this codebase.
 */
export function adjustableRemainingCents(order: AdjustableOrder): number {
  return Math.max(0, order.totalCents - paymentTotals(order.events).adjustedCents);
}

/**
 * Validate an adjustment and produce the event to append, or refuse it.
 *
 * ONE FUNCTION for both halves on purpose: there is no way to hand a caller a
 * validated amount and let them build the event themselves, so there is no
 * path that writes an amount nothing checked. The server-is-the-price-authority
 * rule (CLAUDE.md), applied to a number that arrives from a screen.
 *
 * A COMP DOES NOT TAKE AN AMOUNT FROM THE CLIENT. It is defined as "the whole
 * order, zero to the customer", so the amount is what is left to adjust — a
 * figure derived from the order's own snapshot. Validating a client's idea of
 * the total would be strictly worse than not asking for it.
 *
 * Out of range is REFUSED, never clamped. A clamp silently turns "comp $50 of
 * this $13.75 order" into a legal $13.75 comp and tells nobody a wrong number
 * was typed; the counter finds out at close, from the till.
 */
export function adjustmentEvent(
  order: AdjustableOrder,
  input: AdjustmentInput,
  now: Date,
): AdjustmentResult {
  if (!ADJUSTMENT_KINDS.includes(input.kind)) {
    return refuse('unknown_adjustment_kind', `"${input.kind}" is not an adjustment.`);
  }
  if (!WRITABLE_REASONS.includes(input.reason)) {
    return refuse('unknown_adjustment_reason', `"${input.reason}" is not an adjustment reason.`);
  }
  if (input.reason === 'other' && !input.note?.trim()) {
    return refuse('adjustment_note_required', 'Say what happened.');
  }
  // The same cap the cancel note uses. One number rather than a second
  // constant holding the same 140: they are both a line of free text a person
  // types into a log, and two names for that would be two things to keep level.
  if ((input.note?.length ?? 0) > MAX_CANCEL_NOTE_LENGTH) {
    return refuse(
      'adjustment_note_too_long',
      `Keep the note to ${MAX_CANCEL_NOTE_LENGTH} characters.`,
    );
  }

  const remainingCents = adjustableRemainingCents(order);
  if (remainingCents === 0) {
    return refuse('nothing_left_to_adjust', 'This order has already been adjusted in full.');
  }

  // The comp's amount is DERIVED; the partial's is the client's and is checked.
  const amountCents = input.kind === 'comp' ? remainingCents : (input.amountCents ?? Number.NaN);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return refuse('adjustment_amount_invalid', 'An adjustment is a whole number of cents above zero.');
  }
  if (amountCents > remainingCents) {
    return refuse(
      'adjustment_exceeds_total',
      `That is more than the ${formatBound(remainingCents)} left to adjust on this order.`,
    );
  }

  return {
    ok: true,
    event: {
      at: now,
      kind: 'adjustment',
      // NOT a status change: an adjustment is money, and the order is wherever
      // it was. Null on both, so the time-in-state tally steps over it exactly
      // as it steps over `payment` and `refund`.
      fromStatus: null,
      toStatus: null,
      // The counter decided. `system` would be a lie and `customer` doubly so.
      actor: 'staff',
      // The PRESET goes in the column, the free text goes in `detail` — the
      // shape `cancel` established, so "why were things comped on Friday" is a
      // GROUP BY rather than a scan of typed sentences.
      reason: input.reason,
      amountCents,
      detail: {
        amountCents,
        adjustment: input.kind,
        ...(input.note?.trim() ? { note: input.note.trim() } : {}),
      },
    },
  };
}

const refuse = (reason: AdjustmentRefusalReason, message: string): AdjustmentResult => ({
  ok: false,
  reason,
  message,
});

/** Dollars for one refusal message. Not the app's `formatCents` — this package
 *  has no currency formatter and does not want one; the message needs a number
 *  a person recognises, not a locale.
 *
 *  Integer arithmetic even here. `(cents / 100).toFixed(2)` would read the same
 *  on every value this can be handed, and CLAUDE.md's rule is that there is no
 *  float in the money path — including the part of it a person reads, because
 *  a formatter is exactly where a float gets reintroduced by somebody who is
 *  sure it is only for display. */
const formatBound = (cents: number): string =>
  `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
