# Next

**C-140 shipped this session** — overnight daypart windows, the last of
C-137's four "Left behind" items.

## C-140 — Overnight daypart windows

Migration `20260918090000_overnight_item_windows` swaps
`menu_item_window_ends_after_start` for `menu_item_window_not_empty`
(end ≠ start). `daypartClosure` (`packages/core/menu/composition.ts`) reads
an end at or before the start as wrapping into the next day; the window
belongs to the day it STARTS (Friday 22:00–02:00 serves Saturday 01:00).
Editor list/confirmation name the spill day ("(into Saturday)"). Customer
label unchanged ("Served 22:00–02:00").

**Gate:** green, first attempt. 1137 unit (+6), 238 e2e + 15 skipped = 253
(+1). Committed at 85057b6, SHA recorded at bb6b666.

## Pick this up first

**Overnight store hours (C-011's gap)** — the natural follow-up. `StoreHours`
still has `store_hours_closes_after_opening`, so the checkout gate closes at
midnight and C-140's spill past midnight is unreachable by checkout. Same
shape of work: hand-written migration loosening the CHECK, and the gate's
"open now" + next-opening walk taught to wrap (`docs/WRITEUP.md`, C-011
bullet names the upgrade). Riskier than C-140 — the gate reads it on every
checkout and the next-opening walk spans midnight. Opus-grade.

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
  session's changes. Did not reproduce in C-137's, C-138's or C-139's own
  gate runs. Not root-caused. Joins `e2e/refund.spec.ts:211` and
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
