// A refund that can fail (PRD 3 P0-4, C-067), through the real write paths.
//
// P0-4's own named test is here: "stub a provider that throws; assert the order
// shows refund pending, appears on the exceptions list, and that `paymentState`
// is not `refunded`." Everything else in this file exists because the failure
// path is only half of it — a failure nobody can clear is a worse product than
// the silent success it replaced.
import { deriveRefundState, orderBalance, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder, type PlacementInput } from './placement';
import { loadRefundExceptions, settleRefund, type RefundProvider } from './refund';
import { applyOrderAction } from './transitions';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';

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
    customerName: 'Dana',
    idempotencyKey: `refund-${(keyCounter += 1)}`,
    now: DINNER,
    ...overrides,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

/**
 * A processor stub that remembers what it was called with.
 *
 * ONE HELPER for both the throwing and the working case, because "a retry
 * presents the SAME key" is an assertion across the two of them and a pair of
 * separate stubs cannot make it. `fail` is the message it throws; without one
 * it behaves like the mock the product ships.
 */
function stubProvider(fail?: string): { call: RefundProvider; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    call: async (idempotencyKey) => {
      keys.push(idempotencyKey);
      if (fail !== undefined) throw new Error(fail);
      return `mock_${idempotencyKey}`;
    },
  };
}

const reload = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: {
      paymentState: true,
      totalCents: true,
      events: { select: { kind: true, amountCents: true } },
    },
  });

const cancel = (id: string, provider?: RefundProvider) =>
  applyOrderAction(id, { kind: 'cancel', actor: 'staff', reason: 'out_of_item' }, DINNER, null, provider);

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('the happy path still works, and now means something', () => {
  it('cancelling a paid order asks, sends, and records — in that order', async () => {
    const order = await place({ paidNow: true });
    const provider = stubProvider();
    expect((await cancel(order.id, provider.call)).ok).toBe(true);

    const after = await reload(order.id);
    expect(deriveRefundState(after.events)).toBe('succeeded');
    expect(after.paymentState).toBe('refunded');

    // The request precedes the refund, and the request is what the provider was
    // called with. Both halves matter: the first is the split P0-4 requires,
    // the second is the idempotency key being the request's own row id.
    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id, kind: { in: ['refund_requested', 'refund'] } },
      orderBy: { kind: 'asc' },
      select: { id: true, kind: true, amountCents: true, providerRef: true, actor: true },
    });
    const request = events.find((event) => event.kind === 'refund_requested')!;
    const refund = events.find((event) => event.kind === 'refund')!;
    expect(provider.keys).toEqual([request.id]);
    expect(request.amountCents).toBeNull();
    expect(refund.amountCents).toBe(order.totalCents);
    expect(refund.providerRef).toBe(`mock_${request.id}`);
    // Nobody tapped anything. The cook cancelled; the system sent.
    expect(refund.actor).toBe('system');
    expect(await loadRefundExceptions()).toHaveLength(0);
  });

  it('leaves an unpaid cancellation with no refund of any kind', async () => {
    const order = await place({ paidNow: false });
    await cancel(order.id);
    expect(deriveRefundState((await reload(order.id)).events)).toBeNull();
    expect(await loadRefundExceptions()).toHaveLength(0);
  });
});

// P0-4's named test, and the three assertions it names.
describe('a provider that throws', () => {
  it('leaves the refund pending, on the exceptions list, and NOT refunded', async () => {
    const order = await place({ paidNow: true });
    const provider = stubProvider('card network declined');
    const result = await cancel(order.id, provider.call);

    // The cancellation itself succeeded. That is the point of the split: the
    // status change and the refund attempt are not one write, so the money
    // failing does not un-cancel an order the counter has already told the
    // customer about.
    expect(result.ok).toBe(true);

    const after = await reload(order.id);
    expect(after.paymentState).toBe('paid');
    expect(deriveRefundState(after.events)).toBe('failed');

    const exceptions = await loadRefundExceptions();
    expect(exceptions.map((entry) => entry.id)).toEqual([order.id]);
    // What the list shows is what is still held, not the order total — the same
    // number the retry will send.
    expect(orderBalance(exceptions[0]!).collectedCents).toBe(order.totalCents);
  });

  it('writes the provider’s own words where the receipt reads them', async () => {
    const order = await place({ paidNow: true });
    await cancel(order.id, stubProvider('issuer unreachable').call);

    const failure = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'refund_failed' },
      select: { detail: true, amountCents: true, fromStatus: true, toStatus: true },
    });
    expect(failure.detail).toEqual({ note: 'issuer unreachable' });
    // Nothing moved, so nothing may sum.
    expect(failure.amountCents).toBeNull();
    expect([failure.fromStatus, failure.toStatus]).toEqual([null, null]);
  });

  it('does not let a failed refund lie to the customer about the money', async () => {
    const order = await place({ paidNow: true });
    await cancel(order.id, stubProvider('card network declined').call);
    // `paymentState` is the column every customer-facing surface reads, and
    // `derivePaymentState` is what it is a cache of. Both say the restaurant
    // still holds the money, because it does.
    const after = await reload(order.id);
    expect(after.paymentState).toBe('paid');
    expect(orderBalance(after).collectedCents).toBe(order.totalCents);
  });
});

describe('the retry', () => {
  it('presents the SAME key and clears the exception when it lands', async () => {
    const order = await place({ paidNow: true });
    const failing = stubProvider('card network declined');
    await cancel(order.id, failing.call);

    const working = stubProvider();
    const retried = await settleRefund(order.id, DINNER, null, working.call);
    expect(retried).toEqual({ ok: true, amountCents: order.totalCents });

    // THE IDEMPOTENCY CLAIM, asserted rather than described: the second attempt
    // carried the key the first one did, so a provider that had actually taken
    // the first request would recognise it rather than paying twice.
    expect(working.keys).toEqual(failing.keys);

    const after = await reload(order.id);
    expect(after.paymentState).toBe('refunded');
    expect(deriveRefundState(after.events)).toBe('succeeded');
    expect(await loadRefundExceptions()).toHaveLength(0);
  });

  it('appends a second failure rather than overwriting the first', async () => {
    const order = await place({ paidNow: true });
    await cancel(order.id, stubProvider('first').call);
    await settleRefund(order.id, DINNER, null, stubProvider('second').call);

    const failures = await prisma.orderEvent.findMany({
      where: { orderId: order.id, kind: 'refund_failed' },
      select: { detail: true },
    });
    expect(failures.map((event) => event.detail)).toEqual([{ note: 'first' }, { note: 'second' }]);
    expect(await loadRefundExceptions()).toHaveLength(1);
  });

  it('refuses once the money is already back, and refunds nothing twice', async () => {
    const order = await place({ paidNow: true });
    await cancel(order.id);

    const again = stubProvider();
    expect(await settleRefund(order.id, DINNER, null, again.call)).toMatchObject({
      ok: false,
      reason: 'already_refunded',
    });
    // The provider was never called a second time — the refusal is before the
    // network, not after it.
    expect(again.keys).toEqual([]);
    expect(
      await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'refund' } }),
    ).toBe(1);
  });

  it('refuses on an order nobody asked to refund', async () => {
    const order = await place({ paidNow: true });
    expect(await settleRefund(order.id, DINNER)).toMatchObject({
      ok: false,
      reason: 'no_refund_requested',
    });
  });

  // The amount is recomputed from the log at every attempt rather than frozen
  // at request time. A comp landing between the failure and the retry is the
  // case that proves it: the restaurant collected 3507 and still holds 3507
  // (a comp moves no money), so that is what goes back — and after it has gone
  // back there is nothing left to send.
  it('sends what the restaurant is holding at the moment of the attempt', async () => {
    const order = await place({ paidNow: true });
    await cancel(order.id, stubProvider('card network declined').call);

    await settleRefund(order.id, DINNER, null, stubProvider().call);
    const after = await reload(order.id);
    expect(orderBalance(after).collectedCents).toBe(0);
  });

  it('stamps the person who tapped it, where the automatic attempt is anonymous', async () => {
    await seedStaff();
    const staff = await prisma.staffMember.findFirstOrThrow({ where: { name: 'Noor Haddad' } });
    const order = await place({ paidNow: true });
    await cancel(order.id, stubProvider('card network declined').call);
    await settleRefund(order.id, DINNER, staff.id, stubProvider().call);

    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id, kind: { in: ['refund_failed', 'refund'] } },
      orderBy: { kind: 'asc' },
      select: { kind: true, actor: true, staffId: true },
    });
    expect(events).toEqual([
      // The retry: somebody's deliberate tap on a money control.
      { kind: 'refund', actor: 'staff', staffId: staff.id },
      // The automatic attempt after the cancellation: nobody decided to send it.
      { kind: 'refund_failed', actor: 'system', staffId: null },
    ]);
  });
});
