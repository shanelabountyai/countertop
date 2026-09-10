// Order-ahead scheduling (P1-2): "pickup at 12:30" slots with per-slot
// capacity.
//
// A second, sibling question to THE checkout gate (P0-6). That gate answers
// "can an order be placed right now?"; this file answers a structurally
// different one, "can a promise be made for a specific future minute?" — and
// it gets its own function for the same reason orderability got its own
// function instead of a new branch on the price engine: one function per
// question, not one function that grows an axis every time a new kind of
// question shows up shaped like the old one.
//
// Same-day only. A restaurant that wants "order Tuesday for Thursday" is P2's
// catering lead-time rule (master PRD), not this line of it.
//
// Pure, like `checkout-gate.ts`: `clock` and `weightBySlot` are parameters,
// nothing here reads a database or the system clock.
import { formatMinuteOfDay, type RestaurantClock } from './business-day';
import { orderingWindow, type GateReason, type StoreHoursDay } from './checkout-gate';

// `zonedTimeToInstant` — the local -> instant conversion `Order.requestedFor`
// needs — lives in `business-day.ts`, not here: it is the one exception that
// module's header carves out of its own "instant -> local, never the
// reverse" rule, so there is exactly one such function rather than two.
// `packages/core`'s index re-exports it from there; nothing in THIS file
// calls it, since placement resolves the instant, not `availableSlots`.

/** The four numbers an operator tunes on the settings screen. */
export type SlotConfig = {
  /** How far apart slots are offered — "every 15 minutes". */
  intervalMinutes: number;
  /** How soon the FIRST slot may be — the kitchen's own turnaround, separate
   *  from the ASAP estimate because a scheduled order skips the queue this
   *  restaurant is estimating against. */
  leadMinutes: number;
  /** Prep weight a single slot may hold before it stops being offered — the
   *  same scale `maxOpenWeight` throttles the live queue on (P1-7), so
   *  "busy" means one thing whether an order is ASAP or scheduled. */
  maxSlotWeight: number;
};

/** One offerable pickup time. */
export type Slot = {
  /** Local wall-clock minutes since midnight — what `weightBySlot` and a
   *  booking request are both keyed on. */
  minuteOfDay: number;
  /** "12:30", for the picker. */
  label: string;
  /** Prep weight still bookable in this slot. 0 means full, not absent — a
   *  full slot is still a real slot a customer might have filled a minute
   *  ago, and the screen can say so instead of pretending it never existed. */
  remainingWeight: number;
};

export type ScheduleResult =
  | { open: true; slots: Slot[] }
  | { open: false; reason: GateReason; message: string };

/** The bit of `GateState` this file reads, named separately so `schedule.ts`
 *  does not import a type named for the OTHER gate's whole shape. */
type GateReasonState = {
  paused: boolean;
  closedOnDay: string | null;
  hours: readonly StoreHoursDay[];
  cutoffMinutes: number;
};

/** `minute`, pushed forward to the next multiple of `interval`. Already a
 *  multiple stays put — the lead time is a floor, not a nudge. */
function roundUpToInterval(minute: number, interval: number): number {
  return Math.ceil(minute / interval) * interval;
}

/**
 * Every slot left to book today, and what each still holds (P1-2).
 *
 * Precedence mirrors `checkoutGate`'s first two triggers — the manual switch,
 * then the calendar — because a kitchen that told customers ordering NOW to
 * come back tomorrow cannot turn around and accept a promise for THIS
 * afternoon. What it deliberately does NOT inherit is the throttle
 * (`too_busy`) or the pre-close cutoff's "closing soon" wording: a scheduled
 * slot's own remaining weight is its capacity check, and the only calendar
 * fact left to enforce is that the slot's minute falls inside today's window,
 * which `orderingWindow` already answers for the ASAP gate.
 */
export function availableSlots(
  state: Pick<GateReasonState, 'paused' | 'closedOnDay' | 'hours' | 'cutoffMinutes'>,
  config: SlotConfig,
  weightBySlot: ReadonlyMap<number, number>,
  clock: RestaurantClock,
): ScheduleResult {
  if (state.paused) {
    return {
      open: false,
      reason: 'manually_paused',
      message: 'Scheduled pickup is off right now, same as ordering for now.',
    };
  }

  if (state.closedOnDay === clock.day) {
    return { open: false, reason: 'closed_today', message: 'We are closed today.' };
  }

  const today = state.hours.find((day) => day.dayOfWeek === clock.weekday);
  if (!today) {
    return { open: false, reason: 'outside_hours', message: 'We are closed today.' };
  }

  const { lastOrderMinute } = orderingWindow(today, state.cutoffMinutes);
  const earliest = roundUpToInterval(
    Math.max(today.openMinute, clock.minuteOfDay + config.leadMinutes),
    config.intervalMinutes,
  );

  const slots: Slot[] = [];
  for (let minute = earliest; minute <= lastOrderMinute; minute += config.intervalMinutes) {
    const booked = weightBySlot.get(minute) ?? 0;
    slots.push({
      minuteOfDay: minute,
      label: formatMinuteOfDay(minute),
      remainingWeight: Math.max(0, config.maxSlotWeight - booked),
    });
  }

  return { open: true, slots };
}

/**
 * Is `minuteOfDay` still bookable for `weight` more prep points (P1-2)?
 *
 * The ONE re-check placement makes against a list the customer's browser saw
 * moments earlier — never trusting that list itself, the same discipline
 * `reviewCart` applies to a cart. A minute absent from `slots` (past the
 * cutoff, before the lead time, or simply never generated) fails exactly like
 * a full one: the customer's screen was showing a stale window either way.
 */
export function canBookSlot(slots: readonly Slot[], minuteOfDay: number, weight: number): boolean {
  const slot = slots.find((candidate) => candidate.minuteOfDay === minuteOfDay);
  return slot !== undefined && slot.remainingWeight >= weight;
}

/** How much prep weight is already promised to each slot (P1-2), from the
 *  scheduled orders still open right now. Pure aggregation — the caller reads
 *  `Order.requestedFor` rows and resolves each to a local minute before
 *  calling this, the same way `restaurantClock` is the one place an instant
 *  becomes a wall-clock reading. */
export function sumWeightBySlot(
  rows: readonly { minuteOfDay: number; prepWeight: number }[],
): Map<number, number> {
  const totals = new Map<number, number>();
  for (const row of rows) {
    totals.set(row.minuteOfDay, (totals.get(row.minuteOfDay) ?? 0) + row.prepWeight);
  }
  return totals;
}
