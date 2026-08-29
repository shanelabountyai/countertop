// C-045 deployment smoke. `npm run smoke:prod`.
//
// The e2e suite proves the app; this proves the DEPLOYMENT — that the built
// artifact on Vercel is talking to Neon, that the kitchen is locked to the
// public, and that the passcode in Vercel's environment is the one that opens
// it. None of that can fail locally, which is exactly why it needs its own
// check: every C-045 defect so far was invisible until the thing was deployed.
//
// Read-only by construction: it signs in and looks. Nothing here places,
// advances or cancels an order, because it runs against live data.
import { chromium } from '@playwright/test';

const BASE = process.env.SMOKE_URL ?? 'https://countertop-mu.vercel.app';
const PASSCODE = process.env.STAFF_PASSCODE ?? '';
const checks: Array<[string, boolean, string]> = [];
const check = (name: string, ok: boolean, detail = '') => checks.push([name, ok, detail]);

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(`${BASE}/menu`, { waitUntil: 'domcontentloaded' });
const itemLinks = await page.locator('a[href^="/menu/"]').count();
check('menu lists items', itemLinks > 0, `${itemLinks} item links`);

await page.locator('a[href^="/menu/"]').first().click();
await page.waitForLoadState('domcontentloaded');
check('item detail renders a price', /\$\d+\.\d{2}/.test(await page.locator('body').innerText()));

// Kitchen must be locked to an anonymous visitor.
await page.goto(`${BASE}/kitchen`, { waitUntil: 'domcontentloaded' });
check('kitchen locked when signed out', page.url().includes('/kitchen/login'));

// Sign-in is a server action: it re-renders and rewrites the URL without a
// document navigation, so every wait here is on the URL, never on a load
// event. Waiting on `domcontentloaded` resolves against the page you are
// still standing on and reports a working deployment as broken.
await page.fill('input[name="passcode"]', 'definitely-not-it');
await page.click('button[type="submit"]');
await page.waitForURL(/error=wrong/, { timeout: 15_000 });
check('wrong passcode refused', (await page.locator('body').innerText()).includes('not right'));

// The real one must get in and show the seeded rush.
await page.fill('input[name="passcode"]', PASSCODE);
await page.click('button[type="submit"]');
await page.waitForURL((u) => u.pathname === '/kitchen', { timeout: 15_000 });
check('signed in reaches /kitchen', new URL(page.url()).pathname === '/kitchen');
const body = await page.locator('body').innerText();
const orderNumbers = [...body.matchAll(/#(\d+)/g)].map((m) => m[1]);
check('queue shows seeded orders', orderNumbers.length > 0, `${orderNumbers.length} order numbers`);
check('negation rendered distinctly', /NO |no /.test(body), 'looked for a NO-prefixed removal');

await page.goto(`${BASE}/kitchen/report`, { waitUntil: 'domcontentloaded' });
check('report renders', (await page.locator('body').innerText()).length > 200);

await browser.close();

let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed === 0 ? 0 : 1);
