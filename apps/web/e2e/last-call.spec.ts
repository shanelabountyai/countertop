import { expect, test } from '@playwright/test';
import { reseed, setLastOrderIn } from './fixtures';

// C-079: the door is about to close and every screen a customer could be on
// says so (PRD 5 P0-3).
//
// The three routes are the three the gate is already asked on. What is under
// test is not really the copy — that is one component and one unit-tested
// number — it is that all three MOUNT it, and mount the same one. A menu that
// warns while checkout stays silent is the failure this item exists to prevent.
const ROUTES = ['/menu', '/cart', '/checkout'];

test.beforeEach(() => {
  reseed();
});

test('ten minutes from the cutoff, all three ordering screens say the same thing', async ({
  page,
}) => {
  // `toPass`, because the fixture is set in WHOLE MINUTES off the server's
  // clock. If that clock rolls over between setting it and the third page
  // rendering, the server honestly says 9 — a race in the test, not the
  // product. A retry re-sets the fixture; a rollover cannot happen twice in
  // the few seconds one attempt takes.
  await expect(async () => {
    await setLastOrderIn(10);

    const seen: string[] = [];
    for (const route of ROUTES) {
      await page.goto(route);
      const warning = page.getByTestId('last-call');
      await expect(warning).toBeVisible();
      // The number, not just the sentence: a countdown stuck on the wrong
      // minute renders a perfectly plausible warning.
      await expect(warning).toHaveAttribute('data-minutes', '10', { timeout: 1_000 });
      seen.push((await warning.textContent())!.trim());
    }

    // Byte-identical across the three, which is what "one component" means
    // when it is asserted rather than asserted about.
    expect(new Set(seen).size).toBe(1);
    expect(seen[0]).toContain('Last online orders in 10 min');
  }).toPass({ timeout: 30_000 });
});

test('forty minutes from the cutoff, none of them does', async ({ page }) => {
  await setLastOrderIn(40);

  for (const route of ROUTES) {
    await page.goto(route);
    // Still open for business — the point is that the warning is absent, not
    // that the screen is.
    await expect(page.getByTestId('gate-notice')).toHaveCount(0);
    await expect(page.getByTestId('last-call')).toHaveCount(0);
  }
});

// C-149: sitting on a screen, the number counts down — and the warning appears
// when the window opens, not only on a reload. The page clock is faked; the
// server's is not, so these assert the screen's own arithmetic from the
// server's starting figure.
test('the countdown ticks down without a reload', async ({ page }) => {
  await setLastOrderIn(10);
  await page.clock.install();
  await page.goto('/menu');

  const warning = page.getByTestId('last-call');
  await expect(warning).toBeVisible();
  // 10, or 9 if the server's minute rolled over since the fixture was set —
  // the assertion is the three minutes the SCREEN counts, not that race.
  const start = Number(await warning.getAttribute('data-minutes'));
  expect([9, 10]).toContain(start);
  await page.clock.runFor(3 * 60_000);
  await expect(warning).toHaveAttribute('data-minutes', String(start - 3));
  await expect(warning).toContainText(`Last online orders in ${start - 3} min`);
});

test('the warning appears when the window opens on a screen already up', async ({ page }) => {
  await page.clock.install();
  // Re-set and reload if the server's minute rolled over between the fixture
  // and the render (the first test's race) — that load already shows 30.
  await expect(async () => {
    await setLastOrderIn(31);
    await page.goto('/menu');
    await expect(page.getByTestId('last-call')).toHaveCount(0, { timeout: 1_000 });
  }).toPass({ timeout: 30_000 });
  await page.clock.runFor(60_000);
  await expect(page.getByTestId('last-call')).toHaveAttribute('data-minutes', '30');
});
