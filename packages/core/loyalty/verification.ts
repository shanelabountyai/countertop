// Phone verification (PRD 7 P1-1, C-115).
//
// THE GAP THIS CLOSES: C-113 shipped SMS as a one-way stub — an outbox row,
// no reply channel, no code to confirm against. Self-serve redemption at
// checkout needs the opposite of that: proof that whoever is typing a phone
// number at checkout actually controls it, because nobody is standing at the
// counter to catch a lie the way P0-4's staff-attended redemption does. This
// module is that proof's rulebook — a one-time code, a short window, a capped
// number of guesses.
//
// PURE, like every other module here: it takes a row's own fields and `now`
// and returns a decision. No clock, no database, no crypto — the code itself
// is random and the hash comparison needs `node:crypto`, so both live in
// `packages/db/verification.ts` where every other secret-handling function in
// this codebase already lives (`staffPinDigest`, `phoneDigest`). What belongs
// here is only the arithmetic: is this code still usable, and is this phone
// even eligible for one.

import { hasReward, type LoyaltyTerms } from './ledger';

/** How long a code is good for. Short on purpose — this is a checkout-time
 *  proof, not a magic link somebody might open tomorrow. */
export const VERIFY_CODE_TTL_MINUTES = 5;

/** Guesses allowed against one code before it is dead regardless of the
 *  clock. A six-digit space is a million-to-one per guess; five guesses
 *  keeps a stolen phone number from being brute-forced in the same checkout
 *  session it was typed into. */
export const VERIFY_MAX_ATTEMPTS = 5;

/** Enough of a `PhoneVerification` row to judge an attempt against. A
 *  database row satisfies this structurally, same convention as
 *  `LedgerEntry`. */
export type VerificationRow = {
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
};

export type AttemptRefusal = 'not_requested' | 'already_used' | 'too_many_attempts' | 'expired';

export type AttemptDecision = { ok: true } | { ok: false; reason: AttemptRefusal; message: string };

/**
 * Whether a submitted code is even worth hashing and comparing.
 *
 * CHECKED BEFORE THE COMPARISON, deliberately, and in this order:
 * "already used" and "too many attempts" are checked ahead of "expired" so a
 * code that is dead for one of those reasons reports that reason and not a
 * mismatched clock's — a code that hit its attempt cap one second before it
 * would have expired anyway should tell the customer why it stopped working.
 *
 * `attempts >= VERIFY_MAX_ATTEMPTS` is checked here, before the caller does
 * any hashing — a guess that cannot possibly succeed must not still count as
 * one more data point for whoever is guessing. `packages/db` increments the
 * counter AFTER this returns ok, never before.
 */
export function canAttemptVerification(row: VerificationRow | null, now: Date): AttemptDecision {
  if (!row) return refuseAttempt('not_requested', 'No code was requested for this number.');
  if (row.consumedAt) return refuseAttempt('already_used', 'That code has already been used.');
  if (row.attempts >= VERIFY_MAX_ATTEMPTS) {
    return refuseAttempt('too_many_attempts', 'Too many attempts. Request a new code.');
  }
  if (row.expiresAt <= now) {
    return refuseAttempt('expired', 'That code has expired. Request a new one.');
  }
  return { ok: true };
}

const refuseAttempt = (reason: AttemptRefusal, message: string): AttemptDecision => ({
  ok: false,
  reason,
  message,
});

export type StartRefusal = 'loyalty_disabled' | 'not_a_member' | 'no_reward_available';

export type StartDecision = { ok: true } | { ok: false; reason: StartRefusal; message: string };

/**
 * Whether a code should be issued at all (P1-1's fraud guard, restated for
 * self-serve). A stranger's phone number is worth nothing to guess a code
 * for unless a reward is actually sitting behind it — so this refuses BEFORE
 * a code is generated, not after, the same "refused by name, never silently
 * degraded" discipline `planRedemption` applies to spending one.
 *
 * `isMember` and `balance` arrive from the caller's own lookup rather than
 * being resolved here, for the same reason `planRedemption` takes a balance
 * rather than a member id: this file reads no database.
 */
export function planVerificationStart(input: {
  enabled: boolean;
  isMember: boolean;
  balance: number;
  terms: LoyaltyTerms;
}): StartDecision {
  const { enabled, isMember, balance, terms } = input;
  if (!enabled) return refuseStart('loyalty_disabled', 'The loyalty program is switched off.');
  if (!isMember) return refuseStart('not_a_member', 'That number is not on the punch card.');
  if (!hasReward(balance, terms)) {
    return refuseStart('no_reward_available', 'No reward is available on that number yet.');
  }
  return { ok: true };
}

const refuseStart = (reason: StartRefusal, message: string): StartDecision => ({
  ok: false,
  reason,
  message,
});

// --- The checkout bearer token (C-116) --------------------------------------
//
// A confirmed code proves a phone at ONE instant. Checkout needs that proof to
// survive a few more form fields and a submit — but PRD 7's own resolved
// Non-Goal rules out a "remembered device", and this codebase has no session
// or cookie to hang one on anyway. So the proof travels as a bearer token the
// CLIENT holds and resends with its placement, scoped to one checkout attempt
// the same way `newStatusToken` is scoped to one order: bound to the
// `idempotencyKey` that attempt already carries, so it cannot be replayed onto
// a different order, and short-lived, so it is not a login.

/** How long a confirmed verification stays usable for placement. Longer than
 *  the code's own five minutes — a customer still has a name, a note and a
 *  payment method to get through — but still a checkout-attempt window, not a
 *  day. */
export const VERIFY_TOKEN_TTL_MINUTES = 10;

export type TokenRefusal = 'wrong_order' | 'phone_mismatch' | 'expired';

export type TokenDecision = { ok: true } | { ok: false; reason: TokenRefusal; message: string };

/**
 * Whether an already-signature-checked token proves THIS phone for THIS
 * placement attempt right now. The signature itself is `packages/db`'s job
 * (it needs the pepper and `timingSafeEqual`); this is the arithmetic on top
 * of it, same split as `canAttemptVerification`.
 *
 * CHECKED IN THIS ORDER: a token minted for a different checkout attempt is
 * refused before a phone mismatch is even considered, and both are checked
 * before expiry — a token bound to the wrong order did not become usable by
 * outliving its clock.
 */
export function canUseVerifiedToken(input: {
  tokenIdempotencyKey: string;
  idempotencyKey: string;
  tokenPhoneDigest: string;
  phoneDigest: string;
  /** Epoch milliseconds, not a `Date` — the token carries a bare number
   *  (it has to, to be part of a signed string) and turning it into a `Date`
   *  buys this comparison nothing that `.getTime()` does not already give
   *  it. */
  expiresAtMs: number;
  now: Date;
}): TokenDecision {
  const { tokenIdempotencyKey, idempotencyKey, tokenPhoneDigest, phoneDigest, expiresAtMs, now } =
    input;
  if (tokenIdempotencyKey !== idempotencyKey) {
    return refuseToken('wrong_order', 'That verification was for a different order.');
  }
  if (tokenPhoneDigest !== phoneDigest) {
    return refuseToken('phone_mismatch', 'That verification was for a different phone number.');
  }
  if (expiresAtMs <= now.getTime()) {
    return refuseToken('expired', 'That verification has expired. Verify again.');
  }
  return { ok: true };
}

const refuseToken = (reason: TokenRefusal, message: string): TokenDecision => ({
  ok: false,
  reason,
  message,
});
