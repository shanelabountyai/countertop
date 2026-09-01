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
import { instantMinutesAfter, salesReport, timeInStateReport } from '@countertop/core';
import { prisma } from './index';
import { loadSettings } from './menu';
import { loadReportOrders } from './report';
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
  if (until >= PAUSE_MINUTE) {
    console.log(
      `  paused          ${bounced} arrivals bounced` +
        (until >= RESUME_MINUTE
          ? ` between minute ${PAUSE_MINUTE} and ${RESUME_MINUTE}; ${bounced > 2 ? 1 : 0} came back`
          : '; the door is still shut'),
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
  // Counted, never booked. A midday report that did not say this would look
  // like a restaurant that sold nothing (C-016).
  if (report.inFlight > 0) {
    console.log(`  ${plural(report.inFlight, 'order')} still in flight, not booked`);
  }
  for (const item of report.topItems.slice(0, 3)) {
    console.log(`  top: ${item.itemName} ×${item.quantity} — ${money(item.revenueCents)}`);
  }

  console.log(
    stopped
      ? '\nOpen /kitchen — the queue is live, mid-service.\n'
      : '\nOpen /kitchen/report to see the same numbers on the screen.\n',
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
