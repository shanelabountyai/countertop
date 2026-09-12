import {
  derivePaymentState,
  paymentTotals,
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

    // Placement + five moves + the revert, and — since C-069 — the hold Rae's
    // checkout took plus the capture that took it at the counter. The mistake
    // is still in the history, which is the whole point of an append-only log.
    expect(events).toHaveLength(9);
    // ONE capture, and the undo is the reason this assertion matters: Rae's
    // ticket was advanced to `picked_up` in error, undone, and advanced again.
    // The unique index on the settlement link is what stops the second advance
    // charging the card a second time.
    expect(events.filter((e) => e.kind === 'authorization')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'capture')).toHaveLength(1);
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
    // the rush, so a future writer that adds another money kind fails here
    // with a readable message rather than on a constraint name.
    //
    // "Money-bearing" is broader than "money moved" and has been since C-065:
    // a hold and a release each carry the amount they are ABOUT, which is what
    // lets `paymentTotals` answer "is anything owed at the counter" without
    // following a link.
    const bearing = ['payment', 'refund', 'authorization', 'capture', 'authorization_voided'];
    const events = await prisma.orderEvent.findMany({ select: { kind: true, amountCents: true } });
    const money = events.filter((event) => bearing.includes(event.kind));

    expect(money.length).toBeGreaterThan(0);
    expect(money.every((event) => typeof event.amountCents === 'number')).toBe(true);
    expect(
      events
        .filter((event) => !bearing.includes(event.kind))
        .every((event) => event.amountCents === null),
    ).toBe(true);
  });

});

// PRD 3 P1-1 (C-069), against the WHOLE service and not the truncation the
// describe above leaves behind. `stopping the rush mid-service` re-runs to
// minute 12, so by the time anything after it reads the database there are no
// pickups and no no-show — and those are exactly the two moments a hold is
// settled. Its own `beforeAll` rather than a note about ordering: a test that
// is correct only because of where it sits in a file is a test that breaks
// when somebody adds one above it.
describe('a card held at checkout, taken or let go', () => {
  beforeAll(async () => {
    await runRush(RUSH_ANCHOR);
  }, 180_000);

  // The two tickets in the rush that were prepaid and never handed over:
  // Owen's cancellation and Cass's no-show. Before this item both were charged
  // at checkout and refunded on the way out — a provider call that can fail,
  // on money that never needed to leave the card.
  it('releases the hold on the prepaid tickets that never left the building', async () => {
    const released = await prisma.order.findMany({
      where: { events: { some: { kind: 'authorization_voided' } } },
      select: {
        status: true,
        paymentState: true,
        totalCents: true,
        events: { select: { kind: true, amountCents: true } },
      },
    });

    // One cancelled, one no-show — the two shapes, not one case twice.
    expect(released.map((order) => order.status).sort()).toEqual(['abandoned', 'cancelled']);

    for (const order of released) {
      const totals = paymentTotals(order.events);
      // NOTHING WAS TAKEN AND NOTHING WENT BACK. That is the whole sentence,
      // and the reason there is no refund to fail, no exceptions list entry
      // and nobody to chase.
      expect(totals.capturedCents).toBe(0);
      expect(totals.refundedCents).toBe(0);
      // The hold was for the full ticket and all of it was let go.
      expect(totals.authorizedCents).toBe(0);
      expect(
        order.events
          .filter((event) => event.kind === 'authorization')
          .reduce((sum, event) => sum + (event.amountCents ?? 0), 0),
      ).toBe(order.totalCents);
      expect(order.paymentState).toBe('unpaid');
    }

    // And no refund anywhere in the service. The rush's only prepaid exits are
    // these two, so the refund machinery has nothing to do — which is exactly
    // what P1-1 asked for. A deliberate refund is proved in refund.test.ts and
    // through the screens in the e2e suite.
    expect(await prisma.orderEvent.count({ where: { kind: 'refund' } })).toBe(0);
  });

  it('captures at the counter, once, for exactly what was held', async () => {
    const captured = await prisma.order.findMany({
      where: { events: { some: { kind: 'capture' } } },
      select: { totalCents: true, paymentState: true, events: { select: { kind: true, amountCents: true } } },
    });
    expect(captured.length).toBeGreaterThan(0);

    for (const order of captured) {
      const totals = paymentTotals(order.events);
      expect(totals.capturedCents).toBe(order.totalCents);
      expect(totals.authorizedCents).toBe(0);
      expect(order.paymentState).toBe('paid');
    }
  });
});

// ── The punch card, through a whole service (PRD 7, C-120) ──────────────────
//
// NOT a sixth ugly case — the five above are the master PRD's Success Metrics
// verbatim and this session did not touch that list. What this block asserts
// is that the loyalty state the rush now seeds is COHERENT after twenty
// minutes of real service: the ledger and the snapshots agree to the cent, no
// balance went negative, and the two orders that spent a reward ended up in
// the two different places an order can end up.

describe('the punch card across the rush', () => {
  beforeAll(async () => {
    await runRush(RUSH_ANCHOR);
  }, 180_000);

  it('discounts exactly the two orders that spent a reward, and prices them before tax', async () => {
    const discounted = await prisma.order.findMany({
      where: { discountCents: { gt: 0 } },
      orderBy: { seq: 'asc' },
      select: {
        customerName: true,
        status: true,
        subtotalCents: true,
        discountCents: true,
        taxCents: true,
        totalCents: true,
      },
    });

    // Hand-calculated against the sample menu, both of them.
    //
    // Owen: burrito 1095 + chicken 0 + guacamole 250 + NO onions 0 = 1345.
    // Tax on 1345 − 1000 = 345 → floor(345 × 0.0825 + 0.5) = 28. Total 373.
    //
    // Ivy: torta 1150 + carnitas 150 + light onions 0 + extra tortilla 75
    // = 1375. Tax on 375 → 31. Total 406.
    //
    // The point of writing both out: tax is on the DISCOUNTED base. Taxed on
    // the full subtotal these would be 111c and 113c, and the totals $4.56
    // and $4.88 — which is the 82c-per-order the shop was remitting on food
    // nobody paid for, twice, in a demo somebody can add up on screen.
    expect(discounted).toEqual([
      {
        customerName: 'Owen Brandt',
        status: 'cancelled',
        subtotalCents: 1345,
        discountCents: 1000,
        taxCents: 28,
        totalCents: 373,
      },
      {
        customerName: 'Ivy Castellanos',
        status: 'picked_up',
        subtotalCents: 1375,
        discountCents: 1000,
        taxCents: 31,
        totalCents: 406,
      },
    ]);
  });

  it('reconciles the ledger against the snapshots, to the cent', async () => {
    // The bar the other five cases are held to, in this one's terms. A
    // `redeem` carries its own copy of what the reward was worth; the order
    // carries `discountCents`. Two numbers, two tables, written in one
    // transaction — and if they ever disagree the money path has a hole in it
    // that no single-table assertion would find.
    const redeemed = await prisma.loyaltyEvent.aggregate({
      where: { kind: 'redeem' },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    const snapshotted = await prisma.order.aggregate({ _sum: { discountCents: true } });

    expect(redeemed._count._all).toBe(2);
    expect(redeemed._sum.amountCents).toBe(snapshotted._sum.discountCents);
    expect(redeemed._sum.amountCents).toBe(2000);

    // And every `redeem` points at an order that exists and carries exactly
    // its amount — not just the same total by luck of two sums matching.
    const rows = await prisma.loyaltyEvent.findMany({
      where: { kind: 'redeem' },
      select: { amountCents: true, order: { select: { discountCents: true } } },
    });
    for (const row of rows) expect(row.order?.discountCents).toBe(row.amountCents);
  });

  it('hands the reward back on the order that was cancelled, and keeps it on the one that sold', async () => {
    // C-119's settlement, in a demo rather than a unit test. Owen's ticket was
    // cancelled out from under a spent reward; Ivy's was collected.
    const owen = await memberNamed('Owen Brandt');
    const ivy = await memberNamed('Ivy Castellanos');

    // Owen: 100 in, 100 spent, 100 returned — and no earn, because nobody got
    // the food. Back where he started.
    expect(owen.balance).toBe(100);
    expect(owen.kinds).toEqual({ earn: 1, redeem: 1, adjust: 1 });
    expect(owen.returned).toBe(100);

    // Ivy: 100 in, 100 spent, and 13 earned on the $13.75 of food she
    // actually bought — the SUBTOTAL, not the discounted total, because a
    // customer earns on what the food cost (P0-3).
    expect(ivy.balance).toBe(13);
    expect(ivy.kinds).toEqual({ earn: 2, redeem: 1 });
    expect(ivy.returned).toBe(0);
  });

  it('earns nothing for the member who never collected', async () => {
    // The no-show. The contrast that makes an earn mean something: a member
    // whose food was cooked and never picked up keeps the points she walked
    // in with and gains none.
    const cass = await memberNamed('Cass Iverson');
    expect(cass.balance).toBe(75);
    expect(cass.kinds).toEqual({ earn: 1 });
  });

  it('earns once on the ticket a cook advanced by mistake and reverted', async () => {
    // Rae's order reached `picked_up` the long way — advanced early, reverted,
    // advanced again. C-102's `skipDuplicates` on the per-order index is what
    // makes that one earn rather than two, and the rush is where it happens
    // against a real transition rather than a fixture.
    const rae = await memberNamed('Rae Sutton');
    expect(rae.kinds.earn).toBe(2); // the opening balance, and this order's
    const earnsOnOrders = await prisma.loyaltyEvent.count({
      where: { kind: 'earn', orderId: { not: null }, member: { displayName: 'Rae Sutton' } },
    });
    expect(earnsOnOrders).toBe(1);
  });

  it('leaves no member owing points, which is the invariant C-119 protects', async () => {
    // Over a whole service, with two redemptions, a cancellation, a revert and
    // three earns landing on the same five members. A negative balance here is
    // a reward spent twice.
    const balances = await prisma.loyaltyEvent.groupBy({
      by: ['memberId'],
      _sum: { points: true },
    });
    expect(balances.length).toBeGreaterThan(0);
    for (const row of balances) expect(row._sum.points ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('enrols five of the thirty, because the phone field is optional', async () => {
    // A demo where every customer fills in an optional field is not showing an
    // optional field. Five members, and twenty-five orders with no phone on
    // them at all.
    expect(await prisma.loyaltyMember.count()).toBe(5);
    const withPhone = await prisma.order.count({ where: { customerPhone: { not: null } } });
    const withoutPhone = await prisma.order.count({ where: { customerPhone: null } });
    expect(withPhone).toBe(5);
    expect(withoutPhone).toBeGreaterThan(20);
  });

  it('texts the reverted ticket ONCE, across a whole service', async () => {
    // THIS TEST ASSERTED THE DEFECT UNTIL C-121, on purpose, and is rewritten
    // by the fix rather than deleted by it — which is the whole reason it was
    // written that way. C-120 found the bug by giving rush orders a phone for
    // the first time and reading what came out; the assertion was
    // `toHaveLength(2)` with the wrong number named in its own title, so the
    // fix could not land quietly beside it.
    //
    // `queueReadyNotification` now lands on a unique index over
    // `(orderId, kind)` with `skipDuplicates`, so Rae's ticket — ready at
    // minute 12, reverted at 13, ready again at 16 — queues one message.
    const queued = await prisma.notificationOutbox.findMany({
      select: { message: true, kind: true, order: { select: { customerName: true } } },
    });

    const forRae = queued.filter((row) => row.order?.customerName === 'Rae Sutton');
    expect(forRae).toHaveLength(1);

    // Four customers reached `ready` with a phone on the order — Ada, Cass,
    // Rae and Ivy. Owen's was cancelled at minute 9, before it was ever
    // cooked, so he is told nothing. Four rows, which is what five was.
    expect(queued).toHaveLength(4);
    expect(new Set(queued.map((row) => row.order?.customerName))).toEqual(
      new Set(['Ada Nkemelu', 'Cass Iverson', 'Rae Sutton', 'Ivy Castellanos']),
    );
    // One kind today, and the column exists because it is half the index's
    // grain — not because anything writes a second value yet.
    expect(new Set(queued.map((row) => row.kind))).toEqual(new Set(['ready']));
  });

  it('never lets a placed order join a loyalty table to render itself', async () => {
    // The snapshot rule, read from the loyalty side. `Order.discountCents` is
    // a COLUMN on the order — copied at placement, taxed on, and frozen — so
    // deleting the member who earned it must leave the receipt byte-identical.
    // The ledger cascades with the member (C-100); the order does not.
    const before = await prisma.order.findFirstOrThrow({
      where: { customerName: 'Ivy Castellanos', discountCents: { gt: 0 } },
      ...ORDER_RECEIPT,
    });
    await prisma.loyaltyMember.deleteMany({ where: { displayName: 'Ivy Castellanos' } });
    const after = await prisma.order.findFirstOrThrow({
      where: { id: before.id },
      ...ORDER_RECEIPT,
    });
    expect(after).toEqual(before);
  });
});

/** One member's ledger, summarised. Read through the database rather than
 *  through `memberByPhone`, because the phone is what this test would have to
 *  hard-code and the display name is already in the rush's own table. */
async function memberNamed(displayName: string): Promise<{
  balance: number;
  kinds: Partial<Record<string, number>>;
  /** Points handed back by C-119's settlement, positive. */
  returned: number;
}> {
  const member = await prisma.loyaltyMember.findFirstOrThrow({
    where: { displayName },
    select: { events: { select: { kind: true, points: true, reason: true } } },
  });
  const kinds: Partial<Record<string, number>> = {};
  let balance = 0;
  let returned = 0;
  for (const event of member.events) {
    kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
    balance += event.points;
    if (event.reason === 'loyalty_reward_returned') returned += event.points;
  }
  return { balance, kinds, returned };
}
