// What "forget this customer" means, as two constants and one subtraction
// (PRD 6 P0-4, C-091).
//
// Pure, and the cutoff takes `now` as a parameter like everything else here —
// the sweep is the one job in this product that decides what to destroy from a
// clock reading, so the clock reading is an argument a test can freeze.
//
// WHAT IS IDENTITY AND WHAT IS THE ORDER. This list is the whole judgement of
// the requirement and it is deliberately short: a name, a phone number and the
// customer's free-text note are who placed the order. Everything else on the
// row — `seq`, the money, the lines, the option names, `taxRatePpm`,
// `prepWeight`, the quote, every event — is WHAT WAS SOLD, and the sweep must
// leave every one of them byte-identical or the reports move. There is a test
// that says so, and if it cannot be made to pass the sweep is wrong, not it.

/**
 * What replaces a forgotten name.
 *
 * A PLACEHOLDER, not null: `Order.customerName` is `NOT NULL` and every
 * receipt, queue card and chase-list row renders it unguarded, so nulling the
 * column would trade a retention feature for a crash on eleven screens. The
 * parentheses are load-bearing — this has to read as a state, not as somebody
 * called Forgotten.
 */
export const FORGOTTEN_CUSTOMER_NAME = '(forgotten)';

/**
 * The instant `days` before `now`. Anything strictly older is past its window.
 *
 * ONE function for TWO windows (C-105): `retentionDays`, which bounds how long
 * a customer's identity is kept, and `loyaltyExpiryDays`, which bounds how long
 * an unused balance lives. They are different policies with different numbers
 * and a CHECK tying them together, but "what does N days ago mean" has exactly
 * one answer and a second copy of this subtraction would eventually disagree
 * with the first.
 *
 * Strictly before — an order placed exactly `retentionDays` ago is inside the
 * window and survives one more sweep. A boundary has to fall somewhere and
 * "the window has not elapsed yet" is the side that keeps data.
 *
 * Built through `Date.UTC` with an overflowing day, which is
 * `instantMinutesAfter`'s idiom one file over and the only construction the
 * repo's time lint allows. It is a DURATION and not a calendar walk: UTC days
 * are all 24 hours, so a retention window owes nobody a DST adjustment, and
 * asking the restaurant's calendar what "365 days ago" means would be a second
 * answer to a question with one.
 */
export function cutoffDaysBefore(now: Date, days: number): Date {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - days,
      now.getUTCHours(),
      now.getUTCMinutes(),
      now.getUTCSeconds(),
      now.getUTCMilliseconds(),
    ),
  );
}
