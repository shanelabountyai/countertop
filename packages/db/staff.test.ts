import type { Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { collectOrderPayment } from './payment';
import { placeOrder } from './placement';
import {
  isStaffPin,
  listActiveStaff,
  shiftStamp,
  staffByPin,
  staffById,
  staffIdFromStamp,
  staffPinDigest,
} from './staff';
import { applyOrderAction } from './transitions';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';

// PRD 6 P0-2 (C-086). Every staff-written event since C-004 says
// `actor: 'staff'` and nothing else — the log can say a revert happened and
// cannot say who did it, and since C-038 it guards a cash button. This is the
// one thing in the second-pass set that cannot be retrofitted: every event
// written anonymous meanwhile is anonymous permanently.

const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));

const CART: Cart = {
  lines: [
    {
      id: 'line-1',
      unitPriceAtAddCents: 1345,
      composition: {
        itemId: 'burrito',
        quantity: 1,
        selections: [
          { groupId: 'protein', optionId: 'chicken' },
          { groupId: 'addons', optionId: 'guacamole' },
        ],
      },
    },
  ],
};

let keyCounter = 0;
async function place(paidNow = false) {
  const result = await placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `staff-${(keyCounter += 1)}`,
    now: DINNER,
    paidNow,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

const eventsOn = (orderId: string) =>
  prisma.orderEvent.findMany({
    where: { orderId },
    orderBy: { at: 'asc' },
    select: { kind: true, actor: true, toStatus: true, staffId: true },
  });

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
  await seedStaff(DINNER);
});

describe('turning four digits into a name', () => {
  it('stores a hex digest that satisfies the column CHECK, never the PIN', () => {
    const digest = staffPinDigest('1234');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toContain('1234');
  });

  it('accepts four digits and nothing else', () => {
    expect(isStaffPin('0000')).toBe(true);
    for (const bad of ['', '123', '12345', '12a4', ' 1234', '1234 ', '１２３４']) {
      expect(isStaffPin(bad), bad).toBe(false);
    }
  });

  it('resolves a PIN to the person it belongs to', async () => {
    expect(await staffByPin('1234')).toEqual({ id: 'staff-noor', name: 'Noor Haddad' });
    expect(await staffByPin('5678')).toEqual({ id: 'staff-theo', name: 'Theo Barnes' });
  });

  it('refuses a PIN nobody has, and one belonging to somebody who left', async () => {
    expect(await staffByPin('0000')).toBeNull();
    // Wes is deactivated. Someone who has left cannot start a shift.
    expect(await staffByPin('9012')).toBeNull();
  });

  it('still knows a deactivated person by id, because their rows keep their name', async () => {
    // The reason `active` is a flag and not a delete: a receipt from March has
    // to keep rendering the name of whoever moved it.
    expect(await staffById('staff-gone')).toEqual({ id: 'staff-gone', name: 'Wes Toma' });
    expect((await listActiveStaff()).map((s) => s.name)).toEqual(['Noor Haddad', 'Theo Barnes']);
  });
});

describe('the on-shift stamp — the one forgery that matters', () => {
  const SECRET = 'open-sesame';

  it('round-trips the id it was minted for', () => {
    expect(staffIdFromStamp(shiftStamp('staff-noor', SECRET), SECRET)).toBe('staff-noor');
  });

  it('refuses a cookie edited to name somebody else', () => {
    // The whole point. A cook is already past the passcode; what stops them
    // putting a colleague's name on a revert is that they cannot compute the
    // stamp for a different id.
    const noor = shiftStamp('staff-noor', SECRET);
    const forged = noor.replace('staff-noor', 'staff-theo');
    expect(staffIdFromStamp(forged, SECRET)).toBeNull();
  });

  it('refuses a stamp minted under a passcode that has since rotated', () => {
    // Rotating the passcode ends every shift as well as every session, which
    // is the correct blast radius and needs no second secret.
    expect(staffIdFromStamp(shiftStamp('staff-noor', SECRET), 'rotated')).toBeNull();
  });

  it('refuses everything when there is no passcode at all', () => {
    // An unset STAFF_PASSCODE locks the screen (C-037). A stamp keyed on the
    // empty string would be one anybody could compute.
    expect(staffIdFromStamp(shiftStamp('staff-noor', ''), '')).toBeNull();
  });

  it('returns null rather than throwing on a malformed cookie', () => {
    // `timingSafeEqual` throws on a length mismatch, which would turn a junk
    // cookie into a 500 on the queue screen mid-rush.
    for (const bad of [undefined, '', 'no-dot', '.', '.abc', 'staff-noor.', 'staff-noor.short']) {
      expect(staffIdFromStamp(bad, SECRET), String(bad)).toBeNull();
    }
  });
});

describe('a name on the row', () => {
  it('records two people as two people', async () => {
    // The PRD's test, word for word: two PINs, two advances, two events with
    // different identities.
    const noor = await staffByPin('1234');
    const theo = await staffByPin('5678');
    const order = await place();

    await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER, noor!.id);
    await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER, theo!.id);

    const moves = (await eventsOn(order.id)).filter((event) => event.actor === 'staff');
    expect(moves.map((event) => event.toStatus)).toEqual(['accepted', 'preparing']);
    expect(moves.map((event) => event.staffId)).toEqual(['staff-noor', 'staff-theo']);
  });

  it('leaves a row unattributed when nobody is on shift, rather than guessing', async () => {
    // The same shape a pre-migration row has, and the same shape the seed and
    // the rush write. An honest "we did not record this" — no default, no
    // synthetic "legacy" member, no first-staff-member fallback.
    const order = await place();
    await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER);

    const [, advance] = await eventsOn(order.id);
    expect(advance).toMatchObject({ actor: 'staff', staffId: null });
  });

  it('stamps only what the actor actually did', async () => {
    // A cancelled paid order writes two events: the staff transition and the
    // system's refund. Stamping the refund would put Noor's name on a row she
    // did not write — the engine wrote it, as a consequence.
    const order = await place(true);
    await applyOrderAction(
      order.id,
      { kind: 'cancel', actor: 'staff', reason: 'out_of_item' },
      DINNER,
      'staff-noor',
    );

    const events = await eventsOn(order.id);
    const cancel = events.find((event) => event.kind === 'transition' && event.actor === 'staff');
    expect(cancel?.staffId).toBe('staff-noor');
    expect(events.find((event) => event.kind === 'refund')?.staffId).toBeNull();
    // And the customer's own events — the placement, the checkout charge —
    // were never candidates.
    expect(
      events.filter((event) => event.actor === 'customer').every((event) => event.staffId === null),
    ).toBe(true);
  });

  it('puts a name on the cash button, which is the one that needed it', async () => {
    // The operator's own argument for this item, and the systems reviewer's:
    // an anonymous log guarding a cash control.
    const order = await place();
    for (let step = 0; step < 3; step += 1) {
      await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER, 'staff-theo');
    }

    expect(await collectOrderPayment(order.id, DINNER, 'staff-theo')).toEqual({ ok: true });
    const payment = (await eventsOn(order.id)).find((event) => event.kind === 'payment');
    expect(payment).toMatchObject({ actor: 'staff', staffId: 'staff-theo' });
  });

  it('refuses to delete somebody a row still names', async () => {
    // `onDelete: Restrict`. Attribution must not disappear because a staff
    // list was tidied up; deactivation is how a person leaves.
    const order = await place();
    await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER, 'staff-noor');

    await expect(prisma.staffMember.delete({ where: { id: 'staff-noor' } })).rejects.toThrow();
    expect(await staffById('staff-noor')).not.toBeNull();
  });
});
