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
import { adjustOrder } from './adjustment';
import { enrolMember, redeemReward } from './loyalty';
import { appendOrderNote } from './history';
import { findOrderByStatusToken, placeOrder } from './placement';
import { setShelfLocation } from './queue';
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
    // Ten digits since C-104: the punch-card case below has to be able to
    // enrol this order's customer, and `normalizePhone` refuses a seven-digit
    // number rather than inventing an area code for it.
    customerPhone: '555-010-0100',
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
    // Rename, reprice, re-WEIGH and 86 the item. The weight matters here for
    // the same reason the price does (P1-7): the order's `prepWeight` is a
    // copy, so re-weighting a burrito must not change how heavy an order
    // already in the queue is — the whole receipt is compared below.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'RENAMED ITEM', basePriceCents: 9999, prepWeight: 50, available: false },
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

  it('is byte-identical after the order is comped, refunded, AND the menu moves', async () => {
    // PRD 3's invariant note, made a test (C-065). An adjustment is the first
    // thing in this product that writes money-shaped data about an order AFTER
    // it is placed, so it is the first real chance to violate the snapshot rule
    // from a direction the menu cannot reach. The obvious implementation —
    // "comp it, subtract from the total" — passes every other test in this
    // file and fails this one.
    const id = await placeSnapshotOrder();
    const before = JSON.stringify(await readReceipt(id));

    await adjustOrder(id, { kind: 'partial', amountCents: 300, reason: 'late' }, AT);
    await adjustOrder(id, { kind: 'comp', reason: 'quality' }, AT);
    // A refund beside them, so the case is the PRD's: money out AND money
    // written off on the same order.
    await prisma.orderEvent.create({
      data: { orderId: id, at: AT, kind: 'refund', actor: 'system', amountCents: 500 },
    });
    // And the menu moves underneath all of it.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'RENAMED ITEM', basePriceCents: 9999, available: false },
    });
    await prisma.modifierOption.delete({ where: { id: 'cheese' } });

    expect(JSON.stringify(await readReceipt(id))).toBe(before);
  });

  it('is byte-identical after a punch-card reward is redeemed against it', async () => {
    // PRD 7 P0-4 and P0-6, made a test (C-104). Loyalty is the second thing in
    // this product that writes money-shaped data about an order after it is
    // placed, and it is the one with a live customer record behind it — so it
    // is the direction from which "just take it off the total" is most
    // tempting. `Order` gains no column and no foreign key to any loyalty
    // table; the link runs one way, from `LoyaltyEvent.orderId`.
    await seedSettings({ loyaltyEnabled: true });
    const enrolled = await enrolMember({ phone: '555-010-0100', displayName: 'Dana', now: AT });
    if (!enrolled.ok) throw new Error(enrolled.reason);
    await prisma.loyaltyEvent.create({
      data: { memberId: enrolled.memberId, at: AT, kind: 'adjust', points: 100 },
    });

    const id = await placeSnapshotOrder();
    const before = JSON.stringify(await readReceipt(id));

    const redeemed = await redeemReward(id, AT);
    expect(redeemed).toMatchObject({ ok: true, amountCents: 1000 });
    // And the menu moves underneath it, as everywhere else in this file.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'RENAMED ITEM', basePriceCents: 9999 },
    });

    expect(JSON.stringify(await readReceipt(id))).toBe(before);
  });

  it('is byte-identical while the bag is moved around the shelf', async () => {
    // PRD 2 P0-5's own acceptance criterion. `shelfLocation` is the one
    // MUTABLE column on this table, which is a genuine tension with everything
    // above — and what resolves it is that no reader of a placed order can see
    // it. So the comparison is made through the CUSTOMER'S OWN read, the real
    // loader behind `/status/[token]`, rather than through this file's
    // `RECEIPT_SHAPE`: that one selects every scalar and would go green the
    // day `ORDER_RECEIPT` stopped omitting the column, which is the exact
    // regression this is here to catch.
    const id = await placeSnapshotOrder();
    const { statusToken, totalCents, subtotalCents, taxCents } =
      await prisma.order.findUniqueOrThrow({ where: { id } });
    const before = JSON.stringify(await findOrderByStatusToken(statusToken));

    // Set it, move it, and take it off the shelf again.
    await setShelfLocation(id, 'shelf 3');
    await setShelfLocation(id, 'warmer left');
    await setShelfLocation(id, '');

    expect(JSON.stringify(await findOrderByStatusToken(statusToken))).toBe(before);
    // And nothing the customer can read ever carried the string, at any point.
    await setShelfLocation(id, 'shelf 3');
    expect(JSON.stringify(await findOrderByStatusToken(statusToken))).not.toContain('shelf 3');

    // The money is untouched, which is the other half of the criterion.
    const after = await prisma.order.findUniqueOrThrow({ where: { id } });
    expect([after.subtotalCents, after.taxCents, after.totalCents]).toEqual([
      subtotalCents,
      taxCents,
      totalCents,
    ]);
  });

  it('is byte-identical after three notes are written on the ticket', async () => {
    // PRD 2 P0-6's own acceptance criterion. A note is a fact about the SHIFT,
    // not about what was sold, and it is written on an order that has already
    // been placed — which is the same tension the shelf above resolves.
    //
    // TWO ASSERTIONS, BECAUSE A NOTE IS AN EVENT AND THE SHELF IS A COLUMN.
    // The receipt is byte-identical, as it is for a comp and a refund — the
    // append-only log grows, which it must, and nothing it says moves a
    // snapshot column. What the requirement adds on top is that the note's
    // TEXT never reaches the customer, and that holds structurally rather than
    // by anyone remembering: `ORDER_RECEIPT` selects `{ kind, amountCents }`
    // off the event log, so the shape behind `/status/[token]` has no `detail`
    // to render. Widen that select and the second assertion fails.
    const id = await placeSnapshotOrder();
    const { statusToken } = await prisma.order.findUniqueOrThrow({ where: { id } });
    const before = JSON.stringify(await readReceipt(id));

    await appendOrderNote(id, 'no answer', AT, null);
    await appendOrderNote(id, 'called, arriving 7:40', AT, null);
    await appendOrderNote(id, 'allergy — kitchen told', AT, null);

    expect(JSON.stringify(await readReceipt(id))).toBe(before);
    // And the menu moves underneath it, as everywhere else in this file.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'RENAMED ITEM', basePriceCents: 9999 },
    });
    expect(JSON.stringify(await readReceipt(id))).toBe(before);

    const customerSees = JSON.stringify(await findOrderByStatusToken(statusToken));
    expect(customerSees).not.toContain('arriving 7:40');
    expect(customerSees).not.toContain('allergy');

    // Three rows really are there — so the assertions above pass for the right
    // reason rather than because nothing was ever written.
    expect(await prisma.orderEvent.count({ where: { orderId: id, kind: 'note' } })).toBe(3);
  });

  it('trims a shelf label, caps it at the column width, and clears on empty', async () => {
    const id = await placeSnapshotOrder();
    const read = async () =>
      (await prisma.order.findUniqueOrThrow({ where: { id } })).shelfLocation;

    await setShelfLocation(id, '  shelf 3  ');
    expect(await read()).toBe('shelf 3');

    // Truncated rather than refused — the pause message's rule, not the money
    // rules'. Seventeen characters in, sixteen stored, no error at a cook.
    await setShelfLocation(id, 'the second warmer on the left');
    expect(await read()).toBe('the second warme');

    await setShelfLocation(id, '   ');
    expect(await read()).toBeNull();
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
