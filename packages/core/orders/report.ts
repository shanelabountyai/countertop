// The sales report (P1-1).
//
// PURE, and that is what makes it testable at all: every instant arrives as a
// parameter, the timezone arrives as a parameter, and nothing here reads a
// clock. The bucketing is the whole risk — a report that buckets in UTC tells
// a Los Angeles restaurant that its 5pm dinner rush happens at midnight, and
// every test still passes on a laptop set to UTC. CI runs the suite under
// TZ=Pacific/Kiritimati for exactly this function's sake.
//
// SNAPSHOT-ONLY. Every field read below is a COPY carried on the order —
// `itemName`, `optionName`, `lineTotalCents` — never a menu row. A report that
// joined MenuItem for a name would restate last month's sales under this
// month's menu, and a deleted item would vanish from its own history.
import { restaurantClock } from './business-day';
import { salesRoleOf, type OrderStatus } from './state-machine';

/** What a report needs off an order. A subset of the snapshot, so a database
 *  row satisfies it structurally and no mapping layer can drift. */
export type ReportableOrder = {
  status: OrderStatus;
  placedAt: Date;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lines: readonly ReportableLine[];
};

export type ReportableLine = {
  itemName: string;
  quantity: number;
  lineTotalCents: number;
  options: readonly ReportableOption[];
};

export type ReportableOption = {
  groupName: string;
  optionName: string;
  /** `none` is the NEGATION — "NO onions". It must never count as an attach:
   *  "42% of burritos add onions", read off a column of people REMOVING them,
   *  is the phone-transcription bug this product exists to kill, in report
   *  form. */
  intensity: 'none' | 'light' | 'regular' | 'extra' | null;
};

export type DayBucket = {
  /** "YYYY-MM-DD" in the restaurant's calendar. */
  day: string;
  orders: number;
  items: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export type HourBucket = {
  /** 0-23, local to the restaurant. */
  hour: number;
  orders: number;
  items: number;
  totalCents: number;
};

export type TopItem = {
  itemName: string;
  quantity: number;
  revenueCents: number;
};

export type AttachRate = {
  itemName: string;
  groupName: string;
  optionName: string;
  /** Units of the item that took this option, negations NOT counted. */
  withOption: number;
  /** Every unit of the item sold. */
  ofTotal: number;
  /** `withOption / ofTotal`, 0-1. `ofTotal` is never 0 — a rate exists only
   *  because the item sold. */
  rate: number;
};

export type NoShowRate = {
  sold: number;
  noShow: number;
  /** Of the orders the kitchen FINISHED, the share nobody collected. Null when
   *  none finished: a rate over zero orders is not 0%, it is unknown, and a
   *  screen printing "0% no-shows" on an empty day is lying. */
  rate: number | null;
};

export type SalesReport = {
  days: DayBucket[];
  hours: HourBucket[];
  topItems: TopItem[];
  attachRates: AttachRate[];
  noShow: NoShowRate;
  /** Counted, never booked: orders the kitchen has not finished with. Shown so
   *  a midday report explains its own missing money instead of quietly
   *  under-reporting. */
  inFlight: number;
};

/** The attach map's key. `JSON.stringify` of the tuple, so no delimiter has to
 *  be a character a manager cannot type into a group or option name. */
const attachKey = (itemName: string, groupName: string, optionName: string): string =>
  JSON.stringify([itemName, groupName, optionName]);

/**
 * Sales, bucketed in the restaurant's own calendar.
 *
 * `orders` is every order in the window whatever its status; this function
 * decides what each one counts toward by asking the ONE status module. A
 * cancelled order contributes to nothing, a no-show only to the no-show rate,
 * and an order still on the pass only to `inFlight`.
 */
export function salesReport(orders: readonly ReportableOrder[], timezone: string): SalesReport {
  const days = new Map<string, DayBucket>();
  const hours = new Map<number, HourBucket>();
  const items = new Map<string, TopItem>();
  const attached = new Map<string, number>();
  let sold = 0;
  let noShow = 0;
  let inFlight = 0;

  for (const order of orders) {
    const role = salesRoleOf(order.status);
    if (role === 'cancelled') continue;
    if (role === 'in_flight') {
      inFlight += 1;
      continue;
    }
    if (role === 'no_show') {
      noShow += 1;
      continue;
    }
    sold += 1;

    // ONE clock reading per order, answering both buckets. Reading the day and
    // the hour separately would be two Intl calls a DST boundary could put on
    // opposite sides of a change.
    const clock = restaurantClock(order.placedAt, timezone);
    const hour = Math.floor(clock.minuteOfDay / 60);
    const units = order.lines.reduce((sum, line) => sum + line.quantity, 0);

    const day = days.get(clock.day) ?? {
      day: clock.day,
      orders: 0,
      items: 0,
      subtotalCents: 0,
      taxCents: 0,
      totalCents: 0,
    };
    day.orders += 1;
    day.items += units;
    day.subtotalCents += order.subtotalCents;
    day.taxCents += order.taxCents;
    day.totalCents += order.totalCents;
    days.set(clock.day, day);

    const bucket = hours.get(hour) ?? { hour, orders: 0, items: 0, totalCents: 0 };
    bucket.orders += 1;
    bucket.items += units;
    bucket.totalCents += order.totalCents;
    hours.set(hour, bucket);

    for (const line of order.lines) {
      const item = items.get(line.itemName) ?? {
        itemName: line.itemName,
        quantity: 0,
        revenueCents: 0,
      };
      item.quantity += line.quantity;
      item.revenueCents += line.lineTotalCents;
      items.set(line.itemName, item);

      for (const option of line.options) {
        // The negation, skipped. "NO onions" is a choice ABOUT onions, never
        // an order OF them.
        if (option.intensity === 'none') continue;
        const key = attachKey(line.itemName, option.groupName, option.optionName);
        attached.set(key, (attached.get(key) ?? 0) + line.quantity);
      }
    }
  }

  const attachRates = [...attached.entries()].map(([key, withOption]): AttachRate => {
    const [itemName, groupName, optionName] = JSON.parse(key) as [string, string, string];
    // The denominator is every unit of the item sold — including the units
    // that did NOT take the option, which is the entire point of a rate.
    const ofTotal = items.get(itemName)?.quantity ?? 0;
    return { itemName, groupName, optionName, withOption, ofTotal, rate: withOption / ofTotal };
  });

  return {
    // Chronological. Every other list is ranked; a calendar is not.
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hours: [...hours.values()].sort((a, b) => a.hour - b.hour),
    topItems: [...items.values()].sort(
      (a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName),
    ),
    attachRates: attachRates.sort(
      (a, b) =>
        b.rate - a.rate ||
        a.itemName.localeCompare(b.itemName) ||
        a.optionName.localeCompare(b.optionName),
    ),
    noShow: { sold, noShow, rate: sold + noShow === 0 ? null : noShow / (sold + noShow) },
    inFlight,
  };
}
