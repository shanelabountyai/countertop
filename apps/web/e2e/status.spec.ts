import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { reseed } from './reseed';

// C-014: the customer's status page (P0-5, P0-7, P0-8).
//
// Every test starts by placing a REAL order, because the status token is the
// thing under test and it only exists because placement minted it. Nothing
// here reads a token out of the database — if the receipt does not hand the
// customer a working link, these fail, which is the point.

// Burrito 1095 + chicken 0 = 1095; tax 8.25% of 1095 = 90.3375 → 90; total 1185.
const placeOrderFor = async (page: Page, name: string): Promise<string> => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  // Wait for the add to actually land before navigating: the cart is an
  // httpOnly cookie written by the server action's response, and a `goto`
  // racing it arrives at an empty checkout.
  await expect(page).toHaveURL(/\/cart/);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill(name);
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();

  const href = await page.getByTestId('track-order').getAttribute('href');
  expect(href).toMatch(/^\/status\/.+/);
  return href as string;
};

const card = (page: Page, name: string): Locator =>
  page.getByRole('listitem').filter({ hasText: name }).first();

test.beforeEach(() => {
  reseed();
});

test('the receipt hands the customer a link that opens their own order', async ({ page }) => {
  await placeOrderFor(page, 'Alex Rivera');
  const orderNumber = await page.getByTestId('order-number').innerText();

  await page.getByTestId('track-order').click();

  await expect(page.getByTestId('status-order-number')).toHaveText(orderNumber);
  await expect(page.getByText('under Alex Rivera')).toBeVisible();
  await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'placed');
  await expect(page.getByTestId('order-status')).toContainText('Order received');
  // The snapshot's own money, not a recomputation (P0-9).
  await expect(page.getByTestId('status-total')).toHaveText('$11.85');
  // A range, never a point (P0-7).
  await expect(page.getByTestId('status-estimate')).toHaveText(/\d+–\d+ min/);
  // The UUID never appears in a URL (P0-8): the token is 128 bits of
  // randomness, not something with dashes in the shape of a uuid.
  expect(page.url()).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
});

test('an unknown token is a plain 404, telling nobody what exists', async ({ page }) => {
  const response = await page.goto('/status/definitely-not-a-real-token');
  expect(response?.status()).toBe(404);
});

test('the status moves under the customer without anyone reloading', async ({ page, context }) => {
  const link = await placeOrderFor(page, 'Casey Lin');
  await page.goto(link);
  // Survives a re-render, not a page load — how the two are told apart below.
  await page.evaluate(() => {
    (window as Window & { __neverReloaded?: boolean }).__neverReloaded = true;
  });

  const kitchen = await context.newPage();
  await kitchen.goto('/kitchen');
  const theirs = card(kitchen, 'Casey Lin');
  for (const label of ['Accept', 'Start cooking', 'Food is ready']) {
    await theirs.getByRole('button', { name: label }).click();
  }
  await kitchen.close();

  // Nobody touched this tab. One poll interval plus room for the render.
  await expect(page.getByTestId('order-status')).toContainText('Ready for pickup', {
    timeout: 15_000,
  });
  expect(
    await page.evaluate(() => (window as Window & { __neverReloaded?: boolean }).__neverReloaded),
  ).toBe(true);
  // Food on the shelf gets "come and get it", not a time estimate (P0-7).
  await expect(page.getByTestId('status-estimate')).toHaveCount(0);
});

test('a cancelled order gets its own view with the reason, and stops polling', async ({
  page,
  context,
}) => {
  const link = await placeOrderFor(page, 'Jordan Vale');

  const kitchen = await context.newPage();
  await kitchen.goto('/kitchen');
  const theirs = card(kitchen, 'Jordan Vale');
  await theirs.getByText('Cancel…').click();
  await theirs.getByRole('button', { name: 'Out of an item' }).click();
  // Assert the write LANDED before closing the page that issued it. Closing
  // aborts an in-flight server action exactly the way a `goto` does, and this
  // spec passed for two sessions on the timing alone — the customer's page
  // then loads an order that is still `placed`. A cancelled order leaves the
  // queue, so its absence is the write's own receipt.
  await expect(kitchen.getByText('Jordan Vale')).toHaveCount(0);
  await kitchen.close();

  // Counted from before the load: a terminal order has no further news, so
  // the page must not ask for any (P0-5).
  let polls = 0;
  await page.route('**/api/updates**', async (route) => {
    polls += 1;
    await route.continue();
  });
  await page.goto(link);

  await expect(page.getByTestId('order-status')).toHaveAttribute('data-status', 'cancelled');
  await expect(page.getByTestId('order-status')).toContainText('This order was cancelled');
  // The customer's wording, not the kitchen's shorthand.
  await expect(page.getByTestId('cancel-reason')).toHaveText(
    'The kitchen ran out of something in this order.',
  );
  // No time promise for food nobody is making.
  await expect(page.getByTestId('status-estimate')).toHaveCount(0);

  // Longer than one poll interval: a page still polling would have polled.
  await page.waitForTimeout(8_000);
  expect(polls).toBe(0);
});

test('the status page has no detectable accessibility violations', async ({ page }) => {
  const link = await placeOrderFor(page, 'Robin Ash');
  await page.goto(link);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
