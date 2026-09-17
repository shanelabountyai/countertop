# Next

**C-134 shipped this session:** a per-batch menu-change event, closing PRD
4's last open item (its own builder Open Question: per-row vs per-batch —
resolved per-batch). **PRD 4 is now fully closed** — every P0/P1 shipped and
every Open Question resolved.

**What shipped:** `MenuChangeEvent`, a new append-only table (same trigger
shape as `OrderEvent`) — `at`, `available`, `actor`, an optional `staffId`
(always null today, no staff session exists to attribute a board tap to),
and `items`/`options` as `{id, name}` JSONB snapshots. `setAvailability`
became the ONLY writer of `MenuItem.available`/`ModifierOption.available` —
the two single-tap board actions now call it with a one-element array
instead of running their own `updateMany`, so a single tap logs the same way
a bulk sweep does. One event per call, none when a call flips nothing. A
"Recent changes" section on `/kitchen/availability` reads it back, most
recent batch first.

**The interesting part — a real regression, git-bisected and root-caused
before shipping:** the full e2e sweep failed `cart.spec.ts:65` consistently,
not the timeout-flavored flake it was previously filed under but a *stable
wrong value*. Stashing this session's `menu.ts`/`actions.ts` back to `HEAD`
and rerunning proved it clean 3/3 before this item and broken 3/3 after.
Server-side timestamps then caught the mechanism: `/menu`'s second render
read the option 4ms after the click and **1ms before the write committed** —
a race that has existed since the button was built (`fixtures.ts`'s own
header names four earlier instances of this exact defect class: "clicked a
server action, navigated before the write landed") and was only surviving on
a margin thin enough that the new write's slightly heavier transaction
tipped it over. Fixed the way the other four were: `eightySix(page, name)`,
previously a local unexported helper in `availability.spec.ts`, moved to
`fixtures.ts` and is now what `cart.spec.ts`'s two affected tests call
instead of an unguarded click. **`e2e/cart.spec.ts:65` and `:39` are no
longer on the flaky list — they were never flaky, they were this race, and
it is now closed, not just retried into passing.**

Full gate green: lint, typecheck, 1122 unit tests, production build, and 246
e2e specs (231 passed, 15 skipped, 0 failed, reconciled against `--list`'s
total). One migration, applied to both `countertop_test` and
`countertop_dev` via `npm run db:migrate:all` before the gate ran. CI green
on the second push — see "Read this before the next push" for what broke on
the first.

## Pick this up first

No single obvious next item on the master PRD — every PRD-scoped requirement
and Open Question is now resolved. Pick anything off "Still open" below, or
ask which one matters most. **By the Numbers has one item's worth of drift
since C-132** (this one) — not yet enough to be worth a dedicated recount
item on its own; fold it into whichever session's item pushes it to two or
three.

## Read this before the next push

- **A hand-written migration's index needs a matching `@@index` in
  `schema.prisma`, or CI's drift check fails** — caught this session, on the
  first push. `MenuChangeEvent_staffId_idx` existed in the migration SQL
  (copied from `OrderEvent`'s own `staffId` index pattern) but nothing in
  the schema declared it, so `prisma migrate diff --exit-code` (what CI's
  drift-check step runs) reported `[-] Removed index on columns (staffId)`
  and failed the gate. Fixed by adding `@@index([staffId])` to the model.
  **Run the drift check locally before pushing, not just `npm run
  db:migrate:all`** — migrating applies your own SQL and will never catch
  this, since the SQL is internally consistent; only a diff against
  `schema.prisma` catches the schema/migration mismatch:
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
  scratch — the snippet above is the one step, in seconds.)
- **A server action's click does not block on its own mutation.** A `<form
  action={...}>` submit returns control to the browser (and to Playwright's
  `.click()`) before the action's fetch necessarily completes — this is not
  a bug, it is how progressive enhancement works, and it means any spec that
  clicks a mutation and immediately does something depending on its effect
  elsewhere (a new `page.goto`, a different locator) is racing it. The
  margin can be milliseconds and can flip with an unrelated change to the
  write's own cost (this session: array-form → callback-form transaction).
  **The fix is never a faster write** — it is a guard on the CURRENT page
  confirming the write landed before doing anything else, the same pattern
  `addBurritoToCart`'s `toHaveURL` and `eightySix`'s button-label check both
  use. If a new spec needs to click something that mutates and then leave
  the page, check `fixtures.ts` for an existing guarded helper before
  writing a raw click — this is the fifth time this exact class of bug has
  been found (`fixtures.ts`'s own header names the first four).
- **`testlock`** (`~/.claude/bin/testlock`, outside this repo, not
  committed): built this session after the first e2e attempt came back with
  cascading timeouts traced to *other projects'* concurrent test sweeps on
  the same machine (11 connections on `countertop_test` mid-sweep while a
  sibling project ran its own full gate) — not this repo's code. A plain
  mutex, not `devslot`'s LRU-evict (killing a test sweep mid-run produces no
  result, unlike stopping an idle dev server). Wired into this repo's
  `test:e2e` script guarded the same way `swapcheck` is — a silent no-op
  anywhere it is not installed, CI included. It only protects sweeps that
  call it; it does not (yet) help unless a colliding project also adopts it.
- **`npm run gate` is a manual discipline** (C-125). Anything touching code
  needs the full gate run before push.
- **A new `OrderEventKind`/similar enum value needs its own migration
  file**, separate from any migration whose CHECK names it — Postgres
  refuses a new enum value used in the transaction that added it.
- **Run `npm run db:migrate:all` after adding a migration**, before running
  tests — a schema drift here reads as a wall of unrelated test failures,
  not a clear "missing column" error.
- **Before any e2e sweep, both kill lines** (C-128's incident):
  ```sh
  pkill -9 -f "$PWD.*playwright"
  pkill -9 -f 'node \(vitest'      # parens MUST be escaped
  lsof -ti :3400 | xargs -r kill -9
  ```
  **And check for OTHER projects' sweeps too** (new this session):
  `ps aux | grep -iE "vitest|playwright test"` and `sysctl -n
  kern.memorystatus_level` — a wall of unrelated timeout failures with
  memory below ~40% and other projects' processes in that list means
  contention, not a regression. Retry once it clears; `testlock` (above)
  only helps if the colliding project also calls it.
- **`npm run ci:local`** applies the whole migration history from nothing
  with the drift check — run it for any session that adds a migration, or
  use the shorter snippet above for just the drift check.
- **`npm run db:status` before `demo:rush`** if the last session added a
  migration.
- **Anything run outside `npm test`** gets no `DATABASE_URL`. Prefix with
  `npx dotenv -e .env.test -e .env.local --`.
- **Run `npm run db:generate`** if `typecheck` reports unknown Prisma
  columns.
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
  remaining pre-existing flaky specs; neither reproduced or investigated
  this session (different code paths). If either fails twice on an
  unrelated change, it's earned real investigation the same way `cart.
  spec.ts`'s pair just did.
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
- **No report line for a reversed refund** (C-133) — `report.ts` still
  reads `refundedCents` raw; a reversed refund is visible on the order's own
  receipt and invisible on the sales report until that line is written.
