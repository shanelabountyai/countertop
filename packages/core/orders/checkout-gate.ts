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
import {
  formatMinuteOfDay,
  previousDay,
  WEEKDAY_NAMES,
  type RestaurantClock,
} from './business-day';

/** Why ordering is off. Ordered by precedence — see `checkoutGate`. */
export type GateReason =
  | 'manually_paused'
  | 'closed_today'
  | 'outside_hours'
  | 'closing_soon'
  | 'too_busy';

/** One day's opening window, local wall-clock minutes since midnight. A close
 *  at or before the open runs past midnight into the next day (C-141), and
 *  the window belongs to the day it OPENS — the rule C-140 set for dayparts. */
export type StoreHoursDay = {
  /** 0 = Sunday. */
  dayOfWeek: number;
  openMinute: number;
  closeMinute: number;
};

/** The opening `clock` is in or waiting on, measured from TODAY's midnight: an
 *  overnight close lands past 1440, and yesterday's opening, still running
 *  after midnight, opens below 0. `day` is the calendar day it opened on. */
type Opening = { row: StoreHoursDay; day: string; openMinute: number; closeMinute: number };

function currentOpening(
  state: Pick<GateState, 'hours' | 'closedOnDay'>,
  clock: RestaurantClock,
): Opening | null {
  const now = clock.minuteOfDay;
  const today = state.hours.find((day) => day.dayOfWeek === clock.weekday);
  const todays = today && {
    row: today,
    day: clock.day,
    openMinute: today.openMinute,
    closeMinute: today.closeMinute + (today.closeMinute <= today.openMinute ? 1440 : 0),
  };
  // Today's own opening first, if it is running: where yesterday's spill and
  // today's opening overlap, the later one is the one whose cutoff matters.
  if (todays && now >= todays.openMinute && now < todays.closeMinute) return todays;

  // Yesterday's, still running past midnight — unless yesterday was closed with
  // the override, which must not reopen the door at 00:00 for a shift nobody
  // is working.
  const yesterday = state.hours.find((day) => day.dayOfWeek === (clock.weekday + 6) % 7);
  const yesterdayDay = previousDay(clock.day);
  if (
    yesterday &&
    yesterday.closeMinute <= yesterday.openMinute &&
    now < yesterday.closeMinute &&
    state.closedOnDay !== yesterdayDay
  ) {
    return {
      row: yesterday,
      day: yesterdayDay,
      openMinute: yesterday.openMinute - 1440,
      closeMinute: yesterday.closeMinute,
    };
  }

  return todays ?? null;
}

/**
 * The calendar day the opening now running started on (C-141) — today, except
 * after midnight in an overnight shift, when it is yesterday.
 *
 * The boundary `isLeftOver` and the open-weight sum draw at: Friday's 23:55
 * ticket is still Friday's service at 00:30 Saturday, so it must keep chiming
 * and keep counting toward the throttle. It is also the `businessDay` an ASAP
 * order is stamped with (C-142), so a 00:30 order inside that shift is
 * Friday's next number and sits on Friday's report row.
 */
export function serviceDay(
  state: Pick<GateState, 'hours' | 'closedOnDay'>,
  clock: RestaurantClock,
): string {
  return currentOpening(state, clock)?.day ?? clock.day;
}

/** A minute measured from today's midnight, back on the wall clock. 1440 stays
 *  "24:00" — the end of the day, as a close has always been written. */
function wallMinute(minute: number): number {
  if (minute < 0) return minute + 1440;
  if (minute > 1440) return minute - 1440;
  return minute;
}

/**
 * Everything the gate reads, gathered by the caller in one query.
 *
 * `openWeight` is the summed `prepWeight` of the orders in `OPEN_STATUSES` —
 * derived from THE status module, never a hard-coded list (CLAUDE.md).
 *
 * Weight, not a count, since P1-7: ten bottled waters are not ten fajita
 * plates, and a threshold that could not tell them apart shut the door on the
 * easy queue and held it open on the impossible one.
 */
export type GateState = {
  /** The manual switch. Always wins (P0-6). */
  paused: boolean;
  /** Shown instead of the default when staff set one. */
  pauseMessage: string | null;
  /** The auto-pause threshold, in prep weight. Ordering resumes below it. */
  maxOpenWeight: number;
  openWeight: number;
  /** A "YYYY-MM-DD" the restaurant declared closed, or null. */
  closedOnDay: string | null;
  /** One row per open day; a missing day is a closed day. */
  hours: readonly StoreHoursDay[];
  /** New orders stop this many minutes before close (P0-6, default 15). */
  cutoffMinutes: number;
};

export type GateResult =
  | {
      open: true;
      /** Today's cutoff, local minutes since midnight — carried out of
       *  `orderingWindow` rather than thrown away (PRD 5 P0-3). */
      lastOrderMinute: number;
      /** ...and how far off it is, measured HERE against the same wall-clock
       *  reading the hours were compared against. A screen subtracting it from
       *  its own idea of `now` would be a second answer to the question this
       *  function exists to answer once — and the two would disagree across a
       *  minute boundary. Always >= 1: at 0 the gate is closed. */
      minutesUntilLastOrder: number;
    }
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
 *  before the kitchen does, so the last ticket has time to be cooked. Measured
 *  from the opening day's midnight, so an overnight day's last order is past
 *  1440 (C-141). */
export function orderingWindow(
  day: StoreHoursDay,
  cutoffMinutes: number,
): { openMinute: number; lastOrderMinute: number } {
  const close = day.closeMinute + (day.closeMinute <= day.openMinute ? 1440 : 0);
  return { openMinute: day.openMinute, lastOrderMinute: close - cutoffMinutes };
}

/**
 * Today's opening hours, in the words a customer reads in the footer
 * (PRD 5 P0-1).
 *
 * The SAME `hours` rows and the SAME closed-today override the gate reads,
 * taken from the SAME `GateState` — the acceptance criterion is that the
 * footer's answer about today matches the gate's, and the only way to keep two
 * answers identical is to stop there being two. This is a wording of that
 * state, not a second reading of it.
 *
 * It deliberately says nothing about the CUTOFF or the pause switch. Those
 * decide whether an order can be placed; these are the hours the door is
 * open, which is what somebody looking up an address wants to know — and the
 * gate notice is already on the screen saying the other thing when it applies.
 */
export function todaysHours(
  state: Pick<GateState, 'hours' | 'closedOnDay'>,
  clock: RestaurantClock,
): string {
  // A closed-today override and a day with no row are the same sentence: both
  // mean nobody is opening the door, and a footer is the wrong place to
  // explain which kind of closed it is.
  if (state.closedOnDay === clock.day) return 'Closed today';
  // The opening the gate is judging against — so at 01:00 inside Friday's
  // 22:00–02:00, the footer says that, not Saturday's "Closed today" (C-141).
  const opening = currentOpening(state, clock);
  if (!opening) return 'Closed today';
  // 1440 formats as "24:00" — midnight at the END of the day (see `saveHours`).
  return `${formatMinuteOfDay(opening.row.openMinute)}–${formatMinuteOfDay(opening.row.closeMinute)}`;
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

  // The override closes TODAY's calendar date — the one the button can write —
  // including yesterday's shift still running past midnight: staff who press
  // "closed today" at 01:00 mean now.
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
  const opening = currentOpening(state, clock);
  if (!opening) {
    return {
      open: false,
      reason: 'outside_hours',
      message: nextOpeningMessage(state.hours, clock),
      transient: false,
    };
  }

  // Minutes from today's midnight, so both ends of an overnight shift compare
  // against `minuteOfDay` directly; `wallMinute` puts them back for display.
  const { openMinute, closeMinute } = opening;
  const lastOrderMinute = closeMinute - state.cutoffMinutes;

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
    const stillOpen = clock.minuteOfDay < closeMinute;
    return {
      open: false,
      reason: 'closing_soon',
      message: stillOpen
        ? `We stop taking online orders at ${formatMinuteOfDay(wallMinute(lastOrderMinute))}, ${state.cutoffMinutes} minutes before we close. Come by the counter.`
        : nextOpeningMessage(state.hours, clock),
      transient: false,
    };
  }

  if (state.openWeight >= state.maxOpenWeight) {
    return {
      open: false,
      reason: 'too_busy',
      message:
        'The kitchen is at capacity right now. Ordering reopens as soon as the queue clears — try again in a few minutes.',
      transient: true,
    };
  }

  return {
    open: true,
    lastOrderMinute: wallMinute(lastOrderMinute),
    minutesUntilLastOrder: lastOrderMinute - clock.minuteOfDay,
  };
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
