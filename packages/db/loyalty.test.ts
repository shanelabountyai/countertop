// What the DATABASE refuses about a loyalty ledger (PRD 7 P0-2, C-100).
//
// The core suite proves the arithmetic. These prove the mechanisms — every one
// of them a thing the application code is then allowed to be careless about,
// which is the discipline this repo applies to order numbers, idempotency keys
// and money amounts.
import { loyaltyBalance } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
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
