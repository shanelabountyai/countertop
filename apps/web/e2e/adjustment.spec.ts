import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { card, pickUp, placeOrderFor, reseed } from './fixtures';

// Making it right (PRD 3 P0-3, C-065).
//
// The operator's complaint was that there is no way to. Cooked food cannot be
// cancelled — correctly, and the state machine goes on refusing — so the
// counter comped off-system and the till and the report disagreed by an amount
// nobody wrote down.
//
// The standard burrito is $11.85 at pay-at-pickup. Every figure below is that
// number and arithmetic on it.

test.beforeEach(() => {
  reseed();
});

/** Land on the staff receipt for a just-placed order. */
async function openReceipt(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto(`/kitchen/orders?q=${encodeURIComponent(name)}`);
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByTestId('history-order-number')).toBeVisible();
}

test('comps a picked-up order without touching the total', async ({ page }) => {
  const link = await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });

  // Walk it all the way out of the queue first. `picked_up` is one of the two
  // states the product had no money control for at all, and it is exactly
  // where a wrong order gets discovered.
  await page.goto('/kitchen');
  await pickUp(page, 'Robin Vale');

  await openReceipt(page, 'Robin Vale');
  await expect(page.getByTestId('history-total')).toHaveText('$11.85');

  await page.getByLabel('Reason').selectOption('quality');
  await page.getByRole('button', { name: 'Comp the whole order' }).click();

  // The snapshot is untouched and the adjustment sits BESIDE it.
  await expect(page.getByTestId('history-total')).toHaveText('$11.85');
  await expect(page.getByTestId('history-adjusted')).toHaveText('−$11.85');
  await expect(page.getByTestId('history-outstanding')).toHaveText('$0.00');

  // Nothing left to collect, and nothing left to adjust.
  await expect(page.getByRole('button', { name: 'Collected — mark paid' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Comp the whole order' })).toHaveCount(0);

  // The log says what happened, for how much, and who — the receipt is where a
  // disputed comp is read.
  const activity = page.getByTestId('order-activity');
  await expect(activity).toContainText('Adjusted');
  await expect(activity).toContainText('$11.85');
  await expect(activity).toContainText('Quality');

  // And the customer is told honestly, without the reason.
  await page.goto(link);
  await expect(page.getByTestId('status-total')).toHaveText('$11.85');
  await expect(page.getByTestId('status-adjusted')).toHaveText('−$11.85');
  await expect(page.getByTestId('status-payment')).toHaveText('Nothing to pay');
  await expect(page.getByText(/Quality/)).toHaveCount(0);
});

test('a partial leaves the remainder, and the counter collects exactly that', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });

  await openReceipt(page, 'Robin Vale');
  await page.getByLabel('Reason').selectOption('late');
  await page.getByLabel('Amount to take off, in dollars').fill('3.00');
  await page.getByRole('button', { name: 'Take off' }).click();

  await expect(page.getByTestId('history-total')).toHaveText('$11.85');
  await expect(page.getByTestId('history-outstanding')).toHaveText('$8.85');

  // The queue card asks the same one function, so it says the same number.
  await page.goto('/kitchen');
  await expect(card(page, 'Robin Vale').getByText('Pay at pickup — $8.85')).toBeVisible();
});

test('refuses more than the order is worth, by name, and writes nothing', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });
  await openReceipt(page, 'Robin Vale');

  await page.getByLabel('Reason').selectOption('wrong_item');
  await page.getByLabel('Amount to take off, in dollars').fill('50.00');
  await page.getByRole('button', { name: 'Take off' }).click();

  // Refused, not clamped to $11.85 — and the message names the bound, because
  // a silent clamp is how the counter finds out at close instead of now.
  await expect(page.getByTestId('adjust-error')).toContainText('$11.85');
  await expect(page.getByTestId('history-adjusted')).toHaveCount(0);
  await expect(page.getByTestId('history-total')).toHaveText('$11.85');
});

test('"other" without a note is refused, because it is the row nobody can act on', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });
  await openReceipt(page, 'Robin Vale');

  await page.getByLabel('Reason').selectOption('other');
  await page.getByRole('button', { name: 'Comp the whole order' }).click();

  await expect(page.getByTestId('adjust-error')).toContainText('Say what happened');
  await expect(page.getByTestId('history-adjusted')).toHaveCount(0);
});

test('the control is reachable with gloves on, and the receipt stays accessible', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });
  await openReceipt(page, 'Robin Vale');

  // ≥48px, like every other control staff touch (P0-11).
  for (const name of ['Comp the whole order', 'Take off']) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  }

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
