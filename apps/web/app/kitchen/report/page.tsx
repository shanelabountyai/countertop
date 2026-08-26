// The sales report (P1-1, C-016).
//
// Every bucket on this page was computed by `salesReport` in packages/core,
// which takes the timezone as a parameter and reads no clock. This file's only
// time responsibility is to read `now` ONCE, here, and pass it down.
//
// Nothing here touches a menu table. Every name shown is the name the order
// was placed under, carried on the order itself — so last month's sales are
// reported under last month's menu, and an item deleted this morning still
// appears in the history it earned.
import Link from 'next/link';
import { instantDaysBefore, salesReport } from '@countertop/core';
import { loadSettings } from '@countertop/db/menu';
import { loadReportOrders } from '@countertop/db/report';
import { formatCents } from '@/lib/money';

export const metadata = { title: 'Sales — Firebird Kitchen' };

// Never prerendered: a report baked at build time is a report about the build.
export const dynamic = 'force-dynamic';

const WINDOWS = [1, 7, 30, 90] as const;
const DEFAULT_DAYS = 7;

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  // Read once, here. Everything below is a parameter (CLAUDE.md time rules).
  const now = new Date();
  const requested = Number((await searchParams).days);
  const days = WINDOWS.includes(requested as (typeof WINDOWS)[number]) ? requested : DEFAULT_DAYS;

  const { timezone } = await loadSettings();
  const since = instantDaysBefore(now, days);
  const report = salesReport(await loadReportOrders(since), timezone);

  const busiest = Math.max(1, ...report.hours.map((hour) => hour.orders));
  const revenueCents = report.days.reduce((sum, day) => sum + day.totalCents, 0);

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <Link href="/kitchen" className="text-lg underline underline-offset-4">
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Sales</h1>
      <p className="mt-1 text-lg text-neutral-700">
        Everything below is bucketed in {timezone} — the restaurant&rsquo;s own calendar, not the
        server&rsquo;s. Only orders a customer picked up are counted as sales.
      </p>

      <nav aria-label="Report window" className="mt-4 flex flex-wrap gap-2">
        {WINDOWS.map((window) => (
          <Link
            key={window}
            href={`/kitchen/report?days=${window}`}
            aria-current={window === days ? 'page' : undefined}
            className={`min-h-12 rounded-lg border-2 px-5 py-3 text-lg font-bold ${
              window === days
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : 'border-neutral-400'
            }`}
          >
            {window === 1 ? 'Last 24 hours' : `Last ${window} days`}
          </Link>
        ))}
      </nav>

      {/* The window is an INSTANT range, so its oldest local day is usually a
          partial one. Saying so costs a line and stops someone reading a half
          day as a bad day. */}
      <p className="mt-2 text-base text-neutral-600">
        Counted from exactly {days === 1 ? '24 hours' : `${days} days`} ago, so the earliest day
        shown may be partial.
      </p>

      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Orders sold" value={String(report.noShow.sold)} />
        <Stat label="Revenue" value={formatCents(revenueCents)} />
        <Stat
          label="No-show rate"
          value={report.noShow.rate === null ? '—' : percent(report.noShow.rate)}
          note={
            report.noShow.rate === null
              ? 'No orders finished yet'
              : `${report.noShow.noShow} of ${report.noShow.sold + report.noShow.noShow} finished`
          }
        />
        <Stat
          label="Still open"
          value={String(report.inFlight)}
          note="Not counted as sales yet"
        />
      </section>

      {report.days.length === 0 ? (
        <p className="mt-10 rounded-lg border-2 border-neutral-300 p-6 text-lg">
          No orders were picked up in this window. {report.inFlight > 0 && 'Some are still open.'}
        </p>
      ) : (
        <>
          <Section title="By day">
            <Table
              headers={['Day', 'Orders', 'Items', 'Subtotal', 'Tax', 'Total']}
              label="Sales by day"
              rows={report.days.map((day) => [
                day.day,
                String(day.orders),
                String(day.items),
                formatCents(day.subtotalCents),
                formatCents(day.taxCents),
                formatCents(day.totalCents),
              ])}
            />
          </Section>

          <Section title="By hour">
            <p className="text-lg text-neutral-700">
              Local hours. Only hours with a sale appear — an hour with no orders has no bar
              rather than a bar of zero.
            </p>
            <ul className="mt-3 flex flex-col gap-2">
              {report.hours.map((hour) => (
                <li key={hour.hour} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 text-lg tabular-nums">
                    {String(hour.hour).padStart(2, '0')}:00
                  </span>
                  {/* A div with a width. A chart library for one bar chart of
                      at most 24 rows is a dependency to keep patched forever. */}
                  <span
                    className="h-8 shrink-0 rounded bg-neutral-900"
                    style={{ width: `${(hour.orders / busiest) * 60}%` }}
                  />
                  <span className="text-lg tabular-nums">
                    {hour.orders} {hour.orders === 1 ? 'order' : 'orders'} ·{' '}
                    {formatCents(hour.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Top sellers">
            <Table
              headers={['Item', 'Sold', 'Revenue']}
              label="Top sellers"
              rows={report.topItems.map((item) => [
                item.itemName,
                String(item.quantity),
                formatCents(item.revenueCents),
              ])}
            />
          </Section>

          <Section title="Modifier attach rates">
            <p className="text-lg text-neutral-700">
              Of every unit of an item sold, the share that took each option. A removal
              (&ldquo;NO onions&rdquo;) is a choice about an option, not an order of one, and is
              never counted here.
            </p>
            <Table
              headers={['Item', 'Option', 'Attached', 'Rate']}
              label="Modifier attach rates"
              rows={report.attachRates.map((rate) => [
                rate.itemName,
                `${rate.groupName}: ${rate.optionName}`,
                `${rate.withOption} of ${rate.ofTotal}`,
                percent(rate.rate),
              ])}
            />
          </Section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-lg border-2 border-neutral-300 p-3">
      <p className="text-base text-neutral-700">{label}</p>
      <p className="text-3xl font-bold tabular-nums">{value}</p>
      {note && <p className="mt-1 text-base text-neutral-600">{note}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-2xl font-semibold">{title}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A real table with real headers — this is tabular data, and a grid of divs
 *  would read to a screen reader as a wall of unrelated numbers. It scrolls
 *  inside itself so the page never scrolls sideways on a phone.
 *
 *  The scroll container is focusable and labelled, because a region that
 *  scrolls only by dragging is a region a keyboard cannot reach — which is
 *  exactly what the axe check in the e2e suite caught. */
function Table({ headers, rows, label }: { headers: string[]; rows: string[][]; label: string }) {
  return (
    <div className="overflow-x-auto" tabIndex={0} role="region" aria-label={label}>
      <table className="w-full min-w-md border-collapse text-lg">
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={header}
                scope="col"
                className={`border-b-2 border-neutral-400 p-2 ${
                  index === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join('|')}>
              {row.map((cell, index) => (
                <td
                  key={`${row.join('|')}-${index}`}
                  className={`border-b border-neutral-200 p-2 ${
                    index === 0 ? 'text-left' : 'text-right tabular-nums'
                  }`}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
