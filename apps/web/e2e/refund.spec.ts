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

/**
 * The receipt's money sections, by their own heading (C-071).
 *
 * SCOPED, never `.first()`. The receipt now carries three money forms and two
 * of them have a field called Reason — an index-based locator here is the same
 * "whichever happens to be higher up the page" trap the RECEIPT constant above
 * was written about, and it is why this spec's first run comped nothing and
 * asserted against a refund form instead.
 */
const section = (page: import('@playwright/test').Page, heading: string) =>
  page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) });

async function openReceipt(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/kitchen/orders');
  await page.getByRole('link', { name: RECEIPT }).first().click();
  await expect(page.getByTestId('history-order-number')).toBeVisible();
}

test('a refund that fails is money the shift can see, and send again', async ({ page }) => {
  // Pay at pickup, collected at the counter by the fixture: since C-069 a
  // prepaid order carries a HOLD, and a cancelled hold is released rather than
  // refunded. A refund needs money that actually arrived.
  const link = await placeOrderFor(page, 'Wren Alvarez', { payAtPickup: true });
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
  const link = await placeOrderFor(page, 'Wren Alvarez', { payAtPickup: true });
  await openReceipt(page);
  await page.getByRole('button', { name: 'Collected — mark paid' }).click();

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

// PRD 3 P1-1 (C-069). The same cancellation on a PREPAID order costs nothing
// to send back, because nothing was ever taken — which is the whole item.
test('cancelling a prepaid order releases the hold instead of refunding it', async ({ page }) => {
  const link = await placeOrderFor(page, 'Wren Alvarez');

  await page.goto('/kitchen');
  const ticket = card(page, 'Wren Alvarez');
  await ticket.getByText('Cancel…').click();
  await ticket.getByRole('button', { name: 'Out of an item' }).click();
  await expect(ticket).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText(
    'Card hold released — you were not charged',
  );

  // No refund was asked for, so there is nothing on the list of refunds the
  // restaurant owes — no provider call to fail and nobody to chase.
  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toHaveCount(0);
  await openReceipt(page);
  await expect(page.getByTestId('order-activity')).toContainText('Card hold released');
  await expect(page.getByTestId('order-activity')).not.toContainText('Refund');
});

test('the exceptions list is readable to a screen reader too', async ({ page }) => {
  await placeOrderFor(page, 'Wren Alvarez', { payAtPickup: true });
  await failRefundFor('Wren Alvarez');

  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

// A refund that can be issued on purpose (PRD 3 P0-6, C-071).
//
// The half of the money story C-067 and C-068 both left behind. Cancelling was
// the only thing that could ask for a refund, and the state machine correctly
// refuses to cancel cooked food — so the orders where a refund is most
// obviously right were exactly the ones nothing on any screen could reach.
test('a comped order that already paid can actually get its money back', async ({ page }) => {
  // Collected at the counter, because a HELD card is not money the restaurant
  // can send back (C-069) — it is money it has not taken.
  const link = await placeOrderFor(page, 'Wren Alvarez', { payAtPickup: true });
  await openReceipt(page);
  await page.getByRole('button', { name: 'Collected — mark paid' }).click();

  const makeItRight = section(page, 'Make it right');
  const sendBack = section(page, 'Send money back');

  // Comp it in full — the C-065 control, on an order that has already paid.
  await makeItRight.getByLabel('Reason').selectOption('quality');
  await makeItRight.getByRole('button', { name: 'Comp the whole order' }).click();

  // NOTHING OWED AND THE MONEY STILL IN THE TILL. Both sentences are true, and
  // before this item only the first one had anywhere to be said.
  await expect(page.getByTestId('history-outstanding')).toHaveText('$0.00');
  await expect(sendBack).toBeVisible();

  // Over the bound is REFUSED, not clamped — a mistyped 50 must not quietly
  // become a legal $11.85 that nobody is told about until the till is counted.
  await sendBack.getByLabel('Reason').selectOption('quality');
  await page.getByTestId('refund-amount').fill('50.00');
  await page.getByTestId('send-refund').click();
  await expect(page.getByTestId('refund-error')).toContainText('$11.85');

  // Part of it, which is the thing the enum could never say.
  await sendBack.getByLabel('Reason').selectOption('quality');
  await page.getByTestId('refund-amount').fill('5.00');
  await page.getByTestId('send-refund').click();
  await expect(page.getByTestId('order-activity')).toContainText('Refunded');
  // THE ENUM IS STILL "PAID", correctly: $6.85 of the customer's money is
  // still here, and `refunded` means every captured cent went back. This is
  // the sentence the three-value enum cannot say and the balance can — and the
  // reason `settleRefund` now writes this column from the log rather than
  // compare-and-setting it to a literal.
  await expect(page.getByTestId('staff-payment-state')).toHaveText('Paid');

  // And the rest, which does flip the customer-facing copy.
  await sendBack.getByLabel('Reason').selectOption('quality');
  await page.getByTestId('refund-amount').fill('6.85');
  await page.getByTestId('send-refund').click();
  await expect(page.getByTestId('send-refund')).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Refunded');

  // Nothing was left owing anywhere: two settled refunds, no exception.
  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toHaveCount(0);
});

// PRD 3 P0-5's other half, which C-068 named and deliberately did not build: a
// no-show is NOT automatically a refund — the food was made — so it has to be
// an offer, and the offer needed this control to exist.
test('a no-show is offered a refund rather than given one', async ({ page }) => {
  // Paid at the counter before the no-show, which since C-069 is the only way
  // an abandoned order is holding money at all: a prepaid one has its hold
  // released, and that is P1-1's answer to exactly this customer.
  await placeOrderFor(page, 'Wren Alvarez', { payAtPickup: true });
  await openReceipt(page);
  await page.getByRole('button', { name: 'Collected — mark paid' }).click();

  await page.goto('/kitchen');
  const ticket = card(page, 'Wren Alvarez');
  for (const label of ['Accept', 'Start cooking', 'Food is ready']) {
    await ticket.getByRole('button', { name: label }).click();
  }
  await ticket.getByRole('button', { name: 'No-show' }).click();

  await openReceipt(page);
  // Nothing happened to the money on its own. That is the requirement.
  await expect(page.getByTestId('order-activity')).not.toContainText('Refunded');
  await expect(page.getByTestId('abandoned-refund-offer')).toBeVisible();

  const sendBack = section(page, 'Send money back');
  await sendBack.getByLabel('Reason').selectOption('other');
  await sendBack.getByLabel('Note').fill('called twice, no answer');
  await page.getByTestId('refund-amount').fill('11.85');
  await page.getByTestId('send-refund').click();
  await expect(page.getByTestId('order-activity')).toContainText('Refunded');
});

// A mistaken comp is corrected by a CONTRADICTING ROW, never a delete — the
// log is append-only, and C-065 and C-066 both deferred this saying so.
test('a comp written on the wrong ticket is put back, not erased', async ({ page }) => {
  await placeOrderFor(page, 'Wren Alvarez', { payAtPickup: true });
  await openReceipt(page);

  const makeItRight = section(page, 'Make it right');
  await makeItRight.getByLabel('Reason').selectOption('wrong_item');
  await makeItRight.getByRole('button', { name: 'Comp the whole order' }).click();
  await expect(page.getByTestId('history-outstanding')).toHaveText('$0.00');

  // The comp took the whole order, so Make it right is gone and this is the
  // only adjustment control left on the screen — which is why it is its own
  // section rather than a third button in that form.
  await expect(section(page, 'Make it right')).toHaveCount(0);
  await expect(section(page, 'Put an adjustment back')).toBeVisible();

  // Bounded by what was actually taken off, and refused over it.
  await page.getByTestId('reversal-amount').fill('20.00');
  await page.getByTestId('reversal-note').fill('comped the wrong ticket');
  await page.getByTestId('reverse-adjustment').click();
  await expect(page.getByTestId('reversal-error')).toContainText('$11.85');

  await page.getByTestId('reversal-amount').fill('11.85');
  await page.getByTestId('reversal-note').fill('comped the wrong ticket');
  await page.getByTestId('reverse-adjustment').click();

  // The money is owed again — and BOTH decisions are still in the log, which
  // is the whole reason this is a row rather than a delete.
  await expect(page.getByTestId('history-total')).toHaveText('$11.85');
  const activity = page.getByTestId('order-activity');
  await expect(activity).toContainText('Adjusted');
  await expect(activity).toContainText('Adjustment put back');
  await expect(activity).toContainText('comped the wrong ticket');
});
