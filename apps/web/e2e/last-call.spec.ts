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
  await setLastOrderIn(10);

  const seen: string[] = [];
  for (const route of ROUTES) {
    await page.goto(route);
    const warning = page.getByTestId('last-call');
    await expect(warning).toBeVisible();
    // The number, not just the sentence: a countdown stuck on the wrong minute
    // renders a perfectly plausible warning.
    await expect(warning).toHaveAttribute('data-minutes', '10');
    seen.push((await warning.textContent())!.trim());
  }

  // Byte-identical across the three, which is what "one component" means when
  // it is asserted rather than asserted about.
  expect(new Set(seen).size).toBe(1);
  expect(seen[0]).toContain('Last online orders in 10 min');
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
