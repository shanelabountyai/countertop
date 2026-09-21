# Next

**C-147 shipped this session**: a refused capture is money owed, on both
pages. The customer's status page now splits its released-hold sentence on
`canCollectPayment` like the staff receipt — a `capture_failed` release reads
"your card was not charged. $X due at the counter". New `failCaptureFor`
fixture + one e2e covering both pages and the collect control. Gate green,
first attempt: 1161 unit, 241 e2e + 15 skipped = 256. Committed at d70687b.

## Pick this up first

No item was queued by C-147, and `docs/backlog.md` has nothing unchecked — the
pick comes from "Still open" below or the PRD's P2 list. Cheapest candidate:
**the status page's estimate line sits outside the `role="status"` region**
(C-078) — a screen reader is not told when the estimate changes. Small,
customer-facing, a11y.

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
  processes in that list means contention, not a regression. (C-146 found an
  `apptbasedservice` runner in that list that had burned 1.9s of CPU in eight
  minutes — idle, not sweeping. Check CPU time and RSS before waiting on one;
  a different project on a different port is not a `reuseExistingServer`
  collision.)
- **`npm run test:e2e -- --grep X` does NOT filter** (C-147): the root
  script's `sh -c '...'` swallows trailing args, so it silently runs the full
  sweep. To run one spec, `cd apps/web` and call its own script, with the
  `dotenv -e ../../.env.test -e ../../.env.local --` prefix.
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
- **`payment.spec.ts` reseeds in `beforeEach`**, so `?q=<name>` on
  `/kitchen/orders` matches exactly the order the test placed. "Iris
  Lindqvist" appears nowhere but that spec — a single-link click is safe
  there and is not a pattern to copy blind into a spec that does not reseed.

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
  session's changes. Did not reproduce in C-137's, C-138's, C-139's or
  C-146's own gate runs. Not root-caused. Joins `e2e/refund.spec.ts:211` and
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
- **Twenty-two of twenty-five items have no description** (C-080).
- **`e2e/refund.spec.ts:211` and `e2e/last-call.spec.ts:17`** — the other
  two pre-existing flaky specs, untouched again this session.
- **Same-day only for order-ahead** (C-114) — P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114).
- **No fixture pinned to an actual DST-transition date** (C-114).
- **No e2e drives a scheduled order PAST its slot** (C-123).
- **`refund_failed` rows accumulate uncapped on a stuck provider.**
- **No seeded/rush scenario produces a `refund_reversed` event.**
