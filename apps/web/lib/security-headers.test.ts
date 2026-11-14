// Scorecard K7 (global security headers). The config is the source of truth; this asserts
// what it hands Next, so a dropped header fails the unit suite rather than
// only a scan of the live site.
import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

async function headersFor(source: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const rule = rules.find((r) => r.source === source);
  return Object.fromEntries((rule?.headers ?? []).map((h) => [h.key, h.value]));
}

describe('security headers (K7)', () => {
  it('sets the four required headers on every path', async () => {
    const h = await headersFor('/:path*');
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['Strict-Transport-Security']).toMatch(/max-age=\d{8,}/);
  });
});
