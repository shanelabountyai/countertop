# Next

**C-130 shipped this session** (`5708aa2`): `PhoneVerification`'s own
`ponytail:` comment — no sweep ever deleted an old row, so the table grew by
one per verification request forever. `sweepExpiredVerifications` deletes rows
more than a day past `expiresAt` (a code is already dead the instant it
expires; the margin is only for debugging a report after the fact), wired into
`npm run db:retention` as a third pass. No policy, no settings column, no
migration. Four tests. Gate green on the first attempt, five legs, 1091 unit /
244 e2e. CI run 35113435850 on `8e26131`: green.

## Pick this up first

Nothing is blocking. The shortlist, minus the item C-130 took:

1. **`report.payment.refundedCents` still has no test over the rush** —
   C-126's item, three times deferred now. The reconciliation is narrated by
   the demo and asserted at the unit grain, not over the seeded service.

2. **Five portfolio captures are content-stale** (see the standing list below).
   Needs the machine that produced their siblings, not a container.

3. **Nothing recounts `docs/WRITEUP.md`'s By the Numbers table** (C-128). The
   stamp makes it honest, not current — this session's item pushed the unit
   count from 1087 to 1091 and nothing in the gate flags the table as stale.

## What C-130 built

- **`sweepExpiredVerifications(now)`** in `packages/db/verification.ts` —
  `phoneVerification.deleteMany` where `expiresAt` is more than
  `VERIFICATION_SWEEP_MARGIN_DAYS` (1) days old, using `cutoffDaysBefore` (the
  same subtraction `retention.ts` already does for its two windows) rather
  than a second copy of that arithmetic.
- **No settings-row column.** `retentionDays` and `loyaltyExpiryDays` are both
  real policy a restaurant could want to change, tied together by a CHECK.
  This sweep has no policy behind it — a code is either expired or it is
  not — so there was nothing to add to `RestaurantSettings` and no migration.
- **Wired into the existing runnable**, not a new command:
  `retention-sweep.ts`'s `main()` now prints a third count after the retention
  and expiry passes.
- **Four tests** in `verification.test.ts`, inserting `PhoneVerification` rows
  directly rather than through `startPhoneVerification` — the sweep only
  cares about `expiresAt`. The model's own `expiresAt` > `createdAt` CHECK
  caught a first draft that pinned `createdAt` to a fixed `NOW` while sliding
  `expiresAt` around it; fixed by deriving `createdAt` from `expiresAt`.
- **The schema comment updated**, not deleted: it named the upgrade path at
  C-115 and now names the function that shipped it instead.
- **`docs/RETENTION.md`** gets a fourth numbered step, explicit that this one
  has no window to configure.

## What C-130 leaves behind

- **The sweep is not observable**, same ceiling `sweepRetention` already
  carries — nobody logs how many rows accumulate between runs.
- **Still not scheduled**, same as its two siblings — `docs/RETENTION.md`
  already says why that is deliberate for now.
- **The one-day margin is a constant, not a setting** — deliberate, since
  there is no policy behind it, but if a future support workflow ever wants a
  longer look-back window this is the first place that assumption would need
  to move.

## The gate at C-130

All five legs, on the laptop, **first attempt**.

- **1091 unit** in 45 files (+4, this item's sweep tests).
- **E2E 229 passed + 15 skipped = 244**, reconciling against `--list`'s 244,
  zero failures, 4.6m.
- Lint, typecheck and the production build clean.
- **No migration**, so no drift check and `ci:local` was not run.
- `demo:rush` not run — the rush issues verification codes but places no order
  slow enough for one to age a day past its own five-minute expiry.
- **CI run 35113435850 on `8e26131`: green** — the full `gate` job on a clean
  runner, including the migration history applied from nothing with the drift
  check and both hostile timezones. Pushed as two commits (work +
  record-the-SHA) in one `git push`, so the head commit GitHub evaluated
  `paths-ignore` against was the docs-only one — but `main` already existed,
  so GitHub evaluated the whole `before..after` range rather than the head
  commit alone (that caveat only bites a *brand-new* branch's first push), and
  the `.ts` changes triggered the run normally.

## Before the next sweep

**Both kill lines, every time** — C-128's incident, confirmed again this
session:

```sh
pkill -9 -f "$PWD.*playwright"
pkill -9 -f 'node \(vitest'      # parens MUST be escaped; vitest titles carry no path
lsof -ti :3400 | xargs -r kill -9
```

Memory held at 46% available, pressure 0, this session.

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
  a new branch shows no run, dispatch it manually. (Pushing directly to
  `main`, as this session did, does not hit this — `main` already has history,
  so GitHub diffs the whole push range.)
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

## Still open from C-118 → C-129

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
- **The sleeps in the member-lock test are 250ms**, and so are C-129's. If
  either flakes, raise them; do not delete the test.
- **A refund cannot be reversed at all** (C-127). A comp on the wrong ticket is
  taken back by `adjustment_reversed`; a refund sent to the wrong customer has
  no contradicting row and, since C-127, no longer surfaces as money to chase.
- **`MAX_STAGE_ATTEMPTS` exhausted still throws a raw `P2002`** to the server
  action (C-129, deliberate — three collisions is a different bug) — the
  manager's screen would show the same unhandled error the item just removed.
- **The staged-price retry is not observable** (C-129) — nothing logs a
  collision, so its frequency in production is unknowable.

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
