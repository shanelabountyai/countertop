// The report read (P1-1).
//
// A `select`, not an `include`, and every column named in it is a SNAPSHOT
// column. That is deliberate and it is the point: you can read this query and
// see that no menu table appears in it, so a rename, a reprice or a deleted
// item cannot restate last month's sales. The `menuItemId` correlation columns
// are not selected either — the report has no use for them, and not selecting
// them is how it stays true that they are never read for display.
//
// Customer names, phones and notes are not selected. A sales report has no
// business holding them.
import type { ReportableOrder, StatusEvent } from '@countertop/core';
import { prisma } from './index';

/**
 * Every order placed at or after `since`, in the shape the engine buckets.
 *
 * An INSTANT range, not a local-day range, deliberately: turning "the last 30
 * days in Los Angeles" into a pair of instants is the local -> instant
 * direction that `business-day.ts` refuses to do, because a DST boundary makes
 * it ambiguous. So the query is generous and the ENGINE is exact — it buckets
 * each order by the restaurant's calendar and the days fall out of that.
 *
 * The cost is that the oldest day in a window can be partial. The screen says
 * so rather than pretending otherwise.
 */
export function loadReportOrders(since: Date): Promise<ReportableOrder[]> {
  return prisma.order.findMany({
    where: { placedAt: { gte: since } },
    orderBy: { placedAt: 'asc' },
    select: {
      status: true,
      placedAt: true,
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
export async function loadStatusTimelines(since: Date): Promise<StatusEvent[][]> {
  const orders = await prisma.order.findMany({
    where: { placedAt: { gte: since } },
    orderBy: { placedAt: 'asc' },
    select: {
      events: { orderBy: { at: 'asc' }, select: { at: true, toStatus: true } },
    },
  });
  return orders.map((order) => order.events);
}
