# Next

**C-133 shipped this session:** a refund and a comp can each be pointed at,
and taken back, by name. Closes two backlog "Left behind" notes: C-071's ("a
reversal cannot be pointed at a specific comp") and C-127's ("nothing can
reverse a refund").

**What shipped:** `refund_reversed`, a new event kind whose own migration
(`ALTER TYPE ... ADD VALUE`, split from the migration that uses it, same as
`adjustment_reversed`'s was) is followed by a second migration adding two
self-link columns — `refundReversalOfId` (new, so its CHECK is a full
equivalence) and `adjustmentReversalOfId` (retrofitted onto `adjustment_reversed`,
so its CHECK is one-directional, leaving pre-C-071 rows null). A refund
reversal is full-only, derives its amount from the refund it names, and
writes no provider call — it is a flag, not automated money recovery. A comp
reversal is now bounded by ITS OWN comp's remaining amount
(`targetRemainingCents`) rather than the order's aggregate `adjustedCents`,
which is the actual fix for the C-071 gap. `paymentTotals` gained
`refundReversedCents`, added into `outstandingCents` only —
`refundedCents` stays raw on purpose, so a reversed refund shows as both
"sent" and "owed again" rather than one erasing the other (a fourth
documented exception to the three-bucket revenue invariant, alongside the
comp and hold terms). UI: "Reverse a refund" (new) mirrors "Put an
adjustment back" — both auto-select their target when there is only one.

**The interesting part:** the receipt's "Still owed" line was gated on
`adjustedCents > 0`, which meant a reversed refund (no comp involved at all)
reopened `outstandingCents` with nothing on the screen to show it moved.
Found by actually running the new e2e test in a browser before calling this
done, not by a type error or a unit test — fixed by gating the line on
`adjustedCents > 0 || refundReversedCents > 0` instead
(`apps/web/app/kitchen/orders/[id]/page.tsx`).

Full gate green this session: lint, typecheck, 1115 unit tests, production
build, and 245 e2e specs (230 passed, 15 skipped — the screenshot suite,
unchanged — 0 failed, reconciled against `--list`'s total). Two new
migrations, applied to both `countertop_test` and `countertop_dev` via
`npm run db:migrate:all` before the gate ran.

## Pick this up first

Both items C-132's NEXT.md flagged as "actual decisions" are now resolved:
the refund-reversal item shipped this session as C-133. One is left:

1. **No per-batch menu-change event** — the only thing still open in PRD 4
   itself, as opposed to a backlog "left behind" note.

Otherwise there is no single obvious next item — pick anything off "Still
open" below, or ask which one matters most.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). Anything touching code
  needs the full gate run before push — this session ran lint, typecheck,
  `npm test`, `build:test` and `test:e2e` individually rather than the
  combined `npm run gate` script, which is equivalent but let each stage's
  output be inspected on its own.
- **A new `OrderEventKind` value needs its own migration file**, separate
  from any migration whose CHECK names it — Postgres refuses a new enum
  value used in the transaction that added it. `adjustment_reversed`'s
  migration (C-071) documents this; C-133's `refund_reversed` follows the
  same split.
- **Run `npm run db:migrate:all` after adding a migration**, before running
  tests — a schema drift here reads as a wall of unrelated test failures
  (every db-level test file failed this session until the migration was
  applied), not a clear "missing column" error.
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
- **Never run `prettier --write` in this repo** — there is no `.prettierrc`
  and no Prettier dependency, so its defaults (double quotes, its own
  wrapping) fight this codebase's actual style (single quotes, hand-tuned
  comment wrapping) and reformat far more of a file than intended. Caught
  this session before it was committed; `git checkout --` the file and
  reapply the real edit if it happens again.

## Still open (carried forward, closes two items from C-132's list)

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
- **`e2e/refund.spec.ts:211`, `e2e/cart.spec.ts:65`, `e2e/cart.spec.ts:39`,
  `e2e/last-call.spec.ts:17`** — each has failed once on an unrelated change
  and passed every rerun since (`:39` new this session, same class as `:65`
  in the same file — a "Guacamole is sold out" assertion timing out, not
  failing). Timeouts, not assertions. If any fails twice on an unrelated
  change, it's earned real investigation.
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
