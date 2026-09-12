// What the database writes for the P1-3 stub — one row on the transition
// INTO `ready`, gated on the phone, and nowhere else.
import type { Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { listOrderNotifications, readyMessage } from './notifications';
import { placeOrder } from './placement';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';
import { applyOrderAction } from './transitions';

const AT = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

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
async function place(phone: string | undefined): Promise<{ id: string; seq: number }> {
  const placed = await placeOrder({
    cart: CART,
    customerName: 'Ivy',
    customerPhone: phone,
    idempotencyKey: `notif-${(keyCounter += 1)}`,
    now: AT,
  });
  if (!placed.ok) throw new Error(`placement refused: ${JSON.stringify(placed.errors)}`);
  return { id: placed.order.id, seq: placed.order.seq };
}

/** Every tap between the ticket printing and the bag going over the counter —
 *  the whole chain, so the row can be asserted absent on every step before
 *  `ready` and present on that one. */
async function advanceTo(orderId: string, target: string): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const moved = await applyOrderAction(orderId, { kind: 'advance', actor: 'staff' }, AT);
    if (!moved.ok) throw new Error(`advance refused: ${moved.failure.message}`);
    if (moved.order.status === target) return;
  }
  throw new Error(`never reached ${target}`);
}

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('the SMS stub outbox', () => {
  it('writes one row on the transition into ready, when a phone was given', async () => {
    const order = await place('5550102233');
    await advanceTo(order.id, 'preparing');
    expect(await listOrderNotifications(order.id)).toEqual([]);

    await advanceTo(order.id, 'ready');
    const rows = await listOrderNotifications(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toBe(readyMessage(order.seq));
  });

  it('writes nothing when the order has no phone', async () => {
    const order = await place(undefined);
    await advanceTo(order.id, 'ready');
    expect(await listOrderNotifications(order.id)).toEqual([]);
  });

  it('writes NOTHING on a second ready — one text per order, per kind', async () => {
    // THIS TEST ASSERTED THE OPPOSITE UNTIL C-121, and the rewrite is the
    // item rather than a detail of it. C-113 shipped `toHaveLength(2)` with
    // no comment defending it — in a repo where every decision carries its
    // reason, that absence was the tell: the test described what the code did
    // rather than what it should do.
    //
    // What it should do: a cook advances the wrong card and undoes it, which
    // the state machine PERMITS, so the ticket passes through `ready` twice.
    // The revert means the first message was wrong — the food was not ready —
    // and the customer has already been told once about this bag. A second
    // identical text minutes later is noise about the same food.
    //
    // The seeded rush is what found it: C-120 gave rush orders a phone for
    // the first time, and the wrong-advance customer came out of a real
    // service holding two copies of "#010 is ready for pickup".
    const order = await place('5550102233');
    await advanceTo(order.id, 'ready');
    await applyOrderAction(order.id, { kind: 'revert', actor: 'staff' }, AT);
    await advanceTo(order.id, 'ready');

    const rows = await listOrderNotifications(order.id);
    expect(rows).toHaveLength(1);
    // The FIRST row, kept — not the second written over it. The instant on it
    // is when the customer was actually told.
    expect(rows[0]!.message).toBe(readyMessage(order.seq));
  });

  it('does not let the duplicate roll the status change back', async () => {
    // The reason the write is `skipDuplicates` and not a plain `create`
    // against the same index. `queueReadyNotification` runs INSIDE
    // `applyOrderAction`'s transaction, so a P2002 there would take the
    // status with it — and the cook's second advance is the CORRECT one.
    const order = await place('5550102233');
    await advanceTo(order.id, 'ready');
    await applyOrderAction(order.id, { kind: 'revert', actor: 'staff' }, AT);

    const result = await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, AT);
    expect(result.ok).toBe(true);
    // The status moved even though the notification did not.
    expect(result.ok && result.order.status).toBe('ready');
    expect(await listOrderNotifications(order.id)).toHaveLength(1);
  });

  it('refuses a second row of the same kind at the DATABASE, not in code', async () => {
    // The constraint is the mechanism, asserted directly: a writer that never
    // went through `queueReadyNotification` is refused just the same. Without
    // this the index could be dropped and every test above would still pass
    // on the code path's own care.
    const order = await place('5550102233');
    await advanceTo(order.id, 'ready');
    await expect(
      prisma.notificationOutbox.create({
        data: { orderId: order.id, kind: 'ready', message: 'a second one, by hand' },
      }),
    ).rejects.toThrow(/NotificationOutbox_one_per_order_kind|Unique constraint/);
  });

  it('stores no phone column of its own — the retention guarantee', async () => {
    // `forgetOrderCustomer` (PRD 6 P0-4) nulls `Order.customerPhone` and
    // nothing else. A column here would be a second place it has to reach;
    // this is the row itself, not a re-derivation of the schema.
    const order = await place('5550102233');
    await advanceTo(order.id, 'ready');
    const row = await prisma.notificationOutbox.findFirstOrThrow({ where: { orderId: order.id } });
    expect(Object.keys(row)).not.toContain('phone');
  });
});
