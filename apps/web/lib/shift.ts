// Who is on shift, on this tablet (C-086).
//
// NODE ONLY, and that is load-bearing rather than incidental. This module
// reaches the database and `node:crypto`; `lib/staff-auth.ts` is imported by
// the EDGE middleware and therefore may touch neither. C-086 first put a thin
// wrapper for the shift cookie in that file and took every /kitchen route down
// with `Native module not found: node:crypto` — the comment at the top of it
// had already said exactly why. Nothing here may be imported from there.
//
// The cookie is read HERE and nowhere else, so "how do we know who tapped
// that?" has one answer. Every staff write on the kitchen's screens gets its
// id from `currentShiftId()`; nothing takes a staff id as an argument from a
// request, because a staff id that arrives in a form field is a staff id
// anybody can type.
import { cookies } from 'next/headers';
import { shiftStamp, staffById, staffIdFromStamp, type StaffIdentity } from '@countertop/db/staff';
import { staffPasscode } from './staff-auth';

export const ON_SHIFT_COOKIE = 'ct_shift';

/** A shift, like the passcode cookie, and for the same reason: a tablet
 *  rebooted mid-service should come back with the same person on it. Ending
 *  the shift is a button, not a timeout. */
export const ON_SHIFT_COOKIE_MAX_AGE = 60 * 60 * 16;

/**
 * The cookie's value, and the reader that verifies it.
 *
 * The crypto lives in `packages/db/staff.ts` — where the unit suite is — and
 * the secret lives in `staff-auth.ts`, which owns `STAFF_PASSCODE`. Keying the
 * stamp on the passcode means rotating it ends every shift as well as every
 * session: the correct blast radius, and no second secret to keep in step with
 * the first.
 */
export const shiftCookieValue = (staffId: string): string =>
  shiftStamp(staffId, staffPasscode());

/**
 * The id to stamp on this write, or null.
 *
 * Null is a first-class answer, not a failure: a tablet nobody has signed on
 * to still has to take orders off the pass. What it must never do is guess —
 * an unattributed row is honest, and a wrong name is not.
 */
export async function currentShiftId(): Promise<string | null> {
  const cookie = (await cookies()).get(ON_SHIFT_COOKIE)?.value;
  return staffIdFromStamp(cookie, staffPasscode());
}

/** The same person, with their name, for the header that shows who is on. One
 *  extra read per queue render; the queue is already several. */
export async function currentShift(): Promise<StaffIdentity | null> {
  const id = await currentShiftId();
  if (id === null) return null;
  // A cookie can outlive the row it names — someone deleted, a database
  // restored from before they were added. Verified against the table rather
  // than trusted, so a stale cookie shows "nobody" instead of a dangling id.
  return staffById(id);
}
