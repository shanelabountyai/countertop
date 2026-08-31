import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { backdateQueue, card, placeOrderFor, reseed } from './fixtures';

// C-039: the end-of-day sweep (P1-6).
//
// "Any orders still open at close are flagged for closeout so tomorrow's queue
// and order numbers start clean." Flagged, not swept: closing one out is a
// staff transition to the right terminal state, and the screen's whole job is
// to make sure nobody has to notice the stale card themselves.
//
// The four seeded orders (packages/db/seed.ts) are all in queue states, so
// backdating them makes a whole leftover service in one call.

test.beforeEach(() => {
  reseed();
});

test('a queue left over from an earlier day is counted, dated and marked', async ({ page }) => {
  const day = await backdateQueue();
  await page.goto('/kitchen');

  // The count and the oldest day, so staff know the size of the chore before
  // scrolling for it.
  await expect(page.getByText(`4 orders are still open from an earlier day`)).toBeVisible();
  await expect(page.getByText(`the oldest from ${day}`)).toBeVisible();

  for (const name of ['Dana Reyes', 'Morgan Ellis', 'Priya Shah', 'Sam Okafor']) {
    await expect(card(page, name).getByText(`Left over from ${day}`)).toBeVisible();
  }
});

test('a leftover stops claiming to be new — the chime is for a customer standing there now', async ({
  page,
}) => {
  await backdateQueue();
  await page.goto('/kitchen');

  // #001 Dana Reyes is seeded `placed`, which is the one status that alerts.
  const dana = card(page, 'Dana Reyes');
  await expect(dana.getByText('Left over from')).toBeVisible();
  await expect(dana.getByText('New — not yet accepted')).toBeHidden();
  // Still `placed`, still on the queue, still cancellable — flagged, not swept.
  await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
  await expect(dana.getByRole('button', { name: 'Accept' })).toBeVisible();
});

test("today's orders are untouched by the flag, and the count stays honest", async ({ page }) => {
  const day = await backdateQueue();
  await placeOrderFor(page, 'Today Tamsin');

  await page.goto('/kitchen');
  await expect(page.getByText('4 orders are still open from an earlier day')).toBeVisible();
  await expect(card(page, 'Today Tamsin').getByText('Left over from')).toBeHidden();
  // The new order is the one that chimes, and it is the only one.
  await expect(card(page, 'Today Tamsin').getByText('New — not yet accepted')).toBeVisible();
  await expect(page.getByText(`Left over from ${day}`)).toHaveCount(4);
});

test('closing one out clears it from the count', async ({ page }) => {
  await backdateQueue();
  await page.goto('/kitchen');

  // #003 Priya Shah is `ready` — food made, nobody came for it, which is
  // `abandoned` and not `cancelled`. The distinction is the no-show rate.
  await card(page, 'Priya Shah').getByRole('button', { name: 'No-show' }).click();

  await expect(page.getByText('3 orders are still open from an earlier day')).toBeVisible();
  // `abandoned` is not a queue status, so the card leaves the QUEUE — the
  // assertion is on the card, not on its badge, which would pass against a
  // card that had merely lost its flag. It is off the screen entirely only
  // once its five-second undo has run out: closing out a leftover is as
  // mis-tappable as any other advance, so for that window it sits in the
  // "Just finished" strip, which is the only place that undo can live (P0-4).
  await expect(page.getByRole('heading', { name: 'Ready for pickup (0)' })).toBeVisible();
  await expect(
    page.locator('section:not([aria-label])').getByText('Priya Shah'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Just finished' }).getByText('Priya Shah'),
  ).toBeVisible();
});

test('the flagged queue has no accessibility violations', async ({ page }) => {
  await backdateQueue();
  await page.goto('/kitchen');
  await expect(page.getByText('still open from an earlier day')).toBeVisible();

  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
