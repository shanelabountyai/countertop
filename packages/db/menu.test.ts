import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_CART,
  SAMPLE_MENU,
  addLine,
  confirmPrices,
  restaurantClock,
  reviewCart,
} from '@countertop/core';
import {
  effectivePrices,
  loadMenu,
  loadSettings,
  loadStagedPrices,
  setAvailability,
  writePrice,
} from './menu';
import { prisma } from './index';
import { resetDatabase, seedSampleMenu, seedSettings } from './testing/index';

// The mapping test that keeps the database and the engine speaking the same
// language: seed the core menu, read it back, expect the same object. A column
// added to the schema and not mapped shows up here, not in a wrong receipt.
describe('loadMenu', () => {
  beforeAll(async () => {
    await resetDatabase();
    await seedSampleMenu();
    // C-111: `loadMenu` reads the restaurant's timezone now, because "what
    // does this cost right now" became a calendar question when a price could
    // be staged for a day. The test below deletes this row on purpose to prove
    // the loader still refuses to invent one.
    await seedSettings();
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
    await prisma.restaurantSettings.deleteMany();
    await expect(loadSettings()).rejects.toThrow();
    // And so does the menu, now that a price can depend on the calendar. A
    // silent fallback to UTC here would apply Monday's price on Sunday
    // afternoon for a restaurant in Los Angeles — which is exactly the
    // "manager typing during lunch" this requirement removes, arriving by a
    // different route.
    await expect(loadMenu()).rejects.toThrow();

    await seedSettings();
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

// C-111 (P1-2): a price you can stage.
//
// The whole feature is one resolution rule inside `loadMenu`, and that is the
// point — `priceLine` is the price authority and it has no notion of a
// schedule, so the menu view, cart validation and placement all get the
// effective price without asking for it. These tests are written against
// `loadMenu` and the cart because those are the two things anybody downstream
// actually reads.
describe('staged prices', () => {
  // The restaurant is on America/Los_Angeles. Every instant below is written
  // in UTC and named for the LOCAL day it lands on, because the local day is
  // the thing being tested.
  const SUNDAY_NOON = new Date(Date.UTC(2026, 8, 13, 19, 0)); // 2026-09-13 12:00 LA
  const SUNDAY_2355 = new Date(Date.UTC(2026, 8, 14, 6, 55)); // 2026-09-13 23:55 LA
  const MONDAY_0005 = new Date(Date.UTC(2026, 8, 14, 7, 5)); //  2026-09-14 00:05 LA
  const MONDAY_NOON = new Date(Date.UTC(2026, 8, 14, 19, 0)); // 2026-09-14 12:00 LA

  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings();
  });

  const stage = (day: string, priceCents: number, itemId = 'burrito') =>
    prisma.stagedPrice.create({ data: { itemId, effectiveDay: day, priceCents } });

  it('does not touch the menu before its day', async () => {
    await stage('2026-09-14', 1250);
    expect((await loadMenu(SUNDAY_NOON)).items.burrito?.basePriceCents).toBe(1095);
  });

  it('is the price from its day on', async () => {
    await stage('2026-09-14', 1250);
    expect((await loadMenu(MONDAY_NOON)).items.burrito?.basePriceCents).toBe(1250);
  });

  it('turns over on the RESTAURANT’s midnight, not on UTC’s', async () => {
    // Both of these instants are 2026-09-14 in UTC. Only one of them is
    // Monday in Los Angeles, and the price is a fact about the restaurant's
    // calendar — the same reason `Order.businessDay` is a string.
    await stage('2026-09-14', 1250);
    expect((await loadMenu(SUNDAY_2355)).items.burrito?.basePriceCents).toBe(1095);
    expect((await loadMenu(MONDAY_0005)).items.burrito?.basePriceCents).toBe(1250);
  });

  it('applies the LATEST change that has arrived, not the first', async () => {
    // Ordered ascending and folded into a map, so "latest wins" is the fold
    // rather than a comparison somebody could get backwards.
    await stage('2026-09-14', 1250);
    await stage('2026-09-13', 1150);
    expect((await loadMenu(SUNDAY_NOON)).items.burrito?.basePriceCents).toBe(1150);
    expect((await loadMenu(MONDAY_NOON)).items.burrito?.basePriceCents).toBe(1250);
  });

  it('stages an option delta as well as an item price', async () => {
    await prisma.stagedPrice.create({
      data: { optionId: 'guacamole', effectiveDay: '2026-09-14', priceCents: 250 },
    });
    const sunday = await loadMenu(SUNDAY_NOON);
    const monday = await loadMenu(MONDAY_NOON);
    const guac = (menu: Awaited<ReturnType<typeof loadMenu>>) =>
      menu.groups.addons?.options.find((o) => o.id === 'guacamole')?.priceDeltaCents;
    expect(guac(sunday)).toBe(SAMPLE_MENU.groups.addons?.options.find((o) => o.id === 'guacamole')?.priceDeltaCents);
    expect(guac(monday)).toBe(250);
  });

  it('leaves everything it did not stage exactly as it was', async () => {
    // The round-trip test at the top of this file is the real guard; this is
    // the narrower claim that a staged row is a targeted override and not a
    // second mapping of the whole menu.
    await stage('2026-09-14', 1250);
    const monday = await loadMenu(MONDAY_NOON);
    expect(monday.items.bowl).toEqual(SAMPLE_MENU.items.bowl);
    expect({ ...monday.items.burrito, basePriceCents: 1095 }).toEqual(SAMPLE_MENU.items.burrito);
  });

  it('reports only the changes still to come', async () => {
    // What the editor shows and lets a manager cancel. A row for today has
    // already taken effect — it is not "coming", it is the price.
    await stage('2026-09-14', 1250);
    await stage('2026-09-28', 1300);
    expect((await loadStagedPrices(MONDAY_NOON)).map((r) => r.effectiveDay)).toEqual([
      '2026-09-28',
    ]);
    expect((await loadStagedPrices(SUNDAY_NOON)).map((r) => r.effectiveDay)).toEqual([
      '2026-09-14',
      '2026-09-28',
    ]);
  });

  it('hands back the restaurant’s day beside the prices', async () => {
    // One clock reading for both, because the two callers that want the
    // prices also want the day — to reject a change staged for yesterday, and
    // to delete the rows a live edit has just made spent. Two readings is how
    // those two disagree.
    const { today } = await effectivePrices(SUNDAY_2355);
    expect(today).toBe('2026-09-13');
    expect(today).toBe(restaurantClock(SUNDAY_2355, 'America/Los_Angeles').day);
  });

  // THE PRECEDENCE. C-110 settled a schedule versus a human fact one level up
  // (a daypart and an 86 are separate columns and the 86 wins); this is the
  // same shape one level down, and it needs the same explicit answer rather
  // than whichever branch the code happens to reach first.
  describe('a typed price against a staged one', () => {
    it('wins over a change that has already landed', async () => {
      // Without this, the manager types $13.50, sees "saved", and the menu
      // goes on selling at $12.50 with nothing anywhere saying why.
      await stage('2026-09-14', 1250);
      expect((await loadMenu(MONDAY_NOON)).items.burrito?.basePriceCents).toBe(1250);

      await writePrice({ itemId: 'burrito' }, 1350, null, '2026-09-14');
      expect((await loadMenu(MONDAY_NOON)).items.burrito?.basePriceCents).toBe(1350);
      expect(await prisma.stagedPrice.count()).toBe(0);
    });

    it('does not cancel a change that is still to come', async () => {
      // Fixing today's price is not a reason to call off next month's
      // increase. The delete is bounded by the day, not by the row.
      await stage('2026-09-14', 1250);
      await stage('2026-09-28', 1400);

      await writePrice({ itemId: 'burrito' }, 1350, null, '2026-09-14');
      expect((await loadMenu(MONDAY_NOON)).items.burrito?.basePriceCents).toBe(1350);
      expect((await loadStagedPrices(MONDAY_NOON)).map((r) => r.effectiveDay)).toEqual([
        '2026-09-28',
      ]);
    });

    it('leaves another row’s queue alone', async () => {
      await stage('2026-09-14', 1250);
      await stage('2026-09-14', 1350, 'bowl');
      await writePrice({ itemId: 'burrito' }, 1400, null, '2026-09-14');
      expect((await loadMenu(MONDAY_NOON)).items.bowl?.basePriceCents).toBe(1350);
    });

    it('replaces a change queued for the same day rather than duplicating it', async () => {
      // Re-staging the same day is a manager correcting yesterday's number,
      // not an error — and the unique index would refuse a plain insert.
      await writePrice({ itemId: 'burrito' }, 1250, '2026-09-14', '2026-09-13');
      await writePrice({ itemId: 'burrito' }, 1275, '2026-09-14', '2026-09-13');
      expect(await prisma.stagedPrice.count()).toBe(1);
      expect((await loadMenu(MONDAY_NOON)).items.burrito?.basePriceCents).toBe(1275);
    });

    it('stages an option delta through the same one function', async () => {
      await writePrice({ optionId: 'guacamole' }, 250, '2026-09-14', '2026-09-13');
      expect(
        (await loadMenu(SUNDAY_NOON)).groups.addons?.options.find((o) => o.id === 'guacamole')
          ?.priceDeltaCents,
      ).toBe(SAMPLE_MENU.groups.addons?.options.find((o) => o.id === 'guacamole')?.priceDeltaCents);
      expect(
        (await loadMenu(MONDAY_NOON)).groups.addons?.options.find((o) => o.id === 'guacamole')
          ?.priceDeltaCents,
      ).toBe(250);

      await writePrice({ optionId: 'guacamole' }, 300, null, '2026-09-14');
      expect(await prisma.stagedPrice.count()).toBe(0);
      expect(
        (await loadMenu(MONDAY_NOON)).groups.addons?.options.find((o) => o.id === 'guacamole')
          ?.priceDeltaCents,
      ).toBe(300);
    });
  });

  // THE ACCEPTANCE CRITERION (PRD P1-2): "a cart that straddles the boundary
  // hits the existing old → new confirm rather than repricing silently".
  //
  // Nothing in the cart knows what a staged price is, and that is the whole
  // design. `reviewCart` compares the baseline the line was added at against
  // what `priceLine` says now; a staged change moves the second number, so it
  // routes into the confirm C-015/C-026 already built rather than around it.
  it('routes a cart that straddles midnight into the existing old → new confirm', async () => {
    // Chips: no modifier groups, so the line under test is a price change and
    // nothing else. The burrito's required protein group would be a second
    // reason for the cart to stop, and this test is about the first one.
    await stage('2026-09-14', 450, 'chips');
    const composition = { itemId: 'chips', quantity: 1, selections: [] };

    const sunday = await loadMenu(SUNDAY_NOON);
    const sundayClock = restaurantClock(SUNDAY_NOON, 'America/Los_Angeles');
    const added = addLine(sunday, EMPTY_CART, 'line-1', composition, sundayClock);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.cart.lines[0]?.unitPriceAtAddCents).toBe(350);

    // Still Sunday: nothing to confirm, and the cart is placeable.
    const beforeMidnight = reviewCart(sunday, added.cart, 82_500, sundayClock);
    expect(beforeMidnight.needsPriceConfirmation).toBe(false);
    expect(beforeMidnight.placeable).toBe(true);

    // Monday: the price moved under the cart, and the customer is asked.
    const monday = await loadMenu(MONDAY_NOON);
    const mondayClock = restaurantClock(MONDAY_NOON, 'America/Los_Angeles');
    const afterMidnight = reviewCart(monday, added.cart, 82_500, mondayClock);
    expect(afterMidnight.needsPriceConfirmation).toBe(true);
    expect(afterMidnight.placeable).toBe(false);
    expect(afterMidnight.lines[0]?.priceChange).toEqual({
      fromUnitPriceCents: 350,
      toUnitPriceCents: 450,
    });

    // And confirming re-baselines to the staged price, not to some third one.
    const confirmed = confirmPrices(monday, added.cart, mondayClock);
    expect(confirmed.lines[0]?.unitPriceAtAddCents).toBe(450);
    expect(reviewCart(monday, confirmed, 82_500, mondayClock).placeable).toBe(true);
  });
});
