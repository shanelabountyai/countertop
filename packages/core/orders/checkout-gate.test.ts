import { describe, expect, it } from 'vitest';
import { restaurantClock } from './business-day';
import { checkoutGate, orderingWindow, type GateState, type StoreHoursDay } from './checkout-gate';

// Every instant is built with Date.UTC — the one form that provably cannot
// read the process timezone. CI runs this file under TZ=UTC and
// TZ=Pacific/Kiritimati expecting identical results.
//
// The restaurant is Firebird Kitchen on America/Los_Angeles, open 11:00–21:00
// Monday to Saturday and closed Sunday. The reference instants below were
// hand-checked against that wall clock:
//
//   2026-07-07T18:00Z = Tue 11:00  — the minute the doors open
//   2026-07-07T20:00Z = Tue 13:00  — the middle of lunch
//   2026-07-08T03:00Z = Tue 20:00  — an hour before close
//   2026-07-08T04:00Z = Tue 21:00  — closing time exactly
//   2026-07-08T05:00Z = Tue 22:00  — an hour after close
//   2026-07-05T19:00Z = Sun 12:00  — a day with no hours row at all
const TZ = 'America/Los_Angeles';
const at = (iso: { d: number; h: number }) => new Date(Date.UTC(2026, 6, iso.d, iso.h, 0, 0));

const OPENING = at({ d: 7, h: 18 }); // Tue 11:00
const LUNCH = at({ d: 7, h: 20 }); // Tue 13:00
const HOUR_BEFORE_CLOSE = at({ d: 8, h: 3 }); // Tue 20:00
const CLOSING_TIME = at({ d: 8, h: 4 }); // Tue 21:00
const AFTER_CLOSE = at({ d: 8, h: 5 }); // Tue 22:00
const SUNDAY_NOON = at({ d: 5, h: 19 }); // Sun 12:00

const WEEK: StoreHoursDay[] = [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  openMinute: 11 * 60,
  closeMinute: 21 * 60,
}));

const state = (overrides: Partial<GateState> = {}): GateState => ({
  paused: false,
  pauseMessage: null,
  maxOpenWeight: 60,
  openWeight: 0,
  closedOnDay: null,
  hours: WEEK,
  cutoffMinutes: 15,
  ...overrides,
});

const gate = (now: Date, overrides: Partial<GateState> = {}) =>
  checkoutGate(state(overrides), restaurantClock(now, TZ));

describe('the checkout gate (P0-6)', () => {
  it('is open in the middle of service', () => {
    expect(gate(LUNCH)).toEqual({ open: true });
  });

  it('opens exactly at the opening minute, not a minute after', () => {
    expect(gate(OPENING)).toEqual({ open: true });
  });

  describe('trigger 1 — the manual switch', () => {
    it('closes an otherwise open restaurant', () => {
      const result = gate(LUNCH, { paused: true });
      expect(result.open).toBe(false);
      expect(result).toMatchObject({ reason: 'manually_paused', transient: true });
    });

    it('overrides the throttle, so the reason staff see is the one they chose', () => {
      // Both triggers fire. P0-6: "the manual switch always overrides" — and
      // a cook who paused because the fryer died must not be told the store is
      // merely busy, nor have their pause lifted when the queue drains.
      const result = gate(LUNCH, { paused: true, openWeight: 99 });
      expect(result).toMatchObject({ reason: 'manually_paused' });
    });

    it('overrides the calendar too — a closed restaurant that also paused', () => {
      expect(gate(SUNDAY_NOON, { paused: true })).toMatchObject({ reason: 'manually_paused' });
    });

    it('uses the staff message when there is one', () => {
      const result = gate(LUNCH, { paused: true, pauseMessage: 'Fryer is down until 2.' });
      expect(result).toMatchObject({ message: 'Fryer is down until 2.' });
    });

    it('falls back to the default when the message is blank or whitespace', () => {
      const result = gate(LUNCH, { paused: true, pauseMessage: '   ' });
      expect(result).toMatchObject({ message: expect.stringContaining('paused new online orders') });
    });
  });

  describe('trigger 2 — the open-weight threshold', () => {
    it('stays open one unit of work below the threshold', () => {
      expect(gate(LUNCH, { maxOpenWeight: 60, openWeight: 59 })).toEqual({ open: true });
    });

    it('closes AT the threshold, not one past it', () => {
      // `>=`, so a max of 60 means sixty units of open work is the cap. A
      // gate that waits for 61 is a threshold nobody can reason about.
      expect(gate(LUNCH, { maxOpenWeight: 60, openWeight: 60 })).toMatchObject({
        reason: 'too_busy',
        transient: true,
      });
    });

    it('re-opens on its own as the queue drains', () => {
      const busy = state({ openWeight: 60 });
      const drained = { ...busy, openWeight: 59 };
      expect(checkoutGate(busy, restaurantClock(LUNCH, TZ)).open).toBe(false);
      expect(checkoutGate(drained, restaurantClock(LUNCH, TZ)).open).toBe(true);
    });

    it('reads WORK, so a queue of drinks is not a queue of plates (P1-7)', () => {
      // Ten bottled waters (weight 0) and ten fajita plates (weight 4) are ten
      // tickets either way. Only one of them is a kitchen that should stop
      // taking orders — which the old count could not tell apart.
      expect(gate(LUNCH, { maxOpenWeight: 20, openWeight: 0 })).toEqual({ open: true });
      expect(gate(LUNCH, { maxOpenWeight: 20, openWeight: 40 })).toMatchObject({
        reason: 'too_busy',
      });
    });

    it('is asked last: a closed restaurant is not "too busy"', () => {
      expect(gate(AFTER_CLOSE, { openWeight: 99 })).not.toMatchObject({ reason: 'too_busy' });
    });
  });

  describe('trigger 3 — hours, the closed-today override, and the cutoff', () => {
    it('names the opening time before the doors open', () => {
      const beforeOpen = at({ d: 7, h: 17 }); // Tue 10:00
      expect(gate(beforeOpen)).toMatchObject({
        reason: 'outside_hours',
        message: 'We open at 11:00 today.',
      });
    });

    it('treats a day with no hours row as closed, and says when to come back', () => {
      const result = gate(SUNDAY_NOON);
      expect(result).toMatchObject({ reason: 'outside_hours' });
      // Sunday is closed; Monday opens at 11:00. "tomorrow", not "on Monday".
      expect(result).toMatchObject({ message: 'We are closed right now. We open tomorrow at 11:00.' });
    });

    it('honours a closed-today override on a day that has hours', () => {
      expect(gate(LUNCH, { closedOnDay: '2026-07-07' })).toMatchObject({ reason: 'closed_today' });
    });

    it('ignores a closed-today override for a DIFFERENT day', () => {
      expect(gate(LUNCH, { closedOnDay: '2026-07-08' })).toEqual({ open: true });
    });

    it('stops new orders the configured minutes before close', () => {
      // 21:00 close, 15-minute cutoff: 20:45 is the first refused minute.
      const lastOrder = at({ d: 8, h: 3 }); // 20:00 — still fine
      expect(gate(lastOrder)).toEqual({ open: true });

      const cutoff = new Date(Date.UTC(2026, 6, 8, 3, 45, 0)); // Tue 20:45
      expect(gate(cutoff)).toMatchObject({
        reason: 'closing_soon',
        message: expect.stringContaining('20:45'),
      });
      expect(gate(new Date(Date.UTC(2026, 6, 8, 3, 44, 0)))).toEqual({ open: true });
    });

    it('honours a different cutoff', () => {
      const twentyToNine = new Date(Date.UTC(2026, 6, 8, 3, 40, 0)); // Tue 20:40
      expect(gate(twentyToNine, { cutoffMinutes: 30 })).toMatchObject({ reason: 'closing_soon' });
      expect(gate(twentyToNine, { cutoffMinutes: 15 })).toEqual({ open: true });
    });

    it('says "come to the counter" while staff are still inside', () => {
      expect(gate(HOUR_BEFORE_CLOSE, { cutoffMinutes: 90 })).toMatchObject({
        message: expect.stringContaining('counter'),
      });
    });

    it('says "come back tomorrow" once the lights are off', () => {
      // Same reason, different sentence: at 22:00 nobody is inside to walk up
      // to, so pointing at the counter would send someone to a locked door.
      const result = gate(AFTER_CLOSE);
      expect(result).toMatchObject({ reason: 'closing_soon' });
      expect(result).toMatchObject({ message: expect.stringContaining('tomorrow at 11:00') });
      expect(result).not.toMatchObject({ message: expect.stringContaining('counter') });
    });

    it('closes at the closing minute itself, cutoff or no cutoff', () => {
      expect(gate(CLOSING_TIME, { cutoffMinutes: 0 }).open).toBe(false);
    });

    it('is honest rather than precise when no day has hours at all', () => {
      const result = gate(LUNCH, { hours: [] });
      expect(result).toMatchObject({ message: 'Online ordering is closed right now.' });
    });

    it('names a weekday when the next opening is not tomorrow', () => {
      // Open Saturdays only. From Sunday noon, that is six days out.
      const saturdayOnly = [{ dayOfWeek: 6, openMinute: 9 * 60, closeMinute: 14 * 60 }];
      expect(gate(SUNDAY_NOON, { hours: saturdayOnly })).toMatchObject({
        message: 'We are closed right now. We open on Saturday at 09:00.',
      });
    });
  });

  describe('the ordering window', () => {
    it('is the kitchen window minus the cutoff', () => {
      expect(orderingWindow({ dayOfWeek: 2, openMinute: 660, closeMinute: 1260 }, 15)).toEqual({
        openMinute: 660,
        lastOrderMinute: 1245,
      });
    });
  });

  it('holds across a DST jump — the offset is not a constant', () => {
    // 2026-03-08: 2am PST becomes 3am PDT. 2026-03-08 is a Sunday, so use the
    // autumn jump instead, when 2026-11-01 01:00 PDT repeats as 01:00 PST.
    // Either side, "what time is it at the restaurant" has one answer.
    const springForwardDay = restaurantClock(new Date(Date.UTC(2026, 2, 8, 18, 0, 0)), TZ);
    expect(springForwardDay.minuteOfDay).toBe(11 * 60); // 11:00 PDT, not 10:00
  });
});
