import type { Cart } from '@countertop/core';
import { beforeEach, expect, it } from 'vitest';
import { placeOrder } from './placement';
import { queueCursor, staffNotes } from './queue';
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

// C-092. Pure, so it needs no database: the events come off the card's own
// read, which is newest-first for the undo, and the card reads notes in the
// order they were written because two notes are a story told forwards.
it('reads the shift\'s notes oldest first and ignores every other kind', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 6, 5, 19, minute, 0));
  const notes = staffNotes({
    events: [
      { at: at(58), kind: 'note', detail: { note: 'called, arriving 7:40' } },
      { at: at(56), kind: 'transition', detail: null },
      { at: at(52), kind: 'note', detail: { note: 'no answer' } },
      // A revert's note goes in the same `detail.note`, and is NOT this. The
      // receipt renders it beside the revert it explains; the card would
      // otherwise show "came back at 8" as something somebody wrote today.
      { at: at(50), kind: 'revert', detail: { note: 'came back at 8' } },
      // A payload that is not a note at all, from the mismatch log.
      { at: at(48), kind: 'total_mismatch', detail: { claimedCents: 100 } },
    ],
  });
  expect(notes).toEqual([
    { at: at(52), note: 'no answer' },
    { at: at(58), note: 'called, arriving 7:40' },
  ]);
});
