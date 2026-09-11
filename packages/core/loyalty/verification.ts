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
