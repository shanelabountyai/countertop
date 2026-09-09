// A cookie remembering a few recent status tokens (PRD 5 P1-1 / C-082).
//
// Not a lookup surface (Non-Goals: no lookup by name/phone/number) — the
// token is still the only key, and this cookie is just this browser
// remembering a few it was already handed. Nothing new is stored
// server-side (`Order` has no new column for this).
//
// Session cookie, same idiom as `cart-session.ts`: no maxAge, so a stale
// token does not outlive the visit. The strip on `/menu` filters by
// `isTerminal` anyway, so even a token that outlives its order just stops
// rendering rather than pointing at a receipt that no longer moves.
import { cookies } from 'next/headers';

const COOKIE = 'ct_recent_orders';
const MAX_TOKENS = 5;

export async function readRecentOrderTokens(): Promise<string[]> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((t) => typeof t === 'string') ? parsed : [];
  } catch {
    return [];
  }
}

/** Called once per successful placement. Idempotent by construction: a replay
 *  of the same idempotency key hands back the same token (invariant 5), and
 *  the `includes` check below means appending it again is a no-op, not a
 *  second entry. */
export async function rememberOrder(token: string): Promise<void> {
  const existing = await readRecentOrderTokens();
  if (existing.includes(token)) return;
  const tokens = [...existing, token].slice(-MAX_TOKENS);
  (await cookies()).set(COOKIE, JSON.stringify(tokens), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
}
