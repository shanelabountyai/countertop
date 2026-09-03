import { FORGOTTEN_CUSTOMER_NAME, salesReport, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { searchOrderHistory } from './history';
import { placeOrder } from './placement';
import { loadReportOrders } from './report';
import { enrolMember, redeemReward } from './loyalty';
import { collectOrderPayment } from './payment';
import { forgetOrderCustomer, sweepRetention } from './retention';
import { applyOrderAction } from './transitions';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';

// PRD 6 P0-4's own acceptance test (C-091), and the assertion is the whole
// point: the sweep UPDATEs a snapshot table, which this project's rules make
// hardest, and the only thing that makes it legal is that not one number moves.
// If the byte-identical assertion below cannot be made to pass, the sweep is
// wrong, not the test.

const LA = 'America/Los_Angeles';
const NOW = new Date(Date.UTC(2026, 8, 2, 19, 0, 0));
/** Well past a 365-day window from NOW. */
const LONG_AGO = new Date(Date.UTC(2024, 6, 14, 19, 30, 0));
/** Yesterday — inside every window this test configures. */
const RECENT = new Date(Date.UTC(2026, 8, 1, 19, 30, 0));
/** Two days back: inside the default 365-day window, outside a one-day one. */
const TWO_DAYS_AGO = new Date(Date.UTC(2026, 7, 31, 19, 30, 0));
const EPOCH = new Date(Date.UTC(1970, 0, 1));

const cart = (): Cart => ({
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1345,
      composition: {
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
        ],
        // Free text on the LINE. The PRD names three columns; this is the
        // fourth, and it is where "for Dana's birthday" actually gets typed.
        note: 'cut in half please',
      },
    },
  ],
});

let keyCounter = 0;
async function place(name: string, at: Date, paidNow = true): Promise<string> {
  const result = await placeOrder({
    cart: cart(),
    customerName: name,
    customerPhone: '555-010-0100',
    orderNote: 'blue Honda out front',
    paidNow,
    idempotencyKey: `retention-${(keyCounter += 1)}`,
    now: at,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  // All the way to `picked_up` and PAID, so the order counts as a sale and the
  // chase list is empty — which is what lets the assertion below cover the
  // WHOLE report rather than the totals alone. The outstanding list is the one
  // place a customer's name reaches the report at all (C-051).
  for (let step = 0; step < 4; step += 1) {
    const advanced = await applyOrderAction(result.order.id, { kind: 'advance', actor: 'staff' }, at);
    if (!advanced.ok) throw new Error(`advance refused: ${advanced.failure.message}`);
  }
  return result.order.id;
}

const identityOf = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      customerName: true,
      customerPhone: true,
      orderNote: true,
      lines: { select: { note: true } },
    },
  });

const reportNow = async () => salesReport(await loadReportOrders(EPOCH), LA);

describe('retention', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings({ timezone: LA, retentionDays: 365 });
    await seedStoreHours();
    // Only the loyalty block needs it, and it is here because a redemption is
    // attributed to a staff member (C-086) and the survival of that
    // attribution is half of what P0-5 asserts.
    await seedStaff();
  });

  // THE acceptance test.
  it('leaves every number on the sales report byte-identical', async () => {
    await place('Dana', LONG_AGO);
    await place('Ivy', RECENT);
    const before = await reportNow();

    expect((await sweepRetention(NOW)).forgotten).toBe(1);

    expect(await reportNow()).toEqual(before);
  });

  it('takes the name, the phone and both kinds of note off an old order', async () => {
    const old = await place('Dana', LONG_AGO);

    await sweepRetention(NOW);

    expect(await identityOf(old)).toEqual({
      customerName: FORGOTTEN_CUSTOMER_NAME,
      customerPhone: null,
      orderNote: null,
      lines: [{ note: null }],
    });
  });

  it('leaves an order inside the window completely alone', async () => {
    const recent = await place('Ivy', RECENT);

    await sweepRetention(NOW);

    expect(await identityOf(recent)).toEqual({
      customerName: 'Ivy',
      customerPhone: '555-010-0100',
      orderNote: 'blue Honda out front',
      lines: [{ note: 'cut in half please' }],
    });
  });

  it('leaves the order itself — number, money and activity — exactly as it was', async () => {
    const id = await place('Dana', LONG_AGO);
    const shape = {
      select: { seq: true, subtotalCents: true, taxCents: true, totalCents: true, status: true },
    } as const;
    const before = await prisma.order.findUniqueOrThrow({ where: { id }, ...shape });
    const eventsBefore = await prisma.orderEvent.count({ where: { orderId: id } });

    await sweepRetention(NOW);

    expect(await prisma.order.findUniqueOrThrow({ where: { id }, ...shape })).toEqual(before);
    expect(await prisma.orderEvent.count({ where: { orderId: id } })).toBe(eventsBefore);
  });

  it('cannot be found by name afterwards', async () => {
    await place('Dana', LONG_AGO);
    expect(await searchOrderHistory('Dana')).toHaveLength(1);

    await sweepRetention(NOW);

    expect(await searchOrderHistory('Dana')).toHaveLength(0);
  });

  it('reports zero on a second run rather than re-counting what it already forgot', async () => {
    await place('Dana', LONG_AGO);

    expect((await sweepRetention(NOW)).forgotten).toBe(1);
    expect((await sweepRetention(NOW)).forgotten).toBe(0);
  });

  it('reads the window from the settings row, not from a constant', async () => {
    await place('Ivy', TWO_DAYS_AGO);
    // The default 365-day window leaves it alone.
    expect((await sweepRetention(NOW)).forgotten).toBe(0);

    await seedSettings({ retentionDays: 1, loyaltyExpiryDays: 1 });
    const swept = await sweepRetention(NOW);

    expect(swept).toEqual({ retentionDays: 1, forgotten: 1, members: 0 });
  });

  // The mechanism, not the code path: there is no settings screen for this,
  // and the CHECK is here for the day somebody adds one.
  //
  // EITHER NAME IS A PASS, since C-105: a window of zero days now violates
  // `retention_days_positive` AND `loyalty_expiry_within_retention` (365 does
  // not fit inside 0), and which one Postgres reports first is its business.
  // Both refusals say the same thing — the window cannot collapse — and
  // pinning the assertion to one of them would be asserting an ordering
  // nothing promises.
  it('refuses a window of zero days, which would forget the order on the pass', async () => {
    for (const retentionDays of [0, -1]) {
      await expect(
        prisma.restaurantSettings.update({ where: { id: 'singleton' }, data: { retentionDays } }),
      ).rejects.toThrow(/retention_days_positive|loyalty_expiry_within_retention/);
    }
  });

  describe('forgetting one customer on demand', () => {
    it('forgets a recent order the sweep would not have touched', async () => {
      const recent = await place('Ivy', RECENT);

      expect(await forgetOrderCustomer(recent)).toEqual({ ok: true, forgotten: 1, members: 0 });

      expect(await identityOf(recent)).toEqual({
        customerName: FORGOTTEN_CUSTOMER_NAME,
        customerPhone: null,
        orderNote: null,
        lines: [{ note: null }],
      });
    });

    it('leaves every other order alone', async () => {
      const target = await place('Ivy', RECENT);
      const other = await place('Dana', RECENT);

      await forgetOrderCustomer(target);

      expect((await identityOf(other)).customerName).toBe('Dana');
    });

    it('says so when the id matches no order, rather than reporting a forget', async () => {
      expect(await forgetOrderCustomer('no-such-order')).toEqual({
        ok: false,
        forgotten: 0,
        members: 0,
      });
    });

    it('is idempotent — a second press reports nothing left to remove', async () => {
      const recent = await place('Ivy', RECENT);

      expect((await forgetOrderCustomer(recent)).forgotten).toBe(1);
      expect((await forgetOrderCustomer(recent)).forgotten).toBe(0);
    });
  });
  // --- The loyalty side (PRD 7 P0-5, C-105) --------------------------------
  //
  // The same acceptance assertion as above, extended over the loyalty tables:
  // a member with an earn AND a redemption is gone entirely, the money that
  // redemption moved is untouched, and no number on the report shifts. The
  // fixture is deliberately the awkward one — the financial fact and the
  // entitlement were written in the same transaction (C-104), and this is what
  // proves they were never the same record.
  describe('the loyalty member', () => {
    /** An order with a real punch-card history behind it, settled in full so
     *  the chase list stays empty and the report assertion can cover the whole
     *  report rather than the totals alone. */
    async function orderWithLoyaltyHistory(): Promise<string> {
      await seedSettings({ loyaltyEnabled: true });
      const enrolled = await enrolMember({
        phone: '555-010-0100',
        displayName: 'Ivy Castellanos',
        now: RECENT,
      });
      if (!enrolled.ok) throw new Error(enrolled.reason);

      // Unpaid, so there is something for a reward to come off — a redemption
      // is bounded by what is OWED (C-104), and an order paid at checkout owes
      // nothing.
      const id = await place('Ivy', RECENT, false);
      // The pickup earned points; this is the rest of a punch card.
      await prisma.loyaltyEvent.create({
        data: { memberId: enrolled.memberId, at: RECENT, kind: 'adjust', points: 100 },
      });

      const redeemed = await redeemReward(id, RECENT, 'staff-noor');
      if (!redeemed.ok) throw new Error(redeemed.reason);
      const collected = await collectOrderPayment(id, RECENT, 'staff-noor');
      if (!collected.ok) throw new Error(collected.message);
      return id;
    }

    const moneyEvents = (orderId: string) =>
      prisma.orderEvent.findMany({
        where: { orderId, kind: 'adjustment' },
        select: { kind: true, amountCents: true, reason: true, staffId: true, at: true },
      });

    it('is DELETED with its whole ledger, while the money it moved survives', async () => {
      const id = await orderWithLoyaltyHistory();
      expect(await prisma.loyaltyEvent.count()).toBe(3); // earn, adjust, redeem
      const money = await moneyEvents(id);
      const before = await reportNow();

      expect(await forgetOrderCustomer(id)).toEqual({ ok: true, forgotten: 1, members: 1 });

      // Gone, both tables — a real delete through the Cascade, not a scrub.
      expect(await prisma.loyaltyMember.count()).toBe(0);
      expect(await prisma.loyaltyEvent.count()).toBe(0);
      // And the ten dollars is exactly where it was, with the staff member who
      // gave it and the instant they did: the financial fact was never on the
      // loyalty side.
      expect(await moneyEvents(id)).toEqual(money);
      expect(money).toHaveLength(1);
      expect(money[0]).toMatchObject({ amountCents: 1000, reason: 'loyalty_reward' });
      // THE assertion, over a fully enrolled and redeemed order.
      expect(await reportNow()).toEqual(before);
    });

    it('leaves every other member alone', async () => {
      const id = await orderWithLoyaltyHistory();
      const other = await enrolMember({ phone: '5550109999', displayName: 'Dana', now: RECENT });

      await forgetOrderCustomer(id);

      expect(await prisma.loyaltyMember.count()).toBe(1);
      expect(other.ok && (await prisma.loyaltyMember.findUnique({ where: { id: other.memberId } })))
        .toBeTruthy();
    });

    it('reports no member on an order nobody enrolled under', async () => {
      const plain = await place('Dana', RECENT);
      expect(await forgetOrderCustomer(plain)).toEqual({ ok: true, forgotten: 1, members: 0 });
    });

    // The sweep selects the member on ITS OWN clock, which is the whole reason
    // this is not a filter on the orders it just scrubbed: a customer with one
    // ancient order and one from last week has a live punch card.
    it('survives the sweep while the member is still active, and dies when it is not', async () => {
      await seedSettings({ loyaltyEnabled: true });
      const stale = await enrolMember({ phone: '5550101111', displayName: 'Dana', now: LONG_AGO });
      const active = await enrolMember({ phone: '5550102222', displayName: 'Ivy', now: RECENT });
      if (!stale.ok || !active.ok) throw new Error('enrolment refused');

      expect((await sweepRetention(NOW)).members).toBe(1);

      expect(await prisma.loyaltyMember.findMany({ select: { id: true } })).toEqual([
        { id: active.memberId },
      ]);
    });

    // The mechanism P0-5 asks for by name. There is no screen for either
    // number; the CHECK is here for the day somebody adds one.
    it('cannot be configured to outlive the history that explains it', async () => {
      await expect(
        prisma.restaurantSettings.update({
          where: { id: 'singleton' },
          data: { loyaltyExpiryDays: 400, retentionDays: 365 },
        }),
      ).rejects.toThrow(/loyalty_expiry_within_retention/);

      // Both windows moving together is fine — it is the RELATIONSHIP that is
      // constrained, not either number.
      await expect(
        prisma.restaurantSettings.update({
          where: { id: 'singleton' },
          data: { loyaltyExpiryDays: 400, retentionDays: 400 },
        }),
      ).resolves.toBeTruthy();
    });
  });
});
