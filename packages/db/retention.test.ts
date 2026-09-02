import { FORGOTTEN_CUSTOMER_NAME, salesReport, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { searchOrderHistory } from './history';
import { placeOrder } from './placement';
import { loadReportOrders } from './report';
import { forgetOrderCustomer, sweepRetention } from './retention';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

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
async function place(name: string, at: Date): Promise<string> {
  const result = await placeOrder({
    cart: cart(),
    customerName: name,
    customerPhone: '555-010-0100',
    orderNote: 'blue Honda out front',
    paidNow: true,
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

    await seedSettings({ retentionDays: 1 });
    const swept = await sweepRetention(NOW);

    expect(swept).toEqual({ retentionDays: 1, forgotten: 1 });
  });

  // The mechanism, not the code path: there is no settings screen for this,
  // and the CHECK is here for the day somebody adds one.
  it('refuses a window of zero days, which would forget the order on the pass', async () => {
    for (const retentionDays of [0, -1]) {
      await expect(
        prisma.restaurantSettings.update({ where: { id: 'singleton' }, data: { retentionDays } }),
      ).rejects.toThrow(/retention_days_positive/);
    }
  });

  describe('forgetting one customer on demand', () => {
    it('forgets a recent order the sweep would not have touched', async () => {
      const recent = await place('Ivy', RECENT);

      expect(await forgetOrderCustomer(recent)).toEqual({ ok: true, forgotten: 1 });

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
      expect(await forgetOrderCustomer('no-such-order')).toEqual({ ok: false, forgotten: 0 });
    });

    it('is idempotent — a second press reports nothing left to remove', async () => {
      const recent = await place('Ivy', RECENT);

      expect((await forgetOrderCustomer(recent)).forgotten).toBe(1);
      expect((await forgetOrderCustomer(recent)).forgotten).toBe(0);
    });
  });
});
