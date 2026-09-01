// The database the e2e suite (and a local dev session) runs against.
//
// The specs assert real prices — "$10.95", "+$2.50 guac" — so this writes the
// same SAMPLE_MENU the unit fixtures are hand-calculated against, not a second
// menu written to agree with them. `npm test` truncates this database on its
// way through, which is why seeding is a `pretest:e2e` step rather than a
// thing you remember to run.
//
// The orders are built by PLACING them, through the same `placeOrder` the
// checkout calls, and moved with the same `applyOrderAction` the kitchen
// buttons call. A fixture assembled by hand-writing rows would agree with
// itself and prove nothing.
import {
  addLine,
  EMPTY_CART,
  instantMinutesAfter,
  type Cart,
  type Composition,
} from '@countertop/core';
import { prisma } from './index';
import { loadMenu } from './menu';
import { derivedIdempotencyKey, placeOrder } from './placement';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

// Relative instants through the shared helper (C-017 pulled it into
// packages/core once this file, the rush and two fixtures each had a copy).
const anchor = new Date();
const minutesAgo = (minutes: number): Date => instantMinutesAfter(anchor, -minutes);

type SeedOrder = {
  customerName: string;
  placedMinutesAgo: number;
  /** Each forward advance, and how long ago it happened. */
  advances: number[];
  lines: Composition[];
  orderNote?: string;
};

const SEED_ORDERS: SeedOrder[] = [
  {
    // The P0-11 card: a quantity above one, a NEGATION, and a note.
    customerName: 'Dana Reyes',
    placedMinutesAgo: 2,
    advances: [],
    lines: [
      {
        itemId: 'burrito',
        quantity: 2,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'addons', optionId: 'guacamole' },
          { groupId: 'toppings', optionId: 'onions', intensity: 'none' },
        ],
        note: 'Wrap it tight, it is going in a bike bag',
      },
    ],
  },
  {
    // Past the 15-minute flag: this ticket is running late.
    customerName: 'Morgan Ellis',
    placedMinutesAgo: 22,
    advances: [21, 20],
    lines: [
      {
        itemId: 'bowl',
        quantity: 1,
        selections: [
          { groupId: 'size', optionId: 'large' },
          { groupId: 'protein', optionId: 'steak' },
        ],
      },
    ],
  },
  {
    // Cooked and sitting on the shelf: the second aging flag, a no-show taking
    // shape.
    customerName: 'Priya Shah',
    placedMinutesAgo: 40,
    advances: [38, 35, 25],
    lines: [{ itemId: 'chips', quantity: 1, selections: [] }],
  },
  {
    // The largest card: five lines, none of them hidden.
    customerName: 'Sam Okafor',
    placedMinutesAgo: 6,
    advances: [5],
    orderNote: 'Picking up for the whole shop',
    lines: [
      {
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'carnitas' },
          { groupId: 'salsa', optionId: 'chipotle', intensity: 'extra' },
        ],
      },
      {
        itemId: 'bowl',
        quantity: 1,
        selections: [
          { groupId: 'size', optionId: 'small' },
          { groupId: 'protein', optionId: 'veggie' },
        ],
      },
      {
        itemId: 'taco-plate',
        quantity: 1,
        selections: [
          { groupId: 'fillings', optionId: 'al-pastor' },
          { groupId: 'fillings', optionId: 'mushroom' },
        ],
      },
      { itemId: 'chips', quantity: 3, selections: [] },
      {
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'toppings', optionId: 'cheese', intensity: 'extra' },
          { groupId: 'salsa', optionId: 'verde', intensity: 'light' },
        ],
      },
    ],
  },
];

async function seedOrders(): Promise<void> {
  const menu = await loadMenu();

  for (const [index, seed] of SEED_ORDERS.entries()) {
    let cart: Cart = EMPTY_CART;
    for (const [lineIndex, composition] of seed.lines.entries()) {
      const added = addLine(menu, cart, `seed-${index}-${lineIndex}`, composition);
      if (!added.ok) {
        throw new Error(
          `Seed order ${index} line ${lineIndex} is not orderable: ${added.errors.map((e) => e.message).join(' ')}`,
        );
      }
      cart = added.cart;
    }

    const placed = await placeOrder({
      cart,
      idempotencyKey: derivedIdempotencyKey(`seed-order-${index}`),
      now: minutesAgo(seed.placedMinutesAgo),
      customerName: seed.customerName,
      orderNote: seed.orderNote ?? null,
    });
    if (!placed.ok) {
      throw new Error(`Seed order ${index} was refused: ${placed.errors.map((e) => e.message).join(' ')}`);
    }

    for (const at of seed.advances) {
      const moved = await applyOrderAction(
        placed.order.id,
        { kind: 'advance', actor: 'staff' },
        minutesAgo(at),
      );
      if (!moved.ok) {
        throw new Error(`Seed order ${index} could not advance: ${moved.failure.message}`);
      }
    }
  }
}

async function main(): Promise<void> {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
  await seedOrders();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
