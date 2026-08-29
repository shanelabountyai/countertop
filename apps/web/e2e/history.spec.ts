import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { reseed, seedFinishedRush } from './fixtures';

// Staff order history (post-queue receipt lookup): every status, any day —
// the other half of P0-11's lookup, which is scoped to today's open orders.

test.beforeEach(() => {
  reseed();
});

test('finds an order by name and shows its full receipt, negation intact', async ({ page }) => {
  await page.goto('/kitchen/orders?q=Dana');
  const row = page.getByRole('link', { name: /#001/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Dana Reyes');

  await row.click();
  await expect(page.getByTestId('history-order-number')).toHaveText('#001');
  await expect(page.getByText('Dana Reyes')).toBeVisible();

  const negation = page.getByText('NO onions');
  await expect(negation).toBeVisible();
  const weight = await negation.evaluate((element) => getComputedStyle(element).fontWeight);
  expect(Number(weight)).toBeGreaterThanOrEqual(700);
});

test('finds the same order by its printed number', async ({ page }) => {
  await page.goto('/kitchen/orders?q=001');
  await expect(page.getByRole('link', { name: /Dana Reyes/ })).toBeVisible();
});

test('an empty search shows every order, and "Show all" clears a search', async ({ page }) => {
  await page.goto('/kitchen/orders?q=nobody-by-this-name');
  await expect(page.getByText('Nothing matches "nobody-by-this-name".')).toBeVisible();

  await page.getByRole('link', { name: 'Show all' }).click();
  await expect(page).toHaveURL('/kitchen/orders');
  await expect(page.getByRole('link', { name: /#001/ })).toBeVisible();
});

test('reaches an order that has already left the live queue', async ({ page }) => {
  seedFinishedRush();
  await page.goto('/kitchen/orders?q=Ada Nkemelu');
  const row = page.getByRole('link', { name: /Ada Nkemelu/ });
  await expect(row).toBeVisible();
  // Whatever terminal status a full rush left her in (picked up, cancelled or
  // a no-show), the whole point is that it is NOT one still on the live
  // queue — otherwise this test would pass even if history secretly only
  // reused `loadQueue()`.
  const text = await row.innerText();
  for (const openStatus of ['New', 'Accepted', 'Preparing', 'Ready for pickup']) {
    expect(text).not.toContain(openStatus);
  }
});

test('the history search and its receipt have no detectable accessibility violations', async ({
  page,
}) => {
  await page.goto('/kitchen/orders');
  const listResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(listResults.violations).toEqual([]);

  await page.getByRole('link', { name: /#001/ }).click();
  const detailResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(detailResults.violations).toEqual([]);
});
