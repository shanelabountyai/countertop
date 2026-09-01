import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { card, reseed } from './fixtures';

// C-086 / PRD 6 P0-2: a name on the row.
//
// The engine and the column are proved in packages/db/staff.test.ts. What is
// proved HERE is the loop a shift actually goes round — somebody signs on at
// the start of service, the taps they make carry their name, and the receipt
// that settles a dispute says so. The seeded orders were placed by a script
// with nobody on shift, which is also the shape of every event written before
// this item, so the "not recorded" case is on the same screen for free.

test.beforeEach(() => {
  reseed();
});

const shiftBar = (page: Page) => page.getByTestId('shift-signon');
const onShift = (page: Page) => page.getByTestId('on-shift');
const activity = (page: Page) => page.getByTestId('order-activity');

async function startShift(page: Page, pin: string) {
  await shiftBar(page).getByLabel('Staff PIN').fill(pin);
  await shiftBar(page).getByRole('button', { name: 'Start shift' }).click();
}

test('a shift is signed on once, and every tap after it carries the name', async ({ page }) => {
  await page.goto('/kitchen');
  // The honest default is said out loud rather than left blank: work happens
  // with nobody signed on and the log simply will not know who did it.
  await expect(shiftBar(page)).toContainText('Nobody on shift');

  await startShift(page, '1234');
  await expect(onShift(page)).toContainText('Noor Haddad');
  // A PIN once per shift, not once per tap: the card's own controls are
  // unchanged, which is the point — thirty orders in twenty minutes makes a
  // per-tap prompt something staff route around within a day.
  await card(page, 'Dana Reyes').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card(page, 'Dana Reyes').getByRole('button', { name: 'Accept' })).toHaveCount(0);

  await page.goto('/kitchen/orders?q=Dana');
  await page.getByRole('link', { name: /#001/ }).click();

  const accepted = activity(page).getByRole('listitem').filter({ hasText: 'Moved to Accepted' });
  await expect(accepted).toContainText('Noor Haddad');
  // And the rows the seed wrote, with nobody on shift, say so instead of
  // borrowing whoever happens to be signed on now.
  await expect(activity(page).getByRole('listitem').first()).toContainText('Order placed');
  await expect(activity(page).getByRole('listitem').first()).toContainText('Customer');
});

test('two people on one tablet are two names in the log', async ({ page }) => {
  await page.goto('/kitchen');
  await startShift(page, '1234');
  await card(page, 'Dana Reyes').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card(page, 'Dana Reyes').getByRole('button', { name: 'Accept' })).toHaveCount(0);

  // The handover: Theo takes the pass. Ending a shift is not signing out — the
  // queue stays on the wall, which is why the passcode session is untouched.
  await onShift(page).getByRole('button', { name: 'End shift' }).click();
  await expect(shiftBar(page)).toBeVisible();
  await startShift(page, '5678');
  await expect(onShift(page)).toContainText('Theo Barnes');

  await card(page, 'Dana Reyes').getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(card(page, 'Dana Reyes').getByRole('button', { name: 'Start cooking' })).toHaveCount(0);

  await page.goto('/kitchen/orders?q=Dana');
  await page.getByRole('link', { name: /#001/ }).click();
  await expect(
    activity(page).getByRole('listitem').filter({ hasText: 'Moved to Accepted' }),
  ).toContainText('Noor Haddad');
  await expect(
    activity(page).getByRole('listitem').filter({ hasText: 'Moved to Preparing' }),
  ).toContainText('Theo Barnes');
});

test('a PIN nobody has is refused, and says nothing about who exists', async ({ page }) => {
  await page.goto('/kitchen');
  await startShift(page, '0000');
  await expect(shiftBar(page)).toContainText('That PIN did not match anybody on the list.');
  await expect(onShift(page)).toHaveCount(0);
});

test('somebody who has left cannot start a shift, and is told nothing extra', async ({ page }) => {
  // Wes is deactivated in the seed. The message is the same one a wrong PIN
  // gets: whether a person exists is not something a keypad should teach.
  await page.goto('/kitchen');
  await startShift(page, '9012');
  await expect(shiftBar(page)).toContainText('That PIN did not match anybody on the list.');
});

test('the shift control clears the same tap-target bar as the queue', async ({ page }) => {
  await page.goto('/kitchen');
  // Both dimensions, and on the sign-on form AND the signed-on state — a
  // control on the queue screen is a control with gloves on it, and every
  // previous miss in this project was a target nobody had measured.
  for (const locator of [
    shiftBar(page).getByLabel('Staff PIN'),
    shiftBar(page).getByRole('button', { name: 'Start shift' }),
  ]) {
    const box = await locator.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
  }

  await startShift(page, '1234');
  const end = await onShift(page).getByRole('button', { name: 'End shift' }).boundingBox();
  expect(end?.height ?? 0).toBeGreaterThanOrEqual(48);
  expect(end?.width ?? 0).toBeGreaterThanOrEqual(48);
});

test('the shift control and the activity log have no accessibility violations', async ({ page }) => {
  await page.goto('/kitchen');
  await startShift(page, '1234');
  await card(page, 'Dana Reyes').getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(card(page, 'Dana Reyes').getByRole('button', { name: 'Accept' })).toHaveCount(0);

  const queue = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(queue.violations).toEqual([]);

  await page.goto('/kitchen/orders?q=Dana');
  await page.getByRole('link', { name: /#001/ }).click();
  await expect(activity(page)).toBeVisible();
  const receipt = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(receipt.violations).toEqual([]);
});
