// A refund that can fail (PRD 3 P0-4, C-067), through the real write paths.
//
// P0-4's own named test is here: "stub a provider that throws; assert the order
// shows refund pending, appears on the exceptions list, and that `paymentState`
// is not `refunded`." Everything else in this file exists because the failure
// path is only half of it — a failure nobody can clear is a worse product than
// the silent success it replaced.
import { orderBalance, paymentTotals, pendingRefunds, type Cart } from '@countertop/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { placeOrder, type PlacementInput } from './placement';
import { adjustOrder } from './adjustment';
import { collectOrderPayment } from './payment';
import { loadRefundExceptions, requestRefund, settleRefund } from './refund';
import { type PaymentProvider } from './provider';
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
/**
 * A placed order, and — with `paidNow` — money the restaurant is actually
 * HOLDING.
 *
 * C-069 changed what `paidNow` means at checkout: it is an authorization now,
 * and a hold is not refundable, it is voided. Every test in this file is about
 * money that has already arrived, so the helper takes it at the counter
 * instead — the path that still ends in `paid` before pickup, and the one a
 * shop uses when somebody hands over cash while the food is cooking.
 *
 * Through `collectOrderPayment` and not an inserted row, so what these tests
 * refund is money a real write path put there.
 */
async function place({ paidNow, ...overrides }: Partial<PlacementInput> = {}) {
  const result = await placeOrder({
    cart: CART,
    customerName: 'Dana',
    idempotencyKey: `refund-${(keyCounter += 1)}`,
    now: DINNER,
    ...overrides,
  });
  if (!result.ok) throw new Error(`placement refused: ${JSON.stringify(result.errors)}`);
  if (paidNow) {
    const collected = await collectOrderPayment(result.order.id, DINNER);
    if (!collected.ok) throw new Error(`collection refused: ${collected.message}`);
  }
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
function stubProvider(fail?: string): { call: PaymentProvider; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    call: async (_operation, idempotencyKey) => {
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
      events: { select: { id: true, kind: true, amountCents: true, refundRequestId: true } },
    },
  });

const cancel = (id: string, provider?: PaymentProvider) =>
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
    expect(pendingRefunds(after.events)).toEqual([]);
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
    expect(pendingRefunds((await reload(order.id)).events)).toEqual([]);
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
    expect(pendingRefunds(after.events)).toMatchObject([{ amountCents: null, failed: true }]);

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
    expect(pendingRefunds(after.events)).toEqual([]);
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

// PRD 3 P0-6 (C-071). The refund somebody DECIDES to send, which is the half
// of the money story C-067 and C-068 both left behind: cancelling was the only
// thing that could ask for one, and the state machine correctly refuses to
// cancel cooked food — so the orders where a refund is most obviously right
// were exactly the ones nothing could reach.
describe('a refund issued on purpose', () => {
  const ask = (
    orderId: string,
    amountCents: number,
    provider?: PaymentProvider,
    staffId: string | null = null,
  ) =>
    requestRefund(
      orderId,
      { amountCents, reason: 'quality', note: 'burrito was cold' },
      DINNER,
      staffId,
      provider,
    );

  it('sends part of what is held and leaves the rest', async () => {
    const order = await place({ paidNow: true });
    const provider = stubProvider();

    expect(await ask(order.id, 500, provider.call)).toEqual({ ok: true, amountCents: 500 });

    const after = await reload(order.id);
    expect(orderBalance(after).collectedCents).toBe(order.totalCents - 500);
    // A partial refund is still `paid`. The enum's three values are terminal
    // facts and "most of it is still ours" is not one of them — which is why
    // this column is now written from `derivePaymentState` rather than
    // compare-and-set to a literal.
    expect(after.paymentState).toBe('paid');
    expect(pendingRefunds(after.events)).toEqual([]);
    expect(await loadRefundExceptions()).toHaveLength(0);
  });

  it('flips to refunded only once everything captured has gone back', async () => {
    const order = await place({ paidNow: true });
    await ask(order.id, 500);
    expect((await reload(order.id)).paymentState).toBe('paid');

    await ask(order.id, order.totalCents - 500);
    const after = await reload(order.id);
    expect(after.paymentState).toBe('refunded');
    expect(orderBalance(after).collectedCents).toBe(0);
  });

  // The ask and the send are two rows, and the request's own id is what the
  // provider is handed — the same key discipline the cancellation's refund has
  // had since C-067, reached through the same function.
  it('writes the ask first and hands the provider its row id', async () => {
    const order = await place({ paidNow: true });
    const provider = stubProvider();
    await ask(order.id, 500, provider.call);

    const request = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'refund_requested' },
      select: { id: true, amountCents: true, actor: true, reason: true, detail: true },
    });
    // THE ASK IS FROZEN, and it is the one refund amount that is: the
    // cancellation's request carries null because it cannot know what will be
    // held later, and this one is a number a person typed.
    expect(request.amountCents).toBe(500);
    // A person decided, where the cancellation's request is `system`.
    expect(request.actor).toBe('staff');
    expect(request.reason).toBe('quality');
    expect(request.detail).toEqual({ note: 'burrito was cold' });
    expect(provider.keys).toEqual([request.id]);

    const refund = await prisma.orderEvent.findFirstOrThrow({
      where: { orderId: order.id, kind: 'refund' },
      select: { amountCents: true, refundRequestId: true, providerRef: true },
    });
    expect(refund).toEqual({
      amountCents: 500,
      refundRequestId: request.id,
      providerRef: `mock_${request.id}`,
    });
  });

  // REFUSED, NEVER CLAMPED, and refused BEFORE the provider is called. A clamp
  // would turn "$50 back on this $35.07 order" into a legal $35.07 refund and
  // tell nobody a wrong number was typed.
  it('refuses more than is held without touching the provider', async () => {
    const order = await place({ paidNow: true });
    const provider = stubProvider();

    const result = await ask(order.id, 5000, provider.call);
    expect(result).toMatchObject({ ok: false, reason: 'refund_exceeds_balance' });
    expect(provider.keys).toEqual([]);
    // Nothing was written either — a refused ask is not an ask.
    expect(
      await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'refund_requested' } }),
    ).toBe(0);
  });

  // THE CASE THE WHOLE ITEM EXISTS FOR. A comp on an order that has already
  // paid reads as a zero balance — true about what the customer OWES, wrong
  // about what the restaurant is HOLDING. `orderBalance`'s clamp has said so
  // in a comment since C-064.
  it('sends money back on an order that was comped after paying', async () => {
    const order = await place({ paidNow: true });
    expect((await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER)).ok).toBe(true);

    const comped = await reload(order.id);
    // Nothing owed, and the whole total still in the till. Both true.
    expect(orderBalance(comped).outstandingCents).toBe(0);
    expect(orderBalance(comped).collectedCents).toBe(order.totalCents);

    expect(await ask(order.id, order.totalCents)).toEqual({
      ok: true,
      amountCents: order.totalCents,
    });
    expect(orderBalance(await reload(order.id)).collectedCents).toBe(0);
  });

  // The offer C-068 named and deliberately did not build: a no-show is not
  // automatically a refund — the food was made — so it needs a control, and
  // the control has to work in a state the product could not refund at all.
  it('is available on an abandoned order, which nothing else could refund', async () => {
    const order = await place({ paidNow: true });
    for (const to of ['accepted', 'preparing', 'ready'] as const) {
      const moved = await applyOrderAction(order.id, { kind: 'advance', actor: 'staff' }, DINNER);
      expect(moved.ok, `advancing to ${to}`).toBe(true);
    }
    expect((await applyOrderAction(order.id, { kind: 'abandon', actor: 'staff' }, DINNER)).ok).toBe(
      true,
    );

    expect(await ask(order.id, 1000)).toEqual({ ok: true, amountCents: 1000 });
  });

  it('refuses to stack a second ask on one that has not been sent', async () => {
    const order = await place({ paidNow: true });
    await ask(order.id, 500, stubProvider('card network declined').call);

    const second = stubProvider();
    expect(await ask(order.id, 300, second.call)).toMatchObject({
      ok: false,
      reason: 'refund_already_pending',
    });
    expect(second.keys).toEqual([]);
  });

  // THE DEFECT THE PER-REQUEST SHAPE EXISTS TO PREVENT. Under the old
  // order-level derivation, any `refund` on the order meant "settled" — so a
  // second ask after a first refund had landed would read as already sent, the
  // exceptions list would be quiet, and nothing anywhere would chase the money.
  it('keeps a later ask visible even though an earlier refund already landed', async () => {
    const order = await place({ paidNow: true });
    await ask(order.id, 300);
    await ask(order.id, 500, stubProvider('card network declined').call);

    const after = await reload(order.id);
    expect(pendingRefunds(after.events)).toMatchObject([{ amountCents: 500, failed: true }]);
    expect((await loadRefundExceptions()).map((entry) => entry.id)).toEqual([order.id]);
  });

  // The retry names the request it was rendered against, and settles that one.
  it('retries the named request with its own amount and key', async () => {
    const order = await place({ paidNow: true });
    const failing = stubProvider('card network declined');
    await ask(order.id, 500, failing.call);

    const [request] = pendingRefunds((await reload(order.id)).events);
    const working = stubProvider();
    expect(await settleRefund(order.id, DINNER, null, working.call, request!.id)).toEqual({
      ok: true,
      amountCents: 500,
    });
    expect(working.keys).toEqual(failing.keys);
    expect(orderBalance(await reload(order.id)).collectedCents).toBe(order.totalCents - 500);
  });

  // The ask is frozen; the CEILING is not. A refund landing between the ask
  // and the attempt shrinks what is held, and the shortfall is refused rather
  // than quietly sent smaller — which would tell the counter a $30 refund went
  // out when $5.07 did.
  it('refuses at the attempt when the balance moved under it', async () => {
    const order = await place({ paidNow: true });
    const failing = stubProvider('card network declined');
    await ask(order.id, 3000, failing.call);
    const [request] = pendingRefunds((await reload(order.id)).events);

    // Money leaves by another door before the retry: a settled refund on a
    // different request is the only thing that can reduce `collectedCents`.
    const other = await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        at: DINNER,
        kind: 'refund_requested',
        actor: 'staff',
        reason: 'late',
        amountCents: 3000,
      },
      select: { id: true },
    });
    await settleRefund(order.id, DINNER, null, stubProvider().call, other.id);

    const provider = stubProvider();
    expect(await settleRefund(order.id, DINNER, null, provider.call, request!.id)).toMatchObject({
      ok: false,
      reason: 'refund_exceeds_balance',
    });
    expect(provider.keys).toEqual([]);
  });

  // THE CONSTRAINT IS THE MECHANISM, and this is it: one `refund` row per
  // request, enforced by a partial unique index rather than by the old
  // compare-and-set on `paymentState` — which a partial refund would have
  // silently stopped guarding, because the column stays `paid`.
  it('records one refund per request even under two simultaneous attempts', async () => {
    const order = await place({ paidNow: true });
    await ask(order.id, 500, stubProvider('card network declined').call);
    const [request] = pendingRefunds((await reload(order.id)).events);

    const both = await Promise.all([
      settleRefund(order.id, DINNER, null, stubProvider().call, request!.id),
      settleRefund(order.id, DINNER, null, stubProvider().call, request!.id),
    ]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(both.filter((result) => !result.ok && result.reason === 'raced')).toHaveLength(1);
    expect(
      await prisma.orderEvent.count({ where: { orderId: order.id, kind: 'refund' } }),
    ).toBe(1);
    expect(orderBalance(await reload(order.id)).collectedCents).toBe(order.totalCents - 500);
  });

  it('stamps who decided to send it', async () => {
    await seedStaff();
    const staff = await prisma.staffMember.findFirstOrThrow({ where: { name: 'Noor Haddad' } });
    const order = await place({ paidNow: true });
    await ask(order.id, 500, undefined, staff.id);

    const events = await prisma.orderEvent.findMany({
      where: { orderId: order.id, kind: { in: ['refund_requested', 'refund'] } },
      select: { kind: true, actor: true, staffId: true },
    });
    expect(events.every((event) => event.actor === 'staff' && event.staffId === staff.id)).toBe(
      true,
    );
  });
});

// PRD 3 P0-6 (C-071). A mistaken comp is corrected by a contradicting row, and
// the append-only trigger is what makes that not a preference.
describe('taking an adjustment back', () => {
  const reverse = (orderId: string, amountCents: number) =>
    adjustOrder(
      orderId,
      { kind: 'reversal', amountCents, reason: 'mistake', note: 'comped the wrong ticket' },
      DINNER,
    );

  it('restores what is owed and leaves both decisions in the log', async () => {
    const order = await place({ paidNow: false });
    await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER);
    expect(orderBalance(await reload(order.id)).outstandingCents).toBe(0);

    expect(await reverse(order.id, order.totalCents)).toEqual({
      ok: true,
      amountCents: order.totalCents,
    });

    const after = await reload(order.id);
    expect(orderBalance(after).outstandingCents).toBe(order.totalCents);
    expect(paymentTotals(after.events).adjustedCents).toBe(0);
    // Nothing was deleted. Both rows are still there, and the comp still says
    // when it was made and by whom.
    expect(
      await prisma.orderEvent.count({
        where: { orderId: order.id, kind: { in: ['adjustment', 'adjustment_reversed'] } },
      }),
    ).toBe(2);
  });

  it('never touches the snapshot columns, in either direction', async () => {
    const order = await place({ paidNow: false });
    await adjustOrder(order.id, { kind: 'comp', reason: 'quality' }, DINNER);
    await reverse(order.id, 500);

    const after = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { subtotalCents: true, taxCents: true, totalCents: true },
    });
    expect(after).toEqual({
      subtotalCents: order.subtotalCents,
      taxCents: order.taxCents,
      totalCents: order.totalCents,
    });
  });

  it('refuses more than was ever taken off', async () => {
    const order = await place({ paidNow: false });
    await adjustOrder(order.id, { kind: 'partial', amountCents: 500, reason: 'late' }, DINNER);
    expect(await reverse(order.id, 501)).toMatchObject({
      ok: false,
      reason: 'reversal_exceeds_adjusted',
    });
  });
});
