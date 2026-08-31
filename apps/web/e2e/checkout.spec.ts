import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addBurritoToCart, reseed } from './fixtures';

// C-011: the checkout gate and the checkout it gates (P0-6, P0-8, P0-10).
//
// The seeded restaurant is open round the clock with a zero-minute cutoff —
// the only configuration that makes a suite independent of the wall-clock hour
// it runs at, and CI runs it under two very different timezones. The HOURS
// trigger is driven directly in packages/core's unit tests, where the clock is
// a parameter; what is proved here is the two triggers that are deterministic
// at any hour, and that the screens and the server agree about them.

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

test('a price that changed while an item sat in the cart is confirmed, never silently charged', async ({
  page,
}) => {
  await addBurritoToCart(page);

  await page.goto('/kitchen/menu');
  await page.getByRole('textbox', { name: 'Price for Burrito', exact: true }).fill('12.50');
  await page.getByRole('button', { name: 'Review price for Burrito', exact: true }).click();
  await page.getByRole('button', { name: 'Save new price for Burrito', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Burrito is now priced at $12.50');

  await page.goto('/cart');
  await expect(page.getByText('Price changed: $10.95 → $12.50 each.')).toBeVisible();

  // The customer's last screen before paying has to say which line moved,
  // not just refuse the button — the same gap the sold-out flag had.
  await page.goto('/checkout');
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  await expect(page.getByText('Price changed: $10.95 → $12.50 each.')).toBeVisible();

  // Confirming on the cart is what actually clears it — going back to
  // checkout on its own must not.
  await page.goto('/cart');
  await page.getByRole('button', { name: 'I understand the new prices' }).click();
  // Wait for the confirm to land before navigating away — a goto racing the
  // action's write is the exact trap fixtures.ts exists to keep specs out of.
  await expect(page.getByRole('button', { name: 'I understand the new prices' })).toHaveCount(0);
  await page.goto('/checkout');
  await expect(page.getByText('Price changed', { exact: false })).toHaveCount(0);
  await expect(page.getByTestId('checkout-total')).toHaveText('$13.53');
  await expect(page.getByRole('button', { name: /Place order/ })).toBeEnabled();
});

// The other stale tab: not the gate moving, the cart itself emptying under a
// checkout screen that is still showing a total and an enabled button.
test('a checkout whose cart emptied elsewhere stops showing an order to place', async ({
  page,
  context,
}) => {
  await addBurritoToCart(page);
  await page.goto('/checkout');
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Alex Rivera');

  const otherTab = await context.newPage();
  await otherTab.goto('/cart');
  await otherTab.getByRole('button', { name: /Remove/ }).first().click();
  await expect(otherTab.getByText('Nothing in it yet.')).toBeVisible();
  await otherTab.close();

  await page.getByRole('button', { name: /Place order/ }).click();

  await expect(page.getByText(/cart is empty/i)).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toHaveCount(0);
  await expect(page.getByTestId('order-number')).toHaveCount(0);
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

    await expect(page.getByText('Fryer is down until 2.').first()).toBeVisible();
    // And the screen catches up with the refusal instead of leaving a live
    // button standing over a "we're closed" message: the refusal refreshes the
    // server-rendered half of this page, which is where the notice and the
    // button's disabled state both come from.
    await expect(page.getByTestId('gate-notice')).toHaveAttribute('data-reason', 'manually_paused');
    await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
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
