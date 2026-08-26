import { execSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

// C-016: the sales report (P1-1).
//
// The arithmetic is proved in packages/core/orders/report.test.ts and the
// snapshot rule in packages/db/report.test.ts. What is proved HERE is that a
// real order, moved through the real kitchen buttons, arrives on the report as
// the numbers the kitchen expects — and that nothing counts until it should.
//
// The four seeded orders (packages/db/seed.ts):
//   #001 Dana Reyes   placed      — 2x Burrito, Guacamole, NO onions
//   #002 Morgan Ellis preparing
//   #003 Priya Shah   ready
//   #004 Sam Okafor   accepted    — five lines

test.beforeEach(() => {
  execSync('npm run db:seed:test', { cwd: '../..', stdio: 'ignore' });
});

const card = (page: Page, name: string): Locator =>
  page.getByRole('listitem').filter({ hasText: name }).first();

/** Tap a card forward through the REAL buttons until it is picked up. Each
 *  label comes from the status module, so this walks the actual state machine
 *  rather than writing a status into the database. */
async function pickUp(page: Page, name: string): Promise<void> {
  for (const label of ['Accept', 'Start cooking', 'Food is ready', 'Picked up']) {
    const button = card(page, name).getByRole('button', { name: label, exact: true });
    if ((await button.count()) === 0) continue;
    await button.click();
    await expect(button).toHaveCount(0);
  }
}

const stat = (page: Page, label: string) =>
  page.locator('div').filter({ hasText: new RegExp(`^${label}`) }).last();

test('counts nothing until an order is actually picked up', async ({ page }) => {
  await page.goto('/kitchen/report');

  // Four orders exist and every one of them is still in flight.
  await expect(page.getByText('No orders were picked up in this window.')).toBeVisible();
  await expect(stat(page, 'Still open')).toContainText('4');
  // Not "0%". A rate over zero finished orders is unknown, and a screen
  // printing 0% no-shows on an empty day is lying.
  await expect(stat(page, 'No-show rate')).toContainText('No orders finished yet');
});

test('a picked-up order reaches every section of the report', async ({ page }) => {
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes'); // 2x Burrito, Guacamole, NO onions

  await page.goto('/kitchen/report');
  await expect(stat(page, 'Orders sold')).toContainText('1');
  await expect(stat(page, 'Still open')).toContainText('3');

  // By day: one order, two items.
  const dayRow = page.getByRole('row').filter({ hasText: /^\d{4}-\d{2}-\d{2}/ }).first();
  await expect(dayRow).toContainText('1');
  await expect(dayRow).toContainText('2');

  // Top sellers: two burritos, from the ORDER's snapshot name.
  const seller = page.getByRole('row').filter({ hasText: 'Burrito' }).last();
  await expect(seller).toContainText('2');

  // And an hour bucket exists, in the restaurant's local hours.
  await expect(page.getByText(/^\d{2}:00$/).first()).toBeVisible();
});

// THE NEGATION, in report form. Dana's burritos all say "NO onions"; a report
// claiming 100% of burritos ADD onions, read off a column of people removing
// them, is the phone-transcription bug this product exists to kill.
test('a removal is never counted as a modifier attach', async ({ page }) => {
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes');

  await page.goto('/kitchen/report');
  const attachSection = page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Attached' }) });

  // Guacamole was genuinely ordered on both units, so it is 100%.
  await expect(attachSection.getByRole('row').filter({ hasText: 'Guacamole' })).toContainText(
    '100.0%',
  );
  // Onions were REMOVED from both, so they appear nowhere.
  await expect(attachSection.getByRole('row').filter({ hasText: 'Onions' })).toHaveCount(0);
});

test('a no-show is rated against finished orders, and is not revenue', async ({ page }) => {
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes');
  // Priya is already `ready`, so the no-show button is on her card now.
  await card(page, 'Priya Shah').getByRole('button', { name: 'No-show', exact: true }).click();
  await expect(card(page, 'Priya Shah').getByRole('button', { name: 'No-show' })).toHaveCount(0);

  await page.goto('/kitchen/report');
  // 1 abandoned of 2 finished. The two orders still in flight are in neither
  // half of that fraction.
  await expect(stat(page, 'No-show rate')).toContainText('50.0%');
  await expect(stat(page, 'No-show rate')).toContainText('1 of 2 finished');
  await expect(stat(page, 'Orders sold')).toContainText('1');
});

test('the window selector narrows the report and marks the current choice', async ({ page }) => {
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes');

  await page.goto('/kitchen/report');
  await expect(page.getByRole('link', { name: 'Last 7 days' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.getByRole('link', { name: 'Last 24 hours' }).click();
  await expect(page.getByRole('link', { name: 'Last 24 hours' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The seeded order was placed minutes ago, so it survives the narrower window.
  await expect(stat(page, 'Orders sold')).toContainText('1');
});

test('the report is readable on a phone and has no accessibility violations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes');
  await page.goto('/kitchen/report');

  // Wide tables scroll inside themselves; the page itself never scrolls
  // sideways.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
