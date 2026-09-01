// Staff authentication for /kitchen (C-037).
//
// One shared passcode, no accounts. P0 has no staff-accounts requirement and
// the write-up has named this the first thing a real deployment needs since
// C-008: a screen on the wall behind the till does not want a per-cook login,
// it wants the queue to be unreachable from the internet.
//
// The cookie carries no authority of its own — it is a digest of the passcode.
// Rotating STAFF_PASSCODE therefore invalidates every session ever issued, and
// there is no session table, no expiry sweep, and no second secret to keep in
// step with the first.
//
// `crypto.subtle` rather than `node:crypto` because this module is imported by
// BOTH the edge middleware and a Node server action; only one of them has the
// Node builtin, and both have the Web Crypto global.
//
// FOR THE SAME REASON, nothing about who is on shift lives here (C-086). That
// code needs the database and `node:crypto`, and C-086 briefly put a wrapper
// for it in this file — which pulled both into the middleware bundle and took
// the whole /kitchen route down with `Native module not found: node:crypto`.
// The comment above had already said why. `lib/shift.ts` is the Node-only home
// for it; this module stays edge-safe and knows only the passcode.

export const STAFF_COOKIE = 'ct_staff';

/** A shift, not a session. A tablet rebooted overnight should come back signed
 *  in; the revocation mechanism is rotating the passcode, not waiting. */
export const STAFF_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Unset means LOCKED, never open.
 *
 * A deploy that forgets the variable loses its queue screen and says so on the
 * login page. The alternative — a development default — is the version that
 * ships a passcode everyone already knows to production, which is the failure
 * this item exists to remove.
 */
export const staffPasscode = (): string => process.env.STAFF_PASSCODE ?? '';

/** The cookie's value, and the comparand for a typed passcode. Salted, so the
 *  stored token is not a bare SHA-256 of a six-character word. */
export async function staffToken(passcode: string): Promise<string> {
  const bytes = new TextEncoder().encode(`countertop-staff:${passcode}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Constant-time. Both arguments are digests of the same fixed length, so an
 *  early return on the first differing character leaks how much of a guess was
 *  right — which is exactly the oracle an offline attacker wants. */
export function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The one question the middleware asks. */
export async function isStaff(cookieValue: string | undefined): Promise<boolean> {
  const passcode = staffPasscode();
  if (passcode === '' || cookieValue === undefined) return false;
  return sameToken(cookieValue, await staffToken(passcode));
}

/**
 * Where a login may send someone afterwards.
 *
 * The `next` parameter is a redirect target supplied by whoever crafted the
 * link, which makes it a trust boundary: anything that is not a path under
 * /kitchen falls back to the queue rather than becoming an open redirect.
 */
export function safeNext(next: string | undefined): string {
  return next !== undefined && /^\/kitchen(\/|$|\?)/.test(next) ? next : '/kitchen';
}
