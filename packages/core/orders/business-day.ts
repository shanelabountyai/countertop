// The business day (P0-8, and every report bucket in C-016).
//
// An order's `placedAt` is an instant. "Which day's #047 is this?" is a
// CALENDAR question, and the calendar that answers it is the restaurant's —
// never UTC, never the server process's timezone. A restaurant on
// America/Los_Angeles that closes at 9pm would otherwise roll its order
// numbers over at 4pm local, mid-dinner, because that is midnight in UTC.
//
// `Intl` is the only timezone database in the platform, and it is the reason
// this file needs no dependency: it converts an instant to a wall-clock date
// in a named zone, which is exactly the one operation the CLAUDE.md time bans
// exist to force through a module like this one.

/**
 * The restaurant-timezone calendar day of an instant, as "YYYY-MM-DD".
 *
 * Matches the `businessDay` column exactly (`Char(10)`, a string — never a
 * Postgres `date`, which round-trips through JS as an instant and shifts a
 * day west).
 *
 * Throws on an unknown timezone rather than falling back to UTC: a typo in the
 * settings row must fail loudly at the first placement, not silently reset the
 * order numbers at the wrong hour for a week.
 */
export function businessDayOf(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((candidate) => candidate.type === type);
    if (!found) throw new Error(`Could not read ${type} in timezone ${timezone}`);
    return found.value;
  };

  // Year padded, not assumed four digits: en-US renders year 999 as "999".
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
