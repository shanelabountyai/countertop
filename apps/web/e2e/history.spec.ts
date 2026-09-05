import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { backdateQueue, card, placeOrderFor, reseed, seedFinishedRush } from './fixtures';

// Staff order history (post-queue receipt lookup): every status, any day —
// the other half of P0-11's lookup, which is scoped to today's open orders.

test.beforeEach(() => {
  reseed();
});

test('finds an order by name and shows its full receipt, negation intact', async ({ page }) => {
  await page.goto('/kitchen/orders?q=Dana');
  const row = page.getByRole('link', { name: /#001/ });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Dana Reyes');

  await row.click();
  await expect(page.getByTestId('history-order-number')).toHaveText('#001');
  await expect(page.getByText('Dana Reyes')).toBeVisible();

  const negation = page.getByText('NO onions');
  await expect(negation).toBeVisible();
  const weight = await negation.evaluate((element) => getComputedStyle(element).fontWeight);
  expect(Number(weight)).toBeGreaterThanOrEqual(700);
});

test('finds the same order by its printed number', async ({ page }) => {
  await page.goto('/kitchen/orders?q=001');
  await expect(page.getByRole('link', { name: /Dana Reyes/ })).toBeVisible();
});

test('an empty search shows every order, and "Show all" clears a search', async ({ page }) => {
  await page.goto('/kitchen/orders?q=nobody-by-this-name');
  await expect(page.getByText('Nothing matches "nobody-by-this-name".')).toBeVisible();

  await page.getByRole('link', { name: 'Show all' }).click();
  await expect(page).toHaveURL('/kitchen/orders');
  await expect(page.getByRole('link', { name: /#001/ })).toBeVisible();
});

test('reaches an order that has already left the live queue', async ({ page }) => {
  seedFinishedRush();
  await page.goto('/kitchen/orders?q=Ada Nkemelu');
  const row = page.getByRole('link', { name: /Ada Nkemelu/ });
  await expect(row).toBeVisible();
  // Whatever terminal status a full rush left her in (picked up, cancelled or
  // a no-show), the whole point is that it is NOT one still on the live
  // queue — otherwise this test would pass even if history secretly only
  // reused `loadQueue()`.
  const text = await row.innerText();
  for (const openStatus of ['New', 'Accepted', 'Preparing', 'Ready for pickup']) {
    expect(text).not.toContain(openStatus);
  }
});

// The reason the search shows a dated LIST for a bare number rather than one
// order: `seq` resets every business day, so #001 exists on every day the
// restaurant opened. Picking the day is how you get from that list to the order.
test('a number that recurs across days is narrowed by picking one', async ({ page }) => {
  const earlier = await backdateQueue();
  await placeOrderFor(page, 'Wren Alvarez');

  // Both are #001 — one on the backdated day, one today.
  await page.goto('/kitchen/orders?q=001');
  await expect(page.getByRole('link', { name: /Dana Reyes/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Wren Alvarez/ })).toBeVisible();

  await page.goto(`/kitchen/orders?q=001&day=${earlier}`);
  await expect(page.getByRole('link', { name: /Dana Reyes/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Wren Alvarez/ })).toHaveCount(0);

  // And the day alone, with no term, is a day's service.
  await page.goto(`/kitchen/orders?day=${earlier}`);
  await expect(page.getByRole('link', { name: /Dana Reyes/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Wren Alvarez/ })).toHaveCount(0);

  await page.goto('/kitchen/orders?q=Dana&day=1999-01-01');
  await expect(page.getByText('Nothing matches "Dana" on 1999-01-01.')).toBeVisible();
});

// "Forget this customer" (PRD 6 P0-4, C-091). The only irreversible control in
// the product, so the confirm step is asserted as hard as the forget itself —
// a stray tap on a receipt must not destroy a customer's details.
test('forgets one customer from the receipt, and keeps the order', async ({ page }) => {
  await page.goto('/kitchen/orders?q=Dana');
  await page.getByRole('link', { name: /#001/ }).click();
  // Dana's line note is on the card and is about to go with the rest.
  await expect(page.getByText('Wrap it tight, it is going in a bike bag')).toBeVisible();

  // Step one is a confirm, and "Keep it" really keeps it. `exact` because the
  // confirm panel names her too — "This removes Dana Reyes's name…" — and a
  // substring locator matching the warning as well as the receipt would pass
  // this assertion for the wrong reason and fail the one below for the right
  // one.
  const name = page.getByText('Dana Reyes', { exact: true });
  await page.getByTestId('forget-customer').click();
  await expect(page.getByTestId('forget-confirm')).toBeVisible();
  await page.getByRole('link', { name: 'Keep it' }).click();
  await expect(page.getByTestId('forget-customer')).toBeVisible();
  await expect(name).toBeVisible();

  await page.getByTestId('forget-customer').click();
  await page.getByRole('button', { name: 'Forget them' }).click();

  await expect(page.getByTestId('already-forgotten')).toBeVisible();
  await expect(name).toHaveCount(0);
  await expect(page.getByText('Wrap it tight, it is going in a bike bag')).toHaveCount(0);
  // The order is still an order: its number, its money and its activity stay.
  await expect(page.getByTestId('history-order-number')).toHaveText('#001');
  await expect(page.getByTestId('order-activity')).toBeVisible();

  // And she is no longer findable by the name that was taken off.
  await page.goto('/kitchen/orders?q=Dana');
  await expect(page.getByText('Nothing matches "Dana".')).toBeVisible();
});

test('the history search and its receipt have no detectable accessibility violations', async ({
  page,
}) => {
  await page.goto('/kitchen/orders');
  const listResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(listResults.violations).toEqual([]);

  await page.getByRole('link', { name: /#001/ }).click();
  const detailResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(detailResults.violations).toEqual([]);

  // The forget confirm too: red on red-tinted white is where contrast goes
  // wrong, and it is the one panel a person must be able to read carefully.
  await page.getByTestId('forget-customer').click();
  const confirmResults = await new AxeBuilder({ page }).include('main').analyze();
  expect(confirmResults.violations).toEqual([]);
});

// These two are the only way back from a screen staff reach mid-shift, and
// they were 17px tall — the queue's own cards are held to 48.
test('the back links clear the same tap-target bar as the queue', async ({ page }) => {
  await page.goto('/kitchen/orders');
  const toQueue = await page.getByRole('link', { name: '← Queue' }).boundingBox();
  expect(toQueue?.height ?? 0).toBeGreaterThanOrEqual(48);

  await page.getByRole('link', { name: /#001/ }).click();
  const toHistory = await page.getByRole('link', { name: '← Order history' }).boundingBox();
  expect(toHistory?.height ?? 0).toBeGreaterThanOrEqual(48);
});

// The revert past the queue card (PRD 2 P0-4, C-061).
//
// The operator's finding: an order tapped picked-up by mistake is correctable
// for five seconds and then never again. The card is gone, and the one screen
// that still knows the order exists could not move it.
test('moves a no-show back onto the queue from its receipt, long after the undo', async ({
  page,
}) => {
  await placeOrderFor(page, 'Marguerite Okonkwo');

  // Out of the queue through the real buttons, ending on the no-show.
  await page.goto('/kitchen');
  const queueCard = card(page, 'Marguerite Okonkwo');
  for (const label of ['Accept', 'Start cooking', 'Food is ready']) {
    await queueCard.getByRole('button', { name: label, exact: true }).click();
  }
  await queueCard.getByRole('button', { name: 'No-show', exact: true }).click();

  // The five-second undo has expired by the time the receipt is read — which
  // is the whole premise. A reload is what a person actually does, and it
  // clears the holding slot and the "Just finished" strip together.
  await page.waitForTimeout(5_500);
  await page.reload();
  await expect(card(page, 'Marguerite Okonkwo')).toHaveCount(0);

  await page.goto('/kitchen/orders?q=Marguerite Okonkwo');
  await page.getByRole('link', { name: /Marguerite Okonkwo/ }).first().click();
  await expect(page.getByText('No-show', { exact: true })).toBeVisible();

  const revert = page.getByTestId('revert-panel');
  await revert.getByLabel('Why it is going back').selectOption('customer_returned');
  await revert.getByLabel('Anything to add (optional)').fill('came back at 8');
  await revert.getByRole('button', { name: 'Move back to Ready for pickup' }).click();

  // The order is back, and the log kept both facts rather than swapping one
  // for the other — the append-only trigger is the mechanism, this is the
  // screen that proves a person can see it.
  await expect(page.getByText('Ready for pickup', { exact: true }).first()).toBeVisible();
  const activity = page.getByTestId('order-activity');
  await expect(activity).toContainText('No-show');
  await expect(activity).toContainText('Moved back to Ready for pickup');
  await expect(activity).toContainText('Customer came back');
  await expect(activity).toContainText('came back at 8');

  // And it is on the live queue again, which is the point of moving it.
  await page.goto('/kitchen');
  await expect(card(page, 'Marguerite Okonkwo')).toBeVisible();
});

test('offers no revert on an order that is still in the queue', async ({ page }) => {
  await placeOrderFor(page, 'Tomas Lindqvist');
  await page.goto('/kitchen/orders?q=Tomas Lindqvist');
  await page.getByRole('link', { name: /Tomas Lindqvist/ }).first().click();

  // The queue card already carries "Move back" for an order it is drawing.
  // This control is the one for orders it is NOT — asked of the status
  // module, so `cancelled` (no previous status) never offers it either.
  await expect(page.getByTestId('revert-panel')).toHaveCount(0);
});
