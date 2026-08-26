import { execSync } from 'node:child_process';

/**
 * Put the test database back to `packages/db/seed.ts`, between tests that
 * rewrite live rows.
 *
 * One helper rather than eight copies of the same `execSync` — and it CAPTURES
 * stderr rather than discarding it. `stdio: 'ignore'` turned a seed failure
 * into the string "Command failed: npm run db:seed:test" and nothing else,
 * which is a failure you can only reproduce by guessing. The seed talks to the
 * same Postgres the app under test is holding connections to, so a TRUNCATE
 * can genuinely lose a lock race with an in-flight poll; when that happens the
 * message is worth having.
 */
export function reseed(): void {
  try {
    execSync('npm run db:seed:test', {
      cwd: '../..',
      // stdout ignored (it is npm's banner); stderr kept, because that is the
      // half with the reason in it.
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`db:seed:test failed${stderr ? `:\n${stderr}` : ' with no output'}`);
  }
}
