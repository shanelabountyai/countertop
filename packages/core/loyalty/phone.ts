// A member is a phone number (PRD 7 P0-1, C-101).
//
// PURE, and it is the reason enrolment can be keyed on a value customers type
// four different ways. `(555) 010-2233`, `555-010-2233`, `+1 555 010 2233` and
// `5550102233` are one person, and if they were not, the punch card would
// quietly hand the same customer three separate balances and nobody would ever
// see it happen — a duplicate member has no symptom.
//
// ONE FUNCTION, THREE CALL SITES, the same discipline the orderability rule
// gets: the checkbox that decides whether enrolment is even offered, the write
// that creates the member, and the counter lookup that finds them again all
// ask this. A form that enabled its checkbox on a looser rule than the writer
// accepts is a customer ticking a box that does nothing.

/** A phone reduced to the only thing that identifies it, plus the four digits
 *  a person can confirm out loud. Never stored together: `digits` is what gets
 *  hashed and thrown away, `last4` is what the counter sees. */
export type NormalizedPhone = {
  /** Ten digits, no punctuation, no country code. What the digest is taken of. */
  digits: string;
  /** The last four, in clear. Four digits is not an identifier. */
  last4: string;
};

/**
 * The typed number, or null if it cannot key a membership.
 *
 * ponytail: NANP only — ten digits, with an optional leading 1 that is
 * dropped. A number outside it (a `+44`, an extension, a half-typed one) is
 * not enrollable and the checkbox stays disabled rather than the enrolment
 * failing invisibly after the order is placed. The order itself is unaffected:
 * `Order.customerPhone` keeps whatever was typed, because that field is for a
 * human to ring back and has never had a format rule. Upgrade path if the
 * restaurant ever needs it is a real E.164 parser, which is a dependency and
 * not a regex.
 *
 * Rejecting rather than truncating matters: eleven digits that do NOT start
 * with 1 is a typo, and silently keeping the last ten of it would enrol
 * somebody else's phone number.
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) return null;
  return { digits: local, last4: local.slice(-4) };
}

/** Whether a typed phone can key a membership at all. The checkbox's enable
 *  rule, spelled once so it cannot drift from the writer's. */
export const isEnrollablePhone = (raw: string | null | undefined): boolean =>
  normalizePhone(raw) !== null;
