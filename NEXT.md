# Next

**C-126 shipped this session**: a refund in the seeded rush, end to end — and
two defects, one of them mine.

Kira Lindqvist (#14) is prepaid and collected at minute 21. At 24 a manager
sends $4.25 back for a cold tamale and **the processor declines**; the ask
survives as its own row, the failure lands on the exceptions list, and the
*other* cook retries it off that list at 28. This closes the last rush-script
gap: C-069 made both other prepaid exits voids, correctly, which had left
`requestRefund`, `settleRefund`, `refund_failed` and the exceptions list
demonstrated by unit tests alone.

**The demo caught a bug forty-four tests did not, exactly as C-124 said it
would.** My first version bundled the retry into the refund step. Green
everywhere. Then `--until 26`, between the ask and the retry:

```
  refund   … refused by the processor at 24 — on the exceptions list, not yet sent
  $4.25 refunded to customers        ← it had not happened yet
```

One summary, two contradictory sentences: the settle ran with a minute-28
timestamp even when the clock stopped at 26. **Stopping is a truncation, not a
variant** — I had made it a variant. `refund_retry` is now its own scheduled
step, and `--until 26` reports $176.52 collected rather than $172.27, which is
exactly the $4.25 that had been travelling back in time. No test could have
caught this: they all pin `RUSH_END_MINUTE` and run to the end, where the two
shapes agree. **A suite that only evaluates the end state cannot see an
ordering bug in the middle.**

**The second finding is a product question, and I got it wrong twice before
getting it right.** A refunded customer lands on the report's chase list owing
the refund, with a live Collect control; the same money as a COMP leaves her
owing nothing. I called it a defect, then called it an expired premise like
C-122's and C-125's — and both were wrong. `report.test.ts` asserts this exact
case for a picked-up order and says it was written *"because the day C-067 lets
a picked-up order be refunded, this is what the report says."* **C-126 is that
day; the specification was waiting.** `docs/WRITEUP.md` has why the middle
reading was a recently-found pattern being over-applied to the next ambiguous
case — worth reading before the next `ponytail:` gets called stale.

**What is genuinely open, narrowly stated:** `orderBalance` models a refund as
*the payment coming back*, which fits a reversal and does not fit goodwill. The
shop does not want Kira's $4.25 back. One mechanism, two business meanings, and
`AdjustmentReason` already carries enough to tell them apart without being
consulted. **This is a product decision, and it is yours** — the candidate
change (`collectedCents` → `capturedCents` in the owed term) breaks **8 tests
across 4 files**, measured, several asserting the current meaning on purpose.
Pinned meanwhile by `puts a refunded customer back on the chase list, as
specified`, which carries the comp-vs-refund contrast inside it.

## What C-126 leaves behind

- **The rush's one refund is PARTIAL.** A full refund on a picked-up order —
  where the model says the customer owes the entire ticket again, the starkest
  form of the question above — is demonstrated nowhere.
- **Nothing leaves a refund UNRESOLVED.** The exceptions list is shown filling
  and emptying; a service that ENDS with money stuck on it is the
  operationally interesting case and is not scripted.
- **`refund_failed` rows still accumulate uncapped** on a stuck provider
  (C-069/C-071 debt, unchanged).

## Next unblocked item: pick one — nothing is blocking

The rush-script items are done. What is left:

1. **Decide what a goodwill refund means** (C-126, above). The only item on
   this list that is a product call rather than a code one, and the demo now
   prints the question every run.
2. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.
3. **`writePrice`'s staged branch surfaces a raw `P2002`.** Probed at C-124
   before the item was chosen, and the backlog's old framing ("`stagePrice` is
   a read-modify-write") **was wrong**: `StagedPrice` carries
   `@@unique([itemId, effectiveDay])` and `@@unique([optionId, effectiveDay])`
   and the `staged_price_one_target` CHECK keeps exactly one target column
   non-null, so no duplicate row is constructible. What IS missing is the
   other half of CLAUDE.md's order-number discipline — "map the violation to a
   retry": two managers re-staging the same row for the same day contend
   correctly and the loser gets an unmapped Prisma error instead of "latest
   wins". Smaller than the backlog implied, and real.
4. **`docs/WRITEUP.md`'s "By the Numbers" table is stale.** It claims 45
   requirements, 418 unit tests, 119 e2e specs and a window ending 2026-08-29.
   Current: 105 ticked backlog entries (latest C-126), **1082 unit tests** in
   45 files, **244 e2e specs** in 25 files. Never updated since roughly C-045.
   One pass with real numbers, or delete the table rather than keep lying in
   it.
5. **`ci-self-hosted.yml` now overlaps `ci.yml` almost entirely** (C-125's
   note). It exists because of C-036, whose premise was the billing block
   C-125 deleted from the pre-push hook — the same dead premise, still
   standing. Worth the same audit.

**If you would rather clear the older debt**, the C-069/C-071 list at the
bottom of this file is still accurate.

## What C-124 leaves behind

- **The resolved slot moves with the anchor**, so the demo's time-in-state
  totals are anchor-dependent in a way they were not before. The test pins
  `RUSH_ANCHOR`, where the slot is minute 30 and the tally is 266/126.
- **Nothing asserts the slot contention beyond the rush running.** If Jonah's
  booking were refused, `submit` would throw naming him — so the proof is the
  run, not a line in a test. Deliberate, and worth knowing.
- **`RUSH_END_MINUTE` is 50, sized for the worst grid alignment.** At
  `RUSH_ANCHOR` the last tap is at minute 39, so eleven of those minutes are
  headroom that only one anchor in fifteen ever uses.
- **The two order-ahead tickets carry no phone**, so neither puts a row in the
  P1-3 outbox. A scheduled order's "your food is ready" text is arguably the
  one that matters most, and no demo sends it.
- **Still no e2e drives a scheduled order PAST its slot** (C-123's note, still
  true). The rush now does it at the database and report grain; Playwright does
  not, because waiting out a real slot is not something it expresses cheaply.

## The gate at C-126

All five legs run. **1082 unit** (+2 over C-125's 1080 — exactly the tests
added), 45 files, identical under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
Lint, typecheck and the production build clean. **E2E 219 passed + 15 skipped
+ 10 failed**, reconciling to `--list`'s 244; the ten are the documented
container set, and CI runs them clean.

**No migration**, so `ci:local` was not run.

**`npm run demo:rush` was run full, `--until 12` and `--until 26`** — and
`--until 26` is the one that found the bundling defect. Do this, and do it at a
stop in the middle rather than only at the end: the end state is where the bug
hides.


## Environment notes for whoever runs the gate next

**The ten e2e specs that fail here PASS IN CI** — settled at C-125 by run 116,
which went green on a clean `ubuntu-latest` runner. `contact`, `last-call` ×2,
`menu-editing` ×2, `menu` ×3 and `refund` ×2 die in this container with
`Error: request for './menu/index' is from a module not been linked`, an ESM
loader failure in the fixtures that use a late `await import('@countertop/db')`.
It is environmental, not code. Locally expect **219 passed + 15 skipped + 10
failed = 244**, which is what `--list` reports; in CI expect zero failures.

**Postgres in a fresh container** is installed but down, and the cluster has no
`root` role:

```sh
pg_ctlcluster 16 main start
psql -h 127.0.0.1 -U postgres -c "CREATE ROLE root LOGIN SUPERUSER PASSWORD 'ct'"
psql -h 127.0.0.1 -U postgres -c "CREATE DATABASE countertop_test OWNER root"
npm run db:migrate:test
```

That matches `.env.test`'s `postgresql://root:ct@localhost:5432/countertop_test`
and needs no `pg_hba.conf` edit, because it authenticates with the password the
URL carries. **`npm run ci:local` is different** — it builds its own URL as
`postgresql://$(whoami)@localhost/...` with no password, so it additionally
needs `host … 127.0.0.1/32 trust` in `pg_hba.conf` and a reload. Worth it for
any session that adds a migration: it is the only local thing that applies the
whole history from nothing with the drift check.

**Note for anything run outside `npm test`:** vitest and `tsx` invoked directly
get no `DATABASE_URL` and the local guard refuses with `points at
"<unparseable>"`. Prefix with `npx dotenv -e .env.test -e .env.local --`, which
is what the package scripts do.

**Playwright** may want a browser build the image does not ship. If
`chromium-<N>` is missing, symlink the shipped build at the expected path; at
C-124 and C-125 `/opt/pw-browsers` already carried what was needed.

**There is no pre-push hook any more** (C-125), and `postinstall` no longer
sets `core.hooksPath`. If you have an old clone, `git config --unset
core.hooksPath` once. Pushing no longer runs a 12-minute gate and no longer
needs `--no-verify`.


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
