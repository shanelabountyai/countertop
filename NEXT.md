# Next

**C-135 shipped this session:** the sales report now has its own figure for a
reversed refund — closes the item C-133 left open and NEXT.md carried for two
sessions running (named at the bottom of C-134's own "Still open" list).

**What shipped:** `PaymentSplit.refundReversedCents` in
`packages/core/orders/report.ts`, summed from `paymentTotals` the same way
`refundedCents` already is, and a fourth stat tile on `/kitchen/report`
(`Collected` / `Outstanding` / `Refunded` / `Refund reversed`), shown only
when non-zero. Not a new bucket in the `collected + outstanding + refunded =
revenue` invariant — the money was already counted correctly by `orderBalance`
since C-133; this only gives the report its own name for it, so an operator
seeing an order back on the chase list after its receipt says "refunded" has
an answer at the report grain instead of having to open that one order's
event log.

**Gate:** all five legs green, first attempt. 1123 unit tests (+1), lint,
typecheck, production build, and 246 e2e specs (231 passed, 15 skipped, 0
failed, reconciled against `--list`'s total, 7.7m). No migration this
session, so no drift check and `ci:local` was not run.

**Not yet pushed** — this file, `docs/PROGRESS.md` and `docs/RELEASE_NOTES.md`
are staged for the commit; do that next, then the SHA-record follow-up
commit, then one push, then watch CI.

## Pick this up first

No single obvious next item — everything below is equally weighted. Ask
which one matters most, or pick by size: **staff-adjust floor** (a real
correctness gap, small) and **`reward_terms_changed` test** (coverage gap, no
runtime bug) are both quick; the daypart editor is the only multi-session item
on the list.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). Anything touching code
  needs the full gate run before push.
- **Before any e2e sweep, both kill lines** (C-128's incident):
  ```sh
  pkill -9 -f "$PWD.*playwright"
  pkill -9 -f 'node \(vitest'      # parens MUST be escaped
  lsof -ti :3400 | xargs -r kill -9
  ```
  **And check for OTHER projects' sweeps too**: `ps aux | grep -iE
  "vitest|playwright test"` and `sysctl -n kern.memorystatus_level` — a wall
  of unrelated timeout failures with memory below ~40% and other projects'
  processes in that list means contention, not a regression.
- **`npm run test:e2e` already wires in `testlock`**
  (`~/.claude/bin/testlock`, outside this repo) via the root `package.json`
  script — do not prefix it yourself (`npx testlock ...` fails: it is a local
  script, not an npm package). It is a silent no-op anywhere it is not
  installed, CI included.
- **A hand-written migration's index needs a matching `@@index` in
  `schema.prisma`, or CI's drift check fails** (C-134's incident). Run the
  drift check locally before pushing when a session adds a migration:
  ```sh
  createdb countertop_ci_shadow
  npx dotenv -e .env.test -- npx prisma migrate diff \
    --from-migrations packages/db/prisma/migrations \
    --to-schema-datamodel packages/db/prisma/schema.prisma \
    --shadow-database-url "postgresql://$(whoami)@localhost:5432/countertop_ci_shadow" \
    --exit-code
  dropdb countertop_ci_shadow
  ```
  (`npm run ci:local` also catches this, but runs the whole gate from
  scratch.)
- **A server action's click does not block on its own mutation.** If a new
  spec clicks something that mutates and then leaves the page, check
  `fixtures.ts` for an existing guarded helper (`addBurritoToCart`,
  `eightySix`) before writing a raw click — this class of bug has been found
  and fixed five times now.
- **A new `OrderEventKind`/similar enum value needs its own migration file**,
  separate from any migration whose CHECK names it.
- **Run `npm run db:migrate:all` after adding a migration**, before running
  tests.
- **`npm run db:status` before `demo:rush`** if the last session added a
  migration.
- **Anything run outside `npm test`** gets no `DATABASE_URL`. Prefix with
  `npx dotenv -e .env.test -e .env.local --`.
- **Run `npm run db:generate`** if `typecheck` reports unknown Prisma columns.
- **Never run `prettier --write` in this repo** — no `.prettierrc`, no
  Prettier dependency; its defaults fight this codebase's actual style.

## Still open

- **`NotificationKind` has one value** (C-121) — half the unique index's
  grain.
- **Nothing reads `queueReadyNotification`'s return value** (C-121).
- **No append-only trigger on `NotificationOutbox`** (the model's own
  `ponytail:`).
- **Nothing in the rush redeems at the COUNTER** — both redemptions are
  self-serve.
- **No member in the rush has a balance that expires** —
  `expireInactiveBalances` has unit tests, no demo.
- **A customer who abandons a checkout and comes back verifies again** —
  working as designed, and a second real SMS.
- **`Order.discountCents` has exactly one producer** — a second would break
  `settleRedemptionForOrder`'s assumption.
- **No deadlock is constructible on the member lock** — an argument, not a
  test.
- **`reward_terms_changed` has no test** — needs a mid-placement cash-value
  edit and no control ships for that.
- **Nothing bounds a staff `adjust` below zero.**
- **The sleeps in the member-lock test are 250ms** — raise them if either
  flakes; do not delete the test.
- **`MAX_STAGE_ATTEMPTS` exhausted still throws a raw `P2002`** (C-129,
  deliberate).
- **The staged-price retry is not observable** (C-129) — no collision log.
- **The `PhoneVerification` sweep is not observable** (C-130).
- **`done=off` survives a page reload.**
- **No daypart editor, no overnight daypart window, no schedule view for
  staged prices**, and superseded staged rows are never collected.
- **A sixth customer route can forget the footer** — `/menu/[itemId]`.
- **The status page reads the contact columns twice.**
- **The status page's estimate line is outside the `role="status"` region**
  (C-078).
- **The last-call warning does not tick** (C-079).
- **`setLastOrderIn` cannot express the last `minutesOut` minutes of the
  local day** (C-079) — throws rather than clamping.
- **Twenty-two of twenty-five items have no description** (C-080).
- **`e2e/refund.spec.ts:211` and `e2e/last-call.spec.ts:17`** — the two
  remaining pre-existing flaky specs; neither reproduced or investigated this
  session (different code paths). If either fails twice on an unrelated
  change, it's earned real investigation the same way `cart.spec.ts`'s pair
  already got.
- **Same-day only for order-ahead** (C-114) — multi-day is a master-PRD P2
  item.
- **A fully-booked day degrades silently to ASAP-only** (C-114).
- **No fixture pinned to an actual DST-transition date** (C-114) —
  `ponytail:` on `zonedTimeToInstant`.
- **No e2e drives a scheduled order PAST its slot** (C-123) — the rush does
  it at the database/report grain only.
- **A void the provider refuses is chased by nothing** (`ponytail:` in
  `settleAuthorization`).
- **The staff receipt's payment line still reads "Pay at pickup" on a
  released hold.**
- **`refund_failed` rows accumulate uncapped on a stuck provider.**
- **No seeded/rush scenario produces a `refund_reversed` event** (new, C-135)
  — the new report tile has never been seen live. Verification this session
  was a unit test plus loading `/kitchen/report` under real auth to confirm
  the conditional JSX doesn't crash the route; the dev database had no orders
  in the default window, so the tile itself has never actually rendered
  against real data.
