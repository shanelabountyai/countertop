// The menu the e2e suite (and a local dev session) runs against.
//
// The specs assert real prices — "$10.95", "+$2.50 guac" — so they need the
// same menu the unit fixtures are hand-calculated against, not a second one
// written to agree with them. `npm test` truncates this database on its way
// through, which is why seeding is a `pretest:e2e` step rather than a thing
// you remember to run.
import { prisma } from './index';
import { resetDatabase, seedSampleMenu, seedSettings } from './testing/index';

async function main(): Promise<void> {
  await resetDatabase();
  await seedSampleMenu();
  await seedSettings();
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error: unknown) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
