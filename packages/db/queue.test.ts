import type { Cart } from '@countertop/core';
import { beforeEach, expect, it } from 'vitest';
import { placeOrder } from './placement';
import { queueCursor } from './queue';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';
import { applyOrderAction } from './transitions';

// The cursor is the one thing the whole polling feature rests on: if it fails
// to move, the kitchen screen quietly stops updating and nothing else notices.
// Fixed instants throughout — nothing here reads a clock.
const LUNCH = new Date(Date.UTC(2026, 6, 5, 19, 0, 0));

const CART: Cart = {
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1495,
      composition: {
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'carnitas' },
          { groupId: 'addons', optionId: 'guacamole' },
        ],
      },
    },
  ],
};

let keyCounter = 0;
async function place(now: Date = LUNCH): Promise<string> {
  const result = await placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `key-${(keyCounter += 1)}`,
    now,
  });
  if (!result.ok) throw new Error(`placement failed: ${JSON.stringify(result.errors)}`);
  return result.order.id;
}

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

it('is stable while nothing happens', async () => {
  await place();
  expect(await queueCursor()).toBe(await queueCursor());
});

it('moves when an order is placed', async () => {
  const before = await queueCursor();
  await place();
  expect(await queueCursor()).not.toBe(before);
});

it('moves when an order is advanced', async () => {
  const orderId = await place();
  const before = await queueCursor();

  const moved = await applyOrderAction(orderId, { kind: 'advance', actor: 'staff' }, LUNCH);
  expect(moved.ok).toBe(true);
  expect(await queueCursor()).not.toBe(before);
});

// The reason the cursor carries a COUNT and not just the newest instant. Two
// cooks tapping two cards in the same millisecond is a rush, not a fiction,
// and the second tap must not be invisible.
it('moves for a second event written at the very same instant', async () => {
  const first = await place();
  const second = await place();

  await applyOrderAction(first, { kind: 'advance', actor: 'staff' }, LUNCH);
  const afterOne = await queueCursor();

  await applyOrderAction(second, { kind: 'advance', actor: 'staff' }, LUNCH);
  expect(await queueCursor()).not.toBe(afterOne);
});
