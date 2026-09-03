import { instantMinutesAfter, salesReport, timeInState, type Cart } from '@countertop/core';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder } from './placement';
import { loadQuoteSamples, loadReportOrders, loadStatusTimelines } from './report';
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
async function place(
  quantity = 1,
  at: Date = AT,
  who: { name?: string; paidNow?: boolean } = {},
): Promise<string> {
  const result = await placeOrder({
    cart: cart(quantity),
    customerName: who.name ?? 'Dana',
    ...(who.paidNow && { paidNow: true }),
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

  // C-051 / defect D2. The engine's arithmetic is proved in packages/core; what
  // is proved here is that the loader hands it the real `paymentState`, `seq`
  // and name — the three columns it did not select before, and the ones a
  // chase list is useless without.
  it('separates collected from charged, and names who still owes', async () => {
    await advanceTo(await place(1, AT, { name: 'Pia', paidNow: true }), 'picked_up');
    await advanceTo(await place(1, AT, { name: 'Ozzy' }), 'picked_up');

    const report = await reportSince();
    const charged = report.days[0]?.totalCents ?? 0;

    // Two identical burritos: 1456 each, 2912 charged, half of it collected.
    expect(charged).toBe(2912);
    expect(report.payment.collectedCents).toBe(1456);
    expect(charged - report.payment.collectedCents).toBe(report.payment.outstandingCents);
    expect(report.payment.outstanding).toEqual([
      { day: '2026-07-14', seq: 2, customerName: 'Ozzy', owedCents: 1456 },
    ]);
    expect(report.payment.unpaidRate).toBe(1 / 2);
  });
});

// C-020: the time-in-state loader. The tally's arithmetic is proved in
// packages/core/orders/time-in-state.test.ts; what is proved here is that the
// events a real order actually writes satisfy it — including the revert, which
// is the case `statusChangedAt` cannot represent at all.
describe('loadStatusTimelines', () => {
  const min = (m: number) => instantMinutesAfter(AT, m);

  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings({ timezone: LA });
    await seedStoreHours();
  });

  it('returns one timeline per order, in the shape the tally takes', async () => {
    await place(1);
    await place(1);

    const timelines = await loadStatusTimelines(EPOCH);
    expect(timelines).toHaveLength(2);
    // Just placed: one event each, and it is the placement.
    expect(timelines.map((events) => events.length)).toEqual([1, 1]);
    expect(timelines[0]![0]).toMatchObject({ toStatus: 'placed', at: AT });
  });

  it('carries both visits when a wrong advance was undone', async () => {
    const id = await place(1);
    for (const [minute] of [[1], [3], [11]] as const) {
      const moved = await applyOrderAction(id, { kind: 'advance', actor: 'staff' }, min(minute));
      if (!moved.ok) throw new Error(moved.failure.message);
    }
    const undone = await applyOrderAction(
      id,
      { kind: 'revert', actor: 'staff', reason: 'wrong card' },
      min(12),
    );
    if (!undone.ok) throw new Error(undone.failure.message);

    const [events] = await loadStatusTimelines(EPOCH);
    const tally = timeInState(events!, min(20));

    // preparing: 3 → 11, then 12 → 20 (still there). Two visits, 8 + 8.
    expect(tally.preparing).toBe(16 * 60_000);
    expect(tally.ready).toBe(1 * 60_000);
  });

  it('excludes orders placed before the window, like the sales loader', async () => {
    await place(1, new Date(Date.UTC(2026, 6, 1, 19, 30, 0)));
    await place(1, AT);

    const timelines = await loadStatusTimelines(new Date(Date.UTC(2026, 6, 10, 0, 0, 0)));
    expect(timelines).toHaveLength(1);
  });
});

describe('the quote samples (P1-4, C-042)', () => {
  const min = (m: number) => instantMinutesAfter(AT, m);

  /** Advance to `ready` at a chosen instant, so a sample's actual minutes are
   *  a number this test picked rather than one the clock produced. */
  async function readyAt(id: string, at: Date): Promise<void> {
    for (const kind of ['advance', 'advance', 'advance'] as const) {
      const result = await applyOrderAction(id, { kind, actor: 'staff' }, at);
      if (!result.ok) throw new Error(result.failure.message);
    }
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings({ timezone: LA });
    await seedStoreHours();
  });

  it('pairs the snapshotted quote with the minutes the kitchen actually took', async () => {
    await readyAt(await place(), min(18));

    const [sample] = await loadQuoteSamples(EPOCH);
    expect(sample).toEqual({
      quotedLowMinutes: 10,
      quotedHighMinutes: 20,
      quotedOpenWeight: 0,
      actualMinutes: 18,
    });
  });

  it('skips an order that has not reached ready — it is not evidence yet', async () => {
    await place();
    expect(await loadQuoteSamples(EPOCH)).toHaveLength(0);
  });

  // The C-004 logged revert, at the database grain: an order advanced by
  // mistake was not ready the first time somebody said so, and grading the
  // estimate against that instant would score the kitchen on a mis-tap.
  it('takes the LAST ready, so a wrong advance that was undone does not count', async () => {
    const id = await place();
    await readyAt(id, min(4));
    const undone = await applyOrderAction(
      id,
      { kind: 'revert', actor: 'staff', reason: 'wrong card' },
      min(5),
    );
    if (!undone.ok) throw new Error(undone.failure.message);
    const again = await applyOrderAction(id, { kind: 'advance', actor: 'staff' }, min(17));
    if (!again.ok) throw new Error(again.failure.message);

    expect((await loadQuoteSamples(EPOCH))[0]?.actualMinutes).toBe(17);
  });

  it('skips an order carrying no quote, rather than inventing one for it', async () => {
    const id = await place();
    await readyAt(id, min(18));
    await prisma.order.update({
      where: { id },
      data: { quotedLowMinutes: null, quotedHighMinutes: null, quotedOpenWeight: null },
    });

    expect(await loadQuoteSamples(EPOCH)).toHaveLength(0);
  });

  it('excludes orders placed before the window, like the other two loaders', async () => {
    const old = await place(1, new Date(Date.UTC(2026, 6, 1, 19, 30, 0)));
    await readyAt(old, new Date(Date.UTC(2026, 6, 1, 19, 48, 0)));
    await readyAt(await place(1, AT), min(18));

    expect(await loadQuoteSamples(new Date(Date.UTC(2026, 6, 10, 0, 0, 0)))).toHaveLength(1);
  });
});

// P0-6: loyalty is PROVABLY invisible to the order snapshot and the sales
// report (C-106).
//
// A STATIC CHECK, deliberately, and it is the only kind that can hold this
// claim. Every other loyalty test asserts that some number came out right;
// this one asserts that a whole category of code is absent — and a runtime
// test cannot see the difference between "the report reads no loyalty table"
// and "the report reads one and it happened to be empty". The requirement is
// about what the query CANNOT do, so the query is what gets read.
//
// It is deliberately blunt: the whole file text, not an import parse. A join
// added through a relation name, a `select` widened by hand, and an import all
// contain the same seven letters, and a cleverer check would pass the first
// two.
describe('the sales report cannot see the loyalty program (P0-6)', () => {
  const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('reads nothing loyalty-shaped anywhere on the query path', () => {
    // The loader and the page that renders it. Both, because P0-6 says "no
    // loyalty number appears on /kitchen/report" — a query kept clean and a
    // page that fetches the balance itself would satisfy half a requirement.
    for (const path of ['./report.ts', '../../apps/web/app/kitchen/report/page.tsx']) {
      expect(source(path).toLowerCase(), `${path} mentions loyalty`).not.toContain('loyalt');
      expect(source(path).toLowerCase(), `${path} mentions points`).not.toContain('rewardvalue');
    }
  });

  it('leaves the order snapshot with no column and no foreign key to a member', () => {
    // Bullet one of P0-6, and the reason is the forget: a member FK on the
    // order would make P0-5's delete either cascade — changing a report count
    // — or restrict, blocking it. Both are wrong, so the requirement is that
    // the column never exists rather than that it points the right way.
    const schema = source('./prisma/schema.prisma');
    const order = /\nmodel Order \{\n([\s\S]*?)\n\}/.exec(schema)?.[1];
    expect(order, 'model Order not found in the schema').toBeDefined();

    const loyaltyLines = (order ?? '')
      .split('\n')
      .filter((line) => /loyalt/i.test(line) && !line.trim().startsWith('///'));
    // Exactly one, and it is the BACK-relation: the list of ledger rows
    // pointing AT this order. No scalar, no `@relation(fields:)`, so there is
    // nothing on the order row itself to delete or to chase.
    expect(loyaltyLines).toHaveLength(1);
    expect(loyaltyLines[0]).toMatch(/^\s*loyaltyEvents\s+LoyaltyEvent\[\]\s*$/);
  });
});
