// Adjustments through the real write path (PRD 3 P0-3, C-065).
//
// The core suite proves the arithmetic and the refusals against hand-made
// events. This one proves the parts only a database can be wrong about: that
// the snapshot columns are untouched, that the CHECK actually rejects a
// malformed row, that the append-only trigger still covers the new kind, and
// that the amount is bounded by the order's own total rather than by anything
// a caller passed.
import { orderBalance, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { adjustOrder } from './adjustment';
import { collectOrderPayment } from './payment';
import { placeOrder, type PlacementInput } from './placement';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

/** The same composition the payment suite uses: 1620 a unit, quantity 2,
 *  8.25% tax — $35.07 in total. Hand-calculated, per CLAUDE.md. */
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
    idempotencyKey: `adj-${(keyCounter += 1)}`,
    now: DINNER,
    ...overrides,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

const moneyOf = async (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      subtotalCents: true,
      taxCents: true,
      totalCents: true,
      paymentState: true,
      events: { select: { kind: true, amountCents: true } },
    },
  });

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('adjusting an order (P0-3)', () => {
  it('writes one event and leaves every snapshot column exactly as it was', async () => {
    const order = await place();
    const before = await moneyOf(order.id);

    const result = await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER);
    expect(result).toEqual({ ok: true, amountCents: order.totalCents });

    const after = await moneyOf(order.id);
    // The requirement's own words: it NEVER updates these three.
    expect(after.subtotalCents).toBe(before.subtotalCents);
    expect(after.taxCents).toBe(before.taxCents);
    expect(after.totalCents).toBe(before.totalCents);
    // Nor the payment cache — an adjustment is not money arriving.
    expect(after.paymentState).toBe(before.paymentState);

    const rows = await prisma.orderEvent.findMany({ where: { orderId: order.id, kind: 'adjustment' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(order.totalCents);
    expect(rows[0]!.reason).toBe('quality');
  });

  it('is reachable in the states the product had no money control for at all', async () => {
    // `picked_up` and `abandoned` are the whole point of the requirement: the
    // queue has already dropped the order and cancellation is refused.
    for (const target of ['picked_up', 'abandoned'] as const) {
      const order = await place();
      if (target === 'picked_up') {
        // placed → accepted → preparing → ready → picked_up
        for (let step = 0; step < 4; step += 1) {
          await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER);
        }
      } else {
        await applyOrderAction(order.id, { kind: 'abandon', actor: 'staff' }, DINNER);
      }
      const result = await adjustOrder(order.id, { kind: 'partial', amountCents: 500, reason: 'late' }, DINNER);
      expect(result.ok).toBe(true);
    }
  });

  it('drops the order off the outstanding side once it is comped', async () => {
    const order = await place();
    expect(orderBalance(await moneyOf(order.id)).outstandingCents).toBe(order.totalCents);

    await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER);
    expect(orderBalance(await moneyOf(order.id))).toEqual({
      collectedCents: 0,
      outstandingCents: 0,
    });
  });

  it('makes the counter collect the REMAINDER after a partial, not the ticket', async () => {
    const order = await place();
    await adjustOrder(order.id, { kind: 'partial', amountCents: 700, reason: 'late' }, DINNER);
    await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER);

    expect(await collectOrderPayment(order.id, DINNER)).toEqual({ ok: true });
    const payment = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'payment' },
    });
    expect(payment.amountCents).toBe(order.totalCents - 700);
  });

  it('bounds the amount by the order re-read here, not by anything the caller passed', async () => {
    const order = await place();
    const result = await adjustOrder(
      order.id,
      { kind: 'partial', amountCents: order.totalCents + 1, reason: 'late' },
      DINNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adjustment_exceeds_total');
    expect(await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'adjustment' } })).toBe(0);
  });

  it('refuses a second comp rather than giving away more than was charged', async () => {
    const order = await place();
    await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER);
    const second = await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('nothing_left_to_adjust');
  });

  it('says so rather than throwing when the order is gone', async () => {
    const result = await adjustOrder(
      '00000000-0000-4000-8000-000000000000',
      { kind: 'comp', reason: 'late' },
      DINNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('order_not_found');
  });
});

describe('what the database itself refuses (C-063 constraints, widened)', () => {
  it('rejects an adjustment row with no amount', async () => {
    const order = await place();
    await expect(
      prisma.orderEvent.create({
        data: { orderId: order.id, at: DINNER, kind: 'adjustment', actor: 'staff', amountCents: null },
      }),
    ).rejects.toThrow(/order_event_amount_matches_kind/);
  });

  it('rejects a negative adjustment — direction is the kind, never the sign', async () => {
    const order = await place();
    await expect(
      prisma.orderEvent.create({
        data: { orderId: order.id, at: DINNER, kind: 'adjustment', actor: 'staff', amountCents: -500 },
      }),
    ).rejects.toThrow(/order_event_amount_not_negative/);
  });

  it('keeps the append-only trigger over the new kind — a mistake is contradicted, never edited', async () => {
    const order = await place();
    await adjustOrder(order.id, { kind: 'partial', amountCents: 500, reason: 'late' }, DINNER);
    const row = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'adjustment' },
    });
    await expect(
      prisma.orderEvent.update({ where: { id: row.id }, data: { amountCents: 100 } }),
    ).rejects.toThrow(/append-only/);
  });
});
