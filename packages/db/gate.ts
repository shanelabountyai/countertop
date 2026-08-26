// The checkout gate's read side (P0-6).
//
// Gathers what `checkoutGate` needs and hands it over. The decision is not
// made here — it is made once, in `packages/core/orders/checkout-gate.ts`, so
// that the screen that hides the button and the writer that refuses the row
// cannot disagree.
//
// The open-order count comes from `OPEN_STATUSES`, which is derived from THE
// status module. A status list spelled out here is exactly the defect the
// "one status module" rule exists to prevent (CLAUDE.md).
import { OPEN_STATUSES, type EstimateState, type GateState } from '@countertop/core';
import { prisma } from './index';

/** Settings, hours and the open-order count in one round trip.
 *
 *  Carries the tax rate and timezone too, so placement reads config ONCE
 *  rather than asking two queries the same question — and the P0-7 estimate's
 *  two numbers, because the estimate is computed from the SAME open-order
 *  count the throttle reads. Two queries would let the checkout say "we are at
 *  capacity" and quote a ten-minute wait off a count taken a moment apart. */
export async function loadGateState(): Promise<
  GateState & EstimateState & { timezone: string; taxRatePpm: number }
> {
  const [settings, hours, openOrderCount] = await Promise.all([
    // Throws rather than defaulting, like `loadSettings`: a missing settings
    // row must not become an accidentally wide-open restaurant.
    prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'singleton' } }),
    prisma.storeHours.findMany({ orderBy: { dayOfWeek: 'asc' } }),
    prisma.order.count({ where: { status: { in: [...OPEN_STATUSES] } } }),
  ]);

  return {
    timezone: settings.timezone,
    taxRatePpm: settings.taxRatePpm,
    paused: settings.ordersPaused,
    pauseMessage: settings.pauseMessage,
    maxOpenOrders: settings.maxOpenOrders,
    openOrderCount,
    closedOnDay: settings.closedOnDay,
    hours: hours.map((day) => ({
      dayOfWeek: day.dayOfWeek,
      openMinute: day.openMinute,
      closeMinute: day.closeMinute,
    })),
    cutoffMinutes: settings.cutoffMinutes,
    prepBaseMinutes: settings.prepBaseMinutes,
    prepPerOrderMinutes: settings.prepPerOrderMinutes,
  };
}
