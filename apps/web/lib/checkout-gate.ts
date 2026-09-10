// The web layer's single call into THE checkout gate (P0-6).
//
// Three screens ask "can an order be placed right now?" — the cart, the
// checkout page, and the kitchen's pause switch reporting what it just did.
// They all come through here, and `placeOrder` asks the same
// `checkoutGate` on the server side of the POST. One answer, four askers.
//
// This is also the only place in the request path that reads a clock for the
// gate: `restaurantClock` converts the instant to the restaurant's wall time,
// and everything below it takes that reading as a parameter.
//
// Server-only by construction rather than by the `server-only` package: it
// imports Prisma, which does not survive a client bundle.
import {
  availableSlots,
  checkoutGate,
  readyEstimate,
  restaurantClock,
  type GateResult,
  type ReadyEstimate,
  type ScheduleResult,
} from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import type { LoyaltyOffer } from '@countertop/db/loyalty';

/** The gate and the P0-7 estimate, off ONE read of the queue.
 *
 *  They are asked together because they are the same question answered two
 *  ways — "are we taking orders?" and "how long if we are?" — and both read
 *  the same open prep weight. Two separate loads could quote a wait off a
 *  queue the throttle had already moved past. */
export async function currentCheckout(): Promise<{
  gate: GateResult;
  estimate: ReadyEstimate;
  /** The punch card, as configured (PRD 7 P0-1). Off by default, and off means
   *  no loyalty copy renders on any screen — which is why it comes from the
   *  same read as the gate rather than from a second query the checkout page
   *  would have to remember to make. */
  loyalty: LoyaltyOffer;
  /** P1-2's sibling gate — null when the feature is off, which renders no
   *  slot picker anywhere, the same invisibility rule `loyalty` follows. */
  schedule: ScheduleResult | null;
  /** So a reader of a scheduled order's `requestedFor` (an instant) can word
   *  it in the restaurant's own wall-clock time, the way every other minute
   *  on these screens is worded (CLAUDE.md time rules) — never the visitor's
   *  browser zone, which is a fact about their device and not about pickup. */
  timezone: string;
}> {
  // Read once, here, and passed down — the weight of today's open orders and
  // the wall-clock reading the gate compares hours against are the same
  // instant's answers (CLAUDE.md time rules).
  const now = new Date();
  const state = await loadGateState(now);
  const clock = restaurantClock(now, state.timezone);
  return {
    gate: checkoutGate(state, clock),
    estimate: readyEstimate(state),
    loyalty: state.loyalty,
    schedule: state.scheduledOrdersEnabled
      ? availableSlots(state, state.scheduleConfig, state.weightBySlot, clock)
      : null,
    timezone: state.timezone,
  };
}

export async function currentGate(): Promise<GateResult> {
  return (await currentCheckout()).gate;
}
