// Payment state through the real write paths (P1-8).
//
// The column and the `refund` event kind have been in the schema since C-003;
// until this item nothing wrote either, so `paid` and `refunded` were states
// the database could hold and the app could never reach. These are the three
// writes that make them reachable.
import type { Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder, type PlacementInput } from './placement';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

/** The same hand-calculated composition `placement.test.ts` uses: 1620 a unit,
 *  quantity 2, 8.25% tax — 3507 in total, which is the amount a refund is
 *  asserted against below. */
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
      },
    },
  ],
};

let keyCounter = 0;
async function place(overrides: Partial<PlacementInput> = {}) {
  const result = await placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `pay-${(keyCounter += 1)}`,
    now: DINNER,
    ...overrides,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

const paymentStateOf = async (id: string) =>
  (await prisma.order.findUniqueOrThrow({ where: { id }, select: { paymentState: true } }))
    .paymentState;

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('payment state (P1-8)', () => {
  it('defaults to unpaid, and pay-at-pickup is the absence of a charge', async () => {
    expect((await place()).paymentState).toBe('unpaid');
    expect((await place({ paidNow: false })).paymentState).toBe('unpaid');
  });

  it('records the mock charge taken at checkout', async () => {
    expect((await place({ paidNow: true })).paymentState).toBe('paid');
  });

  it('refunds the column and logs the amount when a paid order is cancelled', async () => {
    const order = await place({ paidNow: true });
    const result = await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      DINNER,
    );

    expect(result.ok).toBe(true);
    expect(await paymentStateOf(order.id)).toBe('refunded');

    // The refund is a logged event, not just a column that moved: money going
    // back is something that happened at a time, for an amount.
    const refund = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'refund' },
    });
    expect(refund.detail).toMatchObject({ amountCents: order.totalCents, provider: 'mock' });
  });

  it('leaves an unpaid cancellation with nothing to refund', async () => {
    const order = await place();
    await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'too_busy' },
      DINNER,
    );

    expect(await paymentStateOf(order.id)).toBe('unpaid');
    expect(await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'refund' } })).toBe(0);
  });
});
