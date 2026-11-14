// Scorecard K5 / SEC-02: the limiter counts in Postgres, so the count is
// shared by every instance and survives a restart.
import { cutoffDaysBefore, instantMinutesAfter } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { hit, LIMITS, sweepRateLimits } from './rate-limit';
import { resetDatabase } from './testing/index';

const NOW = new Date(Date.UTC(2026, 10, 13, 12, 0, 0));
const small = { limit: 3, windowMs: 60_000 };

describe('hit', () => {
  beforeEach(resetDatabase);

  it('admits up to the limit in one window, then refuses', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await hit('t:a', small, NOW));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('keeps the count in the database, not in this process', async () => {
    for (let i = 0; i < 3; i += 1) await hit('t:b', small, NOW);
    const row = await prisma.rateLimit.findFirstOrThrow({ where: { key: 't:b' } });
    expect(row.count).toBe(3);
  });

  it('counts keys separately', async () => {
    for (let i = 0; i < 3; i += 1) await hit('t:c', small, NOW);
    expect(await hit('t:c', small, NOW)).toBe(false);
    expect(await hit('t:d', small, NOW)).toBe(true);
  });

  it('starts over in the next window', async () => {
    for (let i = 0; i < 4; i += 1) await hit('t:e', small, NOW);
    expect(await hit('t:e', small, instantMinutesAfter(NOW, 1))).toBe(true);
  });

  it('loses no hit to a race: ten at once, exactly three admitted', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => hit('t:f', small, NOW)));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it('puts a limit on the kitchen passcode a person never reaches by mistake', () => {
    expect(LIMITS.staffSignInPerIp.limit).toBeLessThanOrEqual(10);
    expect(LIMITS.staffSignInPerIp.windowMs).toBeGreaterThanOrEqual(15 * 60_000);
  });
});

describe('sweepRateLimits', () => {
  beforeEach(resetDatabase);

  it('deletes windows that ended over a day ago and keeps the rest', async () => {
    await hit('t:old', small, cutoffDaysBefore(NOW, 2));
    await hit('t:new', small, NOW);
    expect(await sweepRateLimits(NOW)).toBe(1);
    expect((await prisma.rateLimit.findMany()).map((r) => r.key)).toEqual(['t:new']);
  });
});
