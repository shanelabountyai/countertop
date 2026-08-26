import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { reseed } from './fixtures';

// C-007: the customer menu and the item composer (P0-1, P0-2 display side).
//
// The prices asserted here are hand-calculated against SAMPLE_MENU, which is
// also what `db:seed:test` writes — the same fixture the unit suite is
// calculated against, not a second menu written to agree with the screen.
//
//   Burrito 1095 + chicken 0 + guacamole 250 + cheese "extra" (50 + 75) = 1470
//   NO onions adds nothing — a negation is free by construction
//   tax 8.25% of 1470 = 121.275 → 121;  total 1591

// This file asserts SEEDED prices and was the only one that did so without
// reseeding — so it silently depended on whatever the previous spec file left
// behind. `menu-editing.spec.ts` runs immediately before it and rewrites live
// menu rows; it happened to end on a test that reseeded, until C-026 added
// three that do not. An assertion about $10.95 has to be an assertion about
// the seed, not about test ordering.
test.beforeEach(() => {
  reseed();
});

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

// C-021: editing a line in place. `replaceLine` has existed and been unit
// tested since C-005; this is the screen that finally calls it.
test('a cart line re-opens pre-filled, and saving replaces it where it sat', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart$/);

  await page.goto('/menu/chips');
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    '1 × Burrito',
    '1 × Chips & salsa',
  ]);

  const burritoLine = page.getByRole('listitem').filter({ hasText: 'Burrito' }).first();
  await burritoLine.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\/menu\/burrito\?line=/);

  // Pre-filled on the FIRST render, from the cart cookie — not an empty
  // composer that fills itself in afterwards.
  await expect(page.getByRole('radio', { name: /Chicken/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Guacamole/ })).toBeChecked();
  await expect(total(page)).toHaveText('$13.45');
  // The way back is to the cart, because that is where this was opened from.
  await expect(page.getByRole('link', { name: '← Cart' })).toBeVisible();

  await page.getByRole('checkbox', { name: /Guacamole/ }).uncheck();
  await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
  await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await expect(total(page)).toHaveText('$21.90');

  await page.getByRole('button', { name: /Save changes/ }).click();
  await expect(page).toHaveURL(/\/cart$/);

  // Two lines, not three — and the burrito is still the first of them.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([
    '2 × Burrito',
    '1 × Chips & salsa',
  ]);
  await expect(page.getByText('NO onions')).toBeVisible();
  await expect(page.getByText('Guacamole')).toHaveCount(0);
});

test('a line id that is no longer in the cart composes a fresh one instead', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();

  const href = await page
    .getByRole('listitem')
    .filter({ hasText: 'Burrito' })
    .first()
    .getByRole('link', { name: 'Edit' })
    .getAttribute('href');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Nothing in it yet.')).toBeVisible();

  // The stale link still resolves — it just has nothing to edit, so it is an
  // ordinary composer with an ordinary Add button.
  await page.goto(href!);
  await expect(page.getByRole('button', { name: /Add to cart/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Chicken/ })).not.toBeChecked();
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
