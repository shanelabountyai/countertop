import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addBurritoToCart, reseed } from './fixtures';

// C-012: the 86 board and the three surfaces one 86 has to touch (P0-6).
//
// The trap this spec exists for (CLAUDE.md): an 86 mid-flight reaches the menu
// render, reaches the carts already holding it — and must NOT reach an order
// already placed, which is a snapshot. A board that only updated the menu
// would pass a lazier version of this file.

// Every test mutates the shared menu rows, so each starts from the seed.
test.beforeEach(() => {
  reseed();
});

const eightySix = async (page: Page, name: string) => {
  await page.goto('/kitchen/availability');
  await page.getByRole('button', { name: `Mark ${name} sold out` }).click();
  await expect(page.getByRole('button', { name: `Put ${name} back on` })).toBeVisible();
};

test('an 86 item is rendered sold out on the menu, not hidden, and cannot be added', async ({
  page,
}) => {
  await eightySix(page, 'Chips & salsa');

  await page.goto('/menu');
  // Still on the menu. A customer who cannot FIND the chips assumes the site
  // is broken; one who sees them greyed out knows the kitchen ran out.
  await expect(page.getByText('Chips & salsa — Sold out')).toBeVisible();
  await expect(page.getByRole('link', { name: /Chips & salsa/ })).toHaveCount(0);

  // And the composer refuses it, for anyone who kept the URL.
  await page.goto('/menu/chips');
  await expect(page.getByText('Sold out — the kitchen has run out.')).toBeVisible();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page.getByText('Chips & salsa is sold out.')).toBeVisible();
  await expect(page).toHaveURL(/\/menu\/chips$/);
});

test('an 86 option flags the carts holding it and blocks checkout, at the option grain', async ({
  page,
}) => {
  await addBurritoToCart(page, { guacamole: true });
  await eightySix(page, 'Guacamole');

  await page.goto('/cart');
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();
  await expect(page.getByText('Fix or remove the flagged lines')).toBeVisible();

  // Out of avocado is not out of burritos: the item itself is still orderable.
  await page.goto('/menu');
  await expect(page.getByRole('link', { name: /Burrito \$10\.95/ })).toBeVisible();

  await page.goto('/checkout');
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  await expect(page.getByText('Fix or remove the flagged lines')).toBeVisible();
  // Not just the bottom banner: the customer's last screen before paying has
  // to say which line is the problem, the same as the cart page one step
  // back — a generic banner over an unmarked line list leaves them guessing.
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();
});

test('putting an option back on clears the flag it left in the cart', async ({ page }) => {
  await addBurritoToCart(page, { guacamole: true });
  await eightySix(page, 'Guacamole');
  await page.goto('/cart');
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();

  await page.goto('/kitchen/availability');
  await page.getByRole('button', { name: 'Put Guacamole back on' }).click();
  await expect(page.getByRole('button', { name: 'Mark Guacamole sold out' })).toBeVisible();

  await page.goto('/cart');
  await expect(page.getByText('Guacamole is sold out.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible();
});

test('an order already placed is untouched by the 86 that follows it', async ({ page }) => {
  await addBurritoToCart(page, { guacamole: true });
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Jo Marquez');
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();

  await eightySix(page, 'Guacamole');

  // The ticket renders from the order's OWN snapshot. Guacamole is on this
  // burrito for as long as the row exists, whatever the menu says now.
  await page.goto('/kitchen');
  const card = page.getByRole('listitem').filter({ hasText: 'Jo Marquez' }).first();
  await expect(card.getByText('Guacamole')).toBeVisible();
  await expect(card.getByText(/sold out/i)).toHaveCount(0);
});

test('the board is readable and tappable with gloves on', async ({ page }) => {
  await page.goto('/kitchen/availability');

  for (const button of await page.getByRole('button').all()) {
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  }

  const fontSize = await page
    .getByText('Guacamole', { exact: false })
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(18);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
