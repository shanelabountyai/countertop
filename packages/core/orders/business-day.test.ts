import { describe, expect, it } from 'vitest';
import {
  businessDayOf,
  businessDayRange,
  formatMinuteOfDay,
  instantDaysBefore,
  instantMinutesAfter,
  restaurantClock,
} from './business-day';

// Every instant here is built with Date.UTC — the one form that provably
// cannot read the process timezone. CI runs this file under TZ=UTC and
// TZ=Pacific/Kiritimati and expects identical results; a function that leaked
// the process timezone would pass one pass and fail the other.

describe('the business day (P0-8)', () => {
  it('is the restaurant\'s calendar day, not UTC\'s', () => {
    // 8pm on the 4th in Los Angeles — mid-dinner — is already the 5th in UTC.
    const dinner = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));
    expect(businessDayOf(dinner, 'America/Los_Angeles')).toBe('2026-07-04');
    expect(businessDayOf(dinner, 'UTC')).toBe('2026-07-05');
  });

  it('rolls over at the restaurant\'s midnight, to the minute', () => {
    const before = new Date(Date.UTC(2026, 6, 5, 6, 59, 59));
    const after = new Date(Date.UTC(2026, 6, 5, 7, 0, 0)); // 00:00 PDT
    expect(businessDayOf(before, 'America/Los_Angeles')).toBe('2026-07-04');
    expect(businessDayOf(after, 'America/Los_Angeles')).toBe('2026-07-05');
  });

  it('holds across a DST jump — the offset is not a constant', () => {
    // 2026-03-08, 2am PST becomes 3am PDT. The same UTC hour is a different
    // local hour either side of it, which is why an offset baked into a
    // constant gets the day wrong twice a year.
    const beforeSpringForward = new Date(Date.UTC(2026, 2, 8, 9, 30, 0)); // 01:30 PST
    const afterSpringForward = new Date(Date.UTC(2026, 2, 8, 11, 30, 0)); // 04:30 PDT
    expect(businessDayOf(beforeSpringForward, 'America/Los_Angeles')).toBe('2026-03-08');
    expect(businessDayOf(afterSpringForward, 'America/Los_Angeles')).toBe('2026-03-08');
  });

  it('reads a zone ahead of UTC as that zone, not as an offset guess', () => {
    const instant = new Date(Date.UTC(2026, 6, 4, 12, 0, 0));
    expect(businessDayOf(instant, 'Pacific/Kiritimati')).toBe('2026-07-05'); // UTC+14
    expect(businessDayOf(instant, 'Pacific/Honolulu')).toBe('2026-07-04'); // UTC-10
  });

  it('pads to exactly ten characters, matching the Char(10) column', () => {
    expect(businessDayOf(new Date(Date.UTC(2026, 0, 2, 12, 0, 0)), 'UTC')).toBe('2026-01-02');
  });

  it('throws on an unknown timezone rather than falling back to UTC', () => {
    expect(() => businessDayOf(new Date(Date.UTC(2026, 6, 4)), 'America/Nowhere')).toThrow();
  });
});

describe('the restaurant clock (P0-6)', () => {
  it('reads the weekday in the restaurant\'s calendar, not UTC\'s', () => {
    // Sunday 8pm in Los Angeles is already Monday in UTC. A store closed on
    // Sundays would otherwise open its doors four hours early every week.
    const sundayEvening = new Date(Date.UTC(2026, 6, 6, 3, 0, 0));
    expect(restaurantClock(sundayEvening, 'America/Los_Angeles')).toMatchObject({
      day: '2026-07-05',
      weekday: 0,
      minuteOfDay: 20 * 60,
    });
    expect(restaurantClock(sundayEvening, 'UTC')).toMatchObject({ weekday: 1, minuteOfDay: 180 });
  });

  it('reads midnight as 0, not 1440', () => {
    // en-US renders midnight as "24" without `hourCycle: h23`, which turns the
    // one minute of the day it matters most into an out-of-range number.
    const midnight = new Date(Date.UTC(2026, 6, 5, 7, 0, 0)); // 00:00 PDT
    expect(restaurantClock(midnight, 'America/Los_Angeles').minuteOfDay).toBe(0);
  });

  it('reads the last minute of the day as 1439', () => {
    const lastMinute = new Date(Date.UTC(2026, 6, 5, 6, 59, 0)); // 23:59 PDT
    expect(restaurantClock(lastMinute, 'America/Los_Angeles').minuteOfDay).toBe(23 * 60 + 59);
  });

  it('throws on an unknown timezone rather than falling back to UTC', () => {
    expect(() => restaurantClock(new Date(Date.UTC(2026, 6, 5, 12, 0, 0)), 'Mars/Olympus')).toThrow();
  });
});

describe('formatting a minute of the day', () => {
  it('pads both halves', () => {
    expect(formatMinuteOfDay(0)).toBe('00:00');
    expect(formatMinuteOfDay(9 * 60 + 5)).toBe('09:05');
    expect(formatMinuteOfDay(21 * 60)).toBe('21:00');
    expect(formatMinuteOfDay(23 * 60 + 59)).toBe('23:59');
  });
});

describe('instantDaysBefore', () => {
  const AT = new Date(Date.UTC(2026, 6, 14, 19, 30, 0));

  it('subtracts whole 24-hour days from an instant', () => {
    expect(instantDaysBefore(AT, 7)).toEqual(new Date(Date.UTC(2026, 6, 7, 19, 30, 0)));
  });

  it('subtracts 24 hours across a DST change, not a calendar day', () => {
    // 2026-03-09 12:00 UTC back one day is 2026-03-08 12:00 UTC, whatever the
    // local clock did in between. The window is a lower bound for a query; the
    // buckets are computed from the restaurant's calendar afterwards.
    const after = new Date(Date.UTC(2026, 2, 9, 12, 0, 0));
    expect(instantDaysBefore(after, 1)).toEqual(new Date(Date.UTC(2026, 2, 8, 12, 0, 0)));
  });

  it('returns the same instant for zero days', () => {
    expect(instantDaysBefore(AT, 0)).toEqual(AT);
  });
});

describe('instantMinutesAfter', () => {
  const noon = new Date(Date.UTC(2026, 6, 14, 12, 0, 0));

  it('normalises past the hour, the day and the year', () => {
    expect(instantMinutesAfter(noon, 90)).toEqual(new Date(Date.UTC(2026, 6, 14, 13, 30, 0)));
    expect(instantMinutesAfter(noon, 13 * 60)).toEqual(new Date(Date.UTC(2026, 6, 15, 1, 0, 0)));
    expect(instantMinutesAfter(new Date(Date.UTC(2026, 11, 31, 23, 30, 0)), 45)).toEqual(
      new Date(Date.UTC(2027, 0, 1, 0, 15, 0)),
    );
  });

  it('goes backwards on a negative count', () => {
    expect(instantMinutesAfter(noon, -12 * 60 - 1)).toEqual(
      new Date(Date.UTC(2026, 6, 13, 23, 59, 0)),
    );
  });

  it('keeps the seconds and milliseconds it was given', () => {
    const odd = new Date(Date.UTC(2026, 6, 14, 12, 0, 37, 412));
    expect(instantMinutesAfter(odd, 5)).toEqual(new Date(Date.UTC(2026, 6, 14, 12, 5, 37, 412)));
  });

  it('is an INSTANT shift, unaffected by the process timezone', () => {
    // The whole point of the UTC-field form: the result is the same instant
    // whatever TZ the suite runs under, which CI checks by running it twice.
    expect(instantMinutesAfter(noon, 30).getTime() - noon.getTime()).toBe(30 * 60_000);
  });
});

// P1-1 / C-058. The one decision in the report's date range: what counts as a
// pair of days, and what a backwards pair means.
describe('a typed business-day range (P1-1)', () => {
  it('takes two well-formed days and keeps them inclusive', () => {
    expect(businessDayRange('2026-07-14', '2026-07-20')).toEqual({
      from: '2026-07-14',
      to: '2026-07-20',
    });
  });

  it('is a single day when both ends are the same', () => {
    expect(businessDayRange('2026-07-14', '2026-07-14')).toEqual({
      from: '2026-07-14',
      to: '2026-07-14',
    });
  });

  it('sorts a backwards pair rather than reporting on nothing', () => {
    expect(businessDayRange('2026-07-20', '2026-07-14')).toEqual({
      from: '2026-07-14',
      to: '2026-07-20',
    });
  });

  it('refuses half a range — one end missing is a different question', () => {
    expect(businessDayRange('2026-07-14', undefined)).toBeNull();
    expect(businessDayRange(undefined, '2026-07-20')).toBeNull();
    expect(businessDayRange(undefined, undefined)).toBeNull();
    expect(businessDayRange('2026-07-14', '')).toBeNull();
  });

  it('refuses a month or a day that could over-match a whole December', () => {
    // The reason the bounds are in the regex: "2026-13-99" sorts ABOVE every
    // real day in 2026, so a loose pattern would quietly widen the window
    // past what was asked for instead of failing.
    expect(businessDayRange('2026-07-14', '2026-13-99')).toBeNull();
    expect(businessDayRange('2026-00-01', '2026-07-20')).toBeNull();
    expect(businessDayRange('2026-7-14', '2026-07-20')).toBeNull();
    expect(businessDayRange('14/07/2026', '2026-07-20')).toBeNull();
  });
});
