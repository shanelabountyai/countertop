import { salesReport, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder } from './placement';
import { loadReportOrders } from './report';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

// C-016 at the database grain. The engine's own arithmetic is proved in
// packages/core/orders/report.test.ts; what is proved HERE is the two things
// only a real database can show:
//
//   1. The report reads snapshots. Rename, reprice, 86 and delete every menu
//      row an order was composed from, and the report does not move a cent.
//   2. The loader's shape actually satisfies the engine's input, through the
//      real placement path rather than a hand-built row.

// A frozen instant. 2026-07-14T19:30:00Z is 12:30 in Los Angeles — lunch, and
// the same local day as the UTC one, so a bucketing mistake shows up as an
// HOUR here and the timezone unit tests carry the day-boundary case.
const AT = new Date(Date.UTC(2026, 6, 14, 19, 30, 0));
const LA = 'America/Los_Angeles';

const cart = (quantity: number): Cart => ({
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1345,
      composition: {
        itemId: 'burrito',
        quantity,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
        ],
      },
    },
  ],
});

let keyCounter = 0;
async function place(quantity = 1, at: Date = AT): Promise<string> {
  const result = await placeOrder({
    cart: cart(quantity),
    customerName: 'Dana',
    idempotencyKey: `report-${(keyCounter += 1)}`,
    now: at,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order.id;
}

/** Walk an order forward to a terminal state through the REAL transitions, so
 *  the statuses the report counts are ones the state machine actually reaches. */
async function advanceTo(id: string, target: 'picked_up' | 'abandoned'): Promise<void> {
  const steps = target === 'picked_up' ? 4 : 3;
  for (let step = 0; step < steps; step += 1) {
    const result = await applyOrderAction(id, { kind: 'advance', actor: 'staff' }, AT);
    if (!result.ok) throw new Error(`advance refused: ${result.failure.message}`);
  }
  if (target === 'abandoned') {
    const result = await applyOrderAction(id, { kind: 'abandon', actor: 'staff' }, AT);
    if (!result.ok) throw new Error(`abandon refused: ${result.failure.message}`);
  }
}

const EPOCH = new Date(Date.UTC(1970, 0, 1));
const reportSince = async (since = EPOCH) => salesReport(await loadReportOrders(since), LA);

describe('the sales report, against the database', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings({ timezone: LA });
    await seedStoreHours();
  });

  it('buckets a real placement in the restaurant hour, not the UTC one', async () => {
    await advanceTo(await place(), 'picked_up');
    const report = await reportSince();

    // 19:30Z is 12:30 in Los Angeles.
    expect(report.hours).toEqual([{ hour: 12, orders: 1, items: 1, totalCents: 1456 }]);
    expect(report.days[0]?.day).toBe('2026-07-14');
    // 1095 + 0 chicken + 250 guac + 0 onions(negated) = 1345.
    // Tax 1345 x 82_500ppm = 110.9625 -> 111. Total 1456.
    expect(report.days[0]).toMatchObject({ subtotalCents: 1345, taxCents: 111, totalCents: 1456 });
  });

  it('counts only picked-up orders, and rates no-shows over what finished', async () => {
    await advanceTo(await place(), 'picked_up');
    await advanceTo(await place(), 'picked_up');
    await advanceTo(await place(9), 'abandoned');
    await place(9); // still `placed` — in flight, booked as nothing

    const report = await reportSince();
    expect(report.topItems).toEqual([
      { itemName: 'Burrito', quantity: 2, revenueCents: 2690 },
    ]);
    expect(report.noShow).toEqual({ sold: 2, noShow: 1, rate: 1 / 3 });
    expect(report.inFlight).toBe(1);
  });

  it('rates guacamole against burritos, and never counts the negated onions', async () => {
    await advanceTo(await place(2), 'picked_up');
    const report = await reportSince();

    // Both attach at 100%, so the tie breaks on option name: Chicken, then
    // Guacamole. A ranked list has to be deterministic or the screen reorders
    // itself between two identical reports.
    expect(report.attachRates).toEqual([
      {
        itemName: 'Burrito',
        groupName: 'Protein',
        optionName: 'Chicken',
        withOption: 2,
        ofTotal: 2,
        rate: 1,
      },
      {
        itemName: 'Burrito',
        groupName: 'Add-ons',
        optionName: 'Guacamole',
        withOption: 2,
        ofTotal: 2,
        rate: 1,
      },
    ]);
    // "NO onions" was on every one of those burritos and appears nowhere.
    expect(report.attachRates.some((rate) => rate.optionName === 'Onions')).toBe(false);
  });

  // THE SNAPSHOT RULE, in report form. This is the test that fails the moment
  // someone "improves" the report by joining a menu table for a nicer name.
  it('is byte-identical after every menu row it reported on is mutated or deleted', async () => {
    await advanceTo(await place(2), 'picked_up');
    const before = await reportSince();

    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'Renamed Burrito', basePriceCents: 9900, available: false },
    });
    await prisma.modifierOption.update({
      where: { id: 'guacamole' },
      data: { name: 'Renamed Guac', priceDeltaCents: 9900, available: false },
    });
    await prisma.modifierGroup.update({ where: { id: 'addons' }, data: { name: 'Renamed Add-ons' } });
    // And the destructive one C-015 made possible: delete the group outright.
    await prisma.itemModifierGroup.deleteMany({ where: { groupId: 'toppings' } });
    await prisma.modifierGroup.delete({ where: { id: 'toppings' } });

    expect(await reportSince()).toEqual(before);
  });

  it('excludes orders placed before the window, by instant', async () => {
    const older = new Date(Date.UTC(2026, 6, 1, 19, 30, 0));
    await advanceTo(await place(1, older), 'picked_up');
    await advanceTo(await place(1, AT), 'picked_up');

    const report = await salesReport(
      await loadReportOrders(new Date(Date.UTC(2026, 6, 10, 0, 0, 0))),
      LA,
    );
    expect(report.days.map((day) => day.day)).toEqual(['2026-07-14']);
  });
});
