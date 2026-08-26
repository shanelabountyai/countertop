import { execSync } from 'node:child_process';
import { expect, type Locator, type Page } from '@playwright/test';

// Shared e2e fixtures (C-025).
//
// These exist because of a defect class, not because of tidiness. Four times
// now a spec has clicked something that triggers a server action and then
// navigated before the write landed — C-014's cart cookie, C-015's price save,
// C-019's `page.close()` after a cancel, C-023's checkout. Every one of them
// was a spec quietly writing its own worse copy of a helper that already
// existed one file over, complete with the guard removed.
//
// So the guard lives HERE, once. A spec that composes its own order by hand is
// welcome to — the composer's own suite has to — but nothing else should have
// to remember.

/**
 * Put the test database back to `packages/db/seed.ts`, between tests that
 * rewrite live rows.
 *
 * CAPTURES stderr rather than discarding it. `stdio: 'ignore'` turned a seed
 * failure into the string "Command failed: npm run db:seed:test" and nothing
 * else, which is a failure you can only reproduce by guessing. The seed talks
 * to the same Postgres the app under test is holding connections to, so a
 * TRUNCATE can genuinely lose a lock race with an in-flight poll; when that
 * happens the message is worth having.
 */
export function reseed(): void {
  try {
    execSync('npm run db:seed:test', {
      cwd: '../..',
      // stdout ignored (it is npm's banner); stderr kept, because that is the
      // half with the reason in it.
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`db:seed:test failed${stderr ? `:\n${stderr}` : ' with no output'}`);
  }
}

/**
 * Seed the SEEDED RUSH, stopped twelve minutes in (C-017, C-019, C-028).
 *
 * Twenty-two live tickets across all four queue states, anchored so minute 12
 * is now — so the ages on the cards are the ages a cook would be reading. It
 * replaces the ordinary seed entirely; every spec file that follows reseeds,
 * which is what makes that safe (C-026).
 */
export function seedMidServiceRush(): void {
  runSeedScript('db:rush:test');
}

/** The whole rush, worked to the end: 28 picked up, 1 cancelled, 1 no-show.
 *  What the sales report looks like with a day's service behind it. */
export function seedFinishedRush(): void {
  runSeedScript('db:rush:test:full');
}

function runSeedScript(script: string): void {
  try {
    execSync(`npm run ${script}`, { cwd: '../..', stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(`${script} failed${stderr ? `:\n${stderr}` : ' with no output'}`);
  }
}

/**
 * One order card on the kitchen queue, by the customer's name.
 *
 * `.first()` because a card's option lines are list items too, and a name that
 * matches the card matches its wrapper as well.
 *
 * Takes a `Page` rather than reading a fixture, because half the tests that
 * want it are driving a SECOND page — the kitchen tab beside the customer's.
 */
export const card = (page: Page, name: string): Locator =>
  page.getByRole('listitem').filter({ hasText: name }).first();

/**
 * Compose the standard burrito and land on the cart.
 *
 * Burrito 1095 + chicken 0 = 1095; tax 8.25% of 1095 = 90.3375 → 90; total
 * 1185. With guacamole: 1345 + 110 tax = 1455.
 *
 * The `toHaveURL` is the guard the whole file exists for. The cart is an
 * httpOnly cookie written by the server action's RESPONSE, and a `goto` racing
 * that response arrives at an empty cart — a failure that looks like a
 * rendering bug and is not one.
 */
export async function addBurritoToCart(
  page: Page,
  { guacamole = false }: { guacamole?: boolean } = {},
): Promise<void> {
  await page.goto('/menu/burrito');
  await page.getByRole('radio', { name: /Chicken/ }).check();
  if (guacamole) await page.getByRole('checkbox', { name: /Guacamole/ }).check();
  await page.getByRole('button', { name: /Add to cart/ }).click();
  await expect(page).toHaveURL(/\/cart/);
}

/**
 * A real order, placed through the real screens, returning the customer's
 * tokenized status link.
 *
 * Every step waits for the one before it to have happened: the cart URL after
 * the add, the order number after the place. The link is asserted to look like
 * one before it is handed back, so a spec that goes on to `goto` it fails HERE
 * if placement quietly did not produce it.
 */
export async function placeOrderFor(page: Page, name: string): Promise<string> {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill(name);
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();

  const href = await page.getByTestId('track-order').getAttribute('href');
  expect(href).toMatch(/^\/status\/.+/);
  return href as string;
}
