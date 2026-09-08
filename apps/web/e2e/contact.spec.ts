import { expect, test } from '@playwright/test';
import {
  card,
  clearRestaurantContact,
  closeRestaurantToday,
  placeOrderFor,
  reseed,
} from './fixtures';

// C-077: the restaurant is findable and callable from every customer screen
// (PRD 5 P0-1).
//
// The seeded restaurant is open round the clock — `seedStoreHours` defaults to
// 00:00–24:00 every day so the suite cannot fail for the fifteen minutes
// before local midnight — so "Today: 00:00–24:00" is the seeded week said
// back, and it is asserted against the gate's own answer rather than on its
// own.
//
// The three contact strings are written out here rather than imported from
// `SAMPLE_CONTACT`: no spec in this suite imports a @countertop package at
// module scope, and asserting rendered output against the same constant that
// produced it proves the render, not the value.
const NAME = 'Firebird Kitchen';
const ADDRESS = '1412 Junipero Ave, Long Beach, CA 90804';
const PHONE = '(562) 555-0148';
const TEL = 'tel:5625550148';

test.beforeEach(() => {
  reseed();
});

/** The four customer routes reachable without placing an order. The status
 *  page is the fifth and needs a token, so it gets its own test below. */
const ROUTES = ['/', '/menu', '/cart', '/checkout'];

for (const route of ROUTES) {
  test(`${route} tells a first-time customer where the restaurant is`, async ({ page }) => {
    await page.goto(route);

    const footer = page.getByTestId('restaurant-footer');
    await expect(footer).toContainText(NAME);
    await expect(footer).toContainText(ADDRESS);
    // The number as stored, punctuation and all — and a href a phone dials.
    const call = footer.getByTestId('call-restaurant');
    await expect(call).toHaveText(PHONE);
    await expect(call).toHaveAttribute('href', TEL);
    await expect(footer.getByTestId('hours-today')).toHaveText('Today: 00:00–24:00');
  });
}

test("the footer's hours and the gate agree about today", async ({ page }) => {
  // Open: the menu shows no gate notice and the footer shows the hours.
  await page.goto('/menu');
  await expect(page.getByTestId('gate-notice')).toHaveCount(0);
  await expect(page.getByTestId('hours-today')).toHaveText('Today: 00:00–24:00');

  // Shut, through the same closed-today override the settings screen writes.
  // One source: the footer cannot still be advertising hours on a day the
  // gate is refusing orders for.
  await closeRestaurantToday();
  await page.goto('/menu');
  await expect(page.getByTestId('gate-notice')).toContainText('We are closed today');
  await expect(page.getByTestId('hours-today')).toHaveText('Today: Closed today');
});

test('a cancelled order is given a number to call, not just an apology', async ({
  page,
  context,
}) => {
  const link = await placeOrderFor(page, 'Dana Okafor');

  const kitchen = await context.newPage();
  await kitchen.goto('/kitchen');
  const theirs = card(kitchen, 'Dana Okafor');
  await theirs.getByText('Cancel…').click();
  await theirs.getByRole('button', { name: 'Out of an item' }).click();
  // The write's own receipt — the cancelled order leaves the queue (C-019).
  await expect(kitchen.getByText('Dana Okafor')).toHaveCount(0);
  await kitchen.close();

  await page.goto(link);
  await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'cancelled');

  // PRD 5 P0-1, second bullet: the number is IN the cancelled view, not only
  // down in the footer. Two of them on the page, and the first is the one
  // inside the coloured panel.
  const inPanel = page.getByTestId('order-status').getByTestId('call-restaurant');
  await expect(inPanel).toHaveAttribute('href', TEL);
  await expect(page.getByTestId('call-restaurant')).toHaveCount(2);

  await expect(page.getByTestId('restaurant-footer')).toContainText(ADDRESS);
});

test('a restaurant that has saved no details renders a footer with no holes in it', async ({
  page,
}) => {
  await clearRestaurantContact();
  await page.goto('/menu');

  const footer = page.getByTestId('restaurant-footer');
  // The hours survive — they are store hours, not a contact column.
  await expect(footer.getByTestId('hours-today')).toHaveText('Today: 00:00–24:00');
  await expect(footer.getByTestId('call-restaurant')).toHaveCount(0);
  await expect(footer).not.toContainText(NAME);
});

// No axe test of its own: the footer now renders inside `/`, `/menu`, `/cart`,
// `/checkout` and the status page, and every one of those already has a
// whole-page axe assertion (smoke, menu, status). A sixth would only re-run
// them.
