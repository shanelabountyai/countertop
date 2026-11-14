// The request side of rate limiting (scorecard K5, SEC-02). The counting and
// the limits live in `packages/db/rate-limit.ts`; this only names the caller.
//
// NODE ONLY (reads `next/headers`). The client address is the first entry of
// `x-forwarded-for`, which the deployment platform sets from the connection
// rather than passing a client's value through; locally there is none, and
// every request shares the "local" bucket.
import { headers } from 'next/headers';
import { hit, LIMITS } from '@countertop/db/rate-limit';

export type LimitName = keyof typeof LIMITS;

export async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || h.get('x-real-ip')?.trim() || 'local';
}

/** Counts one hit for this caller against `name`. False means refuse.
 *  `subject` adds a second dimension (a phone digest) when the limit has one. */
export async function allow(name: LimitName, subject?: string): Promise<boolean> {
  const who = subject ?? `ip:${await clientIp()}`;
  return hit(`${name}:${who}`, LIMITS[name], new Date());
}
