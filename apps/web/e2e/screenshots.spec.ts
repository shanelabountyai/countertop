import { expect, test } from '@playwright/test';
import {
  backdateQueue,
  card,
  placeOrderFor,
  reseed,
  seedFinishedRush,
  seedMidServiceRush,
} from './fixtures';

// Screenshots for the write-up (C-031).
//
// SKIPPED unless SCREENSHOTS=1, because these write files into `docs/` and a
// gate run should not touch the working tree. They still appear in the
// `--list` total, which is why the convention reconciles `passed + skipped +
// flaky` rather than reading the tail.
//
//   SCREENSHOTS=1 PORT=3400 npm run test:e2e -- screenshots.spec.ts
//
// They are e2e specs rather than a standalone Playwright script for one
// reason: `webServer` already knows how to build the app and start it on the
// right port. A second launcher would be a second thing to keep in step with
// how this project actually serves itself.
test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to regenerate docs/screenshots');

const shot = (name: string) => `../../docs/screenshots/${name}.png`;

test.describe('the customer', () => {
  test.beforeEach(() => {
    reseed();
  });

  test('menu', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 1000 });
    await page.goto('/menu');
    await expect(page.getByRole('heading', { name: 'Burritos & Bowls' })).toBeVisible();
    await page.screenshot({ path: shot('01-menu'), fullPage: true });
  });

  test('composer, mid-composition', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.goto('/menu/burrito');
    await page.getByRole('radio', { name: /Carnitas/ }).check();
    await page.getByRole('checkbox', { name: /Guacamole/ }).check();
    await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
    // The negation, selected, so the screenshot shows the thing the product is
    // about rather than an empty form.
    await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
    // 1095 + carnitas 150 + guacamole 250 + cheese extra (50 + 75) = 1620.
    await expect(page.getByTestId('line-total')).toHaveText('$16.20');
    await page.screenshot({ path: shot('02-composer'), fullPage: true });
  });

  test('cart with the negation', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto('/menu/burrito');
    await page.getByRole('radio', { name: /Carnitas/ }).check();
    await page.getByRole('checkbox', { name: /Guacamole/ }).check();
    await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
    await page.getByRole('button', { name: /Add to cart/ }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await page.screenshot({ path: shot('03-cart'), fullPage: true });
  });

  test('status page', async ({ page }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto('/menu/chips');
    await page.getByRole('button', { name: /Add to cart/ }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await page.getByRole('link', { name: 'Checkout' }).click();
    await page.getByRole('textbox', { name: /Name for the order/ }).fill('Dana Reyes');
    await page.getByRole('button', { name: /Place order/ }).click();
    const href = await page.getByTestId('track-order').getAttribute('href');
    await page.goto(href!);
    await expect(page.getByTestId('order-status')).toBeVisible();
    await page.screenshot({ path: shot('04-status'), fullPage: true });
  });
});

test.describe('the kitchen, mid-rush', () => {
  test.beforeEach(() => {
    seedMidServiceRush();
  });

  test('queue under load', async ({ page }) => {
    // A kitchen tablet, landscape, on a wall bracket.
    await page.setViewportSize({ width: 1180, height: 900 });
    await page.goto('/kitchen');
    await expect(page.getByRole('heading', { name: /^Preparing \(\d+\)$/ })).toBeVisible();
    await page.screenshot({ path: shot('05-kitchen-queue'), fullPage: true });
  });

  test('one card, close up', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/kitchen');
    // Ada Nkemelu: chicken, guacamole, NO onions — an addition and a removal
    // on the same ticket, which is the whole argument for the card's design.
    const ticket = card(page, 'Ada Nkemelu');
    await expect(ticket).toBeVisible();
    await ticket.screenshot({ path: shot('06-kitchen-card') });
  });

  test('queue, as it fits on the screen', async ({ page }) => {
    // Not fullPage: what a cook actually sees without scrolling, which is the
    // honest version of "does this work at arm's length".
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto('/kitchen');
    await expect(page.getByRole('heading', { name: /^New \(\d+\)$/ })).toBeVisible();
    await page.screenshot({ path: shot('10-kitchen-viewport') });
  });

  test('sales report, mid-service', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 1200 });
    await page.goto('/kitchen/report?days=1');
    await expect(page.getByRole('heading', { name: 'Time in each state' })).toBeVisible();
    await page.screenshot({ path: shot('07-report-midservice'), fullPage: true });
  });
});

test.describe('after service', () => {
  test.beforeEach(() => {
    seedFinishedRush();
  });

  test('sales report with a day behind it', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 1400 });
    await page.goto('/kitchen/report?days=1');
    await expect(page.getByRole('heading', { name: 'Top sellers' })).toBeVisible();
    await page.screenshot({ path: shot('11-report-after'), fullPage: true });
  });
});

test.describe('the operator', () => {
  test.beforeEach(() => {
    reseed();
  });

  test('settings', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 1200 });
    await page.goto('/kitchen/settings');
    await expect(page.getByRole('heading', { name: 'Opening hours' })).toBeVisible();
    await page.screenshot({ path: shot('08-settings'), fullPage: true });
  });

  test('menu editor, on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/kitchen/menu?edit=item:burrito&price=109.50');
    await expect(page.getByText('Was $10.95, will be $109.50.')).toBeVisible();
    await page.screenshot({ path: shot('09-price-confirm'), fullPage: true });
  });
});

// C-040: the three surfaces that shipped after C-031 and had no picture.

test.describe('the staff boundary', () => {
  // The one shot taken signed OUT, for the same reason auth.spec.ts is the one
  // file that runs that way: the sign-in page is unreachable with the cookie
  // global setup hands every other context.
  test.use({ storageState: { cookies: [], origins: [] } });

  test('sign-in', async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 380 });
    await page.goto('/kitchen');
    await expect(page.getByRole('heading', { name: 'Kitchen sign-in' })).toBeVisible();
    await page.screenshot({ path: shot('12-staff-login'), fullPage: true });
  });
});

test.describe('the money and the leftovers', () => {
  test.beforeEach(() => {
    reseed();
  });

  test('an unpaid ticket, close up', async ({ page }) => {
    // Placed through the real checkout, so the badge is the badge a real
    // pay-at-pickup order carries — the bag leaving without the money is what
    // this flag exists to stop.
    await placeOrderFor(page, 'Robin Vale', { payAtPickup: true });
    await page.setViewportSize({ width: 900, height: 900 });
    await page.goto('/kitchen');
    const ticket = card(page, 'Robin Vale');
    await expect(ticket.getByText('Pay at pickup — $11.85')).toBeVisible();
    await ticket.screenshot({ path: shot('13-unpaid-card') });
  });

  test('yesterday still open', async ({ page }) => {
    const day = await backdateQueue();
    await page.setViewportSize({ width: 1180, height: 820 });
    await page.goto('/kitchen');
    await expect(page.getByText('4 orders are still open from an earlier day')).toBeVisible();
    await expect(page.getByText(`Left over from ${day}`).first()).toBeVisible();
    await page.screenshot({ path: shot('14-leftover') });
  });
});
