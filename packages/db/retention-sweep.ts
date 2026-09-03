// The retention job, runnable (PRD 6 P0-4 and PRD 7 P0-5; C-091, C-105).
// `npm run db:retention`.
//
// Narrates and nothing else — the sweeps themselves are `retention.ts` and
// `loyalty.ts` and are asserted by their own tests, so the job and the tests
// can never be running different code. Same split as `rush-demo.ts`.
//
// TWO WINDOWS, ONE COMMAND. `retentionDays` bounds how long a customer's
// identity is kept; `loyaltyExpiryDays` bounds how long an unused balance
// lives, and a CHECK holds the second inside the first. They are different
// policies and there is no reason to make a person remember two commands.
//
// RETENTION RUNS FIRST, and only the counts depend on it: a member past the
// retention window is deleted here, so the expiry pass below does not write an
// `expire` row against a member that no longer exists to hold it. Correct
// either way — the CHECK means an expired balance always precedes a deleted
// member — but the two numbers printed are then disjoint, and a number a
// person has to reconcile is a number they stop reading.
//
// NOT SCHEDULED. This is a command a person runs, and `docs/RETENTION.md` is
// the procedure that says when and why. A cron is the obvious next step and is
// deliberately not this item's — a scheduled job that destroys data wants a
// secret, an endpoint and a way to see that it ran, which is a feature rather
// than a line of config.
import { expireInactiveBalances } from './loyalty';
import { sweepRetention } from './retention';
import { prisma } from './index';

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

async function main(): Promise<void> {
  const now = new Date();

  const { retentionDays, forgotten, members } = await sweepRetention(now);
  console.log(
    forgotten === 0
      ? `Retention window ${retentionDays} days. Nothing to forget.`
      : `Retention window ${retentionDays} days. Forgot the customer on ${plural(forgotten, 'order')}.`,
  );
  if (members > 0) {
    console.log(`Deleted ${plural(members, 'loyalty member')} — the ledger went with them.`);
  }

  const expiry = await expireInactiveBalances(now);
  console.log(
    expiry.members === 0
      ? `Expiry window ${expiry.expiryDays} days. No balance to expire.`
      : `Expiry window ${expiry.expiryDays} days. Expired ${plural(expiry.points, 'point')} across ${plural(expiry.members, 'member')}.`,
  );

  console.log('Order numbers, money, lines and events are untouched — no report moved.');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
