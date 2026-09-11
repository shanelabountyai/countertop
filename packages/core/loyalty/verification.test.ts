// PRD 7 P1-1 (C-115, C-116). The database suite proves the hashing and the
// generated-code mechanics; this proves the arithmetic every one of those
// mechanisms is built on top of.
import { describe, expect, it } from 'vitest';
import { instantMinutesAfter } from '../orders/business-day';
import type { LoyaltyTerms } from './ledger';
import {
  canAttemptVerification,
  canUseVerifiedToken,
  planVerificationStart,
  VERIFY_CODE_TTL_MINUTES,
  VERIFY_MAX_ATTEMPTS,
  VERIFY_TOKEN_TTL_MINUTES,
  type VerificationRow,
} from './verification';

const TERMS: LoyaltyTerms = {
  pointsPerDollar: 1,
  rewardThresholdPoints: 100,
  rewardValueCents: 1000,
};

const NOW = new Date(Date.UTC(2026, 6, 5, 12, 0, 0));
const row = (overrides: Partial<VerificationRow> = {}): VerificationRow => ({
  expiresAt: instantMinutesAfter(NOW, VERIFY_CODE_TTL_MINUTES),
  attempts: 0,
  consumedAt: null,
  ...overrides,
});

describe('canAttemptVerification', () => {
  it('allows a fresh, unexpired, unconsumed row under the attempt cap', () => {
    expect(canAttemptVerification(row(), NOW)).toEqual({ ok: true });
  });

  it('refuses by name when nothing was ever requested', () => {
    const result = canAttemptVerification(null, NOW);
    expect(result).toMatchObject({ ok: false, reason: 'not_requested' });
  });

  it('refuses a row already consumed, even if it has not expired', () => {
    const result = canAttemptVerification(row({ consumedAt: NOW }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'already_used' });
  });

  it('refuses at the attempt cap, one guess before the code would have failed anyway', () => {
    const result = canAttemptVerification(row({ attempts: VERIFY_MAX_ATTEMPTS }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'too_many_attempts' });
  });

  it('allows the last attempt exactly at the cap minus one', () => {
    expect(canAttemptVerification(row({ attempts: VERIFY_MAX_ATTEMPTS - 1 }), NOW)).toEqual({
      ok: true,
    });
  });

  it('refuses a row past its expiry', () => {
    const result = canAttemptVerification(row({ expiresAt: NOW }), NOW);
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('prefers the attempt-cap reason over expiry when both are true', () => {
    const result = canAttemptVerification(
      row({ attempts: VERIFY_MAX_ATTEMPTS, expiresAt: NOW }),
      NOW,
    );
    expect(result).toMatchObject({ reason: 'too_many_attempts' });
  });

  it('prefers already-used over an expired clock', () => {
    const result = canAttemptVerification(row({ consumedAt: NOW, expiresAt: NOW }), NOW);
    expect(result).toMatchObject({ reason: 'already_used' });
  });
});

describe('planVerificationStart', () => {
  const eligible = { enabled: true, isMember: true, balance: 100, terms: TERMS };

  it('issues when the program is on, the phone is a member, and a reward is available', () => {
    expect(planVerificationStart(eligible)).toEqual({ ok: true });
  });

  it('refuses by name when the program is switched off', () => {
    const result = planVerificationStart({ ...eligible, enabled: false });
    expect(result).toMatchObject({ reason: 'loyalty_disabled' });
  });

  it('refuses a phone with no membership behind it', () => {
    const result = planVerificationStart({ ...eligible, isMember: false });
    expect(result).toMatchObject({ reason: 'not_a_member' });
  });

  it('refuses a member one point short of a reward — no code for nothing to spend', () => {
    const result = planVerificationStart({ ...eligible, balance: 99 });
    expect(result).toMatchObject({ reason: 'no_reward_available' });
  });

  it('issues at exactly the threshold', () => {
    expect(planVerificationStart({ ...eligible, balance: 100 })).toEqual({ ok: true });
  });
});

describe('canUseVerifiedToken (C-116)', () => {
  const bound = {
    tokenIdempotencyKey: 'attempt-1',
    idempotencyKey: 'attempt-1',
    tokenPhoneDigest: 'digest-a',
    phoneDigest: 'digest-a',
    expiresAtMs: instantMinutesAfter(NOW, VERIFY_TOKEN_TTL_MINUTES).getTime(),
    now: NOW,
  };

  it('allows a token bound to this order, this phone, and not yet expired', () => {
    expect(canUseVerifiedToken(bound)).toEqual({ ok: true });
  });

  it('refuses a token minted for a different checkout attempt', () => {
    const result = canUseVerifiedToken({ ...bound, tokenIdempotencyKey: 'attempt-2' });
    expect(result).toMatchObject({ ok: false, reason: 'wrong_order' });
  });

  it('refuses a token that proves a different phone', () => {
    const result = canUseVerifiedToken({ ...bound, tokenPhoneDigest: 'digest-b' });
    expect(result).toMatchObject({ ok: false, reason: 'phone_mismatch' });
  });

  it('refuses an expired token', () => {
    const result = canUseVerifiedToken({ ...bound, expiresAtMs: NOW.getTime() });
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('prefers the wrong-order reason over a phone mismatch when both are true', () => {
    const result = canUseVerifiedToken({
      ...bound,
      tokenIdempotencyKey: 'attempt-2',
      tokenPhoneDigest: 'digest-b',
    });
    expect(result).toMatchObject({ reason: 'wrong_order' });
  });

  it('prefers a phone mismatch over expiry when both are true', () => {
    const result = canUseVerifiedToken({
      ...bound,
      tokenPhoneDigest: 'digest-b',
      expiresAtMs: NOW.getTime(),
    });
    expect(result).toMatchObject({ reason: 'phone_mismatch' });
  });
});
