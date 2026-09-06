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
import { formatBoundCents, paymentTotals, type MoneyEvent } from './payment';

/**
 * The two kinds the counter actually reaches for.
 *
 * `remake` is the third in P0-3 and is deliberately NOT here: it carries a
 * link to the order it replaces (`relatedOrderId`), and a remake kind with no
 * link is a word on a screen rather than the number "we remade six tickets
 * Friday". C-066 adds the column and the kind together.
 */
export const ADJUSTMENT_KINDS = ['comp', 'partial', 'reversal'] as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KINDS)[number];

/**
 * The one the counter reaches for when they comped the wrong ticket (C-071).
 *
 * A CONTRADICTING ROW, never a delete, and the log's append-only trigger means
 * that is not a preference. C-065 and C-066 both deferred this and both said
 * why in the same words: a comp is a decision, and a decision that disappears
 * is one nobody can be asked about at close. So the correction is a second
 * decision written beside the first, and both are still there on Sunday.
 *
 * It is in `ADJUSTMENT_KINDS` above rather than in a module of its own for the
 * reason the whole file exists: `adjustmentEvent` is the only thing that may
 * decide an adjustment's amount, and a reversal is an amount decided against
 * that same order's own money. A second writer would be a second bound.
 *
 * Its BOUND is the mirror of the other two. A comp and a partial are bounded
 * by what is left to adjust; a reversal is bounded by what has been adjusted
 * and not yet taken back, which is exactly `paymentTotals`' net `adjustedCents`
 * — so reversing twice cannot manufacture money the order never gave away.
 */
export const isReversal = (kind: AdjustmentKind): kind is 'reversal' => kind === 'reversal';

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

/**
 * The reason a reversal writes (C-071).
 *
 * DELIBERATELY NOT IN `ADJUSTMENT_REASONS`, on the same argument that keeps
 * `loyalty_reward` out of it: the preset is the set a person may pick FOR a
 * comp, and none of its four words is true of taking one back. "Wrong item"
 * on a reversal would put the original comp's own reason on the row that
 * cancels it, and "why were things comped on Friday" — the GROUP BY the reason
 * column exists for — would count the mistake twice and the correction never.
 *
 * The reversal has no dropdown at all. There is one reason to write one, the
 * note is where it is explained, and the note is REQUIRED: money coming back
 * onto a customer's bill is the one adjustment nobody should be able to make
 * silently.
 */
export const ADJUSTMENT_REVERSAL_REASON = 'mistake';

export type AdjustmentReason =
  | (typeof ADJUSTMENT_REASONS)[number]
  | typeof LOYALTY_REWARD_REASON
  | typeof ADJUSTMENT_REVERSAL_REASON;

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
  ADJUSTMENT_REVERSAL_REASON,
];

export type AdjustmentRefusalReason =
  | 'unknown_adjustment_kind'
  | 'unknown_adjustment_reason'
  | 'adjustment_note_required'
  | 'adjustment_note_too_long'
  | 'adjustment_amount_invalid'
  | 'adjustment_exceeds_total'
  | 'nothing_left_to_adjust'
  | 'reversal_exceeds_adjusted'
  | 'nothing_to_reverse';

export type AdjustmentInput = {
  kind: AdjustmentKind;
  /** Cents. Ignored for `comp`, where the server computes the amount rather
   *  than trusting one — see `adjustmentEvent`. Required for `partial` and for
   *  `reversal`: taking back PART of a comp is the ordinary case (two comps
   *  landed, one of them on the wrong ticket), so there is no whole-thing
   *  reading the server could derive. */
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

  // A reversal ALWAYS carries a note, whatever its reason says (C-071). The
  // other two kinds are a decision about the customer's food; this one is a
  // decision about a colleague's decision, and it puts money back onto a bill
  // somebody has already been told they do not owe. "Why is this $10 back?" is
  // a question that gets asked, and the row has to answer it without anybody
  // being available to.
  if (isReversal(input.kind) && !input.note?.trim()) {
    return refuse('adjustment_note_required', 'Say what was wrong with the original.');
  }

  // THE BOUND IS THE MIRROR. Comp and partial spend what is left of the order;
  // a reversal spends what has already been given away — `paymentTotals`' NET
  // `adjustedCents`, which has the reversals already subtracted out of it, so
  // reversing twice cannot take back more than was ever comped.
  const boundCents = isReversal(input.kind)
    ? paymentTotals(order.events).adjustedCents
    : adjustableRemainingCents(order);
  if (boundCents === 0) {
    return isReversal(input.kind)
      ? refuse('nothing_to_reverse', 'There is nothing on this order left to take back.')
      : refuse('nothing_left_to_adjust', 'This order has already been adjusted in full.');
  }

  // The comp's amount is DERIVED; the other two are the client's and are
  // checked. A reversal has no whole-thing reading to derive: the ordinary
  // case is two comps on an order and one of them written on the wrong ticket.
  const amountCents = input.kind === 'comp' ? boundCents : (input.amountCents ?? Number.NaN);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return refuse('adjustment_amount_invalid', 'An adjustment is a whole number of cents above zero.');
  }
  if (amountCents > boundCents) {
    return isReversal(input.kind)
      ? refuse(
          'reversal_exceeds_adjusted',
          `That is more than the ${formatBoundCents(boundCents)} taken off this order.`,
        )
      : refuse(
          'adjustment_exceeds_total',
          `That is more than the ${formatBoundCents(boundCents)} left to adjust on this order.`,
        );
  }

  return {
    ok: true,
    event: {
      at: now,
      // ITS OWN KIND, not a negative `adjustment` (C-071). `amountCents` is
      // unsigned and the database's CHECK says so; direction has been the kind
      // since C-063, and `paymentTotals` subtracts this one out of the net.
      kind: isReversal(input.kind) ? 'adjustment_reversed' : 'adjustment',
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
