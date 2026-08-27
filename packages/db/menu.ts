// The menu, out of the database and into the shape packages/core reasons
// about. One mapping, in one place: the menu view, cart validation and
// placement all price against the same object, so none of them can disagree
// about what is on the menu right now.
//
// `menu.test.ts` asserts this round-trips SAMPLE_MENU exactly — a column added
// to the schema and forgotten here fails there rather than in a receipt.
import type { Menu, ModifierGroup, MenuItem } from '@countertop/core';
import { prisma } from './index';

export async function loadMenu(): Promise<Menu> {
  const [categories, items, groups] = await Promise.all([
    prisma.category.findMany({ orderBy: { sortOrder: 'asc' } }),
    prisma.menuItem.findMany({
      orderBy: { sortOrder: 'asc' },
      include: { modifierGroups: { orderBy: { sortOrder: 'asc' } } },
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
