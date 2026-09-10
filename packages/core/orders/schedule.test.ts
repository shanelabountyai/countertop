import { describe, expect, it } from 'vitest';
import { restaurantClock } from './business-day';
import type { StoreHoursDay } from './checkout-gate';
import { availableSlots, canBookSlot, sumWeightBySlot, type SlotConfig } from './schedule';

// Same reference restaurant as checkout-gate.test.ts: Firebird Kitchen on
// America/Los_Angeles, open 11:00-21:00 Monday to Saturday, closed Sunday.
// CI runs this file under TZ=UTC and TZ=Pacific/Kiritimati expecting
// identical results (CLAUDE.md time rules) — every instant below is built
// with Date.UTC, the one form that cannot read the process timezone.
const TZ = 'America/Los_Angeles';
const at = (iso: { d: number; h: number; m?: number }) =>
  new Date(Date.UTC(2026, 6, iso.d, iso.h, iso.m ?? 0, 0));

const NINE_AM = at({ d: 7, h: 16 }); // Tue 09:00 — before opening
const LUNCH = at({ d: 7, h: 20 }); // Tue 13:00
const SUNDAY_NOON = at({ d: 5, h: 19 }); // Sun 12:00 — no hours row

const WEEK: StoreHoursDay[] = [1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek,
  openMinute: 11 * 60,
  closeMinute: 21 * 60,
}));

const gateState = (
  overrides: Partial<{ paused: boolean; closedOnDay: string | null; cutoffMinutes: number }> = {},
) => ({
  paused: false,
  closedOnDay: null,
  hours: WEEK,
  cutoffMinutes: 15,
  ...overrides,
});

const CONFIG: SlotConfig = { intervalMinutes: 15, leadMinutes: 20, maxSlotWeight: 20 };

const slotsAt = (
  now: Date,
  weightBySlot: ReadonlyMap<number, number> = new Map(),
  gateOverrides: Parameters<typeof gateState>[0] = {},
  config: SlotConfig = CONFIG,
) => availableSlots(gateState(gateOverrides), config, weightBySlot, restaurantClock(now, TZ));

describe('available slots (P1-2)', () => {
  it('starts at the next interval boundary after the lead time, not before', () => {
    // 13:00 + 20 minutes lead = 13:20, rounded UP to the next 15-minute mark.
    const result = slotsAt(LUNCH);
    expect(result.open).toBe(true);
    if (!result.open) throw new Error('unreachable');
    expect(result.slots[0]).toMatchObject({ minuteOfDay: 13 * 60 + 30, label: '13:30' });
  });

  it('never offers a slot before the restaurant opens', () => {
    // 09:00 + 20 lead = 09:20, which is before the 11:00 open — the floor is
    // the OPENING minute, not the lead time alone.
    const result = slotsAt(NINE_AM);
    expect(result.open).toBe(true);
    if (!result.open) throw new Error('unreachable');
    expect(result.slots[0]).toMatchObject({ minuteOfDay: 11 * 60 });
  });

  it('stops at the same last-order cutoff the ASAP gate enforces', () => {
    const result = slotsAt(LUNCH, new Map(), { cutoffMinutes: 15 });
    expect(result.open).toBe(true);
    if (!result.open) throw new Error('unreachable');
    const last = result.slots.at(-1);
    // Close is 21:00; cutoff 15 minutes means the last bookable slot is
    // 20:45, never 21:00 itself — the kitchen still needs the cutoff window
    // to make whatever it just promised.
    expect(last).toMatchObject({ minuteOfDay: 20 * 60 + 45 });
  });

  it('reports full capacity as a real slot with zero remaining, not a missing one', () => {
    const weightBySlot = new Map([[13 * 60 + 30, 20]]);
    const result = slotsAt(LUNCH, weightBySlot);
    expect(result.open).toBe(true);
    if (!result.open) throw new Error('unreachable');
    expect(result.slots[0]).toMatchObject({ minuteOfDay: 13 * 60 + 30, remainingWeight: 0 });
  });

  it('leaves partial capacity visible below the cap', () => {
    const weightBySlot = new Map([[13 * 60 + 30, 6]]);
    const result = slotsAt(LUNCH, weightBySlot);
    expect(result.open).toBe(true);
    if (!result.open) throw new Error('unreachable');
    expect(result.slots[0]).toMatchObject({ remainingWeight: 14 });
  });

  describe('precedence, mirroring the ASAP gate\'s first two triggers', () => {
    it('the manual pause always wins', () => {
      expect(slotsAt(LUNCH, new Map(), { paused: true })).toMatchObject({
        open: false,
        reason: 'manually_paused',
      });
    });

    it('a closed-today override refuses every slot', () => {
      expect(slotsAt(LUNCH, new Map(), { closedOnDay: '2026-07-07' })).toMatchObject({
        open: false,
        reason: 'closed_today',
      });
    });

    it('a day with no hours row refuses every slot', () => {
      const result = slotsAt(SUNDAY_NOON);
      expect(result).toMatchObject({ open: false, reason: 'outside_hours' });
    });

    it('does NOT inherit the throttle — a busy ASAP queue says nothing about a future slot', () => {
      // availableSlots takes no openWeight at all: there is no way to hand it
      // one, which is the point. Only each slot's own remainingWeight caps it.
      const result = slotsAt(LUNCH);
      expect(result.open).toBe(true);
    });
  });
});

describe('canBookSlot (P1-2)', () => {
  const result = slotsAt(LUNCH, new Map([[13 * 60 + 30, 15]]));
  if (!result.open) throw new Error('unreachable');

  it('accepts a request that fits in what is left', () => {
    expect(canBookSlot(result.slots, 13 * 60 + 30, 5)).toBe(true);
  });

  it('refuses a request heavier than what is left', () => {
    expect(canBookSlot(result.slots, 13 * 60 + 30, 6)).toBe(false);
  });

  it('refuses a minute that was never generated — a stale list, not a real slot', () => {
    expect(canBookSlot(result.slots, 13 * 60 + 37, 1)).toBe(false);
  });
});

describe('sumWeightBySlot (P1-2)', () => {
  it('sums prep weight per minute, leaving other minutes absent', () => {
    const totals = sumWeightBySlot([
      { minuteOfDay: 780, prepWeight: 3 },
      { minuteOfDay: 780, prepWeight: 2 },
      { minuteOfDay: 795, prepWeight: 4 },
    ]);
    expect(totals.get(780)).toBe(5);
    expect(totals.get(795)).toBe(4);
    expect(totals.has(810)).toBe(false);
  });
});

// `zonedTimeToInstant` is tested in business-day.test.ts, where the function
// now lives (P1-2 moved it there — it is the one local -> instant exception
// that module's header carves out, and this file does not call it at all).
