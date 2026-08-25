// Test-only helpers. Not imported by apps/web.
import { SAMPLE_MENU } from '@countertop/core';
import { prisma } from '../index.js';

/**
 * Wipes every table. TRUNCATE, not DELETE: the OrderEvent append-only trigger
 * refuses DELETE by design, and TRUNCATE fires TRUNCATE triggers rather than
 * row triggers. Nothing in the application issues one.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "OrderEvent", "OrderLineOption", "OrderLine", "Order",
      "ItemModifierGroup", "ModifierOption", "ModifierGroup", "MenuItem",
      "Category", "RestaurantSettings"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Writes packages/core's SAMPLE_MENU into the database, keeping its readable
 * ids ('burrito', 'guacamole') as primary keys so a failing assertion names
 * something you can find. C-017's seed grows this to the PRD's ~25 items; the
 * shape does not change.
 */
export async function seedSampleMenu(): Promise<void> {
  await prisma.category.createMany({
    data: SAMPLE_MENU.categories.map((category, index) => ({
      id: category.id,
      name: category.name,
      sortOrder: index,
    })),
  });

  const groups = Object.values(SAMPLE_MENU.groups);
  await prisma.modifierGroup.createMany({
    data: groups.map((group) => ({
      id: group.id,
      name: group.name,
      min: group.min,
      max: group.max,
      intensityEnabled: group.intensityEnabled,
    })),
  });
  await prisma.modifierOption.createMany({
    data: groups.flatMap((group) =>
      group.options.map((option, index) => ({
        id: option.id,
        groupId: group.id,
        name: option.name,
        priceDeltaCents: option.priceDeltaCents,
        extraPriceDeltaCents: option.extraPriceDeltaCents ?? null,
        available: option.available,
        sortOrder: index,
      })),
    ),
  });

  const items = Object.values(SAMPLE_MENU.items);
  await prisma.menuItem.createMany({
    data: items.map((item, index) => ({
      id: item.id,
      categoryId: item.categoryId,
      name: item.name,
      basePriceCents: item.basePriceCents,
      available: item.available,
      sortOrder: index,
    })),
  });
  await prisma.itemModifierGroup.createMany({
    data: items.flatMap((item) =>
      item.modifierGroupIds.map((groupId, index) => ({
        itemId: item.id,
        groupId,
        sortOrder: index,
      })),
    ),
  });
}

/**
 * The singleton settings row. Placement reads the timezone (the business day
 * the order number resets on) and the tax rate from here, so every test that
 * places an order needs one — `loadSettings` throws rather than defaulting,
 * which is the behaviour that keeps a missing row from becoming a silent 0%.
 */
export async function seedSettings(
  overrides: { timezone?: string; taxRatePpm?: number } = {},
): Promise<void> {
  await prisma.restaurantSettings.upsert({
    where: { id: 'singleton' },
    update: overrides,
    create: {
      id: 'singleton',
      timezone: overrides.timezone ?? 'America/Los_Angeles',
      taxRatePpm: overrides.taxRatePpm ?? 82_500,
    },
  });
}
