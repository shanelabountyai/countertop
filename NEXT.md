# Next

**C-129 shipped this session** (`b9b80f4`): `writePrice`'s staged branch had
half of CLAUDE.md's database rule — it contends on the unique constraint and
then handed the loser a raw `P2002`. Now a bounded retry (3 attempts), so two
managers re-staging the same row for the same day both get "latest wins", which
is what the action already told them happened. One test, driven rather than
hoped for. No migration. Gate green on the first attempt, five legs, 1087 unit
/ 244 e2e.

## Pick this up first

Nothing is blocking. The shortlist, minus the item C-129 took:

1. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep. Now the smallest real item
   on the list.

2. **`report.payment.refundedCents` still has no test over the rush** —
   C-126's item, three times deferred now. The reconciliation is narrated by
   the demo and asserted at the unit grain, not over the seeded service.

3. **Five portfolio captures are content-stale** (see the standing list below).
   Needs the machine that produced their siblings, not a container.

## What C-129 built

- **A bounded retry around the staged transaction** in `packages/db/menu.ts`.
  The loser's `deleteMany` runs before the winner commits, so it sees nothing
  to delete and its `create` lands on the index; the retry's delete *does* see
  the committed row.
- **`MAX_STAGE_ATTEMPTS = 3`, not the order number's 25**, with the reason on
  the constant: `takingNextOrderNumber` re-reads a maximum somebody else may
  take again and expects to go round; this loop deletes the row it collided
  with.
- **The inline `P2002` check** that `refund.ts`, `authorization.ts` and
  `loyalty.ts` already use — not a second copy of `placement.ts`'s private
  `uniqueViolationTarget`, because this branch does not care which constraint.
- **One test, C-119's shape for C-119's reason.** Two `writePrice` calls under
  `Promise.all` each commit before the other opens, so the retry never runs and
  a green test proves nothing. The test holds a transaction open, walks the
  losing path into it, and releases. **Run against the unfixed code first** —
  `Unique constraint failed on the fields: (itemId, effectiveDay)`.

## What C-129 leaves behind

- **The live branch has no retry and needs none** — `update` + `deleteMany`,
  no insert, no unique violation to map. If a future edit adds an insert there,
  this reasoning stops holding.
- **Nothing tests the option grain of the race.** The retry is grain-agnostic
  (one code path, `{...target}`), so the item test covers the branch; a second
  test would cover the spread operator.
- **The retry is not observable.** Nothing logs that a stage collided, so the
  frequency of two managers racing is unknowable in production. A counter or a
  log line is the upgrade path if it ever matters.
- **`MAX_STAGE_ATTEMPTS` exhausted still throws a raw `P2002`** to the server
  action, which is deliberate — three collisions is a different bug — but the
  manager's screen would show the same unhandled error the item just removed.

## The gate at C-129

All five legs, on the laptop, **first attempt**.

- **1087 unit** in 45 files (+1, this item's race test).
- **E2E 229 passed + 15 skipped = 244**, reconciling against `--list`'s 244,
  zero failures, 8.5m.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check and `ci:local` was not run.
- `demo:rush` not run — the rush places orders, it does not stage prices.
- **CI run 35013197524 on `82c5e57`: green**, the `gate` job succeeding — the
  full sweep on a clean runner, including the migration history applied from
  nothing with the drift check and both hostile timezones. This item changes
  `.ts`, so `paths-ignore` did not skip it.

## Before the next sweep

**Both kill lines, every time** — C-128's incident, confirmed again this
session:

```sh
pkill -9 -f "$PWD.*playwright"
pkill -9 -f 'node \(vitest'      # parens MUST be escaped; vitest titles carry no path
lsof -ti :3400 | xargs -r kill -9
```

Two vitest workers were resident from this session's own file-scoped run and
were reaped by name before the sweep. Memory held at 74% available, pressure 0.

**If four Claude Code sessions are alive, close the ones you have walked away
from before starting a sweep.**

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). CI runs it on every push
  to `main` and to `claude/**` and that is the backstop, but a red CI after the
  fact is worse than a red gate before it.
- **`npm run ci:local`** is still the only thing that applies the whole
  migration history from nothing with the drift check. Run it for any session
  that adds a migration.
- **`npm run db:status` before `demo:rush`** if the last session added a
  migration — `demo:rush` reads `.env.local` and that database drifts.
- **A brand-new branch's FIRST push can skip CI**, documented in `ci.yml`
  rather than fixed: GitHub evaluates `paths-ignore` against the head commit
  alone, and every item's head commit is the docs-only "record the SHA" one. If
  a new branch shows no run, dispatch it manually.
- **There is no pre-push hook** (C-125). Old clones: `git config --unset
  core.hooksPath` once.
- **Anything run outside `npm test`** gets no `DATABASE_URL` and the local
  guard refuses with `points at "<unparseable>"`. Prefix with `npx dotenv -e
  .env.test -e .env.local --`.
- **Run `npm run db:generate`** if `typecheck` reports unknown Prisma columns.

## Environment notes for whoever runs the gate next

**In a container, ten e2e specs fail and they PASS IN CI** — settled at C-125
by run 116 on a clean `ubuntu-latest` runner. `contact`, `last-call` ×2,
`menu-editing` ×2, `menu` ×3 and `refund` ×2 die with `Error: request for
'./menu/index' is from a module not been linked`, an ESM loader failure in the
fixtures using a late `await import('@countertop/db')`. Environmental.

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

## Still open from C-118 → C-128

- **Nothing recounts `docs/WRITEUP.md`'s By the Numbers table** (C-128). The
  stamp makes it honest, not current; no gate leg reads any of those figures.
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
- **The sleeps in the member-lock test are 250ms**, and now so are C-129's. If
  either flakes, raise them; do not delete the test.
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
