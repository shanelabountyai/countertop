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
import {
  businessDayOf,
  estimateAccuracy,
  formatOrderNumber,
  instantDaysBefore,
  isTerminal,
  salesReport,
  serviceTimes,
  timeInStateReport,
  type AccuracyGroup,
  type AttachRate,
  type QuoteAdjustment,
} from '@countertop/core';
import { loadSettings } from '@countertop/db/menu';
import {
  loadQuoteSamples,
  loadReportOrders,
  loadStatusTimelines,
  type ReportWindow,
} from '@countertop/db/report';
import { formatCents } from '@/lib/money';
import { Section, Stat } from '@/lib/panels';
import { CANCEL_REASON_LABEL, STATUS_LABEL } from '@/lib/status-labels';

export const metadata = { title: 'Sales — Firebird Kitchen' };

// Never prerendered: a report baked at build time is a report about the build.
export const dynamic = 'force-dynamic';

// `today` is not "1 day" and is deliberately not spelled as one: the rolling
// windows are 24-hour multiples from `now`, and this one is the restaurant's
// own business day (P0-3). It leads because it is the question the screen is
// opened to answer during a service.
const WINDOWS = ['today', 1, 7, 30, 90] as const;
type ReportChoice = (typeof WINDOWS)[number];
const DEFAULT_WINDOW: ReportChoice = 'today';

const windowLabel = (choice: ReportChoice): string =>
  choice === 'today' ? 'Today' : choice === 1 ? 'Last 24 hours' : `Last ${choice} days`;

const percent = (fraction: number) => `${(fraction * 100).toFixed(1)}%`;

/** One row shape, two tables — the visible rates and the folded-away 100% ones
 *  are the same fact and must read identically (P0-4). */
const attachRows = (rates: AttachRate[]): string[][] =>
  rates.map((rate) => [
    rate.itemName,
    `${rate.groupName}: ${rate.optionName}`,
    `${rate.withOption} of ${rate.ofTotal}`,
    percent(rate.rate),
  ]);

/** Minutes up to an hour and a half, then hours and minutes. A 90-day window's
 *  total in `preparing` is five figures of minutes, which is a number nobody
 *  reads. */
function formatDuration(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 90) return `${minutes.toFixed(1)} min`;
  return `${Math.floor(minutes / 60)} h ${Math.round(minutes % 60)} min`;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  // Read once, here. Everything below is a parameter (CLAUDE.md time rules).
  const now = new Date();
  const requested = (await searchParams).days;
  const choice = WINDOWS.find((option) => String(option) === requested) ?? DEFAULT_WINDOW;

  const { timezone } = await loadSettings();
  // The business day the order numbers reset on, matched as a string against
  // the column placement wrote — never a pair of instants around local
  // midnight (P0-3). Everything else stays the generous instant bound.
  const bounds: ReportWindow =
    choice === 'today'
      ? { businessDay: businessDayOf(now, timezone) }
      : instantDaysBefore(now, choice);
  const report = salesReport(await loadReportOrders(bounds), timezone);
  // Same window, same `now`, and derived from the append-only event log rather
  // than from `statusChangedAt` — which holds one instant and cannot know that
  // a reverted ticket was on the grill twice.
  const timelines = await loadStatusTimelines(bounds);
  const timeInState = timeInStateReport(
    timelines.map((ticket) => ticket.events),
    now,
  );
  // Same timelines, a different question: not "how long is a state" but "how
  // long did a TICKET take", which is the one a customer felt. The threshold
  // is the queue card's own, unstated here so the report and the red card
  // cannot drift (P0-5).
  const service = serviceTimes(timelines);
  // P1-4. Graded against the quote each order CARRIES, not against a quote
  // recomputed now — which is why this needs a snapshot column and not a
  // cleverer query (C-042).
  const accuracy = estimateAccuracy(await loadQuoteSamples(bounds));

  // Only the states an order can still be sitting in. The terminal three
  // always total zero by construction, and a row of "0.0 min" reads like a
  // measurement rather than like arithmetic that cannot come out any other way.
  const timeInStateRows = timeInState.filter((row) => row.orders > 0 && !isTerminal(row.status));

  const busiest = Math.max(1, ...report.hours.map((hour) => hour.orders));

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <Link href="/kitchen" className="inline-flex min-h-12 w-fit items-center text-lg underline underline-offset-4">
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Sales</h1>
      <p className="mt-1 text-lg text-neutral-700">
        Everything below is bucketed in {timezone} — the restaurant&rsquo;s own calendar, not the
        server&rsquo;s. Only orders a customer picked up are counted as sales. Every tax figure is
        the one the order was charged, read off the order itself — never today&rsquo;s rate applied
        to last month&rsquo;s sales.
      </p>

      <nav aria-label="Report window" className="mt-4 flex flex-wrap gap-2">
        {WINDOWS.map((option) => (
          <Link
            key={option}
            href={`/kitchen/report?days=${option}`}
            aria-current={option === choice ? 'page' : undefined}
            className={`min-h-12 rounded-lg border-2 px-5 py-3 text-lg font-bold ${
              option === choice
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : 'border-neutral-400'
            }`}
          >
            {windowLabel(option)}
          </Link>
        ))}
      </nav>

      {/* A rolling window is an INSTANT range, so its oldest local day is
          usually a partial one. Saying so costs a line and stops someone
          reading a half day as a bad day — and `Today` must NOT say it, because
          a business day is whole by definition and a disclaimer that is always
          on is a disclaimer nobody reads (P0-3). */}
      <p className="mt-2 text-base text-neutral-600">
        {choice === 'today'
          ? `The restaurant's business day in ${timezone} — the same day the order numbers reset on, not the last 24 hours.`
          : `Counted from exactly ${choice === 1 ? '24 hours' : `${choice} days`} ago, so the earliest day shown may be partial.`}
      </p>

      {/* Three money numbers, because they are three different facts (P0-1).
          One tile labelled "Revenue" holding the gross is how a month end
          books the state's sales tax as the shop's earnings — the P&L
          overstated and the tax line understated by the same amount. Net sales
          leads because it is the only one of the three that is the shop's. */}
      <section className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {/* Test ids on these three and on no other tile: they are the ones an
            assertion has to ADD UP, and matching them by their label is how a
            spec ends up reading the "Gross counts every order..." sentence
            below and adding the collected figure to itself. */}
        <Stat
          label="Net sales"
          value={formatCents(report.totals.subtotalCents)}
          note="What the shop earned, before tax"
          testId="report-net-sales"
        />
        <Stat
          label="Tax collected"
          value={formatCents(report.totals.taxCents)}
          note="Owed to the state, never earnings"
          testId="report-tax"
        />
        <Stat
          label="Gross"
          value={formatCents(report.totals.totalCents)}
          note="Charged, not collected"
          testId="report-gross"
        />
        <Stat label="Orders sold" value={String(report.noShow.sold)} />
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

      {/* "We remade six tickets Friday" (PRD 3 P0-3, C-066) — a number the
          shop could not produce, because the only record was somebody telling
          the GM at close. Its own row rather than a fifth stat tile: it is not
          a sales figure, and the note has to say why it is missing from the
          ones above. */}
      {report.remakes > 0 && (
        <p className="mt-4 rounded-lg border-2 border-neutral-400 p-4 text-lg">
          <strong data-testid="report-remakes">{report.remakes}</strong>{' '}
          {report.remakes === 1 ? 'order was' : 'orders were'} remade. Deliberately not counted
          above — the food left the building once and was paid for once, so counting the
          replacement again would overstate both sales and the items on it.
        </p>
      )}

      {report.payment.outstanding.length > 0 && (
        <p className="mt-4 rounded-lg border-2 border-amber-500 bg-amber-50 p-4 text-lg">
          <strong>{formatCents(report.payment.outstandingCents)}</strong> of that gross was never
          collected — {report.payment.outstanding.length}{' '}
          {report.payment.outstanding.length === 1 ? 'order' : 'orders'} handed over unpaid. They
          are listed below.
        </p>
      )}

      {report.days.length === 0 ? (
        <p className="mt-10 rounded-lg border-2 border-neutral-300 p-6 text-lg">
          No orders were picked up in this window. {report.inFlight > 0 && 'Some are still open.'}
        </p>
      ) : (
        <>
          {/* First, because it is the one number on this page that can be
              wrong in the till's favour and nowhere else on the screen
              reconciles it (D2). */}
          <Section title="Collected versus charged">
            <p className="text-lg text-neutral-700">
              Gross counts every order a customer took, paid or not — that is what it has always
              meant, and changing it would restate every past report. This is how much of it
              actually came in.
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Stat label="Collected" value={formatCents(report.payment.collectedCents)} />
              <Stat
                label="Outstanding"
                value={formatCents(report.payment.outstandingCents)}
                note={
                  report.payment.unpaidRate === null
                    ? undefined
                    : `${percent(report.payment.unpaidRate)} of orders sold`
                }
              />
              {/* Shown only when there is one. A refund never nets into either
                  of the other two, so a row of $0.00 would be arithmetic
                  rather than a measurement. */}
              {report.payment.refundedCents > 0 && (
                <Stat
                  label="Refunded"
                  value={formatCents(report.payment.refundedCents)}
                  note="Counted in neither of the other two"
                />
              )}
            </div>
            {report.payment.outstanding.length === 0 ? (
              <p className="mt-3 text-lg">Everything sold in this window was paid for.</p>
            ) : (
              <div className="mt-3">
                <Table
                  headers={['Day', 'Order', 'Name', 'Owed']}
                  label="Orders handed over unpaid"
                  rows={report.payment.outstanding.map((order) => [
                    order.day,
                    formatOrderNumber(order.seq),
                    order.customerName,
                    formatCents(order.owedCents),
                  ])}
                />
              </div>
            )}
          </Section>

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
                  {/* The same three money columns as By day (P0-1). Written
                      out rather than tabulated: the bar is what this section
                      is for, and a second table of the same rows would be two
                      renderings of one fact. */}
                  <span className="text-lg tabular-nums">
                    {hour.orders} {hour.orders === 1 ? 'order' : 'orders'} ·{' '}
                    {formatCents(hour.subtotalCents)} net + {formatCents(hour.taxCents)} tax ={' '}
                    {formatCents(hour.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Top sellers">
            <Table
              headers={['Item', 'Sold', 'Net sales']}
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
              Of every unit of an item sold, the share that took each option, most-ordered first. A
              removal (&ldquo;NO onions&rdquo;) is a choice about an option, not an order of one,
              and is never counted here.
            </p>
            <Table
              headers={['Item', 'Option', 'Attached', 'Rate']}
              label="Modifier attach rates"
              rows={attachRows(report.attachRates.filter((rate) => rate.rate < 1))}
            />
            {/* The 100% rows, folded away rather than dropped (P0-4). Every one
                of them is a required group — the menu gave no choice, so the
                number is a restatement of the menu and not a fact about a
                customer. They are still here because "guacamole is at 100%"
                and "guacamole is required" are answered by the same row, and
                the second reading is the one that catches a mis-built group. */}
            {report.attachRates.some((rate) => rate.rate >= 1) && (
              <details className="mt-4">
                <summary className="cursor-pointer p-2 text-lg text-neutral-700">
                  Always taken (required choices) — show
                </summary>
                <div className="mt-2">
                  <Table
                    headers={['Item', 'Option', 'Attached', 'Rate']}
                    label="Always taken (required choices)"
                    rows={attachRows(report.attachRates.filter((rate) => rate.rate >= 1))}
                  />
                </div>
              </details>
            )}
          </Section>
        </>
      )}

      {/* P0-6. Outside the sales branch for a blunter reason than the tally
          below it: a window where everything was cancelled has no sales at
          all, and that is precisely the window somebody needs this table on.
          Rendered only when there were cancellations — a table of zeroes is
          not a measurement. */}
      {report.cancellations.length > 0 && (
        <Section title="Cancellations">
          <p className="text-lg text-neutral-700">
            These orders count toward nothing else on this page — no sales, no items, no attach
            rate — which is correct, and is why they need their own table. Value is what the
            ticket would have been charged, tax included; none of it was taken.
          </p>
          <div className="mt-3">
            <Table
              headers={['Reason', 'Orders', 'Ticket value']}
              label="Cancellations by reason"
              rows={report.cancellations.map((row) => [
                CANCEL_REASON_LABEL[row.reason],
                String(row.orders),
                formatCents(row.totalCents),
              ])}
            />
          </div>
          {/* The free text, listed rather than folded into the table: a count
              of "Other" is the question and this is the answer, and the whole
              point of the two reasons added at C-057 is that this list should
              get shorter. */}
          {report.cancellations.some((row) => row.notes.length > 0) && (
            <>
              <p className="mt-3 text-lg text-neutral-700">What staff wrote:</p>
              <ul className="mt-1 list-disc pl-6 text-lg" data-testid="cancel-notes">
                {report.cancellations.flatMap((row) =>
                  row.notes.map((note, index) => (
                    <li key={`${row.reason}-${index}`}>
                      <span className="text-neutral-600">{CANCEL_REASON_LABEL[row.reason]}</span>{' '}
                      &mdash; {note}
                    </li>
                  )),
                )}
              </ul>
            </>
          )}
        </Section>
      )}

      {/* Outside the "nothing sold" branch on purpose: a report run mid-service
          has no sales and a queue full of orders, and how long they have been
          sitting is exactly the number worth reading then. */}
      <Section title="Time in each state">
        <p className="text-lg text-neutral-700">
          Measured from the order log, so a ticket advanced by mistake and sent back counts both
          visits. Orders still open have their current state counted up to now, which is why a
          busy lunch reads longer than a finished one. Finished states are not listed: an order
          picked up an hour ago has not been &ldquo;picked up&rdquo; for an hour, it is done.
        </p>
        {timeInStateRows.length === 0 ? (
          <p className="mt-3 text-lg">No orders in this window.</p>
        ) : (
          <Table
            headers={['State', 'Orders', 'Average', 'p90', 'Worst', 'Total']}
            label="Time in each state"
            rows={timeInStateRows.map((row) => [
              STATUS_LABEL[row.status],
              String(row.orders),
              row.averageMs === null ? '—' : formatDuration(row.averageMs),
              row.p90Ms === null ? '—' : formatDuration(row.p90Ms),
              row.worstMs === null ? '—' : formatDuration(row.worstMs),
              formatDuration(row.totalMs),
            ])}
          />
        )}
      </Section>

      {/* P0-5. The tally above is per STATE; this is per TICKET, which is the
          grain a customer waited at and a staffing decision is made on. */}
      <Section title="How long tickets took">
        <p className="text-lg text-neutral-700">
          Order to Ready, for every ticket that got there — measured off the order log, floored to
          whole minutes, the same way the kitchen card counts a ticket up. An order that was
          cancelled or is still cooking is not counted: it is not evidence that service was slow.
          &ldquo;Ran late&rdquo; is the same {service.lateAfterMinutes}-minute mark the card turns
          red at.
        </p>
        {service.tickets === 0 ? (
          <p className="mt-3 text-lg">No ticket has reached Ready in this window yet.</p>
        ) : (
          <>
            {/* Two tiles and not three: the slowest ticket is the first row of
                the table below, and a headline restating a row is one more
                place for the two to disagree. */}
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat label="Tickets" value={String(service.tickets)} note="Reached Ready" />
              <Stat
                label="Ran late"
                value={String(service.ranLate)}
                note={`Over ${service.lateAfterMinutes} min to Ready`}
                testId="ran-late"
              />
            </div>
            <div className="mt-3">
              <Table
                headers={['Order', 'Day', 'Order to Ready']}
                label="Slowest tickets"
                rows={service.slowest.map((ticket) => [
                  formatOrderNumber(ticket.seq),
                  ticket.businessDay,
                  `${ticket.minutes} min`,
                ])}
              />
            </div>
          </>
        )}
      </Section>

      {/* Outside the sales branch too, and for the same reason: the question
          "were we honest?" is at its most useful during the service that is
          getting it wrong. */}
      <Section title="Were the quotes honest?">
        <p className="text-lg text-neutral-700">
          Every order below was told a ready-time range at checkout and that range was saved with
          it. Anywhere inside the range counts as on time — that is what a range is for. Early is
          a miss too: someone told &ldquo;15–25 min&rdquo; and handed a bag at six waited longer
          than they had to. Orders placed before this was recorded, and orders that never reached
          Ready, are not counted.
        </p>
        {accuracy.all.samples === 0 ? (
          <p className="mt-3 text-lg">No quoted order has reached Ready in this window yet.</p>
        ) : (
          <>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Quoted orders" value={String(accuracy.all.samples)} note="Reached Ready" />
              <Stat
                label="On time"
                value={percent(accuracy.all.onTime / accuracy.all.samples)}
                note={`${accuracy.all.onTime} of ${accuracy.all.samples} inside the range`}
              />
              <Stat label="Early" value={String(accuracy.all.early)} note="Ready before the low end" />
              <Stat label="Late" value={String(accuracy.all.late)} note="Ready after the high end" />
            </div>
            <div className="mt-3">
              <Table
                headers={['Queue at checkout', 'Orders', 'On time', 'Median miss']}
                label="Quote accuracy by queue depth"
                rows={[
                  accuracyRow('Lighter half', accuracy.lightQueue),
                  accuracyRow('Busier half', accuracy.busyQueue),
                ]}
              />
            </div>
            <p className="mt-3 text-lg" data-testid="quote-suggestion">
              {suggestionText(accuracy.suggestion, accuracy.all.samples)}
            </p>
          </>
        )}
      </Section>

    </main>
  );
}

/** One half of the split, as a table row. Split at the median queue depth, so
 *  "did we get worse as it got busier?" is a comparison of two lines rather
 *  than a chart nobody reads. */
const accuracyRow = (label: string, group: AccuracyGroup): string[] => [
  label,
  String(group.samples),
  String(group.onTime),
  formatMiss(group.medianMissMinutes),
];

/** Signed minutes outside the quoted window, said the way a person would. Zero
 *  is the common case and deserves the plain word, not "0.0 min out". */
function formatMiss(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes === 0) return 'inside the range';
  const size = `${Math.abs(minutes).toFixed(minutes % 1 === 0 ? 0 : 1)} min`;
  return minutes > 0 ? `${size} late` : `${size} early`;
}

/** The engine decides the FACT — which setting, which way — and this decides
 *  the words. Two "change nothing" answers, deliberately distinguished: quotes
 *  that hold up and quotes we have no evidence about are not the same news. */
function suggestionText(suggestion: QuoteAdjustment | null, samples: number): string {
  const SETTING_LABEL = {
    prepBaseMinutes: 'Base prep time',
    prepPerWeightMinutes: 'Minutes per unit of open work',
  } as const;

  if (suggestion === null) {
    return samples < 10
      ? 'Not enough quoted orders yet to say whether the ready-time settings need moving.'
      : 'The quotes are holding up. Nothing to change on the settings screen.';
  }
  const direction = suggestion.direction === 'up' ? 'Raise' : 'Lower';
  const because =
    suggestion.setting === 'prepPerWeightMinutes'
      ? 'the busier half of the window missed by more than the lighter half, so the queue is what the estimate is not pricing'
      : 'both halves of the window missed the same way, so the queue is not the variable';
  return `${direction} ${SETTING_LABEL[suggestion.setting]} on the settings screen — ${because}.`;
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
