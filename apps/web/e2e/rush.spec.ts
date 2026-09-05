import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { card, seedMidServiceRush } from './fixtures';

// C-028: the kitchen queue during the rush.
//
// C-017 asserted the rush at the database grain — thirty orders, five ugly
// cases, zero stuck. C-019 made it possible to stop the clock mid-service.
// Nothing until now has looked at the SCREEN under that load, which is the
// thing the product is actually about: twenty-two live tickets read at arm's
// length, with greasy gloves, in a hurry.
//
// The rush is anchored so minute 12 is NOW, so the ages on these cards are the
// ages a cook would be reading.

test.beforeEach(() => {
  seedMidServiceRush();
});

test('every queue section is populated, and the counts are the orders', async ({ page }) => {
  await page.goto('/kitchen');

  const headings = await page
    .getByRole('heading', { name: /^(New|Accepted|Preparing|Ready for pickup) \(\d+\)$/ })
    .allInnerTexts();
  expect(headings).toHaveLength(4);

  const counts = new Map(
    headings.map((text) => {
      const [, section, count] = /^(.+) \((\d+)\)$/.exec(text.trim())!;
      return [section!, Number(count)];
    }),
  );

  // None of them empty. A rush that only ever filled one column would prove
  // nothing about a queue grouped by state.
  for (const section of ['New', 'Accepted', 'Preparing', 'Ready for pickup']) {
    expect(counts.get(section)).toBeGreaterThan(0);
  }

  // 23 placed by minute 12, one cancelled at minute 9 when the guacamole ran
  // out. The headings add up to the orders that are actually on the queue.
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  expect(total).toBe(22);
});

// Handoff P0-1 and P0-2, both asserted at the depth they exist for: the
// counter's two failures only happen on a board this long.
test('Ready for pickup is the first section, and its first card needs no scroll', async ({
  page,
}) => {
  await page.goto('/kitchen');

  const sections = await page.getByRole('heading', { name: /\(\d+\)$/ }).allInnerTexts();
  expect(sections[0]).toMatch(/^Ready for pickup/);

  // "Above the fold" is the requirement, so it is measured rather than
  // inferred from the section order: the first Ready card's top edge is inside
  // the viewport with the page unscrolled.
  // The first card on the page is therefore the first Ready card.
  const first = page.locator('main > section > ul > li').first();
  const box = await first.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeLessThan(page.viewportSize()!.height);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

// Handoff P0-3, asserted at the depth it exists for: the undo is only out of
// reach on a board deep enough that the tap was below the fold. The strip at
// the top of the page is where the undo can be FOUND; the tile is where it can
// be REACHED, and the difference is a scroll made with both hands full.
// Measured on this seed before the tile existed: the last Ready card's button
// sits at page y=1806, and the strip's undo then lands at viewport y=-1041 —
// a thousand pixels above the fold, on a five-second timer.
test('the undo stays where the tap was — the tile holds the slot', async ({ page }) => {
  await page.goto('/kitchen');

  const ready = page
    .locator('main > section')
    .filter({ has: page.getByRole('heading', { name: /^Ready for pickup \(/ }) });
  const slots = ready.locator('> ul > li');
  const before = await slots.count();
  expect(before).toBeGreaterThan(1);

  // The LAST card in the section — the one whose undo used to be furthest
  // from it, all the way back up past every other Ready ticket.
  const tapped = slots.last();
  const number = (await tapped.getByRole('heading').first().innerText()).trim();
  await tapped.getByRole('button', { name: 'Picked up' }).click();

  // The slot did not close up: same count, same position, and the heading's
  // count — which is LIVE cards — went down by one.
  await expect(
    page.getByRole('heading', { name: `Ready for pickup (${before - 1})` }),
  ).toBeVisible();
  await expect(slots).toHaveCount(before);
  const tile = slots.last();
  await expect(tile).toContainText(number);

  // Inside the viewport, measured, with no scrolling of our own after the tap.
  // `toBeVisible` is not this assertion: a control 3,000 pixels down the page
  // is visible and is exactly the failure this item exists to fix.
  const undo = tile.getByRole('button', { name: /^Undo/ });
  const box = await undo.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  // Greasy gloves, unchanged by the tile being smaller than the card.
  expect(box!.height).toBeGreaterThanOrEqual(48);

  await undo.click();
  await expect(page.getByRole('heading', { name: `Ready for pickup (${before})` })).toBeVisible();
  await expect(slots.last()).toContainText(number);
  await expect(slots.last().getByRole('button', { name: 'Picked up' })).toBeVisible();
});

test('the walk-up lookup marks one card and hides none of the other twenty-one', async ({
  page,
}) => {
  await page.goto('/kitchen');
  const cards = page.locator('main > section > ul > li');
  await expect(cards).toHaveCount(22);

  // Cass Iverson is at the front asking about her order; Ada is behind her.
  await page.getByRole('searchbox').fill('Cass');
  await page.getByRole('button', { name: 'Find' }).click();

  await expect(cards).toHaveCount(22);
  await expect(page.getByText('1 match for')).toBeVisible();
  const marked = page.locator('main > section > ul > li.ring-4');
  await expect(marked).toHaveCount(1);
  await expect(marked).toContainText('Cass Iverson');
  // Ada's ticket — the next question — never left the screen.
  await expect(card(page, 'Ada Nkemelu')).toBeVisible();

  // The receded cards are muted by SURFACE, not by opacity, and this is what
  // says so: a dimmed card is a card whose 18px body text drops under 3:1.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('the cancelled order is off the queue, and its cancel is on the record', async ({ page }) => {
  await page.goto('/kitchen');
  // Owen Brandt's guacamole burrito was cancelled at minute 9 when the kitchen
  // ran out. A cancelled order leaves the queue; it does not sit there greyed.
  await expect(page.getByText('Owen Brandt')).toHaveCount(0);

  // And the customer who was stranded by the same 86 IS here — she reordered
  // without the guacamole a minute later.
  await expect(card(page, 'Nia Feldman')).toBeVisible();
});

test('a negation is unmistakable on a card in the middle of a rush', async ({ page }) => {
  await page.goto('/kitchen');

  // Ada Nkemelu's burrito: chicken, guacamole, NO onions. This is the founding
  // case of the whole product, asserted where it actually has to work — on a
  // screen with twenty-one other tickets on it.
  const negation = card(page, 'Ada Nkemelu').getByText('NO onions');
  await expect(negation).toBeVisible();
  await expect(negation).toHaveCSS('font-weight', '700');

  // Distinct from an ADD on the same card, which is the failure mode: a
  // removal that reads like an addition recreates the phone-order bug.
  const addition = card(page, 'Ada Nkemelu').getByText('Guacamole');
  await expect(addition).toBeVisible();
  await expect(addition).not.toHaveCSS('font-weight', '700');
});

test('the ready shelf shows the no-show aging, and the fresh tickets do not', async ({ page }) => {
  await page.goto('/kitchen');

  // Cass Iverson has been ready since minute 7 — five minutes on the shelf at
  // the stop, which is BELOW the first no-show mark (10 minutes). The card
  // says how long without shouting about it yet.
  await expect(card(page, 'Cass Iverson')).toContainText(/\d+ min/);

  // Nothing on this queue is overdue: the oldest ticket is twelve minutes old
  // and the flag is at fifteen. A rush that lit every flag would mean the
  // demo's clock was wrong, which is exactly the defect this spec's anchor
  // fixes.
  await expect(page.getByText('Running late')).toHaveCount(0);
});

test('every control on a rush card is still thumb-sized', async ({ page }) => {
  await page.goto('/kitchen');

  // P0-11 at load: the tap targets are asserted on ONE card in kitchen.spec.
  // Here they are asserted across a screen with twenty-two of them, because a
  // layout that holds for one card and collapses under a full queue is the
  // version a cook actually meets.
  const controls = await page.locator('main button:visible, main summary:visible').all();
  expect(controls.length).toBeGreaterThan(20);
  for (const control of controls) {
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(48);
  }
});

test('the queue under load has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/kitchen');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});
