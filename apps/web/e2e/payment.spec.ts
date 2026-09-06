import { expect, test } from '@playwright/test';
import { card, pickUp, placeOrderFor, reseed } from './fixtures';

// C-038: payment-state visibility (P1-8).
//
// The mock provider takes the money at checkout, or the customer chooses to pay
// at the counter — and it is the SECOND kind the kitchen has to see, because
// the bag leaving without the money is the failure this exists to prevent.
// Every order here is placed through the real checkout, so the flag on the card
// is the flag a real order would carry.

test.beforeEach(() => {
  reseed();
});

test('a pay-at-pickup order says so on the receipt and on the status page', async ({ page }) => {
  const link = await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });

  // The amount is on the line, not just the words: a customer who has to open
  // the receipt to find out what to bring will bring the wrong thing.
  await expect(page.getByTestId('confirmed-payment')).toHaveText('Pay at pickup — $11.85 due');

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Pay at pickup — $11.85 due');
});

// The name was 'Sam Okafor' until C-067, which is one of the four SEEDED
// customers — and the seed's Sam Okafor is a pay-at-pickup order. `card()` ends
// in `.first()`, so a duplicate name is a coin flip rather than a strict-mode
// violation: this passed only because a just-placed order sorts into "New",
// above the seed's "Accepted", and the two negative assertions below would have
// read the seeded card the moment that stopped being true. Found by the same
// collision breaking the refund spec outright.
// C-069 changed what "pay now" means end to end: the card is HELD at checkout
// and charged when the bag leaves. Both sentences are said to the customer,
// because "Paid" before anybody has cooked is a claim about their bank account
// that was not true.
test('a card held at checkout is charged when the bag leaves', async ({ page }) => {
  const link = await placeOrderFor(page, 'Iris Lindqvist');
  await expect(page.getByTestId('confirmed-payment')).toHaveText(
    'Card held — charged at pickup',
  );

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Card held — charged at pickup');

  // Nothing for the counter to take: a held card is not a debt, and offering
  // to collect cash on one is the double charge this item could have caused.
  await page.goto('/kitchen');
  const ticket = card(page, 'Iris Lindqvist');
  await expect(ticket).toBeVisible();
  await expect(ticket.getByText(/Pay at pickup/)).toHaveCount(0);
  await expect(ticket.getByRole('button', { name: /mark paid/i })).toHaveCount(0);

  // The pickup is the charge. No control, no confirmation — the customer
  // decided at checkout and this is the moment it becomes true.
  await pickUp(page, 'Iris Lindqvist');
  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Paid');
});

// The pickup-shaped answer to a no-show, and the reason the whole item exists:
// nothing left the card, so nothing has to go back.
test('a prepaid no-show releases the hold instead of refunding it', async ({ page }) => {
  const link = await placeOrderFor(page, 'Iris Lindqvist');

  await page.goto('/kitchen');
  for (const label of ['Accept', 'Start cooking', 'Food is ready']) {
    await card(page, 'Iris Lindqvist').getByRole('button', { name: label, exact: true }).click();
  }
  await card(page, 'Iris Lindqvist').getByRole('button', { name: 'No-show', exact: true }).click();
  // Wait for the SERVER to have finished, not for the click to have happened.
  // The hold is released after the status transaction commits, and navigating
  // away on the click alone renders the status page from before it — which is
  // what this test caught on its first run.
  await expect(page.getByRole('region', { name: 'Just finished' })).toContainText(
    'Iris Lindqvist',
  );

  // The customer is told the truth, and it is the reassuring one. Without this
  // sentence the page reads "Pay at pickup — $11.85 due" to somebody who paid
  // twenty minutes ago, which is the message that makes them phone.
  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText(
    'Card hold released — you were not charged',
  );

  // And nothing is owed back: no refund was asked for, so nothing is on the
  // list of refunds the restaurant has not sent.
  await page.goto('/kitchen/orders');
  await expect(page.getByTestId('refund-exceptions')).toHaveCount(0);
});

test('the kitchen card flags the unpaid order, and collecting clears it', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });

  await page.goto('/kitchen');
  const ticket = card(page, 'Robin Vale');
  const badge = ticket.getByText('Pay at pickup — $11.85');
  await expect(badge).toBeVisible();

  // Read at arm's length with greasy gloves, like every other control here.
  const collect = ticket.getByRole('button', { name: 'Collected — mark paid' });
  const box = await collect.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);

  await collect.click();
  await expect(badge).toHaveCount(0);
  await expect(collect).toHaveCount(0);

  // The flag is state, not a click that happened in this tab — a second screen
  // at the counter must not still be showing money owed.
  await page.reload();
  await expect(card(page, 'Robin Vale').getByText(/Pay at pickup/)).toHaveCount(0);
});

// The collect control used to live ONLY on a queue card, so an order handed
// over with the money not collected became permanently uncollectable the
// moment it left the queue: the till and the system disagreeing, with no
// screen able to reconcile them.
test('an order handed over unpaid can still be collected, from its receipt', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });
  await page.goto('/kitchen');
  await pickUp(page, 'Robin Vale');

  await page.goto('/kitchen/orders?q=Robin');
  await page.getByRole('link', { name: /Robin Vale/ }).click();
  await expect(page.getByText('Pay at pickup')).toBeVisible();

  // Held to the same bar as the button it replaces on the queue card.
  const collect = page.getByRole('button', { name: 'Collected — mark paid' });
  expect((await collect.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(48);
  await collect.click();

  await expect(collect).toHaveCount(0);
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();
  // State, not a click that happened in this tab.
  await page.reload();
  await expect(page.getByText('Paid', { exact: true })).toBeVisible();
});

test('a no-show has nothing to collect — nobody took the food', async ({ page }) => {
  await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });
  await page.goto('/kitchen');
  for (const label of ['Accept', 'Start cooking', 'Food is ready']) {
    await card(page, 'Robin Vale').getByRole('button', { name: label, exact: true }).click();
  }
  await card(page, 'Robin Vale').getByRole('button', { name: 'No-show', exact: true }).click();

  // Not in the undo strip it briefly sits in...
  const strip = page.getByRole('region', { name: 'Just finished' });
  await expect(strip.getByText('Robin Vale')).toBeVisible();
  await expect(strip.getByRole('button', { name: /mark paid/i })).toHaveCount(0);

  // ...and not on the receipt either. `unpaid` is the correct permanent answer
  // for food nobody came for.
  await page.goto('/kitchen/orders?q=Robin');
  await page.getByRole('link', { name: /Robin Vale/ }).click();
  await expect(page.getByText('Pay at pickup')).toBeVisible();
  await expect(page.getByRole('button', { name: /mark paid/i })).toHaveCount(0);
});

test('cancelling a paid order refunds it, and the customer is told', async ({ page }) => {
  // Paid at the counter, because since C-069 a prepaid order is HELD rather
  // than charged and a cancelled hold is released instead — which is its own
  // test above. A refund needs money that actually arrived.
  const link = await placeOrderFor(page, 'Jo Mercer', { payAtPickup: true });

  await page.goto('/kitchen');
  const ticket = card(page, 'Jo Mercer');
  await ticket.getByRole('button', { name: 'Collected — mark paid' }).click();
  await expect(ticket.getByRole('button', { name: 'Collected — mark paid' })).toHaveCount(0);

  await ticket.getByText('Cancel…').click();
  await ticket.getByRole('button', { name: 'Out of an item' }).click();
  // The write's own receipt: a cancelled order leaves the queue. Asserted
  // before navigating away, because a `goto` racing an in-flight server action
  // is the defect the shared fixtures exist for (C-025).
  await expect(page.getByText('Jo Mercer')).toHaveCount(0);

  await page.goto(link);
  await expect(page.getByTestId('status-payment')).toHaveText('Refunded');
});
