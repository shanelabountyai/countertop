// PRD 7 P0-2 and P0-3 (C-100). Every number is hand-calculated; decision 9's
// terms are 1 point per dollar, 100 points, $10 off.
import { describe, expect, it } from 'vitest';
import {
  hasReward,
  loyaltyBalance,
  loyaltyLiability,
  redemptionRate,
  planCheckoutRedemption,
  planRedemption,
  pointsForOrder,
  redemptionStateFor,
  settleRedemption,
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

// P1-2 (C-106). The liability is the one number this program cannot be judged
// without, and every figure below is hand-calculated from decision 9's terms.
describe('what the program owes', () => {
  it('values every outstanding point, and separately what is spendable today', () => {
    // Three members: 250, 40 and 100. 390 points at 10c each is $39.00
    // accrued — but only three whole rewards exist (2 + 0 + 1), worth $30.00,
    // and $9.00 of it is stranded across two people who cannot spend it yet.
    expect(loyaltyLiability([250, 40, 100], TERMS)).toEqual({
      points: 390,
      accruedCents: 3900,
      rewardsOutstanding: 3,
      redeemableCents: 3000,
      membersWithReward: 2,
    });
  });

  it('is zero on an empty program rather than a divide by nothing', () => {
    expect(loyaltyLiability([], TERMS)).toEqual({
      points: 0,
      accruedCents: 0,
      rewardsOutstanding: 0,
      redeemableCents: 0,
      membersWithReward: 0,
    });
  });

  it('counts a zero balance as a member with nothing, not as a member missing', () => {
    // An enrolled customer who has not been back. They exist, they own no
    // points, and the count of members is not this function's job.
    expect(loyaltyLiability([0, 0], TERMS)).toMatchObject({ points: 0, rewardsOutstanding: 0 });
  });

  it('refuses to net a negative balance against somebody else’s real points', () => {
    // Cannot happen through the product — a staff `adjust` is the one row a
    // person types, and one fat finger must not quietly reduce what the shop
    // owes everybody else.
    expect(loyaltyLiability([-500, 200], TERMS)).toMatchObject({
      points: 200,
      accruedCents: 2000,
      rewardsOutstanding: 2,
      membersWithReward: 1,
    });
  });

  it('rounds the accrual half-up to the cent', () => {
    // A reward of $10.01 over 3 points is 333.667c per point. One point is
    // 333.67c, and two are 667.33c — rounded, never truncated, because a
    // liability rounded down is a liability understated.
    const odd: LoyaltyTerms = { pointsPerDollar: 1, rewardThresholdPoints: 3, rewardValueCents: 1001 };
    expect(loyaltyLiability([1], odd).accruedCents).toBe(334);
    expect(loyaltyLiability([2], odd).accruedCents).toBe(667);
    // And three points is exactly one reward, both ways round.
    expect(loyaltyLiability([3], odd)).toMatchObject({ accruedCents: 1001, redeemableCents: 1001 });
  });

  it('reads the terms rather than decision 9’s numbers', () => {
    const generous: LoyaltyTerms = {
      pointsPerDollar: 2,
      rewardThresholdPoints: 50,
      rewardValueCents: 500,
    };
    expect(loyaltyLiability([250], generous)).toMatchObject({
      accruedCents: 2500,
      rewardsOutstanding: 5,
      redeemableCents: 2500,
    });
  });
});

describe('the redemption rate', () => {
  it('is what came back over what was issued', () => {
    expect(redemptionRate(1000, 400)).toBe(0.4);
  });

  it('is null when nothing was issued, not zero', () => {
    // "0.0%" reads as a program nobody is using; a window with no earns has no
    // rate at all. Same treatment the sales report gives its no-show rate.
    expect(redemptionRate(0, 0)).toBeNull();
    expect(redemptionRate(0, 300)).toBeNull();
  });

  it('is allowed above 1, because a punch card is saved up across windows', () => {
    expect(redemptionRate(100, 300)).toBe(3);
  });
});

// --- The CHECKOUT redemption (P1-1, C-118) ---------------------------------

describe('planning a redemption at checkout', () => {
  it('spends a whole reward against the food, before tax', () => {
    // 100 points, $10 off, on $23.00 of food. The tax base becomes $13.00 —
    // which is `priceOrder`'s job, not this function's; this one only says
    // how much and how many points.
    expect(planCheckoutRedemption({ enabled: true, balance: 100, subtotalCents: 2300, terms: TERMS }))
      .toEqual({ ok: true, pointsSpent: -100, amountCents: 1000 });
  });

  it('is bounded by the SUBTOTAL, not by anything a client sent', () => {
    // $9.99 of food and a $10 reward. Refused by name — never clamped to
    // $9.99, which would silently cost the customer a cent of their reward,
    // and never allowed through to Postgres, where C-117's
    // `discountCents <= subtotalCents` CHECK would make it a 500.
    const plan = planCheckoutRedemption({
      enabled: true,
      balance: 100,
      subtotalCents: 999,
      terms: TERMS,
    });
    expect(plan).toMatchObject({ ok: false, reason: 'reward_exceeds_subtotal' });
    // Exactly the reward's worth IS enough — the CHECK is `<=`, and so is this.
    expect(
      planCheckoutRedemption({ enabled: true, balance: 100, subtotalCents: 1000, terms: TERMS }),
    ).toMatchObject({ ok: true, amountCents: 1000 });
  });

  it('refuses a balance short of a whole reward, and says by how much', () => {
    const plan = planCheckoutRedemption({
      enabled: true,
      balance: 87,
      subtotalCents: 5000,
      terms: TERMS,
    });
    expect(plan).toMatchObject({ ok: false, reason: 'not_enough_points' });
    expect(plan.ok ? '' : plan.message).toContain('13 points');
  });

  it('refuses with the program switched off, before it looks at anything else', () => {
    // Off beats a balance that would otherwise qualify: the switch is the
    // authority, exactly as it is for enrolment and for the counter flow.
    expect(
      planCheckoutRedemption({ enabled: false, balance: 900, subtotalCents: 9000, terms: TERMS }),
    ).toMatchObject({ ok: false, reason: 'loyalty_disabled' });
  });

  it('is a DIFFERENT question from the counter’s, on the same numbers', () => {
    // $10.00 of food, fully prepaid. The counter refuses — nothing is owed, so
    // there is nothing to take $10 off — and checkout allows, because the food
    // itself costs enough. Two bounds, two answers, and this is exactly why
    // they are two functions.
    expect(
      planRedemption({
        enabled: true,
        balance: 100,
        outstandingCents: 0,
        alreadyRedeemed: false,
        terms: TERMS,
      }),
    ).toMatchObject({ ok: false, reason: 'reward_exceeds_balance_owed' });
    expect(
      planCheckoutRedemption({ enabled: true, balance: 100, subtotalCents: 1000, terms: TERMS }),
    ).toMatchObject({ ok: true });
  });
});

describe('what a checkout redemption is worth once the order has a fate', () => {
  it('is held while the food is being made and once it is sold', () => {
    expect(redemptionStateFor('in_flight')).toBe('spent');
    expect(redemptionStateFor('sold')).toBe('spent');
  });

  it('comes back when nobody got the food', () => {
    expect(redemptionStateFor('cancelled')).toBe('returned');
    expect(redemptionStateFor('no_show')).toBe('returned');
  });
});

describe('settling a checkout redemption', () => {
  it('writes nothing for an order that never spent a reward', () => {
    expect(settleRedemption({ redeemedPoints: null, compensations: [], target: 'returned' }))
      .toBeNull();
  });

  it('returns the points a cancelled order took', () => {
    expect(settleRedemption({ redeemedPoints: -100, compensations: [], target: 'returned' }))
      .toBe(100);
  });

  it('is idempotent — a second cancel-shaped settlement writes nothing', () => {
    // A zero row would fail the ledger's own `adjust` CHECK, correctly.
    expect(settleRedemption({ redeemedPoints: -100, compensations: [100], target: 'returned' }))
      .toBeNull();
  });

  it('re-spends on the way back, so a reverted no-show cannot keep both', () => {
    // `abandoned` is revertable (`previous: 'ready'`). Without this the
    // customer who finally walks in has the $10 off AND the 100 points that
    // bought it.
    expect(settleRedemption({ redeemedPoints: -100, compensations: [100], target: 'spent' }))
      .toBe(-100);
    // And then settles flat again.
    expect(settleRedemption({ redeemedPoints: -100, compensations: [100, -100], target: 'spent' }))
      .toBeNull();
    // Round three: abandoned a second time.
    expect(settleRedemption({ redeemedPoints: -100, compensations: [100, -100], target: 'returned' }))
      .toBe(100);
  });

  it('writes nothing for an order that is spent and has never been compensated', () => {
    expect(settleRedemption({ redeemedPoints: -100, compensations: [], target: 'spent' })).toBeNull();
  });
});
