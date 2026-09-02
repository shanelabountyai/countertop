// The checkout gate's read side (P0-6).
//
// Gathers what `checkoutGate` needs and hands it over. The decision is not
// made here — it is made once, in `packages/core/orders/checkout-gate.ts`, so
// that the screen that hides the button and the writer that refuses the row
// cannot disagree.
//
// The open WEIGHT comes from `OPEN_STATUSES`, which is derived from THE status
// module. A status list spelled out here is exactly the defect the "one status
// module" rule exists to prevent (CLAUDE.md).
//
// Weight rather than a count since P1-7: `Order.prepWeight` is the work the
// order was snapshotted as, so this sum is arithmetic on the orders' own
// copied numbers and never joins back to a menu row.
import {
  businessDayOf,
  OPEN_STATUSES,
  type EstimateState,
  type GateState,
} from '@countertop/core';
import { prisma } from './index';
import { hasLoyaltyPepper, type LoyaltyOffer } from './loyalty';

/** Settings, hours and the open prep weight in one round trip.
 *
 *  Carries the tax rate and timezone too, so placement reads config ONCE
 *  rather than asking two queries the same question — and the P0-7 estimate's
 *  two numbers, because the estimate is computed from the SAME open weight the
 *  throttle reads. Two queries would let the checkout say "we are at capacity"
 *  and quote a ten-minute wait off a queue read a moment apart. */
export async function loadGateState(
  /** The instant the count is taken as of. Passed in, never read here — it is
   *  what decides which orders are TODAY's (CLAUDE.md time rules). */
  now: Date,
): Promise<
  GateState & EstimateState & { timezone: string; taxRatePpm: number; loyalty: LoyaltyOffer }
> {
  const [settings, hours] = await Promise.all([
    // Throws rather than defaulting, like `loadSettings`: a missing settings
    // row must not become an accidentally wide-open restaurant.
    prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'singleton' } }),
    prisma.storeHours.findMany({ orderBy: { dayOfWeek: 'asc' } }),
  ]);

  // Serialised after the settings read rather than folded into the Promise.all
  // above, because the sum now needs the restaurant's own calendar to know
  // which orders are today's. The warning in this file's header is about two
  // separate READS — the gate and the estimate still share exactly one, which
  // is the property that matters.
  const today = businessDayOf(now, settings.timezone);
  const open = await prisma.order.aggregate({
    _sum: { prepWeight: true },
    where: {
      status: { in: [...OPEN_STATUSES] },
      // The negation of `isLeftOver`, in the one dialect Prisma speaks (P1-6).
      // A `preparing` row somebody forgot to tap on Tuesday is not work the
      // kitchen owes: summed in, it inflates every quoted wait and can hold the
      // P0-6 auto-pause closed forever. The kitchen queue still shows it,
      // flagged, which is where it gets closed out.
      businessDay: { gte: today },
    },
  });

  return {
    timezone: settings.timezone,
    taxRatePpm: settings.taxRatePpm,
    paused: settings.ordersPaused,
    pauseMessage: settings.pauseMessage,
    maxOpenWeight: settings.maxOpenWeight,
    // `_sum` is null over zero rows, which is an empty queue and weighs 0.
    openWeight: open._sum.prepWeight ?? 0,
    closedOnDay: settings.closedOnDay,
    hours: hours.map((day) => ({
      dayOfWeek: day.dayOfWeek,
      openMinute: day.openMinute,
      closeMinute: day.closeMinute,
    })),
    // The loyalty offer rides on the SAME settings read, for the reason this
    // file's header gives about the tax rate: the checkout screen that decides
    // whether to render the enrolment checkbox and the writer that decides
    // whether to create the member must be looking at one row, not two reads
    // of it (PRD 7 P0-1 — with the program off, nothing renders anywhere).
    loyalty: {
      // A program switched on with no pepper cannot enrol anybody, so the
      // screen must not offer it. `enrolMember` checks the same pair.
      offered: settings.loyaltyEnabled && hasLoyaltyPepper(),
      terms: {
        pointsPerDollar: settings.pointsPerDollar,
        rewardThresholdPoints: settings.rewardThresholdPoints,
        rewardValueCents: settings.rewardValueCents,
      },
      expiryDays: settings.loyaltyExpiryDays,
    },
    cutoffMinutes: settings.cutoffMinutes,
    prepBaseMinutes: settings.prepBaseMinutes,
    prepPerWeightMinutes: settings.prepPerWeightMinutes,
  };
}
