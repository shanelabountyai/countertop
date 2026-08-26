// Test-only helpers. Not imported by apps/web.
import { SAMPLE_MENU } from '@countertop/core';
import { prisma } from '../index';

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
      "Category", "RestaurantSettings", "StoreHours"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Writes packages/core's SAMPLE_MENU into the database, keeping its readable
 * ids ('burrito', 'guacamole') as primary keys so a failing assertion names
 * something you can find. C-017 grew it to 25 items and 8 groups; the shape
 * did not change, which is why nothing here did either.
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

type SettingsOverrides = {
  timezone?: string;
  taxRatePpm?: number;
  ordersPaused?: boolean;
  pauseMessage?: string | null;
  maxOpenOrders?: number;
  closedOnDay?: string | null;
  cutoffMinutes?: number;
  prepBaseMinutes?: number;
  prepPerOrderMinutes?: number;
};

/**
 * The singleton settings row. Placement reads the timezone (the business day
 * the order number resets on), the tax rate, and the whole P0-6 gate from
 * here, so every test that places an order needs one — `loadSettings` and
 * `loadGateState` throw rather than defaulting, which is the behaviour that
 * keeps a missing row from becoming a silent 0% or an accidentally wide-open
 * restaurant.
 *
 * The gate defaults here are deliberately WIDE: `cutoffMinutes: 0` on top of
 * the round-the-clock hours below. The schema default is 15 minutes, which
 * would close the seeded restaurant between 23:45 and midnight — and a suite
 * that passes all day and fails for the fifteen minutes before local midnight
 * is a suite nobody trusts again. Tests that want the gate shut ask for it.
 */
export async function seedSettings(overrides: SettingsOverrides = {}): Promise<void> {
  await prisma.restaurantSettings.upsert({
    where: { id: 'singleton' },
    update: overrides,
    create: {
      id: 'singleton',
      timezone: overrides.timezone ?? 'America/Los_Angeles',
      taxRatePpm: overrides.taxRatePpm ?? 82_500,
      ordersPaused: overrides.ordersPaused ?? false,
      pauseMessage: overrides.pauseMessage ?? null,
      maxOpenOrders: overrides.maxOpenOrders ?? 25,
      closedOnDay: overrides.closedOnDay ?? null,
      cutoffMinutes: overrides.cutoffMinutes ?? 0,
      prepBaseMinutes: overrides.prepBaseMinutes ?? 12,
      prepPerOrderMinutes: overrides.prepPerOrderMinutes ?? 1,
    },
  });
}

/**
 * Store hours (P0-6). Defaults to open every day, all day.
 *
 * "Always open" is the only configuration that makes a test suite independent
 * of the wall-clock hour it runs at, and CI runs this twice under two very
 * different timezones. The three gate triggers are exercised through the ones
 * that ARE deterministic — the pause switch, the closed-today override, and
 * the open-order threshold — plus the pure unit tests in packages/core, which
 * drive the clock directly.
 */
export async function seedStoreHours(
  days: { dayOfWeek: number; openMinute: number; closeMinute: number }[] = [0, 1, 2, 3, 4, 5, 6].map(
    (dayOfWeek) => ({ dayOfWeek, openMinute: 0, closeMinute: 1440 }),
  ),
): Promise<void> {
  await prisma.storeHours.deleteMany();
  await prisma.storeHours.createMany({ data: days });
}
