// What the DATABASE refuses about a loyalty ledger (PRD 7 P0-2, C-100).
//
// The core suite proves the arithmetic. These prove the mechanisms — every one
// of them a thing the application code is then allowed to be careless about,
// which is the discipline this repo applies to order numbers, idempotency keys
// and money amounts.
import { loyaltyBalance } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { enrolMember, memberByPhone, phoneDigest } from './loyalty';
import { placeOrder } from './placement';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';

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
