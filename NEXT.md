# Next

**C-126 shipped this session**: a refund, end to end, in the seeded rush — and
the run found a money defect on its first print. That defect is the next item.

## Pick this up first: the refund that reads as a debt

**A deliberately refunded order lands on the sales report's "still owed" chase
list for exactly the refunded amount — and because `canCollectPayment` reads
the same figure, the staff receipt offers to collect it from the customer who
was just refunded.**

Reproduce in one command: `npm run demo:rush`, and read the Sales block.

```
  $312.30 collected, $155.43 still owed on 9 orders
  $4.95 sent back to customers
```

Nine, where the rush has **eight** pay-at-counter tickets. The ninth is Gia
Moretti — prepaid, collected, refunded $4.95 at minute 22.

The line is `orderBalance` in `packages/core/orders/payment.ts`:

```ts
outstandingCents: Math.max(
  0,
  order.totalCents - collectedCents - adjustedCents - authorizedCents,
)
```

`collectedCents` is *captured minus refunded*, so a refund raises the
outstanding balance by construction.

**It is a decision, not a patch, and that is why C-126 did not do it.** The
question is whether refunded money is a debt the customer owes or a closed
fact — and three readers act on the answer:

1. `salesReport`'s `payment.outstanding` (the chase list, and `unpaidRate`)
2. `canCollectPayment` → the counter's collect control on the staff receipt
3. `report.payment.collectedCents`, which is already correct either way

`report.ts`'s own comment argues for the current behaviour at the REPORT grain
("the customer has the food and we hold nothing"), and that argument does not
obviously extend to putting a Collect button on the screen. Read it before
deciding; it may be that the report bucket is right and only
`canCollectPayment` is wrong, which would be the smaller fix.

**Pre-existing since C-071**, invisible until something refunded a picked-up
ticket. `docs/WRITEUP.md` → *The bucket that was "structurally empty" until it
wasn't* has the full account.

## What C-126 built

- **A `refund` variant on `KitchenStep`** in `packages/db/rush.ts`, drained by
  the loop that already schedules staff actions minute by minute. The decline
  is a PROVIDER handed to `requestRefund`, not a flag inside it.
- **Gia Moretti** (minute 4, prepaid, collected 18): $15.05 captured, **$4.95
  back at minute 22**, succeeds. Partial on purpose — it leaves `paymentState`
  at `paid`, which is `derivePaymentState`'s lossy case in the demo.
- **Vik Ramsay** (minute 14, prepaid, collected 28): **$14.88 asked for at
  minute 31 and declined** by the processor. Left failing — a successful retry
  would empty the exceptions list before minute 50 and the demo would end
  looking like the one before it.
- **Two Sales lines** in `rush-demo.ts`, gated like the rewards line, so a run
  stopped before minute 22 narrates neither.
- **Four assertions** added inside `a card held at checkout, taken or let go`,
  which already re-runs the full rush — no second 20-minute run.
- **Two existing assertions scoped rather than weakened**: "no refund anywhere
  in the service" became "neither RELEASED hold refunded anything", and
  `refund_requested` is excluded from both sides of the money-amount test
  because the database CHECK leaves that one kind's amount nullable on purpose.

## What C-126 leaves behind

- **Nothing retries the failed refund.** The retry button exists and
  `refund.test.ts` exercises it; the rush deliberately does not press it.
- **Neither refunding customer has a phone**, so neither refund puts a row in
  the P1-3 outbox. "Your refund is on its way" is not a message this product
  sends at all.
- **`report.payment.refundedCents` has no test over the rush** — the two orders
  are asserted at the event grain; the report bucket is only narrated.
- **The amounts are hand-calculated literals** (1505/495 and 1488) against the
  sample menu. A reprice makes `refund` throw naming the customer, which is
  loud and correct, but it is a coupling worth knowing about.

## The gate at C-126

`lint` / `typecheck` / `test` / `build:test` / `test:e2e`, all five run.

- **1082 unit** (+2 over C-125's 1080 — exactly the tests added), 45 files.
- **E2E 229 passed + 15 skipped = 244**, reconciling against `--list`'s total,
  with **zero failures** — this session ran on the laptop rather than in a
  container, so the ten documented container failures did not appear at all.
  That is a third independent confirmation (after CI run 116) that those ten
  are environmental.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check was needed and `ci:local` was not run.
- **`npm run demo:rush` run both full and `--until 12`.** Do this — it is how
  the defect above was found, and the truncated run is what proves the two new
  Sales lines stay silent before minute 22.

## Other unblocked items — nothing is blocking

Same menu as last session, minus the refund one just taken.

1. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.
2. **`writePrice`'s staged branch surfaces a raw `P2002`.** The delete-then-
   create is NOT unguarded — `StagedPrice` carries `@@unique([itemId,
   effectiveDay])` and `@@unique([optionId, effectiveDay])`, and the
   `staged_price_one_target` CHECK makes exactly one target column non-null per
   row, so each grain really is covered and no duplicate row is constructible.
   What is missing is the other half of the discipline CLAUDE.md states for
   order numbers — "map the violation to a retry": two managers re-staging the
   same row for the same day contend correctly and the loser gets an unmapped
   Prisma error instead of "latest wins". Smaller than the backlog implied,
   and real.
3. **`docs/WRITEUP.md`'s "By the Numbers" table is stale.** It says 45
   requirements, 418 unit tests, 119 e2e specs and a build window ending
   2026-08-29. Current: 105 ticked backlog entries (latest C-126), 1082 unit
   tests in 45 files, 244 e2e specs in 25 files. Its "30 orders / 5 ugly cases"
   row is still accurate. A single pass with the current numbers, or a decision
   to delete the table rather than keep lying in it.

**If you would rather clear the older debt**, the C-069/C-071 list at the
bottom of this file is still accurate — though C-126 has now taken the first
line off it, since the rush does exercise the refund path.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). Nothing runs it for you
  locally any more. CI runs it on every push to `main` and to `claude/**`, and
  that is the backstop — but a red CI after the fact is worse than a red gate
  before it, so run it.
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
fixtures that use a late `await import('@countertop/db')`. Environmental, not
code.

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
**Run `npm run db:generate` if `typecheck` reports unknown Prisma columns** —
C-121's `NotificationOutbox.kind` will surface as four phantom type errors
against a stale generated client.

**Note for anything run outside `npm test`:** vitest and `tsx` invoked directly
get no `DATABASE_URL` and the local guard refuses with `points at
"<unparseable>"`. Prefix with `npx dotenv -e .env.test -e .env.local --`.

**There is no pre-push hook** (C-125), and `postinstall` no longer sets
`core.hooksPath`. If you have an old clone, `git config --unset
core.hooksPath` once.

## Still open from C-118 → C-121

- **`NotificationKind` has one value** (C-121). It exists because it is half
  the unique index's grain, not because anything writes a second. A second
  kind — a delay apology, a closing-soon nudge — is a product decision nobody
  has made.
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
  sweep since. A timeout, not an assertion. Local `retries` is 0, CI's is 1.
- **`e2e/cart.spec.ts:65`** ("the header cart count drops a line that gets
  86'd out from under it") failed once at 6.6s mid-sweep during C-113's gate
  run and passed 3/3 in isolation immediately after. Same shape as the refund
  flake above.
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
