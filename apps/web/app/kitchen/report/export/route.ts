// The report as a CSV (P1-2, C-058).
//
// A route handler and not a server action, because the ask is a FILE. A server
// action can only hand a string back to a component, which then needs client
// JavaScript, a Blob and a synthesised anchor click to become a download — a
// pile of machinery to reimplement what `Content-Disposition` has done since
// 1998. This is a GET of the same window the screen resolved, so the link
// works with JavaScript off and survives being pasted into a mail.
//
// It is under /kitchen, so `middleware.ts` guards it with the same one check
// every other staff surface gets (C-037). That is the whole reason it lives
// here rather than under /api.
import { businessDayOf, salesReport } from '@countertop/core';
import { loadSettings } from '@countertop/db/menu';
import { loadReportOrders } from '@countertop/db/report';
import { resolveWindow } from '../window';

// Never prerendered, for the same reason the page is not: a report baked at
// build time is a report about the build.
export const dynamic = 'force-dynamic';

/**
 * Money as a plain decimal — `1234.56`, never `$1,234.56`.
 *
 * This is the one place the CSV deliberately does NOT match the screen.
 * `formatCents` renders for a person, and its thousands separator and currency
 * symbol both arrive in a spreadsheet as text: the column will not sum, which
 * is the only thing a bookkeeper opened the file to do.
 */
const decimal = (cents: number): string => (cents / 100).toFixed(2);

/** RFC 4180 quoting. Nothing in the columns below can contain a comma today —
 *  they are days and numbers — and that is exactly why this is here: the next
 *  column somebody adds will be a name. */
const cell = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export async function GET(request: Request): Promise<Response> {
  // Read once, here, and pass it down (CLAUDE.md time rules).
  const now = new Date();
  const { timezone } = await loadSettings();
  const { searchParams } = new URL(request.url);
  const view = resolveWindow(
    {
      days: searchParams.get('days') ?? undefined,
      from: searchParams.get('from') ?? undefined,
      to: searchParams.get('to') ?? undefined,
    },
    now,
    businessDayOf(now, timezone),
  );

  const report = salesReport(await loadReportOrders(view.bounds), timezone);

  // The By-day table, and only it. It is the rows a bookkeeper reconciles a
  // month against, and the three money columns are the ones that have to add
  // up — `net + tax = gross`, per row, the same reconciliation P0-1 asserts on
  // the screen. No totals row: a spreadsheet sums a column better than a file
  // that has to be re-parsed around a footer, and the screen already carries
  // the three tiles.
  const rows = [
    ['Business day', 'Orders', 'Items', 'Net sales', 'Tax', 'Gross'],
    ...report.days.map((day) => [
      day.day,
      String(day.orders),
      String(day.items),
      decimal(day.subtotalCents),
      decimal(day.taxCents),
      decimal(day.totalCents),
    ]),
  ];

  return new Response(rows.map((row) => row.map(cell).join(',')).join('\r\n'), {
    headers: {
      // `charset` stated rather than assumed: a spreadsheet that guesses
      // Latin-1 mangles the first item name with an accent in it.
      'content-type': 'text/csv; charset=utf-8',
      // The window in the filename (P1-2). A downloads folder ends up holding
      // several of these, and "report.csv (3)" tells nobody which month it is.
      'content-disposition': `attachment; filename="countertop-sales-${view.slug}.csv"`,
      // The numbers are a live read of a database that changes every minute.
      'cache-control': 'no-store',
    },
  });
}
