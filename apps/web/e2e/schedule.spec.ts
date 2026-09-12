import { expect, test } from '@playwright/test';
import { addBurritoToCart, card, reseed, setSchedulingEnabled } from './fixtures';

// C-114: order-ahead scheduling (master PRD P1-2).
//
// Off by default — the seeded database and every other spec in the suite run
// with `scheduledOrdersEnabled: false`, and the first claim here is the same
// one loyalty.spec.ts opens with: OFF must render nothing at all.

test.beforeEach(() => {
  reseed();
});

test('renders no picker while the feature is off, and ASAP still places', async ({ page }) => {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();

  await expect(page.getByRole('group', { name: 'When' })).toHaveCount(0);
  await expect(page.getByText(/pick a pickup time/i)).toHaveCount(0);

  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Robin Cole');
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();
  await expect(page.getByTestId('confirmed-pickup-time')).toHaveCount(0);
});

test('books a slot, and it shows on the confirmation and the kitchen queue', async ({ page }) => {
  await setSchedulingEnabled(true);

  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();

  const when = page.getByRole('group', { name: 'When' });
  await expect(when).toBeVisible();
  await when.getByRole('radio', { name: 'Pick a pickup time' }).check();
  const picker = when.getByRole('combobox');
  await expect(picker).toBeVisible();
  const chosen = await picker.locator('option').first().textContent();

  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Robin Cole');
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();

  // The confirmation says a pickup TIME, not the ASAP estimate — chosen must
  // be a real "HH:MM" label, since that is what `formatMinuteOfDay` produces
  // and what the `<option>` text is made of.
  expect(chosen).toMatch(/^\d{2}:\d{2}/);
  await expect(page.getByTestId('confirmed-pickup-time')).toContainText('Pickup at');

  // And the kitchen sees WHY this ticket is not "running late" the moment it
  // is placed, before anyone has touched it.
  await page.goto('/kitchen');
  await expect(card(page, 'Robin Cole')).toContainText('Pickup');

  // C-123. The badge used to be the whole answer, and it was only an
  // EXPLANATION sitting next to a contradiction: the card beneath it still
  // counted up from the counter and still reddened at fifteen minutes. Now the
  // ticket counts DOWN to the slot it asked for and claims nothing about
  // running late — which is the acceptance criterion, not the badge.
  await expect(card(page, 'Robin Cole')).toContainText(/Due in \d+ min/);
  await expect(card(page, 'Robin Cole').getByText(/running late/)).toHaveCount(0);
});

test('switches order-ahead on from its own settings screen', async ({ page }) => {
  await page.goto('/kitchen/settings');
  const toggle = page.getByRole('checkbox', { name: /Offer a pickup-time picker/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByRole('button', { name: 'Save order-ahead settings' }).click();
  await expect(page.getByTestId('settings-saved')).toContainText('Customers can now pick a pickup time');

  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await expect(page.getByRole('group', { name: 'When' })).toBeVisible();
});
