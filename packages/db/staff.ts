// Who is on shift (PRD 6 P0-2, C-086).
//
// NOT an accounts module. There is no login here, no session, no roles and no
// permissions — the shared passcode (C-037) is still the only authentication
// boundary, and everyone behind it sees the same buttons. All this does is
// turn four digits into a name, so the append-only log can say which of the
// three people behind the passcode wrote a row.
import { createHash, timingSafeEqual } from 'node:crypto';
import { prisma } from './index';

/** Enough to stamp a row and draw a header. Never the digest. */
export type StaffIdentity = { id: string; name: string };

/**
 * The PIN, hashed.
 *
 * Salted like the passcode's digest, and for the same small reason: the stored
 * value should not be a bare SHA-256 of "1234", which is in every rainbow
 * table ever built.
 *
 * BE HONEST ABOUT WHAT THIS BUYS. Four digits is 10,000 possibilities and the
 * salt is a constant, so anybody holding the table can recover every PIN in
 * under a second. That is acceptable only because the PIN is a STAMP and not a
 * credential: the passcode is the boundary, whoever can type a PIN is already
 * through it, and anyone with this table already has every order in the
 * restaurant. The hash keeps the digits out of a casual `SELECT *` and out of
 * a backup; it is not a defence, and the schema's CHECK says the same thing.
 */
export const staffPinDigest = (pin: string): string =>
  createHash('sha256').update(`countertop-staff-pin:${pin}`).digest('hex');

/** Four digits, nothing else. The form is a numeric keypad; this is the rule. */
export const isStaffPin = (pin: string): boolean => /^\d{4}$/.test(pin);

/**
 * Resolve a typed PIN to a person, or null.
 *
 * By digest, so the plaintext never reaches a `where`. Deactivated staff do
 * not resolve — someone who has left cannot start a shift — but their rows
 * keep their name, which is why `active` is a flag and not a delete.
 */
export async function staffByPin(pin: string): Promise<StaffIdentity | null> {
  if (!isStaffPin(pin)) return null;
  return prisma.staffMember.findFirst({
    where: { pinDigest: staffPinDigest(pin), active: true },
    select: { id: true, name: true },
  });
}

/** For rendering a stamped row, and for checking a cookie still names somebody
 *  who exists. A deactivated member still resolves HERE: their old rows must
 *  keep rendering their name long after they have left. */
export async function staffById(id: string): Promise<StaffIdentity | null> {
  return prisma.staffMember.findUnique({ where: { id }, select: { id: true, name: true } });
}

/** Everyone who could be on shift right now. Ordered by name so the screen is
 *  stable between renders. */
export function listActiveStaff(): Promise<StaffIdentity[]> {
  return prisma.staffMember.findMany({
    where: { active: true },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  });
}

// --- The on-shift stamp -----------------------------------------------------
//
// Here, and not in the app's auth module, for one reason: `apps/web` has no
// unit suite, and this is the guard that stops a cook editing their own cookie
// to put a colleague's name on a revert. C-084 had just finished teaching that
// a rule living only in an untested file is a rule that drifts, so the crypto
// lives where the tests are and the app supplies the secret.
//
// This is NOT authentication. The passcode cookie (C-037) is the only boundary
// and this value is unreachable without it. What it prevents is the single
// forgery that matters inside that boundary — an insider naming somebody else.

const stampFor = (staffId: string, secret: string): string =>
  createHash('sha256').update(`countertop-shift:${secret}:${staffId}`).digest('hex');

/** `<staffId>.<stamp>`. The id is in the clear on purpose: it is a uuid the
 *  screens already hold, and hiding it would buy nothing while making the
 *  cookie unreadable in a debugging session. */
export const shiftStamp = (staffId: string, secret: string): string =>
  `${staffId}.${stampFor(staffId, secret)}`;

/**
 * The id this value legitimately names, or null.
 *
 * Null covers every failure identically — absent, malformed, forged, or minted
 * under a passcode that has since rotated — because a caller has exactly one
 * useful response to all four: nobody is on shift. An empty secret is also
 * null: an unset `STAFF_PASSCODE` locks the whole screen (C-037), and a stamp
 * keyed on "" would be one anybody could compute.
 */
export function staffIdFromStamp(value: string | undefined, secret: string): string | null {
  if (secret === '' || value === undefined) return null;
  const split = value.lastIndexOf('.');
  if (split <= 0) return null;
  const staffId = value.slice(0, split);
  const presented = Buffer.from(value.slice(split + 1), 'utf8');
  const expected = Buffer.from(stampFor(staffId, secret), 'utf8');
  // Length first: `timingSafeEqual` throws on a mismatch rather than returning
  // false, which would turn a malformed cookie into a 500 on the queue screen.
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? staffId : null;
}
