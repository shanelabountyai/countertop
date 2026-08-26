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
import type { ReportableOrder } from '@countertop/core';
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
