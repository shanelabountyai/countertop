// The menu, out of the database and into the shape packages/core reasons
// about. One mapping, in one place: the menu view, cart validation and
// placement all price against the same object, so none of them can disagree
// about what is on the menu right now.
//
// `menu.test.ts` asserts this round-trips SAMPLE_MENU exactly — a column added
// to the schema and forgotten here fails there rather than in a receipt.
import { restaurantClock, type Menu, type ModifierGroup, type MenuItem, type RestaurantClock } from '@countertop/core';
import { prisma } from './index';

export async function loadMenu(): Promise<Menu> {
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
          basePriceCents: item.basePriceCents,
          available: item.available,
          prepWeight: item.prepWeight,
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
            priceDeltaCents: option.priceDeltaCents,
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
 * ponytail: read-then-write, last-write-wins, the same concurrency posture
 * C-015 recorded for two managers on stale panels. Two cooks batching
 * overlapping selections in the same second can hand one of them an undo list
 * that is short by the overlap; nobody loses an 86, and the fix if it ever
 * matters is a single `UPDATE ... RETURNING id` in raw SQL.
 */
export async function setAvailability(
  itemIds: string[],
  optionIds: string[],
  available: boolean,
): Promise<{ itemIds: string[]; optionIds: string[] }> {
  const [items, options] = await Promise.all([
    prisma.menuItem.findMany({
      where: { id: { in: itemIds }, available: !available },
      select: { id: true },
    }),
    prisma.modifierOption.findMany({
      where: { id: { in: optionIds }, available: !available },
      select: { id: true },
    }),
  ]);

  const changed = { itemIds: items.map((r) => r.id), optionIds: options.map((r) => r.id) };

  await prisma.$transaction([
    prisma.menuItem.updateMany({ where: { id: { in: changed.itemIds } }, data: { available } }),
    prisma.modifierOption.updateMany({
      where: { id: { in: changed.optionIds } },
      data: { available },
    }),
  ]);

  return changed;
}
