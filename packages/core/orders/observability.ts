// What a placement writes to the log (C-084, PRD 6 P0-1).
//
// PURE, and that is the whole design. When an order goes missing at 7:10pm the
// product could not previously distinguish "never placed" from "placed and
// eaten", because it wrote no line anywhere. The fix needs a sink — one
// `console.log` at the boundary — but the part worth testing is not the sink.
// It is the DECISION about what a line contains, and far more importantly what
// it must never contain, and that is a function with tests.
//
// NO PII, STRUCTURALLY. The input type below has no field for a customer name,
// a phone number or a status token, so a caller cannot put one in a line by
// accident. The single free-text channel — a thrown error's message — is
// allow-listed rather than trusted, because a Prisma error is perfectly
// capable of quoting the row it choked on. Correlation is by idempotency key
// and order id, which are the two identifiers a support question can be
// answered from and neither of which is a person.
import type { CartReview } from '../cart/cart';
import { checkClientTotal, type TotalMismatch } from '../pricing/pricing';
import type { GateReason } from './checkout-gate';

/** How a placement attempt ended. Exhaustive: every exit from the boundary is
 *  one of these three, which is what makes "every outcome is logged" a claim
 *  the compiler helps keep rather than a habit. */
export type PlacementOutcome =
  | { result: 'placed'; orderId: string; replayed: boolean }
  | {
      result: 'refused';
      /** Every refusal kind at once, not the first — the same reason checkout
       *  reports every bad line at once. */
      errorKinds: readonly string[];
      /** Present only when the checkout gate was one of the refusals, so
       *  "the pause bounced eleven orders during the fryer outage" is a
       *  countable number rather than somebody's memory. */
      gateReason?: GateReason | null;
    }
  | { result: 'threw'; errorName: string; message: string };

/**
 * What happened to the enrolment the customer ticked a box for (PRD 7 P0-1,
 * C-101). A CLOSED SET OF NAMES, never free text and never a phone number —
 * the whole reason it is a union and not a message.
 *
 * Logged at all because every value here except `enrolled` is silent to the
 * customer: they ticked a box, the order succeeded, and nothing on the receipt
 * says the punch card did not happen. `loyalty_pepper_unset` in particular is
 * a deploy that switched the program on and forgot the secret, which has no
 * other symptom whatsoever.
 */
export type EnrolmentLogOutcome =
  | 'enrolled'
  | 'loyalty_disabled'
  | 'loyalty_pepper_unset'
  | 'phone_not_enrollable'
  | 'enrolment_threw';

export type PlacementLogInput = {
  /** The instant, passed in like every other instant in this package. */
  at: Date;
  /** The correlation id. It is already unique per checkout attempt and it is
   *  already the key support would be given; it is not a person. */
  idempotencyKey: string;
  outcome: PlacementOutcome;
  /** P0-2's evidence, when there is any. See `totalTampering`. */
  mismatch?: TotalMismatch | null;
  /** Absent unless the customer asked to join (PRD 7 P0-1). */
  enrolment?: EnrolmentLogOutcome | null;
};

/**
 * The throws this boundary actually expects, whose text IS the value of the
 * line: `priceLine` refuses an unknown id rather than pricing it as zero, and
 * the id is the entire diagnostic. Anything else — a Prisma error, a socket
 * error — can quote a value nobody has vetted, so its message is withheld and
 * only its class is logged. A withheld message is a worse log line than a
 * leaked customer phone number is a defect.
 */
const SAFE_THROW_MESSAGES = [
  /^Unknown (?:item|modifier group|option): [\w-]{1,64}$/,
  /^Subtotal (?:must be integer cents|cannot be negative), got -?\d{1,12}$/,
];

const isSafeMessage = (message: string): boolean =>
  SAFE_THROW_MESSAGES.some((pattern) => pattern.test(message));

/** One log line, as a plain object ready for `JSON.stringify`. */
export type PlacementLogLine = Record<string, string | number | boolean | readonly string[]>;

/**
 * Build the line.
 *
 * `at` is an ISO instant, deliberately — a log line is read by machines and by
 * whoever is awake, and neither wants it bucketed into the restaurant's
 * calendar. The business-day questions are the report's job and the report
 * reads the database, not this.
 */
export function placementLogLine(input: PlacementLogInput): PlacementLogLine {
  const line: PlacementLogLine = {
    event: 'placement',
    at: input.at.toISOString(),
    key: input.idempotencyKey,
    result: input.outcome.result,
  };

  switch (input.outcome.result) {
    case 'placed':
      line.orderId = input.outcome.orderId;
      line.replayed = input.outcome.replayed;
      break;
    case 'refused':
      line.refusals = [...input.outcome.errorKinds];
      if (input.outcome.gateReason) line.gateReason = input.outcome.gateReason;
      break;
    case 'threw':
      line.errorName = input.outcome.errorName;
      if (isSafeMessage(input.outcome.message)) line.message = input.outcome.message;
      else line.messageWithheld = true;
      break;
  }

  // Recorded on EVERY outcome it exists for, which is the half of this that
  // was a defect: the mismatch used to be computed inside the write path, so
  // a request that tampered with the total and also failed validation was
  // recorded nowhere at all.
  if (input.mismatch) {
    line.clientTotalCents = input.mismatch.clientTotalCents;
    line.serverTotalCents = input.mismatch.serverTotalCents;
  }

  // One word, from a closed set. There is no channel here for the phone
  // number that enrolment is about — the type has no field for it, which is
  // the same structural no-PII guarantee the rest of this line has.
  if (input.enrolment) line.enrolment = input.enrolment;

  return line;
}

/**
 * Is the client's total evidence of tampering, or just a stale screen?
 *
 * The server's number is the answer either way (P0-2) — this only decides
 * whether the difference is worth recording. A cart with a line that needs
 * fixing prices only the lines that still price; a cart whose price moved is a
 * customer looking at an older number for an honest reason; and a cart that
 * emptied in another tab prices nothing at all while the screen still shows a
 * total. In every one of those a "mismatch" is noise, and a log full of noise
 * is a log nobody reads. What is left is a client claiming a different number
 * for a composition the server prices cleanly, which is the thing worth seeing.
 *
 * `placeable` is exactly that question and the cart already answers it —
 * `lines.length > 0 && !needsFix && !needsPriceConfirmation`. This function
 * first spelled the condition out itself and dropped the empty-cart clause,
 * which put a false `clientTotalCents: 1185 / serverTotalCents: 0` line in the
 * log the day the logging shipped. Ask the review; do not re-derive it.
 */
export function totalTampering(
  review: Pick<CartReview, 'totals' | 'placeable'>,
  clientTotalCents: number | undefined,
): TotalMismatch | null {
  if (clientTotalCents === undefined) return null;
  if (!review.placeable) return null;
  return checkClientTotal(review.totals.totalCents, clientTotalCents);
}
