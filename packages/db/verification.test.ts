// What the DATABASE does with a phone-verification code (PRD 7 P1-1, C-115).
//
// The core suite proves `canAttemptVerification` and `planVerificationStart`'s
// arithmetic; these prove the mechanisms built on top of it — hashing,
// randomness, and reading the newest row for a digest.
import { instantMinutesAfter, VERIFY_MAX_ATTEMPTS } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { enrolMember } from './loyalty';
import { prisma } from './index';
import { resetDatabase, seedSettings } from './testing/index';
import {
  confirmPhoneVerification,
  startPhoneVerification,
  stubSmsVerifyProvider,
  type SmsVerifyProvider,
} from './verification';

const NOW = new Date(Date.UTC(2026, 6, 5, 12, 0, 0));
const PHONE = '5550102233';

/** A member with exactly one reward available (decision 9's threshold is 100
 *  points), so `startPhoneVerification` has something to say yes to. */
async function enrolledMemberWithReward(): Promise<void> {
  await seedSettings({ loyaltyEnabled: true });
  const enrolled = await enrolMember({ phone: PHONE, displayName: 'Ivy', now: NOW });
  if (!enrolled.ok) throw new Error('setup: enrolment failed');
  await prisma.loyaltyEvent.create({
    data: { memberId: enrolled.memberId, at: NOW, kind: 'earn', points: 100 },
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe('starting a verification', () => {
  it('issues a code and the stub echoes it back', async () => {
    await enrolledMemberWithReward();
    const result = await startPhoneVerification(PHONE, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.echoedCode).toMatch(/^\d{6}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());

    const row = await prisma.phoneVerification.findFirstOrThrow();
    // Never the code itself, hashed or not confusable with it.
    expect(row.codeHash).not.toBe(result.echoedCode);
    expect(row.attempts).toBe(0);
    expect(row.consumedAt).toBeNull();
  });

  it('a real provider returns null, and nothing is echoed', async () => {
    await enrolledMemberWithReward();
    const silent: SmsVerifyProvider = async () => null;
    const result = await startPhoneVerification(PHONE, NOW, silent);
    expect(result).toMatchObject({ ok: true, echoedCode: null });
  });

  it('refuses by name with the program off', async () => {
    await seedSettings({ loyaltyEnabled: false });
    const result = await startPhoneVerification(PHONE, NOW);
    expect(result).toMatchObject({ ok: false, reason: 'loyalty_disabled' });
    expect(await prisma.phoneVerification.count()).toBe(0);
  });

  it('refuses a number with no membership behind it — no code for a stranger', async () => {
    await seedSettings({ loyaltyEnabled: true });
    const result = await startPhoneVerification(PHONE, NOW);
    expect(result).toMatchObject({ ok: false, reason: 'not_a_member' });
    expect(await prisma.phoneVerification.count()).toBe(0);
  });

  it('refuses a member with a balance short of a reward', async () => {
    await seedSettings({ loyaltyEnabled: true });
    const enrolled = await enrolMember({ phone: PHONE, displayName: 'Ivy', now: NOW });
    if (!enrolled.ok) throw new Error('setup');
    await prisma.loyaltyEvent.create({
      data: { memberId: enrolled.memberId, at: NOW, kind: 'earn', points: 40 },
    });
    const result = await startPhoneVerification(PHONE, NOW);
    expect(result).toMatchObject({ ok: false, reason: 'no_reward_available' });
    expect(await prisma.phoneVerification.count()).toBe(0);
  });

  it('refuses with no pepper configured, and hashes nothing under an empty key', async () => {
    await enrolledMemberWithReward();
    const pepper = process.env.LOYALTY_PHONE_PEPPER;
    delete process.env.LOYALTY_PHONE_PEPPER;
    try {
      const result = await startPhoneVerification(PHONE, NOW);
      expect(result).toMatchObject({ ok: false, reason: 'loyalty_pepper_unset' });
    } finally {
      process.env.LOYALTY_PHONE_PEPPER = pepper;
    }
    expect(await prisma.phoneVerification.count()).toBe(0);
  });

  it('a resend is a second row, and does not disturb the first', async () => {
    await enrolledMemberWithReward();
    const first = await startPhoneVerification(PHONE, NOW);
    const second = await startPhoneVerification(PHONE, NOW);
    expect(await prisma.phoneVerification.count()).toBe(2);
    if (!first.ok || !second.ok) throw new Error('setup');
    expect(first.echoedCode).not.toBeNull();
    expect(second.echoedCode).not.toBeNull();
  });
});

describe('confirming a verification', () => {
  async function issuedCode(): Promise<string> {
    await enrolledMemberWithReward();
    const started = await startPhoneVerification(PHONE, NOW);
    if (!started.ok || !started.echoedCode) throw new Error('setup: no code issued');
    return started.echoedCode;
  }

  it('accepts the right code and consumes the row', async () => {
    const code = await issuedCode();
    const result = await confirmPhoneVerification(PHONE, code, NOW);
    expect(result).toEqual({ ok: true });

    const row = await prisma.phoneVerification.findFirstOrThrow();
    expect(row.consumedAt).not.toBeNull();
    expect(row.attempts).toBe(0);
  });

  it('refuses a wrong code and counts it as an attempt, not a success', async () => {
    await issuedCode();
    const result = await confirmPhoneVerification(PHONE, '000000', NOW);
    expect(result).toMatchObject({ ok: false, reason: 'code_mismatch' });

    const row = await prisma.phoneVerification.findFirstOrThrow();
    expect(row.attempts).toBe(1);
    expect(row.consumedAt).toBeNull();
  });

  it('refuses reuse of a code already consumed', async () => {
    const code = await issuedCode();
    await confirmPhoneVerification(PHONE, code, NOW);
    const second = await confirmPhoneVerification(PHONE, code, NOW);
    expect(second).toMatchObject({ ok: false, reason: 'already_used' });
  });

  it('locks out after the attempt cap, even with the right code left untried', async () => {
    const code = await issuedCode();
    for (let i = 0; i < VERIFY_MAX_ATTEMPTS; i++) {
      const result = await confirmPhoneVerification(PHONE, '000000', NOW);
      expect(result).toMatchObject({ reason: 'code_mismatch' });
    }
    const locked = await confirmPhoneVerification(PHONE, code, NOW);
    expect(locked).toMatchObject({ ok: false, reason: 'too_many_attempts' });
  });

  it('refuses an expired code', async () => {
    const code = await issuedCode();
    const later = instantMinutesAfter(NOW, 6);
    const result = await confirmPhoneVerification(PHONE, code, later);
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses a number that never requested a code', async () => {
    await seedSettings({ loyaltyEnabled: true });
    const result = await confirmPhoneVerification(PHONE, '123456', NOW);
    expect(result).toMatchObject({ ok: false, reason: 'not_requested' });
  });

  it('only ever compares against the NEWEST code for a number', async () => {
    await enrolledMemberWithReward();
    const first = await startPhoneVerification(PHONE, NOW);
    const second = await startPhoneVerification(PHONE, NOW);
    if (!first.ok || !second.ok || !first.echoedCode || !second.echoedCode) {
      throw new Error('setup');
    }
    expect(first.echoedCode).not.toBe(second.echoedCode);

    // The first code, now stale, no longer works — even though its row is
    // still sitting there unconsumed and unexpired.
    const staleAttempt = await confirmPhoneVerification(PHONE, first.echoedCode, NOW);
    expect(staleAttempt).toMatchObject({ ok: false, reason: 'code_mismatch' });

    const freshAttempt = await confirmPhoneVerification(PHONE, second.echoedCode, NOW);
    expect(freshAttempt).toEqual({ ok: true });
  });
});

describe('the stub provider', () => {
  it('is the code itself, not a reference to it', async () => {
    const phone = { digits: PHONE, last4: '2233' };
    await expect(stubSmsVerifyProvider(phone, '482911')).resolves.toBe('482911');
  });
});
