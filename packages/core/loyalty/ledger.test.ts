// PRD 7 P0-2 and P0-3 (C-100). Every number is hand-calculated; decision 9's
// terms are 1 point per dollar, 100 points, $10 off.
import { describe, expect, it } from 'vitest';
import {
  hasReward,
  loyaltyBalance,
  planRedemption,
  pointsForOrder,
  pointsToNextReward,
  rewardsAvailable,
  type LedgerEntry,
  type LoyaltyTerms,
} from './ledger';

/** Decision 9, as configured. */
const TERMS: LoyaltyTerms = {
  pointsPerDollar: 1,
  rewardThresholdPoints: 100,
  rewardValueCents: 1000,
};

const earn = (points: number): LedgerEntry => ({ kind: 'earn', points });
const redeem = (points: number): LedgerEntry => ({ kind: 'redeem', points });
const adjust = (points: number): LedgerEntry => ({ kind: 'adjust', points });
const expire = (points: number): LedgerEntry => ({ kind: 'expire', points });

describe('loyaltyBalance', () => {
  // The PRD's own worked example, to the point.
  it('is the PRD case: +14, +9, +100, -100, +5 balances to 28', () => {
    expect(loyaltyBalance([earn(14), earn(9), earn(100), redeem(-100), adjust(5)])).toBe(28);
  });

  it('is zero, not NaN, on a member with no history', () => {
    expect(loyaltyBalance([])).toBe(0);
  });

  it('lets an expire take a balance to exactly zero', () => {
    expect(loyaltyBalance([earn(240), expire(-240)])).toBe(0);
  });

  it('sums a correction in either direction', () => {
    expect(loyaltyBalance([earn(50), adjust(-20)])).toBe(30);
  });
});

describe('pointsForOrder', () => {
  // The floor is a floor, and both of these are asserted rather than left to
  // be discovered by a customer counting.
  it('earns on whole dollars of SUBTOTAL, discarding the cents', () => {
    expect(pointsForOrder(2347, TERMS)).toBe(23);
    expect(pointsForOrder(2399, TERMS)).toBe(23);
    expect(pointsForOrder(2400, TERMS)).toBe(24);
  });

  it('earns nothing on tax, because tax is not the subtotal', () => {
    // $12.70 subtotal on a $13.75 order: the points come off 1270, not 1375.
    expect(pointsForOrder(1270, TERMS)).toBe(12);
  });

  it('earns nothing at all below a dollar, and nothing on nothing', () => {
    expect(pointsForOrder(99, TERMS)).toBe(0);
    expect(pointsForOrder(0, TERMS)).toBe(0);
  });

  it('never returns a negative, whatever it is handed', () => {
    expect(pointsForOrder(-500, TERMS)).toBe(0);
  });

  it('scales with the configured rate', () => {
    expect(pointsForOrder(2347, { ...TERMS, pointsPerDollar: 2 })).toBe(46);
  });
});

describe('what a balance is worth', () => {
  it('is a reward at exactly the threshold, and not one cent of a point below', () => {
    expect(hasReward(99, TERMS)).toBe(false);
    expect(hasReward(100, TERMS)).toBe(true);
  });

  it('counts whole rewards only', () => {
    expect(rewardsAvailable(250, TERMS)).toBe(2);
    expect(rewardsAvailable(0, TERMS)).toBe(0);
    expect(rewardsAvailable(-10, TERMS)).toBe(0);
  });

  it('says how far to go, and never says a negative number', () => {
    expect(pointsToNextReward(40, TERMS)).toBe(60);
    expect(pointsToNextReward(0, TERMS)).toBe(100);
    // Already there: zero is a nudge, a negative would be a bug on a screen.
    expect(pointsToNextReward(140, TERMS)).toBe(0);
  });
});

describe('planRedemption (P0-4)', () => {
  const base = {
    enabled: true,
    balance: 120,
    outstandingCents: 1375,
    alreadyRedeemed: false,
    terms: TERMS,
  };

  it('spends exactly the threshold and is worth exactly the reward', () => {
    const plan = planRedemption(base);
    expect(plan).toEqual({ ok: true, pointsSpent: -100, amountCents: 1000 });
  });

  it('refuses when the program is switched off', () => {
    const plan = planRedemption({ ...base, enabled: false });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('loyalty_disabled');
  });

  it('refuses below the threshold, and says how far short', () => {
    const plan = planRedemption({ ...base, balance: 60 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('not_enough_points');
    expect(plan.message).toContain('40');
  });

  it('REFUSES rather than clamping when the reward is worth more than is owed', () => {
    // A $10 reward against a $6.00 order. Clamping would silently turn it into
    // a $6 reward and tell nobody the customer lost four dollars of it.
    const plan = planRedemption({ ...base, outstandingCents: 600 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('reward_exceeds_balance_owed');
  });

  it('allows a reward against an order owing exactly its value', () => {
    expect(planRedemption({ ...base, outstandingCents: 1000 }).ok).toBe(true);
  });

  it('refuses a second reward on the same order, before it looks at points', () => {
    const plan = planRedemption({ ...base, alreadyRedeemed: true, balance: 100_000 });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe('already_redeemed_on_this_order');
  });
});
