import { beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_MENU } from '@countertop/core';
import { loadMenu, loadSettings } from './menu';
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
