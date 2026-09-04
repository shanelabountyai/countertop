// What window the report is looking at (P0-3, widened at P1-1 / C-058).
//
// Its own module because there are now TWO readers — the page and the CSV
// route handler — and a report whose export covers a different set of days
// than the screen above it is worse than no export at all. The resolution
// happens once, here, and both callers take the whole answer.
import { businessDayRange, instantDaysBefore } from '@countertop/core';
import type { ReportWindow } from '@countertop/db/report';

// `today` is not "1 day" and is deliberately not spelled as one: the rolling
// windows are 24-hour multiples from `now`, and this one is the restaurant's
// own business day (P0-3). It leads because it is the question the screen is
// opened to answer during a service.
export const WINDOWS = ['today', 1, 7, 30, 90] as const;
export type ReportChoice = (typeof WINDOWS)[number];
const DEFAULT_WINDOW: ReportChoice = 'today';

/** The three params the report reads. Loose strings, because they arrive off a
 *  URL a person can type. */
export type ReportParams = { days?: string; from?: string; to?: string };

export type ReportView = {
  bounds: ReportWindow;
  /** Which window button is lit, or `null` when a typed range is in force. */
  choice: ReportChoice | null;
  /** The typed range, already ordered and validated, or `null`. */
  range: { from: string; to: string } | null;
  label: string;
  /** The window as a query string — the CSV link hands the export handler the
   *  exact params the page resolved itself from, so the two cannot drift. */
  query: string;
  /** The window in a filename: a bookkeeper's downloads folder ends up holding
   *  several of these and "report.csv (3)" tells them nothing. */
  slug: string;
};

export const windowLabel = (choice: ReportChoice): string =>
  choice === 'today' ? 'Today' : choice === 1 ? 'Last 24 hours' : `Last ${choice} days`;

/**
 * The window, from the URL.
 *
 * A valid typed range WINS over the window buttons — it is the more specific
 * thing, and it is the thing the person just typed. A half-filled or malformed
 * range falls back to the buttons rather than erroring: the form has two date
 * inputs and landing on the page with one of them filled is a normal state,
 * not a mistake to interrupt somebody over.
 *
 * `today` is resolved to the SAME shape as a range whose ends are equal, so
 * there is one string-matching path below this and not two.
 */
export function resolveWindow(params: ReportParams, now: Date, today: string): ReportView {
  const range = businessDayRange(params.from, params.to);
  if (range !== null) {
    return {
      bounds: range,
      choice: null,
      range,
      label: range.from === range.to ? range.from : `${range.from} to ${range.to}`,
      query: `from=${range.from}&to=${range.to}`,
      slug: range.from === range.to ? range.from : `${range.from}_${range.to}`,
    };
  }

  const choice = WINDOWS.find((option) => String(option) === params.days) ?? DEFAULT_WINDOW;
  return {
    // The business day the order numbers reset on, matched as a string against
    // the column placement wrote — never a pair of instants around local
    // midnight (P0-3). Everything else stays the generous instant bound.
    bounds: choice === 'today' ? { from: today, to: today } : instantDaysBefore(now, choice),
    choice,
    range: null,
    label: windowLabel(choice),
    query: `days=${choice}`,
    slug: choice === 'today' ? today : `last-${choice}-days`,
  };
}
