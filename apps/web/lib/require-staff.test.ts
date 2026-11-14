// SEC-04 / scorecard K3: every kitchen entry point checks the staff cookie
// itself, not only the /kitchen middleware matcher.
//
// Two halves. The decision (`staffCookieGeneration`, shared with the
// middleware) is exercised directly. The coverage is a source scan: a new
// kitchen page, route handler or 'use server' export that forgets the guard
// fails here, which is the property the middleware comment used to rely on
// a grep for.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { staffCookieGeneration, staffToken } from './staff-auth';

const KITCHEN = join(__dirname, '..', 'app', 'kitchen');
const LOGIN = join(KITCHEN, 'login');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const files = walk(KITCHEN).filter((path) => !path.startsWith(LOGIN));
const read = (path: string) => readFileSync(path, 'utf8');
const label = (path: string) => relative(KITCHEN, path);

describe('every kitchen entry point guards itself (K3)', () => {
  it('finds the surfaces it is meant to check', () => {
    expect(files.filter((f) => f.endsWith('page.tsx')).length).toBeGreaterThanOrEqual(8);
    expect(files.filter((f) => f.endsWith('route.ts')).length).toBeGreaterThanOrEqual(2);
  });

  it('every page calls requireStaffPage before anything else', () => {
    for (const path of files.filter((f) => f.endsWith('page.tsx'))) {
      const lines = (read(path).split(/^export default async function/m)[1] ?? '').split('\n');
      const open = lines.findIndex((line, i) => (i === 0 ? /\)[^{]*\{\s*$/ : /^(\}\)|\))[^{]*\{\s*$/).test(line));
      expect(open, label(path)).toBeGreaterThanOrEqual(0);
      expect(lines[open + 1]?.trim(), label(path)).toMatch(/^await requireStaffPage\(/);
    }
  });

  it('every route handler returns the refusal before reading anything', () => {
    for (const path of files.filter((f) => f.endsWith('route.ts'))) {
      const source = read(path);
      for (const handler of source.split(/^export async function (?:GET|POST|PUT|PATCH|DELETE)\b/m).slice(1)) {
        const lines = handler.split('\n');
        const open = lines.findIndex((line) => /\{\s*$/.test(line));
        expect(lines[open + 1]?.trim(), label(path)).toBe('const refused = await staffRouteRefusal();');
        expect(lines[open + 2]?.trim(), label(path)).toBe('if (refused) return refused;');
      }
    }
  });

  it("every 'use server' export calls requireStaff as its first statement", () => {
    const actionFiles = files.filter((f) => /^'use server';/m.test(read(f)));
    expect(actionFiles.length).toBeGreaterThanOrEqual(4);
    for (const path of actionFiles) {
      const source = read(path);
      // A 'use server' file may only export async functions; an arrow export
      // would dodge the scan below, so it is refused outright.
      expect(source, label(path)).not.toMatch(/^export const /m);
      const exports = source.split(/^export async function /m).slice(1);
      expect(exports.length, label(path)).toBeGreaterThan(0);
      for (const fn of exports) {
        const name = fn.slice(0, fn.indexOf('('));
        const lines = fn.split('\n');
        const open = lines.findIndex((line) => /^(.*\)|\))[^{]*\{\s*$/.test(line));
        expect(lines[open + 1]?.trim(), `${label(path)} ${name}`).toBe('await requireStaff();');
      }
    }
  });
});

describe('the decision the guard makes', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('refuses everyone when the passcode is unset', async () => {
    delete process.env.STAFF_PASSCODE;
    expect(await staffCookieGeneration(await staffToken(''))).toBeNull();
  });

  it('refuses a missing or wrong cookie', async () => {
    process.env.STAFF_PASSCODE = 'right';
    expect(await staffCookieGeneration(undefined)).toBeNull();
    expect(await staffCookieGeneration(await staffToken('wrong'))).toBeNull();
  });

  it('admits the current and, mid-rotation, the previous passcode', async () => {
    process.env.STAFF_PASSCODE = 'new';
    process.env.STAFF_PASSCODE_PREVIOUS = 'old';
    expect(await staffCookieGeneration(await staffToken('new'))).toBe('current');
    expect(await staffCookieGeneration(await staffToken('old'))).toBe('previous');
  });
});
