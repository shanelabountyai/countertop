import { execSync } from 'node:child_process';
import { expect, test, type Locator, type Page } from '@playwright/test';

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
  // The rush seeds are a whole `npm run` — dotenv, tsx, and thirty orders of
  // writes — billed to the calling test's 30s budget. Measured at 3.4s on an
  // idle machine and 37.8s during a sweep that had ci:local's databases and a
  // second Postgres client competing with it; the second number timed a test
  // out that had passed minutes earlier, which reads as a flaky report and is
  // an under-budgeted seed. `test.slow()` triples the budget rather than
  // moving the seed, because the seed BEING part of the test is the point.
  // Not in `reseed()`: kitchen.spec.ts calls that from `beforeAll`, where
  // `test.slow()` throws — and the ordinary seed is the fast one anyway.
  test.slow();
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
 * An orderable row on the customer menu, by item name and price (C-080).
 *
 * It exists because nine specs had written `{ name: /Burrito \$10\.95/ }` —
 * an assertion that the name is followed IMMEDIATELY by the price, which was
 * true only for as long as nothing else was in the row. P0-4 put the
 * description inside the tap target, so a described item's accessible name is
 * now "Burrito Hot off the griddle… $10.95" and an undescribed one's is still
 * "Chips & salsa $3.50". Both are the same claim — this row, this price — and
 * no spec should have to know which kind of item it is looking at, nor break
 * again the next time something lands between the two.
 *
 * The price is part of the pattern rather than a separate `toContainText`,
 * because it is also what disambiguates: "Burrito" is a prefix of "Burrito
 * bowl", and Playwright matches accessible names by substring.
 */
export const menuRow = (page: Page, name: string, price: string): Locator => {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByRole('link', {
    name: new RegExp(`^${escape(name)}\\b.*${escape(price)}$`),
  });
};

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
   *  places a paid order, which is what the checkout form defaults to.
   *  `phone` likewise leaves the field blank unless a spec is about what the
   *  phone gates (loyalty, the P1-3 SMS stub). */
  { payAtPickup = false, phone }: { payAtPickup?: boolean; phone?: string } = {},
): Promise<string> {
  await addBurritoToCart(page);
  await page.getByRole('link', { name: 'Checkout' }).click();
  await page.getByRole('textbox', { name: /Name for the order/ }).fill(name);
  if (phone) await page.getByRole('textbox', { name: /Phone/ }).fill(phone);
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

/**
 * Cancel a paid order with a refund provider that refuses (PRD 3 P0-4, C-067).
 *
 * THE REAL PATH, not a fabricated row. `applyOrderAction` takes the provider as
 * a default parameter for exactly this — so the cancellation, the
 * `refund_requested` written inside its transaction and the `refund_failed`
 * written after it are all produced by the code that runs in production, and
 * only the thing on the far side of the network boundary is substituted.
 *
 * A failing refund is not reachable through the screens by design: the mock
 * provider always succeeds, and an app-wide "make refunds fail" switch would be
 * a production code path that exists for the tests. This is the one thing a
 * fixture may do that a spec may not, like `backdateQueue`.
 *
 * Same Prisma client discipline as the other db fixtures: import late,
 * disconnect immediately, because the next `reseed()` TRUNCATEs these tables.
 */
export async function failRefundFor(customerName: string): Promise<void> {
  const { prisma } = await import('@countertop/db');
  const { applyOrderAction } = await import('@countertop/db/transitions');
  const { collectOrderPayment } = await import('@countertop/db/payment');
  try {
    const order = await prisma.order.findFirstOrThrow({
      where: { customerName },
      orderBy: { placedAt: 'desc' },
      select: { id: true },
    });
    // MONEY, NOT A HOLD (C-069). A prepaid order carries an authorization now,
    // and cancelling one releases it — there is nothing to refund, which is the
    // point of P1-1. A refund needs money that actually arrived, so this takes
    // it at the counter first, through the same write path the "Collected —
    // mark paid" button uses.
    const collected = await collectOrderPayment(order.id, new Date());
    if (!collected.ok) throw new Error(`collection refused: ${collected.message}`);

    const result = await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      new Date(),
      null,
      async () => {
        throw new Error('card network declined');
      },
    );
    if (!result.ok) throw new Error(`cancel refused: ${result.failure.message}`);
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Put an item on a daypart window that is open, or closed, RIGHT NOW
 * (P1-1, C-110).
 *
 * The caller says which side of the window it wants to be on and this picks
 * the minutes, reading the restaurant's own clock. That is the whole design:
 * fixed hours ("Fridays 16:00–21:00") would make the spec's outcome depend on
 * what time the sweep happens to run, which is the defect `seedSettings`'
 * round-the-clock hours exist to avoid — a suite that passes all day and fails
 * for one hour is a suite nobody trusts again. Offsets ("an hour ago") have
 * the same problem in a smaller window: the schema forecloses overnight
 * windows, so "an hour ago" is unwritable for the first hour of a local day.
 *
 * Chosen so a window exists at every minute of the day:
 *   served     → the whole day, `[0, 1440)`
 *   not served → everything up to now, `[0, minuteOfDay)`, or, at exactly
 *                midnight, everything after it
 *
 * Returns the minutes written, so the spec can build the expected "Served
 * 00:00–14:23" label itself rather than asking the app what it should say.
 *
 * No item is seeded with a window — see docs/WRITEUP.md — so this is the only
 * thing in the suite that creates one, and `reseed()` removes it.
 */
export async function setDaypart(
  itemId: string,
  when: 'served' | 'not served',
): Promise<{ startMinute: number; endMinute: number }> {
  const { prisma } = await import('@countertop/db');
  const { loadClock } = await import('@countertop/db/menu');
  try {
    const clock = await loadClock();
    const window =
      when === 'served'
        ? { startMinute: 0, endMinute: 1440 }
        : clock.minuteOfDay > 0
          ? { startMinute: 0, endMinute: clock.minuteOfDay }
          : { startMinute: 1, endMinute: 1440 };

    await prisma.menuItemWindow.create({
      data: { itemId, dayOfWeek: clock.weekday, ...window },
    });
    return window;
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * The restaurant's tomorrow, as "YYYY-MM-DD" — the earliest day a price change
 * may be staged for (P1-2, C-111).
 *
 * Read off the restaurant's own clock rather than written down, for the same
 * reason `setDaypart` picks its minutes that way: a fixed date rots, and a
 * suite that starts failing on a particular Tuesday is a suite nobody trusts
 * again. It is also the only correct answer — "tomorrow" in Los Angeles is not
 * "tomorrow" wherever the sweep is running.
 */
export async function restaurantTomorrow(): Promise<string> {
  const { prisma } = await import('@countertop/db');
  const { earliestStagedDay } = await import('@countertop/db/menu');
  try {
    // AWAITED before the finally, not returned as a pending promise: the
    // `$disconnect()` below would otherwise race the query it is supposed to
    // be cleaning up after, and the next test in the worker gets "Response
    // from the Engine was empty".
    return await earliestStagedDay();
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Declare today closed — the same one-tap override the settings screen writes
 * (P0-6), reached from a spec that needs the gate shut and the footer's hours
 * to agree about why (C-077).
 *
 * The date comes off the RESTAURANT's clock, never the runner's: a sweep in
 * another timezone would otherwise close the wrong day and the test would fail
 * for reasons that have nothing to do with the code under test.
 *
 * That clock is reached through `@countertop/db/menu`, NOT by importing
 * `@countertop/core` here. Importing core directly from a fixture is the one
 * thing this file must not do: it loads under Playwright's transform as plain
 * CJS, and the untransformed module then sits in the require cache so the NEXT
 * spec to reach `@countertop/db/menu` dies on `Unexpected token 'export'` —
 * a failure in a file that did nothing wrong, four tests later (C-077).
 */
export async function closeRestaurantToday(): Promise<void> {
  const { prisma } = await import('@countertop/db');
  const { loadClock } = await import('@countertop/db/menu');
  try {
    await prisma.restaurantSettings.update({
      where: { id: 'singleton' },
      data: { closedOnDay: (await loadClock()).day },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/** Blank out the three C-077 contact columns — the state every database was in
 *  before that migration, and the one the footer has to render without a hole
 *  in it. */
export async function clearRestaurantContact(): Promise<void> {
  const { prisma } = await import('@countertop/db');
  try {
    await prisma.restaurantSettings.update({
      where: { id: 'singleton' },
      data: { name: null, addressLine: null, phone: null },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Move an order's placement back, relative to the quote SNAPSHOTTED on it
 * (PRD 5 P0-2, C-078).
 *
 * The one thing a fixture may do that a spec may not, for `backdateQueue`'s
 * reason: there is no way to make an order late through the screens and no way
 * to wait twenty-five minutes for one either.
 *
 * The caller says WHERE relative to the order's own quote, never a literal
 * number of minutes. The quote is `prepBaseMinutes` plus the open weight at
 * placement — so it depends on what the seed happens to have on the queue, and
 * a spec that hardcoded "26 minutes ago" would be asserting against a number it
 * had guessed rather than against the promise the product made.
 */
export async function ageOrder(
  customerName: string,
  minutesAgo: (quote: { lowMinutes: number; highMinutes: number }) => number,
): Promise<void> {
  const { prisma } = await import('@countertop/db');
  try {
    const order = await prisma.order.findFirstOrThrow({
      where: { customerName },
      orderBy: { placedAt: 'desc' },
      select: { id: true, quotedLowMinutes: true, quotedHighMinutes: true },
    });
    // An order with no quote cannot be aged against one, and silently aging it
    // by NaN minutes would surface as a status page rendering nothing.
    if (order.quotedLowMinutes === null || order.quotedHighMinutes === null) {
      throw new Error(`${customerName}'s order carries no snapshotted quote to age against`);
    }
    const minutes = minutesAgo({
      lowMinutes: order.quotedLowMinutes,
      highMinutes: order.quotedHighMinutes,
    });
    // `setTime` off a clock read, not `new Date(millis)`: the argument form is
    // banned repo-wide (no-time-axis) and the ban is right — this is an instant
    // shifted by an offset, which crosses no calendar axis at all. Not
    // `instantMinutesAfter` either, for the reason above `closeRestaurantToday`:
    // a fixture must never import `@countertop/core` directly.
    const placedAt = new Date();
    placedAt.setTime(placedAt.getTime() - minutes * 60_000);
    await prisma.order.update({
      where: { id: order.id },
      // Only `placedAt`: the quote stays exactly as placement wrote it, which
      // is the half of P0-2 under test.
      data: { placedAt },
    });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * Put today's last-order minute exactly `minutesOut` minutes from now
 * (PRD 5 P0-3, C-079).
 *
 * Read off the RESTAURANT's clock and expressed as an offset from it, for
 * `setDaypart`'s reason: fixed hours would make the spec's outcome depend on
 * what time the sweep happens to run.
 *
 * Both knobs move together because only their difference matters. The close
 * stays inside the day (`closeMinute` is capped at 1440 by a CHECK), and the
 * cutoff absorbs whatever is left — so this works at every minute of the local
 * day except the last `minutesOut` of it, where the target minute is tomorrow
 * and the schema has no way to say so. That window throws rather than quietly
 * setting something else: a fixture that half-worked would surface as an
 * assertion failure about the warning, three files away from the cause.
 */
export async function setLastOrderIn(minutesOut: number): Promise<void> {
  const { prisma } = await import('@countertop/db');
  const { loadClock } = await import('@countertop/db/menu');
  try {
    const clock = await loadClock();
    const target = clock.minuteOfDay + minutesOut;
    if (target > 1440) {
      throw new Error(
        `last call ${minutesOut} min out lands past midnight (local ${clock.minuteOfDay}); no hours row can say that`,
      );
    }
    // 15 minutes of kitchen time after the door shuts, where the day has room
    // for it — the seeded default is 0, and a cutoff of 0 would make this
    // fixture indistinguishable from "we close now".
    const closeMinute = Math.min(1440, target + 15);
    await prisma.storeHours.update({
      where: { dayOfWeek: clock.weekday },
      data: { openMinute: 0, closeMinute },
    });
    await prisma.restaurantSettings.update({
      where: { id: 'singleton' },
      data: { cutoffMinutes: closeMinute - target },
    });
  } finally {
    await prisma.$disconnect();
  }
}
