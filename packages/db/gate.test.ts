import { isLeftOver, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadGateState } from './gate';
import { prisma } from './index';
import { placeOrder, type PlacementResult } from './placement';
import { loadQueue } from './queue';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

// C-011: the checkout gate, where it meets the database (P0-6).
//
// The unit tests in packages/core drive the clock directly and cover the
// hours arithmetic. This file covers the two things only a database can be
// wrong about: what `loadGateState` reads, and whether `placeOrder` actually
// REFUSES — a gate that only hides a button is not a gate.

// 8pm on the 4th of July in Los Angeles, matching placement.test.ts.
const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

const CART: Cart = {
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1095,
      composition: {
        itemId: 'burrito',
        quantity: 1,
        selections: [{ groupId: 'protein', optionId: 'chicken' }],
      },
    },
  ],
};

let keyCounter = 0;
const place = (): Promise<PlacementResult> =>
  placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `gate-key-${(keyCounter += 1)}`,
    now: DINNER,
  });

const refusal = (result: PlacementResult) => {
  if (result.ok) throw new Error('expected the gate to refuse this placement');
  return result.errors.find((error) => error.kind === 'ordering_closed');
};

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('loadGateState (P0-6)', () => {
  it('reads the settings row, the hours, and the open-order count together', async () => {
    const state = await loadGateState(DINNER);
    expect(state).toMatchObject({
      timezone: 'America/Los_Angeles',
      taxRatePpm: 82_500,
      paused: false,
      maxOpenOrders: 25,
      openOrderCount: 0,
      closedOnDay: null,
      cutoffMinutes: 0,
      // The P0-7 numbers ride along on the same read, off the same count.
      prepBaseMinutes: 12,
      prepPerOrderMinutes: 1,
    });
    expect(state.hours).toHaveLength(7);
  });

  it('throws rather than inventing a wide-open restaurant when settings are missing', async () => {
    await prisma.restaurantSettings.deleteMany();
    await expect(loadGateState(DINNER)).rejects.toThrow();
  });

  it('counts open orders from OPEN_STATUSES, not from a list spelled out here', async () => {
    const first = await place();
    if (!first.ok) throw new Error('setup placement refused');
    expect((await loadGateState(DINNER)).openOrderCount).toBe(1);

    // `ready` is deliberately NOT open: the food is made, so it no longer
    // competes for kitchen capacity and must not hold the throttle closed.
    // Three advances: placed -> accepted -> preparing -> ready.
    for (let i = 0; i < 3; i += 1) {
      await applyOrderAction(first.order.id, { kind: 'advance', actor: 'staff' }, DINNER);
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).status).toBe(
      'ready',
    );
    expect((await loadGateState(DINNER)).openOrderCount).toBe(0);
  });

  it('does not count an order left over from an earlier service (P1-6)', async () => {
    const stale = await place();
    if (!stale.ok) throw new Error('setup placement refused');
    expect((await loadGateState(DINNER)).openOrderCount).toBe(1);

    // The same row, one service later. `preparing` is as open as a status
    // gets, and this is exactly the row nobody remembered to tap: counted, it
    // inflates every quoted wait, and enough of them hold the auto-pause shut
    // on a restaurant that is standing empty.
    await prisma.order.update({
      where: { id: stale.order.id },
      data: { businessDay: '2026-07-03' },
    });
    expect((await loadGateState(DINNER)).openOrderCount).toBe(0);

    // And the queue still shows it — flagged, not swept. This is the pair of
    // assertions that has to stay together: excluding it from the count
    // without leaving it on a screen is how an order disappears.
    expect(await loadQueue()).toHaveLength(1);
    expect(isLeftOver({ status: 'placed', businessDay: '2026-07-03' }, '2026-07-04')).toBe(true);
  });
});

describe('placement obeys the gate (P0-6)', () => {
  it('places normally when the gate is open', async () => {
    expect((await place()).ok).toBe(true);
  });

  it('refuses while manually paused, and says what staff wrote', async () => {
    await seedSettings({ ordersPaused: true, pauseMessage: 'Fryer is down until 2.' });
    expect(refusal(await place())).toMatchObject({
      reason: 'manually_paused',
      message: 'Fryer is down until 2.',
    });
  });

  it('refuses on a closed-today override for the restaurant\'s day', async () => {
    // The 4th in Los Angeles — NOT the 5th, which is what UTC would say and
    // what a gate reaching for the process clock would compare against.
    await seedSettings({ closedOnDay: '2026-07-04' });
    expect(refusal(await place())).toMatchObject({ reason: 'closed_today' });

    await seedSettings({ closedOnDay: '2026-07-05' });
    expect((await place()).ok).toBe(true);
  });

  it('auto-pauses at the open-order threshold and resumes below it', async () => {
    await seedSettings({ maxOpenOrders: 2 });
    expect((await place()).ok).toBe(true);
    const second = await place();
    if (!second.ok) throw new Error('second placement refused');

    // Two open orders, max of two: the gate is shut without anyone touching it.
    expect(refusal(await place())).toMatchObject({ reason: 'too_busy' });

    // Advance one to `ready` and it stops counting — the gate opens itself.
    for (let i = 0; i < 3; i += 1) {
      await applyOrderAction(second.order.id, { kind: 'advance', actor: 'staff' }, DINNER);
    }
    expect((await place()).ok).toBe(true);
  });

  it('refuses outside store hours', async () => {
    // 20:00 in Los Angeles: a 09:00–17:00 Saturday is long over.
    await seedStoreHours([{ dayOfWeek: 6, openMinute: 9 * 60, closeMinute: 17 * 60 }]);
    expect(refusal(await place())).toMatchObject({ reason: 'closing_soon' });
  });

  it('refuses inside hours but past the pre-close cutoff', async () => {
    // 20:00, closing at 21:00, with a 90-minute cutoff: the kitchen is open,
    // online ordering is not.
    await seedStoreHours([{ dayOfWeek: 6, openMinute: 11 * 60, closeMinute: 21 * 60 }]);
    await seedSettings({ cutoffMinutes: 90 });
    expect(refusal(await place())).toMatchObject({ reason: 'closing_soon' });

    await seedSettings({ cutoffMinutes: 15 });
    expect((await place()).ok).toBe(true);
  });

  it('writes nothing at all when it refuses', async () => {
    await seedSettings({ ordersPaused: true });
    await place();
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderEvent.count()).toBe(0);
  });

  it('still replays an already-placed order after the gate closes', async () => {
    // The customer's food is already on the grill. A retry of THAT attempt —
    // an impatient reload, a flaky connection — must return their order, not
    // tell them the restaurant has since closed (P0-10 beats P0-6 here).
    const first = await placeOrder({
      cart: CART,
      customerName: 'Dana',
      idempotencyKey: 'replay-across-the-gate',
      now: DINNER,
    });
    if (!first.ok) throw new Error('setup placement refused');

    await seedSettings({ ordersPaused: true });

    const retry = await placeOrder({
      cart: CART,
      customerName: 'Dana',
      idempotencyKey: 'replay-across-the-gate',
      now: DINNER,
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.replayed).toBe(true);
    expect(retry.order.id).toBe(first.order.id);
    expect(await prisma.order.count()).toBe(1);
  });
});
