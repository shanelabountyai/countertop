// The capstone demo (C-017). `npm run demo:rush`.
//
// Runs the seeded rush against whichever database the environment points at,
// then prints what happened. The rush itself lives in `rush.ts` and is
// asserted by `rush.test.ts` — this file only narrates, so the demo and the
// test can never be showing different runs.
//
// Afterwards: `npm run dev` and open /kitchen/report. The queue is deliberately
// EMPTY when it finishes — every one of the thirty orders reached a terminal
// state, which is the headline result, not a missing screen.
import {
  instantMinutesAfter,
  salesReport,
  serviceTimes,
  timeInStateReport,
} from '@countertop/core';
import { prisma } from './index';
import { loadLoyaltyProgram } from './loyalty';
import { loadSettings } from './menu';
import { loadReportOrders, loadStatusTimelines } from './report';
import {
  EIGHTY_SIX_MINUTE,
  PAUSE_MINUTE,
  RESUME_MINUTE,
  RUSH_END_MINUTE,
  runRush,
} from './rush';

const MIN = 60_000;
const minutes = (ms: number): string => `${(ms / MIN).toFixed(1)} min`;
const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * Anchored so the run ENDS NOW.
 *
 * Minute `until` of the rush is the present moment, which is the only anchor
 * that makes a stopped run look like a service in progress: cards aged 0–12
 * minutes, the no-show five minutes on the shelf, the estimate meaning
 * something. The first version of this anchored a flat hour back, so
 * `--until 12` left every ticket 48 minutes old and every aging flag lit — a
 * queue that looked like a disaster rather than a lunch rush.
 *
 * A full run ends now too, which puts it inside the report's one-day window.
 *
 * The TEST pins a fixed anchor instead (`RUSH_ANCHOR`): a demo wants to be
 * today, an assertion wants to be the same day forever.
 */
const anchorSoItEndsNow = (until: number): Date => instantMinutesAfter(new Date(), -until);

/**
 * `--until N` stops the rush at minute N, which is how you get a kitchen queue
 * with live cards on it. Anything else is the full run.
 */
function untilMinuteFromArgv(): number {
  const flag = process.argv.indexOf('--until');
  if (flag === -1) return RUSH_END_MINUTE;
  const minute = Number(process.argv[flag + 1]);
  if (!Number.isInteger(minute) || minute < 0) {
    throw new Error('--until takes a whole number of minutes, e.g. --until 12');
  }
  return minute;
}

async function main(): Promise<void> {
  const until = untilMinuteFromArgv();
  const anchor = anchorSoItEndsNow(until);
  const rush = await runRush(anchor, until);
  const { timezone } = await loadSettings();

  const placed = rush.attempts.filter((a) => a.outcome === 'placed');
  const refused = rush.attempts.filter((a) => a.outcome === 'refused');
  const seqs = placed.map((a) => a.seq!).sort((a, b) => a - b);

  const stopped = until < RUSH_END_MINUTE;
  console.log(`\nCountertop — seeded rush`);
  console.log(
    stopped
      ? `Stopped at minute ${until}, mid-service: ${placed.length} orders in so far.`
      : `${placed.length} orders placed in 20 minutes, worked to minute ${RUSH_END_MINUTE}.`,
  );
  console.log(`Order numbers #${seqs[0]}–#${seqs.at(-1)}, ${new Set(seqs).size} distinct.\n`);

  // Only the ugly cases that have actually happened yet. A demo that claims a
  // no-show at minute 12 is a demo nobody checks twice.
  const stranded = refused.filter((a) => a.errors.includes('option_unavailable')).length;
  const bounced = refused.filter((a) => a.errors.includes('ordering_closed')).length;
  console.log('The ugly cases');
  if (until >= EIGHTY_SIX_MINUTE) {
    console.log(
      `  86 mid-rush     guacamole off at minute ${EIGHTY_SIX_MINUTE}; ${stranded} cart refused at the option grain` +
        (until >= 10 ? ', replaced a minute later' : ', its owner has not come back yet'),
    );
  }
  if (until >= 13) {
    console.log('  wrong advance   Rae Sutton marked ready at 12, reverted at 13 — a logged event, not a delete');
  }
  console.log(
    until >= 40
      ? '  no-show         Cass Iverson ready at 7, closed out as abandoned at 40'
      : `  no-show         Cass Iverson has been ready since minute 7 — ${Math.max(0, until - 7)} min on the shelf`,
  );
  if (until >= 14) {
    console.log('  double submit   Theo Marsh submitted twice; one order, same answer both times');
  }
  // The refund (C-126), staged like the others: the ask at 24, the retry at
  // 28, and the honest in-between state if the clock stops there. The
  // in-between IS the case — a refund that failed and is sitting on somebody's
  // list is the thing this line exists to show.
  if (until >= 24) {
    console.log(
      until >= 28
        ? '  refund          Kira Lindqvist $4.25 back at 24 — declined by the processor, retried off the exceptions list at 28'
        : '  refund          Kira Lindqvist $4.25 refused by the processor at 24 — on the exceptions list, not yet sent',
    );
  }
  if (until >= PAUSE_MINUTE) {
    console.log(
      `  paused          ${bounced} arrivals bounced` +
        (until >= RESUME_MINUTE
          ? ` between minute ${PAUSE_MINUTE} and ${RESUME_MINUTE}; ${bounced > 2 ? 1 : 0} came back`
          : '; the door is still shut'),
    );
  }

  // Order ahead (P1-2, C-124). Deliberately NOT filed under "the ugly cases"
  // above: these two are ordinary customers who asked for a time, and a demo
  // that listed them among the failures would be teaching the wrong thing.
  // Read from the same `serviceTimes` the report screen reads, so the
  // narration and the screen cannot come out different.
  const booked = await prisma.order.count({ where: { requestedFor: { not: null } } });
  if (booked > 0) {
    const service = serviceTimes(await loadStatusTimelines(anchor));
    console.log('\nOrdered ahead');
    console.log(
      `  ${plural(booked, 'order')} booked a pickup time instead of a range` +
        (service.scheduled === 0
          ? ', and none is out of the kitchen yet'
          : `; ${service.scheduledLate} of ${service.scheduled} missed its slot`),
    );
  }

  console.log('\nWhere they ended up');
  for (const [status, count] of Object.entries(rush.finalStatuses)) {
    console.log(`  ${status.padEnd(12)} ${count}`);
  }

  const orders = await prisma.order.findMany({ select: { id: true } });
  const logs = await Promise.all(
    orders.map((order) =>
      prisma.orderEvent.findMany({
        where: { orderId: order.id },
        select: { at: true, toStatus: true },
      }),
    ),
  );

  console.log('\nTime in state');
  for (const row of timeInStateReport(logs, rush.end)) {
    if (row.orders === 0) continue;
    const average = row.averageMs === null ? '—' : minutes(row.averageMs);
    console.log(
      `  ${row.status.padEnd(12)} ${plural(row.orders, 'order').padStart(9)}   ` +
        `total ${minutes(row.totalMs).padStart(9)}   average ${average}`,
    );
  }

  const report = salesReport(await loadReportOrders(anchor), timezone);
  const day = report.days[0];
  console.log('\nSales');
  console.log(
    `  ${plural(day?.orders ?? 0, 'order')} sold, ${plural(day?.items ?? 0, 'item')}, ${money(day?.totalCents ?? 0)} including tax`,
  );
  console.log(
    `  no-show rate ${report.noShow.rate === null ? '—' : `${Math.round(report.noShow.rate * 100)}%`} ` +
      `(${report.noShow.noShow} of ${report.noShow.sold + report.noShow.noShow} finished)`,
  );
  // What of that revenue actually came in (C-051). The rush hands over
  // pay-at-pickup orders, so this line is never decorative.
  if (report.payment.outstandingCents > 0) {
    console.log(
      `  ${money(report.payment.collectedCents)} collected, ` +
        `${money(report.payment.outstandingCents)} still owed on ` +
        `${plural(report.payment.outstanding.length, 'order')}`,
    );
  }
  // Money sent back on purpose (C-126). Printed whenever there is any, like
  // the rewards line below — a shop that refunded nothing should read the
  // summary it read before.
  if (report.payment.refundedCents > 0) {
    console.log(`  ${money(report.payment.refundedCents)} refunded to customers`);
    // AND SAY WHERE THAT MONEY WENT, because the "still owed" line above now
    // contains it and a reader would otherwise have to work that out (C-126).
    //
    // This is INTENDED, and pre-specified: `orderBalance` models a refund as
    // the payment coming back, so a customer who has the food and whose money
    // has been returned owes it again. `report.test.ts`'s "keeps a refund in
    // its own bucket" case wrote this answer down before any refund could
    // reach a picked-up order, precisely for the day one could — which is
    // today, because of this rush.
    //
    // It is still worth printing, because the case it was written for was a
    // refund that REVERSES a payment, and Kira's is a goodwill refund for a
    // cold tamale. The shop does not want that $4.25 back. Same mechanism, two
    // business meanings, and the report can only tell one of them. That is a
    // product decision rather than an arithmetic error, so the demo states it
    // and NEXT.md carries it.
    console.log(
      '    ↳ and counted in "still owed" above — a refund is modelled as the payment ' +
        'coming back, so she owes it again. Intended; arguably wrong for a goodwill ' +
        'refund. See NEXT.md.',
    );
  }
  // Counted, never booked. A midday report that did not say this would look
  // like a restaurant that sold nothing (C-016).
  if (report.inFlight > 0) {
    console.log(`  ${plural(report.inFlight, 'order')} still in flight, not booked`);
  }
  // What the punch card cost, from the SAME `SalesTotals` the screen reads
  // (C-118's fourth money column). Printed only when a reward was actually
  // spent, the same rule the tile on `/kitchen/report` follows — a shop with
  // no loyalty program should read the summary it read before PRD 7.
  if (report.totals.discountCents > 0) {
    console.log(
      `  ${money(report.totals.discountCents)} of punch-card rewards, off the food before tax`,
    );
  }
  for (const item of report.topItems.slice(0, 3)) {
    console.log(`  top: ${item.itemName} ×${item.quantity} — ${money(item.revenueCents)}`);
  }

  // The program itself (C-120). Loyalty is deliberately absent from the sales
  // report's own query path — PRD 7 P0-6 makes that a requirement, and a
  // static check enforces it — so this is a second read, of the screen that
  // owns the question.
  const loyalty = await loadLoyaltyProgram(anchor);
  if (loyalty.enabled) {
    console.log('\nPunch card');
    console.log(
      `  ${plural(loyalty.members, 'member')}, ` +
        `${loyalty.liability.points} points outstanding — ` +
        `${money(loyalty.liability.redeemableCents)} of that spendable tomorrow`,
    );
    console.log(
      `  ${plural(loyalty.window.redemptions, 'reward')} spent today, ` +
        `${money(loyalty.window.redeemedCents)} off — ` +
        `${loyalty.window.pointsEarned} points earned back`,
    );
    // THE TWO FIGURES ABOVE DO NOT MATCH ON PURPOSE, and a demo that left a
    // viewer to notice that on their own would look like a bug. The ledger
    // counts every reward that was spent; Sales counts only orders that SOLD,
    // so a reward spent on an order that was later cancelled is in one and
    // not the other. C-119's settlement is why the points are not simply
    // gone — they went back to the customer who never got the food.
    if (loyalty.window.redeemedCents !== report.totals.discountCents) {
      console.log(
        `  of that, ${money(report.totals.discountCents)} came off food that was actually sold — ` +
          `${loyalty.window.pointsReturned} points went back to a customer whose order was cancelled`,
      );
    }
  }

  console.log(
    stopped
      ? '\nOpen /kitchen — the queue is live, mid-service.\n'
      : '\nOpen /kitchen/report to see the same numbers on the screen, and /kitchen/loyalty for the punch card.\n',
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
