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

const order = (
  at: Date,
  lines: ReportableLine[],
  status: ReportableOrder['status'] = 'picked_up',
  money = { subtotalCents: 0, taxCents: 0, totalCents: 0 },
): ReportableOrder => ({
  status,
  placedAt: at,
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
      days: [],
      hours: [],
      topItems: [],
      attachRates: [],
      noShow: { sold: 0, noShow: 0, rate: null },
      inFlight: 0,
    });
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
