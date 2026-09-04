import { describe, expect, it } from 'vitest';
import { salesReport, type ReportableOrder, type ReportableLine } from './report';

// C-016. Every number below is hand-counted from the fixtures in this file.
//
// The bucketing is the point. `LA` is UTC-7 in July, so an order placed at
// 2026-07-14T02:30:00Z is 7:30pm on the THIRTEENTH in Los Angeles — a
// different day AND a different hour from what UTC would say. A report that
// buckets on the instant passes every other test in this file and gets this
// one wrong, which is why it is first.
const LA = 'America/Los_Angeles';

const line = (
  itemName: string,
  quantity: number,
  lineTotalCents: number,
  options: ReportableLine['options'] = [],
): ReportableLine => ({ itemName, quantity, lineTotalCents, options });

const opt = (
  groupName: string,
  optionName: string,
  intensity: 'none' | 'light' | 'regular' | 'extra' | null = null,
) => ({ groupName, optionName, intensity });

/** A fixed instant from UTC components. `new Date(string)` is banned by lint
 *  for the whole repo, tests included — and the ban is right here too: a
 *  fixture that means an instant should say so in the only way that cannot be
 *  read through the process timezone. Month is 1-based, because `Date.UTC`'s
 *  0-based one is its own trap. */
const utc = (year: number, month: number, day: number, hour: number, minute = 0): Date =>
  new Date(Date.UTC(year, month - 1, day, hour, minute));

let seq = 0;

const order = (
  at: Date,
  lines: ReportableLine[],
  status: ReportableOrder['status'] = 'picked_up',
  money = { subtotalCents: 0, taxCents: 0, totalCents: 0 },
  payment: ReportableOrder['paymentState'] = 'paid',
): ReportableOrder => ({
  status,
  placedAt: at,
  // A running number, so the fixtures that do not care about the chase list
  // still produce distinguishable rows in it. `paid` is the default for the
  // same reason: every test written before C-051 is about revenue, and an
  // unpaid default would put all of them on the outstanding list.
  seq: (seq += 1),
  customerName: 'Dana',
  paymentState: payment,
  // C-064: the split reads the EVENTS now, so a fixture has to carry the ones
  // its `paymentState` implies. Derived from that argument rather than passed
  // separately, so a test cannot describe an order that is `paid` with no
  // payment on it — which is a state the database's own agreement test forbids.
  events:
    payment === 'unpaid'
      ? []
      : payment === 'paid'
        ? [{ kind: 'payment' as const, amountCents: money.totalCents }]
        : [
            { kind: 'payment' as const, amountCents: money.totalCents },
            { kind: 'refund' as const, amountCents: money.totalCents },
          ],
  cancelReason: null,
  cancelNote: null,
  ...money,
  lines,
});

describe('salesReport — buckets in the restaurant calendar, never UTC', () => {
  it('books a late-evening order on the local day, not the UTC one', () => {
    // 02:30Z on the 14th is 19:30 on the 13th in Los Angeles.
    const report = salesReport([order(utc(2026, 7, 14, 2, 30), [line('Burrito', 1, 1095)])], LA);

    expect(report.days.map((d) => d.day)).toEqual(['2026-07-13']);
    expect(report.hours.map((h) => h.hour)).toEqual([19]);
  });

  it('is the same report whatever the process timezone is', () => {
    // The function takes the zone as a parameter and reads no clock, so this
    // holds by construction — and CI runs the whole suite twice to prove the
    // construction was not quietly abandoned.
    const orders = [order(utc(2026, 7, 14, 2, 30), [line('Burrito', 1, 1095)])];
    expect(salesReport(orders, 'UTC').days[0]?.day).toBe('2026-07-14');
    expect(salesReport(orders, LA).days[0]?.day).toBe('2026-07-13');
  });

  it('splits two orders 40 minutes apart across a local midnight', () => {
    const report = salesReport(
      [
        order(utc(2026, 7, 14, 6, 40), [line('Burrito', 1, 1095)]), // 23:40 on the 13th
        order(utc(2026, 7, 14, 7, 20), [line('Burrito', 1, 1095)]), // 00:20 on the 14th
      ],
      LA,
    );

    expect(report.days.map((d) => [d.day, d.orders])).toEqual([
      ['2026-07-13', 1],
      ['2026-07-14', 1],
    ]);
    expect(report.hours.map((h) => h.hour)).toEqual([0, 23]);
  });

  it('buckets across a DST spring-forward without losing an order', () => {
    // 2026-03-08 is the US spring-forward: 02:00 local never happens.
    const report = salesReport(
      [
        order(utc(2026, 3, 8, 9, 30), [line('Burrito', 1, 1095)]), // 01:30 PST
        order(utc(2026, 3, 8, 10, 30), [line('Burrito', 1, 1095)]), // 03:30 PDT
      ],
      LA,
    );

    expect(report.days).toHaveLength(1);
    expect(report.days[0]?.orders).toBe(2);
    // An hour that does not exist locally is simply never a bucket.
    expect(report.hours.map((h) => h.hour)).toEqual([1, 3]);
  });
});

describe('salesReport — what each status counts toward', () => {
  const spread: ReportableOrder[] = [
    order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)], 'picked_up'),
    order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)], 'picked_up'),
    order(utc(2026, 7, 14, 19), [line('Burrito', 9, 9855)], 'cancelled'),
    order(utc(2026, 7, 14, 19), [line('Burrito', 9, 9855)], 'abandoned'),
    order(utc(2026, 7, 14, 19), [line('Burrito', 9, 9855)], 'placed'),
    order(utc(2026, 7, 14, 19), [line('Burrito', 9, 9855)], 'ready'),
  ];

  it('counts items and revenue over picked-up orders only', () => {
    const report = salesReport(spread, LA);
    // 2 units, not 38. The cancelled, abandoned and in-flight nines are the
    // trap: a report summing every row it was handed books food nobody took.
    expect(report.topItems).toEqual([{ itemName: 'Burrito', quantity: 2, revenueCents: 2190 }]);
    expect(report.days[0]?.orders).toBe(2);
  });

  it('reports a no-show rate over FINISHED orders, not over everything', () => {
    // 1 abandoned of 3 finished (2 picked up + 1 abandoned). The cancelled and
    // the two still in flight are in neither half of the fraction.
    expect(salesReport(spread, LA).noShow).toEqual({ sold: 2, noShow: 1, rate: 1 / 3 });
  });

  it('counts orders still on the pass rather than silently dropping them', () => {
    expect(salesReport(spread, LA).inFlight).toBe(2);
  });

  it('reports an unknown no-show rate, not 0%, when nothing finished', () => {
    const report = salesReport([spread[4] as ReportableOrder], LA);
    expect(report.noShow).toEqual({ sold: 0, noShow: 0, rate: null });
  });

  it('is empty, not broken, with no orders at all', () => {
    expect(salesReport([], LA)).toEqual({
      totals: { subtotalCents: 0, taxCents: 0, totalCents: 0 },
      days: [],
      hours: [],
      topItems: [],
      attachRates: [],
      noShow: { sold: 0, noShow: 0, rate: null },
      payment: {
        collectedCents: 0,
        outstandingCents: 0,
        refundedCents: 0,
        outstanding: [],
        unpaidRate: null,
      },
      inFlight: 0,
      cancellations: [],
      remakes: 0,
    });
  });
});

describe('salesReport — cancellations by reason (P0-6)', () => {
  const money = { subtotalCents: 1000, taxCents: 83, totalCents: 1083 };
  const cancelled = (reason: ReportableOrder['cancelReason'], note?: string): ReportableOrder => ({
    ...order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1083)], 'cancelled', money),
    cancelReason: reason,
    cancelNote: note ?? null,
  });

  it('counts and values every cancellation, ranked by how often', () => {
    const report = salesReport(
      [
        cancelled('kitchen_error'),
        cancelled('customer_changed_mind'),
        cancelled('kitchen_error'),
        cancelled('too_busy'),
        cancelled('other', 'power cut'),
        cancelled('out_of_item'),
      ],
      LA,
    );

    // Five reasons over six orders, the doubled one first. $10.83 a ticket.
    expect(report.cancellations).toEqual([
      { reason: 'kitchen_error', orders: 2, totalCents: 2166, notes: [] },
      { reason: 'customer_changed_mind', orders: 1, totalCents: 1083, notes: [] },
      { reason: 'other', orders: 1, totalCents: 1083, notes: ['power cut'] },
      { reason: 'out_of_item', orders: 1, totalCents: 1083, notes: [] },
      { reason: 'too_busy', orders: 1, totalCents: 1083, notes: [] },
    ]);
  });

  it('keeps the cancelled money out of every other number on the page', () => {
    // The table exists BECAUSE these orders count toward nothing else. If
    // adding it ever books a cancelled ticket as a sale, this fails first.
    const report = salesReport([cancelled('kitchen_error')], LA);
    expect(report.totals).toEqual({ subtotalCents: 0, taxCents: 0, totalCents: 0 });
    expect(report.topItems).toEqual([]);
    expect(report.days).toEqual([]);
    expect(report.cancellations[0]?.totalCents).toBe(1083);
  });

  it('reports a cancellation with no stored reason rather than dropping it', () => {
    // Nothing writes a null today — but a table whose counts do not add up to
    // the number of orders cancelled is worse than one that says "other".
    const report = salesReport([cancelled(null), cancelled('other', 'delivery driver no-show')], LA);
    expect(report.cancellations).toEqual([
      { reason: 'other', orders: 2, totalCents: 2166, notes: ['delivery driver no-show'] },
    ]);
  });

  it('says nothing at all when nothing was cancelled', () => {
    expect(salesReport([order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)])], LA).cancellations)
      .toEqual([]);
  });
});

describe('salesReport — modifier attach rates', () => {
  // Four burritos across three orders: two take guacamole, one says NO onions,
  // and one takes nothing. Plus a bowl, which must not dilute the burrito's
  // denominator.
  const orders: ReportableOrder[] = [
    order(utc(2026, 7, 14, 19), [
      line('Burrito', 2, 2690, [opt('Add-ons', 'Guacamole'), opt('Toppings', 'Onions', 'none')]),
    ]),
    order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)]),
    order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1345, [opt('Add-ons', 'Queso')])]),
    order(utc(2026, 7, 14, 19), [line('Burrito bowl', 1, 1195, [opt('Add-ons', 'Guacamole')])]),
  ];

  it('rates an option against the units of ITS OWN item', () => {
    const report = salesReport(orders, LA);
    const guac = report.attachRates.find(
      (rate) => rate.itemName === 'Burrito' && rate.optionName === 'Guacamole',
    );
    // 2 burrito units of 4 took guacamole. The bowl's guacamole is its own row
    // and does not touch this numerator or this denominator.
    expect(guac).toEqual({
      itemName: 'Burrito',
      groupName: 'Add-ons',
      optionName: 'Guacamole',
      withOption: 2,
      ofTotal: 4,
      rate: 0.5,
    });
    expect(
      report.attachRates.find((rate) => rate.itemName === 'Burrito bowl')?.rate,
    ).toBe(1);
  });

  // THE NEGATION. "NO onions" is a choice ABOUT onions, never an order OF
  // them — a report claiming half these burritos added onions, off a column of
  // people removing them, is the transcription bug in report form.
  it('never counts a negation as an attach', () => {
    const onions = salesReport(orders, LA).attachRates.find(
      (rate) => rate.optionName === 'Onions',
    );
    expect(onions).toBeUndefined();
  });

  it('counts a priced intensity as an attach, because it was ordered', () => {
    const report = salesReport(
      [order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1145, [opt('Salsa', 'Chipotle', 'extra')])])],
      LA,
    );
    expect(report.attachRates[0]).toMatchObject({ optionName: 'Chipotle', withOption: 1, rate: 1 });
  });

  it('multiplies the attach by the line quantity, not by the line', () => {
    const report = salesReport(
      [order(utc(2026, 7, 14, 19), [line('Burrito', 3, 4035, [opt('Add-ons', 'Guacamole')])])],
      LA,
    );
    expect(report.attachRates[0]).toMatchObject({ withOption: 3, ofTotal: 3, rate: 1 });
  });

  // P0-4. The bowl's guacamole is 100% and the burrito's is 50%, and the
  // burrito's is the row worth reading: twice the units, and a rate that could
  // have come out otherwise. A rate sort leads with the 100% row every time,
  // which is how a table of required groups pushes the one decidable line off
  // the screen.
  it('ranks by attached volume, so a 100% row does not lead', () => {
    const ranked = salesReport(orders, LA).attachRates.map(
      (rate) => `${rate.itemName}: ${rate.optionName}`,
    );
    expect(ranked).toEqual([
      'Burrito: Guacamole', // 2 units, 50%
      'Burrito: Queso', // 1 unit, 25% — ties break on the item name
      'Burrito bowl: Guacamole', // 1 unit, 100%, and last
    ]);
  });
});

describe('salesReport — the rankings and the money', () => {
  it('ranks top sellers by quantity, breaking ties by name', () => {
    const report = salesReport(
      [
        order(utc(2026, 7, 14, 19), [line('Chips & salsa', 5, 2475), line('Burrito', 2, 2190)]),
        order(utc(2026, 7, 14, 19), [line('Taco plate', 2, 2790)]),
      ],
      LA,
    );
    expect(report.topItems.map((item) => [item.itemName, item.quantity])).toEqual([
      ['Chips & salsa', 5],
      ['Burrito', 2],
      ['Taco plate', 2],
    ]);
  });

  it('sums subtotal, tax and total per day from the SNAPSHOT columns', () => {
    // 1095 + 90 tax = 1185, twice: the receipt's own numbers, added up. No
    // rate is applied here — a report that recomputed tax would disagree with
    // every receipt the moment the rate changed.
    const money = { subtotalCents: 1095, taxCents: 90, totalCents: 1185 };
    const report = salesReport(
      [
        order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)], 'picked_up', money),
        order(utc(2026, 7, 14, 20), [line('Burrito', 1, 1095)], 'picked_up', money),
      ],
      LA,
    );
    expect(report.days).toEqual([
      {
        day: '2026-07-14',
        orders: 2,
        items: 2,
        subtotalCents: 2190,
        taxCents: 180,
        totalCents: 2370,
      },
    ]);
  });

  it('keeps a renamed item as two rows, because the snapshots disagree', () => {
    // The honest answer and a real ceiling: the report groups by the name the
    // order was placed under, which is the only name it HAS without joining a
    // menu table. A rename splits the history; see the write-up.
    const report = salesReport(
      [
        order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)]),
        order(utc(2026, 7, 14, 19), [line('Classic Burrito', 1, 1095)]),
      ],
      LA,
    );
    expect(report.topItems).toHaveLength(2);
  });

  it('separates an item name that contains the attach key separator', () => {
    // The key is JSON, not a delimiter, so a quote or a bracket in a name
    // cannot collide two different options into one rate.
    const report = salesReport(
      [
        order(utc(2026, 7, 14, 19), [line('"Burrito", "Add-ons"', 1, 1095, [opt('X', 'Y')])]),
        order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095, [opt('Add-ons', 'X", "Y')])]),
      ],
      LA,
    );
    expect(report.attachRates).toHaveLength(2);
    expect(report.attachRates.every((rate) => rate.withOption === 1)).toBe(true);
  });
});

describe('salesReport — collected versus charged (defect D2, C-051)', () => {
  const AT = utc(2026, 7, 14, 19);
  const money = (totalCents: number) => ({ subtotalCents: totalCents, taxCents: 0, totalCents });

  it('separates the money that came in from the money that was booked', () => {
    const paid = order(AT, [line('Burrito', 1, 1095)], 'picked_up', money(1195), 'paid');
    const unpaid = order(AT, [line('Bowl', 1, 1430)], 'picked_up', money(1430), 'unpaid');
    const report = salesReport([paid, unpaid], LA);

    const charged = report.days[0]?.totalCents ?? 0;
    expect(charged).toBe(2625);
    expect(report.payment.collectedCents).toBe(1195);
    expect(report.payment.collectedCents).not.toBe(charged);
    // To the cent. This delta is the whole defect: before C-051 the screen
    // said 2625 and the drawer held 1195, and nothing reconciled the two.
    expect(charged - report.payment.collectedCents).toBe(1430);
    expect(report.payment.outstandingCents).toBe(1430);
    expect(report.payment.outstanding).toEqual([
      { day: '2026-07-14', seq: unpaid.seq, customerName: 'Dana', owedCents: 1430 },
    ]);
    expect(report.payment.unpaidRate).toBe(1 / 2);
  });

  it('does not chase an unpaid order nobody was handed', () => {
    // Cancelled, abandoned and still-cooking orders are `unpaid` too, and none
    // of them is money anybody owes. The split covers exactly the set revenue
    // covers — the defect was revenue counting uncollected money, not the
    // product forgetting to bill a no-show.
    const report = salesReport(
      [
        order(AT, [line('Burrito', 1, 1095)], 'cancelled', money(1195), 'unpaid'),
        order(AT, [line('Burrito', 1, 1095)], 'abandoned', money(1195), 'unpaid'),
        order(AT, [line('Burrito', 1, 1095)], 'preparing', money(1195), 'unpaid'),
      ],
      LA,
    );

    expect(report.payment.outstanding).toEqual([]);
    expect(report.payment.outstandingCents).toBe(0);
    expect(report.payment.unpaidRate).toBeNull();
  });

  it('keeps a refund in its own bucket, and shows the money as owed', () => {
    const report = salesReport(
      [order(AT, [line('Burrito', 1, 1095)], 'picked_up', money(1195), 'refunded')],
      LA,
    );

    // C-064 CHANGED THIS, and the new answer is the more honest one. Under the
    // enum a refunded order counted toward neither collected nor outstanding
    // and simply vanished from the split. Under the balance the customer has
    // the food and we hold nothing — which is money owed, and it belongs on
    // the chase list. Unreachable today (a refund only accompanies a cancel,
    // and a cancelled order is not a sale), and written down because the day
    // C-067 lets a picked-up order be refunded, this is what the report says.
    expect(report.payment.collectedCents).toBe(0);
    expect(report.payment.outstandingCents).toBe(1195);
    // Its own bucket still, netted into neither.
    expect(report.payment.refundedCents).toBe(1195);
    // Still booked as revenue: the split explains the headline, it never
    // restates it (decision 2026-09-01 #1).
    expect(report.days[0]?.totalCents).toBe(1195);
  });

  it('splits every window exactly into collected and outstanding', () => {
    // The invariant the balance buys, and one the enum could not hold: a
    // refunded order used to fall out of both halves. Now every cent of
    // revenue is in exactly one of them.
    const report = salesReport(
      [
        order(AT, [line('Burrito', 1, 1)], 'picked_up', money(1195), 'paid'),
        order(AT, [line('Bowl', 1, 1)], 'picked_up', money(1430), 'unpaid'),
        order(AT, [line('Bowl', 1, 1)], 'picked_up', money(900), 'refunded'),
      ],
      LA,
    );

    const revenue = report.days.reduce((sum, day) => sum + day.totalCents, 0);
    expect(report.payment.collectedCents + report.payment.outstandingCents).toBe(revenue);
  });

  it('lists the chase list chronologically, oldest first', () => {
    const report = salesReport(
      [
        order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1)], 'picked_up', money(100), 'unpaid'),
        order(utc(2026, 7, 15, 19), [line('Burrito', 1, 1)], 'picked_up', money(200), 'unpaid'),
      ],
      LA,
    );

    expect(report.payment.outstanding.map((o) => [o.day, o.owedCents])).toEqual([
      ['2026-07-14', 100],
      ['2026-07-15', 200],
    ]);
  });
});

// C-053 / PRD 1 P0-1. The headline was `Σ totalCents` labelled `Revenue`, so a
// bookkeeper booked the state's sales tax as the shop's earnings. Three
// numbers, three facts, and the addition that ties them asserted rather than
// rendered.
describe('salesReport — net sales, tax and gross are three different numbers', () => {
  const money = { subtotalCents: 1095, taxCents: 90, totalCents: 1185 };
  // Two hours on one local day, so the reconciliation is asserted on a row
  // that is a SUM and not a single order's columns copied across.
  const twoHours = [
    order(utc(2026, 7, 14, 19), [line('Burrito', 1, 1095)], 'picked_up', money),
    order(utc(2026, 7, 14, 20), [line('Burrito', 1, 1095)], 'picked_up', money),
    order(utc(2026, 7, 14, 20), [line('Burrito', 1, 1095)], 'picked_up', money),
  ];

  it('reports the window as net, tax and gross', () => {
    expect(salesReport(twoHours, LA).totals).toEqual({
      subtotalCents: 3285,
      taxCents: 270,
      totalCents: 3555,
    });
  });

  it('carries the same three columns on every hour bucket', () => {
    expect(salesReport(twoHours, LA).hours).toEqual([
      { hour: 12, orders: 1, items: 1, subtotalCents: 1095, taxCents: 90, totalCents: 1185 },
      { hour: 13, orders: 2, items: 2, subtotalCents: 2190, taxCents: 180, totalCents: 2370 },
    ]);
  });

  it('reconciles net + tax = gross on every row and on the window', () => {
    // The assertion the requirement asks for, over a fixture with a tax that
    // does not divide evenly into the subtotal — 90 on 1095 is 8.219%, so a
    // report that recomputed tax from a rate instead of reading the snapshot
    // would land a cent away and this would catch it.
    const report = salesReport(twoHours, LA);
    for (const row of [...report.days, ...report.hours, report.totals]) {
      expect(row.subtotalCents + row.taxCents).toBe(row.totalCents);
    }
  });

  it('counts tax on sold orders only, like every other money figure', () => {
    // The cancelled order carries ten times the money. A headline that summed
    // what it was handed would book it.
    const report = salesReport(
      [
        ...twoHours,
        order(utc(2026, 7, 14, 20), [line('Burrito', 9, 9855)], 'cancelled', {
          subtotalCents: 9855,
          taxCents: 810,
          totalCents: 10665,
        }),
      ],
      LA,
    );
    expect(report.totals).toEqual({ subtotalCents: 3285, taxCents: 270, totalCents: 3555 });
  });
});
