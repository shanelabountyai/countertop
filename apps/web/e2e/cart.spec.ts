import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addBurritoToCart, reseed } from './fixtures';

// C-083: P1-2, ordering for a group. The stepper goes through the same
// server-price-authority path a composer save uses (`updateCartLine`), so
// what is proved here is the same thing `checkout.spec.ts` proves for the
// composer: the total shown is the total the server recomputed, not client
// arithmetic.

test.beforeEach(() => {
  reseed();
});

test('a stepper changes quantity without a trip back into the composer', async ({ page }) => {
  await addBurritoToCart(page);
  await expect(page.getByTestId('line-quantity')).toHaveText('1');
  await expect(page.getByTestId('cart-total')).toHaveText('$11.85');
  await expect(page.getByRole('button', { name: /Decrease quantity/ })).toBeDisabled();

  await page.getByRole('button', { name: /Increase quantity/ }).click();
  await expect(page.getByTestId('line-quantity')).toHaveText('2');
  await expect(page.getByTestId('cart-total')).toHaveText('$23.71');
  await expect(page.getByRole('button', { name: /Decrease quantity/ })).toBeEnabled();

  await page.getByRole('button', { name: /Decrease quantity/ }).click();
  await expect(page.getByTestId('line-quantity')).toHaveText('1');
  await expect(page.getByTestId('cart-total')).toHaveText('$11.85');
  await expect(page.getByRole('button', { name: /Decrease quantity/ })).toBeDisabled();

  // The loop-based `/cart` axe scan in menu.spec.ts only ever sees an empty
  // cart. This is the one that exercises the stepper's disabled state.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('the menu header shows the cart count without opening the cart', async ({ page }) => {
  await page.goto('/menu');
  await expect(page.getByRole('link', { name: 'View cart' })).toHaveText('View cart');

  await addBurritoToCart(page);
  await page.getByRole('button', { name: /Increase quantity/ }).click();
  await expect(page.getByTestId('line-quantity')).toHaveText('2');

  await page.goto('/menu');
  await expect(page.getByRole('link', { name: 'View cart (2)' })).toBeVisible();
});
