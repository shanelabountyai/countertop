import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addBurritoToCart, loyaltyMembers, reseed, setLoyaltyEnabled } from './fixtures';

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
