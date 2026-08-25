import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// C-007: the customer menu and the item composer (P0-1, P0-2 display side).
//
// The prices asserted here are hand-calculated against SAMPLE_MENU, which is
// also what `db:seed:test` writes — the same fixture the unit suite is
// calculated against, not a second menu written to agree with the screen.
//
//   Burrito 1095 + chicken 0 + guacamole 250 + cheese "extra" (50 + 75) = 1470
//   NO onions adds nothing — a negation is free by construction
//   tax 8.25% of 1470 = 121.275 → 121;  total 1591

const total = (page: Page) => page.getByTestId('line-total');

test('the menu lists every category, item and price', async ({ page }) => {
  await page.goto('/menu');
  await expect(page.getByRole('heading', { name: 'Burritos & Bowls' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sides' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Burrito \$10\.95/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Chips & salsa \$3\.50/ })).toBeVisible();
});

test('skipping a required group blocks the add with a clear message', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('button', { name: /Add to cart/ }).click();

  await expect(page.getByText('Choose your protein.')).toBeVisible();
  // Still on the composer: nothing was added.
  await expect(page.getByRole('heading', { name: 'Burrito' })).toBeVisible();
});

test('a priced option changes the composed price immediately', async ({ page }) => {
  await page.goto('/menu/burrito');
  await expect(total(page)).toHaveText('$10.95');

  await page.getByRole('radio', { name: /Chicken/ }).check();
  await expect(total(page)).toHaveText('$10.95');

  await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await expect(total(page)).toHaveText('$13.45');

  // Intensity: "extra" costs the option's delta PLUS its extra surcharge.
  // Clicked by its LABEL, the way a customer does — the radio itself is
  // visually hidden behind the pill it draws.
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
  await expect(
    page.getByRole('radiogroup', { name: 'Cheese' }).getByRole('radio', { name: /^Extra/ }),
  ).toBeChecked();
  await expect(total(page)).toHaveText('$14.70');

  // The negation is free, and it is not one of your picks.
  await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
  await expect(total(page)).toHaveText('$14.70');

  // Quantity multiplies the whole composed unit, modifiers included.
  await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await expect(total(page)).toHaveText('$29.40');
});

test('a composed line reaches the cart, with the negation distinct and the tax the server computed', async ({
  page,
}) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
  await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
  await page.getByRole('button', { name: /Add to cart/ }).click();

  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('heading', { name: '1 × Burrito' })).toBeVisible();
  await expect(page.getByText('Extra cheese')).toBeVisible();

  // "NO onions" is not "onions" (P0-11's founding case, at the customer end).
  const negation = page.getByText('NO onions');
  await expect(negation).toBeVisible();
  await expect(negation).toHaveCSS('font-weight', '600');

  await expect(page.getByTestId('cart-total')).toHaveText('$15.91');

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Nothing in it yet.')).toBeVisible();
});

for (const path of ['/menu', '/menu/burrito', '/cart']) {
  test(`${path} has no detectable accessibility violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
