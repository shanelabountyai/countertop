# Next

**C-136 and C-137 shipped this session**, both closing coverage/UX gaps
NEXT.md had carried, not new PRD requirements.

## C-136 — a test for `reward_terms_changed`

The one checkout refusal reason nothing exercised: the owner edits the
reward's cash value between a checkout redemption being planned and being
confirmed under the member lock. No control ships to edit
`rewardValueCents` from the UI (deliberate — see `loyaltyLiability`'s own
comment), so the test drives `confirmCheckoutRedemption` directly against a
stale `plan`, the same technique `serialises two transactions that open at
the same instant` already uses. Verified the test actually catches a break
by disabling the guard first (`if (false)`), watching it fail, then
restoring. No code change outside the test file. Committed at 8e9950f.

## C-137 — a consolidated view of every queued price change

First of the two items C-110/C-111 left behind (see "Still open" below for
the rest of that backlog item). A "Queued changes" section now sits at the
top of `/kitchen/menu`, listing every staged price across the whole menu —
not just the per-row note on the item being edited — reusing
`loadStagedPrices` and `cancelStagedPrice` as-is. No migration, no new
query. Committed at abbd6a3.

**A new pre-existing flaky spec was found and bisected, not fixed**:
`e2e/menu-editing.spec.ts:234` ("the editor is usable one-handed on a
phone") fails intermittently when run as part of the full file — reproduced
identically against clean `HEAD` before this session's changes existed (6/6
clean standalone across two rounds, fails ~50% of the time as part of the
full file, both before and after). Ruled out as caused by this session's
diff by the same bisection method C-134 used for a real regression; this one
came back clean on both sides. Not root-caused. Joins `e2e/refund.spec.ts:211`
and `e2e/last-call.spec.ts:17` on the pre-existing flaky list — three now.
Did not reproduce in either item's own final gate run (both green, first
attempt, 247 total reconciled both times).

**Gate:** both items green, first attempt, on the laptop. C-136: 1124 unit
(+1), lint, typecheck, build, 231 e2e + 15 skipped = 246. C-137: 1124 unit
(unchanged), lint, typecheck, build, 232 e2e + 15 skipped = 247 (+1, the new
consolidated-view test). No migrations either item. CI green for both
pushes (`gh run watch`, ~10min each).

## Pick this up first

**Piece 2 of the daypart/schedule backlog item — collecting superseded
staged rows.** Decided this session (asked and answered): a manual
"Collect" button, not an automatic sweep — matches this repo's own
precedent for cleanup jobs (C-091, C-105: nothing self-schedules). The new
C-137 schedule view is where that button belongs. No migration needed (a
pure delete over the existing `StagedPrice` table); mirror
`packages/db/retention.ts`'s `sweepRetention` shape for the query, wire a
button into the "Queued changes" section.

After that, in order (per the scoping done this session):
3. **The daypart editor UI** — bolts onto `/kitchen/menu` +
   `apps/web/app/kitchen/menu/actions.ts`. Table and CHECKs
   (`MenuItemWindow`) already exist, no migration. `loadMenu` already
   includes `windows`; the page currently doesn't render them at all.
   Medium size.
4. **Overnight daypart windows** — decided this session: `MenuItemWindow`
   only, not unified with `StoreHours` (C-011 has the identical gap per
   `docs/WRITEUP.md`, left for a separate session). Needs a hand-written
   migration loosening the `menu_item_window_ends_after_start` CHECK and a
   rewrite of `daypartClosure` in `packages/core/menu/composition.ts` from
   "same-day start ≤ now < end" to "does any window, possibly wrapping,
   contain now." Largest and riskiest of the four — do last.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). Anything touching code
  needs the full gate run before push.
- **Before any e2e sweep, both kill lines** (C-128's incident):
  ```sh
  pkill -9 -f "$PWD.*playwright"
  pkill -9 -f 'node \(vitest'      # parens MUST be escaped
  lsof -ti :3400 | xargs -r kill -9
  ```
  **And check for OTHER projects' sweeps too**: `ps aux | grep -iE
  "vitest|playwright test"` and `sysctl -n kern.memorystatus_level` — a wall
  of unrelated timeout failures with memory below ~40% and other projects'
  processes in that list means contention, not a regression. This session
  hit exactly that twice (other projects' `vitest`/`playwright` processes at
  200%+ CPU each) before finding the real, separate flaky spec above — the
  contention pattern and a genuine pre-existing flake are BOTH real and
  distinguishable: contention produces a wide, unrelated wall of timeouts
  across many spec files; the flake above is one specific test, in one
  specific file, reproducing with or without other load.
- **`npm run test:e2e` already wires in `testlock`**
  (`~/.claude/bin/testlock`, outside this repo) via the root `package.json`
  script — do not prefix it yourself. Silent no-op anywhere not installed,
  CI included.
- **A hand-written migration's index needs a matching `@@index` in
  `schema.prisma`, or CI's drift check fails** (C-134's incident).
- **A server action's click does not block on its own mutation.** Check
  `fixtures.ts` for an existing guarded helper before writing a raw click.
- **Run `npm run db:migrate:all` after adding a migration**, before tests.
- **Anything run outside `npm test`** gets no `DATABASE_URL`. Prefix with
  `npx dotenv -e .env.test -e .env.local --`.
- **Never run `prettier --write`** — no config, no dependency, fights this
  codebase's style.

## Still open

- **Nothing bounds a staff `adjust` below zero** — investigated this
  session, not fixed. There is currently NO write path anywhere in
  `apps/web` that lets a staff member write an arbitrary loyalty `adjust`
  row (grepped every write site: only `settleRedemptionForOrder`'s system
  compensating rows and an e2e fixture write raw `adjust` rows today). The
  gap is real in `packages/core/loyalty/ledger.ts`'s `loyaltyBalance` (a
  plain unbounded sum) and is explicitly anticipated by comments in both
  `ledger.ts` and `loyalty.ts` ("a staff `adjust` is the one row a person
  types"), but building a guard function with no caller would be dead code.
  **Decide when a real staff-adjust write path is scoped**: this repo's own
  "refused, never clamped" convention (`planRedemption`, `planCheckoutRedemption`)
  argues for a `planStaffAdjustment`-style refusal, not a `Math.max(0, …)`
  clamp like `loyaltyLiability`'s (that one floors a report figure, not a
  write). Revisit together with whatever session finally builds the staff
  correction UI the loyalty PRD describes but nothing has built yet.
- **A third flaky spec**: `e2e/menu-editing.spec.ts:234`, see above. Not
  reproduced/investigated beyond the bisection that rules out this
  session's changes.
- **`NotificationKind` has one value** (C-121).
- **Nothing reads `queueReadyNotification`'s return value** (C-121).
- **No append-only trigger on `NotificationOutbox`** (the model's own
  `ponytail:`).
- **Nothing in the rush redeems at the COUNTER** — both redemptions are
  self-serve.
- **No member in the rush has a balance that expires**.
- **A customer who abandons a checkout and comes back verifies again**.
- **`Order.discountCents` has exactly one producer**.
- **No deadlock is constructible on the member lock** — an argument, not a
  test.
- **`MAX_STAGE_ATTEMPTS` exhausted still throws a raw `P2002`** (C-129,
  deliberate).
- **The staged-price retry is not observable** (C-129).
- **The `PhoneVerification` sweep is not observable** (C-130).
- **`done=off` survives a page reload.**
- **A sixth customer route can forget the footer** — `/menu/[itemId]`.
- **The status page reads the contact columns twice.**
- **The status page's estimate line is outside the `role="status"` region**
  (C-078).
- **The last-call warning does not tick** (C-079).
- **`setLastOrderIn` cannot express the last `minutesOut` minutes of the
  local day** (C-079).
- **Twenty-two of twenty-five items have no description** (C-080).
- **`e2e/refund.spec.ts:211` and `e2e/last-call.spec.ts:17`** — the other
  two pre-existing flaky specs, untouched again this session.
- **Same-day only for order-ahead** (C-114) — P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114).
- **No fixture pinned to an actual DST-transition date** (C-114).
- **No e2e drives a scheduled order PAST its slot** (C-123).
- **A void the provider refuses is chased by nothing.**
- **The staff receipt's payment line still reads "Pay at pickup" on a
  released hold.**
- **`refund_failed` rows accumulate uncapped on a stuck provider.**
- **No seeded/rush scenario produces a `refund_reversed` event.**
