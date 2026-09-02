import {
  derivePaymentState,
  estimateAccuracy,
  instantMinutesAfter,
  isOpen,
  timeInState,
  timeInStateReport,
  type OrderStatus,
  type StatusEvent,
} from '@countertop/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { ORDER_RECEIPT } from './placement';
import { loadQuoteSamples } from './report';
import { runRush, RUSH_ANCHOR, RUSH_END_MINUTE, RUSH_ORDERS, type RushResult } from './rush';

// C-017 — the seeded rush, asserted. The PRD's lagging Success Metrics are the
// test list, near enough verbatim:
//
//   "A seeded rush (30 orders in 20 minutes via script) flows through the
//    queue with zero stuck or lost orders — and the rush includes the ugly
//    cases, or the demo proves nothing"
//   "Time-in-state report matches hand-tallied values for the seeded rush"
//   "Order numbers are sequential with no duplicates across the rush's
//    concurrent placements"
//
// The rush runs ONCE, in `beforeAll`, and every test reads the database it
// left behind. Re-running it per test would be twenty minutes of simulated
// service repeated a dozen times to prove twelve different things about the
// same twenty minutes.

const MIN = 60_000;
const END = instantMinutesAfter(RUSH_ANCHOR, RUSH_END_MINUTE);

let rush: RushResult;

const orderFor = async (label: string) =>
  prisma.order.findFirstOrThrow({ where: { customerName: label }, ...ORDER_RECEIPT });

const eventsFor = async (label: string): Promise<StatusEvent[]> => {
  const order = await orderFor(label);
  return prisma.orderEvent.findMany({
    where: { orderId: order.id },
    orderBy: { at: 'asc' },
    select: { at: true, toStatus: true },
  });
};

beforeAll(async () => {
  rush = await runRush(RUSH_ANCHOR);
}, 180_000);

describe('the seeded rush', () => {
  it('lands thirty orders, and the two customers who bounced are counted, not lost', async () => {
    const placed = rush.attempts.filter((a) => a.outcome === 'placed');
    expect(placed).toHaveLength(30);
    expect(await prisma.order.count()).toBe(30);

    // Four attempts were refused: the stranded guacamole cart and three
    // arrivals during the pause. Two of those customers came back.
    const refused = rush.attempts.filter((a) => a.outcome === 'refused');
    expect(refused.map((a) => a.label).sort()).toEqual([
      'Bram Whitfield',
      'Juno Park',
      'Lila Ortiz',
      'Nia Feldman',
    ]);
    expect(rush.orderIds.has('Nia Feldman')).toBe(true);
    expect(rush.orderIds.has('Juno Park')).toBe(true);
    // The two who gave up have no order at all — a refusal is not a quiet
    // half-placement.
    expect(await prisma.order.count({ where: { customerName: 'Lila Ortiz' } })).toBe(0);
    expect(await prisma.order.count({ where: { customerName: 'Bram Whitfield' } })).toBe(0);
  });

  it('every arrival is inside the twenty-minute window', () => {
    for (const order of RUSH_ORDERS) {
      expect(order.minute).toBeLessThanOrEqual(20);
      expect(order.minute).toBeGreaterThanOrEqual(0);
    }
  });

  it('numbers the orders 1..30 with no duplicates, across concurrent placements', async () => {
    const orders = await prisma.order.findMany({ select: { businessDay: true, seq: true } });

    // One business day: the rush and its tail do not straddle midnight in the
    // restaurant's timezone, so a gap would be a real gap.
    expect(new Set(orders.map((o) => o.businessDay)).size).toBe(1);

    const seqs = orders.map((o) => o.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it('leaves nothing stuck: no order is still open when the rush is over', async () => {
    const open = await prisma.order.findMany({
      where: { status: { in: ['placed', 'accepted', 'preparing'] } },
      select: { customerName: true, status: true },
    });
    expect(open).toEqual([]);

    // And derived from THE status module rather than that literal list, so
    // adding a state cannot quietly slip past this assertion.
    const all = await prisma.order.findMany({ select: { status: true } });
    expect(all.filter((o) => isOpen(o.status as OrderStatus))).toEqual([]);

    expect(rush.finalStatuses).toEqual({ picked_up: 28, cancelled: 1, abandoned: 1 });
  });
});

describe('ugly case 1 — an option is 86\'d mid-rush', () => {
  it('refuses the cart that was composed before the kitchen ran out, at the OPTION grain', () => {
    const stranded = rush.attempts.find(
      (a) => a.label === 'Nia Feldman' && a.outcome === 'refused',
    );
    expect(stranded?.errors).toContain('option_unavailable');
    // Out of avocado is not out of burritos: the ITEM was never the problem.
    expect(stranded?.errors).not.toContain('item_unavailable');
  });

  it('lets the same customer through a minute later with the guacamole taken off', async () => {
    const fixed = await orderFor('Nia Feldman');
    expect(fixed.status).toBe('picked_up');
    const options = fixed.lines.flatMap((line) => line.options.map((o) => o.optionName));
    expect(options).not.toContain('Guacamole');
    // The negation survived the fix. It is the reason she ordered.
    expect(options).toContain('Onions');
  });

  it('does not touch the orders already placed with it — snapshots do not care', async () => {
    const ada = await orderFor('Ada Nkemelu');
    const guac = ada.lines[0]!.options.find((o) => o.optionName === 'Guacamole');

    // Still on the receipt, still at the price it was sold at, an hour after
    // the menu row it was copied from went unavailable.
    expect(guac).toMatchObject({ optionName: 'Guacamole', appliedDeltaCents: 250 });
    expect(ada.status).toBe('picked_up');

    const live = await prisma.modifierOption.findUniqueOrThrow({ where: { id: 'guacamole' } });
    expect(live.available).toBe(false);
  });

  it('cancels the in-flight order with the reason attached', async () => {
    const owen = await orderFor('Owen Brandt');
    expect(owen).toMatchObject({ status: 'cancelled', cancelReason: 'out_of_item' });
    expect(owen.cancelNote).toBe('Out of guacamole, called them');
    // The snapshot is untouched by the cancel: it still says what was ordered.
    expect(owen.lines[0]!.options.map((o) => o.optionName)).toContain('Guacamole');
  });
});

describe('ugly case 2 — a cook advances the wrong card', () => {
  it('records the undo as an appended revert, never as a deletion', async () => {
    const rae = await orderFor('Rae Sutton');
    const events = await prisma.orderEvent.findMany({
      where: { orderId: rae.id },
      orderBy: { at: 'asc' },
    });

    const revert = events.find((e) => e.kind === 'revert');
    expect(revert).toMatchObject({
      fromStatus: 'ready',
      toStatus: 'preparing',
      actor: 'staff',
      reason: 'advanced the wrong card',
    });

    // Placement + five moves + the revert, and — since C-085 — the payment
    // Rae's checkout took. The mistake is still in the history, which is the
    // whole point of an append-only log.
    expect(events).toHaveLength(8);
    expect(events.filter((e) => e.kind === 'payment')).toHaveLength(1);
    // The status walk, with the money event stepped over: it did not move the
    // order, so it does not belong in the sequence of states the order was in.
    expect(events.filter((e) => e.toStatus !== null).map((e) => e.toStatus)).toEqual([
      'placed',
      'accepted',
      'preparing',
      'ready',
      'preparing',
      'ready',
      'picked_up',
    ]);
    expect(rae.status).toBe('picked_up');
  });
});

describe('ugly case 3 — nobody collects the food', () => {
  it('ages out to abandoned, not to cancelled', async () => {
    const cass = await orderFor('Cass Iverson');
    expect(cass.status).toBe('abandoned');
    // A no-show is not a cancellation: the food was made. The distinction is
    // what makes the no-show rate mean anything (C-016).
    expect(cass.cancelReason).toBeNull();

    const events = await eventsFor('Cass Iverson');
    // Thirty-three minutes on the shelf — past all three no-show flags.
    expect(timeInState(events, END).ready).toBe(33 * MIN);
  });
});

describe('ugly case 4 — the customer double-taps Place order', () => {
  it('produces exactly one order, and the same answer twice', async () => {
    const attempt = rush.attempts.find((a) => a.label === 'Theo Marsh')!;

    // Idempotency means the SAME answer, not merely no duplicate.
    expect(attempt.replayedOrderId).toBe(attempt.orderId);
    expect(await prisma.order.count({ where: { customerName: 'Theo Marsh' } })).toBe(1);
  });
});

describe('ugly case 5 — orders arrive while the restaurant is paused', () => {
  it('bounces them off the gate with the reason, and takes them again once it lifts', async () => {
    const bounced = rush.attempts.filter(
      (a) => a.outcome === 'refused' && a.label !== 'Nia Feldman',
    );
    expect(bounced).toHaveLength(3);
    for (const attempt of bounced) expect(attempt.errors).toContain('ordering_closed');

    const juno = await orderFor('Juno Park');
    expect(juno.status).toBe('picked_up');
    // The retry is its OWN order, not a replay: a different tap, minutes
    // later, with a new idempotency key.
    expect(juno.placedAt.getTime()).toBe(RUSH_ANCHOR.getTime() + 19 * MIN);
  });
});

describe('the time-in-state report', () => {
  // HAND-TALLIED from the script, not recomputed from it. Every order is
  // accepted one minute after it lands and starts cooking two minutes after
  // that, so `placed` and `accepted` are flat across all thirty:
  //
  //   placed     30 × 1                                          =  30 min
  //   accepted   30 × 2                                          =  60 min
  //   preparing  27 × 8  + 12 slow  + Cass 3 + Owen 4 + Rae 8    = 243 min
  //   ready      27 × 3            + Cass 33 + Rae 4 + Owen 0    = 118 min
  //
  // The twelve slow minutes are Ivy 2, Ola 4, Rosa 3, Tam 2, Yara 1. Rae's
  // eight in `preparing` are two visits (5 + 3) because her ticket was
  // advanced by mistake and sent back — only the event log knows that.
  it('matches the hand tally, minute for minute', async () => {
    const orders = await prisma.order.findMany({ select: { id: true } });
    const logs = await Promise.all(
      orders.map((order) =>
        prisma.orderEvent.findMany({
          where: { orderId: order.id },
          select: { at: true, toStatus: true },
        }),
      ),
    );

    const rows = timeInStateReport(logs, END);
    const row = (status: OrderStatus) => rows.find((r) => r.status === status)!;

    expect(row('placed')).toMatchObject({ orders: 30, totalMs: 30 * MIN, averageMs: 1 * MIN });
    expect(row('accepted')).toMatchObject({ orders: 30, totalMs: 60 * MIN, averageMs: 2 * MIN });
    expect(row('preparing')).toMatchObject({ orders: 30, totalMs: 243 * MIN });
    // Twenty-nine reached `ready`: the cancelled order never did.
    expect(row('ready')).toMatchObject({ orders: 29, totalMs: 118 * MIN });

    // Terminal states do not accrue: an order picked up half an hour ago has
    // not been "in picked_up" for half an hour, it is done.
    expect(row('picked_up')).toMatchObject({ orders: 28, totalMs: 0 });
    expect(row('cancelled')).toMatchObject({ orders: 1, totalMs: 0 });
    expect(row('abandoned')).toMatchObject({ orders: 1, totalMs: 0 });
  });

  it('tallies one ordinary ticket exactly', async () => {
    // Ben Sorensen: placed at 0, accepted 1, preparing 3, ready 11, gone 14.
    expect(timeInState(await eventsFor('Ben Sorensen'), END)).toMatchObject({
      placed: 1 * MIN,
      accepted: 2 * MIN,
      preparing: 8 * MIN,
      ready: 3 * MIN,
      picked_up: 0,
    });
  });

  it('counts the reverted ticket\'s two visits to preparing', async () => {
    expect(timeInState(await eventsFor('Rae Sutton'), END)).toMatchObject({
      preparing: 8 * MIN,
      ready: 4 * MIN,
    });
  });
});

// C-042 — the rush is P1-4's fixture too, and it is the only one big enough to
// reach the ten-sample floor. Everything below reads the same twenty minutes
// of service the tests above do.
describe('the quote accuracy report (P1-4)', () => {
  it('grades every order the kitchen finished, and nothing it did not', async () => {
    const samples = await loadQuoteSamples(RUSH_ANCHOR);
    const reachedReady = await prisma.order.count({
      where: { events: { some: { toStatus: 'ready' } } },
    });

    // Placed by the real path, so every one of them carries a quote — the
    // count is the outcomes, not the promises.
    expect(samples).toHaveLength(reachedReady);
    expect(samples.length).toBeGreaterThan(20);
    for (const sample of samples) {
      expect(sample.quotedHighMinutes).toBeGreaterThan(sample.quotedLowMinutes);
      expect(sample.quotedOpenWeight).toBeGreaterThanOrEqual(0);
    }
  });

  it('sees the queue GROW across the rush, which is what makes the split mean anything', async () => {
    const samples = await loadQuoteSamples(RUSH_ANCHOR);
    const weights = samples.map((sample) => sample.quotedOpenWeight);

    // A rush that quoted every order against the same empty kitchen could not
    // tell a base error from a per-weight one, and this report would be
    // guessing. Thirty orders in twenty minutes do not.
    expect(Math.max(...weights)).toBeGreaterThan(Math.min(...weights) + 5);
  });

  it('clears the ten-order floor and says something actionable', async () => {
    const accuracy = estimateAccuracy(await loadQuoteSamples(RUSH_ANCHOR));

    expect(accuracy.all.samples).toBeGreaterThanOrEqual(10);
    expect(accuracy.all.early + accuracy.all.onTime + accuracy.all.late).toBe(
      accuracy.all.samples,
    );
    expect(accuracy.lightQueue.samples + accuracy.busyQueue.samples).toBe(accuracy.all.samples);

    // The simulated kitchen advances tickets on a script, not on a prep time,
    // so WHICH way it misses is a property of the script and not worth
    // asserting. That it reaches a verdict at all is the pipeline working end
    // to end: quote snapshotted at placement, outcome read off the event log,
    // and a named setting out the other side.
    if (accuracy.suggestion !== null) {
      expect(['prepBaseMinutes', 'prepPerWeightMinutes']).toContain(accuracy.suggestion.setting);
      expect(['up', 'down']).toContain(accuracy.suggestion.direction);
    }
  });
});

// Declared LAST on purpose: its `beforeAll` re-runs the rush, which truncates
// the database every test above reads. A describe added after this one would
// be looking at a different service.
describe('stopping the rush mid-service', () => {
  let midService: RushResult;

  beforeAll(async () => {
    midService = await runRush(RUSH_ANCHOR, 12);
  }, 180_000);

  it('leaves a queue with live cards on it, which the full run does not', async () => {
    const open = await prisma.order.findMany({ where: { status: { in: ['placed', 'accepted', 'preparing'] } } });
    expect(open.length).toBeGreaterThan(10);

    // Every queue status is represented, which is the point of the screenshot.
    const onQueue = await prisma.order.groupBy({ by: ['status'], _count: true });
    const statuses = onQueue.map((row) => row.status);
    expect(statuses).toEqual(expect.arrayContaining(['placed', 'accepted', 'preparing', 'ready']));
  });

  it('is a truncation, not a variant: nothing after minute 12 has happened', async () => {
    // Arrivals are exactly the customers due by minute 12.
    const expected = RUSH_ORDERS.filter((o) => o.minute <= 12 && !o.expectRefusal).length;
    expect(midService.attempts.filter((a) => a.outcome === 'placed')).toHaveLength(expected);

    // The pause (15) and the wrong-advance undo (13) are still in the future.
    expect(await prisma.orderEvent.count({ where: { kind: 'revert' } })).toBe(0);
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({ where: { id: 'singleton' } });
    expect(settings.ordersPaused).toBe(false);

    // The 86 (minute 8) and its cancel (minute 9) already have.
    const guac = await prisma.modifierOption.findUniqueOrThrow({ where: { id: 'guacamole' } });
    expect(guac.available).toBe(false);
    expect(await prisma.order.count({ where: { status: 'cancelled' } })).toBe(1);
  });

  it('runs an unfinished order\'s last span to the stop, not to the wall clock', async () => {
    expect(midService.untilMinute).toBe(12);
    expect(midService.end).toEqual(instantMinutesAfter(RUSH_ANCHOR, 12));

    // Ada Nkemelu: placed 0, accepted 1, preparing 3, ready 11 — and her
    // pickup at 14 has not happened. At the stop she has been on the shelf a
    // minute, and `ready` is the span still running.
    const ada = await orderFor('Ada Nkemelu');
    expect(ada.status).toBe('ready');
    expect(timeInState(await eventsFor('Ada Nkemelu'), midService.end)).toMatchObject({
      placed: 1 * MIN,
      accepted: 2 * MIN,
      preparing: 8 * MIN,
      ready: 1 * MIN,
      picked_up: 0,
    });

    // And the tally counts her as still in flight: nothing is booked as sold.
    const rows = timeInStateReport([await eventsFor('Ada Nkemelu')], midService.end);
    expect(rows.find((r) => r.status === 'picked_up')).toMatchObject({ orders: 0, averageMs: null });
  });
});

// PRD 3 P0-1 (C-063), and the assertion the 2026-09-01 decision was really
// about. The event stream is the truth about money; `Order.paymentState` is a
// DERIVED CACHE over it. A cache nobody checks is a second source of truth
// wearing a disguise, so this is the check — over a whole simulated service
// rather than over a fixture built to agree.
describe('the payment column is a cache of the payment events', () => {
  it('agrees with the stream for every order in the rush', async () => {
    const orders = await prisma.order.findMany({
      select: {
        seq: true,
        paymentState: true,
        events: { select: { kind: true, amountCents: true } },
      },
      orderBy: { seq: 'asc' },
    });

    // The rush mixes paid-at-checkout, pay-at-pickup and one cancelled prepaid
    // ticket that refunds, so this is not a set of rows that agree by being
    // identical — which is the only reason the assertion below means anything.
    //
    // Deliberately not asserted against `RUSH_ORDERS.length`: that counts
    // ATTEMPTS, and the double-submit is two attempts that must produce one
    // order. The order count has its own test above; what this one needs is
    // that every payment state is represented.
    expect(new Set(orders.map((order) => order.paymentState)).size).toBeGreaterThan(1);

    // Named disagreements, not a boolean: a failure here should say WHICH
    // order and which two answers, because "false is not true" would send
    // somebody back through thirty orders by hand.
    const disagreements = orders
      .map((order) => ({
        seq: order.seq,
        column: order.paymentState,
        derived: derivePaymentState(order.events),
      }))
      .filter((row) => row.column !== row.derived);
    expect(disagreements).toEqual([]);
  });

  it('gives every money event an amount and no other event one', async () => {
    // The database CHECK says this too. The test says it in the vocabulary of
    // the rush, so a future writer that adds a third money kind fails here
    // with a readable message rather than on a constraint name.
    const events = await prisma.orderEvent.findMany({ select: { kind: true, amountCents: true } });
    const money = events.filter((event) => event.kind === 'payment' || event.kind === 'refund');

    expect(money.length).toBeGreaterThan(0);
    expect(money.every((event) => typeof event.amountCents === 'number')).toBe(true);
    expect(
      events
        .filter((event) => event.kind !== 'payment' && event.kind !== 'refund')
        .every((event) => event.amountCents === null),
    ).toBe(true);
  });

  it('refunds exactly what it captured on the cancelled prepaid ticket', async () => {
    // The one order in the rush that goes all the way round: charged at
    // checkout, cancelled, refunded. Captured and refunded must be the same
    // number, or the balance P0-2 builds on this starts life wrong.
    const refunded = await prisma.order.findFirstOrThrow({
      where: { paymentState: 'refunded' },
      select: { totalCents: true, events: { select: { kind: true, amountCents: true } } },
    });

    const captured = refunded.events
      .filter((event) => event.kind === 'payment')
      .reduce((sum, event) => sum + (event.amountCents ?? 0), 0);
    const returned = refunded.events
      .filter((event) => event.kind === 'refund')
      .reduce((sum, event) => sum + (event.amountCents ?? 0), 0);

    expect(captured).toBe(refunded.totalCents);
    expect(returned).toBe(captured);
  });
});
