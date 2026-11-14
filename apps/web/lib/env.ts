// Environment validation at boot (scorecard K11).
//
// Every variable the app reads, checked once when the server starts
// (`instrumentation.ts`), so a malformed value fails the boot with the
// variable's NAME rather than surfacing as a confusing error on the first
// request. `.env.example` must name every key here, and `env.test.ts` fails
// the suite if any `process.env` read in the repo is missing from it.
//
// What this deliberately does NOT do is require the optional secrets. Unset
// STAFF_PASSCODE means the kitchen is LOCKED and unset LOYALTY_PHONE_PEPPER
// means enrolment refuses by name (both by design, both fail closed); making
// either a boot error would turn a closed door into an outage.
//
// No dependency: six keys do not need a schema library.

type Source = Record<string, string | undefined>;

export type Env = {
  NODE_ENV: 'development' | 'test' | 'production';
  DATABASE_URL: string;
  DIRECT_URL?: string;
  PORT?: number;
  STAFF_PASSCODE?: string;
  STAFF_PASSCODE_PREVIOUS?: string;
  LOYALTY_PHONE_PEPPER?: string;
};

/** The keys the running app reads. Tooling-only keys (E2E_DEV, SMOKE_URL, …)
 *  are listed in `.env.example` too, but never read by the server. */
export const APP_ENV_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'DIRECT_URL',
  'PORT',
  'STAFF_PASSCODE',
  'STAFF_PASSCODE_PREVIOUS',
  'LOYALTY_PHONE_PEPPER',
] as const;

const DB_SCHEMES = new Set(['postgres:', 'postgresql:', 'prisma:', 'prisma+postgres:']);

const isDatabaseUrl = (value: string): boolean => {
  try {
    return DB_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
};

/** Throws `Invalid environment: NAME, NAME` — names only, never a value. */
export function parseEnv(source: Source): Env {
  // An empty `NAME=` line (a key waiting for its value) is unset, not invalid.
  const get = (key: (typeof APP_ENV_KEYS)[number]): string | undefined =>
    source[key] === '' ? undefined : source[key];
  const bad: string[] = [];

  const nodeEnv = get('NODE_ENV') ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') bad.push('NODE_ENV');

  const databaseUrl = get('DATABASE_URL');
  if (databaseUrl === undefined || !isDatabaseUrl(databaseUrl)) bad.push('DATABASE_URL');

  const directUrl = get('DIRECT_URL');
  if (directUrl !== undefined && !isDatabaseUrl(directUrl)) bad.push('DIRECT_URL');

  const port = get('PORT');
  if (port !== undefined && !/^\d{1,5}$/.test(port)) bad.push('PORT');

  if (bad.length > 0) throw new Error(`Invalid environment: ${bad.join(', ')}`);

  const env: Env = { NODE_ENV: nodeEnv as Env['NODE_ENV'], DATABASE_URL: databaseUrl! };
  if (directUrl !== undefined) env.DIRECT_URL = directUrl;
  if (port !== undefined) env.PORT = Number(port);
  for (const key of ['STAFF_PASSCODE', 'STAFF_PASSCODE_PREVIOUS', 'LOYALTY_PHONE_PEPPER'] as const) {
    const value = get(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}
