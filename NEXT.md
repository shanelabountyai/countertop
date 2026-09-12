# Next

**C-123 shipped this session**: the queue's running-late flag, and the pickup
time it never knew about. C-114 gave an order a `requestedFor`; `queueAging`
computed every flag as a duration from something the ORDER did, so a scheduled
ticket reddened fifteen minutes after PLACEMENT.

**A probe before any change printed worse than the backlog described.**
`overdue` was not "early sometimes" — it was `true` from 12:15 onward,
**forever**, so a scheduled order genuinely late at 17:10 and one sitting
correctly at 12:20 were the same colour. The flag carried no information about
a scheduled ticket at all. The probe also printed two things nobody had filed:
food bagged twenty minutes BEFORE its slot scored `noShowLevel: 2` (the card's
*other* red branch — the flag was wrong by both of its paths), and the report
counted every scheduled order as having run late at 295 minutes, top of the
slowest-five, pushing the genuinely slow tickets off a list of five.

Built as `isPastDue(order, at, thresholds)` — one sentence, two readers,
differing only in WHEN they ask: the card at `now`, the report at the instant
the food reached `ready`. The ASAP branch is `isOverdue` verbatim and the whole
pre-P1-2 behaviour. The no-show clock starts at the LATER of ready and the
promised minute. `serviceTimes` splits its sample. No migration.

**Three things worth carrying forward, all in `docs/WRITEUP.md`'s C-123 entry:**

- **The comment paid for itself, one item after a comment cost more than it was
  worth.** C-122's `ponytail:` described its own defect backwards.
  `isOverdue`'s comment — "two readers … the same sentence about the same
  minutes" — was *correct*, and following it rather than skimming it is the
  only reason the report was fixed in the same session. The report's version
  was the worse one: the card's red gets distrusted, a report's number gets
  used. **The lesson is not "trust comments" or "distrust comments" — it is
  that a comment naming a blast radius is a lead to follow to the other
  surface, and then to verify.**
- **A screen was asserting the invariant in English.** `report/page.tsx` says
  to the operator: *"Ran late" is the same 15-minute mark the card turns red
  at.* Fixing the card alone would not have left a latent inconsistency — it
  would have made a sentence **rendered on the screen** false on the day it
  shipped. Worth grepping user-facing copy for claims about behaviour before
  changing that behaviour.
- **"Revert the fix and require red" is only half the technique.** It catches a
  test that agrees with the ORIGINAL defect — the C-119 and C-122 failure. It
  does NOT catch a test that agrees with the OVER-correction, which here was
  the likelier long-term risk: "a scheduled order is never late" is a sentence
  a reasonable person would write and nobody would question. Both defects were
  run. Five tests are red against the original; four **different** ones are red
  against the over-correction, and two of those had been green against the
  original and would have read as dead weight. **The other half is: apply the
  wrong fix too.**

## Next unblocked item: pick one — nothing is blocking

Same menu as last session, minus the one just taken.

1. **The rush no longer exercises a refund end to end.** Both its prepaid exits
   are voids, which is C-069 working correctly — but it means the refund
   machinery, `refund_failed`, and the exceptions list appear in no demo at
   all. ~six lines of rush script plus assertions. **Cheapest real gap.**
2. **The rush places no SCHEDULED order either** — new, and the same shape as
   item 1. C-114 shipped order-ahead and C-123 has just fixed two flags that
   only scheduled orders reach, and none of it appears in the capstone demo;
   the e2e suite is the only thing that drives any of it. Seeding two — one
   collected on time, one left past its slot to redden — would demonstrate
   `requestedFor`, `dueInMinutes`, the no-show clock and the report's new
   `scheduled`/`scheduledLate` pair in one pass. **Pairs naturally with item 1:
   both are rush-script work in the same file.**
3. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.
4. **`stagePrice` is the other read-modify-write in `menu.ts`** — a
   delete-then-create inside a transaction, scoped to the same
   `(target, effectiveDay)` the create writes. Not obviously wrong, and nothing
   asserts it under concurrency. **Worth thirty minutes of probing before
   deciding it is an item at all** — which is exactly what C-122 and C-123 both
   turned out to need.

**If you would rather clear the older debt**, the C-069/C-071 list at the
bottom of this file is still accurate.

## What C-123 leaves behind

- **The rush script places no scheduled order**, so none of this reaches the
  capstone demo. Item 2 above.
- **`dueInMinutes` is floored**, so a card reads "Due in 0 min" for the last
  minute before its slot. Correct, and consistent with every other minute on
  the screen; it just reads oddly for sixty seconds.
- **Nothing bounds how far a card counts down.** A slot four hours out reads
  "Due in 240 min" rather than the hours a person would say out loud.
- **`scheduledLate` has no slowest-list of its own.** The count says how many
  missed their slot and nothing says by how much, or which. Deliberate — one
  table per quantity — but it is the obvious next ask from an operator.
- **No e2e drives a scheduled order PAST its slot.** `schedule.spec.ts` now
  asserts the card counts down and does not claim to be running late, which is
  the defect that was filed; the other direction is unit-tested only, because
  waiting out a real slot is not something Playwright expresses cheaply.

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
  such a trigger would block. Worth remembering when one is added.
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

## The gate at C-123

`lint` / `typecheck` / `test` / `build:test` / `test:e2e`, all five run.

- **1072 unit** (+16 over C-122's 1056 — exactly the tests added), 45 files.
- **E2E 218 passed + 15 skipped + 10 failed**, reconciling to `--list`'s 243;
  the ten are the documented pre-existing set above, unchanged.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check was needed and `ci:local` was not run.

## Environment notes for whoever runs the gate next

**Ten e2e specs fail in a fresh container and it is not the code.** `contact`,
`last-call` ×2, `menu-editing` ×2, `menu` ×3 and `refund` ×2 die with
`Error: request for './menu/index' is from a module not been linked` — an ESM
loader failure in the fixtures that use a late `await import('@countertop/db')`.
Verified pre-existing at C-118 by stashing that change and running the same ten
on `f239791`, where they fail identically. **Confirmed unchanged at C-123**:
the same ten specs, all ten carrying that identical error, and
**218 passed + 15 skipped + 10 failed = 243**, which is what `--list` reports.

**Postgres in a fresh container** is installed but down, and the cluster has no
`root` role. What worked at C-123, start to finish:

```sh
pg_ctlcluster 16 main start
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE root LOGIN SUPERUSER PASSWORD 'ct'"
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE countertop_test OWNER root"
npm run db:migrate:test
```

That matches `.env.test`'s `postgresql://root:ct@localhost:5432/countertop_test`
and needs no `pg_hba.conf` edit, because it authenticates with the password the
URL carries. The `pg_hba` trust line in the older note here is only needed for
`npm run ci:local`, which builds its own URL as
`postgresql://$(whoami)@localhost/...` with no password. **`ci:local` is still
worth running for a migration session** — it is the only thing that applies the
whole migration history from nothing, asserts the five named invariants, and
runs the drift check. C-123 added no migration, so it was not run.

**Playwright browsers:** the older note here says the image ships build 1194
while Playwright wants 1234 and a symlink is needed. **No longer true in this
image** — `/opt/pw-browsers` carries both `chromium-1234` and
`chromium_headless_shell-1234`, and the e2e leg ran with no intervention.

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
  flake above — a second data point for "timeout under load," not a pattern.
- **Same-day only** for order-ahead (C-114) — multi-day is the master
  PRD's own catering/lead-time P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114) — no
  "nothing left today" copy.
- **No fixture pinned to an actual DST-transition date** (C-114) for
  `zonedTimeToInstant` — a `ponytail:` comment on the function names the gap.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
