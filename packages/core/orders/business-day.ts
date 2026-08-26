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
 * The restaurant's wall clock at an instant: what day it is there, which day
 * of the week, and how far into the day.
 *
 * ONE `Intl` call, and the only place in the codebase that converts an instant
 * to a local wall-clock reading. Everything downstream — the daily order-number
 * reset (P0-8), the store-hours gate (P0-6), every report bucket (P1-1) — asks
 * this, which is what the CLAUDE.md bans on `getHours` and `getTimezoneOffset`
 * exist to force.
 *
 * The direction matters: instant → local, never local → instant. A DST jump
 * makes the reverse ambiguous (2:30am happens twice in the autumn and not at
 * all in the spring); this direction is always a single answer.
 *
 * Throws on an unknown timezone rather than falling back to UTC: a typo in the
 * settings row must fail loudly at the first placement, not silently reset the
 * order numbers — or unlock the doors — at the wrong hour for a week.
 */
export type RestaurantClock = {
  /** "YYYY-MM-DD" in the restaurant's calendar. */
  day: string;
  /** 0 = Sunday, matching `StoreHours.dayOfWeek` and `Date.prototype.getDay`. */
  weekday: number;
  /** Minutes since local midnight, 0–1439. What store hours are compared in. */
  minuteOfDay: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function restaurantClock(now: Date, timezone: string): RestaurantClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    // Without this, en-US renders midnight as "24" and the arithmetic below
    // silently produces 1440 for the one minute of the day it matters most.
    hourCycle: 'h23',
  }).formatToParts(now);

  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((candidate) => candidate.type === type);
    if (!found) throw new Error(`Could not read ${type} in timezone ${timezone}`);
    return found.value;
  };

  const weekday = WEEKDAY_INDEX[part('weekday')];
  if (weekday === undefined) throw new Error(`Could not read weekday in timezone ${timezone}`);

  return {
    // Year padded, not assumed four digits: en-US renders year 999 as "999".
    day: `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`,
    weekday,
    minuteOfDay: Number(part('hour')) * 60 + Number(part('minute')),
  };
}

/**
 * The restaurant-timezone calendar day of an instant, as "YYYY-MM-DD".
 *
 * Matches the `businessDay` column exactly (`Char(10)`, a string — never a
 * Postgres `date`, which round-trips through JS as an instant and shifts a
 * day west).
 */
export function businessDayOf(now: Date, timezone: string): string {
  return restaurantClock(now, timezone).day;
}

/** "13:05" from 785. The customer-facing half of "we open at 11:00" (P0-6). */
export function formatMinuteOfDay(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * `now` minus a whole number of 24-hour days, as an instant (P1-1).
 *
 * INSTANT arithmetic, not calendar arithmetic, and deliberately so: "30 days
 * ago" here means 30 × 24 hours. That is exactly what a report window wants —
 * a generous lower bound for one indexed query, with the exact day bucketing
 * done afterwards by `restaurantClock` against the restaurant's own calendar.
 * Calendar arithmetic would have to answer what "a day" means across a DST
 * change, in the local → instant direction this module refuses to go.
 *
 * The cost, and the screen says so: the oldest local day in a window is
 * usually partial.
 */
export function instantDaysBefore(now: Date, days: number): Date {
  /* The ban exists to stop a CALENDAR value being read through the process
     timezone. This builds an instant from an instant by arithmetic on epoch
     milliseconds: no calendar, no timezone, no parsing. This module is where
     the rule's own message says such a conversion belongs, and this is the
     only exemption in the codebase. */
  // eslint-disable-next-line no-restricted-syntax
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
