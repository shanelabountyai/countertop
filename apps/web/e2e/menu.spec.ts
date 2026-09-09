import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { menuRow, reseed, setDaypart } from './fixtures';

// C-007: the customer menu and the item composer (P0-1, P0-2 display side).
//
// The prices asserted here are hand-calculated against SAMPLE_MENU, which is
// also what `db:seed:test` writes — the same fixture the unit suite is
// calculated against, not a second menu written to agree with the screen.
//
//   Burrito 1095 + chicken 0 + guacamole 250 + cheese "extra" (50 + 75) = 1470
//   NO onions adds nothing — a negation is free by construction
//   tax 8.25% of 1470 = 121.275 → 121;  total 1591

// This file asserts SEEDED prices and was the only one that did so without
// reseeding — so it silently depended on whatever the previous spec file left
// behind. `menu-editing.spec.ts` runs immediately before it and rewrites live
// menu rows; it happened to end on a test that reseeded, until C-026 added
// three that do not. An assertion about $10.95 has to be an assertion about
// the seed, not about test ordering.
test.beforeEach(() => {
  reseed();
});

const total = (page: Page) => page.getByTestId('line-total');

test('the menu lists every category, item and price', async ({ page }) => {
  await page.goto('/menu');
  await expect(page.getByRole('heading', { name: 'Burritos & Bowls' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sides' })).toBeVisible();
  // C-080 put the description INSIDE the tap target, so it is inside the
  // link's accessible name too — between the name and the price. `Chips &
  // salsa` is deliberately undescribed in SAMPLE_MENU, so its name is still
  // adjacent, and that contrast is the assertion.
  await expect(menuRow(page, 'Burrito', '$10.95')).toBeVisible();
  await expect(menuRow(page, 'Chips & salsa', '$3.50')).toBeVisible();
});

test('the menu says what the food is, with no composer opened', async ({ page }) => {
  await page.goto('/menu');

  // P0-4. Read straight off the list — the point of the requirement is that
  // finding out what a burrito is does not cost a navigation.
  await expect(
    page.getByText('Hot off the griddle, folded tight, big enough to need two hands.'),
  ).toBeVisible();

  // An item with no description renders nothing rather than an empty line.
  await expect(menuRow(page, 'Chips & salsa', '$3.50')).toHaveText(/^Chips & salsa\s*\$3\.50$/);

  // ...and the composer says it too, for the customer who did navigate.
  await page.goto('/menu/burrito');
  await expect(
    page.getByText('Hot off the griddle, folded tight, big enough to need two hands.'),
  ).toBeVisible();
});

test('the category strip jumps to each section', async ({ page }) => {
  await page.goto('/menu');
  const strip = page.getByRole('navigation', { name: 'Jump to a category' });

  // Every category on the menu is in the strip, in menu order.
  await expect(strip.getByRole('link')).toHaveText([
    'Burritos & Bowls',
    'Plates',
    'Sides',
    'Drinks',
    'Sweets',
  ]);

  // Native in-page anchors: tapping one moves the URL fragment and scrolls the
  // matching section into view. Asserting `isVisible` alone would pass on a
  // short page that never scrolled, so the fragment is asserted too.
  for (const [name, id] of [
    ['Sweets', 'sweets'],
    ['Plates', 'plates'],
  ]) {
    await strip.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`#category-${id}$`));
    await expect(page.getByRole('heading', { name, level: 2 })).toBeInViewport();
  }
});

test('skipping a required group blocks the add with a clear message', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('button', { name: /Add to cart/ }).click();

  await expect(page.getByText('Choose your protein.')).toBeVisible();
  // Still on the composer: nothing was added.
  await expect(page.getByRole('heading', { name: 'Burrito' })).toBeVisible();
});

test('a freshly opened composer has no filled pill in any intensity group', async ({ page }) => {
  await page.goto('/menu/burrito');

  // Cheese and Onions are the burrito's two intensity-enabled groups.
  // `choice === null` is what BOTH "never touched" and "deliberately chose
  // Skip" look like in the data — so before C-081, Skip's own pill (and its
  // native `checked`) came in pre-filled on a screen nobody had touched yet.
  // Intensity applies per OPTION, not per group — Salsa's three options and
  // Toppings' three each get their own radiogroup, six on the burrito.
  const intensityOptions = ['Chipotle', 'Salsa verde', 'Pico de gallo', 'Onions', 'Cilantro', 'Cheese'];
  for (const name of intensityOptions) {
    // `getByRole('radio')` alone matches all five pills; the assertion is
    // "none of them are checked", which needs a single-element locator.
    await expect(
      page.getByRole('radiogroup', { name }).getByRole('radio', { checked: true }),
    ).toHaveCount(0);
  }
  // The visible hint P0-5 also asks for: the absence of a choice is stated,
  // not left to be inferred from a wall of identical-looking pills.
  await expect(page.getByText('No choice made yet')).toHaveCount(intensityOptions.length);

  // Tapping Skip DOES fill its own pill and clears only ITS hint — the
  // requirement is about the untouched state, not about Skip forever looking
  // unselected.
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText('Skip').click();
  await expect(
    page.getByRole('radiogroup', { name: 'Cheese' }).getByRole('radio', { name: 'Skip' }),
  ).toBeChecked();
  await expect(page.getByText('No choice made yet')).toHaveCount(intensityOptions.length - 1);
});

test('a failed add-to-cart moves focus to the first violating group, naming it', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('button', { name: /Add to cart/ }).click();

  // Protein is the burrito's only required group, so it is both the first
  // violation and the one the customer actually has to act on.
  const proteinFieldset = page.getByRole('group', { name: 'Protein' });
  await expect(proteinFieldset).toBeFocused();
  // `aria-describedby` ties the fieldset to its own error text — the
  // assistive-technology half of "the error message takes you to the error":
  // landing here reads the group AND why it failed, not just the group.
  await expect(proteinFieldset).toHaveAccessibleDescription(/protein/i);

  // The fieldset's own message stays unique on the page — the summary near
  // the submit button names the group in its OWN sentence, not "the choices
  // above" and not a duplicate of the fieldset's, which would make every
  // exact-text locator for it ambiguous.
  await expect(page.getByText('Choose your protein.')).toHaveCount(1);
  await expect(page.getByText('Fix Protein before adding this to your cart.')).toBeVisible();

  // The new markup (the focused fieldset, `aria-describedby`, the untouched
  // hint) is exactly what P0-6 says must not cost the composer its existing
  // axe pass — checked in THIS failed state, not only the pristine one below.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

test('a priced option changes the composed price immediately', async ({ page }) => {
  await page.goto('/menu/burrito');
  await expect(total(page)).toHaveText('$10.95');

  await page.getByRole('radio', { name: /Chicken/ }).check();
  await expect(total(page)).toHaveText('$10.95');

  await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await expect(total(page)).toHaveText('$13.45');

  // Intensity: "extra" costs the option's delta PLUS its extra surcharge.
  // Clicked by its LABEL, the way a customer does — the radio itself is
  // visually hidden behind the pill it draws.
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
  await expect(
    page.getByRole('radiogroup', { name: 'Cheese' }).getByRole('radio', { name: /^Extra/ }),
  ).toBeChecked();
  await expect(total(page)).toHaveText('$14.70');

  // The negation is free, and it is not one of your picks.
  await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
  await expect(total(page)).toHaveText('$14.70');

  // Quantity multiplies the whole composed unit, modifiers included.
  await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await expect(total(page)).toHaveText('$29.40');
});

test('a composed line reaches the cart, with the negation distinct and the tax the server computed', async ({
  page,
}) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await page.getByRole('radiogroup', { name: 'Cheese' }).getByText(/^Extra/).click();
  await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
  await page.getByRole('button', { name: /Add to cart/ }).click();

  await expect(page).toHaveURL(/\/cart$/);
  // Quantity moved off the heading and onto the stepper (C-083, P1-2).
  await expect(page.getByRole('heading', { name: 'Burrito', exact: true })).toBeVisible();
  await expect(page.getByTestId('line-quantity')).toHaveText('1');
  await expect(page.getByText('Extra cheese')).toBeVisible();

  // "NO onions" is not "onions" (P0-11's founding case, at the customer end).
  const negation = page.getByText('NO onions');
  await expect(negation).toBeVisible();
  await expect(negation).toHaveCSS('font-weight', '600');

  await expect(page.getByTestId('cart-total')).toHaveText('$15.91');

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Nothing in it yet.')).toBeVisible();
});

// C-110 (P1-1): an item that knows what time it is, end to end. The unit and
// db suites assert the refusal at all three call sites with a frozen clock;
// what only a browser can prove is that the SCREENS are wired to the same
// answer — that the menu row, the composer's Add button and the checkout page
// are not each deciding for themselves.
//
// No seeded item carries a window (docs/WRITEUP.md), so these write their own.
// `reseed()` in `beforeEach` takes it away again.
const hhmm = (minuteOfDay: number): string =>
  `${String(Math.floor(minuteOfDay / 60)).padStart(2, '0')}:${String(minuteOfDay % 60).padStart(2, '0')}`;

test('an item outside its serving hours is shown with its hours, not hidden', async ({ page }) => {
  const { startMinute, endMinute } = await setDaypart('chips', 'not served');

  await page.goto('/menu');

  // Rendered, not hidden — the same rule an 86 follows (P0-6): a customer who
  // cannot find the chips assumes the site is broken.
  await expect(page.getByText(`Chips & salsa — Served ${hhmm(startMinute)}–${hhmm(endMinute)}`)).toBeVisible();
  await expect(page.getByRole('link', { name: /Chips & salsa/ })).toHaveCount(0);
  // And it is the schedule, not "Sold out": nobody ran out of anything.
  await expect(page.getByText('Chips & salsa — Sold out')).toHaveCount(0);
  // Its neighbours are untouched.
  await expect(menuRow(page, 'Chips & guac', '$5.95')).toBeVisible();
});

test('the composer opened directly says so, and will not add', async ({ page }) => {
  const { startMinute, endMinute } = await setDaypart('chips', 'not served');
  const sentence = `Chips & salsa is served ${hhmm(startMinute)}–${hhmm(endMinute)}.`;

  // Straight past the greyed row. The composer is running the same
  // `validateComposition` the server runs, with the clock the server read —
  // so it refuses before the POST, and the POST would be refused too
  // (`placement.test.ts` asserts that half without a browser).
  await page.goto('/menu/chips');
  await expect(page.getByText(sentence)).toBeVisible();

  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).not.toHaveURL(/\/cart$/);
  // C-081: the bottom summary exists to name a GROUP, and chips has none —
  // it stays silent rather than repeat a generic "the choices above" that
  // named nothing. The sentence itself is what says nothing was silently
  // added — shown above the modifiers already, and AGAIN once `attempted`
  // turns on `generalMessages`, hence `.first()` rather than a bare locator.
  await expect(page.getByText(sentence).first()).toBeVisible();
});

test('a window closing under an open cart takes the 86 path, in gentler words', async ({ page }) => {
  // Added while it was being served...
  await setDaypart('chips', 'served');
  await page.goto('/menu/chips');
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('heading', { name: 'Chips & salsa', exact: true })).toBeVisible();

  // ...and the clock moved. Same fix-or-remove path an 86 uses — the decision
  // recorded at C-110 was that the existing path is the honest one and the
  // kindness belongs in the sentence.
  const { prisma } = await import('@countertop/db');
  try {
    await prisma.menuItemWindow.deleteMany({ where: { itemId: 'chips' } });
  } finally {
    await prisma.$disconnect();
  }
  const { startMinute, endMinute } = await setDaypart('chips', 'not served');

  await page.reload();
  await expect(
    page.getByText(`Chips & salsa is served ${hhmm(startMinute)}–${hhmm(endMinute)}.`),
  ).toBeVisible();
  // The line still shows its price — it is unavailable, not unknown.
  await expect(page.getByTestId('cart-total')).toHaveText('$3.79');
  await expect(page.getByText('Fix or remove the flagged lines before placing this order.')).toBeVisible();
});

// C-021: editing a line in place. `replaceLine` has existed and been unit
// tested since C-005; this is the screen that finally calls it.
test('a cart line re-opens pre-filled, and saving replaces it where it sat', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart$/);

  await page.goto('/menu/chips');
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Burrito', 'Chips & salsa']);

  const burritoLine = page.getByRole('listitem').filter({ hasText: 'Burrito' }).first();
  await burritoLine.getByRole('link', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\/menu\/burrito\?line=/);

  // Pre-filled on the FIRST render, from the cart cookie — not an empty
  // composer that fills itself in afterwards.
  await expect(page.getByRole('radio', { name: /Chicken/ })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: /Guacamole/ })).toBeChecked();
  await expect(total(page)).toHaveText('$13.45');
  // The way back is to the cart, because that is where this was opened from.
  await expect(page.getByRole('link', { name: '← Cart' })).toBeVisible();

  await page.getByRole('checkbox', { name: /Guacamole/ }).uncheck();
  await page.getByRole('radiogroup', { name: 'Onions' }).getByText('No onions').click();
  await page.getByRole('spinbutton', { name: 'Quantity' }).fill('2');
  await expect(total(page)).toHaveText('$21.90');

  await page.getByRole('button', { name: /Save changes/ }).click();
  await expect(page).toHaveURL(/\/cart$/);

  // Two lines, not three — and the burrito is still the first of them.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(['Burrito', 'Chips & salsa']);
  await expect(burritoLine.getByTestId('line-quantity')).toHaveText('2');
  await expect(page.getByText('NO onions')).toBeVisible();
  await expect(page.getByText('Guacamole')).toHaveCount(0);
});

test('a line id that is no longer in the cart composes a fresh one instead', async ({ page }) => {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();

  const href = await page
    .getByRole('listitem')
    .filter({ hasText: 'Burrito' })
    .first()
    .getByRole('link', { name: 'Edit' })
    .getAttribute('href');
  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Nothing in it yet.')).toBeVisible();

  // The stale link still resolves — it just has nothing to edit, so it is an
  // ordinary composer with an ordinary Add button.
  await page.goto(href!);
  await expect(page.getByRole('button', { name: /Add to cart/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Chicken/ })).not.toBeChecked();
});

for (const path of ['/menu', '/menu/burrito', '/cart']) {
  test(`${path} has no detectable accessibility violations`, async ({ page }) => {
    await page.goto(path);
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
