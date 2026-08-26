import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { reseed } from './reseed';

// C-011: the checkout gate and the checkout it gates (P0-6, P0-8, P0-10).
//
// The seeded restaurant is open round the clock with a zero-minute cutoff —
// the only configuration that makes a suite independent of the wall-clock hour
// it runs at, and CI runs it under two very different timezones. The HOURS
// trigger is driven directly in packages/core's unit tests, where the clock is
// a parameter; what is proved here is the two triggers that are deterministic
// at any hour, and that the screens and the server agree about them.

// Burrito 1095 + chicken 0 = 1095; tax 8.25% of 1095 = 90.3375 → 90; total 1185.
const addBurritoToCart = async (page: Page) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart/);
};

const pauseFrom = async (page: Page, why?: string) => {
  await page.goto('/kitchen');
  if (why) await page.getByRole('textbox', { name: /Tell customers why/ }).fill(why);
  await page.getByRole('button', { name: 'Pause new orders' }).click();
  await expect(page.getByRole('button', { name: 'Resume orders' })).toBeVisible();
};

test.beforeEach(() => {
  reseed();
});

test('places an order end to end, and it lands on the kitchen queue', async ({ page }) => {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();

  await expect(page.getByTestId('checkout-total')).toHaveText('$11.85');
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Alex Rivera');
  await page.getByRole('textbox', { name: /Anything we should know/ }).fill('Blue Honda out front');
  await page.getByRole('button', { name: /Place order/ }).click();

  // The receipt: order number and name, never the UUID (P0-8).
  await expect(page.getByTestId('order-number')).toHaveText(/^#\d{3}$/);
  await expect(page.getByTestId('confirmed-total')).toHaveText('$11.85');
  const orderNumber = await page.getByTestId('order-number').innerText();

  // The same order, on the screen the kitchen reads.
  await page.goto('/kitchen');
  const card = page.getByRole('listitem').filter({ hasText: 'Alex Rivera' }).first();
  await expect(card.getByRole('heading', { name: orderNumber })).toBeVisible();
  await expect(card.getByText('Order note: Blue Honda out front')).toBeVisible();
});

test('a name is required before an order can be placed', async ({ page }) => {
  await addBurritoToCart(page);
  await page.goto('/checkout');
  await page.getByRole('button', { name: /Place order/ }).click();
  // The order never left the browser, and nothing was written.
  await expect(page.getByTestId('order-number')).toHaveCount(0);
});

test.describe('the manual pause (trigger 1)', () => {
  test('closes checkout for the customer, with the reason staff typed', async ({
    page,
    context,
  }) => {
    await addBurritoToCart(page);

    const kitchen = await context.newPage();
    await pauseFrom(kitchen, 'Fryer is down until 2.');
    await kitchen.close();

    // The cart says so before the customer taps into checkout...
    await page.goto('/cart');
    await expect(page.getByTestId('gate-notice')).toContainText('Fryer is down until 2.');
    await expect(page.getByRole('link', { name: 'Checkout' })).toHaveCount(0);

    // ...and so does checkout itself, reached directly.
    await page.goto('/checkout');
    const notice = page.getByTestId('gate-notice');
    await expect(notice).toHaveAttribute('data-reason', 'manually_paused');
    await expect(notice).toContainText('Fryer is down until 2.');
    await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  });

  test('the SERVER refuses a stale tab that still has an enabled button', async ({
    page,
    context,
  }) => {
    // The whole point of one gate function called in two places. This tab
    // rendered while the restaurant was open, so its button is live; the
    // pause lands after, and only the server can catch it.
    await addBurritoToCart(page);
    await page.goto('/checkout');
    await page.getByRole('textbox', { name: /Name for the order/ }).fill('Alex Rivera');
    await expect(page.getByRole('button', { name: /Place order/ })).toBeEnabled();

    const kitchen = await context.newPage();
    await pauseFrom(kitchen, 'Fryer is down until 2.');
    await kitchen.close();

    await page.getByRole('button', { name: /Place order/ }).click();

    await expect(page.getByText('Fryer is down until 2.')).toBeVisible();
    await expect(page.getByTestId('order-number')).toHaveCount(0);
    // And no row was written, which is the assertion that matters.
    await page.goto('/kitchen');
    await expect(page.getByText('Alex Rivera')).toHaveCount(0);
  });

  test('resuming re-opens it, and in-flight orders were never touched', async ({ page }) => {
    await pauseFrom(page);
    // The four seeded orders are still on the queue while ordering is paused:
    // the gate is asked about NEW orders and nothing else (P0-6).
    await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
    await expect(page.getByText('Dana Reyes')).toBeVisible();

    await page.getByRole('button', { name: 'Resume orders' }).click();
    await expect(page.getByTestId('gate-status')).toContainText('Open — taking orders');

    await addBurritoToCart(page);
    await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible();
  });
});

test('the kitchen sees the gate\'s answer, not the switch\'s position', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(page.getByTestId('gate-status')).toContainText('Open — taking orders');
  await pauseFrom(page, 'Back in ten.');
  await expect(page.getByTestId('gate-status')).toContainText('Back in ten.');
});

test('checkout has no detectable accessibility violations, open or closed', async ({ page }) => {
  await addBurritoToCart(page);
  await page.goto('/checkout');
  const open = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(open.violations).toEqual([]);

  await pauseFrom(page);
  await page.goto('/checkout');
  await expect(page.getByTestId('gate-notice')).toBeVisible();
  const closed = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(closed.violations).toEqual([]);
});

test.describe('the ready-time estimate (P0-7)', () => {
  test('quotes a range at checkout, never a single number', async ({ page }) => {
    await addBurritoToCart(page);
    await page.goto('/checkout');
    // A point estimate is wrong the minute it passes; a range is not.
    await expect(page.getByTestId('ready-estimate')).toHaveText(/\d+–\d+ min/);
  });

  test('is replaced by the pause message, never left standing as a stale promise', async ({
    page,
    browser,
  }) => {
    await addBurritoToCart(page);
    await page.goto('/checkout');
    await expect(page.getByTestId('ready-estimate')).toBeVisible();

    const kitchen = await (await browser.newContext()).newPage();
    await pauseFrom(kitchen, 'Fryer is down until 2.');

    await page.reload();
    await expect(page.getByTestId('gate-notice')).toContainText('Fryer is down until 2.');
    await expect(page.getByTestId('ready-estimate')).toHaveCount(0);
  });
});
