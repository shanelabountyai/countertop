# Next

**C-125 shipped this session** (`f2b79d5`): the gate moved into CI, and the hole the
pre-push hook was badly filling is closed.

**The finding, and it is a process defect rather than a code one.** C-118
through C-124 all shipped on unmerged `claude/…` branches. `main` sat at
`f239791` (C-117). `ci.yml` triggered only on `push: branches: [main]` and on
`pull_request`, and no PR has ever existed in this repo. So for SEVEN
CONSECUTIVE ITEMS, CLAUDE.md's "watch CI green before saying done" had nothing
to watch — every one of them was verified by a hand-run in a container and
nothing else.

**The pre-push hook was the only gate, and it was the wrong one.** Its header
read "CI is blocked on GitHub Actions billing (every run since C-029 dies in
~3s)" — false since the repo went public on 2026-08-31, and its own closing
line said "Delete this hook once CI actually runs". It ran `ci:local` plus the
whole gate, took ~12 minutes, and CANNOT PASS IN A CONTAINER, so C-123 and
C-124 were both pushed with `--no-verify`. A gate that is routinely bypassed
does not gate; it trains the bypass. **Same lesson as C-122's misleading
`ponytail:`, one layer up: a safeguard whose stated premise is false is worse
than no safeguard, because it reads as a reason not to look.**

**What was done, in this order, so there was never a window with no gate:**

1. **Ran `ci.yml` on the branch via `workflow_dispatch` first** — run 116 on
   `8ca3447`, green across all 18 steps. That was the first independent
   verification of anything since C-117.
2. **Added `claude/**` to `ci.yml`'s push triggers**, so branch work is gated
   while it is still branch work. Runs are free on a public repo, and
   `concurrency` is keyed on `github.ref`, so a branch run never delays
   `main`'s.
3. **Fast-forwarded `main`** from `f239791` to the CI-verified SHA — clean,
   16 commits, zero divergence, no merge commit.
4. **Deleted `.githooks/pre-push`** per its own instruction, and removed the
   `git config core.hooksPath .githooks` from `package.json`'s `postinstall`
   that wired it. Leaving that line would have pointed git at a hooks
   directory with nothing in it.

**What run 116 settled, all of it previously asserted rather than checked:**

- **The ten "pre-existing container" e2e failures are genuinely
  environmental.** Playwright exited 0 on a clean runner, so `contact`,
  `last-call` ×2, `menu-editing` ×2, `menu` ×3 and `refund` ×2 all pass. The
  note carried from C-118 to C-124 was correct — and is now verified rather
  than inherited.
- **C-121's migration applies from nothing**, all six hand-written invariants
  exist, and there is **no schema drift** — so declaring
  `@@unique([orderId, kind], map:)` in `schema.prisma` rather than in the
  migration alone was right.
- **Both hostile timezones agree**, ~50s each.
- The `Order_businessDay_seq_key` duplicate-key ERRORs in the teardown log are
  **not failures** — that is the seeded rush contending on the constraint
  exactly as CLAUDE.md specifies, with the violation mapped to a retry.

## Read this before the next push

- **`npm run gate` is now a manual discipline.** Nothing runs it for you
  locally any more. CI runs it on every push to `main` and to `claude/**`, and
  that is the backstop — but a red CI after the fact is worse than a red gate
  before it, so run it.
- **`npm run ci:local` is still the only thing that applies the whole
  migration history from nothing** with the drift check. Run it for any
  session that adds a migration. `ci.yml` does the same work, after the push.
- **A brand-new branch's FIRST push can skip CI**, and this is documented in
  `ci.yml` rather than fixed: GitHub evaluates `paths-ignore` against the head
  commit alone on a new branch, and every backlog item's head commit is the
  docs-only "record the SHA" one. Later pushes evaluate the whole range and
  trigger normally. If a new branch shows no run, that is this — dispatch it
  manually rather than assuming the trigger is broken.

## Next unblocked item: pick one — nothing is blocking

Same menu as last session, minus the one just taken.

1. **The rush no longer exercises a refund end to end.** Both its prepaid exits
   are voids, which is C-069 working correctly — but it means the refund
   machinery, `refund_failed`, and the exceptions list appear in no demo at
   all. ~six lines of rush script plus assertions. **Still the cheapest real
   gap, and now the only rush-script item left.**
2. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.
3. **`writePrice`'s staged branch surfaces a raw `P2002`.** This was on last
   session's list as "`stagePrice` is the other read-modify-write in
   `menu.ts`" and **that framing was wrong** — probed this session before the
   item was chosen. The function is `writePrice`, and its delete-then-create is
   NOT unguarded: `StagedPrice` carries `@@unique([itemId, effectiveDay])` and
   `@@unique([optionId, effectiveDay])`, and since exactly one target column is
   non-null per row (the `staged_price_one_target` CHECK), each grain really is
   covered. **No duplicate row is constructible.** What IS missing is the other
   half of the discipline CLAUDE.md states for order numbers — "map the
   violation to a retry": two managers re-staging the same row for the same day
   contend on the constraint correctly and the loser gets an unmapped Prisma
   error instead of "latest wins". Smaller than the backlog implied, and real.
4. **`docs/WRITEUP.md`'s "By the Numbers" table is stale and nobody has been
   maintaining it.** It says 45 requirements, 418 unit tests, 119 e2e specs and
   a build window ending 2026-08-29. The current figures: 103 ticked backlog
   entries (latest numbered C-124), 1080 unit tests in 45 files, 244 e2e specs
   in 25 files. Not wrong per-item — simply never updated since roughly
   C-045. Its "30 orders / 5 ugly cases" row is still accurate after
   C-124. A single pass with the current numbers, or a decision to delete the
   table rather than keep lying in it.

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

## The gate at C-124

`lint` / `typecheck` / `test` / `build:test` / `test:e2e`, all five run.

- **1080 unit** (+8 over C-123's 1072 — exactly the tests added), 45 files, and
  identical under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
- **E2E 219 passed + 15 skipped + 10 failed**, reconciling to `--list`'s 244;
  the ten are the documented pre-existing set, unchanged.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check was needed and `ci:local` was not run.
- **`npm run demo:rush` was run, both full and `--until 12`** — which is how
  the grid defect above was found. Do this.

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
