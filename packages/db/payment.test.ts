// Payment state through the real write paths (P1-8).
//
// The column and the `refund` event kind have been in the schema since C-003;
// until this item nothing wrote either, so `paid` and `refunded` were states
// the database could hold and the app could never reach. These are the three
// writes that make them reachable.
import { instantMinutesAfter, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { collectOrderPayment } from './payment';
import { orderBalance } from '@countertop/core';
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

// C-085 / PRD 6 P0-3. `paymentState` has been reachable since C-038, but
// flipping it recorded no instant, no actor and no amount — the `ponytail:`
// comment on `markOrderPaid` named that ceiling the day it was written. "When
// did we take that money?" had no answer at all for a counter collection.
describe('a payment is something that happened (PRD 6 P0-3)', () => {
  /** Walk to `ready`, the state a counter collection actually happens in. */
  const toReady = async (id: string) => {
    for (let step = 0; step < 3; step += 1) {
      const result = await applyOrderAction(id, { kind: 'advance', actor: 'staff' }, DINNER);
      if (!result.ok) throw new Error(`advance refused: ${result.failure.message}`);
    }
  };

  const paymentsOn = (orderId: string) =>
    prisma.orderEvent.findMany({ where: { orderId, kind: 'payment' }, orderBy: { at: 'asc' } });

  it('records the counter collection with its instant, its amount and where it happened', async () => {
    const order = await place();
    await toReady(order.id);

    // `instantMinutesAfter`, not `new Date(DINNER.getTime() + …)`: the
    // repo-wide ban on `new Date(<expr>)` is blanket by design, and the
    // restaurant-timezone module is where instant arithmetic lives.
    const collectedAt = instantMinutesAfter(DINNER, 11);
    expect(await collectOrderPayment(order.id, collectedAt)).toEqual({ ok: true });
    expect(await paymentStateOf(order.id)).toBe('paid');

    const [payment, ...rest] = await paymentsOn(order.id);
    expect(rest).toEqual([]);
    expect(payment).toMatchObject({
      at: collectedAt,
      actor: 'staff',
      // Not a status change, so the time-in-state tally steps over it exactly
      // as it steps over a refund.
      fromStatus: null,
      toStatus: null,
      detail: { amountCents: order.totalCents, where: 'counter', provider: 'mock' },
    });
  });

  it('records the charge taken at checkout too, as the customer', async () => {
    // Recording only the counter half would have made "every payment has a
    // time" false for most orders — about two thirds of a service pays here.
    const order = await place({ paidNow: true });
    const [payment] = await paymentsOn(order.id);
    expect(payment).toMatchObject({
      at: DINNER,
      actor: 'customer',
      detail: { amountCents: order.totalCents, where: 'checkout' },
    });
  });

  it('writes nothing for a pay-at-pickup order until somebody collects', async () => {
    const order = await place();
    expect(await paymentsOn(order.id)).toEqual([]);
  });

  it('is one payment when two people tap Collect at once', async () => {
    const order = await place();
    await toReady(order.id);

    const [first, second] = await Promise.all([
      collectOrderPayment(order.id, DINNER),
      collectOrderPayment(order.id, DINNER),
    ]);

    // One of them collected and one was told it is settled — but the assertion
    // that matters is that the log holds ONE payment. A second event here
    // would be a second payment in every report that ever reads the log.
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(await paymentsOn(order.id)).toHaveLength(1);
  });

  it('refuses a no-show and records nothing — nobody took the food', async () => {
    const order = await place();
    await toReady(order.id);
    await applyOrderAction(order.id, { kind: 'abandon', actor: 'staff' }, DINNER);

    const result = await collectOrderPayment(order.id, DINNER);
    expect(result).toEqual({
      ok: false,
      message: 'Nobody took this order, so there is nothing to collect on it.',
    });
    expect(await paymentsOn(order.id)).toEqual([]);
    expect(await paymentStateOf(order.id)).toBe('unpaid');
  });

  it('is queryable by the business day the order belongs to', async () => {
    // The event carries an instant; the DAY is the order's, in the
    // restaurant's calendar. Asking the other way round — bucketing the
    // instant here — is the timezone mistake `business-day.ts` refuses to
    // make, and a payment taken at 11:40pm belongs to the service it was for.
    const order = await place({ paidNow: true });
    const sameDay = await prisma.orderEvent.findMany({
      where: { kind: 'payment', order: { businessDay: order.businessDay } },
    });
    expect(sameDay).toHaveLength(1);
    expect(
      await prisma.orderEvent.count({
        where: { kind: 'payment', order: { businessDay: '1999-01-01' } },
      }),
    ).toBe(0);
  });

  it('leaves both money events on a refunded order, and the payment divides nothing', async () => {
    // The integration risk of a new event kind: a paid order that is cancelled
    // now carries a `payment` AND a `refund`, and the timeline has to step
    // over the new one. It does — `toStatus` is null, which is what makes
    // `timeInState` skip it.
    //
    // C-067 settled the odd one out this comment used to describe: the engine
    // gave `refund` the `cancelled` it accompanied, contradicting
    // `time-in-state.ts`'s own promise. The refund is no longer written by the
    // engine at all — it is written after the provider answers, outside the
    // transition — so both money events now carry null statuses, and the
    // assertion below is on both rather than on one.
    const order = await place({ paidNow: true });
    await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      DINNER,
    );

    const money = await prisma.orderEvent.findMany({
      where: { orderId: order.id, kind: { in: ['payment', 'refund'] } },
      orderBy: { at: 'asc' },
    });
    expect(money.map((event) => event.kind)).toEqual(['payment', 'refund']);
    expect(money.map((event) => event.toStatus)).toEqual([null, null]);
  });
});

// PRD 3 P0-2 (C-064), at the database grain. The arithmetic is proved in
// packages/core; what is proved here is that a receipt loaded through the real
// query carries what `orderBalance` needs, and that a partial refund leaves
// the snapshot alone.
describe('the balance, against the database', () => {
  it('survives a partial refund without touching a cent of the snapshot', async () => {
    const order = await place({ paidNow: true });
    const before = { subtotal: order.subtotalCents, tax: order.taxCents, total: order.totalCents };

    // Nothing writes a PARTIAL refund even now: C-067 sends back what the
    // restaurant is holding, in full. Inserted directly, as an append (which
    // the append-only trigger permits), because the balance has to be right on
    // the day something does.
    await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        at: DINNER,
        kind: 'refund',
        fromStatus: null,
        toStatus: null,
        actor: 'staff',
        amountCents: 300,
        detail: { amountCents: 300, provider: 'mock' },
      },
    });

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: {
        subtotalCents: true,
        taxCents: true,
        totalCents: true,
        events: { select: { kind: true, amountCents: true } },
      },
    });

    expect(orderBalance(reloaded)).toEqual({
      collectedCents: order.totalCents - 300,
      outstandingCents: 300,
    });
    // The snapshot rule, in money form: the order still costs what it cost.
    expect({
      subtotal: reloaded.subtotalCents,
      tax: reloaded.taxCents,
      total: reloaded.totalCents,
    }).toEqual(before);
  });

  it('lets the counter collect the remainder, and only the remainder', async () => {
    // The reason the collect path takes the BALANCE rather than the total: a
    // partly settled order must not be charged the whole ticket again.
    const order = await place();
    for (let step = 0; step < 3; step += 1) {
      await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER);
    }
    await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        at: DINNER,
        kind: 'payment',
        fromStatus: null,
        toStatus: null,
        actor: 'staff',
        amountCents: 1000,
        detail: { amountCents: 1000, where: 'counter', provider: 'mock' },
      },
    });

    expect(await collectOrderPayment(order.id, DINNER)).toEqual({ ok: true });

    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id, kind: 'payment' },
      orderBy: { at: 'asc' },
      select: { amountCents: true },
    });
    // 1000 already down, and the collection takes the rest — not another 3507.
    expect(events.map((event) => event.amountCents)).toEqual([1000, order.totalCents - 1000]);

    const reloaded = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { totalCents: true, events: { select: { kind: true, amountCents: true } } },
    });
    expect(orderBalance(reloaded).outstandingCents).toBe(0);
  });
});
