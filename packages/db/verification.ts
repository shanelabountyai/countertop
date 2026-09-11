// Phone verification, the database half (PRD 7 P1-1, C-115).
//
// `packages/core/loyalty/verification.ts` decides WHETHER a code should be
// issued or accepted; this file is the half that needs a random source, a
// hash and a table — the same split `phoneDigest`/`memberByPhone` and
// `staffPinDigest`/`staffByPin` already draw.
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  canAttemptVerification,
  instantMinutesAfter,
  loyaltyBalance,
  normalizePhone,
  planVerificationStart,
  VERIFY_CODE_TTL_MINUTES,
  type AttemptRefusal,
  type NormalizedPhone,
  type StartRefusal,
} from '@countertop/core';
import { hasLoyaltyPepper, phoneDigest } from './loyalty';
import { prisma } from './index';

/** Random, six digits, zero-padded — `000000` through `999999` equally
 *  likely. `randomInt` is Node's CSPRNG; `Math.random` is not. */
const sixDigitCode = (): string => randomInt(0, 1_000_000).toString().padStart(6, '0');

/** SHA-256 of the code, domain-separated by the digest it was issued to — so
 *  the same six digits landing on two different numbers do not hash equal.
 *  Not peppered: a code is random and single-use, unlike a customer-chosen
 *  phone number or PIN, so this defends the table against a casual read, not
 *  against someone who already holds it — the same honestly stated line
 *  `staffPinDigest` draws about its own constant salt. */
const codeHash = (digest: string, code: string): string =>
  createHash('sha256').update(`countertop-loyalty-verify:${digest}:${code}`).digest('hex');

/** What sending a code asks of the carrier. One seam, the same shape as
 *  `PaymentProvider` (`provider.ts`): the request on this side is real,
 *  nothing on the other side of it is. */
export type SmsVerifyProvider = (phone: NormalizedPhone, code: string) => Promise<string | null>;

/**
 * The stub, and there is no other implementation in this product — the
 * master PRD parks "real SMS" on its P2 list, unbuilt, the same way there is
 * no real payment processor behind `provider.ts`. Unlike `mockPaymentProvider`
 * this one is not a no-op: a stub has no channel back to the customer except
 * the response it is already answering, so IT RETURNS THE CODE rather than
 * merely resolving.
 *
 * THAT IS NOT A DEV-ONLY BRANCH BEHIND AN ENV VAR. `local-guard.ts` already
 * states why a variable nobody set is not a safety boundary, and the same
 * argument holds here: the boundary is this function's SIGNATURE, not a flag
 * some deploy forgot to set. The day a real provider is plugged in, it
 * returns `null` — a real send has nothing left to hand back — the caller
 * stops having a code to echo, and nothing else in this file changes.
 */
export const stubSmsVerifyProvider: SmsVerifyProvider = async (_phone, code) => code;

/** The db-only refusals, beside the ones `planVerificationStart` already
 *  names — same pattern `EnrolmentRefusal` and `RedemptionRefusal` use in
 *  `loyalty.ts`. */
export type StartFailure = StartRefusal | 'loyalty_pepper_unset' | 'phone_not_enrollable';

export type StartResult =
  | {
      ok: true;
      expiresAt: Date;
      /** What the stub "sent" — see `stubSmsVerifyProvider`. Null the day a
       *  real provider replaces it; every caller must treat a null the same
       *  as a code it never gets to see. */
      echoedCode: string | null;
    }
  | { ok: false; reason: StartFailure; message: string };

/**
 * Issue a code, or refuse to (P1-1).
 *
 * ELIGIBILITY IS CHECKED BEFORE A CODE IS EVER GENERATED — a stranger's phone
 * number is worth nothing to guess a code for unless a reward is actually
 * sitting behind it, `planVerificationStart`'s whole reason for existing.
 *
 * A NEW ROW EVERY TIME, never an update to a prior one. `confirmPhoneVerification`
 * only ever reads the newest row for a digest, so an old unconsumed code
 * simply stops being compared against — a resend needs no separate
 * "invalidate" step.
 */
export async function startPhoneVerification(
  phone: string,
  now: Date,
  provider: SmsVerifyProvider = stubSmsVerifyProvider,
): Promise<StartResult> {
  if (!hasLoyaltyPepper()) {
    return refuseStart('loyalty_pepper_unset', 'The loyalty program is not configured.');
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return refuseStart('phone_not_enrollable', 'That does not look like a phone number.');
  }

  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: {
      loyaltyEnabled: true,
      pointsPerDollar: true,
      rewardThresholdPoints: true,
      rewardValueCents: true,
    },
  });

  const digest = phoneDigest(normalized.digits);
  const member = await prisma.loyaltyMember.findUnique({
    where: { phoneDigest: digest },
    select: { events: { select: { kind: true, points: true } } },
  });

  const plan = planVerificationStart({
    enabled: settings.loyaltyEnabled,
    isMember: member !== null,
    balance: member ? loyaltyBalance(member.events) : 0,
    terms: settings,
  });
  if (!plan.ok) return refuseStart(plan.reason, plan.message);

  const code = sixDigitCode();
  const expiresAt = instantMinutesAfter(now, VERIFY_CODE_TTL_MINUTES);
  await prisma.phoneVerification.create({
    data: { phoneDigest: digest, codeHash: codeHash(digest, code), expiresAt, createdAt: now },
  });

  const echoedCode = await provider(normalized, code);
  return { ok: true, expiresAt, echoedCode };
}

const refuseStart = (reason: StartFailure, message: string): StartResult => ({
  ok: false,
  reason,
  message,
});

export type ConfirmFailure = AttemptRefusal | 'code_mismatch' | 'loyalty_pepper_unset' | 'phone_not_enrollable';

export type ConfirmResult = { ok: true } | { ok: false; reason: ConfirmFailure; message: string };

/**
 * Spend one guess against the newest code issued to a number (P1-1).
 *
 * `canAttemptVerification` IS CHECKED BEFORE THE HASH COMPARISON, so a guess
 * that could not possibly succeed — expired, already used, over the cap —
 * never reaches `timingSafeEqual` and never increments `attempts` a second
 * time for the same reason it was already dead.
 *
 * ONLY A WRONG GUESS MOVES `attempts`. A correct one sets `consumedAt`
 * instead, which is what actually blocks reuse — counting it too would be
 * bookkeeping nothing reads.
 */
export async function confirmPhoneVerification(
  phone: string,
  code: string,
  now: Date,
): Promise<ConfirmResult> {
  if (!hasLoyaltyPepper()) {
    return refuseConfirm('loyalty_pepper_unset', 'The loyalty program is not configured.');
  }
  const normalized = normalizePhone(phone);
  if (!normalized) {
    return refuseConfirm('phone_not_enrollable', 'That does not look like a phone number.');
  }
  const digest = phoneDigest(normalized.digits);

  const row = await prisma.phoneVerification.findFirst({
    where: { phoneDigest: digest },
    orderBy: { createdAt: 'desc' },
  });

  const attempt = canAttemptVerification(row, now);
  if (!attempt.ok) return refuseConfirm(attempt.reason, attempt.message);
  // Non-null here: `canAttemptVerification`'s only null-row refusal
  // (`not_requested`) already returned above.
  const found = row!;

  const presented = Buffer.from(codeHash(digest, code), 'hex');
  const expected = Buffer.from(found.codeHash, 'hex');
  // Length first: `timingSafeEqual` throws on a mismatch rather than
  // returning false. Both are fixed-length SHA-256 hex, so this never
  // actually differs, but the guard is the same one `staffIdFromStamp` keeps
  // for the same reason — a malformed value must not become a 500.
  const matches = presented.length === expected.length && timingSafeEqual(presented, expected);

  await prisma.phoneVerification.update({
    where: { id: found.id },
    data: matches ? { consumedAt: now } : { attempts: { increment: 1 } },
  });

  if (!matches) return refuseConfirm('code_mismatch', 'That code is not correct.');
  return { ok: true };
}

const refuseConfirm = (reason: ConfirmFailure, message: string): ConfirmResult => ({
  ok: false,
  reason,
  message,
});
