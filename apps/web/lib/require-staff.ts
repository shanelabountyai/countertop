// The staff check, repeated at every kitchen entry point (SEC-04, scorecard K3).
//
// `middleware.ts` is still the first line: it is what sends a browser to the
// login page. This is the second, and it exists because a route-layer matcher
// is only as good as the routing layer. A server action is addressed by its id,
// not by the path it was rendered on, and a middleware bug or bypass would
// leave every kitchen write behind nothing at all. So each kitchen page, route
// handler and `'use server'` export asks the same question again, server-side,
// from the cookie, before it touches the database.
//
// NODE ONLY (it reads `next/headers`). The decision itself is
// `staffCookieGeneration` in `staff-auth.ts`, the same function the middleware
// calls, so the two layers cannot disagree about what "signed in" means.
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { STAFF_COOKIE, staffCookieGeneration } from './staff-auth';

/** True when this request carries a staff cookie for the current passcode or
 *  the one being rotated away from (C-158). Unset passcode is always false. */
export async function isStaffRequest(): Promise<boolean> {
  const cookie = (await cookies()).get(STAFF_COOKIE)?.value;
  return (await staffCookieGeneration(cookie)) !== null;
}

/** For server actions: refuse, loudly, rather than run the write. */
export async function requireStaff(): Promise<void> {
  if (!(await isStaffRequest())) throw new Error('Not signed in.');
}

/** For kitchen pages: a person who navigated is sent to the login page. */
export async function requireStaffPage(next: string): Promise<void> {
  if (!(await isStaffRequest())) redirect(`/kitchen/login?next=${encodeURIComponent(next)}`);
}

/** For kitchen route handlers: null when signed in, else the 401 to return. */
export async function staffRouteRefusal(): Promise<Response | null> {
  return (await isStaffRequest()) ? null : new Response('Not signed in.', { status: 401 });
}
