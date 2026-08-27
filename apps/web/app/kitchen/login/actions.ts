'use server';

// Only async function exports live in a 'use server' file — a plain constant
// here is a build error the rest of the gate does not catch (C-023, C-024).
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  safeNext,
  sameToken,
  staffPasscode,
  staffToken,
  STAFF_COOKIE,
  STAFF_COOKIE_MAX_AGE,
} from '@/lib/staff-auth';

export async function signIn(formData: FormData): Promise<void> {
  const passcode = staffPasscode();
  const next = safeNext(formData.get('next')?.toString());

  // Not a wrong passcode — a deployment with no passcode set at all. Saying so
  // is the difference between a five-minute fix and an afternoon.
  if (passcode === '') redirect('/kitchen/login?error=unset');

  // Both sides hashed, so the comparison is over two fixed-length digests and
  // `sameToken`'s constant time is actually constant.
  const token = await staffToken(passcode);
  if (!sameToken(await staffToken(formData.get('passcode')?.toString() ?? ''), token)) {
    redirect(`/kitchen/login?error=wrong&next=${encodeURIComponent(next)}`);
  }

  (await cookies()).set(STAFF_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/kitchen',
    maxAge: STAFF_COOKIE_MAX_AGE,
    secure: process.env.NODE_ENV === 'production',
  });
  redirect(next);
}

export async function signOut(): Promise<void> {
  (await cookies()).delete({ name: STAFF_COOKIE, path: '/kitchen' });
  redirect('/kitchen/login');
}
