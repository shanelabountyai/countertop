import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { card, reseed } from './fixtures';

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
  reseed();
});

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

// C-020: the time-in-state tally on the report screen.
//
// The seeded queue is one order in each state, which is exactly the shape that
// makes the "orders" column mean something: every order entered `placed`, only
// the one that got that far entered `ready`.
const timeInState = (page: Page) => page.getByRole('region', { name: 'Time in each state' });

test('time in each state counts the orders that ENTERED each state', async ({ page }) => {
  await page.goto('/kitchen/report');

  // Nothing has sold, and this section is still the useful one.
  await expect(page.getByText('No orders were picked up in this window.')).toBeVisible();

  // All four were placed; three got as far as accepted; two to preparing; one
  // is on the shelf.
  await expect(timeInState(page).getByRole('row').filter({ hasText: 'New' })).toContainText('4');
  await expect(timeInState(page).getByRole('row').filter({ hasText: 'Accepted' })).toContainText('3');
  await expect(timeInState(page).getByRole('row').filter({ hasText: 'Preparing' })).toContainText('2');
  await expect(
    timeInState(page).getByRole('row').filter({ hasText: 'Ready for pickup' }),
  ).toContainText('1');

  // Terminal states are not rows. An order picked up an hour ago has not been
  // "picked up" for an hour — it is done, and a "0.0 min" row reads like a
  // measurement instead of like arithmetic that cannot come out otherwise.
  await expect(timeInState(page).getByRole('row').filter({ hasText: 'Picked up' })).toHaveCount(0);
});

test('a ticket sent back counts both visits to preparing', async ({ page }) => {
  await page.goto('/kitchen');
  // Morgan Ellis is preparing. Mark ready by mistake, then undo it.
  await card(page, 'Morgan Ellis').getByRole('button', { name: 'Food is ready', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ready for pickup (2)' })).toBeVisible();
  await card(page, 'Morgan Ellis').getByRole('button', { name: /Undo/ }).click();
  await expect(page.getByRole('heading', { name: 'Preparing (1)' })).toBeVisible();

  await page.goto('/kitchen/report');
  // Still two orders in `preparing` — the revert did not remove Morgan's first
  // visit, it appended a correction on top of it.
  await expect(timeInState(page).getByRole('row').filter({ hasText: 'Preparing' })).toContainText('2');
  // And she reached `ready` once, which is the mistake still being on the
  // record rather than erased from it.
  await expect(
    timeInState(page).getByRole('row').filter({ hasText: 'Ready for pickup' }),
  ).toContainText('2');
});
