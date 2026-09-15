# Next

**C-127 shipped this session** (`a1e1f74`): a refund is a closed fact, not a
debt. `orderBalance.outstandingCents` subtracts `capturedCents` where it
subtracted `collectedCents`, and the report's three buckets reconcile for the
first time since C-071. Gate green, five legs, nothing outstanding.

## Pick this up first

Nothing is blocking, and the shortlist is the same one C-126 left minus the
refund item. In recommended order:

1. **`docs/WRITEUP.md`'s "By the Numbers" table is stale**, and it is the only
   thing in the repo that is *wrong* rather than merely absent. It says 45
   requirements, 418 unit tests, 119 e2e specs and a build window ending
   2026-08-29. Current: **106 ticked backlog entries** (latest C-127), **1086
   unit tests in 45 files**, **244 e2e specs in 25 files**, window through
   2026-09-15. Its "30 orders / 5 ugly cases" row is still accurate. One pass
   with the current numbers, or a decision to delete the table rather than keep
   lying in it. Smallest item on the list and the one a portfolio reader hits.

2. **`writePrice`'s staged branch surfaces a raw `P2002`.** The delete-then-
   create is NOT unguarded — `StagedPrice` carries `@@unique([itemId,
   effectiveDay])` and `@@unique([optionId, effectiveDay])`, and the
   `staged_price_one_target` CHECK makes exactly one target column non-null per
   row, so each grain is covered and no duplicate row is constructible. What is
   missing is the other half of the discipline CLAUDE.md states for order
   numbers — *map the violation to a retry*: two managers re-staging the same
   row for the same day contend correctly and the loser gets an unmapped Prisma
   error instead of "latest wins". Smaller than the backlog implied, and real.

3. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.

## What C-127 built

- **One word in `orderBalance`** — `order.totalCents - capturedCents -
  adjustedCents - authorizedCents`. `collectedCents` is *captured minus
  refunded*, so reading it there meant a refund raised the debt by
  construction.
- **Both readers close from that one line.** The C-069 precedent applied a
  second time: the hold was subtracted in `orderBalance` rather than checked on
  three screens, precisely so `canCollectPayment` would go dark structurally.
- **The report's conservation test now sums all three buckets.** C-064's
  version summed `collected + outstanding` and passed for five items *because
  of* the double count — a refunded ticket put 0 in `collected` and its whole
  total in `outstanding`, so two buckets hit revenue exactly.
- **Two seam tests in `payment.test.ts`** asserting `orderBalance` and
  `canCollectPayment` together, plus a partial-refund report test beside an
  unpaid pickup, so the fix cannot be read as "refunds forgive tickets".
- **Comments updated in both engines** — `payment.ts` names the one-word
  difference, `report.ts` records that its own three-bucket claim was false
  between C-071 and C-127.

## What C-127 leaves behind

- **Nothing can reverse a refund.** A comp on the wrong ticket is taken back by
  `adjustment_reversed`; a refund sent to the wrong customer has no
  contradicting row, and under C-127 it no longer even surfaces as money to
  chase. The honest cost of the decision, and a smaller hole than the Collect
  button was.
- **One case moved that nobody chose**, asserted with its reasoning rather than
  left to be found: a refund exceeding its capture (a data error) used to read
  as the whole ticket owed and now reads as the part nothing was captured for.
- **`report.payment.refundedCents` still has no test over the rush** — C-126's
  item, untouched. The reconciliation is narrated by the demo and asserted at
  the unit grain, not over the seeded service.

## The gate at C-127

All five legs run, on the laptop.

- **1086 unit** (+4 over C-126's 1082 — the two seam tests and two report
  tests), 45 files.
- **E2E 229 passed + 15 skipped = 244**, reconciling against `--list`'s total,
  **zero failures**, 4.6m. Laptop rather than container, so the ten documented
  container failures did not appear — a fourth independent confirmation that
  those ten are environmental.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check and `ci:local` was not run.
- **`npm run demo:rush` run full and `--until 12`.** The full run prints the
  fix; the truncated one proves the two refund Sales lines stay silent before
  minute 22.

## One environment note this session added

**`demo:rush` reads `.env.local`, and the local dev database drifts.** It failed
with `P2022: the column kind does not exist` before it ran — C-121's
`NotificationOutbox.kind` migration had never been applied to `countertop_dev`.
`npm run db:migrate:dev` fixed it in one command. This is `db:status` doing the
job it exists for, not a defect, and worth knowing because the demo is the only
thing in the gate that touches that database: **run `npm run db:status` before
`demo:rush` if the last session added a migration.**

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). Nothing runs it for you
  locally. CI runs it on every push to `main` and to `claude/**`, and that is
  the backstop — but a red CI after the fact is worse than a red gate before
  it, so run it.
- **`npm run ci:local` is still the only thing that applies the whole migration
  history from nothing** with the drift check. Run it for any session that adds
  a migration.
- **A brand-new branch's FIRST push can skip CI**, documented in `ci.yml`
  rather than fixed: GitHub evaluates `paths-ignore` against the head commit
  alone on a new branch, and every backlog item's head commit is the docs-only
  "record the SHA" one. If a new branch shows no run, dispatch it manually
  rather than assuming the trigger is broken.

## Environment notes for whoever runs the gate next

**In a container, ten e2e specs fail and they PASS IN CI** — settled at C-125
by run 116 on a clean `ubuntu-latest` runner. `contact`, `last-call` ×2,
`menu-editing` ×2, `menu` ×3 and `refund` ×2 die with `Error: request for
'./menu/index' is from a module not been linked`, an ESM loader failure in the
fixtures that use a late `await import('@countertop/db')`. Environmental.

**Postgres in a fresh container** is installed but down, and the cluster has no
`root` role:

```sh
pg_ctlcluster 16 main start
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE root LOGIN SUPERUSER PASSWORD 'ct'"
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE countertop_test OWNER root"
npm run db:migrate:test
```

`npm run ci:local` is different — it builds its own URL as
`postgresql://$(whoami)@localhost/...` with no password, so it additionally
needs `host … 127.0.0.1/32 trust` in `pg_hba.conf` and a reload.

**On the laptop**, `.env.test` points at `postgresql://shanelabounty@localhost`
and the cluster is already up; `npm run db:migrate:test` is the only setup.
**Run `npm run db:generate` if `typecheck` reports unknown Prisma columns.**

**Note for anything run outside `npm test`:** vitest and `tsx` invoked directly
get no `DATABASE_URL` and the local guard refuses with `points at
"<unparseable>"`. Prefix with `npx dotenv -e .env.test -e .env.local --`.

**There is no pre-push hook** (C-125), and `postinstall` no longer sets
`core.hooksPath`. If you have an old clone, `git config --unset
core.hooksPath` once.

## Still open from C-118 → C-121

- **`NotificationKind` has one value** (C-121). It exists because it is half
  the unique index's grain, not because anything writes a second.
- **Nothing reads `queueReadyNotification`'s return value** (C-121). "We told
  them" and "we had already told them" are different facts; the boolean is
  returned rather than discarded so the seam exists the day a caller wants it.
- **Still no append-only trigger on `NotificationOutbox`** (the model's own
  `ponytail:`) — and C-121's migration dedupe is exactly the kind of `DELETE`
  such a trigger would block.
- **Nothing in the rush redeems at the COUNTER.** Both its redemptions are
  self-serve, so `redeemReward` and the staff receipt's reward button are
  demonstrated only by the e2e suite.
- **No member in the rush has a balance that expires.**
  `expireInactiveBalances` has unit tests and no demo.
- **Five portfolio captures are content-stale and were deliberately not
  regenerated** — `05-kitchen-queue`, `06-kitchen-card`,
  `10-kitchen-viewport`, `07-report-midservice`, `11-report-after`.
  Regenerating in a container re-renders every font, verifiably:
  `12-staff-login.png`, a static page that cannot have changed, comes back
  9007 → 7764 bytes. Run `SCREENSHOTS=1 PORT=3400 npm run test:e2e --
  screenshots.spec.ts` on the machine that produced their siblings.
  `15-loyalty.png` is committed and should be regenerated with the rest.
- **A customer who abandons a checkout and comes back verifies again.**
  C-116's binding working as designed; also a second SMS per order on a real
  carrier.
- **`Order.discountCents` has exactly one producer.** If a second appears,
  `settleRedemptionForOrder` assumes the discount and the `redeem` row are the
  same fact.
- **No deadlock is constructible on the member lock — an argument, not a
  test.**
- **`reward_terms_changed` has no test.** Reaching it needs the reward's cash
  value edited mid-placement and C-106 ships no control for that value.
- **Nothing bounds a staff `adjust` below zero.** Screen-level, pre-existing.
- **The sleeps in the member-lock test are 250ms.** If it flakes, raise them;
  do not delete the test.

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
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since, including this one. A timeout, not an assertion.
- **`e2e/cart.spec.ts:65`** ("the header cart count drops a line that gets
  86'd out from under it") failed once at 6.6s mid-sweep during C-113's gate
  run. Same shape; passed this sweep.
- **Same-day only** for order-ahead (C-114) — multi-day is the master PRD's own
  catering/lead-time P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114) — no
  "nothing left today" copy.
- **No fixture pinned to an actual DST-transition date** (C-114) for
  `zonedTimeToInstant` — a `ponytail:` comment on the function names the gap.
- **Still no e2e drives a scheduled order PAST its slot** (C-123). The rush
  does it at the database and report grain; Playwright does not, because
  waiting out a real slot is not something it expresses cheaply.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
- **A refund cannot be reversed at all** (C-127, new to this list).
