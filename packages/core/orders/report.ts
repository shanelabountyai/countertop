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
import { orderBalance, paymentTotals, type MoneyEvent } from './payment';
import {
  salesRoleOf,
  type CancelReason,
  type OrderStatus,
  type PaymentState,
} from './state-machine';

/** What a report needs off an order. A subset of the snapshot, so a database
 *  row satisfies it structurally and no mapping layer can drift. */
export type ReportableOrder = {
  status: OrderStatus;
  placedAt: Date;
  /** The service day placement stamped (C-142) — the day bucket. Not
   *  re-derived from `placedAt`: a 00:30 order inside Friday's overnight shift
   *  is Friday's #047 and must land on Friday's row beside its number. */
  businessDay: string;
  /** The human-callable number. Only ever read for the outstanding list — a
   *  chase list is useless without something to say at the counter. */
  seq: number;
  customerName: string;
  paymentState: PaymentState;
  /** The money events, so the split below asks `orderBalance` rather than the
   *  enum (C-064). The third of that function's three readers. */
  events: readonly MoneyEvent[];
  /** Why it was cancelled, on the orders that were (P0-6). Nullable because
   *  the column is: every other order in the window has nothing to say here,
   *  and an `abandoned` no-show is not a cancellation and never carries one. */
  cancelReason: CancelReason | null;
  /** What staff typed, when they typed anything. The whole reason `other` is
   *  worth showing at all — a count of `other` is the question, not the
   *  answer. Capped at 140 characters by the column. */
  cancelNote: string | null;
  subtotalCents: number;
  /** What a reward took off before tax (PRD 7 P1-1, C-118). Zero on every
   *  order that carried no checkout redemption, including every order placed
   *  before the column existed. */
  discountCents: number;
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
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

export type HourBucket = {
  /** 0-23, local to the restaurant. */
  hour: number;
  orders: number;
  items: number;
  /** The same three money columns the day bucket carries (P0-1). An hour that
   *  reported only its gross made the one screen a bookkeeper reads say two
   *  different things about tax depending on which table she looked at. */
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
};

/**
 * The window's four money numbers, which are three different facts (P0-1).
 *
 * `Σ totalCents` was the headline and it was labelled `Revenue`, so a month
 * end booked $41,203 of revenue when $3,141 of it was a sales-tax liability
 * owed to the state — the P&L overstated and the tax line understated by
 * exactly the same amount.
 *
 * `subtotalCents - discountCents + taxCents === totalCents` per order — a
 * database CHECK since C-117 — so it holds here by summation; the test asserts
 * it anyway, on every day row, every hour row and on this, because the day it
 * stops holding the cause will be a snapshot column somebody widened and not
 * this addition.
 *
 * THE DISCOUNT IS ITS OWN COLUMN AND THE SUBTOTAL STAYS GROSS (C-118). Netting
 * the reward out of `subtotalCents` would restore the old two-term identity
 * for free and cost the only thing this screen is for: the shop would no
 * longer be able to see what the punch card cost it in food, and the report's
 * `subtotalCents` would silently stop meaning what `Order.subtotalCents`
 * means. Two numbers that are two facts, as with net and tax above.
 *
 * Summed from the SNAPSHOT columns only. Nothing on this path recomputes tax
 * from `RestaurantSettings` — last month's sales are taxed at last month's
 * rate, which is the rate the order carries.
 */
export type SalesTotals = {
  /** What the food was sold for. The headline, and GROSS of rewards. */
  subtotalCents: number;
  /** What the loyalty program gave back, before tax (PRD 7 P1-1). Never
   *  netted into the subtotal — see above. */
  discountCents: number;
  /** Collected on the state's behalf, never the shop's money. Computed on
   *  `subtotal − discount`, which is why this is not `subtotal × rate`. */
  taxCents: number;
  /** What was charged. Shown, and never called revenue. */
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
   *  because the item sold. A rate of exactly 1 is the tell for a REQUIRED
   *  group: every unit took it because the menu gave no choice. The screen
   *  folds those away (P0-4); they stay in this list because a rate that is
   *  uninteresting to read is not a rate that is wrong. */
  rate: number;
};

/** One line of the chase list. Enough to walk to the till and ask. */
export type OutstandingOrder = {
  /** The order's `businessDay` — the day its `seq` belongs to, and the same
   *  value the day bucket used. */
  day: string;
  seq: number;
  customerName: string;
  /** What is OWED, which since C-064 is not always the order's total — a
   *  partly settled order belongs on the chase list for the remainder, not
   *  for the whole ticket. */
  owedCents: number;
};

/**
 * What of the counted revenue is actually in the drawer (D2).
 *
 * Scoped to the orders that count as SALES, deliberately: the defect is that
 * revenue counted food nobody paid for, so the split has to cover exactly the
 * set revenue covers. Money taken for an order nobody collected is a till
 * question, and the till is out of scope by decision (2026-09-01 #2).
 *
 * The three buckets sum to the window's revenue. `refunded` is its own bucket
 * and never nets into the other two — a refund that survives a pickup is food
 * the customer has and money the restaurant does not, so landing it in
 * "collected" would book revenue that went back out. It was structurally empty
 * when this was written, because the only refund the engine wrote accompanied
 * a `cancel` and a cancelled order is not a sale; P0-6's deliberate refund
 * (C-071) made it reachable and the seeded rush has exercised it since C-126.
 *
 * THAT FIRST SENTENCE WAS FALSE for the five items between C-071 and C-127,
 * and nothing noticed because nothing refunded a picked-up ticket until the
 * rush did. `outstandingCents` was computed from money COLLECTED rather than
 * money CAPTURED, so a refunded cent was counted twice — once here as sent
 * back, once on the chase list as still owed — and the split summed to more
 * than the revenue above it. C-127 fixed it in `orderBalance`, which is where
 * the arithmetic lives; this comment is the claim that fix restores.
 */
export type PaymentSplit = {
  collectedCents: number;
  outstandingCents: number;
  refundedCents: number;
  /** The slice of `refundedCents` flagged as sent in error (C-133) — already
   *  folded back into `outstandingCents` by `orderBalance`, so this is not a
   *  fourth bucket to sum, only the report's own record that some of what
   *  shows as "refunded" is also back on the chase list. Zero on every
   *  window nothing was reversed in. */
  refundReversedCents: number;
  /** Comps and counter rewards, net of their reversals (PRD 3 P1-3, C-153).
   *  The fourth bucket: booked as revenue, never owed, never collected. With
   *  it the split sums to revenue as
   *  `collected + outstanding + refunded + comped − refundReversed`. */
  compedCents: number;
  /** Chronological, like `days` — a chase list is worked oldest first. */
  outstanding: OutstandingOrder[];
  /** Unpaid pickups as a share of orders sold, so "six on a Friday" compares
   *  against a Tuesday. Null when nothing sold: 0% over no orders is a lie,
   *  the same reason `NoShowRate.rate` is nullable. */
  unpaidRate: number | null;
};

/**
 * One reason, and what it cost (P0-6).
 *
 * Counted over the orders the sales numbers deliberately DROP — a cancelled
 * order contributes to nothing else on this report, which is correct and is
 * also why "we cancelled eleven tickets on Friday" was a fact the product
 * held and could not say. The two grains a decision needs are both here: how
 * often, and how much walked out the door.
 *
 * `totalCents` is the gross the ticket would have been charged, summed. Not
 * revenue and never labelled as such (P0-1) — it is money that was never
 * taken, and the subtotal/tax split of a sale that did not happen is a
 * distinction with nothing behind it.
 */
export type CancellationReason = {
  reason: CancelReason;
  orders: number;
  totalCents: number;
  /** The free text, in the order the cancellations happened. Empty for the
   *  reasons nobody wrote on, which in practice is every one but `other` —
   *  collected off the NOTE rather than off the reason, so a note typed
   *  beside a preset reason is not silently dropped. */
  notes: string[];
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
  /** The window, in one object, so the headline tiles are not three `reduce`s
   *  in a page component — the arithmetic that decides what a month's revenue
   *  was belongs where it is tested. */
  totals: SalesTotals;
  days: DayBucket[];
  hours: HourBucket[];
  topItems: TopItem[];
  attachRates: AttachRate[];
  noShow: NoShowRate;
  payment: PaymentSplit;
  /** Counted, never booked: orders the kitchen has not finished with. Shown so
   *  a midday report explains its own missing money instead of quietly
   *  under-reporting. */
  inFlight: number;
  /**
   * Why the cancelled orders were cancelled (P0-6), ranked by how many.
   *
   * The only place on this page that reports on orders the rest of it drops.
   */
  cancellations: CancellationReason[];
  /**
   * "We remade six tickets Friday" (PRD 3 P0-3, C-066) — the number the shop
   * had no way to produce, because the only record was somebody telling the GM
   * at close.
   *
   * These orders are counted HERE and NOWHERE ELSE. That exclusion is the
   * load-bearing half of decision 7: a remake is a real order with a real
   * ticket, so left alone it would book a second sale at full price, add its
   * units to the top-item counts, and record an onions attach on the remake of
   * an order that said NO onions — which is the exact fiction this PRD's
   * opening scenario is about.
   */
  remakes: number;
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
  const cancelled = new Map<CancelReason, CancellationReason>();
  const outstanding: OutstandingOrder[] = [];
  let sold = 0;
  let noShow = 0;
  let inFlight = 0;
  let remakes = 0;
  let collectedCents = 0;
  let outstandingCents = 0;
  let refundedCents = 0;
  let refundReversedCents = 0;
  let compedCents = 0;

  for (const order of orders) {
    // BEFORE the status roles, deliberately. A remake is `sold` by every rule
    // this function otherwise applies — it is a real order that really got
    // picked up — and that is precisely why it has to be taken out first. The
    // food left the building once and was paid for once; counting the
    // replacement again is how Monday's numbers become fiction.
    if (order.events.some((event) => event.kind === 'remake')) {
      remakes += 1;
      continue;
    }
    const role = salesRoleOf(order.status);
    if (role === 'cancelled') {
      // `other` for a row with no stored reason, and that is not a
      // reclassification: the only writer of this column sets it on every
      // cancel, so a null is an order from before that path existed and
      // "no reason recorded" is exactly what `other` means. Dropping it
      // instead would make the table's counts disagree with the number of
      // orders cancelled, which is the one thing this table has to get right.
      const reason = order.cancelReason ?? 'other';
      const row = cancelled.get(reason) ?? { reason, orders: 0, totalCents: 0, notes: [] };
      row.orders += 1;
      row.totalCents += order.totalCents;
      if (order.cancelNote) row.notes.push(order.cancelNote);
      cancelled.set(reason, row);
      continue;
    }
    if (role === 'in_flight') {
      inFlight += 1;
      continue;
    }
    if (role === 'no_show') {
      noShow += 1;
      continue;
    }
    sold += 1;

    // The hour is the wall clock's; the day is the stamped service day (C-142),
    // so a 00:30 order in Friday's overnight shift is Friday's row, hour 0.
    const hour = Math.floor(restaurantClock(order.placedAt, timezone).minuteOfDay / 60);
    const units = order.lines.reduce((sum, line) => sum + line.quantity, 0);

    // Booked as revenue above; here is how much of it arrived. Asked of
    // `orderBalance` rather than of `paymentState` (C-064) — the enum could
    // only sort orders into three piles, and the moment anything is partial
    // the answer is an amount. `collected + outstanding` is still exactly the
    // revenue booked above, so the split explains the headline without
    // restating it.
    const balance = orderBalance(order);
    collectedCents += balance.collectedCents;
    if (balance.outstandingCents > 0) {
      outstandingCents += balance.outstandingCents;
      outstanding.push({
        day: order.businessDay,
        seq: order.seq,
        customerName: order.customerName,
        owedCents: balance.outstandingCents,
      });
    }
    // Its own bucket, and now a SUM OF REFUNDS rather than the totals of
    // orders wearing a `refunded` label. It still nets into neither of the
    // other two, and since C-127 that is all it does: a refunded order is
    // SETTLED, so it leaves the chase list entirely and the money it sent
    // back is reported here and only here. The restaurant has less in the
    // drawer than it booked; the customer owes nothing for it.
    const orderPayment = paymentTotals(order.events);
    refundedCents += orderPayment.refundedCents;
    refundReversedCents += orderPayment.refundReversedCents;
    compedCents += orderPayment.adjustedCents;

    const day = days.get(order.businessDay) ?? {
      day: order.businessDay,
      orders: 0,
      items: 0,
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: 0,
    };
    day.orders += 1;
    day.items += units;
    day.subtotalCents += order.subtotalCents;
    day.discountCents += order.discountCents;
    day.taxCents += order.taxCents;
    day.totalCents += order.totalCents;
    days.set(order.businessDay, day);

    const bucket = hours.get(hour) ?? {
      hour,
      orders: 0,
      items: 0,
      subtotalCents: 0,
      discountCents: 0,
      taxCents: 0,
      totalCents: 0,
    };
    bucket.orders += 1;
    bucket.items += units;
    bucket.subtotalCents += order.subtotalCents;
    bucket.discountCents += order.discountCents;
    bucket.taxCents += order.taxCents;
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

  const totals = [...days.values()].reduce(
    (sum, day) => ({
      subtotalCents: sum.subtotalCents + day.subtotalCents,
      discountCents: sum.discountCents + day.discountCents,
      taxCents: sum.taxCents + day.taxCents,
      totalCents: sum.totalCents + day.totalCents,
    }),
    { subtotalCents: 0, discountCents: 0, taxCents: 0, totalCents: 0 },
  );

  return {
    // Summed off the day buckets rather than off a fourth accumulator in the
    // loop, so the headline and the By-day table cannot disagree: if they ever
    // do, it is one bug and not two numbers.
    totals,
    // Chronological. Every other list is ranked; a calendar is not.
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    hours: [...hours.values()].sort((a, b) => a.hour - b.hour),
    topItems: [...items.values()].sort(
      (a, b) => b.quantity - a.quantity || a.itemName.localeCompare(b.itemName),
    ),
    // Ranked by ATTACHED VOLUME, not by rate (P0-4). Sorting by rate puts the
    // required choices first — every one of them is 100% by construction, and
    // a required group is not a decision anybody can act on. The row worth
    // reading is the optional one lots of people took, and under a rate sort
    // it lands below every group the menu forces. Ties break on the units
    // first so the shape survives: same volume, then item, then option.
    attachRates: attachRates.sort(
      (a, b) =>
        b.withOption - a.withOption ||
        a.itemName.localeCompare(b.itemName) ||
        a.optionName.localeCompare(b.optionName),
    ),
    noShow: { sold, noShow, rate: sold + noShow === 0 ? null : noShow / (sold + noShow) },
    payment: {
      collectedCents,
      outstandingCents,
      refundedCents,
      refundReversedCents,
      compedCents,
      outstanding,
      unpaidRate: sold === 0 ? null : outstanding.length / sold,
    },
    inFlight,
    // Ranked by count, because "which of these keeps happening" is the
    // question — the value column says what it cost, and the two do not
    // always agree about which row matters. Ties break on the reason so the
    // shape is stable rather than insertion-ordered.
    cancellations: [...cancelled.values()].sort(
      (a, b) => b.orders - a.orders || a.reason.localeCompare(b.reason),
    ),
    remakes,
  };
}
