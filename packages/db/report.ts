// The report read (P1-1).
//
// A `select`, not an `include`, and every column named in it is a SNAPSHOT
// column. That is deliberate and it is the point: you can read this query and
// see that no menu table appears in it, so a rename, a reprice or a deleted
// item cannot restate last month's sales. The `menuItemId` correlation columns
// are not selected either — the report has no use for them, and not selecting
// them is how it stays true that they are never read for display.
//
// Phones and notes are not selected. A sales report has no business holding
// them. `customerName` and `seq` ARE selected, and only since C-051: the
// outstanding list is a chase list, and "$14.30 is owed" with nobody to ask
// is not one. They are snapshot columns like the rest of this select.
import { elapsedMinutes, type QuoteSample, type ReportableOrder, type StatusEvent } from '@countertop/core';
import { Prisma, prisma } from './index';

/**
 * What bounds a report (P0-3).
 *
 * Two shapes because there are genuinely two questions. The rolling windows
 * ask "the last 30 days", which is 30 x 24 hours from an instant and is
 * deliberately generous — the engine does the exact day bucketing afterwards,
 * and the oldest local day comes out partial. `Today` asks "this business
 * day", which is not a 24-hour range at all: it is the restaurant's own
 * calendar day, the same one the order numbers reset on.
 *
 * A `Date` here still means the instant lower bound, so every existing caller
 * reads the same as it did.
 */
export type ReportWindow = Date | { businessDay: string };

/**
 * The window as a `where` fragment, in ONE place, so the three loaders below
 * cannot end up bounding three different sets of orders.
 *
 * The business-day arm compares the `businessDay` COLUMN as a string — no
 * parsing, no local -> instant conversion, the same trick `historyWhere` uses.
 * The column was written by `restaurantClock` at placement, so "today" on this
 * screen is the same day the order number came from, by construction rather
 * than by two computations agreeing.
 */
const windowWhere = (window: ReportWindow): Prisma.OrderWhereInput =>
  window instanceof Date
    ? { placedAt: { gte: window } }
    : { businessDay: window.businessDay };

/**
 * Every order in the window, in the shape the engine buckets.
 *
 * The rolling windows are an INSTANT range, not a local-day range,
 * deliberately: turning "the last 30 days in Los Angeles" into a pair of
 * instants is the local -> instant direction that `business-day.ts` refuses to
 * do, because a DST boundary makes it ambiguous. So the query is generous and
 * the ENGINE is exact — it buckets each order by the restaurant's calendar and
 * the days fall out of that.
 *
 * The cost is that the oldest day in such a window can be partial. The screen
 * says so rather than pretending otherwise.
 *
 * `Today` (P0-3) has no such cost and needs no such conversion: the business
 * day is already a string on every order, so the day is MATCHED rather than
 * bounded, and the window is exactly one restaurant day whatever DST did.
 */
export function loadReportOrders(window: ReportWindow): Promise<ReportableOrder[]> {
  return prisma.order.findMany({
    where: windowWhere(window),
    orderBy: { placedAt: 'asc' },
    select: {
      status: true,
      placedAt: true,
      seq: true,
      customerName: true,
      paymentState: true,
      // The money events (C-064): the report's outstanding list asks
      // `orderBalance` what is owed, like the queue card and the receipt do.
      // Two scalars per event on an already-heavy scan — the alternative was
      // leaving one of that function's three readers on the enum, which is the
      // drift this codebase keeps having to come back and undo.
      events: { select: { kind: true, amountCents: true } },
      subtotalCents: true,
      taxCents: true,
      totalCents: true,
      lines: {
        orderBy: { lineNumber: 'asc' },
        select: {
          itemName: true,
          quantity: true,
          lineTotalCents: true,
          options: {
            orderBy: { sortOrder: 'asc' },
            select: { groupName: true, optionName: true, intensity: true },
          },
        },
      },
    },
  });
}

/**
 * One timeline per order in the window, for the time-in-state tally (C-020).
 *
 * The EVENTS, not `statusChangedAt`. That column holds a single instant — the
 * current status's — so it can answer "how long has this been ready?" and
 * nothing else. An order that was advanced by mistake and sent back visited a
 * status twice, and only the append-only log still knows that.
 *
 * `toStatus` and `at` are the only columns selected: a tally has no business
 * reading the actor, the reason or the detail payload.
 */
export async function loadStatusTimelines(window: ReportWindow): Promise<StatusEvent[][]> {
  const orders = await prisma.order.findMany({
    where: windowWhere(window),
    orderBy: { placedAt: 'asc' },
    select: {
      events: { orderBy: { at: 'asc' }, select: { at: true, toStatus: true } },
    },
  });
  return orders.map((order) => order.events);
}

/**
 * What each order was promised against what it got (P1-4, C-042).
 *
 * Two `where` clauses do the whole filtering, and both are honesty rather than
 * optimisation: an order placed before C-042 has no quote to grade, and an
 * order that never reached `ready` has no outcome to grade it against — a
 * cancelled ticket and one still on the grill are not evidence that the
 * estimate is wrong.
 *
 * The LAST `ready` event, not the first. An order advanced by mistake and sent
 * back (the C-004 logged revert) was not ready the first time somebody said
 * so; the correction is the truth, and the append-only log is the only place
 * that still knows both happened.
 */
export async function loadQuoteSamples(window: ReportWindow): Promise<QuoteSample[]> {
  const orders = await prisma.order.findMany({
    where: {
      ...windowWhere(window),
      quotedLowMinutes: { not: null },
      events: { some: { toStatus: 'ready' } },
    },
    orderBy: { placedAt: 'asc' },
    select: {
      placedAt: true,
      quotedLowMinutes: true,
      quotedHighMinutes: true,
      quotedOpenWeight: true,
      events: { where: { toStatus: 'ready' }, orderBy: { at: 'desc' }, take: 1, select: { at: true } },
    },
  });

  return orders.flatMap((order) => {
    const readyAt = order.events[0]?.at;
    // The three columns move together under a CHECK, so one non-null is all
    // three — but the type is nullable and narrowing it here costs a line.
    if (
      readyAt === undefined ||
      order.quotedLowMinutes === null ||
      order.quotedHighMinutes === null ||
      order.quotedOpenWeight === null
    ) {
      return [];
    }
    return [
      {
        quotedLowMinutes: order.quotedLowMinutes,
        quotedHighMinutes: order.quotedHighMinutes,
        quotedOpenWeight: order.quotedOpenWeight,
        // The same floored-and-never-negative minutes the queue ages tickets
        // by, so "18 min" on the kitchen card and "18 min" here are one rule.
        actualMinutes: elapsedMinutes(order.placedAt, readyAt),
      },
    ];
  });
}
