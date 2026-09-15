# Next

**C-128 shipped this session**: the recount. `docs/WRITEUP.md`'s *By the
Numbers* had been a C-029 table wearing no date for seventy-eight items — 45
requirements, 418 unit tests, 119 e2e specs, a build window ending 2026-08-29.
It now reads 107 / 1,086 / 244 / through 2026-09-15 and **opens with the date
it was counted**, which is the actual fix: a dated number can be old, an
undated one is a claim. Gate green, five legs. No code, no migration.

## Pick this up first

Nothing is blocking. The shortlist is C-127's minus the numbers item:

1. **`writePrice`'s staged branch surfaces a raw `P2002`.** The delete-then-
   create is NOT unguarded — `StagedPrice` carries `@@unique([itemId,
   effectiveDay])` and `@@unique([optionId, effectiveDay])`, and the
   `staged_price_one_target` CHECK makes exactly one target column non-null per
   row, so each grain is covered and no duplicate row is constructible. What is
   missing is the other half of the discipline CLAUDE.md states for order
   numbers — *map the violation to a retry*: two managers re-staging the same
   row for the same day contend correctly and the loser gets an unmapped Prisma
   error instead of "latest wins". Smallest real item on the list.

2. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.

3. **`report.payment.refundedCents` still has no test over the rush** —
   C-126's item, twice deferred now. The reconciliation is narrated by the demo
   and asserted at the unit grain, not over the seeded service.

## What C-128 built

- **The table, recounted from the repo**, every figure derived by a command
  recorded in `docs/PROGRESS.md` so the next recount is a re-run: backlog ticks
  by grep, lines by `git ls-files | xargs wc -l`, unit tests from `npm test`,
  e2e from `playwright test --list`, constraints from `pg_constraint`.
- **The stamp, which is the actual deliverable.** *Counted at C-128,
  2026-09-15*, with one sentence on why the date is load-bearing. It converts
  the failure mode from *wrong* to *old* — the same category as every other gap
  in the document, and the one a reader can reason about.
- **Two rows that did not drift, and why**, which turned out to be the
  finding: the menu fixture and the rush's 30/20/5 are *specified* numbers that
  something actively defends, so C-124 and C-126 each fitted a new scenario
  *inside* the thirty. The rows that drifted were the rows nothing was holding.
- **Two neighbouring paragraphs scoped to their moment rather than rewritten**
  — "What the *first* twelve extra items were (written at C-029)", and "the
  eleven defects recorded *at that point*". The prose was good; it needed a
  date, the same fix as the table's.
- **A defect narrative in `docs/WRITEUP.md`** — the only thing in the repo that
  was wrong rather than absent.

## What C-128 leaves behind

- **Nothing recounts the table.** The stamp makes it honest, not current. A
  `docs:numbers` script emitting the table body is the upgrade path and was
  deliberately not built: a script that must itself be maintained, against a
  table touched once every seventy-eight items, is the more expensive of the
  two.
- **`By the Numbers` sits at line ~2337 of a 3,547-line file**, with eleven
  defect narratives appended *after* it. A summary table two-thirds of the way
  through a document is a structural oddity a portfolio reader meets before the
  material it summarises. Not moved — the ordering is the document's history.
- **No gate leg reads any of these numbers**, so nothing fails when they drift
  again. The honest reason the item existed at all.
- **One claim was caught in its own diff**: the rewritten ratio sentence first
  said the defect rate "has not moved much" across "eighty-nine items", from
  the wrong subtraction and a trend nobody had checked. It went *up* — 11
  defects across the first 29 items, 72 across 107, because the later items are
  mostly the project auditing itself. Corrected before commit, and recorded.

## The gate at C-128

All five legs, on the laptop, **on the second attempt** — see the incident
below.

- **1086 unit** in 45 files, unchanged (this item adds no code; running it
  anyway is what makes the table's figures the gate's own output rather than a
  previous session's log).
- **E2E 229 passed + 15 skipped = 244**, reconciling against `--list`'s 244,
  zero failures, 7.8m.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check and `ci:local` was not run.
- `demo:rush` not run — nothing in this item can reach it.

## The environment incident, and a hole it found in the pre-sweep recipe

**Read this before the next sweep.** The first gate attempt failed in clusters
across unrelated files — `retention` 6/17, `menu` 7/27, `remake` 15/15,
`payment` 13/13, `authorization` 8/15 — at 53s, 89s, 123s, 85s and 102s, with
the *same suite having passed 1086/1086 in 41s* twenty minutes earlier in the
same session.

- **Cause:** `kern.memorystatus_level` at **13%**, `swapcheck` refusing, three
  `JetsamEvent` reports from the minutes of the run. Five Playwright
  `test-server` processes were resident — one per live VS Code / Claude Code
  session, and `swapcheck` listed **four sessions across four projects**.
- **Not the pool:** `pg_stat_activity` showed 6 connections on
  `countertop_test`. Checked before reading a stack trace, and it cleared that
  hypothesis in one query.
- **THE HOLE, and the reason this section exists:** CLAUDE.md's pre-sweep kill
  is `pkill -9 -f "$PWD.*playwright"`, scoped to the project so two projects
  obeying the rule cannot kill each other. **Vitest workers set their process
  title to `node (vitest 8)` — no path at all** — so the `$PWD`-scoped pattern
  misses every one of them. Five orphans survived holding 265/222/191/21/21 MB,
  and memory only went 14% → 80% once they were reaped **by name**:

  ```sh
  pkill -9 -f 'node \(vitest'      # parens MUST be escaped
  ```

  The unescaped form fails with `Cannot compile regular expression …
  (parentheses not balanced)`, exits non-zero, and reaps nothing. It was
  written into PROGRESS unescaped first and corrected after being run.
- **`Killed: 9` in the log was mine**, from the pkill, and so was the gate's
  exit 137. The jetsam report timestamps settled it, not the message.

**If four Claude Code sessions are alive, close the ones you have walked away
from before starting a sweep.** That is the standing cause here, not anything
in this repo.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). CI runs it on every push
  to `main` and to `claude/**` and that is the backstop, but a red CI after the
  fact is worse than a red gate before it.
- **`npm run ci:local`** is still the only thing that applies the whole
  migration history from nothing with the drift check. Run it for any session
  that adds a migration.
- **`npm run db:status` before `demo:rush`** if the last session added a
  migration — `demo:rush` reads `.env.local` and that database drifts (C-127
  hit `P2022` on C-121's column).
- **A brand-new branch's FIRST push can skip CI**, documented in `ci.yml`
  rather than fixed: GitHub evaluates `paths-ignore` against the head commit
  alone, and every item's head commit is the docs-only "record the SHA" one. If
  a new branch shows no run, dispatch it manually.
- **There is no pre-push hook** (C-125). Old clones: `git config --unset
  core.hooksPath` once.

## Environment notes for whoever runs the gate next

**In a container, ten e2e specs fail and they PASS IN CI** — settled at C-125
by run 116 on a clean `ubuntu-latest` runner. `contact`, `last-call` ×2,
`menu-editing` ×2, `menu` ×3 and `refund` ×2 die with `Error: request for
'./menu/index' is from a module not been linked`, an ESM loader failure in the
fixtures using a late `await import('@countertop/db')`. Environmental — this
session's laptop run is a fifth independent confirmation.

**Postgres in a fresh container** is installed but down, and the cluster has no
`root` role:

```sh
pg_ctlcluster 16 main start
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE root LOGIN SUPERUSER PASSWORD 'ct'"
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE countertop_test OWNER root"
npm run db:migrate:test
```

`npm run ci:local` builds its own URL as `postgresql://$(whoami)@localhost/…`
with no password, so it additionally needs `host … 127.0.0.1/32 trust` in
`pg_hba.conf` and a reload.

**On the laptop**, `.env.test` points at `postgresql://shanelabounty@localhost`
and the cluster is already up; `npm run db:migrate:test` is the only setup.
**Run `npm run db:generate` if `typecheck` reports unknown Prisma columns.**

**Anything run outside `npm test`** gets no `DATABASE_URL` and the local guard
refuses with `points at "<unparseable>"`. Prefix with `npx dotenv -e .env.test
-e .env.local --`.

## Still open from C-118 → C-127

- **`NotificationKind` has one value** (C-121) — it exists because it is half
  the unique index's grain.
- **Nothing reads `queueReadyNotification`'s return value** (C-121). "We told
  them" and "we had already told them" are different facts; the boolean exists
  so the seam does.
- **Still no append-only trigger on `NotificationOutbox`** (the model's own
  `ponytail:`), and C-121's migration dedupe is exactly the kind of `DELETE`
  such a trigger would block.
- **Nothing in the rush redeems at the COUNTER.** Both redemptions are
  self-serve, so `redeemReward` and the staff receipt's reward button are
  demonstrated only by e2e.
- **No member in the rush has a balance that expires.**
  `expireInactiveBalances` has unit tests and no demo.
- **Five portfolio captures are content-stale and were deliberately not
  regenerated** — `05-kitchen-queue`, `06-kitchen-card`, `10-kitchen-viewport`,
  `07-report-midservice`, `11-report-after`. Regenerating in a container
  re-renders every font, verifiably: `12-staff-login.png`, a static page that
  cannot have changed, comes back 9007 → 7764 bytes. Run `SCREENSHOTS=1
  PORT=3400 npm run test:e2e -- screenshots.spec.ts` on the machine that
  produced their siblings. `15-loyalty.png` should be regenerated with them.
- **A customer who abandons a checkout and comes back verifies again** —
  C-116's binding working as designed; also a second SMS per order on a real
  carrier.
- **`Order.discountCents` has exactly one producer.** If a second appears,
  `settleRedemptionForOrder` assumes the discount and the `redeem` row are the
  same fact.
- **No deadlock is constructible on the member lock — an argument, not a test.**
- **`reward_terms_changed` has no test.** Reaching it needs the reward's cash
  value edited mid-placement and C-106 ships no control for that value.
- **Nothing bounds a staff `adjust` below zero.** Screen-level, pre-existing.
- **The sleeps in the member-lock test are 250ms.** If it flakes, raise them;
  do not delete the test.
- **A refund cannot be reversed at all** (C-127). A comp on the wrong ticket is
  taken back by `adjustment_reversed`; a refund sent to the wrong customer has
  no contradicting row and, since C-127, no longer surfaces as money to chase.

## Still open from earlier items

- **No per-batch menu-change event** — PRD 4's builder Open Question, still the
  only thing open in that document.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out."
- **No daypart editor**, no overnight daypart window, no schedule view for
  staged prices, and superseded staged rows are never collected.
- **A sixth customer route can forget the footer** — `/menu/[itemId]` is a
  customer screen and is in none of P0-1's five, P0-3's three, or P0-4's two.
- **The status page reads the contact columns twice** — once for the panel's
  `tel:` link, once inside the footer.
- **The status page's estimate line is outside the `role="status"` region**
  (C-078). One attribute, but a second live region is a decision about which
  one wins when both change on the same poll.
- **The last-call warning does not tick** (C-079) — `force-dynamic` renders
  with no poll, so twelve minutes on the page still reads "in 12 min".
- **`setLastOrderIn` cannot express the last `minutesOut` minutes of the local
  day** (C-079); it throws rather than clamping.
- **Twenty-two of twenty-five items have no description** (C-080) — the
  mechanism ships, the copy is a restaurant's job.
- **`e2e/refund.spec.ts:211`** and **`e2e/cart.spec.ts:65`** each failed once
  mid-sweep (8.0s and 6.6s, C-108 and C-113 era) and have passed every sweep
  since, including this one. Timeouts, not assertions.
- **Same-day only** for order-ahead (C-114) — multi-day is the master PRD's own
  catering/lead-time P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114) — no "nothing
  left today" copy.
- **No fixture pinned to an actual DST-transition date** (C-114) for
  `zonedTimeToInstant` — a `ponytail:` on the function names the gap.
- **Still no e2e drives a scheduled order PAST its slot** (C-123). The rush
  does it at the database and report grain; Playwright does not.
- **A void the provider refuses is chased by nothing** (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- **The staff receipt's payment line still reads "Pay at pickup" on a released
  hold**; only the customer's status page got the honest sentence.
- **A reversal cannot be pointed at a specific comp**, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
