import {
  CANCEL_REASONS,
  EVENT_ACTORS,
  INTENSITIES,
  ORDER_EVENT_KINDS,
  ORDER_STATUSES,
  PAYMENT_STATES,
} from '@countertop/core';
import type { Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder } from './placement';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

// THE regression test this project exists to keep passing (CLAUDE.md, the
// snapshot rule). A placed order is an immutable COPY. Menu edits made after
// placement must be PROVABLY invisible to it — not "we're careful", provably.
//
// It places through the REAL placement path (C-006). A hand-built row would
// prove only that the fixture copies its names; this proves the code that
// takes customers' money does.

const AT = new Date(Date.UTC(2026, 6, 4, 18, 30, 0)); // a frozen instant; nothing here reads a clock

/** A burrito with everything the snapshot has to carry: a priced add-on, a
 *  priced `extra` intensity, and a NEGATION. */
const CART: Cart = {
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1620,
      composition: {
        itemId: 'burrito',
        quantity: 2,
        selections: [
          { groupId: 'protein', optionId: 'carnitas' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'toppings', optionId: 'cheese', intensity: 'extra' },
          { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
        ],
        note: 'no rush',
      },
    },
  ],
};

let keyCounter = 0;
async function placeSnapshotOrder(): Promise<string> {
  const result = await placeOrder({
    cart: CART,
    customerName: 'Dana',
    customerPhone: '555-0100',
    orderNote: 'blue Honda out front',
    idempotencyKey: `snapshot-${(keyCounter += 1)}`,
    now: AT,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order.id;
}

/** Everything a receipt or a kitchen ticket renders — and NOTHING from a menu table. */
const RECEIPT_SHAPE = {
  include: {
    lines: {
      orderBy: { lineNumber: 'asc' },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    },
  },
} as const;

const readReceipt = (id: string) =>
  prisma.order.findUniqueOrThrow({ where: { id }, ...RECEIPT_SHAPE });

describe('the snapshot rule', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings();
    await seedStoreHours();
  });

  it('renders a receipt with zero joins to any menu table', async () => {
    const id = await placeSnapshotOrder();
    const receipt = await readReceipt(id);

    // 1095 + 150 (carnitas) + 250 (guac) + 125 (cheese at extra: 50 + 75)
    // + 0 (onions, a negation) = 1620; x2 = 3240. Tax 3240 x 8.25% = 267.3 -> 267.
    expect(receipt.subtotalCents).toBe(3240);
    expect(receipt.taxCents).toBe(267);
    expect(receipt.totalCents).toBe(3507);

    const line = receipt.lines[0];
    expect(line).toMatchObject({
      itemName: 'Burrito',
      categoryName: 'Burritos & Bowls',
      basePriceCents: 1095,
      quantity: 2,
      unitPriceCents: 1620,
      lineTotalCents: 3240,
    });
    expect(line?.options.map((o) => [o.groupName, o.optionName, o.intensity, o.appliedDeltaCents])).toEqual([
      ['Protein', 'Carnitas', null, 150],
      ['Add-ons', 'Guacamole', null, 250],
      ['Toppings', 'Cheese', 'extra', 125],
      ['Toppings', 'Onions', 'none', 0],
    ]);

    // The options account for the whole difference from the base price. If a
    // future change prices something outside the option list, this catches it.
    const deltas = line?.options.reduce((sum, o) => sum + o.appliedDeltaCents, 0) ?? 0;
    expect((line?.basePriceCents ?? 0) + deltas).toBe(line?.unitPriceCents);
  });

  it('is byte-identical after every referenced menu row is mutated or deleted', async () => {
    const id = await placeSnapshotOrder();
    const before = JSON.stringify(await readReceipt(id));

    // Rename the category the line copied its categoryName from.
    await prisma.category.update({ where: { id: 'burritos' }, data: { name: 'RENAMED CATEGORY' } });
    // Rename, reprice and 86 the item.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'RENAMED ITEM', basePriceCents: 9999, available: false },
    });
    // Rename a group the options copied their groupName from, and change its rules.
    await prisma.modifierGroup.update({
      where: { id: 'toppings' },
      data: { name: 'RENAMED GROUP', min: 3, max: 3, intensityEnabled: false },
    });
    // Rename, reprice and 86 an ordered option.
    await prisma.modifierOption.update({
      where: { id: 'guacamole' },
      data: { name: 'RENAMED OPTION', priceDeltaCents: -5000, extraPriceDeltaCents: 1, available: false },
    });
    // DELETE an ordered option outright. This is the mutation an
    // `onDelete: Restrict` foreign key would have forbidden forever — the
    // snapshot survives it because it never referred to the row, only copied it.
    await prisma.modifierOption.delete({ where: { id: 'cheese' } });
    // Detach a group from the item entirely.
    await prisma.itemModifierGroup.delete({
      where: { itemId_groupId: { itemId: 'burrito', groupId: 'addons' } },
    });

    expect(JSON.stringify(await readReceipt(id))).toBe(before);
  });

  it('leaves the analytics ids dangling rather than mutating the order', async () => {
    const id = await placeSnapshotOrder();
    await prisma.modifierOption.delete({ where: { id: 'cheese' } });

    const receipt = await readReceipt(id);
    const cheese = receipt.lines[0]?.options.find((o) => o.optionName === 'Cheese');
    // Still says 'cheese', and that row no longer exists. Correct: the column
    // is for analytics correlation and is never resolved for display.
    expect(cheese?.modifierOptionId).toBe('cheese');
    expect(await prisma.modifierOption.findUnique({ where: { id: 'cheese' } })).toBeNull();
  });
});

describe('the persisted vocabulary matches the engine', () => {
  // The database enum and the engine's list are two spellings of one
  // vocabulary. Nothing but a test stops them drifting — and a drifted
  // OrderStatus is a queue filter that silently omits a state.
  const ENUMS: [string, readonly string[]][] = [
    ['Intensity', INTENSITIES],
    ['OrderStatus', ORDER_STATUSES],
    ['CancelReason', CANCEL_REASONS],
    ['EventActor', EVENT_ACTORS],
    ['OrderEventKind', ORDER_EVENT_KINDS],
    ['PaymentState', PAYMENT_STATES],
  ];

  for (const [typeName, engineValues] of ENUMS) {
    it(`stores exactly the ${typeName} values packages/core defines`, async () => {
      const rows = await prisma.$queryRaw<{ value: string }[]>`
        SELECT e.enumlabel AS value
        FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = ${typeName}
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.value)).toEqual([...engineValues]);
    });
  }
});
