import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { reseed } from './fixtures';

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

// C-041: prep points (P1-7). Deliberately NOT behind the confirm panel — a
// weight is not money and no customer sees it, so the ceremony that guards a
// price would only teach staff to tap through it.
test('prep points save straight away, with no confirm step', async ({ page }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('spinbutton', { name: 'Prep points for Burrito', exact: true }).fill('5');
  await page.getByRole('button', { name: 'Save prep points for Burrito', exact: true }).click();

  await expect(page.getByRole('status')).toContainText('Burrito is now 5 prep points');
  await expect(
    page.getByRole('spinbutton', { name: 'Prep points for Burrito', exact: true }),
  ).toHaveValue('5');
});

test('a prep point that is not a whole number is refused, with the bound', async ({ page }) => {
  await page.goto('/kitchen/menu');
  const field = page.getByRole('spinbutton', { name: 'Prep points for Burrito', exact: true });
  // `type=number` steps in whole numbers and would refuse to submit this; the
  // server is what makes the rule true, so relax the step and post it anyway.
  // Deliberately NOT by switching the input to `type=text`: that changes its
  // ROLE, and the spinbutton locator then waits thirty seconds for an element
  // that no longer exists.
  await field.evaluate((input: HTMLInputElement) => input.setAttribute('step', 'any'));
  await field.fill('2.5');
  await page.getByRole('button', { name: 'Save prep points for Burrito', exact: true }).click();

  await expect(page.getByTestId('menu-error')).toContainText('0 to 50');
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

// C-026: the confirm panel showed a number. Saving is checked against it.
//
// The panel already re-reads the current value on every render (C-015), so a
// screen left open through someone else's edit shows the truth. What these
// cover is the window between that render and the tap — which is the one
// window a screen whose entire purpose is "here is the number you are
// replacing" must not apply a change across.
test('a price that moved between the confirm and the tap is refused, by value', async ({
  page,
  context,
}) => {
  await retype(page, 'Burrito', '109.50');
  await expect(page.getByText('Was $10.95, will be $109.50.')).toBeVisible();

  // Someone else, on the prep table's other phone.
  const other = await context.newPage();
  await other.goto('/kitchen/menu');
  await other.getByRole('textbox', { name: 'Price for Burrito', exact: true }).fill('11.50');
  await other.getByRole('button', { name: 'Review price for Burrito', exact: true }).click();
  await other.getByRole('button', { name: 'Save new price for Burrito', exact: true }).click();
  await expect(other.getByRole('status')).toContainText('$11.50');
  await other.close();

  // The first manager's confirm is now about a price that no longer exists.
  await page.getByRole('button', { name: 'Save new price for Burrito', exact: true }).click();
  await expect(page.getByTestId('menu-error')).toContainText('$11.50 now');
  await expect(page.getByTestId('menu-error')).toContainText('not the $10.95 you were shown');

  // And nothing was written: the other manager's price stands.
  await page.goto('/menu');
  await expect(page.getByRole('link', { name: /Burrito \$11\.50/ })).toBeVisible();
});

test('a group whose bounds moved under the confirm is refused', async ({ page, context }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('spinbutton', { name: 'Choose at least, Salsa' }).fill('1');
  await page.getByRole('button', { name: 'Review changes to Salsa', exact: true }).click();
  await expect(page.getByText('Shared — affects 2 items:')).toBeVisible();

  const other = await context.newPage();
  await other.goto('/kitchen/menu');
  await other.getByRole('spinbutton', { name: 'Choose at most, Salsa' }).fill('2');
  await other.getByRole('button', { name: 'Review changes to Salsa', exact: true }).click();
  await other.getByRole('button', { name: 'Save changes to Salsa' }).click();
  await expect(other.getByRole('status')).toContainText('Salsa updated');
  await other.close();

  await page.getByRole('button', { name: 'Save changes to Salsa' }).click();
  await expect(page.getByTestId('menu-error')).toContainText('choose 0 to 2');
});

test('an unchanged value still saves — the check is staleness, not paranoia', async ({ page }) => {
  await retype(page, 'Burrito', '12.50');
  await page.getByRole('button', { name: 'Save new price for Burrito', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Burrito is now priced at $12.50');
});

// C-027: the intensity surcharge — the last price in the system a manager
// could not change. "Extra cheese" costs the option's delta PLUS this.
test('the extra surcharge can be repriced, and the composer follows', async ({ page }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('textbox', { name: 'Extra surcharge for Cheese', exact: true }).fill('1.25');
  await page.getByRole('button', { name: 'Review extra surcharge for Cheese', exact: true }).click();

  await expect(page.getByText('Was $0.75, will be $1.25.')).toBeVisible();
  // The panel says what it is added to, because a surcharge alone is not a price.
  await expect(page.getByText('added ON TOP of +$0.50')).toBeVisible();

  await page.getByRole('button', { name: 'Save extra surcharge for Cheese', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Extra cheese is now $1.25');

  // Burrito 1095 + chicken 0 + cheese at extra (50 + 125) = 1270.
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
  await expect(page.getByTestId('line-total')).toHaveText('$12.70');
});

test('a blank surcharge makes extra free, and says so rather than showing $0.00', async ({
  page,
}) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('textbox', { name: 'Extra surcharge for Cheese', exact: true }).fill('');
  await page.getByRole('button', { name: 'Review extra surcharge for Cheese', exact: true }).click();

  // "free" is a different fact from "$0.00" — and it is the column's null.
  await expect(page.getByText('Was $0.75, will be free.')).toBeVisible();
  await page.getByRole('button', { name: 'Save extra surcharge for Cheese', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Extra cheese is now free');

  // Burrito 1095 + chicken 0 + cheese at extra (50 + 0) = 1145.
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
  await expect(page.getByTestId('line-total')).toHaveText('$11.45');
});

test('a negative surcharge is refused: extra must never make food cheaper', async ({ page }) => {
  await page.goto('/kitchen/menu');
  await page.getByRole('textbox', { name: 'Extra surcharge for Cheese', exact: true }).fill('-1.00');
  await page.getByRole('button', { name: 'Review extra surcharge for Cheese', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Nothing was changed' })).toBeVisible();
  await expect(page.getByText(/never negative/)).toBeVisible();
});

test('a group without intensity has no surcharge row at all', async ({ page }) => {
  await page.goto('/kitchen/menu');
  // Salsa and Toppings are intensity-enabled; Add-ons is not.
  await expect(
    page.getByRole('textbox', { name: 'Extra surcharge for Guacamole', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Extra surcharge for Chipotle', exact: true }),
  ).toBeVisible();
});
