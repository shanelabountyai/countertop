# Next

**C-132 shipped this session:** `docs/WRITEUP.md`'s By the Numbers table,
recounted for the first time since C-128. Every figure re-derived the same
way C-128 recorded doing it (`docs/PROGRESS.md`'s C-132 entry has the exact
commands), so this was a re-run, not a re-derivation.

**The interesting part:** the menu-fixture row ("7 modifier groups") wasn't
drift — it was a miscount that predates C-128 itself. `SAMPLE_MENU` has
carried 8 since C-017; the 8th group (`tortilla-style`) is quoted for its
hyphen and doesn't match the plain-identifier shape a manual scan or naive
grep expects, so both the C-017 prose and the C-128 recount skipped it the
same way. Corrected in the table, in the "specified numbers don't drift"
paragraph, and logged as the 73rd Defects Found entry.

Full new figures: 111 requirements, 273 commits through C-131, 46,535
TS/TSX lines (21,295 tests, 46%), 1,092 unit tests in 45 files, 244 e2e in
25 files (unchanged), 34 migrations / 2 triggers / 48 CHECKs / 19 tables
(unchanged), ~16,150 doc lines, 73 defects, 2026-08-25 → 2026-09-16.

Docs-only — no code, no migration, no gate run (CI's `paths-ignore` skips
`**/*.md` and `docs/**` the same way it skips a "record the SHA" commit).

## Pick this up first

NEXT.md's shortlist after C-131 (portfolio screenshots, this recount) is now
fully closed, and `docs/backlog.md` has no unchecked items. There is no
single obvious next item — pick anything off "Still open" below, or ask
which one matters most. Two that stand out as actual decisions rather than
busywork:

1. **A refund cannot be reversed at all** (C-127's own left-behind item) —
   needs a decision on what a wrongly-sent refund's contradicting row should
   look like, not just a patch.
2. **No per-batch menu-change event** — the only thing still open in PRD 4
   itself, as opposed to a backlog "left behind" note.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). A docs-only push skips
  CI by design (`paths-ignore`); anything touching code still needs the full
  gate run before push, same as always.
- **This session's `npx vitest run` (bypassing `npm test`) ran unusually
  slow** — still running past 15 minutes for a suite that normally finishes
  in well under a minute. `pg_stat_activity` showed `rental_test` holding 35
  connections mid-run, well over its own 10-connection convention cap — an
  environmental symptom (`docs/conventions.md` → *Cap the connection pool per
  project*), not a countertop regression. If a future session sees the same
  thing, check `pg_stat_activity` before suspecting the code.
- **Before any e2e sweep, both kill lines** (C-128's incident, confirmed
  again at C-131):
  ```sh
  pkill -9 -f "$PWD.*playwright"
  pkill -9 -f 'node \(vitest'      # parens MUST be escaped
  lsof -ti :3400 | xargs -r kill -9
  ```
- **`npm run ci:local`** is the only thing that applies the whole migration
  history from nothing with the drift check — run it for any session that
  adds a migration.
- **`npm run db:status` before `demo:rush`** if the last session added a
  migration.
- **A brand-new branch's FIRST push can skip CI** (documented in `ci.yml`,
  not fixed). Pushing to `main` directly, as this project does, doesn't hit
  it.
- **Anything run outside `npm test`** gets no `DATABASE_URL`. Prefix with
  `npx dotenv -e .env.test -e .env.local --`.
- **Run `npm run db:generate`** if `typecheck` reports unknown Prisma
  columns.

## Still open (carried forward, unchanged by C-132)

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
- **A refund cannot be reversed at all** (C-127) — see "Pick this up first."
- **`MAX_STAGE_ATTEMPTS` exhausted still throws a raw `P2002`** (C-129,
  deliberate).
- **The staged-price retry is not observable** (C-129) — no collision log.
- **The `PhoneVerification` sweep is not observable** (C-130).
- **No per-batch menu-change event** — see "Pick this up first."
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
- **`e2e/refund.spec.ts:211`, `e2e/cart.spec.ts:65`, `e2e/last-call.spec.ts:17`**
  — each has failed once on an unrelated change and passed every rerun since.
  Timeouts, not assertions. If any fails twice on an unrelated change, it's
  earned real investigation.
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
- **A reversal cannot be pointed at a specific comp**, and `refund_failed`
  rows accumulate uncapped on a stuck provider.
