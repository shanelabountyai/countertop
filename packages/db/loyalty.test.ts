// What the DATABASE refuses about a loyalty ledger (PRD 7 P0-2, C-100).
//
// The core suite proves the arithmetic. These prove the mechanisms — every one
// of them a thing the application code is then allowed to be careless about,
// which is the discipline this repo applies to order numbers, idempotency keys
// and money amounts.
import { loyaltyBalance, orderBalance } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { enrolMember, memberByPhone, phoneDigest, redeemReward } from './loyalty';
import { placeOrder } from './placement';
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
    await prisma.order.update({ where: { id: orderId }, data: { subtotalCents: 99 } });

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
