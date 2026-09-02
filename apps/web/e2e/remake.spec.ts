import { expect, test } from '@playwright/test';
import { pickUp, placeOrderFor, reseed } from './fixtures';

// The remake link (PRD 3 P0-3, C-066), decision 7 of 2026-09-02.
//
// Ivy is back at the counter with an order she got wrong. The thing that had
// to be true, and could not be before, is that the KITCHEN gets a ticket —
// a remake nobody is told to cook is the transcription failure this product
// exists to kill.

test.beforeEach(() => {
  reseed();
});

async function openReceipt(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto(`/kitchen/orders?q=${encodeURIComponent(name)}`);
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByTestId('history-order-number')).toBeVisible();
}

test('a remake puts a new ticket on the line, comped, linked both ways', async ({ page }) => {
  await placeOrderFor(page, 'Ivy Castellanos', { payAtPickup: true });
  await page.goto('/kitchen');
  await pickUp(page, 'Ivy Castellanos');

  await openReceipt(page, 'Ivy Castellanos');
  // Held, because a second order for the same name is about to exist and a
  // `.first()` lookup would stop meaning the original.
  const originalUrl = page.url();
  const originalNumber = (await page.getByTestId('history-order-number').textContent())?.trim();
  expect(originalNumber).toBeTruthy();

  await page.getByLabel('What went wrong').selectOption('wrong_item');
  await page.getByLabel('Note for the line').fill('onions off, cut in half');
  await page.getByRole('button', { name: 'Remake it' }).click();

  // WAIT for the action to land before reading anything. `click()` returns
  // before the redirect, and a bare `textContent()` reads the page we were on
  // — which is the same defect class fixtures.ts exists for, and it made this
  // test read the original's number and call it the remake's.
  await expect(page.getByTestId('order-activity')).toContainText('Remade from');

  // We land on the NEW order — the next thing that happens is a ticket going
  // to the line, and the number to call out is this one.
  const remakeNumber = (await page.getByTestId('history-order-number').textContent())?.trim();
  expect(remakeNumber).not.toBe(originalNumber);

  // Same money on the ticket, and nothing owed on it.
  await expect(page.getByTestId('history-total')).toHaveText('$11.85');
  await expect(page.getByTestId('history-outstanding')).toHaveText('$0.00');
  await expect(page.getByRole('button', { name: 'Collected — mark paid' })).toHaveCount(0);

  // The link, read from the remake's end.
  await expect(page.getByTestId('order-activity')).toContainText(originalNumber!);

  // And from the original's end. By URL, not by search: there are two orders
  // called Ivy Castellanos now, which is the whole point.
  await page.goto(originalUrl);
  await expect(page.getByTestId('remade-as')).toContainText(remakeNumber!);

  // THE POINT: the kitchen has something to cook, and the correction is ON it.
  // Scoped by NUMBER, not by name — there are two Ivy Castellanos orders now,
  // and the original is still on screen inside its undo window.
  await page.goto('/kitchen');
  const ticket = page.getByRole('listitem').filter({ hasText: remakeNumber! });
  await expect(ticket).toBeVisible();
  await expect(ticket).toContainText('REMAKE: onions off, cut in half');
  // (That the customer's OWN note survives beside the correction is asserted
  // in packages/db/remake.test.ts, where the fixture actually has one — this
  // flow's shared `placeOrderFor` places no note.)
});

test('a comped order can still be remade — money and food are separate decisions', async ({
  page,
}) => {
  await placeOrderFor(page, 'Ivy Castellanos', { payAtPickup: true });
  await openReceipt(page, 'Ivy Castellanos');

  // Give her the money back first. The adjust section then disappears,
  // because there is nothing left to adjust.
  await page.getByLabel('Reason').selectOption('quality');
  await page.getByRole('button', { name: 'Comp the whole order' }).click();
  await expect(page.getByTestId('history-adjusted')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Comp the whole order' })).toHaveCount(0);

  // The remake must survive that. It is the PRD's own scenario: she gets her
  // money back AND a new torta.
  await page.getByLabel('What went wrong').selectOption('quality');
  await page.getByRole('button', { name: 'Remake it' }).click();
  await expect(page.getByTestId('order-activity')).toContainText('Remade from');
});

test('the remake is not counted as a second sale', async ({ page }) => {
  await placeOrderFor(page, 'Ivy Castellanos', { payAtPickup: true });
  await openReceipt(page, 'Ivy Castellanos');
  await page.getByLabel('What went wrong').selectOption('wrong_item');
  await page.getByRole('button', { name: 'Remake it' }).click();
  // Land the write before navigating away. A `goto` that races a server
  // action is the C-019 defect, and it is why fixtures.ts has a guard.
  await expect(page.getByTestId('order-activity')).toContainText('Remade from');

  await page.goto('/kitchen/report');
  // One remake, and the food is not double counted. The report's own copy is
  // asserted in the db suite; here it only has to be reachable and truthful.
  await expect(page.getByTestId('report-remakes')).toHaveText('1');
});
