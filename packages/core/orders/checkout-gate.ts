// THE checkout gate (P0-6). One code path, three triggers.
//
// "Can a customer place an order right now?" is asked in three places — the
// cart screen deciding whether to render a checkout form, the checkout form
// deciding whether to render a submit button, and `placeOrder` deciding
// whether to write a row. All three call `checkoutGate`. None of them knows
// what a trigger is.
//
// That is the whole design constraint. A pause switch that stops the button
// but not the POST is not a pause; a closing time enforced by the screen and
// not the server is a restaurant that takes orders all night from anyone who
// kept a tab open. The gate is one function so that "the button is hidden" and
// "the order is refused" cannot drift apart.
//
// Pure: `now` is a parameter, and the wall-clock reading it needs is computed
// by `restaurantClock` and handed in. Nothing here reads a database or a clock.
import { formatMinuteOfDay, WEEKDAY_NAMES, type RestaurantClock } from './business-day';

/** Why ordering is off. Ordered by precedence — see `checkoutGate`. */
export type GateReason =
  | 'manually_paused'
  | 'closed_today'
  | 'outside_hours'
  | 'closing_soon'
  | 'too_busy';

/** One day's opening window, local wall-clock minutes since midnight. */
export type StoreHoursDay = {
  /** 0 = Sunday. */
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
};

/**
 * Everything the gate reads, gathered by the caller in one query.
 *
 * `openOrderCount` is the count of orders in `OPEN_STATUSES` — derived from
 * THE status module, never a hard-coded list (CLAUDE.md).
 */
export type GateState = {
  /** The manual switch. Always wins (P0-6). */
  paused: boolean;
  /** Shown instead of the default when staff set one. */
  pauseMessage: string | null;
  /** The auto-pause threshold. Ordering resumes on its own below it. */
  maxOpenOrders: number;
  openOrderCount: number;
  /** A "YYYY-MM-DD" the restaurant declared closed, or null. */
  closedOnDay: string | null;
  /** One row per open day; a missing day is a closed day. */
  hours: readonly StoreHoursDay[];
  /** New orders stop this many minutes before close (P0-6, default 15). */
  cutoffMinutes: number;
};

export type GateResult =
  | { open: true }
  | {
      open: false;
      reason: GateReason;
      /** Customer-facing, and specific enough to act on: a "closed" that does
       *  not say when to come back is a customer who does not come back. */
      message: string;
      /** True where waiting is the answer — the screen may offer to re-check.
       *  False for "we open Tuesday", where re-checking is pointless. */
      transient: boolean;
    };

const DEFAULT_PAUSE_MESSAGE =
  'We have paused new online orders for a few minutes. Please try again shortly.';

/** The window a customer can actually order in: the door closes `cutoffMinutes`
 *  before the kitchen does, so the last ticket has time to be cooked. */
export function orderingWindow(
  day: StoreHoursDay,
  cutoffMinutes: number,
): { openMinute: number; lastOrderMinute: number } {
  return { openMinute: day.openMinute, lastOrderMinute: day.closeMinute - cutoffMinutes };
}

/**
 * Is ordering open?
 *
 * Precedence is deliberate and tested:
 *
 *   1. **The manual switch first.** P0-6 says it "always overrides". Staff who
 *      hit pause because the fryer died must not be told the reason is that
 *      the store is busy — and they must not have the pause lifted by the
 *      auto-threshold dropping.
 *   2. **Then the calendar**: a closed-today override, then the weekly hours,
 *      then the pre-close cutoff. A closed restaurant is not "too busy".
 *   3. **Then the throttle.** Last, because it is the only one that clears
 *      itself, and because saying "we are slammed" to someone who arrived
 *      after closing is the wrong sentence.
 *
 * In-flight orders are unaffected by every branch here — this function is
 * asked about NEW orders and nothing else (P0-6).
 */
export function checkoutGate(state: GateState, clock: RestaurantClock): GateResult {
  if (state.paused) {
    return {
      open: false,
      reason: 'manually_paused',
      message: state.pauseMessage?.trim() || DEFAULT_PAUSE_MESSAGE,
      transient: true,
    };
  }

  const today = state.hours.find((day) => day.dayOfWeek === clock.weekday);

  if (state.closedOnDay === clock.day) {
    return {
      open: false,
      reason: 'closed_today',
      message: 'We are closed today. Online ordering opens again tomorrow.',
      transient: false,
    };
  }

  // A day with no row is a day the restaurant is shut. Absence as the closed
  // signal means a week is configured by listing the days it opens, and a
  // deleted row cannot leave a door open.
  if (!today) {
    return {
      open: false,
      reason: 'outside_hours',
      message: nextOpeningMessage(state.hours, clock),
      transient: false,
    };
  }

  const { openMinute, lastOrderMinute } = orderingWindow(today, state.cutoffMinutes);

  if (clock.minuteOfDay < openMinute) {
    return {
      open: false,
      reason: 'outside_hours',
      message: `We open at ${formatMinuteOfDay(openMinute)} today.`,
      transient: false,
    };
  }

  if (clock.minuteOfDay >= lastOrderMinute) {
    // Two different sentences, because they are two different situations: the
    // kitchen still has the lights on in the first, and does not in the
    // second. A customer told "come back tomorrow" while staff are visibly
    // inside is a customer who walks up and knocks.
    const stillOpen = clock.minuteOfDay < today.closeMinute;
    return {
      open: false,
      reason: 'closing_soon',
      message: stillOpen
        ? `We stop taking online orders at ${formatMinuteOfDay(lastOrderMinute)}, ${state.cutoffMinutes} minutes before we close. Come by the counter.`
        : nextOpeningMessage(state.hours, clock),
      transient: false,
    };
  }

  if (state.openOrderCount >= state.maxOpenOrders) {
    return {
      open: false,
      reason: 'too_busy',
      message:
        'The kitchen is at capacity right now. Ordering reopens as soon as the queue clears — try again in a few minutes.',
      transient: true,
    };
  }

  return { open: true };
}

/**
 * "We open at 11:00 on Tuesday." Walks forward from today to find the next day
 * with hours, up to a full week.
 *
 * Returns a general sentence rather than a wrong specific one when no day has
 * hours at all: a precise wrong time is worse than an honest vague one, the
 * same rule the estimate follows (P0-7).
 */
function nextOpeningMessage(hours: readonly StoreHoursDay[], clock: RestaurantClock): string {
  for (let ahead = 1; ahead <= 7; ahead += 1) {
    const weekday = (clock.weekday + ahead) % 7;
    const day = hours.find((candidate) => candidate.dayOfWeek === weekday);
    if (!day) continue;
    const when = ahead === 1 ? 'tomorrow' : `on ${WEEKDAY_NAMES[weekday]}`;
    return `We are closed right now. We open ${when} at ${formatMinuteOfDay(day.openMinute)}.`;
  }

  return 'Online ordering is closed right now.';
}
