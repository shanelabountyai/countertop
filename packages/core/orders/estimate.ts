// THE ready-time estimate (P0-7).
//
// Configurable base prep time plus a per-open-WEIGHT increment (P1-7), widened
// into a
// RANGE and rounded to something a human would say out loud. One function, so
// the checkout and the status page cannot promise different times for the same
// queue.
//
// Two rules, both from the PRD and both about honesty rather than accuracy:
//
//   * **A range, never a point.** "20 min" is wrong at 21; "15–25 min" is not.
//     Accuracy is explicitly not a P0 metric — existence and recalculation
//     are — so the estimate's job is to be defensible, not precise.
//   * **No estimate while ordering is shut.** That rule lives at the call
//     site, because it is the same decision as "show the pause message":
//     the checkout renders the gate notice INSTEAD of this. A screen that
//     showed both would be promising a time for an order it will not take.
//
// Pure: the weight comes in as a number, nothing here reads a clock or a
// database. It is summed over OPEN_STATUSES by the caller — the same number
// the auto-pause threshold reads, so "busy" means one thing.

/** What the estimate is computed from. Both minute values are settings. */
export type EstimateState = {
  /** Minutes for a ticket with an empty queue in front of it. */
  prepBaseMinutes: number;
  /**
   * Added per unit of open prep weight (P1-7). Weight rather than orders,
   * because the queue ahead of you is work, not tickets: four bottled waters
   * used to add four minutes to everyone else's quote.
   */
  prepPerWeightMinutes: number;
  /** Summed `prepWeight` of the orders in OPEN_STATUSES right now. */
  openWeight: number;
};

export type ReadyEstimate = {
  lowMinutes: number;
  highMinutes: number;
  /** "15–25 min", with an en dash — the only string any screen should print. */
  label: string;
};

/** How wide the honest range is, and what it rounds to. Constants rather than
 *  settings: a restaurant tunes how LONG food takes (P0-7's two configurable
 *  numbers), not how vague we are about it. */
const RANGE_MINUTES = 10;
const STEP_MINUTES = 5;

/** The one place a range becomes the string a screen prints. Both estimates
 *  below go through it, so the checkout and the status page cannot disagree
 *  about what a range looks like. */
const range = (lowMinutes: number, highMinutes: number): ReadyEstimate => ({
  lowMinutes,
  highMinutes,
  label: `${lowMinutes}–${highMinutes} min`,
});

export function readyEstimate(state: EstimateState): ReadyEstimate {
  const centre =
    state.prepBaseMinutes + state.prepPerWeightMinutes * Math.max(0, state.openWeight);

  // Round DOWN to the step, then add the width: the low end is the promise a
  // customer hears, so it must not drift later than the arithmetic says. A
  // floor of one step keeps a misconfigured zero from reading as "now".
  const lowMinutes = Math.max(STEP_MINUTES, Math.floor(centre / STEP_MINUTES) * STEP_MINUTES);

  return range(lowMinutes, lowMinutes + RANGE_MINUTES);
}

/**
 * The same estimate, seen from INSIDE the queue (P0-7, the C-014 status page).
 *
 * The checkout answers "how long if I order now?"; a customer who already
 * ordered is asking "how much longer?", and the honest answer is the same
 * window with the time already spent taken off it. Recomputed on every poll,
 * so a queue that got busier moves it out — which is the point of showing a
 * range rather than a countdown to a fixed clock time.
 *
 * Null once the low end reaches zero: we are INSIDE the window now, and the
 * caller says "any minute" instead. A range that shrinks to "0–10 min" and
 * then goes negative is the precise wrong number P0-7 forbids.
 */
export function remainingEstimate(
  estimate: ReadyEstimate,
  elapsedMinutes: number,
): ReadyEstimate | null {
  const spent = Math.max(0, elapsedMinutes);
  const lowMinutes = estimate.lowMinutes - spent;
  return lowMinutes <= 0 ? null : range(lowMinutes, estimate.highMinutes - spent);
}
