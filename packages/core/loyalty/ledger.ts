// The loyalty ledger (PRD 7 P0-2, C-100).
//
// Decision 8 of 2026-09-02: the master PRD's loyalty Non-Goal is lifted, by the
// owner. This document's own PRD recommended shelving it; that was read and
// overruled. What survives of the Non-Goal is a boundary — ONE INTEGER PER
// MEMBER, and a second entitlement dimension (tiers, birthdays, streaks) is
// where the objection it encoded genuinely begins.
//
// PURE, like every other module here: it takes events and returns numbers. No
// clock, no database, no order row — which is what lets the balance be driven
// over a whole seeded rush in a unit test, the same property `derivePaymentState`
// has and for the same reason.
//
// THERE IS NO BALANCE COLUMN, deliberately. `paymentState` earned its cache
// because every existing surface already read it; a loyalty balance has no
// such reader and a cached one would be a second answer that can disagree with
// the ledger. If one is ever added it is a derived cache with an agreement
// test, and that is a later decision with a written reason.

export const LOYALTY_EVENT_KINDS = ['earn', 'redeem', 'adjust', 'expire'] as const;
export type LoyaltyEventKind = (typeof LOYALTY_EVENT_KINDS)[number];

/** Enough of a ledger row to sum. A database row satisfies it structurally, so
 *  nothing has to map and no shape can drift between them. */
export type LedgerEntry = {
  kind: LoyaltyEventKind;
  /** SIGNED. Positive on `earn`, negative on `redeem` and `expire`, either
   *  direction on `adjust` — and a CHECK in the database says the same thing,
   *  so an unsigned row cannot exist to be summed wrongly here. */
  points: number;
};

/**
 * What a member has. A plain sum, and that is the entire design.
 *
 * The sign lives on the row rather than in this function's knowledge of the
 * kinds, which is the opposite of the choice `paymentTotals` makes about
 * money — and the difference is deliberate. Money's direction has to be its
 * KIND, because a balance that trusted a sign could not tell a refund from a
 * negative payment and both would sum identically. A points ledger has no such
 * ambiguity: there is one column, one direction per kind, and a CHECK holding
 * it. So the sum stays a sum, and adding a fifth kind does not edit this line.
 */
export function loyaltyBalance(entries: readonly LedgerEntry[]): number {
  return entries.reduce((sum, entry) => sum + entry.points, 0);
}

/** The program's numbers, as configured (decision 9: 1, 100, 1000). */
export type LoyaltyTerms = {
  pointsPerDollar: number;
  rewardThresholdPoints: number;
  rewardValueCents: number;
};

/**
 * What an order earns (P0-3).
 *
 * `floor(subtotal / 100) × pointsPerDollar`, read from the order's
 * SNAPSHOTTED subtotal. **Tax earns nothing** — a customer does not earn
 * loyalty on money the restaurant collects for the state — and the whole
 * number is a function of columns already written and frozen, so no live menu
 * row and no recomputation is involved.
 *
 * Integer arithmetic throughout. `Math.floor` on a division of two integers is
 * exact; there is no float in the money path, including this one.
 *
 * $23.47 and $23.99 both earn 23. That is the floor being a floor, and it is
 * asserted rather than left to be discovered.
 */
export function pointsForOrder(subtotalCents: number, terms: LoyaltyTerms): number {
  if (subtotalCents <= 0) return 0;
  return Math.floor(subtotalCents / 100) * terms.pointsPerDollar;
}

/** How many whole rewards a balance is worth. */
export const rewardsAvailable = (balance: number, terms: LoyaltyTerms): number =>
  balance <= 0 ? 0 : Math.floor(balance / terms.rewardThresholdPoints);

/** Whether the counter can offer one right now. The question the queue card
 *  and the staff panel both ask, so it is one function and not two `>=`s. */
export const hasReward = (balance: number, terms: LoyaltyTerms): boolean =>
  rewardsAvailable(balance, terms) >= 1;

/** Points still needed for the next reward. Zero when one is already available
 *  — "0 points to go" is a nudge; a negative number is a bug on a screen. */
export function pointsToNextReward(balance: number, terms: LoyaltyTerms): number {
  if (hasReward(balance, terms)) return 0;
  return terms.rewardThresholdPoints - Math.max(0, balance);
}

export type RedemptionRefusalReason =
  | 'loyalty_disabled'
  | 'not_enough_points'
  | 'reward_exceeds_balance_owed'
  | 'already_redeemed_on_this_order';

export type RedemptionPlan =
  | { ok: true; pointsSpent: number; amountCents: number }
  | { ok: false; reason: RedemptionRefusalReason; message: string };

/**
 * Whether a reward can be spent against this order, and for exactly what
 * (P0-4). One function, so the screen that offers the control and the write
 * that performs it cannot disagree about the answer.
 *
 * APPLIED AFTER TAX, to the amount still OWED. That is a real decision with a
 * real price, not a technicality: the honest version — a discount before tax —
 * needs a snapshotted `Order.discountCents` and `subtotal − discount` as the
 * tax base, because `priceOrder` defines `subtotalCents` as exactly the sum of
 * the lines and a discount breaking that identity breaks every receipt that
 * reconciles. That is P1-1 and it moves with SMS verification or not at all.
 * The cost of the version built here is that the customer pays tax on food
 * they did not pay for, and the copy therefore says "$10 off your total" and
 * never "a free burrito".
 *
 * REFUSED, NEVER CLAMPED, when the reward is worth more than the order owes —
 * the same rule PRD 3 applies to an over-large adjustment, and the same
 * reason: a clamp silently converts a $10 reward into a $6 one and nobody is
 * told the customer lost four dollars of it.
 */
export function planRedemption(input: {
  enabled: boolean;
  balance: number;
  outstandingCents: number;
  alreadyRedeemed: boolean;
  terms: LoyaltyTerms;
}): RedemptionPlan {
  const { enabled, balance, outstandingCents, alreadyRedeemed, terms } = input;
  if (!enabled) {
    return refuse('loyalty_disabled', 'The loyalty program is switched off.');
  }
  // Checked before the balance, so an order that already carries a reward says
  // so rather than reporting whatever the points happen to be.
  if (alreadyRedeemed) {
    return refuse(
      'already_redeemed_on_this_order',
      'A reward has already been used on this order.',
    );
  }
  if (!hasReward(balance, terms)) {
    return refuse(
      'not_enough_points',
      `That is ${pointsToNextReward(balance, terms)} points short of a reward.`,
    );
  }
  if (terms.rewardValueCents > outstandingCents) {
    return refuse(
      'reward_exceeds_balance_owed',
      'This order does not owe enough to use a whole reward on it.',
    );
  }
  return {
    ok: true,
    // Negative: the sign is the direction on this ledger.
    pointsSpent: -terms.rewardThresholdPoints,
    amountCents: terms.rewardValueCents,
  };
}

const refuse = (reason: RedemptionRefusalReason, message: string): RedemptionPlan => ({
  ok: false,
  reason,
  message,
});
