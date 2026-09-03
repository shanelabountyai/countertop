import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { card, pickUp, reseed } from './fixtures';

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

// C-054 / PRD 1 P0-3. `Today` is the default and is the restaurant's business
// day — the seeded orders were placed minutes ago, so they are on it.
test('the window selector narrows the report and marks the current choice', async ({ page }) => {
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes');

  await page.goto('/kitchen/report');
  await expect(page.getByRole('link', { name: 'Today' })).toHaveAttribute('aria-current', 'page');
  await expect(stat(page, 'Orders sold')).toContainText('1');
  // The partial-day disclaimer belongs to the rolling windows only: a business
  // day is whole by definition, and a caveat that is always on is one nobody
  // reads.
  await expect(page.getByText(/earliest day shown may be partial/)).toHaveCount(0);
  await expect(page.getByText(/business day/)).toBeVisible();

  await page.getByRole('link', { name: 'Last 24 hours' }).click();
  await expect(page.getByRole('link', { name: 'Last 24 hours' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The seeded order was placed minutes ago, so it survives the narrower window.
  await expect(stat(page, 'Orders sold')).toContainText('1');
  await expect(page.getByText(/earliest day shown may be partial/)).toBeVisible();
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

// C-042: "were we honest?" (P1-4).
//
// The arithmetic is proved in packages/core/orders/estimate.test.ts and the
// pairing of quote to outcome in packages/db/report.test.ts. What is proved
// HERE is that a quote snapshotted at checkout survives to the report screen,
// and that the screen refuses to recommend a settings change off a handful of
// orders.
const accuracy = (page: Page) =>
  page.getByRole('region', { name: 'Quote accuracy by queue depth' });

test('a quoted order that reached Ready is graded on the report', async ({ page }) => {
  await page.goto('/kitchen/report');

  // Priya Shah is the one seeded order that got as far as `ready`.
  await expect(stat(page, 'Quoted orders')).toContainText('1');
  await expect(accuracy(page)).toBeVisible();

  // One order is not evidence. The screen says so rather than moving a setting.
  await expect(page.getByTestId('quote-suggestion')).toContainText('Not enough quoted orders');
});

test('food handed over well before the low end counts as a miss, not a win', async ({ page }) => {
  await page.goto('/kitchen');
  // Dana was placed two minutes ago and quoted at least ten. Walking her to
  // the shelf now is the kitchen beating its own estimate by a mile — which is
  // a customer who waited longer at the counter than they were told to.
  for (const label of ['Accept', 'Start cooking', 'Food is ready']) {
    await card(page, 'Dana Reyes').getByRole('button', { name: label, exact: true }).click();
    await expect(
      card(page, 'Dana Reyes').getByRole('button', { name: label, exact: true }),
    ).toHaveCount(0);
  }

  await page.goto('/kitchen/report');
  await expect(stat(page, 'Quoted orders')).toContainText('2');
  await expect(stat(page, 'Early')).toContainText('1');
});

// C-051 / defect D2. The report counted revenue on food nobody paid for, and
// no screen in the product reconciled the till against it. The seeded orders
// are all pay-at-pickup, so picking one up is exactly the case.
test('an order handed over unpaid is money owed, by name, not just revenue', async ({ page }) => {
  await page.goto('/kitchen');
  // Morgan pays at the counter; Dana walks off owing.
  await card(page, 'Morgan Ellis').getByRole('button', { name: 'Collected — mark paid' }).click();
  await expect(
    card(page, 'Morgan Ellis').getByRole('button', { name: /mark paid/i }),
  ).toHaveCount(0);
  await pickUp(page, 'Morgan Ellis');
  await pickUp(page, 'Dana Reyes');

  await page.goto('/kitchen/report');

  // Revenue still counts both — the split explains the headline, it does not
  // restate it (decision 2026-09-01 #1).
  await expect(stat(page, 'Orders sold')).toContainText('2');
  await expect(stat(page, 'Outstanding')).toContainText('50.0% of orders sold');

  // And the chase list names the person to ask, which a count cannot.
  const owed = page
    .getByRole('table')
    .filter({ has: page.getByRole('columnheader', { name: 'Owed' }) });
  await expect(owed.getByRole('row').filter({ hasText: 'Dana Reyes' })).toBeVisible();
  await expect(owed.getByRole('row').filter({ hasText: 'Morgan Ellis' })).toHaveCount(0);
});

// C-053 / PRD 1 P0-1. The headline tile was the gross labelled "Revenue", so
// the month-end number a bookkeeper reads off this screen included the sales
// tax owed to the state. Three tiles, and the addition tying them checked on
// the rendered page rather than only in the engine — the defect was never in
// the arithmetic, it was in which number carried the word.
test('the headline is net sales, with tax as its own number', async ({ page }) => {
  await page.goto('/kitchen');
  await pickUp(page, 'Dana Reyes');

  await page.goto('/kitchen/report');

  // The word itself is gone from the page. A screen that says "Revenue"
  // anywhere is a screen someone can quote to an accountant.
  await expect(page.getByText('Revenue')).toHaveCount(0);

  // By test id, not by label. The blunt `stat` helper takes the LAST div whose
  // text starts with the label, and this section's own prose starts with the
  // word "Gross" — which made the first version of this test read the
  // collected figure and call it the gross. The three tiles that have to add
  // up are the three that carry an id.
  const cents = async (testId: string) => {
    const text = (await page.getByTestId(testId).textContent()) ?? '';
    const amount = /^\$([\d,]+\.\d{2})$/.exec(text)?.[1];
    // Loudly. `Number('')` is 0, so a locator that matched the wrong element
    // reads as a real $0.00 and the reconciliation fails pointing at the page.
    expect(amount, `no amount in ${testId}: ${text}`).toBeDefined();
    return Math.round(Number(amount?.replace(/,/g, '')) * 100);
  };
  const net = await cents('report-net-sales');
  const tax = await cents('report-tax');
  const gross = await cents('report-gross');

  expect(net).toBeGreaterThan(0);
  expect(tax).toBeGreaterThan(0);
  expect(net + tax).toBe(gross);
});
