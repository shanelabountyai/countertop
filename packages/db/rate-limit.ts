// Rate limiting in Postgres (scorecard K5, SEC-02).
//
// Fixed-window counters: one row per (key, window), incremented by a single
// atomic upsert, so two requests racing on the same key cannot both read a
// stale count. In the database rather than in process memory because the
// deployment is serverless: a counter in memory resets on every cold start
// and is per-instance, which is no limit at all.
//
// `now` is a parameter, like everywhere else in this package; the caller reads
// the clock once. ponytail: a fixed window lets up to twice the limit through
// across a window edge. Switch to a sliding window if that burst ever matters.
import { cutoffDaysBefore } from '@countertop/core';
import { prisma } from './index';

export type Limit = { limit: number; windowMs: number };

const MINUTES = 60_000;

/** Every public limit, in one place. Generous for a person, tight for a
 *  script. Keys are namespaced by the caller (`signin:ip:…`). */
export const LIMITS = {
  /** The kitchen's shared passcode. A guesser gets ten tries a quarter hour. */
  staffSignInPerIp: { limit: 10, windowMs: 15 * MINUTES },
  /** Each start sends (well, will send) a text: cap it per caller and per phone. */
  verifyStartPerIp: { limit: 10, windowMs: 15 * MINUTES },
  verifyStartPerPhone: { limit: 5, windowMs: 15 * MINUTES },
  /** Guesses are already capped per code; this caps them per caller across codes. */
  verifyConfirmPerIp: { limit: 20, windowMs: 15 * MINUTES },
  /** Placement. A lunch run from one office is a handful; a flood is not. */
  placementPerIp: { limit: 120, windowMs: 15 * MINUTES },
  /** Anonymous reads of /status/[token]. */
  statusReadPerIp: { limit: 300, windowMs: 15 * MINUTES },
} as const satisfies Record<string, Limit>;

/** The instant the fixed window containing `now` began. Epoch arithmetic
 *  through `Date.UTC`'s millisecond field (it normalises the overflow), so no
 *  calendar and no process timezone is involved. */
const windowStartFor = (now: Date, windowMs: number): Date =>
  new Date(Date.UTC(1970, 0, 1, 0, 0, 0, Math.floor(now.getTime() / windowMs) * windowMs));

/** Counts one hit against `key`. True when the hit is within the limit. */
export async function hit(key: string, { limit, windowMs }: Limit, now: Date): Promise<boolean> {
  const windowStart = windowStartFor(now, windowMs);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key", "windowStart", "count") VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT ("key", "windowStart") DO UPDATE SET "count" = "RateLimit"."count" + 1
    RETURNING "count"`;
  return Number(rows[0]?.count ?? Number.POSITIVE_INFINITY) <= limit;
}

/** Deletes counters whose window ended over a day ago; nothing reads them. */
export async function sweepRateLimits(now: Date): Promise<number> {
  const { count } = await prisma.rateLimit.deleteMany({
    where: { windowStart: { lt: cutoffDaysBefore(now, 1) } },
  });
  return count;
}
