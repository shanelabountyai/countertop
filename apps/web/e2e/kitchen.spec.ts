import { execSync } from 'node:child_process';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';

// C-008: the kitchen queue (P0-4, P0-11).
//
// The four seeded orders are placed through the real `placeOrder` and moved
// with the real `applyOrderAction` (see packages/db/seed.ts):
//
//   #001 Dana Reyes   placed 2m ago   — 2× burrito, NO onions, a line note
//   #002 Morgan Ellis preparing, 22m  — past the 15-minute flag
//   #003 Priya Shah   ready, 25m      — past the second no-show mark
//   #004 Sam Okafor   accepted        — five lines, none hidden

const card = (page: Page, name: string): Locator =>
  page.getByRole('listitem').filter({ hasText: name }).first();

const heightOf = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box?.height ?? 0;
};

test('groups the queue by state, with a count on each section', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Preparing (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready for pickup (1)' })).toBeVisible();
});

test('a card carries everything the line cook needs, with the negation unmistakable', async ({
  page,
}) => {
  await page.goto('/kitchen');
  const dana = card(page, 'Dana Reyes');

  await expect(dana.getByRole('heading', { name: /^#\d{3}$/ })).toBeVisible();
  await expect(dana.getByText('2× Burrito')).toBeVisible();
  // Never truncated, never behind a hover.
  await expect(dana.getByText('Wrap it tight, it is going in a bike bag')).toBeVisible();

  // A removal must not read like an addition. The additive option is plain
  // text; the negation is not.
  const negation = dana.getByText('NO onions');
  const addition = dana.getByText('Guacamole');
  await expect(negation).toBeVisible();
  const negationStyle = await negation.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, weight: style.fontWeight };
  });
  const additionBackground = await addition.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(negationStyle.background).not.toBe(additionBackground);
  expect(Number(negationStyle.weight)).toBeGreaterThanOrEqual(700);
});

test('item lines are legible at arm\'s length and every tap target clears 48px', async ({
  page,
}) => {
  await page.goto('/kitchen');
  const dana = card(page, 'Dana Reyes');

  const fontSize = await dana
    .getByText('2× Burrito')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(18);

  // Open the cancel disclosure first: a control nobody can see yet has no tap
  // target to measure, and the ones behind it have to clear the bar too.
  await dana.getByText('Cancel…').click();
  const controls = await dana.locator('button:visible, summary:visible, input:visible').all();
  expect(controls.length).toBeGreaterThan(3);
  const heights = await Promise.all(controls.map(heightOf));
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(48);

  // The advance is the biggest control on the card (P0-4).
  const advance = await heightOf(dana.getByRole('button', { name: 'Accept' }));
  const others = heights.filter((height) => height !== advance);
  expect(advance).toBeGreaterThan(Math.max(...others));
});

test('flags a late ticket and a no-show taking shape', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(card(page, 'Morgan Ellis').getByText(/running late/)).toBeVisible();
  await expect(card(page, 'Priya Shah').getByText(/On the shelf \d+ min — no-show\?/)).toBeVisible();
});

test('renders every line of the largest order', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(card(page, 'Sam Okafor').locator('ul > li')).toHaveCount(5);
});

test('finds an order by name, and by the number printed on its own card', async ({ page }) => {
  await page.goto('/kitchen');

  await page.getByRole('searchbox').fill('Priya');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(card(page, 'Priya Shah')).toBeVisible();
  await expect(page.getByText('Dana Reyes')).toHaveCount(0);

  // The number a cook reads off the screen is the number they type in.
  const number = await card(page, 'Priya Shah').getByRole('heading').first().innerText();
  await page.getByRole('link', { name: 'Show all' }).click();
  await page.getByRole('searchbox').fill(number);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(card(page, 'Priya Shah')).toBeVisible();
  await expect(page.getByText('Sam Okafor')).toHaveCount(0);
});

test('the kitchen queue has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/kitchen');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

// These move orders. Reseeding first keeps them from depending on each other
// (or on a retry running against a queue a previous attempt already advanced).
test.describe('taking action on a card', () => {
  test.beforeEach(() => {
    execSync('npm run db:seed:test', { cwd: '../..', stdio: 'ignore' });
  });

  test('advancing moves the card and offers an undo that survives the re-render', async ({
    page,
  }) => {
    await page.goto('/kitchen');
    await card(page, 'Dana Reyes').getByRole('button', { name: 'Accept' }).click();

    await expect(page.getByRole('heading', { name: 'New (0)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Accepted (2)' })).toBeVisible();

    const undo = card(page, 'Dana Reyes').getByRole('button', { name: /^Undo/ });
    await expect(undo).toBeVisible();
    await undo.click();

    await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Accepted (1)' })).toBeVisible();
  });

  test('cancelling asks for a reason, and a no-show is closed out as its own thing', async ({
    page,
  }) => {
    await page.goto('/kitchen');
    // A <summary> is a disclosure, not a button: target it the way it reads.
    await card(page, 'Morgan Ellis').getByText('Cancel…').click();
    await card(page, 'Morgan Ellis').getByRole('button', { name: 'Out of an item' }).click();
    await expect(page.getByRole('heading', { name: 'Preparing (0)' })).toBeVisible();
    await expect(page.getByText('Morgan Ellis')).toHaveCount(0);

    // `abandoned`, not `cancelled` — the no-show rate is its own signal.
    await card(page, 'Priya Shah').getByRole('button', { name: 'No-show' }).click();
    await expect(page.getByRole('heading', { name: 'Ready for pickup (0)' })).toBeVisible();
  });
});
