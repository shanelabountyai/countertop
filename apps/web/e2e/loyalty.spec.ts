import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  addBurritoToCart,
  adjustLoyaltyPoints,
  loyaltyMembers,
  pickUp,
  reseed,
  setLoyaltyEnabled,
} from './fixtures';

// C-101: enrolment (PRD 7 P0-1).
//
// Two claims, and the first one matters more than the second: with the program
// OFF — which is the default and the state the other ninety-odd specs run
// against — the customer flow renders exactly what it rendered before loyalty
// existed. Then, with it on, a phone typed two ways across two orders is one
// member and the number itself is nowhere in the table.

const PHONE = '(555) 010-2233';

test.beforeEach(() => {
  reseed();
});

test('renders nothing at all while the program is off', async ({ page }) => {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();

  // Not "hidden" — absent. A checkbox rendered and hidden is still read by a
  // screen reader and still submitted by a form.
  await expect(page.getByRole('group', { name: 'Punch card' })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: /Collect points/ })).toHaveCount(0);
  await expect(page.getByText(/punch card|collect points|points per dollar/i)).toHaveCount(0);

  // And the order still places, with a phone, writing no ledger row anywhere.
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Ivy Castellanos');
  await page.getByRole('textbox', { name: /Phone/ }).fill(PHONE);
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();
  expect(await loyaltyMembers()).toEqual([]);
});

test('enrols on a ticked box, and the same phone typed two ways is one member', async ({
  page,
}) => {
  await setLoyaltyEnabled(true);

  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();

  const join = page.getByRole('checkbox', { name: /Collect points/ });
  // Disabled until there is a phone to count the punch card against — asked of
  // the same function the server enrols with, so this cannot be a box that
  // ticks and does nothing.
  await expect(join).toBeDisabled();
  await expect(page.getByText(/Add your phone number above to join/)).toBeVisible();

  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Ivy Castellanos');
  await page.getByRole('textbox', { name: /Phone/ }).fill('555-010');
  await expect(join).toBeDisabled();

  await page.getByRole('textbox', { name: /Phone/ }).fill(PHONE);
  await expect(join).toBeEnabled();
  // Unchecked by default: ordering without the punch card is a first-class
  // path and there is no interstitial and no second screen.
  await expect(join).not.toBeChecked();
  // The copy says what is kept and for how long (P0-1).
  await expect(page.getByText(/one-way code, not the number itself/)).toBeVisible();
  await expect(page.getByText(/365 days, the points expire/)).toBeVisible();

  await join.check();
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();
  // Told, at last (C-103). C-101 and C-102 both shipped with a customer who
  // ticked the box and heard nothing back.
  await expect(page.getByTestId('enrolled-confirmation')).toContainText('on the punch card');

  const [member] = await loyaltyMembers();
  expect(member).toMatchObject({ phoneLast4: '2233', displayName: 'Ivy Castellanos' });
  // The number is not in the table. Only the last four, which is not one.
  expect(JSON.stringify(member)).not.toContain('5550102233');
  expect(member?.phoneDigest).toHaveLength(64);

  // Back the next day, typing it the other way: still one member.
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Ivy C');
  await page.getByRole('textbox', { name: /Phone/ }).fill('5550102233');
  await page.getByRole('checkbox', { name: /Collect points/ }).check();
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();

  const members = await loyaltyMembers();
  expect(members).toHaveLength(1);
  // And the returning customer keeps the name they enrolled under.
  expect(members[0]?.displayName).toBe('Ivy Castellanos');
});

test('the enrolment control is reachable and labelled', async ({ page }) => {
  await setLoyaltyEnabled(true);
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Phone/ }).fill(PHONE);
  await expect(page.getByRole('checkbox', { name: /Collect points/ })).toBeEnabled();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});

// C-103: the counter panel (PRD 7's staff-receipt view of a member).
//
// Read-only, and the only screen where a balance exists to be read at all. The
// counter is holding a phone number it deliberately cannot see, so what it
// gets is the last four and a name — "the one ending 2233, Ivy" — which is
// what a person confirms out loud.

/** Place an order that joins the punch card, and hand back the name used. */
async function placeAsMember(page: Page, name: string): Promise<void> {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill(name);
  await page.getByRole('textbox', { name: /Phone/ }).fill(PHONE);
  await page.getByRole('checkbox', { name: /Collect points/ }).check();
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();
}

async function openReceipt(page: Page, name: string): Promise<void> {
  await page.goto(`/kitchen/orders?q=${encodeURIComponent(name)}`);
  await page.getByRole('link', { name: new RegExp(name) }).first().click();
  await expect(page.getByTestId('history-order-number')).toBeVisible();
}

test('the counter reads a balance the pickup earned', async ({ page }) => {
  await setLoyaltyEnabled(true);
  await placeAsMember(page, 'Ivy Castellanos');

  // Nothing yet — the points are earned at pickup, which is the whole of
  // C-102 restated from the screen's side.
  await openReceipt(page, 'Ivy Castellanos');
  await expect(page.getByTestId('member-panel')).toContainText('Ivy Castellanos');
  await expect(page.getByTestId('member-balance')).toHaveText('0 points');

  await page.goto('/kitchen');
  await pickUp(page, 'Ivy Castellanos');

  await openReceipt(page, 'Ivy Castellanos');
  // $10.95 of burrito, floored: ten points, and the tax earned nothing.
  await expect(page.getByTestId('member-balance')).toHaveText('10 points');
  await expect(page.getByTestId('member-panel')).toContainText('ending 2233');
  await expect(page.getByTestId('member-reward')).toHaveText('90 points to the next reward');

  // Ninety more, as a staff correction, and the offer changes. The panel sums
  // the ledger rather than reading a column, so this is the same arithmetic
  // the balance always was.
  await adjustLoyaltyPoints(90);
  await openReceipt(page, 'Ivy Castellanos');
  await expect(page.getByTestId('member-balance')).toHaveText('100 points');
  await expect(page.getByTestId('member-reward')).toContainText('Reward available');
  await expect(page.getByTestId('member-reward')).toContainText('$10.00');

  // Read-only: spending it is C-104's, and a panel that implies a control it
  // does not have is worse than one that admits it.
  await expect(page.getByRole('button', { name: /reward/i })).toHaveCount(0);
});

test('the staff receipt says nothing about punch cards while the program is off', async ({
  page,
}) => {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Robin Vale');
  await page.getByRole('textbox', { name: /Phone/ }).fill(PHONE);
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();
  await expect(page.getByTestId('enrolled-confirmation')).toHaveCount(0);

  await page.goto('/kitchen');
  await pickUp(page, 'Robin Vale');

  // A phone on the order, a pickup that happened, and still no panel: the
  // lookup is not even attempted with the program off.
  await openReceipt(page, 'Robin Vale');
  await expect(page.getByTestId('member-panel')).toHaveCount(0);
  await expect(page.getByText(/punch card|points/i)).toHaveCount(0);
});
