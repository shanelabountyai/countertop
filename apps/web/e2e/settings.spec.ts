import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { reseed } from './fixtures';

// C-023: the operator's settings.
//
// Every value here was a column with a CHECK constraint and no way to change
// it short of SQL. What is proved below is that a save reaches the GATE — the
// customer-facing answer — and not merely the form it was typed into.

// The seed opens every day 00:00–00:00 (all day) so the suite never depends on
// the wall-clock hour. These tests change that on purpose and put it back.
test.beforeEach(() => {
  reseed();
});

test('closing for today shuts the door, and reopening opens it again', async ({ page }) => {
  await page.goto('/kitchen/settings');
  await page.getByRole('button', { name: 'Close for today' }).click();
  await expect(page.getByTestId('settings-saved')).toContainText('Closed for');

  // The customer's checkout is the assertion, not the settings screen.
  await page.goto('/checkout');
  await expect(page.getByText('We are closed today.')).toBeVisible();

  await page.goto('/kitchen/settings');
  await page.getByRole('button', { name: 'Reopen today' }).click();
  await expect(page.getByTestId('settings-saved')).toContainText('Reopened');

  await page.goto('/checkout');
  await expect(page.getByText('We are closed today.')).toHaveCount(0);
});

test('unticking a day closes the restaurant on it, and the week saves as a week', async ({
  page,
}) => {
  await page.goto('/kitchen/settings');

  // Close every day. A day with no row is a closed day.
  for (const day of ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']) {
    await page.getByRole('checkbox', { name: day }).uncheck();
  }
  await page.getByRole('button', { name: 'Save hours' }).click();
  await expect(page.getByTestId('settings-saved')).toContainText('closed every day');

  // With no day open at all the gate has no next opening to name, and says
  // so rather than inventing one.
  await page.goto('/checkout');
  await expect(page.getByText('Online ordering is closed right now.')).toBeVisible();
});

test('a closing time that is not after its opening is refused, by name', async ({ page }) => {
  await page.goto('/kitchen/settings');
  await page.getByRole('checkbox', { name: 'Wednesday' }).check();
  await page.getByRole('textbox', { name: 'Wednesday opens' }).fill('18:00');
  await page.getByRole('textbox', { name: 'Wednesday closes' }).fill('11:00');
  await page.getByRole('button', { name: 'Save hours' }).click();

  // The message names the DAY and both times — a generic "invalid hours" makes
  // a manager check all seven rows.
  await expect(page.getByTestId('settings-error')).toContainText('Wednesday closes at 11:00');
  await expect(page.getByTestId('settings-error')).toContainText('opens at 18:00');
});

test('the service numbers reach the estimate a customer is quoted', async ({ page }) => {
  await page.goto('/kitchen/settings');
  await page.getByRole('spinbutton', { name: /A ticket takes/ }).fill('40');
  await page.getByRole('spinbutton', { name: /Add/ }).fill('0');
  await page.getByRole('button', { name: 'Save service settings' }).click();
  await expect(page.getByTestId('settings-saved')).toContainText('Service settings saved');

  // A range around 40 minutes, not the seeded 12 — and never a point.
  await page.goto('/menu/chips');
  await page.getByRole('button', { name: /Add to cart/ }).click();
  // Wait for the cart cookie to LAND before navigating. A `goto` racing the
  // server action arrives at an empty checkout, which this project has now
  // been bitten by three times (C-014, C-015, C-019) and has a rule about.
  await expect(page).toHaveURL(/\/cart$/);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByTestId('ready-estimate')).toContainText('40');
});

test('a number outside its constraint is refused with the bound in the message', async ({
  page,
}) => {
  await page.goto('/kitchen/settings');
  // `type=number` with a max would normally block this; the server is what
  // makes it true, so post it anyway by removing the attribute.
  const field = page.getByRole('spinbutton', { name: /Add/ });
  await field.evaluate((input: HTMLInputElement) => input.removeAttribute('max'));
  await field.fill('900');
  await page.getByRole('button', { name: 'Save service settings' }).click();

  await expect(page.getByTestId('settings-error')).toContainText('0 to 60');
});

test('the settings screen has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/kitchen/settings');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
