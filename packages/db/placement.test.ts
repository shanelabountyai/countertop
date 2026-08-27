import type { Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder, type PlacementInput, type PlacementResult } from './placement';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

// 8pm on the 4th of July in Los Angeles. Deliberately an instant that is
// ALREADY the 5th in UTC: the business day these orders are numbered on is the
// restaurant's, and a placement that reached for UTC would number them into
// tomorrow, mid-dinner.
const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

/** Burrito, quantity 2, with a priced add-on, a priced `extra` and a NEGATION.
 *  1095 + 150 + 250 + 125 + 0 = 1620; x2 = 3240. Tax 8.25% -> 267. Total 3507. */
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
const place = (overrides: Partial<PlacementInput> = {}): Promise<PlacementResult> =>
  placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `key-${(keyCounter += 1)}`,
    now: DINNER,
    ...overrides,
  });

/** Narrows, and fails with the actual errors rather than "undefined" when a
 *  placement that should have succeeded did not. */
function placed(result: PlacementResult) {
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('placing an order (P0-3, P0-8, P0-9)', () => {
  it('snapshots the cart, priced by the server, with its `placed` event', async () => {
    const order = placed(await place({ customerPhone: '555-0100', orderNote: 'blue Honda' }));

    expect(order).toMatchObject({
      businessDay: '2026-07-04',
      seq: 1,
      customerName: 'Dana',
      customerPhone: '555-0100',
      orderNote: 'blue Honda',
      status: 'placed',
      subtotalCents: 3240,
      taxCents: 267,
      taxRatePpm: 82_500,
      totalCents: 3507,
      paymentState: 'unpaid',
    });
    expect(order.placedAt).toEqual(DINNER);
    expect(order.statusChangedAt).toEqual(DINNER);

    const line = order.lines[0];
    expect(line).toMatchObject({
      lineNumber: 1,
      itemName: 'Burrito',
      categoryName: 'Burritos & Bowls',
      unitPriceCents: 1620,
      lineTotalCents: 3240,
      note: 'no rush',
    });
    expect(line?.options.map((o) => [o.optionName, o.intensity, o.appliedDeltaCents])).toEqual([
      ['Carnitas', null, 150],
      ['Guacamole', null, 250],
      ['Cheese', 'extra', 125],
      ['Onions', 'none', 0],
    ]);

    // The status moved and the log says so, in the same write. A snapshot with
    // no `placed` event is a hole in the history the reports read.
    const events = await prisma.orderEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'transition',
      fromStatus: null,
      toStatus: 'placed',
      actor: 'customer',
    });
  });

  it('gives the status link ≥128 bits of randomness, and never repeats one', async () => {
    const first = placed(await place());
    const second = placed(await place());

    // base64url of 24 random bytes: 32 characters, 192 bits.
    expect(first.statusToken).toMatch(/^[\w-]{32}$/);
    expect(second.statusToken).not.toBe(first.statusToken);
  });

  it('numbers by the restaurant\'s day, and resets on the next one', async () => {
    expect(placed(await place()).seq).toBe(1);
    expect(placed(await place()).seq).toBe(2);

    // 8pm on the 5th, local — a new business day, so #1 comes round again.
    const tomorrow = placed(await place({ now: new Date(Date.UTC(2026, 6, 6, 3, 0, 0)) }));
    expect(tomorrow).toMatchObject({ businessDay: '2026-07-05', seq: 1 });
  });

  it('gives twelve simultaneous checkouts twelve different numbers', async () => {
    // The rush. Every one of these reads the same maximum before any of them
    // writes; the unique constraint is what keeps them apart, and the retry is
    // what keeps them all served.
    const orders = await Promise.all(Array.from({ length: 12 }, () => place().then(placed)));

    expect(orders.map((order) => order.seq).sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(await prisma.order.count()).toBe(12);
  });
});

describe('idempotent placement (P0-10)', () => {
  it('answers a double-tap with the first order, byte for byte', async () => {
    const first = await place({ idempotencyKey: 'double-tap' });
    const second = await place({ idempotencyKey: 'double-tap' });

    expect(first).toMatchObject({ ok: true, replayed: false });
    expect(second).toMatchObject({ ok: true, replayed: true });
    // Same answer, not merely no duplicate: a second tap that returned a
    // different order number would send the customer to the wrong counter.
    expect(placed(second)).toEqual(placed(first));
    expect(await prisma.order.count()).toBe(1);
  });

  it('answers two SIMULTANEOUS taps with one order', async () => {
    const [first, second] = await Promise.all([
      place({ idempotencyKey: 'race' }),
      place({ idempotencyKey: 'race' }),
    ]);

    expect(await prisma.order.count()).toBe(1);
    expect(placed(first!).id).toBe(placed(second!).id);
  });

  it('replays even after the menu changed under the customer', async () => {
    const first = placed(await place({ idempotencyKey: 'sold-out-since' }));
    // The guac ran out between the tap and the retry. The food is already
    // being made; telling the customer it failed would be the lie.
    await prisma.modifierOption.update({
      where: { id: 'guacamole' },
      data: { available: false },
    });

    const replay = await place({ idempotencyKey: 'sold-out-since' });
    expect(placed(replay)).toEqual(first);
  });

  it('refuses a placement carrying no key at all', async () => {
    const result = await place({ idempotencyKey: '' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.errors.map((e) => e.kind)).toContain(
      'idempotency_key_required',
    );
    expect(await prisma.order.count()).toBe(0);
  });
});

describe('what placement refuses', () => {
  const refusal = async (overrides: Partial<PlacementInput>) => {
    const result = await place(overrides);
    expect(result.ok).toBe(false);
    expect(await prisma.order.count()).toBe(0);
    return result.ok === false ? result : null;
  };

  it('an order with no name (P0-8)', async () => {
    const result = await refusal({ customerName: '   ' });
    expect(result?.errors.map((e) => e.kind)).toEqual(['name_required']);
  });

  it('an empty cart', async () => {
    const result = await refusal({ cart: { lines: [] } });
    expect(result?.errors.map((e) => e.kind)).toEqual(['empty_cart']);
  });

  it('a line whose option was 86\'d while it sat in the cart (P0-3)', async () => {
    await prisma.modifierOption.update({
      where: { id: 'guacamole' },
      data: { available: false },
    });

    const result = await refusal({});
    expect(result?.errors.map((e) => e.kind)).toEqual(['option_unavailable']);
    // The review comes back with it, so checkout can point at the line rather
    // than at the order.
    expect(result?.review.lines[0]?.problems[0]).toMatchObject({ optionId: 'guacamole' });
  });

  it('a line that was repriced while it sat in the cart (P0-3)', async () => {
    await prisma.menuItem.update({ where: { id: 'burrito' }, data: { basePriceCents: 1195 } });

    const result = await refusal({});
    expect(result?.errors.map((e) => e.kind)).toEqual(['price_changed']);
    expect(result?.review.lines[0]?.priceChange).toEqual({
      fromUnitPriceCents: 1620,
      toUnitPriceCents: 1720,
    });
  });

  it('reports every reason at once, not one per submit', async () => {
    const result = await refusal({ customerName: '', orderNote: 'n'.repeat(141) });
    expect(result?.errors.map((e) => e.kind)).toEqual(['name_required', 'order_note_too_long']);
  });
});

describe('the server is the price authority (P0-2)', () => {
  it('ignores a tampered client total and logs the mismatch', async () => {
    const order = placed(await place({ clientTotalCents: 0 }));

    expect(order.totalCents).toBe(3507);

    const mismatch = await prisma.orderEvent.findFirst({
      where: { orderId: order.id, kind: 'total_mismatch' },
    });
    expect(mismatch).toMatchObject({
      actor: 'customer',
      detail: { clientTotalCents: 0, serverTotalCents: 3507 },
    });
  });

  it('logs nothing when the client agreed', async () => {
    const order = placed(await place({ clientTotalCents: 3507 }));
    expect(
      await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'total_mismatch' } }),
    ).toBe(0);
  });

  it('charges today\'s price, not the price the cart remembered', async () => {
    // A reprice the customer HAS confirmed: the cart's baseline says 1720
    // because they clicked through the old -> new prompt.
    await prisma.menuItem.update({ where: { id: 'burrito' }, data: { basePriceCents: 1195 } });
    const confirmed: Cart = {
      lines: [{ ...CART.lines[0]!, unitPriceAtAddCents: 1720 }],
    };

    const order = placed(await place({ cart: confirmed }));
    expect(order).toMatchObject({ subtotalCents: 3440, taxCents: 284, totalCents: 3724 });
  });

  it('taxes at the restaurant\'s configured rate, snapshotted', async () => {
    await seedSettings({ taxRatePpm: 0 });
    const order = placed(await place());
    expect(order).toMatchObject({ taxRatePpm: 0, taxCents: 0, totalCents: 3240 });
  });
});

describe('the quote the customer was given (P1-4)', () => {
  // Firebird's defaults: 12 minutes base, one per unit of open work. Nothing
  // in front of the first order, so 12 rounds down to a 10–20 window.
  it('snapshots the ready-time range and the queue it was computed against', async () => {
    const order = placed(await place());
    expect(order).toMatchObject({
      quotedLowMinutes: 10,
      quotedHighMinutes: 20,
      quotedOpenWeight: 0,
    });
  });

  it('quotes the SECOND order against the first one, which is now in front of it', async () => {
    const first = placed(await place());
    // The burrito weighs 2 and there are two of them.
    expect(first.prepWeight).toBe(4);

    const second = placed(await place());
    expect(second).toMatchObject({
      quotedOpenWeight: 4,
      quotedLowMinutes: 15,
      quotedHighMinutes: 25,
    });
  });

  // The point of the column. The estimate is recomputed on every render of the
  // status page, which is right for a customer watching the queue — but an
  // order that has been placed was promised one thing, and a settings change
  // an hour later must not rewrite what it was promised.
  it('is not rewritten when the settings that produced it move', async () => {
    const order = placed(await place());
    await seedSettings({ prepBaseMinutes: 45, prepPerWeightMinutes: 6 });

    const reread = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(reread).toMatchObject({ quotedLowMinutes: 10, quotedHighMinutes: 20 });
  });

  it('replays the ORIGINAL quote for a double-submit, not a fresh one', async () => {
    const key = 'double-tap';
    const first = placed(await place({ idempotencyKey: key }));
    // Another order lands in between, so a recomputed quote would differ.
    await place();
    const replay = await place({ idempotencyKey: key });

    expect(replay).toMatchObject({ ok: true, replayed: true });
    expect(placed(replay)).toMatchObject({
      quotedLowMinutes: first.quotedLowMinutes,
      quotedHighMinutes: first.quotedHighMinutes,
      quotedOpenWeight: first.quotedOpenWeight,
    });
  });
});
