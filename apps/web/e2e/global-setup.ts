// The signed-in staff context, written once for the whole sweep (C-037).
//
// Nine spec files drive /kitchen. Making each of them log in first would be
// nine copies of the same beforeEach — the exact pattern C-025 exists to stop —
// so the cookie is minted here and handed to every context via
// `use.storageState`. The one spec that must NOT have it (auth.spec.ts) opts
// out with an empty storageState of its own.
//
// This talks to no server: the cookie is a digest of the passcode, so it can
// be computed before the app is even built. That keeps it independent of
// whether Playwright starts `webServer` before or after global setup.
import { writeFileSync } from 'node:fs';
import { STAFF_AUTH_FILE } from './auth-file';
import { staffPasscode, staffToken, STAFF_COOKIE } from '../lib/staff-auth';

export default async function globalSetup(): Promise<void> {
  const passcode = staffPasscode();
  if (passcode === '') {
    throw new Error(
      'STAFF_PASSCODE is not set, so every /kitchen spec would fail at the login ' +
        'page. Add it to .env.test (see .env.example).',
    );
  }

  writeFileSync(
    STAFF_AUTH_FILE,
    JSON.stringify({
      cookies: [
        {
          name: STAFF_COOKIE,
          value: await staffToken(passcode),
          domain: 'localhost',
          // Scoped exactly as the app scopes it: the customer surfaces never
          // receive this cookie, in the tests or in production.
          path: '/kitchen',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
  );
}
