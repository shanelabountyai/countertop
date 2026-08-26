import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { reseed } from './reseed';

// C-015: safe menu editing (P0-13).
//
// THE WHOLE FILE RUNS ON A PHONE. The between-rush device is a phone, not a
// laptop, so a desktop-viewport suite would prove nothing about the screen
// this requirement is actually about.
test.use({ viewport: { width: 390, height: 844 } }); // iPhone 14 portrait

// Every test rewrites live menu rows, so each starts from the seed.
test.beforeEach(() => {
  reseed();
});

// `exact: true` throughout: "Price for Burrito" is a PREFIX of "Price for
// Burrito bowl", and Playwright matches accessible names by substring. The
// names are distinct; the default locator is not.
const retype = async (page: Page, itemName: string, price: string) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('textbox', { name: `Price for ${itemName}`, exact: true }).fill(price);
  await page.getByRole('button', { name: `Review price for ${itemName}`, exact: true }).click();
};

test('a price edit is confirmed old → new before it is saved', async ({ page }) => {
  // THE TARGET DEFECT: $10.95 typed as $109.50. A valid price, so nothing but
  // showing it beside the old one can catch it.
  await retype(page, 'Burrito', '109.50');

  await expect(page.getByRole('heading', { name: 'Change the price of Burrito?' })).toBeVisible();
  await expect(page.getByText('Was $10.95, will be $109.50.')).toBeVisible();

  // Nothing is written until the manager says so.
  await page.goto('/menu');
  await expect(page.getByRole('link', { name: /Burrito \$10\.95/ })).toBeVisible();
});

test('cancelling the confirm leaves the price exactly as it was', async ({ page }) => {
  await retype(page, 'Burrito', '109.50');
  await page.getByRole('link', { name: 'Cancel' }).click();

  await expect(page.getByRole('heading', { name: 'Edit menu' })).toBeVisible();
  await page.goto('/menu');
  await expect(page.getByRole('link', { name: /Burrito \$10\.95/ })).toBeVisible();
});

test('confirming saves the price and the customer menu shows it', async ({ page }) => {
  await retype(page, 'Burrito', '12.50');
  await page.getByRole('button', { name: 'Save new price for Burrito', exact: true }).click();

  await expect(page.getByRole('status')).toContainText('Burrito is now priced at $12.50');

  await page.goto('/menu');
  await expect(page.getByRole('link', { name: /Burrito \$12\.50/ })).toBeVisible();
});

test('a modifier delta may be repriced negative, and the composer follows', async ({ page }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('textbox', { name: 'Price for Guacamole', exact: true }).fill('-0.50');
  await page.getByRole('button', { name: 'Review price for Guacamole', exact: true }).click();
  await expect(page.getByText('Was +$2.50, will be −$0.50.')).toBeVisible();
  await page.getByRole('button', { name: 'Save new price for Guacamole', exact: true }).click();
  // Wait for the write to LAND before navigating: a `goto` racing the server
  // action aborts it, and the composer then honestly reports the old price.
  await expect(page.getByRole('status')).toContainText('Guacamole is now −$0.50');

  await page.goto('/menu/burrito');
  await expect(page.getByRole('checkbox', { name: /Guacamole/ })).toBeVisible();
  await expect(page.getByText('−$0.50')).toBeVisible();
});

test('a price that is not a price is refused before any confirm panel', async ({ page }) => {
  await retype(page, 'Burrito', '1O.95'); // letter O, the other fat-finger
  await expect(page.getByRole('heading', { name: 'Nothing was changed' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Save new price/ })).toHaveCount(0);
});

test('editing a shared modifier group names every item it touches', async ({ page }) => {
  await page.goto('/kitchen/menu');
  // Salsa serves the burrito AND the bowl. Making it required is a two-second
  // edit that silently changes an item nobody was looking at.
  await page.getByRole('spinbutton', { name: 'Choose at least, Salsa' }).fill('1');
  await page.getByRole('button', { name: 'Review changes to Salsa', exact: true }).click();

  await expect(page.getByText('Shared — affects 2 items:')).toBeVisible();
  const affected = page.getByRole('list').filter({ hasText: 'Burrito bowl' }).last();
  await expect(affected.getByRole('listitem')).toHaveText(['Burrito', 'Burrito bowl']);
  await expect(page.getByText('This makes the group REQUIRED')).toBeVisible();

  await page.getByRole('button', { name: 'Save changes to Salsa' }).click();
  await expect(page.getByRole('status')).toContainText('Salsa updated');

  // Both items feel it, which is what the warning promised — including the
  // bowl, which is the one nobody was looking at.
  for (const path of ['/menu/burrito', '/menu/bowl']) {
    await page.goto(path);
    await page.getByRole('radio', { name: /Chicken/ }).check();
    if (path.endsWith('bowl')) await page.getByRole('radio', { name: /Medium/ }).check();
    await page.getByRole('button', { name: /Add to cart/ }).click();
    await expect(page.getByText('Choose your salsa.')).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
  }
});

test('a group used by one item is not dressed up as a shared one', async ({ page }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('button', { name: 'Review changes to Fillings' }).click();

  await expect(page.getByText('Affects 1 item: Taco plate.')).toBeVisible();
  await expect(page.getByText(/^Shared —/)).toHaveCount(0);
});

test('deleting a shared group warns first, then removes it from every item', async ({ page }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('button', { name: 'Delete Salsa', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Delete Salsa?' })).toBeVisible();
  await expect(page.getByText('Shared — affects 2 items:')).toBeVisible();
  await expect(page.getByText('Chipotle, Salsa verde, Pico de gallo')).toBeVisible();

  await page.getByRole('button', { name: /Delete Salsa and remove it/ }).click();
  await expect(page.getByRole('status')).toContainText('Salsa deleted');

  // Gone from both composers — and the items themselves still order.
  for (const path of ['/menu/burrito', '/menu/bowl']) {
    await page.goto(path);
    await expect(page.getByRole('checkbox', { name: /Chipotle/ })).toHaveCount(0);
  }
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart$/);
});

test('an order already placed keeps the price it was placed at', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Priya Nair');
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('confirmed-total')).toHaveText('$11.85');
  // The customer's own link, off the receipt — the surface they will re-open
  // AFTER the menu has moved under them.
  const statusUrl = (await page.getByTestId('track-order').getAttribute('href')) as string;

  // Reprice AND rename the thing it was composed from, after the fact.
  await retype(page, 'Burrito', '99.00');
  await page.getByRole('button', { name: 'Save new price for Burrito', exact: true }).click();

  // THE SNAPSHOT RULE. The receipt is a copy; the menu row is not its source.
  await page.goto(statusUrl);
  await expect(page.getByTestId('status-total')).toHaveText('$11.85');
  await page.goto('/kitchen');
  const card = page.getByRole('listitem').filter({ hasText: 'Priya Nair' }).first();
  await expect(card.getByText('$99.00')).toHaveCount(0);
});

test('the editor is usable one-handed on a phone', async ({ page }) => {
  await page.goto('/kitchen/menu');

  // Nothing scrolls sideways: a row that runs off a 390px screen is a row a
  // manager edits blind.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  for (const control of await page.getByRole('button').all()) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  }
  for (const field of await page.getByRole('textbox').all()) {
    const box = await field.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('the confirm panel itself is accessible', async ({ page }) => {
  await retype(page, 'Burrito', '12.50');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
