import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SAMPLE_MENU } from '@countertop/core';
import { loadMenu, loadSettings, setAvailability } from './menu';
import { prisma } from './index';
import { resetDatabase, seedSampleMenu } from './testing/index';

// The mapping test that keeps the database and the engine speaking the same
// language: seed the core menu, read it back, expect the same object. A column
// added to the schema and not mapped shows up here, not in a wrong receipt.
describe('loadMenu', () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedSampleMenu();
  });

  it('round-trips the sample menu exactly, ordering included', async () => {
    const menu = await loadMenu();
    expect(menu).toEqual(SAMPLE_MENU);
    expect(menu.groups.salsa?.options.map((o) => o.id)).toEqual(['chipotle', 'verde', 'pico']);
    expect(menu.items.bowl?.modifierGroupIds).toEqual(['size', 'protein', 'salsa']);
  });

  it('reads an 86 as an 86', async () => {
    await prisma.modifierOption.update({
      where: { id: 'guacamole' },
      data: { available: false },
    });
    const menu = await loadMenu();
    expect(menu.groups.addons?.options.find((o) => o.id === 'guacamole')?.available).toBe(false);
    await prisma.modifierOption.update({ where: { id: 'guacamole' }, data: { available: true } });
  });

  // P1-1. Absent, not empty: the round-trip above expects an item with no
  // schedule to have NO `windows` key at all, which is what SAMPLE_MENU is
  // written as and what `exactOptionalPropertyTypes` distinguishes. Mapping it
  // as `windows: []` would fail that test — this one says why on purpose.
  it('maps daypart windows, and only onto the items that have them', async () => {
    await prisma.menuItemWindow.createMany({
      data: [
        { itemId: 'taco-plate', dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 },
        { itemId: 'taco-plate', dayOfWeek: 5, startMinute: 7 * 60, endMinute: 11 * 60 },
      ],
    });

    const menu = await loadMenu();
    // In clock order, so the "07:00–11:00 and 16:00–21:00" sentence reads
    // without the label having to re-sort them.
    expect(menu.items['taco-plate']?.windows).toEqual([
      { dayOfWeek: 5, startMinute: 7 * 60, endMinute: 11 * 60 },
      { dayOfWeek: 5, startMinute: 16 * 60, endMinute: 21 * 60 },
    ]);
    expect(menu.items.burrito).not.toHaveProperty('windows');

    await prisma.menuItemWindow.deleteMany();
  });

  it('refuses to invent settings when the row is missing', async () => {
    await expect(loadSettings()).rejects.toThrow();
    await prisma.restaurantSettings.create({
      data: { id: 'singleton', timezone: 'America/Los_Angeles', taxRatePpm: 82_500 },
    });
    await expect(loadSettings()).resolves.toEqual({
      timezone: 'America/Los_Angeles',
      taxRatePpm: 82_500,
    });
  });
});

// C-109 (P0-3): the bulk 86, and the one thing about it that is not just six
// taps in a loop — it reports the rows it FLIPPED, which is what makes the
// undo beside the report honest.
describe('setAvailability', () => {
  // The fryer going down: five rows across three categories, which is the
  // whole reason the batch is a selection and not a category.
  const FRIED = ['chips', 'chips-guac', 'taquitos', 'nachos', 'churros'];

  const availability = async () => {
    const [items, options] = await Promise.all([
      prisma.menuItem.findMany({ where: { available: false }, select: { id: true } }),
      prisma.modifierOption.findMany({ where: { available: false }, select: { id: true } }),
    ]);
    return {
      items: items.map((r) => r.id).sort(),
      options: options.map((r) => r.id).sort(),
    };
  };

  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
  });

  it('kills a selection spanning both grains in one action', async () => {
    const changed = await setAvailability(FRIED, ['guacamole'], false);

    expect(changed.itemIds.sort()).toEqual([...FRIED].sort());
    expect(changed.optionIds).toEqual(['guacamole']);
    expect(await availability()).toEqual({
      items: [...FRIED].sort(),
      options: ['guacamole'],
    });
  });

  it('reports the rows it flipped, not the rows it was handed', async () => {
    // Churros ran out an hour ago, for its own reason. It is in the selection
    // because the cook swept the fryer's whole output; it is not something
    // this batch did.
    await prisma.menuItem.update({ where: { id: 'churros' }, data: { available: false } });

    const changed = await setAvailability(FRIED, [], false);
    expect(changed.itemIds.sort()).toEqual(['chips', 'chips-guac', 'nachos', 'taquitos']);
    expect(changed.itemIds).not.toContain('churros');
  });

  it('undoes exactly what it did and nothing else', async () => {
    await prisma.menuItem.update({ where: { id: 'churros' }, data: { available: false } });
    const killed = await setAvailability(FRIED, [], false);

    // The undo acts on what came back, which is the whole point of it coming
    // back: the fryer is fixed, and the churros the shop genuinely ran out of
    // stay off the menu.
    const restored = await setAvailability(killed.itemIds, killed.optionIds, true);

    expect(restored.itemIds.sort()).toEqual(killed.itemIds.sort());
    expect(await availability()).toEqual({ items: ['churros'], options: [] });
  });

  it('changes nothing, and says so, when the batch is already off', async () => {
    await setAvailability(FRIED, [], false);
    const again = await setAvailability(FRIED, [], false);

    expect(again).toEqual({ itemIds: [], optionIds: [] });
    expect(await availability()).toEqual({ items: [...FRIED].sort(), options: [] });
  });

  it('ignores ids the menu does not have, rather than throwing mid-rush', async () => {
    const changed = await setAvailability(['taquitos', 'deleted'], ['no-such-option'], false);

    expect(changed).toEqual({ itemIds: ['taquitos'], optionIds: [] });
    expect(await availability()).toEqual({ items: ['taquitos'], options: [] });
  });
});
