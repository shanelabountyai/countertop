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
import { checkoutGate, restaurantClock, type GateResult } from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';

export async function currentGate(): Promise<GateResult> {
  const state = await loadGateState();
  return checkoutGate(state, restaurantClock(new Date(), state.timezone));
}
