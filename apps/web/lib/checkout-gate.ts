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
  checkoutGate,
  readyEstimate,
  restaurantClock,
  type GateResult,
  type ReadyEstimate,
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
}> {
  // Read once, here, and passed down — the weight of today's open orders and
  // the wall-clock reading the gate compares hours against are the same
  // instant's answers (CLAUDE.md time rules).
  const now = new Date();
  const state = await loadGateState(now);
  return {
    gate: checkoutGate(state, restaurantClock(now, state.timezone)),
    estimate: readyEstimate(state),
    loyalty: state.loyalty,
  };
}

export async function currentGate(): Promise<GateResult> {
  return (await currentCheckout()).gate;
}
