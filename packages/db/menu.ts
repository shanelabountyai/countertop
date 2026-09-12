// The menu, out of the database and into the shape packages/core reasons
// about. One mapping, in one place: the menu view, cart validation and
// placement all price against the same object, so none of them can disagree
// about what is on the menu right now.
//
// `menu.test.ts` asserts this round-trips SAMPLE_MENU exactly — a column added
// to the schema and forgotten here fails there rather than in a receipt.
import {
  nextDay,
  restaurantClock,
  type Menu,
  type ModifierGroup,
  type MenuItem,
  type RestaurantClock,
} from '@countertop/core';
import { prisma } from './index';

export async function loadMenu(now: Date = new Date()): Promise<Menu> {
  // P1-2, and it happens BEFORE the menu is read rather than beside it: the
  // effective price is a property of the menu, not a second thing a caller has
  // to remember to apply. That is the point — a resolution step a caller can
  // forget is a price authority with a hole in it. The three callers that hold
  // an instant of their own (placement, the rush, the seed) pass it; every
  // other one takes the default and gets today's prices without a line
  // changing.
  const staged = await effectivePrices(now);

  const [categories, items, groups] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.menuItem.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        modifierGroups: { orderBy: { sortOrder: 'asc' } },
        // P1-1. Ordered so the "served 07:00–11:00 and 16:00–21:00" sentence
        // reads in clock order without the label having to re-sort it.
        windows: { orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }] },
      },
    }),
    prisma.modifierGroup.findMany({
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    }),
  ]);

  return {
    categories: categories.map((category) => ({ id: category.id, name: category.name })),

    items: Object.fromEntries(
      items.map((item): [string, MenuItem] => [
        item.id,
        {
          id: item.id,
          categoryId: item.categoryId,
          name: item.name,
          // Absent, not null (P0-4) — the same `exactOptionalPropertyTypes`
          // care as `station` below. This is the ONLY new field here and it
          // stops at the live-menu surfaces: `placeOrder` builds its snapshot
          // lines from an explicit field list that does not include it, which
          // is why a description can be rewritten under a placed order without
          // the receipt moving (packages/db/snapshot.test.ts).
          ...(item.description === null ? {} : { description: item.description }),
          // The staged price if one has arrived, the live column otherwise
          // (P1-2). Resolved HERE, in the one mapping, so `priceLine` — the
          // price authority — needs no notion of a schedule and all three of
          // its call sites get the answer for free.
          basePriceCents: staged.items.get(item.id) ?? item.basePriceCents,
          available: item.available,
          prepWeight: item.prepWeight,
          // Absent, not null (C-112) — the same reason the windows below are
          // absent rather than empty. `menu.test.ts` round-trips SAMPLE_MENU
          // exactly, so a station added to the schema and forgotten here fails
          // there rather than as a missing button on the 86 board.
          ...(item.station === null ? {} : { station: item.station }),
          // Absent, not empty — the same `exactOptionalPropertyTypes` care the
          // option's `extraPriceDeltaCents` needs below, and the same reason:
          // `windows: []` and no key at all are different values, and only the
          // second matches an item written with no schedule.
          ...(item.windows.length === 0
            ? {}
            : {
                windows: item.windows.map((window) => ({
                  dayOfWeek: window.dayOfWeek,
                  startMinute: window.startMinute,
                  endMinute: window.endMinute,
                })),
              }),
          modifierGroupIds: item.modifierGroups.map((join) => join.groupId),
        },
      ]),
    ),

    groups: Object.fromEntries(
      groups.map((group): [string, ModifierGroup] => [
        group.id,
        {
          id: group.id,
          name: group.name,
          min: group.min,
          max: group.max,
          intensityEnabled: group.intensityEnabled,
          options: group.options.map((option) => ({
            id: option.id,
            name: option.name,
            priceDeltaCents: staged.options.get(option.id) ?? option.priceDeltaCents,
            // Absent, not null: `extraPriceDeltaCents: undefined` and no key
            // at all are different values under exactOptionalPropertyTypes,
            // and only the second matches what the core menu is written as.
            ...(option.extraPriceDeltaCents === null
              ? {}
              : { extraPriceDeltaCents: option.extraPriceDeltaCents }),
            available: option.available,
          })),
        },
      ]),
    ),
  };
}

/** Tax rate and timezone. Placement and every report bucket read these. */
export async function loadSettings(): Promise<{ timezone: string; taxRatePpm: number }> {
  // Throws rather than defaulting: a missing settings row must not become a
  // silent 0% tax on a real order.
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
  });
  return { timezone: settings.timezone, taxRatePpm: settings.taxRatePpm };
}

/**
 * The restaurant's wall clock right now — the reading THE orderability
 * function compares a daypart against (P1-1).
 *
 * The one place the menu request path reads a clock, the same way
 * `currentCheckout` is the one place the gate's path reads one. Everything
 * below it takes the reading as a parameter, which is what keeps
 * `packages/core` clock-free (CLAUDE.md time rules).
 *
 * `now` is a parameter with a default rather than a hard-coded `new Date()`,
 * so a test can freeze it without a fake timer.
 */
export async function loadClock(now: Date = new Date()): Promise<RestaurantClock> {
  return restaurantClock(now, (await loadSettings()).timezone);
}

/**
 * Today's prices, after every staged change whose day has arrived (P1-2).
 *
 * THE RESOLUTION RULE, in one place and in four lines: a staged row overrides
 * the live column once `effectiveDay` is today or earlier, and among rows that
 * have arrived the LATEST day wins. Ordered ascending and folded into a map,
 * so "latest wins" is the fold rather than a comparison somebody could get
 * backwards.
 *
 * Filtered in SQL rather than in JS: the spent rows are deleted when a manager
 * types a live price (see `writePrice` below), but a row that is merely
 * superseded stays, and a table that grows with every price change the
 * restaurant has ever made should not be read whole on every menu render.
 *
 * Returns `today` alongside, because every caller that wants the prices also
 * wants the day — to reject a change staged for yesterday, or to delete the
 * rows a live edit has just made spent. Two readings of one clock is how those
 * two disagree.
 *
 * String comparison, not date arithmetic: ISO days sort chronologically, which
 * is the reason `businessDay` is stored this way in the first place.
 */
export async function effectivePrices(
  now: Date = new Date(),
): Promise<{ today: string; items: Map<string, number>; options: Map<string, number> }> {
  const today = (await loadClock(now)).day;
  const rows = await prisma.stagedPrice.findMany({
    where: { effectiveDay: { lte: today } },
    orderBy: { effectiveDay: 'asc' },
  });

  const items = new Map<string, number>();
  const options = new Map<string, number>();
  for (const row of rows) {
    if (row.itemId !== null) items.set(row.itemId, row.priceCents);
    else if (row.optionId !== null) options.set(row.optionId, row.priceCents);
  }
  return { today, items, options };
}

/**
 * The changes still to come, for the editor to show and to let a manager
 * cancel (P1-2).
 *
 * Deliberately NOT part of `Menu`: a queued price is not a fact about what is
 * orderable right now, and putting it there would put it in front of the
 * customer menu, the cart and the placement path — three readers with no use
 * for it and one more thing to accidentally price against.
 *
 * Strictly `> today`. A row for today has already taken effect and is not
 * "coming"; it is the price, and it is already on the row above.
 */
export async function loadStagedPrices(
  now: Date = new Date(),
): Promise<{ id: string; itemId: string | null; optionId: string | null; effectiveDay: string; priceCents: number }[]> {
  const today = (await loadClock(now)).day;
  return prisma.stagedPrice.findMany({
    where: { effectiveDay: { gt: today } },
    orderBy: { effectiveDay: 'asc' },
    select: { id: true, itemId: true, optionId: true, effectiveDay: true, priceCents: true },
  });
}

/**
 * The earliest day a price change may be staged for: the restaurant's
 * tomorrow (P1-2).
 *
 * One answer, two callers — the `min` on the editor's date input and the e2e
 * fixture that fills it. A spec that wrote down its own "tomorrow" would be
 * computing it in whatever timezone the sweep happens to run in, and would
 * pass all day and fail for the hours either side of local midnight.
 */
export async function earliestStagedDay(now: Date = new Date()): Promise<string> {
  return nextDay((await loadClock(now)).day);
}

/**
 * Write a price — now, or on a day still to come (P1-2).
 *
 * Here rather than in the editor's action because THE PRECEDENCE lives here,
 * two functions below the resolution rule it is the inverse of. Splitting them
 * across packages is how "latest arrived wins" and "a live edit wins" end up
 * being two people's opinions instead of one rule.
 *
 * A LIVE write also deletes the staged rows that have already taken effect.
 * Without that delete a change that landed on Monday keeps overriding every
 * price typed after it: the manager types $13.50, sees "Saved", and the menu
 * goes on selling at Monday's $12.50 with nothing anywhere saying why. Rows still in
 * the FUTURE survive — fixing today's price is not a reason to cancel next
 * month's increase.
 *
 * A STAGED write replaces whatever was queued for that row on that day.
 * Delete-then-create rather than an upsert, because the uniques are over
 * nullable columns and re-staging the same day is the ordinary case: a manager
 * correcting the number they queued yesterday, not an error.
 *
 * `today` is passed in rather than read, so the caller that already validated
 * `effectiveDay` against a clock reading and the write that acts on it are
 * looking at the same day. Two readings across local midnight is how a change
 * gets refused as "not in the future" and then deleted as "already spent".
 */
export async function writePrice(
  target: { itemId: string } | { optionId: string },
  priceCents: number,
  effectiveDay: string | null,
  today: string,
): Promise<void> {
  if (effectiveDay !== null) {
    await prisma.$transaction([
      prisma.stagedPrice.deleteMany({ where: { ...target, effectiveDay } }),
      prisma.stagedPrice.create({ data: { ...target, effectiveDay, priceCents } }),
    ]);
    return;
  }

  const live =
    'itemId' in target
      ? prisma.menuItem.update({ where: { id: target.itemId }, data: { basePriceCents: priceCents } })
      : prisma.modifierOption.update({
          where: { id: target.optionId },
          data: { priceDeltaCents: priceCents },
        });

  await prisma.$transaction([
    live,
    prisma.stagedPrice.deleteMany({ where: { ...target, effectiveDay: { lte: today } } }),
  ]);
}

/**
 * The bulk 86 (P0-3), and the only thing that separates it from six taps: it
 * happens in one transaction and it reports which rows it actually flipped.
 *
 * It writes exactly the `available` booleans the single-row toggles write —
 * no new column, no batch entity, no per-item override of a shared option.
 * So everything downstream of an 86 is downstream of this too, by
 * construction: the menu renders "sold out", `validateComposition` refuses the
 * composition, `reviewCart` flags the lines already holding it, and a placed
 * order is untouched because it is a snapshot. That is P0-4, and it is a
 * property of the write rather than of six copied code paths.
 *
 * The RETURN is the load-bearing part. It is the rows that changed, not the
 * rows that were selected — so the undo offered next to the report restores
 * what this batch killed and nothing else. Six fried rows selected when two
 * were already sold out for a different reason means four came back, and the
 * two that ran out stay out.
 *
 * ONE STATEMENT PER GRAIN, and that is what makes the return trustworthy
 * (C-122). This read the rows first and then updated them, which meant two
 * cooks batching overlapping selections in the same second BOTH matched the
 * same still-available row and BOTH claimed to have killed it — and then the
 * first one to tap undo put it back on the menu while the second was still
 * looking at a report saying it was sold out. An item a customer can order and
 * the kitchen does not have is the founding failure of this product, arriving
 * through the undo of all places.
 *
 * The old comment here called that "an undo list that is short by the overlap"
 * and said "nobody loses an 86". Both halves were wrong, in the reassuring
 * direction: the lists come back LONG, because over-claiming is what a
 * check-then-write produces, and the lost 86 is the whole harm. It is written
 * down because a `ponytail:` that mis-describes its own defect is worse than
 * no comment — it is a reason not to look.
 *
 * `updateManyAndReturn` puts the guard in the WHERE of the write itself, so
 * Postgres re-evaluates `available = !available` against the row it just
 * locked: the loser of a race matches nothing, returns nothing, and claims
 * nothing. Same shape as C-119's member lock — the fix is not a lock added
 * around a read, it is the read and the write becoming one statement.
 */
export async function setAvailability(
  itemIds: string[],
  optionIds: string[],
  available: boolean,
): Promise<{ itemIds: string[]; optionIds: string[] }> {
  // STILL ONE TRANSACTION, for the reason it always was: a batch that killed
  // the items and not the options would leave the fryer half off the menu.
  // What changed is that each statement is now its own guard — the
  // `available: !available` clause is in the WHERE of the UPDATE, not in a
  // SELECT that ran before it.
  const [items, options] = await prisma.$transaction([
    prisma.menuItem.updateManyAndReturn({
      where: { id: { in: itemIds }, available: !available },
      data: { available },
      select: { id: true },
    }),
    prisma.modifierOption.updateManyAndReturn({
      where: { id: { in: optionIds }, available: !available },
      data: { available },
      select: { id: true },
    }),
  ]);

  return { itemIds: items.map((r) => r.id), optionIds: options.map((r) => r.id) };
}
