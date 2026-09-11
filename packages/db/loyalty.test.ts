// What the DATABASE refuses about a loyalty ledger (PRD 7 P0-2, C-100).
//
// The core suite proves the arithmetic. These prove the mechanisms — every one
// of them a thing the application code is then allowed to be careless about,
// which is the discipline this repo applies to order numbers, idempotency keys
// and money amounts.
import { instantMinutesAfter, loyaltyBalance, orderBalance } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import {
  confirmCheckoutRedemption,
  enrolMember,
  lockMemberBalance,
  expireInactiveBalances,
  loadLoyaltyProgram,
  memberByPhone,
  phoneDigest,
  redeemReward,
  setLoyaltyEnabled,
} from './loyalty';
import { placeOrder } from './placement';
import {
  confirmPhoneVerificationForCheckout,
  startPhoneVerification,
} from './verification';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';
import { applyOrderAction } from './transitions';

const AT = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

const member = (overrides: Record<string, unknown> = {}) =>
  prisma.loyaltyMember.create({
    data: {
      phoneDigest: `digest-${Math.random()}`,
      phoneLast4: '2233',
      displayName: 'Ivy Castellanos',
      enrolledAt: AT,
      lastActivityAt: AT,
      ...overrides,
    },
  });

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
  await seedStaff();
});

describe('the member', () => {
  it('is one member per phone digest', async () => {
    await member({ phoneDigest: 'same' });
    await expect(member({ phoneDigest: 'same' })).rejects.toThrow();
  });

  it('refuses a last4 that is not exactly four digits', async () => {
    for (const phoneLast4 of ['', '123', '12345', 'abcd']) {
      await expect(member({ phoneLast4 })).rejects.toThrow(
        /loyalty_member_last4_is_four_digits|too long/,
      );
    }
  });

  it('refuses a blank display name', async () => {
    await expect(member({ displayName: '   ' })).rejects.toThrow(
      /loyalty_member_name_not_blank/,
    );
  });
});

describe('the ledger', () => {
  it('ties the SIGN to the kind, in both directions', async () => {
    const m = await member();
    const row = (kind: string, points: number, amountCents: number | null = null) =>
      prisma.loyaltyEvent.create({
        data: { memberId: m.id, at: AT, kind: kind as 'earn', points, amountCents },
      });

    // Wrong-signed, every kind.
    await expect(row('earn', -5)).rejects.toThrow(/loyalty_event_sign_matches_kind/);
    await expect(row('redeem', 5, 1000)).rejects.toThrow(/loyalty_event_sign_matches_kind/);
    await expect(row('expire', 5)).rejects.toThrow(/loyalty_event_sign_matches_kind/);
    // A zero adjustment is a row recording a decision nobody made.
    await expect(row('adjust', 0)).rejects.toThrow(/loyalty_event_sign_matches_kind/);

    // And the legal directions, including an adjust either way.
    await expect(row('earn', 5)).resolves.toBeTruthy();
    await expect(row('adjust', -5)).resolves.toBeTruthy();
    await expect(row('adjust', 5)).resolves.toBeTruthy();
  });

  it('carries money on a redeem and on nothing else', async () => {
    const m = await member();
    await expect(
      prisma.loyaltyEvent.create({
        data: { memberId: m.id, at: AT, kind: 'redeem', points: -100, amountCents: null },
      }),
    ).rejects.toThrow(/loyalty_event_amount_matches_kind/);

    await expect(
      prisma.loyaltyEvent.create({
        data: { memberId: m.id, at: AT, kind: 'earn', points: 10, amountCents: 500 },
      }),
    ).rejects.toThrow(/loyalty_event_amount_matches_kind/);
  });

  it('refuses a negative reward value — direction is the POINTS column', async () => {
    const m = await member();
    await expect(
      prisma.loyaltyEvent.create({
        data: { memberId: m.id, at: AT, kind: 'redeem', points: -100, amountCents: -1000 },
      }),
    ).rejects.toThrow(/loyalty_event_amount_not_negative/);
  });

  it('is append-only for UPDATE — a mistake is contradicted, never edited', async () => {
    const m = await member();
    const row = await prisma.loyaltyEvent.create({
      data: { memberId: m.id, at: AT, kind: 'earn', points: 10 },
    });
    await expect(
      prisma.loyaltyEvent.update({ where: { id: row.id }, data: { points: 9999 } }),
    ).rejects.toThrow(/append-only/);
  });
});

describe('one earn per order (P0-3’s whole mechanism)', () => {
  it('refuses a second earn on the same order, and allows other kinds on it', async () => {
    const m = await member();
    const placed = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: 1095,
            composition: {
              itemId: 'burrito',
              quantity: 1,
              selections: [{ groupId: 'protein', optionId: 'chicken' }],
            },
          },
        ],
      },
      customerName: 'Ivy',
      idempotencyKey: 'c8f2b0e1-0000-4000-8000-000000000001',
      now: AT,
    });
    if (!placed.ok) throw new Error('placement refused');

    const earn = () =>
      prisma.loyaltyEvent.create({
        data: { memberId: m.id, orderId: placed.order.id, at: AT, kind: 'earn', points: 10 },
      });

    await expect(earn()).resolves.toBeTruthy();
    // The state machine permits reverts, so `ready -> picked_up` can happen
    // twice on one order. THE CONSTRAINT is what stops the second earn; the
    // code path's care is UX.
    await expect(earn()).rejects.toThrow();

    // A redemption on the same order is a different kind and is unaffected —
    // the index is partial for exactly this reason.
    await expect(
      prisma.loyaltyEvent.create({
        data: {
          memberId: m.id,
          orderId: placed.order.id,
          at: AT,
          kind: 'redeem',
          points: -100,
          amountCents: 1000,
        },
      }),
    ).resolves.toBeTruthy();

    // Two DIFFERENT orders each earning is the ordinary case and must work;
    // a plain unique index on orderId would still allow it, but a plain unique
    // index on (memberId) would not, and that is the shape to get wrong.
    expect(
      loyaltyBalance(
        await prisma.loyaltyEvent.findMany({
          where: { memberId: m.id },
          select: { kind: true, points: true },
        }),
      ),
    ).toBe(-90);
  });
});

describe('what outlives what', () => {
  it('takes the ledger with the member — the forget path is a real delete', async () => {
    const m = await member();
    await prisma.loyaltyEvent.create({
      data: { memberId: m.id, at: AT, kind: 'earn', points: 10 },
    });

    await prisma.loyaltyMember.delete({ where: { id: m.id } });
    expect(await prisma.loyaltyEvent.count({ where: { memberId: m.id } })).toBe(0);
  });

  it('refuses to delete a staff member a correction is attributed to', async () => {
    const m = await member();
    await prisma.loyaltyEvent.create({
      data: { memberId: m.id, at: AT, kind: 'adjust', points: 5, staffId: 'staff-noor' },
    });
    await expect(prisma.staffMember.delete({ where: { id: 'staff-noor' } })).rejects.toThrow();
  });
});

describe('the program is off by default (P0-1)', () => {
  it('is switched off in a freshly seeded restaurant', async () => {
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({
      where: { id: 'singleton' },
    });
    expect(settings.loyaltyEnabled).toBe(false);
    // Decision 9's numbers are configured and waiting.
    expect(settings.pointsPerDollar).toBe(1);
    expect(settings.rewardThresholdPoints).toBe(100);
    expect(settings.rewardValueCents).toBe(1000);
    // Decision 10.
    expect(settings.loyaltyExpiryDays).toBe(365);
  });

  it('refuses a program configured with nonsense numbers', async () => {
    for (const patch of [
      { pointsPerDollar: 0 },
      { rewardThresholdPoints: 0 },
      { rewardValueCents: -1 },
      { loyaltyExpiryDays: 0 },
    ]) {
      await expect(
        prisma.restaurantSettings.update({ where: { id: 'singleton' }, data: patch }),
      ).rejects.toThrow(/loyalty_settings_positive/);
    }
  });
});

// --- Enrolment (P0-1, C-101) -----------------------------------------------
//
// The phone is the key and the phone is never stored, which makes these the
// two claims worth a test: the same number typed two ways is ONE member, and
// nothing in the loyalty tables holds the digits.

describe('enrolment', () => {
  const NOW = new Date(Date.UTC(2026, 6, 5, 19, 30, 0));
  /** The same customer, back the next day. */
  const TOMORROW = new Date(Date.UTC(2026, 6, 6, 19, 30, 0));
  const enable = () => seedSettings({ loyaltyEnabled: true });

  it('reads the PRD\'s two spellings as one member', async () => {
    await enable();

    const first = await enrolMember({
      phone: '(555) 010-2233',
      displayName: 'Ivy Castellanos',
      now: NOW,
    });
    const second = await enrolMember({
      phone: '5550102233',
      displayName: 'Ivy C',
      now: TOMORROW,
    });

    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && second.ok && first.memberId).toBe(second.ok ? second.memberId : null);
    expect(await prisma.loyaltyMember.count()).toBe(1);

    // The second enrolment does not overwrite the first: a returning customer
    // keeps the instant they joined, which is what expiry and retention are
    // both counted from.
    const stored = await prisma.loyaltyMember.findFirstOrThrow();
    expect(stored.displayName).toBe('Ivy Castellanos');
    expect(stored.enrolledAt).toEqual(NOW);
    expect(stored.phoneLast4).toBe('2233');
  });

  it('stores a digest under the pepper, never the number', async () => {
    await enable();
    await enrolMember({ phone: '555-010-2233', displayName: 'Ivy', now: NOW });

    const stored = await prisma.loyaltyMember.findFirstOrThrow();
    // Every field, serialised — so a column added later that happens to hold
    // the digits fails this test rather than shipping. The last four are
    // deliberately in clear and are not the number.
    const everything = JSON.stringify(stored).replace(stored.phoneLast4, '');
    expect(everything).not.toContain('5550102233');
    expect(everything).not.toContain('555-010-2233');
    expect(everything).not.toContain('555010');

    expect(stored.phoneDigest).toBe(phoneDigest('5550102233'));
    expect(stored.phoneDigest).toHaveLength(64);
    // An HMAC, not a bare hash: the same digits under a different pepper is a
    // different digest, which is the entire point of the pepper being an
    // environment secret and not a constant in this file.
    const pepper = process.env.LOYALTY_PHONE_PEPPER;
    process.env.LOYALTY_PHONE_PEPPER = 'a-different-pepper';
    expect(phoneDigest('5550102233')).not.toBe(stored.phoneDigest);
    process.env.LOYALTY_PHONE_PEPPER = pepper;
  });

  it('writes nothing at all while the program is off', async () => {
    // The seeded default, restated as the behaviour that matters: a request
    // may ask to enrol, and with `loyaltyEnabled: false` it is refused BY NAME
    // and no row exists.
    const result = await enrolMember({ phone: '5550102233', displayName: 'Ivy', now: NOW });
    expect(result).toEqual({ ok: false, reason: 'loyalty_disabled' });
    expect(await prisma.loyaltyMember.count()).toBe(0);
  });

  it('refuses a phone it cannot key a membership on, rather than inventing one', async () => {
    await enable();
    for (const phone of [null, '', '555010223', '+44 20 7946 0000']) {
      expect(await enrolMember({ phone, displayName: 'Ivy', now: NOW })).toEqual({
        ok: false,
        reason: 'phone_not_enrollable',
      });
    }
    expect(await prisma.loyaltyMember.count()).toBe(0);
  });

  it('refuses — and does not hash under an empty key — with no pepper set', async () => {
    await enable();
    const pepper = process.env.LOYALTY_PHONE_PEPPER;
    delete process.env.LOYALTY_PHONE_PEPPER;
    try {
      expect(await enrolMember({ phone: '5550102233', displayName: 'Ivy', now: NOW })).toEqual({
        ok: false,
        reason: 'loyalty_pepper_unset',
      });
      // Louder than a digest that is stable now and wrong the day the pepper
      // is configured.
      expect(() => phoneDigest('5550102233')).toThrow(/LOYALTY_PHONE_PEPPER/);
      expect(await memberByPhone('5550102233')).toBeNull();
    } finally {
      process.env.LOYALTY_PHONE_PEPPER = pepper;
    }
    expect(await prisma.loyaltyMember.count()).toBe(0);
  });
});

describe('the counter lookup', () => {
  const NOW = new Date(Date.UTC(2026, 6, 5, 19, 30, 0));

  it('finds a member by a number typed any way, and sums their balance', async () => {
    await seedSettings({ loyaltyEnabled: true });
    const enrolled = await enrolMember({
      phone: '(555) 010-2233',
      displayName: 'Ivy Castellanos',
      now: NOW,
    });
    if (!enrolled.ok) throw new Error(enrolled.reason);
    await prisma.loyaltyEvent.createMany({
      data: [
        { memberId: enrolled.memberId, at: NOW, kind: 'earn', points: 140 },
        { memberId: enrolled.memberId, at: NOW, kind: 'redeem', points: -100, amountCents: 1000 },
      ],
    });

    const found = await memberByPhone('555.010.2233');
    expect(found).toMatchObject({
      id: enrolled.memberId,
      displayName: 'Ivy Castellanos',
      phoneLast4: '2233',
      balance: 40,
    });
    // What the counter is handed carries no digest to leak onto a screen.
    expect(JSON.stringify(found)).not.toContain(phoneDigest('5550102233'));
  });

  it('is a miss, not an error, for a number nobody enrolled', async () => {
    await seedSettings({ loyaltyEnabled: true });
    expect(await memberByPhone('5550109999')).toBeNull();
    expect(await memberByPhone('nonsense')).toBeNull();
  });
});

// --- Earning at pickup (P0-3, C-102) ---------------------------------------
//
// The arithmetic is the core suite's — `pointsForOrder` asserts $23.47 and
// $23.99 both earning 23 there, with no database in sight. These prove the
// three things only the write path can be wrong about: that the earn fires on
// the SOLD transition and nowhere else, that a revert-and-re-advance produces
// one row because the INDEX says so, and that the number comes off the frozen
// snapshot rather than off a menu row somebody has since repriced.

describe('earning at pickup', () => {
  const PICKUP = new Date(Date.UTC(2026, 6, 5, 4, 0, 0));
  /** 1095 burrito + 150 carnitas + 250 guacamole. $14.95, which earns 14 and
   *  not 15 — the floor, hand-calculated. */
  const SUBTOTAL = 1495;

  let keyCounter = 0;
  const place = async (phone: string | undefined) => {
    const placed = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: SUBTOTAL,
            composition: {
              itemId: 'burrito',
              quantity: 1,
              selections: [
                { groupId: 'protein', optionId: 'carnitas' },
                { groupId: 'addons', optionId: 'guacamole' },
              ],
            },
          },
        ],
      },
      customerName: 'Ivy Castellanos',
      customerPhone: phone,
      idempotencyKey: `c8f2b0e1-0000-4000-8000-10000000000${(keyCounter += 1)}`,
      now: AT,
    });
    if (!placed.ok) throw new Error(`placement refused: ${JSON.stringify(placed.errors)}`);
    expect(placed.order.subtotalCents).toBe(SUBTOTAL);
    return placed.order.id;
  };

  /** Every tap a cook makes between the ticket printing and the bag going
   *  over the counter. Deliberately the whole chain rather than a jump: the
   *  earn has to fire on the LAST one and on none of the others. */
  const advanceTo = async (orderId: string, target: string, now = PICKUP) => {
    for (let i = 0; i < 6; i += 1) {
      const moved = await applyOrderAction(orderId, { kind: 'advance', actor: 'staff' }, now);
      if (!moved.ok) throw new Error(`advance refused: ${moved.failure.message}`);
      if (moved.order.status === target) return;
    }
    throw new Error(`never reached ${target}`);
  };

  const earns = (orderId: string) =>
    prisma.loyaltyEvent.findMany({ where: { orderId, kind: 'earn' } });

  const enrolled = async () => {
    await seedSettings({ loyaltyEnabled: true });
    const result = await enrolMember({
      phone: '(555) 010-2233',
      displayName: 'Ivy Castellanos',
      now: AT,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.memberId;
  };

  it('earns once, at pickup, and survives a revert and a re-advance', async () => {
    const memberId = await enrolled();
    const orderId = await place('5550102233');

    // Nothing yet: the food is still being made, and points are for food
    // collected.
    await advanceTo(orderId, 'ready');
    expect(await earns(orderId)).toHaveLength(0);

    await advanceTo(orderId, 'picked_up');
    expect(await earns(orderId)).toHaveLength(1);

    // The fat-fingered advance and its undo — a supported operation, which is
    // exactly why the constraint and not the code path is the mechanism.
    const reverted = await applyOrderAction(orderId, { kind: 'revert', actor: 'staff' }, PICKUP);
    expect(reverted.ok).toBe(true);
    await advanceTo(orderId, 'picked_up');

    const rows = await earns(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId, points: 14, amountCents: null });
    // Nothing is clawed back by the revert either (recorded ceiling): a staff
    // `adjust` is the correction, because an automatic reversal would make the
    // balance a function of a status history rather than of a set of facts.
    expect((await memberByPhone('5550102233'))?.balance).toBe(14);
  });

  it('moves lastActivityAt — what expiry is counted from', async () => {
    await enrolled();
    const before = await prisma.loyaltyMember.findFirstOrThrow();
    expect(before.lastActivityAt).toEqual(AT);

    await advanceTo(await place('5550102233'), 'picked_up');

    const after = await prisma.loyaltyMember.findFirstOrThrow();
    expect(after.lastActivityAt).toEqual(PICKUP);
    // The instant they joined is not touched by earning.
    expect(after.enrolledAt).toEqual(AT);
  });

  it('reads the snapshot, not the menu — a reprice after placement earns the same', async () => {
    await enrolled();
    const orderId = await place('5550102233');
    // Everything the points were computed from, moved underneath the order.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { basePriceCents: 9999, name: 'Renamed' },
    });
    await prisma.modifierOption.update({
      where: { id: 'guacamole' },
      data: { priceDeltaCents: 9999 },
    });

    await advanceTo(orderId, 'picked_up');
    expect((await earns(orderId))[0]?.points).toBe(14);
  });

  it('earns nothing on an order nobody collected', async () => {
    await enrolled();
    const abandoned = await place('5550102233');
    await advanceTo(abandoned, 'ready');
    expect(
      (await applyOrderAction(abandoned, { kind: 'abandon', actor: 'staff' }, PICKUP)).ok,
    ).toBe(true);

    const cancelled = await place('5550102233');
    expect(
      (
        await applyOrderAction(
          cancelled,
          { kind: 'cancel', actor: 'staff', reason: 'other', note: 'Customer changed their mind' },
          PICKUP,
        )
      ).ok,
    ).toBe(true);

    expect(await prisma.loyaltyEvent.count()).toBe(0);
  });

  it('is a quiet no-op for a customer who never joined', async () => {
    await seedSettings({ loyaltyEnabled: true });
    await advanceTo(await place('5550109999'), 'picked_up');
    await advanceTo(await place(undefined), 'picked_up');
    expect(await prisma.loyaltyEvent.count()).toBe(0);
  });

  it('writes nothing once the program is switched off, member or not', async () => {
    await enrolled();
    await seedSettings({ loyaltyEnabled: false });
    await advanceTo(await place('5550102233'), 'picked_up');
    expect(await prisma.loyaltyEvent.count()).toBe(0);
  });

  it('earns nothing under a dollar rather than writing a zero-point row', async () => {
    // A zero `earn` would fail the sign CHECK and take the cook's tap down
    // with it; the refusal is by name and the pickup still commits.
    await enrolled();
    await seedSettings({ loyaltyEnabled: true, pointsPerDollar: 1 });
    const orderId = await place('5550102233');
    // taxCents/totalCents forced to match — C-117's CHECK now enforces
    // subtotalCents - discountCents + taxCents = totalCents on every row.
    await prisma.order.update({
      where: { id: orderId },
      data: { subtotalCents: 99, taxCents: 0, totalCents: 99 },
    });

    await advanceTo(orderId, 'picked_up');
    expect(await prisma.loyaltyEvent.count()).toBe(0);
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status,
    ).toBe('picked_up');
  });
});

describe('redeeming at the counter (P0-4)', () => {
  const PICKUP = new Date(Date.UTC(2026, 6, 5, 4, 0, 0));
  const REDEEM_AT = new Date(Date.UTC(2026, 6, 5, 4, 5, 0));

  // Hand-calculated, from the seeded menu and the seeded 8.25% rate.
  // 1095 burrito + 150 carnitas + 250 guacamole = 1495 subtotal;
  // round(1495 × 0.0825) = round(123.3375) = 123 tax; 1618 total.
  //
  // The PRD writes this case as "$10 against a $13.75 order" — illustrative
  // prose, not a fixture; these are the real numbers this menu produces and
  // they make the same distinction the PRD's do. AFTER TAX, off what is owed:
  // 1618 − 1000 = 618. A before-tax discount would owe 536 instead
  // (495 + round(495 × 0.0825) = 495 + 41), so this one number is what
  // separates the version that shipped from the version P1-1 is gated on.
  const SUBTOTAL = 1495;
  const TAX = 123;
  const TOTAL = 1618;

  let keyCounter = 0;
  const place = async (
    line: { itemId: string; unitPriceAtAddCents: number; selections?: unknown[] },
    phone: string | undefined = '5550102233',
  ) => {
    const placed = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: line.unitPriceAtAddCents,
            composition: {
              itemId: line.itemId,
              quantity: 1,
              selections: (line.selections ?? []) as never,
            },
          },
        ],
      },
      customerName: 'Ivy Castellanos',
      customerPhone: phone,
      idempotencyKey: `c8f2b0e1-0000-4000-8000-20000000000${(keyCounter += 1)}`,
      now: AT,
    });
    if (!placed.ok) throw new Error(`placement refused: ${JSON.stringify(placed.errors)}`);
    return placed.order.id;
  };

  const BURRITO = {
    itemId: 'burrito',
    unitPriceAtAddCents: SUBTOTAL,
    selections: [
      { groupId: 'protein', optionId: 'carnitas' },
      { groupId: 'addons', optionId: 'guacamole' },
    ],
  };

  /** Enrol, and hand the member however many points the case needs. The
   *  `adjust` is the product's own correction kind, so nothing here writes a
   *  ledger row in a shape the application could not. */
  const memberWith = async (points: number) => {
    await seedSettings({ loyaltyEnabled: true });
    const result = await enrolMember({
      phone: '(555) 010-2233',
      displayName: 'Ivy Castellanos',
      now: AT,
    });
    if (!result.ok) throw new Error(result.reason);
    if (points !== 0) {
      await prisma.loyaltyEvent.create({
        data: {
          memberId: result.memberId,
          at: AT,
          kind: 'adjust',
          points,
          reason: 'opening balance',
        },
      });
    }
    return result.memberId;
  };

  it('writes both rows, and moves no snapshot column doing it', async () => {
    const memberId = await memberWith(100);
    const orderId = await place(BURRITO);

    const redeemed = await redeemReward(orderId, REDEEM_AT, 'staff-noor');
    expect(redeemed).toEqual({ ok: true, pointsSpent: -100, amountCents: 1000 });

    // THE SNAPSHOT IS UNTOUCHED. The customer was charged what they were
    // charged; the reward is a second fact beside it (P0-4, and CLAUDE.md's
    // snapshot rule read from the money side).
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { subtotalCents: true, taxCents: true, totalCents: true },
    });
    expect(order).toEqual({ subtotalCents: SUBTOTAL, taxCents: TAX, totalCents: TOTAL });

    // Two rows, and they agree to the cent.
    const ledger = await prisma.loyaltyEvent.findMany({ where: { orderId, kind: 'redeem' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      memberId,
      points: -100,
      amountCents: 1000,
      staffId: 'staff-noor',
    });

    const money = await prisma.orderEvent.findMany({ where: { orderId, kind: 'adjustment' } });
    expect(money).toHaveLength(1);
    expect(money[0]).toMatchObject({
      amountCents: 1000,
      reason: 'loyalty_reward',
      actor: 'staff',
      staffId: 'staff-noor',
      // Not a status change: the order is wherever it was.
      fromStatus: null,
      toStatus: null,
    });

    // What the counter now collects, after tax.
    expect(orderBalance({ totalCents: TOTAL, events: money }).outstandingCents).toBe(618);
    // And the points are gone, summed rather than decremented.
    expect((await memberByPhone('5550102233'))?.balance).toBe(0);
    // The redeem moves the expiry clock too — an active customer is one who
    // spends as well as one who earns (P0-5 counts from this).
    const member = await prisma.loyaltyMember.findUniqueOrThrow({ where: { id: memberId } });
    expect(member.lastActivityAt).toEqual(REDEEM_AT);
  });

  it('refuses a second reward on the same order, by name', async () => {
    await memberWith(250);
    const orderId = await place(BURRITO);

    expect((await redeemReward(orderId, REDEEM_AT)).ok).toBe(true);
    const second = await redeemReward(orderId, REDEEM_AT);
    expect(second).toMatchObject({ ok: false, reason: 'already_redeemed_on_this_order' });

    // One of each, still — and 150 points kept rather than spent twice.
    expect(await prisma.loyaltyEvent.count({ where: { orderId, kind: 'redeem' } })).toBe(1);
    expect(await prisma.orderEvent.count({ where: { orderId, kind: 'adjustment' } })).toBe(1);
    expect((await memberByPhone('5550102233'))?.balance).toBe(150);
  });

  it('is held by the INDEX, not by the read in front of it', async () => {
    const memberId = await memberWith(0);
    const orderId = await place(BURRITO);
    const row = {
      memberId,
      orderId,
      at: REDEEM_AT,
      kind: 'redeem' as const,
      points: -100,
      amountCents: 1000,
    };
    await expect(prisma.loyaltyEvent.create({ data: row })).resolves.toBeTruthy();
    // Two taps a moment apart both pass a check-then-write. This is what stops
    // the second one — the same sentence as the earn's index and the
    // idempotency key's.
    await expect(prisma.loyaltyEvent.create({ data: row })).rejects.toThrow();
  });

  it('refuses against an order that owes less than the reward — never clamps', async () => {
    await memberWith(100);
    // 300 side, round(300 × 0.0825) = round(24.75) = 25 tax, 325 owed. A clamp
    // would quietly turn a $10 reward into a $3.25 one and tell nobody the
    // customer lost the other $6.75; refusing keeps it for a bigger order.
    const orderId = await place({ itemId: 'beans-side', unitPriceAtAddCents: 300 });
    expect(
      await prisma.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { totalCents: true },
      }),
    ).toEqual({ totalCents: 325 });

    const refused = await redeemReward(orderId, REDEEM_AT);
    expect(refused).toMatchObject({ ok: false, reason: 'reward_exceeds_balance_owed' });

    // NEITHER row was written. A refusal that spent the points anyway is the
    // worse half of the pair landing alone.
    expect(await prisma.loyaltyEvent.count({ where: { orderId } })).toBe(0);
    expect(await prisma.orderEvent.count({ where: { orderId, kind: 'adjustment' } })).toBe(0);
    expect((await memberByPhone('5550102233'))?.balance).toBe(100);
  });

  it('refuses against an order already paid in full — the reward is what is OWED', async () => {
    await memberWith(100);
    const orderId = await place(BURRITO);
    // The checkout default: "Pay now — card", captured in full at placement.
    await prisma.orderEvent.create({
      data: { orderId, at: AT, kind: 'payment', actor: 'customer', amountCents: TOTAL },
    });

    const refused = await redeemReward(orderId, REDEEM_AT);
    expect(refused).toMatchObject({ ok: false, reason: 'reward_exceeds_balance_owed' });
    expect((await memberByPhone('5550102233'))?.balance).toBe(100);

    // NOT an oversight — the bound is what is still owed, and a captured card
    // charge cannot be handed back without the refund C-067 has not built.
    // Counter redemption is a pay-at-pickup feature by construction; spending
    // points on a prepaid order is P1-1, applied at checkout, gated on SMS.
    // The proof is the same order with the payment absent:
    const unpaid = await place(BURRITO);
    expect((await redeemReward(unpaid, REDEEM_AT)).ok).toBe(true);
  });

  it('refuses a balance short of a reward, and says how short', async () => {
    await memberWith(99);
    const orderId = await place(BURRITO);
    const refused = await redeemReward(orderId, REDEEM_AT);
    expect(refused).toMatchObject({ ok: false, reason: 'not_enough_points' });
    if (!refused.ok) expect(refused.message).toContain('1 points');
    expect(await prisma.loyaltyEvent.count({ where: { orderId } })).toBe(0);
  });

  it('refuses for a customer nobody enrolled, and with the program off', async () => {
    await memberWith(100);
    const stranger = await place(BURRITO, '5550109999');
    expect(await redeemReward(stranger, REDEEM_AT)).toMatchObject({
      ok: false,
      reason: 'not_a_member',
    });

    const orderId = await place(BURRITO);
    await seedSettings({ loyaltyEnabled: false });
    expect(await redeemReward(orderId, REDEEM_AT)).toMatchObject({
      ok: false,
      reason: 'loyalty_disabled',
    });
    expect(await prisma.orderEvent.count({ where: { kind: 'adjustment' } })).toBe(0);
  });

  it('spends on the same visit that earns — one order carries both rows', async () => {
    // The product's own happy path, and the reason the indexes are PARTIAL: a
    // customer with a balance orders, collects, earns, and spends on the way
    // out. A unique index on `orderId` across all kinds would refuse this.
    await memberWith(90);
    const orderId = await place(BURRITO);
    for (let i = 0; i < 6; i += 1) {
      const moved = await applyOrderAction(orderId, { kind: 'advance', actor: 'staff' }, PICKUP);
      if (!moved.ok) throw new Error(`advance refused: ${moved.failure.message}`);
      if (moved.order.status === 'picked_up') break;
    }
    // 90 + 14 earned = 104.
    expect((await memberByPhone('5550102233'))?.balance).toBe(104);

    expect((await redeemReward(orderId, REDEEM_AT)).ok).toBe(true);
    expect(await prisma.loyaltyEvent.count({ where: { orderId } })).toBe(2);
    expect((await memberByPhone('5550102233'))?.balance).toBe(4);
  });
});

// --- Expiry (P0-5, C-105) --------------------------------------------------
//
// An immortal balance is an unbounded liability and, worse, it is the argument
// for keeping a named person's purchase history forever. These assert the
// sweep that stops that — and the two things about it that are decisions
// rather than mechanics: it ignores the program's own switch, and it does not
// touch the clock it selects on.

describe('expiring an inactive balance', () => {
  /** Well past a 365-day window from `AT`. */
  const LATER = new Date(Date.UTC(2027, 8, 1, 3, 0, 0));
  /** A month before `LATER` — inside every window here. */
  const RECENTLY = new Date(Date.UTC(2027, 7, 1, 3, 0, 0));

  const balanceOf = async (id: string): Promise<number> =>
    loyaltyBalance(
      await prisma.loyaltyEvent.findMany({ where: { memberId: id }, select: { kind: true, points: true } }),
    );

  /** A member with `points` earned, last active at `lastActivityAt`. */
  async function memberHolding(points: number, lastActivityAt: Date): Promise<string> {
    const m = await member({ phoneDigest: `digest-${Math.random()}`, lastActivityAt });
    await prisma.loyaltyEvent.create({
      data: { memberId: m.id, at: lastActivityAt, kind: 'earn', points },
    });
    return m.id;
  }

  it('zeroes it with ONE expire row worth exactly minus the balance', async () => {
    const id = await memberHolding(240, AT);

    expect(await expireInactiveBalances(LATER)).toEqual({
      expiryDays: 365,
      members: 1,
      points: 240,
    });

    const [expired, ...rest] = await prisma.loyaltyEvent.findMany({
      where: { memberId: id, kind: 'expire' },
    });
    expect(rest).toHaveLength(0);
    expect(expired?.points).toBe(-240);
    expect(expired?.at).toEqual(LATER);
    // Written against NO ORDER. Expiry is a fact about a member, not a sale.
    expect(expired?.orderId).toBeNull();
    // A sum, not a decrement — the earns are still there to explain it.
    expect(await balanceOf(id)).toBe(0);
    expect(await prisma.loyaltyEvent.count({ where: { memberId: id } })).toBe(2);
  });

  it('leaves a member who was active inside the window completely alone', async () => {
    const id = await memberHolding(240, RECENTLY);

    expect((await expireInactiveBalances(LATER)).members).toBe(0);

    expect(await balanceOf(id)).toBe(240);
  });

  it('does not move `lastActivityAt` — expiring is not activity', async () => {
    const id = await memberHolding(240, AT);

    await expireInactiveBalances(LATER);

    // If it moved, the member would keep resetting the clock that eventually
    // deletes the row, and a balance of zero would be held under a name
    // forever.
    const after = await prisma.loyaltyMember.findUniqueOrThrow({ where: { id } });
    expect(after.lastActivityAt).toEqual(AT);
  });

  it('is idempotent without a constraint — the second run finds nothing to zero', async () => {
    await memberHolding(240, AT);

    expect((await expireInactiveBalances(LATER)).members).toBe(1);
    expect((await expireInactiveBalances(LATER)).members).toBe(0);
    expect(await prisma.loyaltyEvent.count({ where: { kind: 'expire' } })).toBe(1);
  });

  it('writes nothing for a stale member whose balance is already zero', async () => {
    // A zero-point row would fail the sign CHECK, correctly: a ledger row
    // worth nothing records a decision nobody made.
    await member({ lastActivityAt: AT });

    expect((await expireInactiveBalances(LATER)).members).toBe(0);
    expect(await prisma.loyaltyEvent.count()).toBe(0);
  });

  it('reads the window from the settings row, not from a constant', async () => {
    const id = await memberHolding(240, RECENTLY);
    await seedSettings({ loyaltyExpiryDays: 7 });

    expect(await expireInactiveBalances(LATER)).toEqual({ expiryDays: 7, members: 1, points: 240 });

    expect(await balanceOf(id)).toBe(0);
  });

  // THE decision in this sweep, asserted rather than argued: switching the
  // program off must not make every outstanding balance immortal, which is the
  // exact failure P0-5 exists to prevent.
  it('expires with the program switched OFF, unlike every other write here', async () => {
    const id = await memberHolding(240, AT);
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(settings.loyaltyEnabled).toBe(false);

    expect((await expireInactiveBalances(LATER)).members).toBe(1);

    expect(await balanceOf(id)).toBe(0);
  });
});

// The program's own screen, at the database grain (PRD 7 P1-2, C-106).
//
// The arithmetic is proved in packages/core; what is proved here is the shape
// of the three aggregates — that a member with no rows is still a member, that
// the liability is all-time while everything else is the window, and that the
// window's edge falls where it says it does.
describe('the program report', () => {
  const WINDOW_START = new Date(Date.UTC(2026, 6, 1, 0, 0, 0));
  const INSIDE = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));
  const BEFORE = new Date(Date.UTC(2026, 5, 20, 3, 0, 0));

  async function holder(points: number, at = INSIDE): Promise<string> {
    const m = await member({ phoneDigest: `digest-${Math.random()}` });
    if (points !== 0) {
      await prisma.loyaltyEvent.create({
        data: { memberId: m.id, at, kind: 'earn', points },
      });
    }
    return m.id;
  }

  it('reports an empty program without dividing by anything', async () => {
    const report = await loadLoyaltyProgram(WINDOW_START);

    expect(report.members).toBe(0);
    expect(report.liability).toMatchObject({ points: 0, accruedCents: 0, rewardsOutstanding: 0 });
    expect(report.window.rate).toBeNull();
    expect(report.window.redemptions).toBe(0);
  });

  it('counts a member who enrolled and never came back', async () => {
    // No ledger rows at all, so the balance grouping cannot see them. They
    // handed over a phone number; that is what this count means.
    await holder(0);

    const report = await loadLoyaltyProgram(WINDOW_START);
    expect(report.members).toBe(1);
    expect(report.liability.points).toBe(0);
  });

  it('values the liability per member, so half a reward stays unspendable', async () => {
    await holder(250);
    await holder(40);
    await holder(100);

    const report = await loadLoyaltyProgram(WINDOW_START);
    expect(report.members).toBe(3);
    expect(report.liability).toEqual({
      points: 390,
      accruedCents: 3900,
      rewardsOutstanding: 3,
      redeemableCents: 3000,
      membersWithReward: 2,
    });
  });

  it('reports the window as positive counts, whatever sign the rows carry', async () => {
    const id = await holder(400);
    await prisma.loyaltyEvent.createMany({
      data: [
        { memberId: id, at: INSIDE, kind: 'redeem', points: -100, amountCents: 1000 },
        { memberId: id, at: INSIDE, kind: 'redeem', points: -100, amountCents: 1000 },
        { memberId: id, at: INSIDE, kind: 'expire', points: -50 },
        { memberId: id, at: INSIDE, kind: 'adjust', points: -25 },
      ],
    });

    const report = await loadLoyaltyProgram(WINDOW_START);
    expect(report.window).toEqual({
      pointsEarned: 400,
      pointsRedeemed: 200,
      pointsExpired: 50,
      // Signed, alone among them: a program propped up by hand should look
      // like one.
      pointsAdjusted: -25,
      // Nothing here was a reward coming back off a dead order (C-118).
      pointsReturned: 0,
      redemptions: 2,
      redeemedCents: 2000,
      rate: 0.5,
    });
    // 400 − 200 − 50 − 25.
    expect(report.liability.points).toBe(125);
  });

  it('keeps the liability all-time while the window has an edge', async () => {
    // Earned before the window, spent inside it: the shop still owes the
    // remainder, and the rate is above 1 because a punch card is saved up.
    const id = await holder(300, BEFORE);
    await prisma.loyaltyEvent.createMany({
      data: [
        { memberId: id, at: INSIDE, kind: 'earn', points: 100 },
        { memberId: id, at: INSIDE, kind: 'redeem', points: -200, amountCents: 2000 },
      ],
    });

    const report = await loadLoyaltyProgram(WINDOW_START);
    expect(report.window).toMatchObject({ pointsEarned: 100, pointsRedeemed: 200, rate: 2 });
    expect(report.liability).toMatchObject({ points: 200, accruedCents: 2000 });
  });

  it('carries the terms and both windows, and the switch apart from the pepper', async () => {
    const report = await loadLoyaltyProgram(WINDOW_START);

    expect(report).toMatchObject({
      enabled: false,
      terms: { pointsPerDollar: 1, rewardThresholdPoints: 100, rewardValueCents: 1000 },
      expiryDays: 365,
      retentionDays: 365,
    });

    await setLoyaltyEnabled(true);
    // The switch alone. `offered` is the switch AND a pepper, and the screen
    // has to be able to say which of the two is missing.
    expect(await loadLoyaltyProgram(WINDOW_START)).toMatchObject({ enabled: true });

    await setLoyaltyEnabled(false);
    expect(await loadLoyaltyProgram(WINDOW_START)).toMatchObject({ enabled: false });
  });

  it('switching the program off destroys nothing', async () => {
    await setLoyaltyEnabled(true);
    await holder(250);

    await setLoyaltyEnabled(false);

    // The balance is the customer's, not the program's. C-105 makes the same
    // point from the other side: expiry runs with the switch off, because a
    // switched-off program must not make every balance immortal.
    const report = await loadLoyaltyProgram(WINDOW_START);
    expect(report.liability.points).toBe(250);
    expect(report.members).toBe(1);
  });
});

// --- Redeeming at CHECKOUT, before tax (P1-1, C-118) -----------------------

describe('spending a reward at checkout', () => {
  // The same burrito the counter block above redeems against, and deliberately
  // so: $14.95 of food, a $10 reward. AFTER tax (C-104) the customer still
  // owes $6.18. BEFORE tax — here — the tax base is $4.95, tax is 41c, and the
  // total is $5.36. The 82c between them is the sales tax this shop was
  // remitting on food nobody paid for, and it is the entire reason P1-1 exists.
  const SUBTOTAL = 1495;
  const DISCOUNT = 1000;
  const TAX_ON_DISCOUNTED = 41;
  const TOTAL = 536;

  const PHONE = '5550102233';
  let keyCounter = 0;
  const nextKey = () => `d9e3c1f2-0000-4000-8000-3000000000${String((keyCounter += 1)).padStart(2, '0')}`;

  const BURRITO = {
    id: 'line-1',
    unitPriceAtAddCents: SUBTOTAL,
    composition: {
      itemId: 'burrito',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'carnitas' },
        { groupId: 'addons', optionId: 'guacamole' },
      ],
    },
  } as const;

  const memberWith = async (points: number) => {
    await seedSettings({ loyaltyEnabled: true });
    const result = await enrolMember({ phone: PHONE, displayName: 'Ivy Castellanos', now: AT });
    if (!result.ok) throw new Error(result.reason);
    if (points !== 0) {
      await prisma.loyaltyEvent.create({
        data: { memberId: result.memberId, at: AT, kind: 'adjust', points, reason: 'opening balance' },
      });
    }
    return result.memberId;
  };

  /** A REAL token, through the real two calls — never a hand-built string.
   *  The stub provider echoes the code back (C-115's seam), which is the one
   *  thing that makes a one-time code clickable with no carrier behind it. */
  const verify = async (idempotencyKey: string, phone = PHONE) => {
    const started = await startPhoneVerification(phone, AT);
    if (!started.ok) throw new Error(`verification refused: ${started.reason}`);
    if (started.echoedCode === null) throw new Error('the stub provider echoed no code');
    const confirmed = await confirmPhoneVerificationForCheckout(
      phone,
      started.echoedCode,
      idempotencyKey,
      AT,
    );
    if (!confirmed.ok) throw new Error(`confirmation refused: ${confirmed.reason}`);
    return confirmed.token;
  };

  const placeWith = async (
    idempotencyKey: string,
    verifiedPhoneToken: string | null,
    phone: string | undefined = PHONE,
  ) =>
    placeOrder({
      cart: { lines: [BURRITO as never] },
      customerName: 'Ivy Castellanos',
      customerPhone: phone,
      idempotencyKey,
      now: AT,
      ...(verifiedPhoneToken === null ? {} : { verifiedPhoneToken }),
    });

  it('takes the reward off BEFORE tax, and both rows commit together', async () => {
    const memberId = await memberWith(100);
    const key = nextKey();
    const placed = await placeWith(key, await verify(key));
    if (!placed.ok) throw new Error(`refused: ${JSON.stringify(placed.errors)}`);

    // The snapshot, and the identity C-117's CHECK enforces at the row.
    expect(placed.order).toMatchObject({
      subtotalCents: SUBTOTAL,
      discountCents: DISCOUNT,
      taxCents: TAX_ON_DISCOUNTED,
      totalCents: TOTAL,
    });
    expect(
      placed.order.subtotalCents - placed.order.discountCents + placed.order.taxCents,
    ).toBe(placed.order.totalCents);
    expect(placed.verifiedPhone).toBe('verified');

    // The ledger half. ONE transaction with the order above — a snapshot
    // carrying a discount with no `redeem` beside it is $10 given away with
    // nothing to explain it.
    const ledger = await prisma.loyaltyEvent.findMany({ where: { orderId: placed.order.id } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      memberId,
      kind: 'redeem',
      points: -100,
      amountCents: DISCOUNT,
      // Nobody at the counter decided this one.
      staffId: null,
    });
    expect((await memberByPhone(PHONE))?.balance).toBe(0);

    // NO `adjustment` EVENT, which is the difference from the counter flow:
    // the reward is IN the snapshot here, so an adjustment beside it would
    // take the ten dollars off twice.
    expect(await prisma.orderEvent.count({ where: { orderId: placed.order.id, kind: 'adjustment' } }))
      .toBe(0);
    // And the customer owes exactly the discounted total, not $6.18.
    expect(orderBalance({ totalCents: placed.order.totalCents, events: [] }).outstandingCents)
      .toBe(TOTAL);
  });

  it('leaves the counter’s own control refusing by the name it already had', async () => {
    // Decision, this session: whichever redemption happens first wins, and the
    // other is refused as already-redeemed. Checkout is ALWAYS first — the
    // counter needs an order that exists — so this is what "checkout wins"
    // looks like, and it needed no new mechanism: C-104's partial unique index
    // and `planRedemption`'s own `alreadyRedeemed` were already the answer.
    await memberWith(250);
    const key = nextKey();
    const placed = await placeWith(key, await verify(key));
    if (!placed.ok) throw new Error('refused');

    expect(await redeemReward(placed.order.id, AT)).toMatchObject({
      ok: false,
      reason: 'already_redeemed_on_this_order',
    });
    // Still one redeem, and the 150 points that were left are still there.
    expect(await prisma.loyaltyEvent.count({ where: { orderId: placed.order.id, kind: 'redeem' } }))
      .toBe(1);
    expect((await memberByPhone(PHONE))?.balance).toBe(150);
  });

  it('refuses the whole placement rather than quietly charging full price', async () => {
    // The customer pressed a button reading "$5.36". Placing at $16.18 because
    // the balance moved under them is the precise-wrong-number failure this
    // product has a rule about — so nothing is written at all.
    await memberWith(40);
    const key = nextKey();
    // 40 points cannot even request a code, so the token has to be minted
    // while the reward exists and then spent after it stops existing.
    await prisma.loyaltyEvent.deleteMany({});
    await memberWith(100);
    const token = await verify(key);
    await prisma.loyaltyEvent.deleteMany({});

    const refused = await placeWith(key, token);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.errors).toEqual([
      expect.objectContaining({ kind: 'reward_unavailable', reason: 'not_enough_points' }),
    ]);
    expect(await prisma.order.count()).toBe(0);
  });

  it('refuses a reward worth more than the food, rather than clamping it', async () => {
    // A $3.00 side and a $10 reward. C-117's `discountCents <= subtotalCents`
    // CHECK is what this refusal exists to keep out of reach.
    await memberWith(100);
    const key = nextKey();
    const token = await verify(key);
    const refused = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: 300,
            composition: { itemId: 'beans-side', quantity: 1, selections: [] as never },
          },
        ],
      },
      customerName: 'Ivy Castellanos',
      customerPhone: PHONE,
      idempotencyKey: key,
      now: AT,
      verifiedPhoneToken: token,
    });
    expect(refused).toMatchObject({ ok: false });
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.errors[0]).toMatchObject({ reason: 'reward_exceeds_subtotal' });
    expect(await prisma.order.count()).toBe(0);
  });

  it('refuses a token minted for a different checkout attempt', async () => {
    await memberWith(100);
    const token = await verify(nextKey());
    const refused = await placeWith(nextKey(), token);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.errors[0]).toMatchObject({ reason: 'wrong_order' });
    // The points are untouched: nothing was spent on an order nothing wrote.
    expect((await memberByPhone(PHONE))?.balance).toBe(100);
  });

  it('refuses a token presented on an order placed under another number', async () => {
    await memberWith(100);
    const key = nextKey();
    const token = await verify(key);
    const refused = await placeWith(key, token, '5550109999');
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.errors[0]).toMatchObject({ reason: 'phone_mismatch' });
  });

  it('replays a discounted order without re-reading the token', async () => {
    // The second tap. A ten-minute token that has since expired must not turn
    // an impatient reload into a refusal for an order already on the grill —
    // the reward is snapshotted on the row this returns.
    await memberWith(100);
    const key = nextKey();
    const first = await placeWith(key, await verify(key));
    if (!first.ok) throw new Error('refused');

    // `instantMinutesAfter`, never `new Date(AT.getTime() + …)`: the lint
    // bans the second shape and the module that does this arithmetic is the
    // one place it is tested.
    const ELEVEN_MINUTES_LATER = instantMinutesAfter(AT, 11);
    const second = await placeOrder({
      cart: { lines: [BURRITO as never] },
      customerName: 'Ivy Castellanos',
      customerPhone: PHONE,
      idempotencyKey: key,
      now: ELEVEN_MINUTES_LATER,
      verifiedPhoneToken: 'a.b.c.d',
    });
    if (!second.ok) throw new Error('the replay was refused');
    expect(second.replayed).toBe(true);
    // Idempotency means the SAME answer, not merely no duplicate.
    expect(second.order).toEqual(first.order);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.loyaltyEvent.count({ where: { kind: 'redeem' } })).toBe(1);
  });

  it('places at full price with no token, exactly as it did before C-118', async () => {
    await memberWith(100);
    const placed = await placeWith(nextKey(), null);
    if (!placed.ok) throw new Error('refused');
    expect(placed.order).toMatchObject({ subtotalCents: SUBTOTAL, discountCents: 0, taxCents: 123 });
    // Null, not a word: no token was presented, which is the ordinary case.
    expect(placed.verifiedPhone).toBeNull();
    expect((await memberByPhone(PHONE))?.balance).toBe(100);
  });

  it('hands the points back when the order is cancelled, and says so on the ledger', async () => {
    const memberId = await memberWith(100);
    const key = nextKey();
    const placed = await placeWith(key, await verify(key));
    if (!placed.ok) throw new Error('refused');
    expect((await memberByPhone(PHONE))?.balance).toBe(0);

    const cancelled = await applyOrderAction(
      placed.order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      AT,
    );
    expect(cancelled.ok).toBe(true);

    // The points are back — as a ROW, never by deleting the redeem. "Where did
    // my hundred points go" is answered by reading the ledger.
    expect((await memberByPhone(PHONE))?.balance).toBe(100);
    const returned = await prisma.loyaltyEvent.findMany({
      where: { orderId: placed.order.id, kind: 'adjust' },
    });
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ memberId, points: 100, reason: 'loyalty_reward_returned' });
    // The SNAPSHOT is untouched. The order was cancelled; what it was priced
    // at is still what it was priced at.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: placed.order.id } });
    expect(order).toMatchObject({ discountCents: DISCOUNT, totalCents: TOTAL });
  });

  it('re-spends them when a no-show is reverted and picked up after all', async () => {
    await memberWith(100);
    const key = nextKey();
    const placed = await placeWith(key, await verify(key));
    if (!placed.ok) throw new Error('refused');
    const orderId = placed.order.id;

    const advance = async () =>
      applyOrderAction(orderId, { kind: 'advance', actor: 'staff' }, AT);
    await advance(); // accepted
    await advance(); // preparing
    await advance(); // ready
    await applyOrderAction(orderId, { kind: 'abandon', actor: 'staff' }, AT);
    expect((await memberByPhone(PHONE))?.balance).toBe(100);

    // She walks in. Without the re-spend she keeps the $10 off AND the 100
    // points that bought it.
    await applyOrderAction(orderId, { kind: 'revert', actor: 'staff' }, AT);
    expect((await memberByPhone(PHONE))?.balance).toBe(0);
    await advance(); // picked_up — and the earn lands on the same transition

    const rows = await prisma.loyaltyEvent.findMany({
      where: { orderId },
      orderBy: { kind: 'asc' },
      select: { kind: true, points: true, reason: true },
    });
    // redeem −100, return +100, re-spend −100, earn +14 on the $14.95 subtotal.
    expect(rows).toEqual(
      expect.arrayContaining([
        { kind: 'redeem', points: -100, reason: null },
        { kind: 'adjust', points: 100, reason: 'loyalty_reward_returned' },
        { kind: 'adjust', points: -100, reason: 'loyalty_reward_respent' },
        { kind: 'earn', points: 14, reason: null },
      ]),
    );
    expect((await memberByPhone(PHONE))?.balance).toBe(14);
  });

  it('settles nothing at all on an order that spent no reward', async () => {
    await memberWith(100);
    const placed = await placeWith(nextKey(), null);
    if (!placed.ok) throw new Error('refused');
    await applyOrderAction(
      placed.order.id,
      { kind: 'cancel', actor: 'staff', reason: 'too_busy' },
      AT,
    );
    expect(await prisma.loyaltyEvent.count({ where: { orderId: placed.order.id } })).toBe(0);
    expect((await memberByPhone(PHONE))?.balance).toBe(100);
  });

  it('does not restart the expiry clock on a cancellation', async () => {
    // An order that died is something that happened TO this member, not
    // something they did — the same call `expireInactiveBalances` makes.
    const memberId = await memberWith(100);
    const key = nextKey();
    const placed = await placeWith(key, await verify(key));
    if (!placed.ok) throw new Error('refused');
    const afterRedeem = await prisma.loyaltyMember.findUniqueOrThrow({ where: { id: memberId } });

    const MUCH_LATER = instantMinutesAfter(AT, 24 * 60);
    await applyOrderAction(
      placed.order.id,
      { kind: 'cancel', actor: 'staff', reason: 'customer_changed_mind' },
      MUCH_LATER,
    );
    const after = await prisma.loyaltyMember.findUniqueOrThrow({ where: { id: memberId } });
    expect(after.lastActivityAt).toEqual(afterRedeem.lastActivityAt);
  });

  it('refuses the reward with the program switched off mid-checkout', async () => {
    await memberWith(100);
    const key = nextKey();
    const token = await verify(key);
    await setLoyaltyEnabled(false);
    const refused = await placeWith(key, token);
    if (refused.ok) throw new Error('expected a refusal');
    expect(refused.errors[0]).toMatchObject({ reason: 'loyalty_disabled' });
  });
});

describe('the program screen, with two ways to redeem', () => {
  it('keeps a returned reward out of the number labelled “Staff corrections”', async () => {
    // The screen names that number after a person. A checkout redemption
    // handed back on a cancelled order is an `adjust` too — summing the kind
    // would file the system's own bookkeeping under somebody's name, which is
    // a false sentence rather than an imprecise one.
    await seedSettings({ loyaltyEnabled: true });
    const enrolled = await enrolMember({
      phone: '5550102233',
      displayName: 'Ivy Castellanos',
      now: AT,
    });
    if (!enrolled.ok) throw new Error(enrolled.reason);
    await prisma.loyaltyEvent.create({
      data: { memberId: enrolled.memberId, at: AT, kind: 'adjust', points: 100, reason: 'opening balance' },
    });

    const key = 'e4a7b2c9-0000-4000-8000-400000000001';
    const started = await startPhoneVerification('5550102233', AT);
    if (!started.ok || started.echoedCode === null) throw new Error('verification refused');
    const confirmed = await confirmPhoneVerificationForCheckout(
      '5550102233',
      started.echoedCode,
      key,
      AT,
    );
    if (!confirmed.ok) throw new Error('confirmation refused');
    const placed = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: 1495,
            composition: {
              itemId: 'burrito',
              quantity: 1,
              selections: [
                { groupId: 'protein', optionId: 'carnitas' },
                { groupId: 'addons', optionId: 'guacamole' },
              ] as never,
            },
          },
        ],
      },
      customerName: 'Ivy Castellanos',
      customerPhone: '5550102233',
      idempotencyKey: key,
      now: AT,
      verifiedPhoneToken: confirmed.token,
    });
    if (!placed.ok) throw new Error('placement refused');

    await applyOrderAction(
      placed.order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      AT,
    );

    const report = await loadLoyaltyProgram(new Date(Date.UTC(2026, 0, 1)));
    // The opening balance a person typed, and nothing else.
    expect(report.window.pointsAdjusted).toBe(100);
    // The reward that came back, on its own line.
    expect(report.window.pointsReturned).toBe(100);
    // And the redemption itself is still counted as one, with its cost — the
    // order died, but it did happen and the screen says so.
    expect(report.window).toMatchObject({ redemptions: 1, redeemedCents: 1000, pointsRedeemed: 100 });
  });
});

// --- The balance under concurrency (C-119) ---------------------------------
//
// The defect C-118 named and left: the balance a redemption is planned
// against was read outside any transaction, so two redemptions racing each
// saw the same 100 points and each wrote a `redeem`. The per-order unique
// index cannot catch it — it is per ORDER, and these are two orders.
//
// These tests are the reproduction, kept. Each one FAILED before the member
// row lock existed, at `balance = -100` with two rewards granted.

describe('two redemptions racing for one balance', () => {
  const PHONE = '5550102233';
  const SUBTOTAL = 1495;

  const BURRITO = {
    id: 'line-1',
    unitPriceAtAddCents: SUBTOTAL,
    composition: {
      itemId: 'burrito',
      quantity: 1,
      selections: [
        { groupId: 'protein', optionId: 'carnitas' },
        { groupId: 'addons', optionId: 'guacamole' },
      ],
    },
  } as const;

  /** Enrol with exactly ONE reward's worth of points — the fixture the whole
   *  block turns on: enough for one, never for two. */
  const memberWithOneReward = async () => {
    await seedSettings({ loyaltyEnabled: true });
    const result = await enrolMember({ phone: PHONE, displayName: 'Ivy Castellanos', now: AT });
    if (!result.ok) throw new Error(result.reason);
    await prisma.loyaltyEvent.create({
      data: { memberId: result.memberId, at: AT, kind: 'adjust', points: 100, reason: 'opening balance' },
    });
    return result.memberId;
  };

  /** `now` is a parameter because a token lives ten minutes
   *  (`VERIFY_TOKEN_TTL_MINUTES`) and one test places an hour later — minting
   *  at `AT` and placing at `AT + 60` refuses `expired` before the balance is
   *  ever consulted, which is C-116 working and not the race under test. */
  const tokenFor = async (idempotencyKey: string, now: Date = AT) => {
    const started = await startPhoneVerification(PHONE, now);
    if (!started.ok || started.echoedCode === null) throw new Error('verification refused');
    const confirmed = await confirmPhoneVerificationForCheckout(
      PHONE,
      started.echoedCode,
      idempotencyKey,
      now,
    );
    if (!confirmed.ok) throw new Error('confirmation refused');
    return confirmed.token;
  };

  const placeWithReward = async (idempotencyKey: string, verifiedPhoneToken: string) =>
    placeOrder({
      cart: { lines: [BURRITO as never] },
      customerName: 'Ivy Castellanos',
      customerPhone: PHONE,
      idempotencyKey,
      now: AT,
      verifiedPhoneToken,
    });

  const KEY_A = 'd0d0d0d0-0000-4000-8000-500000000001';
  const KEY_B = 'd1d1d1d1-0000-4000-8000-500000000002';

  it('serves exactly one of two SIMULTANEOUS checkouts, and never goes below zero', async () => {
    await memberWithOneReward();
    // Two separate checkout attempts — two idempotency keys, two tokens. This
    // is not a double-tap; it is one customer with two tabs, which self-serve
    // redemption is what made possible.
    const [tokenA, tokenB] = [await tokenFor(KEY_A), await tokenFor(KEY_B)];

    const results = await Promise.all([
      placeWithReward(KEY_A, tokenA),
      placeWithReward(KEY_B, tokenB),
    ]);

    // One order at the discounted price, one refusal by name.
    const granted = results.filter((result) => result.ok);
    const refused = results.filter((result) => !result.ok);
    expect(granted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      errors: [expect.objectContaining({ kind: 'reward_unavailable', reason: 'not_enough_points' })],
    });

    // THE ASSERTION THE DEFECT FAILED: a balance is a sum and it may not be
    // negative. Before the lock this read −100.
    expect((await memberByPhone(PHONE))?.balance).toBe(0);
    expect(await prisma.loyaltyEvent.count({ where: { kind: 'redeem' } })).toBe(1);

    // And the refusal wrote NOTHING: one order, not two, and no orphaned row
    // from the transaction that rolled back.
    expect(await prisma.order.count()).toBe(1);
  });

  it('leaves no gap in the day’s order numbers when it refuses', async () => {
    // The reason the lock is taken BEFORE `Order.create`. A refusal that
    // rolled back an order row would leave #001 followed by #003, with
    // nothing in between and nobody able to say why.
    await memberWithOneReward();
    const [tokenA, tokenB] = [await tokenFor(KEY_A), await tokenFor(KEY_B)];
    await Promise.all([placeWithReward(KEY_A, tokenA), placeWithReward(KEY_B, tokenB)]);

    // A third, ordinary order — no reward, placed after the collision.
    const after = await placeOrder({
      cart: { lines: [BURRITO as never] },
      customerName: 'Wren Alcott',
      customerPhone: '5550107777',
      idempotencyKey: 'd2d2d2d2-0000-4000-8000-500000000003',
      now: AT,
    });
    if (!after.ok) throw new Error('the ordinary placement was refused');

    const seqs = (await prisma.order.findMany({ select: { seq: true }, orderBy: { seq: 'asc' } }))
      .map((order) => order.seq);
    expect(seqs).toEqual([1, 2]);
  });

  it('serves one of two simultaneous COUNTER redemptions, on two orders', async () => {
    // The same defect on the path that has had it since C-104, and the reason
    // it is fixed in the same session: two staff on two tablets, one member,
    // two of their orders on the board. Neither order has been redeemed
    // against, so the per-order index never fires.
    await memberWithOneReward();
    const place = async (key: string, name: string) => {
      const result = await placeOrder({
        cart: { lines: [BURRITO as never] },
        customerName: name,
        customerPhone: PHONE,
        idempotencyKey: key,
        now: AT,
      });
      if (!result.ok) throw new Error('placement refused');
      return result.order.id;
    };
    const [first, second] = [
      await place('d3d3d3d3-0000-4000-8000-500000000004', 'Ivy Castellanos'),
      await place('d4d4d4d4-0000-4000-8000-500000000005', 'Ivy Castellanos'),
    ];

    const results = await Promise.all([
      redeemReward(first, AT, 'staff-noor'),
      redeemReward(second, AT, 'staff-noor'),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.find((result) => !result.ok)).toMatchObject({
      ok: false,
      reason: 'not_enough_points',
    });
    expect((await memberByPhone(PHONE))?.balance).toBe(0);

    // BOTH HALVES of the loser rolled back, which is the whole reason the
    // refusal is thrown rather than returned: an `adjustment` with no `redeem`
    // beside it is ten dollars off somebody's ticket for free.
    expect(await prisma.loyaltyEvent.count({ where: { kind: 'redeem' } })).toBe(1);
    expect(await prisma.orderEvent.count({ where: { kind: 'adjustment' } })).toBe(1);
  });

  it('still serves BOTH when the member can actually afford both', async () => {
    // The lock serialises; it does not refuse. 200 points is two rewards and
    // both orders get one — a fix that made concurrent redemptions fail would
    // be a different defect wearing this one's clothes.
    const memberId = await memberWithOneReward();
    await prisma.loyaltyEvent.create({
      data: { memberId, at: AT, kind: 'adjust', points: 100, reason: 'second reward' },
    });
    const [tokenA, tokenB] = [await tokenFor(KEY_A), await tokenFor(KEY_B)];

    const results = await Promise.all([
      placeWithReward(KEY_A, tokenA),
      placeWithReward(KEY_B, tokenB),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect((await memberByPhone(PHONE))?.balance).toBe(0);
    expect(await prisma.loyaltyEvent.count({ where: { kind: 'redeem' } })).toBe(2);
    for (const result of results) {
      if (!result.ok) throw new Error('unreachable');
      expect(result.order).toMatchObject({ discountCents: 1000, totalCents: 536 });
    }
  });

  it('holds under eight at once, which is not a number a person produces', async () => {
    // Not realism — a margin. Eight tabs is absurd; the point is that the
    // serialisation is a lock rather than a two-way coincidence, so the
    // answer is the same at eight as at two.
    const memberId = await memberWithOneReward();
    await prisma.loyaltyEvent.create({
      data: { memberId, at: AT, kind: 'adjust', points: 200, reason: 'three rewards total' },
    });

    const keys = Array.from(
      { length: 8 },
      (_unused, index) => `d5d5d5d5-0000-4000-8000-5000000000${String(index + 10)}`,
    );
    const tokens: string[] = [];
    for (const key of keys) tokens.push(await tokenFor(key));

    const results = await Promise.all(
      keys.map((key, index) => placeWithReward(key, tokens[index]!)),
    );

    // Three rewards' worth of points, three orders discounted, five refused.
    expect(results.filter((result) => result.ok)).toHaveLength(3);
    expect((await memberByPhone(PHONE))?.balance).toBe(0);
    expect(await prisma.loyaltyEvent.count({ where: { kind: 'redeem' } })).toBe(3);
    expect(await prisma.order.count()).toBe(3);
  });

  it('reads the balance BEHIND the member lock, not in front of it', async () => {
    // THE MECHANISM, isolated — and the reason this test is shaped so oddly.
    //
    // The placement-level tests above do not prove the lock. They prove the
    // fix, which is two things: re-reading the balance inside the transaction,
    // and doing it after the UPDATE that locks the row. Neuter the second by
    // moving the UPDATE below the SELECT and every one of them stays green
    // except the counter's — because two `placeOrder` calls under
    // `Promise.all` do enough sequential work apiece (the menu, the gate, the
    // token) that the first transaction commits before the second opens, so
    // the re-read alone happens to win. That is scheduling luck on a laptop,
    // not a property of the code, and a real server under load has no such
    // luck.
    //
    // So this drives one transaction to TAKE the lock and spend the points,
    // holds it open, and asks `lockMemberBalance` what it sees. The sleeps
    // make the ordering deterministic rather than likely. Reading 100 here —
    // a balance that has already been spent — is the defect; reading 0 is the
    // lock doing its job.
    const memberId = await memberWithOneReward();
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.loyaltyMember.update({ where: { id: memberId }, data: { lastActivityAt: AT } });
        await tx.loyaltyEvent.create({
          data: { memberId, at: AT, kind: 'adjust', points: -100, reason: 'spent' },
        });
        await held;
      },
      { timeout: 20_000 },
    );
    // Long enough for the holder to have taken the row lock.
    await pause(250);

    const waiter = prisma.$transaction(async (tx) => lockMemberBalance(tx, memberId, AT), {
      timeout: 20_000,
    });
    // Long enough for the waiter to have reached — and blocked on — the lock.
    await pause(250);
    release();
    await holder;

    expect(await waiter).toBe(0);
  });

  it('serialises two transactions that open at the same instant', async () => {
    // The mechanism, tested apart from placement.
    //
    // This test exists because the placement-level tests above do NOT prove
    // it. Re-checking the balance inside the transaction is half the fix and
    // the half that happens to win at the interleaving `Promise.all` over two
    // `placeOrder` calls produces — each does enough sequential work before
    // its transaction (the menu, the gate, the token) that the first commits
    // before the second begins. Neuter the lock by moving the UPDATE after
    // the SELECT and those tests stay green; only the counter one goes red.
    //
    // So this drives `confirmCheckoutRedemption` directly, in two
    // transactions with nothing in front of them, which is the shape a real
    // server under load produces and a test with a menu load in the way does
    // not. Without the row lock the second SELECT reads a balance the first
    // transaction has not yet committed away, and both confirm.
    const memberId = await memberWithOneReward();
    const plan = {
      memberId,
      pointsSpent: -100,
      amountCents: 1000,
      subtotalCents: SUBTOTAL,
    };

    const confirm = () =>
      prisma.$transaction(async (tx) => {
        const result = await confirmCheckoutRedemption(tx, plan, AT);
        // Spend the points for real when confirmed, so the second transaction
        // has something committed to find. `orderId: null` is legal on an
        // `adjust` but not on a `redeem`, so this writes against a real order.
        if (result.ok) {
          await tx.loyaltyEvent.create({
            data: { memberId, at: AT, kind: 'adjust', points: -100, reason: 'spent' },
          });
        }
        return result;
      });

    const [first, second] = await Promise.all([confirm(), confirm()]);
    const confirmed = [first, second].filter((result) => result.ok);
    expect(confirmed).toHaveLength(1);
    expect([first, second].find((result) => !result.ok)).toMatchObject({
      reason: 'not_enough_points',
    });
    expect((await memberByPhone(PHONE))?.balance).toBe(0);
  });

  it('does not move the expiry clock on a redemption it refuses', async () => {
    // `lockMemberBalance` moves `lastActivityAt` BECAUSE moving it is what
    // takes the lock — so a refused redemption would leave the clock moved by
    // a spend that never happened, if the rollback did not carry it.
    const memberId = await memberWithOneReward();
    const before = await prisma.loyaltyMember.findUniqueOrThrow({ where: { id: memberId } });
    const LATER = instantMinutesAfter(AT, 60);

    const [tokenA, tokenB] = [await tokenFor(KEY_A, LATER), await tokenFor(KEY_B, LATER)];
    const raced = await Promise.all([
      placeOrder({
        cart: { lines: [BURRITO as never] },
        customerName: 'Ivy Castellanos',
        customerPhone: PHONE,
        idempotencyKey: KEY_A,
        now: LATER,
        verifiedPhoneToken: tokenA,
      }),
      placeOrder({
        cart: { lines: [BURRITO as never] },
        customerName: 'Ivy Castellanos',
        customerPhone: PHONE,
        idempotencyKey: KEY_B,
        now: LATER,
        verifiedPhoneToken: tokenB,
      }),
    ]);

    // One served, one refused — the precondition this test's real assertion
    // rests on, stated so a token expiring cannot make it pass vacuously.
    expect(raced.filter((result) => result.ok)).toHaveLength(1);

    const after = await prisma.loyaltyMember.findUniqueOrThrow({ where: { id: memberId } });
    // Moved once, by the one that succeeded — never twice, and never by the
    // one that rolled back.
    expect(after.lastActivityAt).toEqual(LATER);
    expect(after.lastActivityAt.getTime()).toBeGreaterThan(before.lastActivityAt.getTime());
  });
});
