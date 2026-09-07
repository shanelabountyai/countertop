import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { addBurritoToCart, reseed } from './fixtures';

// C-012: the 86 board and the three surfaces one 86 has to touch (P0-6).
//
// The trap this spec exists for (CLAUDE.md): an 86 mid-flight reaches the menu
// render, reaches the carts already holding it — and must NOT reach an order
// already placed, which is a snapshot. A board that only updated the menu
// would pass a lazier version of this file.

// Every test mutates the shared menu rows, so each starts from the seed.
test.beforeEach(() => {
  reseed();
});

const eightySix = async (page: Page, name: string) => {
  await page.goto('/kitchen/availability');
  await page.getByRole('button', { name: `Mark ${name} sold out` }).click();
  await expect(page.getByRole('button', { name: `Put ${name} back on` })).toBeVisible();
};

test('an 86 item is rendered sold out on the menu, not hidden, and cannot be added', async ({
  page,
}) => {
  await eightySix(page, 'Chips & salsa');

  await page.goto('/menu');
  // Still on the menu. A customer who cannot FIND the chips assumes the site
  // is broken; one who sees them greyed out knows the kitchen ran out.
  await expect(page.getByText('Chips & salsa — Sold out')).toBeVisible();
  await expect(page.getByRole('link', { name: /Chips & salsa/ })).toHaveCount(0);

  // And the composer refuses it, for anyone who kept the URL.
  await page.goto('/menu/chips');
  await expect(page.getByText('Sold out — the kitchen has run out.')).toBeVisible();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page.getByText('Chips & salsa is sold out.')).toBeVisible();
  await expect(page).toHaveURL(/\/menu\/chips$/);
});

test('an 86 option flags the carts holding it and blocks checkout, at the option grain', async ({
  page,
}) => {
  await addBurritoToCart(page, { guacamole: true });
  await eightySix(page, 'Guacamole');

  await page.goto('/cart');
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();
  await expect(page.getByText('Fix or remove the flagged lines')).toBeVisible();

  // Out of avocado is not out of burritos: the item itself is still orderable.
  await page.goto('/menu');
  await expect(page.getByRole('link', { name: /Burrito \$10\.95/ })).toBeVisible();

  await page.goto('/checkout');
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();
  await expect(page.getByText('Fix or remove the flagged lines')).toBeVisible();
  // Not just the bottom banner: the customer's last screen before paying has
  // to say which line is the problem, the same as the cart page one step
  // back — a generic banner over an unmarked line list leaves them guessing.
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();
});

test('putting an option back on clears the flag it left in the cart', async ({ page }) => {
  await addBurritoToCart(page, { guacamole: true });
  await eightySix(page, 'Guacamole');
  await page.goto('/cart');
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();

  await page.goto('/kitchen/availability');
  await page.getByRole('button', { name: 'Put Guacamole back on' }).click();
  await expect(page.getByRole('button', { name: 'Mark Guacamole sold out' })).toBeVisible();

  await page.goto('/cart');
  await expect(page.getByText('Guacamole is sold out.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Checkout' })).toBeVisible();
});

test('an order already placed is untouched by the 86 that follows it', async ({ page }) => {
  await addBurritoToCart(page, { guacamole: true });
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Jo Marquez');
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();

  await eightySix(page, 'Guacamole');

  // The ticket renders from the order's OWN snapshot. Guacamole is on this
  // burrito for as long as the row exists, whatever the menu says now.
  await page.goto('/kitchen');
  const card = page.getByRole('listitem').filter({ hasText: 'Jo Marquez' }).first();
  await expect(card.getByText('Guacamole')).toBeVisible();
  await expect(card.getByText(/sold out/i)).toHaveCount(0);
});

// C-071 (P0-1): the row says who it stops, before the tap.
//
// The failure this replaces is not an error message — it is silence. The cook
// 86s guacamole, is right to, and finds out at the fourth item that she took
// four things off the menu. The board has always known: `ItemModifierGroup`
// holds the join and `loadMenu()` already returned it.
test('an option row names every item the 86 will stop, without a tap', async ({ page }) => {
  await page.goto('/kitchen/availability');

  // Shared across four items — all four named, none behind a count.
  const guacamole = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Mark Guacamole sold out' }) });
  await expect(guacamole).toContainText(
    'Used on: Burrito, California burrito, Torta, Loaded nachos',
  );

  // Used on one item — one name, and no "shared" language that would train
  // the cook to ignore the line on the rows where it matters.
  const alPastor = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Mark Al pastor sold out' }) });
  await expect(alPastor).toContainText('Used on: Taco plate');
  await expect(alPastor).not.toContainText('more');

  // Nine items: truncated, but the count of what was left out is still there.
  // "Shared" alone would be the useless version of this line.
  const chicken = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Mark Chicken sold out' }) });
  await expect(chicken).toContainText('+5 more');
  await expect(chicken).toContainText('Used on: Burrito,');
});

test('the board is readable and tappable with gloves on', async ({ page }) => {
  await page.goto('/kitchen/availability');

  // Links too, since C-109: picking a row for a batch is now one of the most
  // tapped controls on the screen and it is an <a>, so a button-only loop
  // would have stopped covering the thing being tapped.
  for (const control of await page.getByRole('button').or(page.getByRole('link')).all()) {
    const box = await control.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
  }

  const fontSize = await page
    .getByText('Guacamole', { exact: false })
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(18);

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

// C-108 (P0-2): the board is 25 items plus every option of every group, and it
// is read one-handed while the pass backs up. The queue one tap away has had a
// search box since C-011; this screen is longer and more urgent.
test('searching narrows the board to the option and the items it stops', async ({ page }) => {
  await page.goto('/kitchen/availability');
  await page.getByRole('searchbox', { name: /Find an item or option/ }).fill('guac');
  await page.getByRole('button', { name: 'Find' }).click();

  // The option, which is the thing being 86'd — and its used-on line intact,
  // because a narrowed board still has to say what the tap costs.
  const guacamole = page
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: 'Mark Guacamole sold out' }) });
  await expect(guacamole).toContainText(
    'Used on: Burrito, California burrito, Torta, Loaded nachos',
  );

  // The four items carrying it, none of which is called "guac", plus the side
  // that is.
  for (const name of ['Burrito', 'California burrito', 'Torta', 'Loaded nachos', 'Chips & guac']) {
    await expect(page.getByRole('button', { name: `Mark ${name} sold out` })).toBeVisible();
  }

  // And the rest of the menu is gone — a filter that leaves 25 rows on screen
  // has not done the thing this box exists for.
  await expect(page.getByRole('button', { name: 'Mark Churros sold out' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mark Queso sold out' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Drinks' })).toHaveCount(0);

  // The 86 still works from inside the search, and the board comes back.
  await page.getByRole('button', { name: 'Mark Guacamole sold out' }).click();
  await expect(page.getByRole('button', { name: 'Put Guacamole back on' })).toBeVisible();
  await page.getByRole('link', { name: 'Show all' }).click();
  await expect(page.getByRole('button', { name: 'Mark Churros sold out' })).toBeVisible();
});

test('a search that matches nothing says so instead of going blank', async ({ page }) => {
  await page.goto('/kitchen/availability?q=lobster');
  await expect(page.getByText('Nothing on the menu matches “lobster”.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Options' })).toHaveCount(0);
});

// C-109 (P0-3, P0-4): the batch.
//
// The grain is a SELECTION, not a category, and this menu is why: the fryer's
// output is Chips & salsa, Chips & guac and Taquitos (Sides), Loaded nachos
// (Plates) and Churros (Sweets). Three categories, each of which also holds
// food that is fine — rice, a tamale plate, a paleta. A category-level 86
// could not have expressed "the fryer is down" without taking those off the
// menu too, which is the reverse-case failure the PRD calls worse.
const FRIED = ['Chips & salsa', 'Chips & guac', 'Taquitos', 'Loaded nachos', 'Churros'];

/** Pick rows, then kill them in one action. Each pick waits for the URL it
 *  wrote — the selection lives there, and a click on a stale page loses it. */
const select = async (page: Page, names: string[]) => {
  for (const name of names) {
    await page.getByRole('link', { name: `Select ${name}` }).click();
    await expect(page.getByRole('link', { name: `Selected ${name}` })).toBeVisible();
  }
};

test('a bulk 86 reaches all three surfaces, exactly as one tap does', async ({ page }) => {
  // Placed BEFORE the batch, so the snapshot has something to be right about.
  await addBurritoToCart(page, { guacamole: true });
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill('Jo Marquez');
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByRole('heading', { name: 'Order placed' })).toBeVisible();

  // And a second cart, still open, holding one of the rows about to die.
  await addBurritoToCart(page, { guacamole: true });

  // Six rows, both grains, one action.
  await page.goto('/kitchen/availability');
  await select(page, [...FRIED, 'Guacamole']);
  await page.getByRole('button', { name: 'Mark all 6 sold out' }).click();

  // It reports what it did, and names it — not a count on its own.
  await expect(page.getByRole('heading', { name: 'Marked 6 sold out.' })).toBeVisible();
  for (const name of [...FRIED, 'Guacamole']) {
    await expect(page.getByRole('button', { name: `Put ${name} back on` })).toBeVisible();
  }

  // Surface 1: the menu renders them sold out, never hides them.
  await page.goto('/menu');
  for (const name of FRIED) {
    await expect(page.getByText(`${name} — Sold out`)).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(`^${name} \\$`) })).toHaveCount(0);
  }
  // Out of the fryer is not out of burritos: the option grain moved, the item
  // carrying it did not.
  await expect(page.getByRole('link', { name: /Burrito \$10\.95/ })).toBeVisible();

  // Surface 2: the cart already holding one is flagged, and checkout is shut.
  await page.goto('/checkout');
  await expect(page.getByText('Guacamole is sold out.')).toBeVisible();
  await expect(page.getByRole('button', { name: /Place order/ })).toBeDisabled();

  // Surface 3: the order placed a minute ago is a snapshot and does not care.
  await page.goto('/kitchen');
  const card = page.getByRole('listitem').filter({ hasText: 'Jo Marquez' }).first();
  await expect(card.getByText('Guacamole')).toBeVisible();
  await expect(card.getByText(/sold out/i)).toHaveCount(0);
});

test('the undo returns exactly what the batch killed, and nothing else', async ({ page }) => {
  // Churros ran out an hour ago for its own reason. It is in the sweep because
  // the cook swept the whole fryer; it is not something the batch did.
  await eightySix(page, 'Churros');

  await select(page, FRIED);
  await page.getByRole('button', { name: 'Mark all 5 sold out' }).click();
  // Four, not five — the report counts what changed.
  await expect(page.getByRole('heading', { name: 'Marked 4 sold out.' })).toBeVisible();

  await page.getByRole('button', { name: 'Put all 4 back on' }).click();
  await expect(page.getByRole('heading', { name: 'Put 4 back on.' })).toBeVisible();

  await page.goto('/menu');
  for (const name of ['Chips & salsa', 'Chips & guac', 'Taquitos', 'Loaded nachos']) {
    await expect(page.getByRole('link', { name: new RegExp(`^${name} \\$`) })).toBeVisible();
  }
  // The one the shop is genuinely out of stays out. An undo that helpfully put
  // it back would be selling food nobody has.
  await expect(page.getByText('Churros — Sold out')).toBeVisible();
});

test('the batch names its full blast radius before it applies, and survives a re-search', async ({
  page,
}) => {
  await page.goto('/kitchen/availability?q=guac');
  await select(page, ['Guacamole']);

  // Before any kill: what it will stop, at full reach — not the rows the
  // filter happens to be showing.
  const batch = page.getByRole('region', { name: 'Selection' });
  await expect(batch).toContainText('1 selected. This will stop:');
  await expect(batch).toContainText('Used on: Burrito, California burrito, Torta, Loaded nachos');
  await expect(page.getByRole('button', { name: 'Mark all 1 sold out' })).toBeVisible();

  // The filter moves underneath the selection and the selection stays: it is
  // in the URL, not in the DOM of a page that just got replaced.
  await page.getByRole('searchbox', { name: /Find an item or option/ }).fill('churro');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByRole('heading', { name: '1 selected. This will stop:' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark Churros sold out' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Select Churros' })).toBeVisible();

  // Adding a row from the new filter keeps the one picked under the old.
  await select(page, ['Churros']);
  await expect(page.getByRole('button', { name: 'Mark all 2 sold out' })).toBeVisible();

  await page.getByRole('link', { name: 'Clear selection' }).click();
  await expect(page.getByRole('button', { name: /Mark all/ })).toHaveCount(0);
});

test('a category offers to select what it is showing, and only that', async ({ page }) => {
  await page.goto('/kitchen/availability');
  // A shortcut that SEEDS a selection — not a second way to kill, and not a
  // claim that a category maps to a station.
  await page.getByRole('link', { name: 'Select these 4 in Drinks' }).click();

  await expect(page.getByRole('heading', { name: '4 selected. This will stop:' })).toBeVisible();
  for (const name of ['Horchata', 'Agua fresca', 'Mexican Coke', 'Bottled water']) {
    await expect(page.getByRole('link', { name: `Selected ${name}` })).toBeVisible();
  }
  // Nothing outside the category came along.
  await expect(page.getByRole('link', { name: 'Selected Churros' })).toHaveCount(0);
});
