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

// ---------------------------------------------------------------------------
// Were we honest? (P1-4)
//
// Everything above PROMISES. Everything below GRADES the promise, by comparing
// what an order was quoted at placement against when the kitchen actually
// called it ready — and it can only do that because the quote is SNAPSHOTTED
// on the order (C-042). Recomputing an old order's estimate from today's
// settings and today's queue would grade this afternoon's arithmetic against
// this afternoon's arithmetic and always score full marks.
//
// Pure, like the rest of this file: the samples arrive as data, already
// resolved to minutes by the caller that owns the clock.
// ---------------------------------------------------------------------------

/** One order that was quoted and reached `ready`. */
export type QuoteSample = {
  quotedLowMinutes: number;
  quotedHighMinutes: number;
  /** Open prep weight at the moment of placement — the queue that was in front
   *  of it. Without this the report can say the quotes are wrong but not WHICH
   *  of the two settings is wrong, which is the whole of P1-4. */
  quotedOpenWeight: number;
  /** `placedAt` → the `ready` transition, in minutes. */
  actualMinutes: number;
};

export type AccuracyGroup = {
  samples: number;
  /** Ready before the low end. Not a success: a customer told "15–25" and
   *  handed a bag at 6 minutes waited 9 minutes longer than they had to. */
  early: number;
  onTime: number;
  late: number;
  /**
   * Median signed minutes OUTSIDE the quoted window — 0 for an order inside
   * it, negative early, positive late. Null with no samples, for the same
   * reason the no-show rate is (C-016): an average over nothing is unknown,
   * and a screen printing "0 min out" says something false.
   *
   * The MEDIAN, not the mean: one order that sat on the pass for two hours
   * because nobody tapped it is a data-entry story, not a prep-time story, and
   * a mean lets it rewrite the setting.
   */
  medianMissMinutes: number | null;
};

/** Which of the P0-7 settings to move, and which way. Data, not a sentence —
 *  the screen writes the words, this file decides the fact. */
export type QuoteAdjustment = {
  setting: 'prepBaseMinutes' | 'prepPerWeightMinutes';
  direction: 'up' | 'down';
};

export type EstimateAccuracy = {
  all: AccuracyGroup;
  /** The half of the samples placed against the LIGHTER queue, split at the
   *  median open weight. */
  lightQueue: AccuracyGroup;
  busyQueue: AccuracyGroup;
  /** Null when the quotes hold up, or when there is not enough evidence to
   *  say. Both are "change nothing", and the screen distinguishes them by
   *  looking at `all.samples`. */
  suggestion: QuoteAdjustment | null;
};

/** Below this, no suggestion at all. A restaurant's first four orders of the
 *  week must not retune its prep time, and "we do not know yet" is a real
 *  answer that this project prefers to a confident wrong one. */
const MIN_SAMPLES = 10;

/** How far outside the window the median has to sit before it is worth acting
 *  on. One STEP, because the estimate is rounded to steps: a miss smaller than
 *  the rounding is not a number anyone can tune against. */
const ACTIONABLE_MINUTES = STEP_MINUTES;

/** Signed minutes outside the window. Inside is 0 — a range's whole point is
 *  that anywhere in it is right, so grading against its centre would score a
 *  correct quote as a miss. */
const missMinutes = (sample: QuoteSample): number =>
  sample.actualMinutes < sample.quotedLowMinutes
    ? sample.actualMinutes - sample.quotedLowMinutes
    : Math.max(0, sample.actualMinutes - sample.quotedHighMinutes);

/** Even counts average the two middles. Sorted here rather than trusted: the
 *  caller orders by placement time, which has nothing to do with this. */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function group(samples: readonly QuoteSample[]): AccuracyGroup {
  const misses = samples.map(missMinutes);
  return {
    samples: samples.length,
    early: misses.filter((miss) => miss < 0).length,
    onTime: misses.filter((miss) => miss === 0).length,
    late: misses.filter((miss) => miss > 0).length,
    medianMissMinutes: median(misses),
  };
}

/**
 * Grade the quotes, and name the setting to move (P1-4).
 *
 * The diagnosis is a comparison, not a regression: split the samples at the
 * median open weight and ask whether the busy half missed WORSE than the light
 * half. If it did, the per-weight increment is too small — the quotes degrade
 * as the queue grows. If both halves miss the same way, the queue is not the
 * variable and the base prep time is simply wrong.
 *
 * ponytail: a two-parameter least-squares fit over (openWeight, actual) would
 * name both numbers at once instead of one. Skipped — thirty orders across a
 * narrow band of queue depths is not enough to fit two parameters against, and
 * a suggestion that swings every service is worse than none. The upgrade path
 * is the fit, on the same samples, once a real restaurant has months of them.
 */
export function estimateAccuracy(samples: readonly QuoteSample[]): EstimateAccuracy {
  const byQueue = [...samples].sort((a, b) => a.quotedOpenWeight - b.quotedOpenWeight);
  const half = Math.floor(byQueue.length / 2);
  const all = group(byQueue);
  // The odd sample out goes to the busy half, where the interesting failure
  // is. With fewer than MIN_SAMPLES nothing is suggested anyway.
  const lightQueue = group(byQueue.slice(0, half));
  const busyQueue = group(byQueue.slice(half));

  return { all, lightQueue, busyQueue, suggestion: suggest(all, lightQueue, busyQueue) };
}

function suggest(
  all: AccuracyGroup,
  lightQueue: AccuracyGroup,
  busyQueue: AccuracyGroup,
): QuoteAdjustment | null {
  const miss = all.medianMissMinutes;
  if (all.samples < MIN_SAMPLES || miss === null) return null;
  if (Math.abs(miss) < ACTIONABLE_MINUTES) return null;

  const light = Math.abs(lightQueue.medianMissMinutes ?? 0);
  const busy = Math.abs(busyQueue.medianMissMinutes ?? 0);
  return {
    // Only when the busy half is worse by a whole step: a queue-shaped error
    // is the one the per-weight number exists to absorb. Anything flatter than
    // that is a base that is wrong at every depth.
    setting: busy - light >= ACTIONABLE_MINUTES ? 'prepPerWeightMinutes' : 'prepBaseMinutes',
    direction: miss > 0 ? 'up' : 'down',
  };
}
