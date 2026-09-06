// Auth at placement, capture at pickup (PRD 3 P1-1, C-069), through the real
// write paths.
//
// The arithmetic is proved in packages/core. What is proved here is the half
// only a database can say: that a hold is settled exactly once no matter how
// many times a card is advanced and undone, that the provider is handed the
// hold's own row id, and that a capture the provider refuses leaves an order
// the counter can still take money for.
import { orderBalance, paymentTotals, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { settleAuthorization } from './authorization';
import { prisma } from './index';
import { collectOrderPayment } from './payment';
import { placeOrder, type PlacementInput } from './placement';
import { type PaymentProvider } from './provider';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

/** The same hand-calculated composition every money test here uses: 1620 a
 *  unit, quantity 2, 8.25% tax — 3507 in total. */
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
    customerName: 'Ivy',
    idempotencyKey: `auth-${(keyCounter += 1)}`,
    now: DINNER,
    paidNow: true,
    ...overrides,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

/** Remembers what the seam was asked for, which is the assertion "the provider
 *  is handed the hold's own id" is made of. */
function stubProvider(fail?: string): {
  call: PaymentProvider;
  calls: { operation: string; key: string; amountCents: number }[];
} {
  const calls: { operation: string; key: string; amountCents: number }[] = [];
  return {
    calls,
    call: async (operation, key, amountCents) => {
      calls.push({ operation, key, amountCents });
      if (fail !== undefined) throw new Error(fail);
      return `mock_${operation}_${key}`;
    },
  };
}

const advance = (id: string, provider?: PaymentProvider) =>
  applyOrderAction(id, { kind: 'advance', actor: 'staff' }, DINNER, null, provider);

/** Walk to `ready`. */
async function toReady(id: string, provider?: PaymentProvider) {
  for (let step = 0; step < 3; step += 1) {
    const result = await advance(id, provider);
    if (!result.ok) throw new Error(`advance refused: ${result.failure.message}`);
  }
}

const reload = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      paymentState: true,
      status: true,
      totalCents: true,
      events: { select: { kind: true, amountCents: true } },
    },
  });

const kindsOn = async (id: string) =>
  (
    await prisma.orderEvent.findMany({
      where: { orderId: id },
      orderBy: { at: 'asc' },
      select: { kind: true },
    })
  ).map((event) => event.kind);

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('a hold at checkout', () => {
  it('records the hold and takes no money', async () => {
    const order = await place();
    expect(order.paymentState).toBe('authorized');

    const hold = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'authorization' },
    });
    expect(hold.amountCents).toBe(order.totalCents);
    expect(hold.authorizationId).toBeNull();
    expect(await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'payment' } })).toBe(0);
  });

  // The double-charge this item could most easily have introduced: an
  // authorized order that the counter is also invited to take cash for.
  it('leaves nothing for the counter to collect while it stands', async () => {
    const order = await place();
    await toReady(order.id);

    expect(orderBalance(await reload(order.id)).outstandingCents).toBe(0);
    expect(await collectOrderPayment(order.id, DINNER)).toEqual({
      ok: false,
      message: 'This order is already settled.',
    });
  });

  it('is untouched while the food is still being cooked', async () => {
    const order = await place();
    await toReady(order.id);
    expect(await kindsOn(order.id)).toEqual([
      'transition',
      'authorization',
      'transition',
      'transition',
      'transition',
    ]);
  });
});

describe('capture at pickup', () => {
  it('takes exactly what was held, on the transition into picked_up', async () => {
    const order = await place();
    await toReady(order.id);

    const provider = stubProvider();
    const result = await advance(order.id, provider.call);
    expect(result.ok).toBe(true);

    const hold = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'authorization' },
    });
    // THE HOLD'S OWN ROW ID IS THE KEY. Durable before the call, which is what
    // makes a retry after a lost response present the same one.
    expect(provider.calls).toEqual([
      { operation: 'capture', key: hold.id, amountCents: order.totalCents },
    ]);

    const after = await reload(order.id);
    expect(after.paymentState).toBe('paid');
    expect(paymentTotals(after.events)).toMatchObject({
      capturedCents: order.totalCents,
      authorizedCents: 0,
    });
    expect(orderBalance(after)).toEqual({
      collectedCents: order.totalCents,
      outstandingCents: 0,
    });
  });

  // THE UNDO, which is why the guard is a constraint and not a derived check.
  // `picked_up` is revertable on purpose — the fat-fingered advance needs it —
  // so "advance, undo, advance" is an ordinary sequence at a counter, and the
  // second advance must not charge the card again.
  it('charges once across an undo and a second advance', async () => {
    const order = await place();
    await toReady(order.id);

    const provider = stubProvider();
    await advance(order.id, provider.call);
    const undone = await applyOrderAction(
      order.id,
      { kind: 'revert', actor: 'staff', reason: 'wrong_order' },
      DINNER,
      null,
      provider.call,
    );
    expect(undone.ok).toBe(true);
    await advance(order.id, provider.call);

    const after = await reload(order.id);
    expect(after.status).toBe('picked_up');
    expect(after.events.filter((event) => event.kind === 'capture')).toHaveLength(1);
    expect(paymentTotals(after.events).capturedCents).toBe(order.totalCents);
    // The second advance found nothing held and never reached the provider.
    expect(provider.calls).toHaveLength(1);
  });

  it('does not settle twice when two screens advance the same card at once', async () => {
    const order = await place();
    await toReady(order.id);

    const provider = stubProvider();
    await Promise.all([advance(order.id, provider.call), advance(order.id, provider.call)]);

    const after = await reload(order.id);
    expect(after.events.filter((event) => event.kind === 'capture')).toHaveLength(1);
  });

  it('leaves a pay-at-pickup order alone — there was never a hold', async () => {
    const order = await place({ paidNow: false });
    await toReady(order.id);
    const provider = stubProvider();
    await advance(order.id, provider.call);

    expect(provider.calls).toEqual([]);
    expect((await reload(order.id)).paymentState).toBe('unpaid');
  });
});

// THE POINT OF THE ITEM. Before it, both of these were charged at checkout and
// needed a refund on the way out — a provider call that can fail, on money
// that never had to leave the card.
describe('a hold let go', () => {
  it('costs a no-show a void, not a refund', async () => {
    const order = await place();
    await toReady(order.id);

    const provider = stubProvider();
    await applyOrderAction(order.id, { kind: 'abandon', actor: 'staff' }, DINNER, null, provider.call);

    const hold = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'authorization' },
    });
    expect(provider.calls).toEqual([
      { operation: 'void', key: hold.id, amountCents: order.totalCents },
    ]);

    const after = await reload(order.id);
    expect(after.status).toBe('abandoned');
    // Nothing was taken, so nothing goes back and nothing is pending.
    expect(await kindsOn(order.id)).not.toContain('refund_requested');
    expect(paymentTotals(after.events)).toMatchObject({ capturedCents: 0, refundedCents: 0 });
    expect(after.paymentState).toBe('unpaid');

    const released = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'authorization_voided' },
    });
    expect(released).toMatchObject({
      reason: 'no_show',
      amountCents: order.totalCents,
      authorizationId: hold.id,
      // Nobody decided to release it; the no-show did.
      actor: 'system',
      staffId: null,
    });
  });

  it('costs a cancelled prepaid ticket a void, and asks for no refund', async () => {
    const order = await place();
    const provider = stubProvider();
    await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      DINNER,
      null,
      provider.call,
    );

    const kinds = await kindsOn(order.id);
    expect(kinds).toContain('authorization_voided');
    // The engine's refund request keys off `paymentState === 'paid'`, and an
    // authorized order is not paid. That is the whole mechanism: no refund is
    // requested because none is owed.
    expect(kinds).not.toContain('refund_requested');
    expect(kinds).not.toContain('refund');
    expect(provider.calls.map((call) => call.operation)).toEqual(['void']);
  });

  it('leaves an order that was collected at the counter refunding as before', async () => {
    // The refund machinery is not dead — it is reached by money that actually
    // arrived. C-067 and C-071 both still apply here, unchanged.
    const order = await place({ paidNow: false });
    await collectOrderPayment(order.id, DINNER);
    await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      DINNER,
    );

    expect(await kindsOn(order.id)).toEqual(
      expect.arrayContaining(['payment', 'refund_requested', 'refund']),
    );
    expect((await reload(order.id)).paymentState).toBe('refunded');
  });
});

describe('a capture the provider refuses', () => {
  it('releases the hold and puts the order back to owing at the counter', async () => {
    const order = await place();
    await toReady(order.id);

    const provider = stubProvider('card network declined');
    const result = await advance(order.id, provider.call);
    // The pickup itself is NOT the failure: the food went out and the
    // transition is correct. What changed is what the order owes.
    expect(result.ok).toBe(true);

    const after = await reload(order.id);
    expect(after.status).toBe('picked_up');
    expect(after.paymentState).toBe('unpaid');
    expect(orderBalance(after).outstandingCents).toBe(order.totalCents);

    const released = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'authorization_voided' },
    });
    expect(released.reason).toBe('capture_failed');
    // The provider's own words, where `readNote` already lifts them onto the
    // receipt — no new channel and no new column.
    expect(released.detail).toMatchObject({ note: 'card network declined' });

    // AND THE COUNTER CAN TAKE THE MONEY. That is the whole reason this is a
    // release rather than a new exceptions list: the customer is standing
    // there with the food, and the existing control is exactly right.
    expect(await collectOrderPayment(order.id, DINNER)).toEqual({ ok: true });
    expect((await reload(order.id)).paymentState).toBe('paid');
  });

  it('does not retry a hold it has already released', async () => {
    const order = await place();
    await toReady(order.id);
    await advance(order.id, stubProvider('declined').call);

    const provider = stubProvider();
    const again = await settleAuthorization(order.id, 'picked_up', DINNER, provider.call);
    expect(again).toEqual({
      ok: false,
      reason: 'nothing_held',
      message: 'There is no hold on this order to settle.',
    });
    expect(provider.calls).toEqual([]);
  });
});

describe('settleAuthorization on its own', () => {
  it('is safe on an order that is still in flight', async () => {
    const order = await place();
    const provider = stubProvider();
    expect(await settleAuthorization(order.id, 'preparing', DINNER, provider.call)).toMatchObject({
      ok: false,
      reason: 'nothing_held',
    });
    expect(provider.calls).toEqual([]);
  });

  it('says so when the order is gone', async () => {
    expect(
      await settleAuthorization('00000000-0000-4000-8000-000000000000', 'picked_up', DINNER),
    ).toMatchObject({ ok: false, reason: 'order_not_found' });
  });

  // A void the provider refused writes NOTHING: the hold is still live on the
  // customer's card, and a release row would say it is not.
  it('leaves the hold standing when the release itself fails', async () => {
    const order = await place();
    await toReady(order.id);
    const result = await settleAuthorization(
      order.id,
      'abandoned',
      DINNER,
      stubProvider('gateway timeout').call,
    );

    expect(result).toMatchObject({ ok: false, reason: 'raced' });
    expect(await kindsOn(order.id)).not.toContain('authorization_voided');
    expect((await reload(order.id)).paymentState).toBe('authorized');
  });
});
