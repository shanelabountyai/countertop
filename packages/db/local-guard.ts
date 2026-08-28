// C-043: the destructive scripts refuse to run against a database that is not
// on this machine.
//
// `db:seed:test`, `demo:rush`, `db:reset:test` and every packages/db test
// begin by wiping every table. That has been safe only because every database
// this repo can reach is on localhost — an accident of setup, not a
// mechanism. C-045 puts a real restaurant's data behind a Neon URL, and one
// mistyped `dotenv -e` away is a truncated production database.
//
// The URL is the subject, never `NODE_ENV`: an env var nobody set is not a
// safety mechanism, and the variable that actually decides which rows get
// wiped is the connection string.
import { pathToFileURL } from 'node:url';

const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '::1', '[::1]']);

export const OVERRIDE_ENV = 'COUNTERTOP_ALLOW_REMOTE_WIPE';

/** The host a connection string points at, '' for a unix socket. */
export function databaseHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not parseable is not "probably fine" — refuse rather than guess.
    return '<unparseable>';
  }
  // `postgresql:///db?host=/var/run/postgresql` names its socket directory in
  // the query rather than the authority; libpq reads it, `URL.hostname` does not.
  return parsed.hostname || parsed.searchParams.get('host') || '';
}

export function isLocalHost(host: string): boolean {
  // A socket path is local by construction — a unix socket has no network.
  return host.startsWith('/') || LOCAL_HOSTS.has(host.toLowerCase());
}

/**
 * Throws unless every database the caller is about to wipe lives on this
 * machine. `DATABASE_URL` is what Prisma connects to; `PGHOST` is what the
 * `dropdb`/`createdb` in `db:reset:test` connect to, and they are separate
 * settings that can disagree.
 *
 * The override names the host being wiped rather than being a boolean: a
 * blanket `=1` exported once in a shell profile would disarm this everywhere,
 * forever, which is the failure mode the guard exists to prevent.
 */
export function assertLocalDatabase(action: string, env: NodeJS.ProcessEnv = process.env): void {
  const targets: Array<[string, string]> = [['DATABASE_URL', databaseHost(env.DATABASE_URL ?? '')]];
  if (env.PGHOST) targets.push(['PGHOST', env.PGHOST]);

  for (const [name, host] of targets) {
    if (isLocalHost(host)) continue;
    if (env[OVERRIDE_ENV] === host) continue;
    throw new Error(
      `${action} wipes every table, and ${name} points at "${host}", which is not this machine. ` +
        `Refusing. If that is genuinely what you want, re-run with ${OVERRIDE_ENV}=${host}.`,
    );
  }
}

// `tsx packages/db/local-guard.ts "<action>"` — the entry point for
// `db:reset:test`, whose dropdb/createdb never go through Prisma.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertLocalDatabase(process.argv[2] ?? 'This script');
  } catch (error) {
    // The message, not a stack trace: this is an operator reading a refusal,
    // not a developer debugging one.
    console.error(`\n${(error as Error).message}\n`);
    process.exit(1);
  }
}
