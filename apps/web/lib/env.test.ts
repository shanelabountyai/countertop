// Scorecard K11: the env schema, and `.env.example` naming every key read.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_ENV_KEYS, parseEnv } from './env';

const ROOT = join(__dirname, '..', '..', '..');
const DB = 'postgresql://postgres:postgres@localhost:5432/countertop_test';

describe('parseEnv', () => {
  it('accepts a minimal valid environment, empty lines as unset', () => {
    const env = parseEnv({ DATABASE_URL: DB, STAFF_PASSCODE: '', PORT: '3400' });
    expect(env.DATABASE_URL).toBe(DB);
    expect(env.PORT).toBe(3400);
    expect(env.STAFF_PASSCODE).toBeUndefined();
    expect(env.NODE_ENV).toBe('development');
  });

  it('refuses a missing or malformed DATABASE_URL, by name only', () => {
    expect(() => parseEnv({})).toThrow('Invalid environment: DATABASE_URL');
    const secret = 'mysql://user:hunter2@db/x';
    expect(() => parseEnv({ DATABASE_URL: secret })).toThrow(/^Invalid environment: DATABASE_URL$/);
  });

  it('refuses a bad PORT, DIRECT_URL or NODE_ENV', () => {
    expect(() => parseEnv({ DATABASE_URL: DB, PORT: 'abc' })).toThrow('PORT');
    expect(() => parseEnv({ DATABASE_URL: DB, DIRECT_URL: 'nope' })).toThrow('DIRECT_URL');
    expect(() => parseEnv({ DATABASE_URL: DB, NODE_ENV: 'staging' })).toThrow('NODE_ENV');
  });

  it('does not require the fail-closed secrets', () => {
    expect(() => parseEnv({ DATABASE_URL: DB, NODE_ENV: 'production' })).not.toThrow();
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Set by the platform or the test runner, never by an operator.
const PLATFORM = new Set(['NODE_ENV', 'NEXT_RUNTIME', 'CI']);

describe('.env.example (K11)', () => {
  const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
  const named = new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));

  it('names every key the app schema reads', () => {
    for (const key of APP_ENV_KEYS) if (!PLATFORM.has(key)) expect(named, key).toContain(key);
  });

  it('names every process.env read in the repo', () => {
    const sources = ['apps', 'packages', 'scripts']
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) => /\.(ts|tsx|mts)$/.test(f) && !/\.test\.ts$/.test(f));
    const read = new Set<string>();
    for (const file of sources) {
      for (const m of readFileSync(file, 'utf8').matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) read.add(m[1]!);
    }
    expect(read.size).toBeGreaterThan(3);
    for (const key of read) if (!PLATFORM.has(key)) expect(named, key).toContain(key);
  });

  it('carries names only, never a value for a secret', () => {
    for (const key of ['DATABASE_URL', 'DIRECT_URL', 'STAFF_PASSCODE', 'STAFF_PASSCODE_PREVIOUS', 'LOYALTY_PHONE_PEPPER']) {
      expect(example, key).toMatch(new RegExp(`^${key}=$`, 'm'));
    }
  });
});
