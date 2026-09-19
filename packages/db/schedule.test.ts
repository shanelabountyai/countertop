import type { Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadGateState } from './gate';
import { placeOrder, type PlacementInput, type PlacementResult } from './placement';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

// Same reference instant as placement.test.ts: 8pm on the 4th of July in Los
// Angeles (already the 5th in UTC). Store hours are the test default —
// open every minute of every day — so the only window that matters here is
// the one `availableSlots` computes from the lead time.
const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));
// clock.minuteOfDay = 20:00 = 1200. +20 lead = 1220, rounded up to the next
// 15-minute mark = 1230 = 20:30 — the first bookable slot.
const FIRST_SLOT = 20 * 60 + 30;
// The day `availableSlots` offers FIRST_SLOT on at DINNER — Los Angeles' 4th.
const DINNER_DAY = '2026-07-04';

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
const place = (overrides: Partial<PlacementInput> = {}): Promise<PlacementResult> =>
  placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `key-${(keyCounter += 1)}`,
    now: DINNER,
    requestedForDay: DINNER_DAY,
    ...overrides,
  });

function placed(result: PlacementResult) {
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedStoreHours();
});

describe('order-ahead scheduling (P1-2)', () => {
  it('books a slot: writes the instant, and quotes no ASAP range', async () => {
    await seedSettings({ scheduledOrdersEnabled: true, maxSlotWeight: 20 });
    const order = placed(await place({ requestedForMinute: FIRST_SLOT }));

    expect(order.requestedFor).toEqual(new Date(Date.UTC(2026, 6, 5, 3, 30, 0)));
    expect(order.quotedLowMinutes).toBeNull();
    expect(order.quotedHighMinutes).toBeNull();
    expect(order.quotedOpenWeight).toBeNull();
  });

  it('refuses a slot request when the feature is off', async () => {
    await seedSettings({ scheduledOrdersEnabled: false });
    const result = await place({ requestedForMinute: FIRST_SLOT });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ kind: 'slot_unavailable' }),
    );
  });

  it('refuses a minute the picker never generated', async () => {
    await seedSettings({ scheduledOrdersEnabled: true });
    // One minute before the lead time clears — never an offered slot.
    const result = await place({ requestedForMinute: FIRST_SLOT - 15 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ kind: 'slot_unavailable' }),
    );
  });

  it('fills a slot and refuses the next order that would overflow it', async () => {
    // The burrito weighs 2 (SAMPLE_MENU); a cap of 2 leaves room for exactly
    // one order in the slot.
    await seedSettings({ scheduledOrdersEnabled: true, maxSlotWeight: 2 });
    placed(await place({ requestedForMinute: FIRST_SLOT }));

    const second = await place({ requestedForMinute: FIRST_SLOT });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.errors).toContainEqual(
      expect.objectContaining({ kind: 'slot_unavailable' }),
    );
  });

  it('still refuses a scheduled order while the kitchen is paused', async () => {
    await seedSettings({ scheduledOrdersEnabled: true, ordersPaused: true });
    const result = await place({ requestedForMinute: FIRST_SLOT });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(
      expect.objectContaining({ kind: 'ordering_closed', reason: 'manually_paused' }),
    );
  });

  it('does not throttle a scheduled order off the LIVE queue — only its own slot caps it', async () => {
    await seedSettings({ scheduledOrdersEnabled: true, maxOpenWeight: 1 });
    // An ASAP order this heavy would trip `maxOpenWeight` on its own; a
    // scheduled one for a different slot must not be refused by it.
    placed(await place({ requestedForMinute: FIRST_SLOT }));
    const second = placed(await place({ requestedForMinute: FIRST_SLOT + 15 }));
    expect(second.requestedFor).not.toBeNull();
  });

  it('refuses a slot picked on yesterday\'s list and submitted after midnight (C-144)', async () => {
    await seedSettings({ scheduledOrdersEnabled: true, maxSlotWeight: 20 });
    // 00:05 on the 5th in Los Angeles. The 5th offers 20:30 too, so a bare
    // minute used to be booked a day late instead of refused.
    const afterMidnight = new Date(Date.UTC(2026, 6, 5, 7, 5, 0));

    const stale = await place({ now: afterMidnight, requestedForMinute: FIRST_SLOT });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error('unreachable');
    expect(stale.errors).toContainEqual(expect.objectContaining({ kind: 'slot_unavailable' }));

    // Picked off the 5th's own list, the same minute books the 5th.
    const fresh = placed(
      await place({ now: afterMidnight, requestedForMinute: FIRST_SLOT, requestedForDay: '2026-07-05' }),
    );
    expect(fresh.requestedFor).toEqual(new Date(Date.UTC(2026, 6, 6, 3, 30, 0)));
  });

  it('refuses a slot minute sent without its day', async () => {
    await seedSettings({ scheduledOrdersEnabled: true, maxSlotWeight: 20 });
    // Not through `place`, which supplies the day.
    const result = await placeOrder({
      cart: CART,
      customerName: 'Dana',
      idempotencyKey: 'no-day',
      now: DINNER,
      requestedForMinute: FIRST_SLOT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors).toContainEqual(expect.objectContaining({ kind: 'slot_unavailable' }));
  });

  it('loadGateState buckets booked weight by slot, for the NEXT read to see', async () => {
    await seedSettings({ scheduledOrdersEnabled: true, maxSlotWeight: 20 });
    placed(await place({ requestedForMinute: FIRST_SLOT }));

    const state = await loadGateState(DINNER);
    expect(state.scheduledOrdersEnabled).toBe(true);
    // The burrito weighs 2.
    expect(state.weightBySlot.get(FIRST_SLOT)).toBe(2);
    expect(state.weightBySlot.has(FIRST_SLOT + 15)).toBe(false);
  });
});
