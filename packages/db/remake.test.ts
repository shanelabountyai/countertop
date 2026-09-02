// The remake link (PRD 3 P0-3, C-066), through the real write path.
//
// Decision 7 of 2026-09-02: a remake is a real second order. These prove the
// three things that decision costs — the snapshot is COPIED rather than
// re-priced, the money is neutral on both orders, and the report does not
// count the food twice.
import { orderBalance, salesReport, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { remakeOrder } from './remake';
import { placeOrder, type PlacementInput } from './placement';
import { loadReportOrders } from './report';
import { applyOrderAction } from './transitions';
import { resetDatabase, seedSampleMenu, seedSettings, seedStoreHours } from './testing/index';

const DINNER = new Date(Date.UTC(2026, 6, 5, 3, 0, 0));
/** Anything before DINNER: the report window is "placed at or after this". */
const WINDOW_START = new Date(Date.UTC(2026, 6, 5, 0, 0, 0));

/** Ivy's torta, in the shape this repo's fixtures use: 1620 a unit, quantity
 *  2, 8.25% tax — $35.07. The NEGATION is the point of the scenario, so it is
 *  in the composition and asserted on the copy. */
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
    customerName: 'Ivy Castellanos',
    orderNote: 'cut it in half please',
    idempotencyKey: `remake-${(keyCounter += 1)}`,
    now: DINNER,
    ...overrides,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  return result.order;
}

const withEvents = (id: string) =>
  prisma.order.findUniqueOrThrow({
    where: { id },
    select: { totalCents: true, events: { select: { kind: true, amountCents: true } } },
  });

beforeEach(async () => {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
  await seedStoreHours();
});

describe('remaking an order (P0-3, decision 7)', () => {
  it('creates a REAL second order with its own number and its own ticket', async () => {
    const original = await place();
    const result = await remakeOrder(original.id, 'wrong_item', DINNER, 'onions off');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order.id).not.toBe(original.id);
    expect(result.order.seq).toBe(original.seq + 1);
    // On the line, alerting, exactly like any other new ticket — which is the
    // whole reason this shape was chosen over an adjustment.
    expect(result.order.status).toBe('placed');
  });

  it('copies the snapshot verbatim, negation and customer note included', async () => {
    const original = await place();
    const result = await remakeOrder(original.id, 'wrong_item', DINNER);
    if (!result.ok) throw new Error('refused');

    expect(result.order.totalCents).toBe(original.totalCents);
    expect(result.order.subtotalCents).toBe(original.subtotalCents);
    expect(result.order.taxCents).toBe(original.taxCents);
    // Ivy asked for it cut in half and got neither that nor the onions off.
    // A remake that loses either goes out wrong twice.
    expect(result.order.orderNote).toBe('cut it in half please');
    expect(result.order.customerName).toBe('Ivy Castellanos');
    const onions = result.order.lines[0]!.options.find((o) => o.optionName === 'Onions');
    expect(onions?.intensity).toBe('none');
  });

  it('puts the correction ON the ticket, above the customer\'s own note', async () => {
    const original = await place();
    const result = await remakeOrder(original.id, 'wrong_item', DINNER, 'onions off, cut in half');
    if (!result.ok) throw new Error('refused');

    // The first version of this shipped the note into the comp's `detail`,
    // where nothing the cook looks at renders it — a remake that loses the
    // correction goes out wrong a second time.
    expect(result.order.orderNote).toBe('REMAKE: onions off, cut in half · cut it in half please');
  });

  it('keeps the customer note alone when there is no correction to add', async () => {
    const original = await place();
    const result = await remakeOrder(original.id, 'quality', DINNER);
    if (!result.ok) throw new Error('refused');
    expect(result.order.orderNote).toBe('cut it in half please');
  });

  it('never overflows the note column, and the correction wins the truncation', async () => {
    const original = await place();
    // A LEGAL note — the shared 140 cap refuses anything longer, and the UI
    // stops at it too. What overflows is the COMBINATION with the customer's
    // own note, and the correction is the half that must survive: it is the
    // instruction the kitchen already got wrong once.
    const result = await remakeOrder(original.id, 'quality', DINNER, 'y'.repeat(135));
    if (!result.ok) throw new Error('refused');
    expect(result.order.orderNote!.length).toBe(140);
    expect(result.order.orderNote!.startsWith('REMAKE: yyy')).toBe(true);
  });

  it('refuses a correction longer than the note column, rather than silently cutting it', async () => {
    const original = await place();
    const result = await remakeOrder(original.id, 'quality', DINNER, 'z'.repeat(200));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('adjustment_note_too_long');
  });

  it('does NOT re-price off a menu that has moved since', async () => {
    const original = await place();
    // The kitchen repriced the burrito between the order and the complaint.
    await prisma.menuItem.update({
      where: { id: 'burrito' },
      data: { name: 'RENAMED', basePriceCents: 9999 },
    });

    const result = await remakeOrder(original.id, 'quality', DINNER);
    if (!result.ok) throw new Error('refused');
    expect(result.order.totalCents).toBe(original.totalCents);
    expect(result.order.lines[0]!.itemName).toBe(original.lines[0]!.itemName);
  });

  it('leaves nobody owing anything on either order', async () => {
    const original = await place({ paidNow: true });
    const result = await remakeOrder(original.id, 'wrong_item', DINNER);
    if (!result.ok) throw new Error('refused');

    // The remake is comped in full, so no counter is ever shown money to
    // collect for food nobody will be charged for.
    expect(orderBalance(await withEvents(result.order.id))).toEqual({
      collectedCents: 0,
      outstandingCents: 0,
    });
    // And the original is untouched — it was paid, and it stays paid.
    expect(orderBalance(await withEvents(original.id))).toEqual({
      collectedCents: original.totalCents,
      outstandingCents: 0,
    });
  });

  it('links one way and reads from both ends', async () => {
    const original = await place();
    const result = await remakeOrder(original.id, 'late', DINNER);
    if (!result.ok) throw new Error('refused');

    const link = await prisma.orderEvent.findFirstOrThrow({
      where: { kind: 'remake', orderId: result.order.id },
    });
    expect(link.relatedOrderId).toBe(original.id);
    expect(link.amountCents).toBeNull();
    // The reverse lookup the original's receipt does.
    expect(
      await prisma.orderEvent.count({ where: { kind: 'remake', relatedOrderId: original.id } }),
    ).toBe(1);
  });

  it('makes ONE ticket out of two taps genuinely in flight at once', async () => {
    const original = await place();
    // Concurrent, not sequential. Both read the same remake count, derive the
    // same idempotency key, and contend on the CONSTRAINT — the loser reads
    // the winner's order instead of minting a second ticket for the line.
    const [a, b] = await Promise.all([
      remakeOrder(original.id, 'wrong_item', DINNER),
      remakeOrder(original.id, 'wrong_item', DINNER),
    ]);
    if (!a.ok || !b.ok) throw new Error('refused');

    expect(a.order.id).toBe(b.order.id);
    expect(
      await prisma.orderEvent.count({ where: { kind: 'remake', relatedOrderId: original.id } }),
    ).toBe(1);
  });

  it('still allows a genuine second remake, because the replacement can go wrong too', async () => {
    const original = await place();
    const first = await remakeOrder(original.id, 'wrong_item', DINNER);
    const second = await remakeOrder(original.id, 'quality', DINNER);
    if (!first.ok || !second.ok) throw new Error('refused');

    // A deliberate later click is not a double tap: the operator has already
    // been redirected to the first remake, and asking again means the second
    // one also went out wrong. Two tickets, honestly.
    expect(second.order.id).not.toBe(first.order.id);
  });

  it('refuses to delete an order something was remade from', async () => {
    const original = await place();
    await remakeOrder(original.id, 'quality', DINNER);
    // `Restrict`: the link is the only record either happened.
    await expect(prisma.order.delete({ where: { id: original.id } })).rejects.toThrow();
  });

  it('says so rather than throwing when the order is gone', async () => {
    const result = await remakeOrder(
      '00000000-0000-4000-8000-000000000000',
      'quality',
      DINNER,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('order_not_found');
  });
});

describe('what the report does with a remake', () => {
  it('counts it as a remake and NOT as a second sale', async () => {
    const original = await place({ paidNow: true });
    const result = await remakeOrder(original.id, 'wrong_item', DINNER);
    if (!result.ok) throw new Error('refused');

    // Both orders all the way out of the kitchen, so both are `sold` by every
    // rule the report otherwise applies. That is exactly the trap.
    for (const id of [original.id, result.order.id]) {
      for (let step = 0; step < 4; step += 1) {
        await applyOrderAction(id, { kind: 'advance', actor: 'staff' }, DINNER);
      }
    }

    const report = salesReport(await loadReportOrders(WINDOW_START), 'America/Los_Angeles');
    expect(report.remakes).toBe(1);
    // One torta left the building and one torta is counted.
    expect(report.noShow.sold).toBe(1);
    const units = report.topItems.reduce((sum, item) => sum + item.quantity, 0);
    expect(units).toBe(2); // quantity 2 on ONE order, not 4 across two

    // And no attach rate is measured against more units than the one order
    // actually sold — 4 here would mean the replacement was counted as food.
    for (const rate of report.attachRates) {
      expect(rate.ofTotal).toBeLessThanOrEqual(2);
    }
  });

  it('books no revenue for the replacement', async () => {
    const original = await place({ paidNow: true });
    const before = salesReport(await loadReportOrders(WINDOW_START), 'America/Los_Angeles');
    const beforeCents = before.days.reduce((sum, day) => sum + day.totalCents, 0);

    const result = await remakeOrder(original.id, 'wrong_item', DINNER);
    if (!result.ok) throw new Error('refused');
    for (let step = 0; step < 4; step += 1) {
      await applyOrderAction(result.order.id, { kind: 'advance', actor: 'staff' }, DINNER);
    }

    const after = salesReport(await loadReportOrders(WINDOW_START), 'America/Los_Angeles');
    expect(after.days.reduce((sum, day) => sum + day.totalCents, 0)).toBe(beforeCents);
  });
});
