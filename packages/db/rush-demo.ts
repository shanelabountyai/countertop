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
import { runRush, RUSH_END_MINUTE } from './rush';

const MIN = 60_000;
const minutes = (ms: number): string => `${(ms / MIN).toFixed(1)} min`;
const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/**
 * An hour ago, so the whole rush and its 45-minute tail land just behind the
 * present and the report's one-day window has something in it. The TEST pins a
 * fixed anchor instead (`RUSH_ANCHOR`) — a demo wants to be today, an
 * assertion wants to be the same day forever.
 *
 */
const anchorAnHourAgo = (): Date => instantMinutesAfter(new Date(), -60);

async function main(): Promise<void> {
  const anchor = anchorAnHourAgo();
  const rush = await runRush(anchor);
  const { timezone } = await loadSettings();

  const placed = rush.attempts.filter((a) => a.outcome === 'placed');
  const refused = rush.attempts.filter((a) => a.outcome === 'refused');
  const seqs = placed.map((a) => a.seq!).sort((a, b) => a - b);

  console.log(`\nCountertop — seeded rush`);
  console.log(`${placed.length} orders placed in 20 minutes, worked to minute ${RUSH_END_MINUTE}.`);
  console.log(`Order numbers #${seqs[0]}–#${seqs.at(-1)}, ${new Set(seqs).size} distinct.\n`);

  console.log('The ugly cases');
  console.log(
    `  86 mid-rush     guacamole off at minute 8; ${refused.filter((a) => a.errors.includes('option_unavailable')).length} cart refused at the option grain, replaced a minute later`,
  );
  console.log('  wrong advance   Rae Sutton marked ready at 12, reverted at 13 — a logged event, not a delete');
  console.log('  no-show         Cass Iverson ready at 7, closed out as abandoned at 40');
  console.log('  double submit   Theo Marsh submitted twice; one order, same answer both times');
  console.log(
    `  paused          ${refused.filter((a) => a.errors.includes('ordering_closed')).length} arrivals bounced between minute 15 and 18; 1 came back`,
  );

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
  for (const item of report.topItems.slice(0, 3)) {
    console.log(`  top: ${item.itemName} ×${item.quantity} — ${money(item.revenueCents)}`);
  }

  console.log('\nOpen /kitchen/report to see the same numbers on the screen.\n');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
