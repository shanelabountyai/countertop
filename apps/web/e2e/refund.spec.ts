import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { card, failRefundFor, placeOrderFor, reseed } from './fixtures';

// A refund that can fail (PRD 3 P0-4, C-067).
//
// What shipped before: cancelling a paid order wrote a `refund` event inside
// the cancellation's own transaction and flipped `paymentState` to `refunded`.
// Nothing was ever sent anywhere, so nothing could fail, so the one state a
// counter actually needs at 7:40 on a Friday — "we tried and it did not go
// through" — did not exist.
//
// The standard burrito is $11.85. Every figure below is that number.

test.beforeEach(() => {
  reseed();
});

// Deliberately NOT one of the four seeded names. `card()` and the history
// links both end in `.first()`, so a spec sharing a name with the seed silently
// asserts against whichever order happens to be higher up the page — which is
// how this test first passed its cancel and then failed on the card still being
// there. The one left was the seed's.
const RECEIPT = /Wren Alvarez/;

async function openReceipt(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/kitchen/orders');
  await page.getByRole('link', { name: RECEIPT }).first().click();
  await expect(page.getByTestId('history-order-number')).toBeVisible();
}

test('a refund that fails is money the shift can see, and send again', async ({ page }) => {
  const link = await placeOrderFor(page, 'Wren Alvarez');
  await failRefundFor('Wren Alvarez');

  // 1. THE EXCEPTIONS LIST. Unfiltered and above the search, because a
  //    customer whose card was never credited appears in no other list on any
  //    day under any status — there is nothing to think to search for.
  await page.goto('/kitchen/orders');
  const exceptions = page.getByTestId('refund-exceptions');
  await expect(exceptions).toBeVisible();
  await expect(exceptions).toContainText('Refunds not sent (1)');
  await expect(exceptions).toContainText('$11.85 owed');

  // 2. THE CUSTOMER IS NOT TOLD THEY HAVE BEEN PAID. The requirement's third
  //    bullet, from the one screen it is about.
  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText(
    'Refund pending — $11.85 coming back',
  );

  // 3. THE RECEIPT SAYS WHAT HAPPENED, in the provider's own words.
  await openReceipt(page);
  const panel = page.getByTestId('refund-panel');
  await expect(panel).toContainText('Refund owed — $11.85 not sent');
  await expect(page.getByTestId('order-activity')).toContainText('card network declined');
  // The payment line still reads Paid, which is TRUE — the restaurant is still
  // holding the money — and is the whole reason the panel above it exists.
  await expect(page.getByText('Refunded', { exact: true })).toHaveCount(0);

  // Read at arm's length with greasy gloves, like every other control here.
  const retry = page.getByTestId('retry-refund');
  expect((await retry.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);

  // 4. THE RETRY CLEARS IT — the same function, the same key, a working
  //    provider. A failure nobody can send again is a worse product than the
  //    silent success it replaced.
  await retry.click();
  await expect(page.getByTestId('refund-panel')).toHaveCount(0);
  await expect(page.getByTestId('order-activity')).toContainText('Refunded');

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Refunded');

  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toHaveCount(0);
});

test('a refund that works leaves nothing for anybody to chase', async ({ page }) => {
  const link = await placeOrderFor(page, 'Wren Alvarez');

  // Cancelled through the real buttons, with the real provider.
  await page.goto('/kitchen');
  const ticket = card(page, 'Wren Alvarez');
  await ticket.getByText('Cancel…').click();
  await ticket.getByRole('button', { name: 'Out of an item' }).click();
  await expect(ticket).toHaveCount(0);

  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Refunded');
});

test('the exceptions list is readable to a screen reader too', async ({ page }) => {
  await placeOrderFor(page, 'Wren Alvarez');
  await failRefundFor('Wren Alvarez');

  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
