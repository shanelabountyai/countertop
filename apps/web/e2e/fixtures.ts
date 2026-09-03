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
export async function placeOrderFor(
  page: Page,
  name: string,
  /** P1-8. Leaves the default alone unless a spec asks — every existing spec
   *  places a paid order, which is what the checkout form defaults to. */
  { payAtPickup = false }: { payAtPickup?: boolean } = {},
): Promise<string> {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill(name);
  if (payAtPickup) await page.getByRole('radio', { name: /Pay at pickup/ }).check();
  await page.getByRole('button', { name: /Place order/ }).click();
  await expect(page.getByTestId('order-number')).toBeVisible();

  const href = await page.getByTestId('track-order').getAttribute('href');
  expect(href).toMatch(/^\/status\/.+/);
  return href as string;
}

/**
 * Move every order on the queue back to an earlier business day (P1-6).
 *
 * There is no way to produce a leftover through the screens — `businessDay` is
 * assigned by the server from the instant of placement — and no way to wait for
 * one either. So the row is edited directly, which is the one thing a fixture
 * may do that a spec may not.
 *
 * Prisma rather than a `psql` shell-out: the spec process already has the
 * client as a dependency and the connection string in its environment, and a
 * `psql` on PATH is an assumption about the machine rather than about the
 * project. Disconnects immediately, because the next `reseed()` TRUNCATEs the
 * same tables and an idle pool from this process is a lock race waiting to
 * happen.
 *
 * Returns the day it wrote, so the assertion can name it rather than matching
 * a loose pattern.
 */
export async function backdateQueue(businessDay = '2020-01-01'): Promise<string> {
  const { prisma } = await import('@countertop/db');
  try {
    await prisma.order.updateMany({ data: { businessDay } });
  } finally {
    await prisma.$disconnect();
  }
  return businessDay;
}

/**
 * Tap a card forward through the REAL buttons until it is picked up.
 *
 * Each label comes from the status module, so this walks the actual state
 * machine rather than writing a status into the database. Shared the moment it
 * had a second caller: four separate defects in this repo came from a spec
 * quietly reinventing a helper that already existed one file over.
 */
export async function pickUp(page: Page, name: string): Promise<void> {
  for (const label of ['Accept', 'Start cooking', 'Food is ready', 'Picked up']) {
    const button = card(page, name).getByRole('button', { name: label, exact: true });
    if ((await button.count()) === 0) continue;
    await button.click();
    await expect(button).toHaveCount(0);
  }
}

/**
 * Switch the punch card on or off (PRD 7 P0-1, C-101).
 *
 * DIRECTLY, EVEN THOUGH THERE IS NOW A SCREEN (C-106's /kitchen/loyalty). The
 * ten-odd specs that want the program on want it as a precondition, and paying
 * two navigations and a form post each to arrive at one is the slowest way to
 * assert something a spec is not about. What keeps this honest is that the
 * REAL toggle has its own spec — `switches the punch card on from its own
 * screen` in loyalty.spec.ts drives the button and then checks the checkout
 * follows it — so a fixture that wrote the wrong column could not pass
 * unnoticed.
 *
 * `reseed()` puts it back to false, which is the seeded default and the state
 * every other spec in the suite runs against.
 */
export async function setLoyaltyEnabled(loyaltyEnabled: boolean): Promise<void> {
  const { prisma } = await import('@countertop/db');
  try {
    await prisma.restaurantSettings.update({ where: { id: 'singleton' }, data: { loyaltyEnabled } });
  } finally {
    await prisma.$disconnect();
  }
}

/** Every loyalty member, as stored. The digest included — a spec asserting the
 *  phone is not in the table has to be able to look at the whole row. */
export async function loyaltyMembers(): Promise<
  { phoneDigest: string; phoneLast4: string; displayName: string }[]
> {
  const { prisma } = await import('@countertop/db');
  try {
    return await prisma.loyaltyMember.findMany({
      select: { phoneDigest: true, phoneLast4: true, displayName: true },
      orderBy: { enrolledAt: 'asc' },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * A staff correction on the only member's balance (PRD 7 P0-2's `adjust`).
 *
 * The one thing a fixture may do that a spec may not, for the same reason
 * `backdateQueue` exists: the reward threshold is 100 points and a burrito
 * earns 10, so reaching "reward available" through the screens is ten orders
 * of clicking to assert one line of copy. `adjust` is a real kind with a real
 * sign, so this writes a row the product itself would write rather than a
 * fictional one — and the panel it feeds sums the ledger, so a fabricated
 * balance column could not have been faked here even if one existed.
 */
export async function adjustLoyaltyPoints(points: number): Promise<void> {
  const { prisma } = await import('@countertop/db');
  try {
    const member = await prisma.loyaltyMember.findFirstOrThrow();
    await prisma.loyaltyEvent.create({
      data: { memberId: member.id, at: new Date(), kind: 'adjust', points, reason: 'e2e fixture' },
    });
  } finally {
    await prisma.$disconnect();
  }
}
