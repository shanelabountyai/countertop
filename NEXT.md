# Next

**C-138 shipped this session** — the second of C-137's "Left behind" items,
closing the gap C-111 carried.

## C-138 — Collecting superseded staged rows

`effectivePrices` already resolves two arrived `StagedPrice` rows for the
same item/option by taking the latest `effectiveDay`, but nothing deleted
the earlier one — only a live edit spent a staged row, and two future rows
that both arrived with no live edit in between just piled up. Added
`collectSupersededPrices(now)` in `packages/db/menu.ts` (same fold
`effectivePrices` already uses, ascending by day — the second arrived row
for a target proves the first superseded), a server action
`collectSupersededStagedPrices`, and a "Collect superseded queued changes"
button on `/kitchen/menu` — placed after the "Queued changes" section but
NOT gated on `staged.length > 0` (that condition is about future rows; this
button only ever finds past ones, so the two conditions are independent).
Manual button, not a sweep — matches this repo's own precedent (C-091,
C-105: nothing here self-schedules), decided in the C-137 session.

Four new unit tests in `packages/db/menu.test.ts`'s `collectSupersededPrices`
describe. No migration, no e2e (staff-only cleanup button, no acceptance
criterion calling for a browser test).

**Gate:** green, first attempt. 1128 unit (+4), lint, typecheck, build, 232
e2e + 15 skipped = 247 (unchanged). Committed at 525b09b, SHA recorded at
b3c6c2b, pushed together. CI: watch `gh run list --branch main --limit 1`
for run 35369065311 if this session cleared before it finished — it was
in progress at handoff time.

## Pick this up first

**The daypart editor UI** — bolts onto `/kitchen/menu` +
`apps/web/app/kitchen/menu/actions.ts`. Table and CHECKs
(`MenuItemWindow`) already exist, no migration needed. `loadMenu` already
includes `windows`; the page currently doesn't render them at all. Medium
size. This is the last of C-137's four "Left behind" items except the one
below.

After that:
2. **Overnight daypart windows** — decided in the C-137 session:
   `MenuItemWindow` only, not unified with `StoreHours` (C-011 has the
   identical gap per `docs/WRITEUP.md`, left for a separate session).
   Needs a hand-written migration loosening the
   `menu_item_window_ends_after_start` CHECK and a rewrite of
   `daypartClosure` in `packages/core/menu/composition.ts` from "same-day
   start ≤ now < end" to "does any window, possibly wrapping, contain now."
   Largest and riskiest of the recent items — do last, on its own session.

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
  processes in that list means contention, not a regression.
- **`npm run test:e2e` already wires in `testlock`**
  (`~/.claude/bin/testlock`, outside this repo) via the root `package.json`
  script — do not prefix it yourself. Silent no-op anywhere not installed,
  CI included.
- **A hand-written migration's index needs a matching `@@index` in
  `schema.prisma`, or CI's drift check fails** (C-134's incident). Directly
  relevant to the overnight-windows item above.
- **A server action's click does not block on its own mutation.** Check
  `fixtures.ts` for an existing guarded helper before writing a raw click.
- **Run `npm run db:migrate:all` after adding a migration**, before tests.
- **Anything run outside `npm test`** gets no `DATABASE_URL`. Prefix with
  `npx dotenv -e .env.test -e .env.local --`.
- **Never run `prettier --write`** — no config, no dependency, fights this
  codebase's style.

## Still open

- **Nothing bounds a staff `adjust` below zero** — investigated, not fixed.
  There is currently NO write path anywhere in `apps/web` that lets a staff
  member write an arbitrary loyalty `adjust` row. The gap is real in
  `packages/core/loyalty/ledger.ts`'s `loyaltyBalance` (a plain unbounded
  sum) and is explicitly anticipated by comments in both `ledger.ts` and
  `loyalty.ts`. **Decide when a real staff-adjust write path is scoped**:
  this repo's "refused, never clamped" convention (`planRedemption`,
  `planCheckoutRedemption`) argues for a `planStaffAdjustment`-style
  refusal, not a `Math.max(0, …)` clamp. Revisit together with whatever
  session finally builds the staff correction UI the loyalty PRD describes
  but nothing has built yet.
- **A third flaky spec**: `e2e/menu-editing.spec.ts:234` ("the editor is
  usable one-handed on a phone"), intermittent when run as part of the full
  file, reproduces identically on clean `HEAD` — not caused by any recent
  session's changes. Did not reproduce in C-137's or C-138's own gate runs.
  Not root-caused. Joins `e2e/refund.spec.ts:211` and
  `e2e/last-call.spec.ts:17` on the pre-existing flaky list.
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
