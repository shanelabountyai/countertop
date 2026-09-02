// The retention job, runnable (PRD 6 P0-4, C-091). `npm run db:retention`.
//
// Narrates and nothing else — the sweep itself is `retention.ts` and is
// asserted by `retention.test.ts`, so the job and the test can never be
// running different code. Same split as `rush-demo.ts`.
//
// NOT SCHEDULED. This is a command a person runs, and `docs/RETENTION.md` is
// the procedure that says when and why. A cron is the obvious next step and is
// deliberately not this item's — a scheduled job that destroys data wants a
// secret, an endpoint and a way to see that it ran, which is a feature rather
// than a line of config.
import { sweepRetention } from './retention';
import { prisma } from './index';

async function main(): Promise<void> {
  const now = new Date();
  const { retentionDays, forgotten } = await sweepRetention(now);
  console.log(
    forgotten === 0
      ? `Retention window ${retentionDays} days. Nothing to forget.`
      : `Retention window ${retentionDays} days. Forgot the customer on ${forgotten} order${forgotten === 1 ? '' : 's'}.`,
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
