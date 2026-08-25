import { describe, expect, it } from 'vitest';
import { businessDayOf } from './business-day.js';

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
