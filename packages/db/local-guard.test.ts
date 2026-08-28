// C-043. Pure — no database, which is the point: the guard has to decide
// before anything connects.
import { describe, expect, it } from 'vitest';
import { assertLocalDatabase, databaseHost, OVERRIDE_ENV } from './local-guard';

const LOCAL = 'postgresql://shane@localhost:5432/countertop_test';
const NEON = 'postgresql://u:p@ep-cool-name-123.us-east-2.aws.neon.tech/countertop?sslmode=require';

describe('databaseHost', () => {
  it('reads the authority', () => {
    expect(databaseHost(LOCAL)).toBe('localhost');
    expect(databaseHost(NEON)).toBe('ep-cool-name-123.us-east-2.aws.neon.tech');
  });

  it('reads the socket directory libpq takes from the query string', () => {
    expect(databaseHost('postgresql:///countertop_test?host=/var/run/postgresql')).toBe(
      '/var/run/postgresql',
    );
  });

  it('does not guess at a string it cannot parse', () => {
    expect(databaseHost('')).toBe('<unparseable>');
    expect(databaseHost('countertop_test')).toBe('<unparseable>');
  });
});

describe('assertLocalDatabase', () => {
  const ok = (env: NodeJS.ProcessEnv) => () => assertLocalDatabase('the test', env);

  it('allows every shape of local', () => {
    expect(ok({ DATABASE_URL: LOCAL })).not.toThrow();
    expect(ok({ DATABASE_URL: 'postgresql://u@127.0.0.1:5432/x' })).not.toThrow();
    expect(ok({ DATABASE_URL: 'postgresql://u@[::1]:5432/x' })).not.toThrow();
    expect(ok({ DATABASE_URL: 'postgresql:///x?host=/tmp' })).not.toThrow();
    expect(ok({ DATABASE_URL: LOCAL, PGHOST: 'localhost' })).not.toThrow();
  });

  it('refuses a remote DATABASE_URL, naming the host', () => {
    expect(ok({ DATABASE_URL: NEON })).toThrow(/ep-cool-name-123\.us-east-2\.aws\.neon\.tech/);
    expect(ok({ DATABASE_URL: NEON })).toThrow(/DATABASE_URL/);
  });

  it('refuses a remote PGHOST even when DATABASE_URL is local', () => {
    // db:reset:test's dropdb reads PGHOST and never looks at DATABASE_URL —
    // the two settings can disagree, so both are checked.
    expect(ok({ DATABASE_URL: LOCAL, PGHOST: 'db.example.com' })).toThrow(/PGHOST/);
  });

  it('refuses a DATABASE_URL it cannot parse rather than assuming local', () => {
    expect(ok({})).toThrow();
    expect(ok({ DATABASE_URL: 'countertop_test' })).toThrow();
  });

  it('takes an override that names the exact host, and nothing broader', () => {
    const host = 'ep-cool-name-123.us-east-2.aws.neon.tech';
    expect(ok({ DATABASE_URL: NEON, [OVERRIDE_ENV]: host })).not.toThrow();
    // A blanket truthy value exported once in a shell profile disarms nothing.
    expect(ok({ DATABASE_URL: NEON, [OVERRIDE_ENV]: '1' })).toThrow();
    expect(ok({ DATABASE_URL: NEON, [OVERRIDE_ENV]: 'some-other-host' })).toThrow();
  });
});
