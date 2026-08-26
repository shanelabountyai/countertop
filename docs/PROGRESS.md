# Progress Log — Countertop

Mechanical build log, one entry per backlog item: what it built, what it
decided, what it left behind. Pair with `docs/RELEASE_NOTES.md` for the
portfolio-facing version of the same history.

---

## C-001 — Monorepo scaffold, CI, and the four docs

**Built:**
- `apps/web`: Next.js 16 (App Router) + TypeScript + Tailwind v4 via `create-next-app`. **Port 3400 is baked into the `dev`/`start` scripts and into `playwright.config.ts`'s default** — never passed as `PORT=` on the command line. Two projects both defaulting to the same port fail silently, because Playwright's `reuseExistingServer` adopts whatever is already listening and the suite then tests the wrong app.
- `packages/core`: `package.json` + an empty `index.ts` naming which session fills it, and one scaffold test so the two CI timezone passes run a real suite rather than reporting green on zero tests.
- `packages/db`: Prisma client singleton, `schema.prisma` with datasource + generator only — no models. The header carries the rules C-003 has to obey (snapshot columns, integer cents, the two unique constraints, `@db.Timestamptz(3)`, never `db push`) so the schema session opens with them in front of it.
- ESLint: `eslint-rules/no-time-axis.mjs` exports two rule sets. `noTimeAxisRules` (the five CLAUDE.md bans — `new Date(string)`, `Date.parse`, `get/set*`, `getTimezoneOffset`, `toISOString().slice(0,10)`) applies to `packages/**` **and** `apps/web`. `noClockReadRules` adds a `packages/core`-only ban on `Date.now()` and bare `new Date()`, which is CLAUDE.md's "nothing in `packages/core` reads the system clock" made mechanical instead of remembered.
- Playwright + `@axe-core/playwright`, `workers: 1`, production build by default (`e2e:server` = build + start), `E2E_DEV=1` as the escape hatch. Two smoke specs: the app serves on 3400, and the landing page has zero axe violations at WCAG 2.1 AA.
- `.github/workflows/ci.yml`: throwaway Postgres, `prisma migrate deploy` from scratch, `prisma migrate diff --exit-code` drift check, an assertion that the gitignored Prisma client actually got generated, the unit suite twice (`TZ=UTC` and `TZ=Pacific/Kiritimati`), then the e2e leg on 3400.
- Local databases `countertop_dev` / `countertop_test` on the brew-managed Postgres cluster, with `.env.local` / `.env.test` (both gitignored) wired through the `dotenv -e .env.test -e .env.local` first-file-wins pattern.
- `docs/`: this file, `RELEASE_NOTES.md`, `WRITEUP.md`, and `backlog.md` (C-001 → C-017, derived from the PRD's four phases).

**Decided:**
- **Local dev uses the existing brew-managed Postgres, not `docker-compose.yml`.** Docker isn't installed on this machine and the sibling projects (`bookable_test`, `rental_test`, `storage_test`) already share this cluster. The compose file is committed anyway — it costs ten lines, it maps to what CI's service container provides, and it publishes on 5435 to stay clear of Bookable's 5434. Nothing downstream cares which one produced the `DATABASE_URL`.
- **The clock-read ban is scoped to `packages/core`, not repo-wide.** `apps/web` legitimately needs the current instant at the request boundary — that's the value it passes *into* the engine as `now`. Banning it everywhere would just produce a repo full of eslint-disable comments, which is a ban nobody reads.
- **The `deepmerge-ts` high-severity advisory is accepted, not fixed.** It reaches us only as a transitive dependency of the Prisma **CLI** (`prisma` → `@prisma/config` → `deepmerge-ts`), the vulnerability is stack exhaustion when merging recursive object graphs, and the only graph it merges here is our own committed config. `npm audit fix` cannot resolve it without a Prisma release. Recorded in `docs/WRITEUP.md`; revisit when Prisma bumps.
- **Verified rather than assumed, both in this repo's installed versions:** `dotenv-cli` tolerates a missing `-e` file (CI has neither `.env.test` nor `.env.local`, so the workflow's `env:` block is what applies), and the **first** `-e` file wins on conflict (which is what lets `.env.test` override only the database while inheriting everything else from `.env.local`).

**Left behind:**
- **No shadcn.** `create-next-app` gave Tailwind v4; `components.json` and the first component get pulled in C-007, when there is a screen that needs one. Installing a component library before any UI exists is inventory, not progress.
- **The drift check currently checks nothing** — there are no models and no migrations. It starts doing real work the moment C-003 writes the first migration, which is exactly when it matters.
- **No seed script.** `db:reset:test` recreates and migrates but does not seed; the `db:seed:*` scripts land with C-003's fixtures. CLAUDE.md's warning stands for later sessions: migrations applied with zero rows is a green `db:status` and a red sweep.
- **`e2e:server` rebuilds on every sweep** (~10s here, and it is what stops a stale `.next` testing yesterday's code). If the build cost becomes annoying once there are real screens, that is a trade to revisit, not a default to change.

**Found and fixed within C-001:**
- **The drift check could not have passed.** `prisma migrate diff --from-migrations` needs `packages/db/prisma/migrations/migration_lock.toml` to know the connector, and with no migrations written that directory did not exist. Fixed by committing the lock file (`provider = "postgresql"`) up front — the file Prisma writes with the first migration anyway. Written up in `docs/WRITEUP.md`.
- **The first push to a new branch skips CI.** GitHub evaluates `paths-ignore` against the head commit alone on a new branch, and the head commit of every backlog item is the docs-only "record the SHA" one. Added `workflow_dispatch` so it is recoverable without an empty commit; later pushes evaluate the whole `before..after` range and trigger normally.

**Blocked, not resolved:** GitHub Actions refuses to start the job — *"The job was not started because recent account payments have failed or your spending limit needs to be increased."* The workflow file is registered and syntactically valid, but **CI has never actually run green on this repo.** The four gate steps were executed locally instead, including CI's own migrate-from-scratch and drift-check commands against a throwaway local database. That is not the same as a green CI badge and is not claimed to be.

C-001 committed and pushed at 5e9979b

---

## C-002 — Menu model, price engine, and the one orderability function

**Built:**
- `packages/core/menu/types.ts` — categories → items → modifier groups → options, pure data. Options carry `priceDeltaCents` (negative and zero allowed) and an optional `extraPriceDeltaCents`; groups carry `min`/`max`/`intensityEnabled`. Items reference groups **by id**, so one `salsa` group genuinely serves both the burrito and the bowl with nothing to drift apart.
- `packages/core/menu/composition.ts` — `validateComposition`, THE orderability function. Reports every reason at once as a discriminated union (`group_required`, `below_min`, `above_max`, `option_unavailable`, `item_unavailable`, `duplicate_option`, `unknown_group`/`unknown_option`/`unknown_item`, `intensity_not_supported`, `quantity_out_of_range`, `note_too_long`), each with a customer-readable message. Server-side caps live here: quantity 1–20 and notes ≤140, both configurable.
- `packages/core/pricing/pricing.ts` — `priceLine` ((base + Σ deltas) × quantity), `priceOrder` (Σ lines + tax), `taxOn` (the single rounding operation in the engine), `taxRatePpmFromPercent`, and `checkClientTotal`, which returns a mismatch record and structurally *cannot* return "use the client's number".
- `packages/core/menu/sample-menu.ts` — the hand-built menu every fixture is calculated against: a required single-select size group, negative deltas, an optional 0–3 group, two intensity-enabled groups (one with a priced "extra"), a min-2 group, an item with no modifiers, and two groups reused across two items.
- 53 tests across the two modules, **written and confirmed red before any implementation existed** (52 failing on `not implemented`; the 53rd is the one-level-deep nesting test, which `tsc` enforces via `@ts-expect-error` rather than a function, so it cannot be red by construction).

**Decided:**
- **There is no `required` flag — `min > 0` IS required.** Two ways to say the same thing is two ways to disagree; a group with `required: true, min: 0` has no defined meaning and someone would eventually write one. Same reasoning that makes S/M/L a modifier group instead of a second "variant" mechanism.
- **Intensity `none` is a first-class selection — the negation — and it does not count toward `min`/`max`.** This is the correctness-critical call of the session. If `none` counted as a pick, a customer could satisfy the required protein group by selecting "chicken → none" and walk out with a burrito containing no protein, with the kitchen never told a choice was skipped. It also means "no onions plus three toppings" is three picks, not four. Both directions are tested.
- **A `none` selection of an 86'd option is allowed.** Asking for NO onions when the kitchen is out of onions is trivially satisfiable; refusing it is exactly what a naive `option.available` check does. This also means a cart line holding "onions → none" is correctly *not* flagged when onions get 86'd mid-flight (P0-3).
- **The tax rate is an integer in parts per million, not a float percentage and not basis points.** A float rate lands the boundary cent on the wrong side by luck; `taxOn` is `floor((subtotal × ppm + 500_000) / 1_000_000)` — half-up, entirely in integers. Basis points were the obvious first choice and were rejected on a real number: 8.875% (New York) is 887.5 bp, which basis points cannot express, and 88_750 ppm, which this can.
- **Tax is computed once on the subtotal, never per line and summed.** Per-line rounding drifts a cent per line against a receipt a customer can check with a calculator. The fixture asserts the rule rather than the arithmetic, because on this particular pair of lines both approaches happen to agree.
- **`light` costs the same as `regular`.** Restaurants do not discount light sauce; inventing a discount rule nobody asked for is a pricing policy smuggled in as a default.
- **`priceLine` throws on an unknown id rather than pricing it at zero.** A silent zero is how a tampered request becomes free food. It assumes a composition `validateComposition` has already accepted, and says so.

**Left behind:**
- **No default-included options.** "NO onions" is expressed as selecting Onions at `none`, not as deselecting something the item ships with. Default-inclusion is a real modeling feature (it changes what the composer screen renders) and it is not in P0-1 — if C-007 wants it, it is an additive change to the group type.
- **The menu itself is not validated** — nothing checks that `max >= min`, or that every `modifierGroupIds` entry resolves. A malformed group is a seed/menu-editor bug, and C-015 is where the editor gets to refuse one.
- **`sample-menu.ts` ships inside the module rather than a test-only folder.** It is four items; C-017's seed grows it to the PRD's ~25 without changing the shape.
- **No display formatting.** Cents → "$10.95" is a UI concern and lands with the first screen that needs it (C-007).

C-002 committed and pushed at 78c7ef4

---

## C-003 — The data model, and the snapshot rule made provable

Opened with the review pause START-HERE calls for: entity list, the exact
snapshot columns, and the unique constraints, all confirmed before a line of
schema was written. Three forks were put up and all three recommendations taken.

**Built:**
- `packages/db/prisma/schema.prisma` — ten models. Menu side: `Category`, `MenuItem`, `ModifierGroup`, `ModifierOption`, and `ItemModifierGroup`, the join that makes group reuse real. Order side: `Order`, `OrderLine`, `OrderLineOption`, and the append-only `OrderEvent`. Plus a `RestaurantSettings` singleton holding the two things placement needs — `timezone` and `taxRatePpm`.
- **The snapshot columns.** `OrderLine` copies `itemName`, `categoryName`, `basePriceCents` and computes `unitPriceCents`/`lineTotalCents`; `OrderLineOption` copies `groupName`, `optionName`, `intensity` and stores `appliedDeltaCents` — what that option actually added, so the options sum exactly to `unitPriceCents − basePriceCents`. `Order` snapshots `taxRatePpm` alongside the money.
- **The hand-written migration** (`prisma migrate dev --create-only`, then edited): the `order_event_append_only` BEFORE UPDATE OR DELETE trigger, and the `restaurant_settings_singleton` CHECK.
- `packages/db/testing/` — `resetDatabase()` (TRUNCATE, because the append-only trigger refuses DELETE by design) and `seedSampleMenu()`, which writes `packages/core`'s `SAMPLE_MENU` into the database keeping its readable ids. One menu definition in the repo, not a fixture and a seed drifting apart.
- `packages/db/snapshot.test.ts` — places an order, then renames the category, renames/reprices/86s the item, renames a group and changes its rules, renames/reprices/86s an ordered option, **deletes an ordered option outright**, and detaches a group from the item — then asserts the receipt JSON is byte-identical. Plus a test that the deleted option's analytics id is left dangling rather than the order being mutated, and an enum-parity test asserting the database's `Intensity` values equal `packages/core`'s `INTENSITIES`.
- `packages/db/constraints.test.ts` — 8 concurrent placements racing for order #47 produce exactly one winner; duplicate idempotency key, duplicate status token, and duplicate line number all refused; the append-only trigger refuses UPDATE, DELETE, **and a cascading delete of the parent order**; a second settings row refused.
- CI gained an "assert the hand-written invariants exist" step, checking the trigger, the CHECK, and both unique indexes against a database built from nothing.

**Decided (the three review forks, all confirmed):**
- **Menu references on snapshots are plain strings with no foreign key.** `onDelete: Restrict` would forbid deleting any menu row ever ordered — forever — and `SetNull` would MUTATE a placed order, which is the one thing this model refuses. The columns exist for analytics correlation and are never resolved for display or pricing. This is a deliberate, recorded deviation from CLAUDE.md's "if kept, Restrict" wording, and it is what lets the regression test delete an option the order actually contains.
- **No cart tables.** The cart is client-side; every mutation posts to a server endpoint that validates against the live menu and returns the priced line, and checkout revalidates everything. Cart tables would mirror `OrderLine` field for field and need their own session keying and expiry job.
- **Two timestamp columns, not seven.** `placedAt` orders the queue and `statusChangedAt` drives both aging flags; every other transition time derives from the event log. A column per status can disagree with the log, and a logged revert would have to invent a rule about whether to un-set one.

**Also decided:**
- **`taxRatePpm` is snapshotted on the order.** Without it a later rate change makes an old receipt arithmetically unexplainable — you can see 8.25% did not produce that number, and nothing tells you what did.
- **TRUNCATE is deliberately not blocked by the append-only trigger.** It fires TRUNCATE triggers, not row triggers, and it is how the suite resets between files. Nothing in the application issues one.
- **The P0-2 total mismatch is an `OrderEvent`, not a column.** It is an event that happened, not a property of the order.
- **CI checks `pg_class` for the unique indexes, not `pg_constraint`.** Prisma emits `CREATE UNIQUE INDEX`, not `ALTER TABLE ADD CONSTRAINT`, so they are not in `pg_constraint` at all — verified against the live database while writing the step. Checking the wrong catalog is a green assertion that verifies nothing, which is worse than no assertion.

**Found and fixed within C-003:**
- **The time-axis lint ban was too broad to obey.** It rejected `new Date(Date.UTC(...))`, which is the one argument form that provably cannot read the process timezone, and is how every test builds the frozen `now` the engine takes as a parameter. Left as-is it would have put an `eslint-disable` in every future test file — a ban nobody reads. Narrowed to exempt exactly that shape (verified against a probe file: string, bare number, and `Date.UTC(...) + 1000` all still rejected). The `packages/core` clock ban was likewise narrowed to **zero-argument** `new Date()` and `Date.now()`, which is what "reads the clock" actually means.

**Left behind:**
- **`OrderStatus` has no parity test yet.** The database enum exists; the ONE status module in `packages/core` is C-004's. The `Intensity` parity test in `snapshot.test.ts` is the template — **C-004 must add the matching one**, or the two vocabularies can drift.
- **No placement code.** `snapshot.test.ts` writes the snapshot the way C-006's route will, in a local helper. Order-number assignment, the idempotency retry, and the mismatch log are C-006.
- **No seed script and no `RestaurantSettings` row outside tests.** `db:seed:*` lands with C-017.
- **Store hours, pause, throttle and prep times are not in `RestaurantSettings`.** C-011 and C-013 add their own columns; adding them now would be four settings nothing reads.

C-003 committed and pushed at 85f384e

---

## C-004 — The order state machine

The lifecycle as ONE module, and every reader-facing status list derived from
one table inside it rather than spelled out at each call site.

**Built:**
- `packages/core/orders/state-machine.ts` — `STATUS_FACTS`, a
  `Record<OrderStatus, …>` holding nine facts per status (`next`, `previous`,
  `open`, `terminal`, `alerts`, `inQueue`, `cancellableByStaff`,
  `cancellableByCustomer`, `abandonable`). Adding a state is a compile error
  until every one of those questions is answered — which is the CLAUDE.md
  invariant ("the compiler finds the readers, not grep") made structural rather
  than aspirational.
- **The reader lists are filters over that table, not literals.**
  `OPEN_STATUSES` (the P0-6 throttle count), `TERMINAL_STATUSES` (where P0-5
  polling stops), `ALERT_STATUSES` (P0-12), `QUEUE_STATUSES` (the kitchen
  groupings, in flow order), plus `isOpen` / `isTerminal` /
  `needsAcknowledgment` / `nextStatus` / `previousStatus`.
- `applyTransition(order, action, now)` — pure; it decides, it does not
  persist. Four actions (`advance`, `revert`, `cancel`, `abandon`), returning
  either the new status plus the `OrderEvent` rows to append, or a refusal
  carrying a **reason** and a staff-facing message.
- `acknowledge(order, now)` is `advance` with the target named — the ack IS
  `placed → accepted` (P0-12), not a second code path that could disagree.
- `placementEvent(now)` — the `placed` row's own event, a transition from
  nothing, so C-006 does not hand-roll the event vocabulary.
- The **status vocabulary** (`ORDER_STATUSES`, `CANCEL_REASONS`,
  `EVENT_ACTORS`, `ORDER_EVENT_KINDS`, `PAYMENT_STATES`) now lives in the
  engine, and `packages/db/snapshot.test.ts` asserts all five against
  `pg_enum` — the parity test C-003 explicitly left for this session, extended
  from one enum to a table over six.
- `packages/core/orders/state-machine.test.ts` — 58 tests. The centre of it is
  the **full 7×5 transition table written out longhand** (every status against
  every action), so a change to the machine has to be re-justified row by row
  instead of agreeing with itself. That yields 20 refusals across 8 distinct
  reasons — well past the PRD's "≥8 invalid transitions" — every one asserted
  **by reason**, plus tests that the table covers and reaches every status.

**Decided:**
- **Staff may cancel through `preparing`, not just `placed|accepted`.** The
  PRD's state line says `placed|accepted → cancelled`; START-HERE says "staff
  anytime pre-ready". Took the wider reading: "out of item" is usually
  discovered with the pan already hot, and the narrower rule would leave staff
  with no button for the case the preset reason list names first.
- **`ready` is on the queue but is NOT open.** The food is made, so it must not
  hold the P0-6 auto-pause threshold closed — but it still ages on the queue
  until someone collects it. Two facts, deliberately not one.
- **`picked_up` and `abandoned` are terminal AND revertable; `cancelled` is
  not.** The 5-second undo has to work on the last forward tap too, and a
  no-show closed out by mistake is the same fat-finger. A cancel may have
  written a refund, and un-cancelling would have to re-charge — so it refuses,
  by its own reason (`revert_not_allowed`), with a message that says to place a
  new order.
- **`advance` and `revert` accept an OPTIONAL target, and refuse a stale one**
  (`unexpected_target`). Two cooks tapping the same card is not a hypothetical
  at arm's length with gloves on; the second tap names a state that is already
  behind and is refused rather than skipping one.
- **The mock refund is an `OrderEvent`, not a payment interface.** Cancelling a
  `paid` order emits a second event (`kind: 'refund'`, actor `system`, detail
  `{amountCents, provider: 'mock'}`). An interface with one implementation is
  an interface with no information in it; the real adapter is P2, and the event
  is the record either way.
- **`other` requires text.** A cancel reason nobody can act on later is the
  reason the preset list exists to avoid. Cancel notes are capped at 140 to
  match the column.
- **Eligibility is checked before payload.** "This order cannot be cancelled at
  all" is more useful to a caller than "your note is too long" on an order that
  was never cancellable.

**Left behind:**
- **No aging flags.** The 15-minute queue flag and the 10/20/30-minute `ready`
  no-show flags are pure functions of `statusChangedAt` and `now`, and they
  belong with the queue that renders them — C-008. They go in this module, not
  in a component.
- **Nothing persists yet.** `applyTransition` returns the events; writing them
  and the new status **in one transaction** is C-006's and C-008's job. A
  status that moved without an event is a hole in the history the P1-1 report
  reads, and there is no test yet that could catch one — the transaction is the
  thing to review in C-008.
- **No undo *window*.** The 5 seconds in P0-4 is UI: the engine allows a revert
  whenever the table does, and the button is what expires. Correctness does not
  depend on a client-side timer.

C-004 committed and pushed at 88740a1

---

## C-005 — The cart

The cart as compositions the server re-prices on every read, and a checkout
re-check that catches the two things that can change while food sits in it: an
86 and a reprice.

**Built:**
- `packages/core/cart/cart.ts` — `addLine`, `replaceLine`, `removeLine`,
  `reviewCart`, `confirmPrices`. Pure: the caller persists the cart and supplies
  the line id, so nothing here reads a clock, a cookie, or a database.
- **A cart line holds a `Composition` and one display-only number** —
  `unitPriceAtAddCents`, the price the line was added at. It exists for exactly
  one job: detecting that the menu was repriced underneath it. It is never
  summed, never stored, never compared against a client-supplied total.
- `reviewCart(menu, cart, ratePpm)` — the checkout gate for cart *contents*.
  Per line: the live `PricedLine`, every `CompositionViolation` (86'd item, 86'd
  option, over-cap quantity or note, a group that changed shape), and the
  `old → new` price change if there is one. Cart-wide: server totals,
  `needsFix`, `needsPriceConfirmation`, `placeable`.
- `packages/core/cart/serialize.ts` — `parseCart` / `parseComposition`, the
  trust boundary. Shape only: types, integers, known intensities. Menu truth is
  `validateComposition`'s to answer, and duplicating a cap here would be a
  second answer to drift from the first.
- `packages/db/menu.ts` — `loadMenu()` (rows → the core `Menu`) and
  `loadSettings()`. `menu.test.ts` asserts `loadMenu()` round-trips
  `SAMPLE_MENU` exactly, ordering included.
- `apps/web/lib/cart-session.ts` + `apps/web/app/cart/actions.ts` — one httpOnly
  session cookie, and five thin server actions over it.
- 26 cart tests + 3 loader tests. Hand-calculated: 1345×2 + 350 = 3040,
  tax 250.8 → **251**, total 3291.

**Decided:**
- **No cart table.** A cart holds nothing the customer's own browser cannot
  hold, because it holds no authority — every price is recomputed from the live
  menu on every read. Rows appear when a cart becomes an order (C-006). A
  tampered cookie cannot make food cheaper; the worst it can do is suppress the
  customer's own confirmation dialog and charge them the real menu price.
- **Confirming a price change IS the re-baseline.** `confirmPrices` rewrites
  each line's `unitPriceAtAddCents` to the live price, and `needsPriceConfirmation`
  falls to false as a consequence. A separate "confirmed" flag is a second fact
  that can get out of step with the prices it was supposed to describe.
- **Editing a line re-baselines it too.** An edit goes back through the
  composer, where the customer sees today's price — carrying the old baseline
  forward would ask them to confirm a change they just made themselves.
- **`reviewCart` reports every problem on every line at once.** A checkout that
  surfaces one 86'd line per attempt is the phone call this product exists to
  replace.
- **A line the menu no longer has (`unknown_option`) is not priced, not
  guessed.** `priced` is null, it contributes nothing to the total, `needsFix`
  blocks placement, and `confirmPrices` leaves its stale baseline alone.
  Inventing a price for a deleted option is the silent repricing this path
  exists to prevent.
- **Cookie writes can fail, and the action says so.** Over ~4KB a browser drops
  the cookie silently — which would read as a lost cart. `writeCart` returns
  false and the action returns `cart_full` rather than reporting a save that
  did not happen.
- **Session cookie, no `maxAge`.** P0-3 asks for per-session persistence, and a
  week-old cart full of 86'd food is worse than an empty one.

**Left behind:**
- **No UI.** The composer and the cart screen are C-007's; this is the engine
  and the server surface they call. `getCartReview` is what checkout renders.
- **No placement.** `reviewCart(...).placeable` is the gate C-006 checks before
  snapshotting — and placement must re-check it inside the transaction, because
  a review is a read and an 86 can land between the two.
- **The checkout gate proper (pause / auto-pause / hours, P0-6) is not here.**
  `placeable` answers "is this cart orderable?", not "is the restaurant taking
  orders?" That is ONE code path with three triggers, and it lands in C-012.
- **No cart-level cap.** Quantity and note caps are enforced per line; the
  number of lines is bounded only by the cookie ceiling above.

C-005 committed and pushed at 0c9f4ca

---

## C-006 — The placement flow

The cart becomes rows: re-priced by the server, copied instead of referenced,
numbered without racing, and answerable to the same key twice.

**Built:**
- `packages/core/orders/business-day.ts` — `businessDayOf(now, timezone)`, the
  restaurant-timezone calendar day as `"YYYY-MM-DD"`. `Intl.DateTimeFormat`
  with `formatToParts`, which is the only timezone database in the platform and
  the reason this needs no dependency. Six tests: a UTC-vs-local day split, the
  rollover to the minute, a DST jump, a zone ahead of UTC, the `Char(10)`
  padding, and an unknown zone throwing rather than falling back to UTC.
- `packages/core/orders/placement.ts` — `buildOrderSnapshot(menu, cart, ratePpm)`
  (the pure copy: item and category names, base price, applied delta per option,
  computed unit/line totals, tax once on the subtotal), `normalizeIdentity`
  (P0-8's name/phone/note, trimmed and length-checked against the column
  widths), and `formatOrderNumber(seq)` → `#047`.
- `packages/core/pricing/pricing.ts` — `optionCost` exported as
  `appliedDeltaCents`. The snapshot stores what each option added; a second
  implementation of that arithmetic would be a second answer to drift, and a
  test asserts the options sum to exactly `unitPriceCents - basePriceCents`.
- `packages/db/placement.ts` — `placeOrder(input)`: replay check, re-price and
  re-validate against the live menu, then ONE `prisma.order.create` writing the
  order, its lines, its options and its `placed` event together. Exports
  `ORDER_RECEIPT`, the include shape every reader of a placed order shares.
- `apps/web/app/checkout/actions.ts` — `placeCartOrder(raw)`. Shape-checks the
  request, reads the cart from the httpOnly cookie (never from an argument),
  calls placement, clears the cart, and returns a confirmation with **no UUID
  in it**.
- 14 core placement tests + 6 business-day tests + 17 placement integration
  tests. `snapshot.test.ts` now places through the real `placeOrder` instead of
  hand-building a row — the regression test proves the code that takes money,
  not a fixture that agrees with itself. 199 unit tests, identical under
  `TZ=UTC` and `TZ=Pacific/Kiritimati`.

**Decided:**
- **The idempotency key is checked first, before the menu is even read.** A
  retry answers out of the orders table. A customer whose second tap arrived
  after the guacamole ran out must not be told their food is sold out when it
  is already being made — there is a test for exactly that.
- **The order number is `max(seq) + 1` retried on the constraint**, not a
  check-then-write and not a Postgres sequence (which cannot reset per business
  day). Twelve simultaneous checkouts get 1–12 in a test; the loser of each
  race re-reads the maximum, because a cached one would collide again.
- **`statusToken` is 24 random bytes, base64url** — 192 bits, comfortably past
  P1-5's ≥128. A token collision is handled by the same retry as a `seq`
  collision rather than by a separate path.
- **A tampered client total places the order at the server's price and writes a
  `total_mismatch` event.** The mismatch is evidence, never an input: the order
  is correct and the tampering is visible, which is what P0-2 asks for.
- **Placement refuses with the whole `CartReview` attached**, so checkout can
  point at the line that is 86'd rather than at the order. Same reasoning as
  `reviewCart` reporting every problem at once.
- **The confirmation returned to the client carries no order UUID** — order
  number, name, status token, totals and lines. An id that never leaves the
  server cannot leak into a URL someone shares (P0-8).
- **The re-check and the write are NOT one transaction** (recorded in WRITEUP as
  a deliberate ceiling). An 86 landing in the milliseconds between them is
  snapshotted anyway — and that order is indistinguishable from one placed a
  second before the 86, which no isolation level prevents either. The
  operational answer already exists: staff cancel with reason `out_of_item`.
  This deviates from C-005's note that placement would re-check "inside the
  transaction"; locking the menu rows on every checkout buys a millisecond of a
  window that stays open for minutes regardless.
- **`seedSettings` joins the test helpers.** `loadSettings` throws rather than
  defaulting, so every placement test seeds the singleton row — which is the
  behaviour that keeps a missing row from becoming a silent 0% tax.

**Left behind:**
- **No checkout screen.** `placeCartOrder` has no caller until C-007 builds the
  menu and the cart UI; the client-side disabled submit button (P0-10's second
  criterion) belongs to that session. The server guarantee holds without it,
  which is the point.
- **No confirmation or status page.** `statusToken` is issued and returned;
  C-014 renders the page behind it.
- **The checkout gate (P0-6) is not consulted.** Placement answers "is this cart
  orderable?", not "is the restaurant taking orders?" — one code path with three
  triggers, in C-011.
- **`paymentState` is always `unpaid`.** Payment is out of scope for P0; the
  column and the `refund` event kind are there for P1-8.
- **The rush script (C-017)** is what proves the number allocation and the
  double-submit under a real 20-minute load. The unit-level version here is
  twelve concurrent placements and two simultaneous double-taps.

C-006 committed and pushed at 34d966b

---

## C-007 — Customer menu and item composer

**Built:**
- `apps/web/app/menu/page.tsx` — categories in menu order, items with base
  prices. `force-dynamic`: an 86 has to reach the menu the moment a manager
  taps it, and a route prerendered at build time goes stale the first time the
  kitchen runs out of anything. A sold-out item is rendered greyed and
  unclickable, never hidden (P0-6).
- `apps/web/app/menu/[itemId]/composer.tsx` — the composer. Non-intensity
  groups render radios (`max === 1`) or checkboxes; intensity-enabled groups
  render a five-way pill per option: **Skip / No X / Light / Regular / Extra**.
  The negation is one of the five, not a separate mechanism, and a negated
  option is struck through on a red row.
- `apps/web/lib/money.ts` — `formatCents`, `formatDeltaCents`. The one place
  money becomes a string. A free option shows no delta at all rather than
  "+$0.00".
- `apps/web/lib/menu-labels.ts` — `describeSelection` returns `{ text, negated }`.
  The words are shared with C-008's kitchen card; the emphasis is not, because
  a card read at arm's length needs more than the cart line does.
- `apps/web/app/cart/page.tsx` — the cart screen: composed lines, per-line
  problems, old → new price confirmation, server-computed subtotal/tax/total,
  remove. Plain `<form action={…}>` server actions, so it works before
  hydration and needs no client component.
- `packages/db/seed.ts` + `db:seed:test`, wired into `pretest:e2e`. The e2e
  specs assert real prices, so they need the same SAMPLE_MENU the unit
  fixtures are hand-calculated against — and `npm test` truncates that
  database on its way through.
- 9 e2e specs (4 behavioural, 3 axe, 2 pre-existing smoke). The composed
  fixture is hand-calculated in the spec header: burrito 1095 + chicken 0 +
  guacamole 250 + cheese-at-extra (50 + 75) = 1470, NO onions free, tax 121,
  total 1591.

**Decided:**
- **The composer calls `validateComposition` and `priceLine` — the same
  functions the cart and placement call.** Not a client-side reimplementation:
  a second answer here is a screen that composes something checkout refuses, or
  quotes a price the server disagrees with. The page hands the client a menu
  scoped to one item and its groups, which is everything those two functions
  read.
- **Add to cart is never disabled for an invalid composition.** It validates on
  click and names what is missing ("Choose your protein."). A greyed-out button
  explains nothing, cannot be focused, and is the reason people email support.
  The server re-validates regardless — the button is UX, the action is the
  gate.
- **Requirement hints show from the start; red messages only after a first
  attempt.** Nagging before the first tap is how a form teaches people to stop
  reading it.
- **The price beside an option is the MENU's delta until it is selected, the
  APPLIED one after.** A negated cheese shows nothing, not "+$0.50" — a price
  the receipt would disagree with.
- **No shadcn, still.** Radios, checkboxes and buttons are native elements
  Tailwind styles. A component library installed for its `<Button>` is
  inventory.
- **The relative imports in `packages/**` lost their `.js` extensions**
  (defect, see WRITEUP). Turbopack does not map `./x.js` onto the `x.ts` beside
  it, and the production build failed the moment a page actually pulled
  `packages/core` in.

**Left behind:**
- **No checkout screen.** The cart totals and says so. Name, phone, the
  idempotency key and the submit belong with the pause/hours gate they have to
  pass through (C-011); placement itself has been built and tested since C-006.
- **No edit-in-place from the cart.** `replaceLine` exists and is tested;
  the cart offers Remove only. Re-opening the composer with a line's selections
  pre-filled is a composer feature, and it is not in P0-3's wording ("editable
  and removable" is satisfied by remove-and-re-add today) — worth revisiting
  when the composer next gets touched.
- **86 toggling has no UI.** The menu and the composer render availability
  correctly from the database; the manager-facing switch is C-012.
- **Nothing polls.** A menu open in a tab while the kitchen 86s an item shows
  the old state until reload. C-009's cursor is the general fix.

C-007 committed and pushed at 7e39b40

---

## C-008 — Kitchen queue view

**Built:**
- `packages/core/orders/queue.ts` — the pure half of the screen: `queueAging`
  (two clocks, see below), `groupQueue` (one group per `QUEUE_STATUSES`, empty
  ones kept), `matchesLookup` (name or order number, one box), and
  `undoRemainingMs`. Nothing reads a clock; `now` is a parameter. 20 tests.
- `packages/db/queue.ts` — `loadQueue()`, one query, statuses taken from
  `QUEUE_STATUSES`. `QUEUE_ORDER` is `ORDER_RECEIPT` plus the single most
  recent event, which is the only extra fact the screen needs.
- `packages/db/transitions.ts` — `applyOrderAction`. The engine decides; this
  writes the status and its events in one transaction, guarded by
  `updateMany({ where: { id, status: <the status that was read> } })`. A count
  of zero IS the concurrency check — two cooks tapping one card is the normal
  case, not the edge case.
- `apps/web/app/kitchen/` — the queue screen, its four server actions, and the
  card controls. Advance is `min-h-16` and full width; every other control is
  `min-h-12`. Sections carry counts, so an empty one still says so.
- `packages/db/seed.ts` grew four orders, PLACED through the real `placeOrder`
  and moved with the real `applyOrderAction` — a hand-written fixture row would
  agree with itself and prove nothing. They cover the P0-11 card (quantity 2, a
  negation, a note), the 15-minute flag, the second no-show mark, and a
  five-line order.
- 10 kitchen e2e specs including axe, the ≥48px sweep over every visible
  control (the cancel disclosure is opened first — a control nobody can see has
  no tap target to measure), and a font-size assertion on the item line.

**Decided:**
- **Two aging clocks, not one.** The card's elapsed time runs from
  `placedAt` — how long the customer has actually been waiting — and it does
  not reset when a cook taps "start cooking". The `ready` no-show flag runs
  from `statusChangedAt`, because cooked food going cold on a shelf is a
  different problem from a slow ticket. C-003's column comment said
  `statusChangedAt` drove both; it drives the second one only.
- **Flags fire AT the threshold, not a minute past it.** `>= 15`, so a manager
  can verify the rule against the clock on the wall.
- **The undo is derived from the event log, not from a client flag.** Same
  discipline as the new-order alert (P0-12): the card moves to another section
  the instant it advances, so a React state flag would be lost with the
  unmounted component. The server computes the milliseconds remaining and the
  client counts that duration down — a duration, never a clock reading.
- **Undo is offered only after a forward advance.** After a revert it would
  walk the order further back, which is not what the word means. The always-on
  "Move back" control is the explicit, logged way to do that.
- **`ADVANCE_LABEL` and `SECTION_LABEL` are `Record<OrderStatus, …>`.** A new
  state does not compile until someone decides what its button and its heading
  say — the same mechanism `STATUS_FACTS` uses, extended to the UI.
- **The walk-up lookup is a plain GET form.** It works before hydration, and
  the result is a URL a second screen can be opened on.

**Left behind:**
- **No staff authentication.** `/kitchen` is reachable by anyone who knows the
  path, and the four server actions take an order id from the client. That is a
  scope line, not an oversight — recorded in the write-up, and the first thing
  a real deployment would need.
- **Nothing polls.** The queue is only as fresh as the last tap or reload; the
  aging minutes freeze between renders. C-009's server-issued cursor is the fix
  and the reason this screen was built to re-render from state alone.
- **No chime, no flash.** A `placed` card is styled like the others beyond its
  section heading. C-010 adds the alert — the state it derives from
  (`STATUS_FACTS.placed.alerts`) is already there.
- **`paymentState` is never moved to `refunded`.** The engine writes a refund
  event when a cancelled order was `paid`; nothing sets `paid` yet (P1-8), so
  advancing the column would be an untested branch on behalf of a feature that
  does not exist.
- **No cancel reason on the customer's side.** The reason and note are stored
  and logged; the distinct cancelled view is C-014's.

C-008 committed and pushed at 41fbc35

## C-009 — Polling with a server-issued cursor

**Built:**
- `packages/db/queue.ts` — `queueCursor()`. One aggregate over the append-only
  event log returning `<count>.<newest instant>`. Opaque to the client, which
  does nothing but echo it back.
- `apps/web/app/api/updates/route.ts` — the changes-since endpoint. Takes the
  echoed cursor, returns `{ cursor, changed }` and nothing else. No order data,
  no client clock, `Cache-Control: no-store`.
- `apps/web/lib/live-updates.tsx` — `<LiveUpdates cursor active />`. Renders
  nothing; polls every 5s, calls `router.refresh()` when the cursor moved, and
  does not fetch at all while `document.hidden`. Returning to the tab polls
  immediately rather than waiting out the interval.
- `apps/web/app/kitchen/page.tsx` — reads the cursor, then the queue, then
  mounts `<LiveUpdates />`. Four lines; the screen was already built to
  re-render from state alone (C-008), which is what made this the whole change.
- `packages/db/queue.test.ts` — four cursor tests: stable while idle, moves on
  a placement, moves on an advance, and moves for a second event written at the
  *same instant* as the first. Two e2e specs: a change made on a second screen
  arriving without a reload (proved by a `window` marker surviving), and a
  backgrounded tab issuing zero requests over more than one interval.

**Decided:**
- **The cursor is the log's TIP, not a position to read forward from.** A
  `WHERE at > cursor` range query has a lost-update window — a row whose `at`
  is older than the issued cursor but which commits after it is never seen.
  Comparing the tip string has no such window, because that row still moved the
  tip. What it gives up is the ability to say *what* changed, which nothing on
  this screen needs.
- **It carries a count as well as an instant.** Two cooks tapping two cards in
  the same millisecond is a rush, not a fiction; without the count the second
  tap is invisible. There is a test that writes both events at one instant.
- **The endpoint answers a question; it does not ship the queue.** `changed:
  true` makes the client re-run the server component. That keeps ONE renderer
  for a queue card instead of a second copy of it in a client bundle — and it
  is exactly the payload a WebSocket would push, which is what the PRD means by
  "the transport swaps, not the logic".
- **Cursor read BEFORE the queue.** An event landing between the two reads then
  makes the cursor older than what was rendered, costing one spurious refresh.
  The other order makes it newer, and the change goes unseen until the next
  one. One wasted render beats one missed order.
- **The idle refresh is counted in ticks, not milliseconds.** Elapsed minutes
  are server-computed, so a screen that only refreshed on change would print a
  frozen "12 min". Twelve ticks at 5s is a minute — the resolution the number
  is printed at — and no client clock is read to get there.
- **The background pause is on the kitchen screen too.** P0-5 scopes it to the
  customer page; it is the same rule and it was free, so a queue behind a POS
  window asks nobody anything.

**Left behind:**
- **`active` has no consumer yet.** The prop exists so C-014's status page can
  pass `!isTerminal(status)` and stop polling a terminal order, per P0-5. The
  kitchen queue never stops, so that branch ships untested until the page it
  was built for exists.
- **The customer half of P0-5 is C-014's.** There is no status page to poll,
  and the endpoint is queue-scoped: an order-scoped variant (`?token=`) is
  three lines and was left out rather than shipped untested.
- **New orders are rendered, not announced.** The chime and flash are C-010,
  which now has the re-render it needs to fire on.
- **Full-table `count()` per poll.** Free at one restaurant's event volume;
  recorded in the write-up with a sequence column as the upgrade.

C-009 committed and pushed at a7caee3

## C-010 — New-order alert and acknowledge

**Built:**
- `apps/web/app/kitchen/new-order-alert.tsx` — `<NewOrderAlert count />`. Takes
  a count of un-acknowledged orders, chimes on arrival and every 6 seconds
  after, and renders an `aria-live="assertive"` banner naming the tap that
  clears it. A blocked autoplay policy surfaces as a "this screen is muted"
  button rather than as silence.
- `apps/web/app/globals.css` — `alert-pulse`: a 1.2-second box-shadow ring,
  well under the three-flashes-a-second seizure threshold, switched off under
  `prefers-reduced-motion`.
- `apps/web/app/kitchen/page.tsx` — the count, derived from
  `needsAcknowledgment` over the **unfiltered** queue; the card's own styling
  and a "NEW — not yet accepted" badge.
- `apps/web/e2e/kitchen.spec.ts` — five specs: it chimes and keeps chiming, it
  goes silent on Accept, it survives a reload, a name lookup cannot silence it,
  and the alerting screen still passes axe. The AudioContext is stubbed in the
  page and its oscillators counted — nothing test-only ships in the component.

**Decided:**
- **Nothing new in `packages/core`.** `ALERT_STATUSES`, `needsAcknowledgment`
  and `acknowledge` were written in C-004 against this requirement, and the
  Accept button has been `placed → accepted` since C-008. The alert had exactly
  one thing left to do — be heard — so that is all this item added.
- **The count comes off the unfiltered queue.** A cook who has typed a name
  into the P0-11 lookup box is still the person who has to hear the next order
  land. An alert a search can silence is one that gets silenced during exactly
  the rush it exists for. There is a spec for it.
- **There is no mute and no dismiss.** The only thing that stops the chime is
  the transition. A dismiss button is how an order gets silenced without anyone
  cooking it, which is the failure this requirement is named after.
- **A blocked chime is shown, not swallowed.** Browsers start an AudioContext
  suspended until a user gesture, so a wall-mounted screen nobody has touched
  would otherwise deliver the exact silence P0-12 exists to prevent. The
  component checks `ctx.state` after resuming and renders a button when it is
  still not running.
- **The badge carries the meaning; the pulse is the second signal.** Motion as
  the sole carrier disappears for anyone who turned motion off, which is why
  the reduced-motion rule can stop the animation dead without losing anything.
- **Un-acknowledged outranks "running late" on a card.** Both are urgent; only
  one of them names the tap that fixes it.
- **The effect is keyed on the count.** A second order arriving while the first
  is still un-acked restarts the cycle and rings immediately, rather than
  waiting out an interval that is already half spent. The 60-second idle
  re-render does not re-ring, because the count did not change.

**Left behind:**
- **One banner and one chime, however many orders are waiting.** The count is
  read aloud; the orders are not distinguished. Per-order sounds in a kitchen
  are noise, not information.
- **The chime is synthesised, so there is no volume control and no
  per-restaurant sound.** Both are settings-screen work, and there is no
  settings screen until C-011.
- **A kitchen with no screen open hears nothing.** The alert is per-screen and
  client-side; there is no server-side page or SMS. That is P1-3's outbox.
- **The rush demo still has to prove it.** P0-12's third criterion is that
  alerts fire and are acknowledged during the seeded rush, which is C-016.

C-010 committed and pushed at 354d1a8

## C-011 — The checkout gate

**Built:**
- `packages/core/orders/checkout-gate.ts` — `checkoutGate(state, clock)`. ONE
  function, five refusal reasons, three triggers feeding it. Returns the
  customer-facing sentence, so no screen composes its own.
- `packages/core/orders/business-day.ts` — `restaurantClock(now, tz)` returning
  `{ day, weekday, minuteOfDay }`. One `Intl` call, and now the only place an
  instant becomes a local wall-clock reading; `businessDayOf` derives from it.
- `packages/db/prisma/migrations/…_checkout_gate/` — five gate columns on
  `RestaurantSettings`, a `StoreHours` table keyed by `dayOfWeek`, and six
  hand-written CHECK constraints.
- `packages/db/gate.ts` — `loadGateState()`. Settings, hours and the open-order
  count in one round trip; the count comes from `OPEN_STATUSES`.
- `packages/db/placement.ts` — `placeOrder` asks the gate and refuses with
  `ordering_closed`, carrying the trigger.
- `apps/web/lib/checkout-gate.ts` — `currentGate()`, the web layer's single
  call, and the only place the request path reads a clock for the gate.
- `apps/web/app/checkout/` — the checkout page, the form (name, phone, order
  note, idempotency key, receipt), and `GateNotice`.
- `apps/web/app/kitchen/pause-switch.tsx` + `setOrderingPaused` — the manual
  trigger's surface, showing the GATE's answer rather than the switch's own
  position.
- Tests: 24 gate unit tests, 11 clock tests, 11 db tests, 10 constraint tests,
  and 7 e2e specs.

**Decided:**
- **Precedence is manual → calendar → throttle, and it is tested.** P0-6 says
  the manual switch "always overrides", so it is asked first: a cook who paused
  because the fryer died must not be told the reason is that the store is busy,
  nor have their pause lifted when the queue drains. The throttle is asked last
  because it is the only trigger that clears itself, and because "we are
  slammed" is the wrong sentence for someone who arrived after closing.
- **The gate composes the MESSAGE, not just the verdict.** "We open at 11:00
  today", "we stop taking online orders at 20:45" — a screen that only received
  a boolean would have to reconstruct the reason, and the second screen to do
  it would say it differently.
- **A missing `StoreHours` row is a closed day.** A week is configured by
  listing what opens, so a deleted row can never leave a door open.
- **The threshold is `>=`.** A max of 25 means twenty-five open orders is the
  cap; a gate that waits for 26 is a threshold nobody can verify by counting
  cards.
- **The gate is asked AFTER the idempotency replay.** A retry of an order
  already on the grill returns that order — being told the restaurant has since
  closed would be wrong, and the gate is asked about NEW orders only. There is
  a test.
- **Six CHECK constraints, because the gate trusts these numbers.** A settings
  screen is one fat finger from a restaurant open 21:00–11:00, which every
  branch would read as "closed all day, forever" with no error anywhere. The
  constraint makes it a write-time failure instead.
- **The seeded restaurant is open round the clock with a zero-minute cutoff.**
  The schema default cutoff is 15 minutes, which would close the seeded
  restaurant between 23:45 and midnight — a suite that passes all day and fails
  for fifteen minutes before local midnight is a suite nobody trusts again. The
  hours trigger is driven directly in the pure tests, where the clock is a
  parameter.

**Left behind:**
- **One window per day.** `dayOfWeek` is the primary key, so split lunch/dinner
  service is not modelled, and the `closeMinute > openMinute` CHECK forecloses
  overnight service. Both refuse loudly rather than misbehaving quietly.
- **No settings screen for hours, threshold or cutoff.** They are columns with
  sane defaults and constraints; only the pause switch has a UI, because only
  the pause switch is a mid-service action. C-015 is the menu-editing screen
  and the natural home for the rest.
- **The auto-pause threshold has no e2e.** It needs 25 open orders to fire;
  it is unit-tested at the database level, and C-017's rush is where it earns
  a browser test.
- **The confirmation is rendered inline, not at a URL.** The status token is
  printed but the page behind it is C-014's.

C-011 committed and pushed at 347af21

## C-012 — Availability at two grains

**Built:**
- `apps/web/app/kitchen/availability/page.tsx` — the 86 board. Items by
  category, then every modifier group's options, one tap per row, no dialog and
  no save button. Plain `<form action={…}>`, so it works before hydration.
- `setItemAvailable` / `setOptionAvailable` in `apps/web/app/kitchen/actions.ts`
  — the two writes, plus `revalidateMenuSurfaces()`, which names the three
  customer surfaces an 86 has to reach.
- A link to the board from the queue header, next to "Customer menu".
- Tests: 6 e2e specs — the item grain, the option grain with an affected open
  cart, the restore, the placed order that must NOT change, and the
  gloves-and-axe pass.

**Decided:**
- **This item shipped almost no logic, and that is the result.** Both grains
  were already answered by `validateComposition`, and `reviewCart` already
  flagged the lines holding a sold-out option, and `placeOrder` already refused
  the order — so C-012 was the missing *write surface*, nothing more. That is
  the payoff of "one orderability function" stated as a test: adding the 86
  button required no new rule, and there was nowhere for a second answer to
  appear.
- **`updateMany`, not `update`.** A board left open on a wall screen holds ids
  that a later menu edit can delete. `update` throws `P2025` on a missing row,
  which is a 500 in a cook's face mid-rush; `updateMany` changes nothing and
  re-renders the truth.
- **The board is a server component with plain forms.** No client state, no
  optimistic toggle: the row shows what the database says, and the only way to
  see a stale one is to not have pressed the button. An optimistic 86 that
  failed silently would be exactly the wrong lie to tell a kitchen.
- **The e2e asserts the surface that must NOT move.** Placing an order with
  guacamole, then 86'ing guacamole, then reading the kitchen card — the ticket
  still says Guacamole and says nothing about sold out. The snapshot rule has a
  unit-level regression test; this is the same claim at the grain a demo can
  see.
- **The button says what it does, with the name in it.** "Mark Guacamole sold
  out", not a toggle switch — a switch's meaning depends on its current
  position, which is the thing a glance across a kitchen gets wrong.

**Left behind:**
- **No per-item availability override.** 86'ing guacamole 86s it for the
  burrito and the bowl alike, because they share the group object — right for
  stock, wrong for a group reused as a structure device. C-015 (P0-13) owns
  the warning that names the blast radius.
- **No bulk action and no auto-restore.** An 86 persists until someone taps it
  back, including overnight. A "put everything back on" button and an
  end-of-day reset are both settings-screen work.
- **No staff authentication**, the same scope line as the queue: anyone with
  the URL can 86 the menu. Recorded in the write-up.
- **A customer's open tab learns about the 86 on its next render**, not
  instantly — the customer surfaces are `force-dynamic` but nothing polls them
  until C-014. Placement refuses regardless, so the cost is a wasted trip to
  the cart, never a bad order.

C-012 committed and pushed at a2c1ec3

## C-013 — Estimated ready time

**Built:**
- `packages/core/orders/estimate.ts` — `readyEstimate(state)`, the whole of
  P0-7's arithmetic: `prepBaseMinutes + prepPerOrderMinutes × openOrderCount`,
  rounded down to a five-minute step and widened by ten into a range, with a
  one-step floor. Pure, no clock, no database.
- Two settings columns (`prepBaseMinutes` 12, `prepPerOrderMinutes` 1) and a
  hand-written migration adding the CHECK constraints that keep them sane.
- `loadGateState` now returns them, so the gate and the estimate come off ONE
  read; `currentCheckout()` in `apps/web/lib/checkout-gate.ts` returns both,
  and `currentGate()` is a thin call through it for the three screens that only
  want the gate.
- The estimate line on the checkout page, rendered only while the gate is open.
- Tests: 6 unit specs on the range arithmetic, 2 e2e (a range is shown; the
  pause message replaces it), 2 db constraint specs, and the `loadGateState`
  assertion that the prep numbers ride along on the same read.

**Decided:**
- **The estimate reads the same count as the throttle, from the same query.**
  Both answer "how busy are we?" over `OPEN_STATUSES`. Two loads would let the
  checkout quote a ten-minute wait off a count the auto-pause had already moved
  past — the same screen saying "we are at capacity" and "ready in 10 min".
- **A range, and the low end rounds DOWN.** `Math.floor` to the five-minute
  step, then `+10`. The low number is the one a customer hears as the promise,
  so the arithmetic must never round it later than it really is. 19 minutes is
  sold as "15–25", never "20–30".
- **The "no estimate while paused" rule lives at the call site, not in the
  function.** It is the same decision as "show the pause message": the checkout
  renders `<GateNotice>` *instead of* the estimate. Baking a gate check into
  `readyEstimate` would have been wrong for C-014 — an order already cooking
  still has a ready time after the restaurant stops taking new orders.
- **The range width and the rounding step are constants, not settings.** P0-7
  makes two numbers configurable — how long food takes. How vague we are about
  it is a product decision, and a settings screen offering "range width" is an
  invitation to set it to zero and start promising exact minutes.
- **A one-step floor, so the estimate can never say "now".** A misconfigured
  zero base reads as "5–15 min", not "0–10".

**Left behind:**
- **The estimate is not polled at checkout.** P0-7 says "recalculated on each
  poll"; the checkout page recalculates on every render (`force-dynamic`) and
  has no poller. C-014's status page has one and is where that half lands.
- **Count-based, not weight-based.** Ten bags of chips read exactly like ten
  catering bowls (P1-7, already deferred by decision).
- **No settings UI.** Same line as the gate's hours and thresholds — columns
  with defaults and constraints, changed by a migration. C-015 is the screen.
- **The confirmation does not repeat the estimate.** After placement the cart
  is empty and the line is gone; the customer's ready time lives on the status
  page C-014 builds behind the token already printed on the receipt.

C-013 committed and pushed at 17924aa

## C-014 — Customer status page

**Built:**
- `apps/web/app/status/[token]/page.tsx` — the page behind the token printed on
  the receipt. Order number and name, a status banner whose copy comes from a
  `Record<OrderStatus, …>`, the remaining-time estimate, the order's own lines
  and its subtotal/tax/total, and a distinct cancelled view carrying the reason
  in the customer's words. Rendered entirely from the snapshot: no menu table
  is touched, and the internal UUID never reaches the page.
- `findOrderByStatusToken` in `packages/db/placement.ts`, beside
  `findOrderByIdempotencyKey` and sharing `ORDER_RECEIPT` — the same shape the
  confirmation renders, so the two cannot drift.
- `remainingEstimate(estimate, elapsedMinutes)` in
  `packages/core/orders/estimate.ts`: the C-013 window with the time already
  spent taken off it, null once the low end reaches zero. Both estimates now
  build their label through one `range()` helper.
- `LiveUpdates` is mounted with `active={!isTerminal(order.status)}` — the prop
  C-009 added for exactly this — so a picked-up or cancelled order stops asking.
- The receipt's `<code>/status/…</code>` placeholder is now a real link.
- Tests: 6 unit specs on `remainingEstimate`, 5 e2e (the link opens the right
  order; an unknown token is a 404; the status moves under the customer with no
  reload; the cancelled view with its reason and zero polls after it; axe).

**Decided:**
- **The token is the key, and the order number deliberately is not.** #047 is
  guessable by construction — it is a counter — so a page keyed on it would
  hand out the day's orders to anyone who could count. A bad token and a
  deleted order return the same 404, so a probe cannot confirm what exists.
- **`robots: { index: false }`.** A link that is secret only because it is
  unguessable stops being secret the moment a crawler files it. Real hardening
  (expiry, revocation) is P1-5 and deferred; one line of metadata is not.
- **The estimate is the checkout's window minus the time already spent, and it
  goes null rather than counting to zero.** "0–10 min" is a promise about the
  past. Below the low end the page says "any minute now", which is the only
  honest thing left to say (P0-7: never a precise wrong number).
- **The status page never asks the gate.** C-013 put that rule at the call
  site for this reason: an order already cooking still has a ready time after
  the restaurant stops taking new ones. The checkout renders the pause message
  instead of an estimate; this page does not.
- **Which statuses get an estimate is `isOpen`, not a list.** Exactly
  placed/accepted/preparing — asked of the status module, so a new state cannot
  quietly acquire or lose a time promise.
- **Two wordings for one cancel reason.** Staff pick "Out of an item"; the
  customer reads "The kitchen ran out of something in this order." Same enum,
  two `Record<CancelReason, string>` tables, because a kitchen note is not an
  apology. The `other` note is appended verbatim — it is the only reason that
  requires one.
- **Options render as a flat list here, grouped on the kitchen card.** The
  kitchen reads "Salsa: chipotle, NO onions" at arm's length; a customer
  checking their own order reads the selections. The negation stays visually
  distinct on both — this is the screen they verify us against.

**Left behind:**
- **One global polling cursor, so every event re-renders every status page.**
  The cursor is the tip of the whole event log; a customer's page refreshes
  when a stranger's order advances. Correct, and wasteful in a rush.
- **The estimate can move outwards after placement.** It is recomputed from
  the current queue, not frozen at placement, so a customer 4 minutes in can be
  told "16–26 min" when they were quoted "10–20". That is the honest direction
  and the alternative is a countdown that lies.
- **A revert on a terminal order is invisible to the customer.** Polling stops
  at `picked_up`; a cook's undo puts the order back to `ready` and the page
  already stopped asking. `cancelled` has no revert, so this is only the
  fat-fingered pickup.
- **No customer cancel button**, though `cancellableByCustomer` is true while
  `placed`. Not in C-014's scope; the state machine is ready for it.
- **No link recovery.** Lose the URL and the order is unreachable from the
  customer side — the phone number captured at checkout is P1-3's channel, not
  a lookup.

C-014 committed and pushed at 40c835d

---

## C-015 — Safe menu editing

**Built:**
- `apps/web/app/kitchen/menu/page.tsx` — the editor. Item base prices, modifier
  deltas, and each group's name/min/max, all on one screen, all going through a
  confirm step before anything is written.
- `apps/web/app/kitchen/menu/actions.ts` — `saveItemPrice`, `saveOptionPrice`,
  `saveGroup`, `deleteGroup`. Each re-parses and re-checks its own arguments;
  the confirm panel is UX, not the guard.
- `parsePriceInput` in `packages/core/pricing/pricing.ts` — a typed price
  ("15", "$15", "-1.50", "−1.50") to integer cents, or null.
- `apps/web/lib/revalidate-menu.ts` — the list of surfaces a live-menu change
  has to reach, extracted out of `kitchen/actions.ts` so the 86 board and the
  editor cannot drift apart on it.
- `apps/web/e2e/menu-editing.spec.ts` — 11 specs, the whole file at a 390×844
  viewport.

**Decided:**
- **The confirm step is a URL, not client state.** `?edit=item:burrito&price=…`
  renders a confirm panel instead of the list. It survives a reload, works
  before hydration, and re-reads the CURRENT price from the database on every
  render — so a panel left open through someone else's edit shows the real old
  value rather than one captured at click time. A `confirm()` dialog would have
  been one line and none of that.
- **Old → new, side by side and large, is the entire defence against the
  fat-finger.** $1.50 → $15.00 is a perfectly valid price; no parser can catch
  it. `parsePriceInput` exists to stop a typo becoming a plausible NUMBER, not
  to stop it being the wrong one.
- **Parsed off the string, never `parseFloat(x) * 100`.** 15.10 in binary
  floating point is 1509.9999…, so the multiply-then-round route puts a real
  menu price a cent low by luck of the value. The regex is also the validation:
  "1.5.0", "1,50" and "" are null, not NaN silently becoming 0.
- **Negative deltas stay legal; negative item prices do not.** "Small −$1.50"
  is a discount the menu already ships. An item that pays the customer to order
  it is a typo every time.
- **One form, two submit buttons, for the group row.** `<button name="edit"
  value="delete-group:…">` — the submitting button's own name/value picks which
  confirm panel opens. Nested forms are illegal HTML and a second form would
  have needed the fields duplicated.
- **The affected-items list is derived from `loadMenu`, not a second query.**
  Items whose `modifierGroupIds` contain the group. A separate "who uses this"
  query is the thing that drifts from what the composer actually renders.
- **Always the full list, never a count.** The manager has to recognise the
  item they had forgotten about; "affects 2 items" is not that. The amber
  shared-warning styling is what turns on at two or more.
- **Deleting a group deletes the joins first, in one transaction.**
  `ItemModifierGroup.group` is `onDelete: Restrict`, so the database refuses to
  let this happen as a side effect — which is the schema comment from C-003
  paying off exactly where it said it would.
- **Cancel is a link, not a second submit button.** Leaving without saving must
  never be one mis-tap away from saving on a 390px screen.
- **The whole e2e file runs at 390×844, not one spec.** The between-rush device
  is a phone; a desktop-viewport suite proves nothing about this screen. The
  spec asserts zero horizontal overflow, ≥48px on every button and text field,
  and axe-clean on both the list and the confirm panel.

- **Only the MIN is bounded by the option count.** A min above it makes the
  item unorderable; a max above it is slack the seeded Fillings group already
  ships (min 2, max 4, three fillings). The first version of the guard had this
  exactly backwards — see the write-up.

**Left behind:**
- **No add, no delete, no reorder for items, categories or options.** P0-13 is
  about editing SAFELY, and the seed owns the menu's shape. Adding a row has no
  destructive-edit problem to solve, which is why it is not here.
- **`extraPriceDeltaCents` is not editable.** The intensity surcharge is a
  price the editor cannot reach; it comes from the seed. Same confirm panel
  would serve it.
- **No optimistic-concurrency check on save.** Two managers confirming stale
  panels at once: last write wins. The panel re-reads on render, so the window
  is the seconds between confirm and save, not minutes.
- **A price edit does not warn about carts already holding the item.** It does
  not need to — `reviewCart` re-prices at checkout and the customer sees the
  new total before placing. Nobody is charged a price they did not see.
- **No staff authentication**, same standing scope line as the rest of
  `/kitchen`. Anyone who knows the path can reprice the menu.

C-015 committed and pushed at 70f7f83

---

## C-016 — Sales report

**Built:**
- `packages/core/orders/report.ts` — `salesReport(orders, timezone)`. Pure, no
  clock: day and hour buckets in the restaurant's calendar, top sellers,
  modifier attach rates, no-show rate, and an in-flight count.
- `salesRole` on `STATUS_FACTS`, plus `SOLD_STATUSES` / `NO_SHOW_STATUSES` /
  `salesRoleOf` — the report derives what counts from the ONE status module.
- `instantDaysBefore(now, days)` in `packages/core/orders/business-day.ts` —
  the report window's lower bound, and the only `no-restricted-syntax`
  exemption in the codebase.
- `packages/db/report.ts` — `loadReportOrders(since)`, a `select` naming only
  snapshot columns.
- `apps/web/app/kitchen/report/page.tsx` — the screen, with a 1/7/30/90-day
  window selector.
- 22 new engine tests, 5 database tests, 6 e2e.

**Decided:**
- **`salesRole` is a field on `STATUS_FACTS`, not a list in the report.** Four
  values — `sold`, `no_show`, `cancelled`, `in_flight` — so a new state cannot
  ship without deciding which one it is. A boolean pair would have let a state
  be neither, and a list in `report.ts` is the grep-not-compiler failure the
  "one status module" invariant exists to prevent.
- **Only `picked_up` is revenue.** A cancelled order counts toward nothing, a
  no-show only toward its own rate, and an order still on the pass toward
  `inFlight` — which is DISPLAYED, so a midday report explains its own missing
  money instead of quietly under-reporting.
- **The no-show rate is null, not 0, when nothing has finished.** A rate over
  zero orders is unknown. A screen printing "0% no-shows" on an empty day is
  lying, and it is the kind of lie an owner acts on.
- **A negation is never an attach.** `intensity === 'none'` is skipped when
  counting. "42% of burritos add onions", read off a column of people REMOVING
  them, is the phone-transcription bug in report form — asserted in the engine
  tests, the database tests and the e2e.
- **The attach denominator is units of the item, not orders.** A line of 3
  burritos with guacamole is 3 attached of 3, not 1 of 1. And the bowl's
  guacamole is its own row: an option is rated against its own item.
- **The window is an INSTANT range; the buckets are the restaurant's
  calendar.** Turning "the last 30 days in Los Angeles" into a pair of instants
  is the local → instant direction `business-day.ts` refuses to take, because a
  DST boundary makes it ambiguous. So the query is generous and the engine is
  exact. The cost is a partial oldest day, which the screen states.
- **The attach key is `JSON.stringify` of the tuple, not a delimiter.** A group
  or option name can contain any character a manager can type; there is no
  separator that is safe, so the key does not use one. There is a test with a
  quote in an item name.
- **Grouped by the snapshot NAME, so a rename splits the history.** The honest
  answer without joining a menu table, and a real ceiling — in the write-up.
- **A bar chart of divs.** At most 24 rows on one screen; a charting dependency
  would be a thing to keep patched forever for that.

**Left behind:**
- **A renamed item reports as two rows.** Grouping by `menuItemId` and showing
  the most recent snapshot name would merge them without a menu join, but it
  makes "which name wins" a decision, and the ids are documented as correlation
  only.
- **No CSV export, no printing, no date-range picker.** Four fixed windows.
- **Every report is a full scan of the window.** No aggregate is precomputed —
  fine at one restaurant, wrong at a chain, and the fix is a materialised daily
  rollup, not an index.
- **Revenue is placed-price revenue, not money collected.** `paymentState` is
  P1-8 and unread here; an unpaid picked-up order counts in full.

C-016 committed and pushed at 667158e

## C-017 — The seeded rush

**Built:**
- `packages/db/rush.ts` — the rush itself: 30 orders arriving across 20
  minutes, a 45-minute kitchen tail, and the five ugly cases the PRD names.
  Declarative (`RUSH_ORDERS`, `COMPOSITIONS`, a default cadence with
  per-order overrides), executed minute by minute.
- `packages/db/rush.test.ts` — 15 tests, one describe block per ugly case plus
  the three lagging Success Metrics.
- `packages/db/rush-demo.ts` and `npm run demo:rush` — the same run, narrated:
  ugly cases, final statuses, time-in-state and the day's sales.
- `packages/core/orders/time-in-state.ts` — `timeInState(events, now)` and
  `timeInStateReport(orders, now)`, derived from the append-only event log.
  9 unit tests.
- `packages/core/orders/business-day.ts` — `instantMinutesAfter(instant, n)`,
  extracted once four files had grown the same UTC-field expression. 4 tests.
- `packages/core/menu/sample-menu.ts` — grown to the PRD Measurement Method's
  25 items and 8 modifier groups across 5 categories. The original 4 items and
  6 groups are byte-identical.

**Decided:**
- **Simulated time, not wall-clock.** Twenty minutes of service runs in under a
  second because every call takes its instant as a parameter. That is the
  payoff for "nothing in `packages/core` reads the clock", not a workaround for
  it — a rush that had to run at 1× could not be a test at all, and the demo
  would be a thing nobody waits for twice.
- **Everything goes through the real paths.** `placeOrder` for placements,
  `applyOrderAction` for every move, the settings row for the pause, the
  `available` column for the 86. Rows written directly would agree with
  themselves and prove nothing — the same reason `seed.ts` places its orders.
- **The script throws on any refusal it did not script.** An unexpected
  `option_unavailable` or a gate bounce kills the run naming the customer,
  rather than delivering 28 orders and reporting 30. That guard is what lets
  the rush run under the SHIPPING throttle default (25 open orders) instead of
  a raised one: if the rush ever stops fitting, it says so.
- **Orders sharing an arrival minute are submitted concurrently.** Minute 11
  takes three at once. The `(businessDay, seq)` unique constraint and its retry
  loop are the point — a rush of sequential awaits would never touch them, and
  the Success Metric is about *concurrent* placements. The cost: which name got
  which number inside a minute is not deterministic, so the test asserts the
  set of numbers is exactly 1..30, never a name-to-number mapping.
- **Time in state is derived from the event log, never from
  `statusChangedAt`.** That column holds one instant and can only answer "how
  long has this been ready?". Rae Sutton's ticket was advanced by mistake and
  sent back, so it visited `preparing` twice — 5 minutes then 3 — and only the
  append-only log still knows that. It is the concrete reason undo is a logged
  revert rather than an overwrite.
- **Terminal states do not accrue.** An order picked up half an hour ago has
  not been "in `picked_up`" for half an hour; it is done. Unfinished orders run
  their last span to `now`.
- **An average is over the orders that ENTERED the status.** 29 orders reached
  `ready`; the cancelled one must not drag the mean toward zero. A status
  nothing visited reads null, not 0 — the same rule as C-016's no-show rate.
- **The hand tally is written out in a comment and hard-coded.** `placed`
  30 × 1, `accepted` 30 × 2, `preparing` 27 × 8 + 12 slow + 3 + 4 + 8 = 243,
  `ready` 27 × 3 + 33 + 4 = 118. Deriving the expectation from the same table
  the script runs would agree with a bug; the PRD asks for a HAND tally and
  that is what the arithmetic in the comment is.
- **The cadence is uniform on purpose, with an explicit `slow` column.** Every
  order is accepted at +1 and starts cooking at +3, which is what makes
  `placed` and `accepted` flat across all thirty and the tally checkable on
  paper. The 12 minutes of variation are five named tickets.
- **The menu grew by ADDING.** The new 21 items only compose existing groups
  plus the two new ones; not one of the four original items or six original
  groups moved. Every hand-calculated price fixture in `packages/core` is
  priced against those rows, and growing the menu by editing them would have
  quietly rewritten the arithmetic the suite checks.
- **`salsa` stays on exactly two items and `fillings` on exactly one.** C-015's
  shared-group warning asserts "Shared — affects 2 items" and "Affects 1 item:
  Taco plate" by name. New items deliberately route around both groups.
- **New item names avoid containing an existing option name.** "Chips & guac",
  not "Chips & queso" — Playwright matches accessible names by substring and
  case-insensitively, so a "Chips & queso" item would make every `Queso`
  locator in the availability suite ambiguous. A naming rule, enforced by
  nothing but this note and the suite going red.
- **The demo anchors an hour ago; the test pins a fixed instant.** A demo wants
  to be today so `/kitchen/report`'s one-day window has something in it; an
  assertion wants to be the same day forever.

**Left behind:**
- **The rush leaves the queue EMPTY.** All 30 orders reach a terminal state by
  minute 45, which is the headline result — but it means `npm run demo:rush`
  followed by `/kitchen` shows nothing, and the payoff screen is
  `/kitchen/report`. A variant that stops at minute 20 would leave a queue full
  of live cards; that is a flag on the demo, not a second script.
- **The auto-pause threshold is never triggered by the rush.** The peak is
  around 16 open orders against a default of 25. Manual pause is the scripted
  trigger; the threshold has its own tests in `gate.test.ts`.
- **`slow` pushes ready and pickup together.** No ticket is cooked fast and
  collected late except the no-show, so the `ready` column is 3 minutes for 27
  of the 30. A real service has a much fatter tail there.
- **No time-in-state SCREEN.** The tally is a function, a test and a line of
  demo output. Putting it on `/kitchen/report` beside the sales numbers is a
  small piece of work nobody has asked for yet.
- **Nothing asserts what the kitchen queue LOOKED like mid-rush.** The rush is
  asserted at the database grain; the screens are covered by their own e2e
  specs against the ordinary seed. A Playwright run driving the 20 minutes
  would be the real capstone demo and is a project of its own.

C-017 committed and pushed at 5442b5b

## C-018 — The write-up, finished

**Built:**
- `docs/WRITEUP.md` — the four sections marked "Reserved for the end" now
  written, plus the two that had said "Filled in as phases land" since C-001.
  470 lines.

**Decided:**
- **The hardest bug is the one that was green everywhere.** C-007's `.js`
  specifiers resolved under `tsc`, under vitest, under tsx and under ESLint,
  and failed only in Turbopack — for code that had been merged, tested and
  type-checked for three sessions without ever being COMPILED, because a
  server action no rendered page imports is in no bundle. The other candidates
  were all found by a test doing its job; that one was found by a timeout
  naming a port.
- **C-017 gets a Defects entry that records finding nothing.** Fourteen of
  fifteen assertions passed on the first run of the largest piece of behaviour
  in the project, and the fifteenth was a typo in the test. That is evidence
  about the unit suite, and worth writing down as such rather than as a
  brag — an integration test written first would have been the only thing
  failing and the worst place to debug any of it.
- **The two C-015 defect entries were appended past the end of the file** by a
  previous session, sitting under "By the Numbers". Lifted back into "Defects
  Found" where they belong; nothing was reworded.

**Left behind:**
- **The live-demo line still reads `_(Vercel, later)_`.** Deploying is a
  decision about hosting a real database, not a write-up task.
- **"By the Numbers" counts itself.** The documentation line is approximate by
  construction and marked `~`.

C-018 committed and pushed at d183641

## C-019 — Stopping the rush mid-service

**Built:**
- `runRush(anchor, untilMinute)` — the loop stops where it is told. Default
  unchanged (`RUSH_END_MINUTE`), and `RushResult` now carries `untilMinute`
  and an `end` that reflects it.
- `npm run demo:rush -- --until 12`, and `npm run demo:rush:live` as the
  shorthand. The narration only claims the ugly cases that have actually
  happened by the stop, and says how long the no-show has been on the shelf
  instead of announcing an abandonment that is still 28 minutes away.
- The sales block prints the in-flight count when there is one, so a
  mid-service run reads "0 sold, 22 still in flight" rather than looking like a
  restaurant that sold nothing.
- 3 new database tests, declared LAST in the file with a comment saying why.

**Decided:**
- **Stopping is a TRUNCATION, not a variant.** No second script, no second
  order table, no "live mode" branch anywhere in the rush. The orders that had
  not arrived yet simply have not arrived, and there is a test asserting
  exactly that: at minute 12 the revert count is zero and the pause is off,
  while the 86 and its cancel have already happened.
- **The default is still the full run.** `demo:rush` with no flag is the
  capstone: thirty orders, everything terminal, zero stuck. The live variant is
  for looking at the screen the product is actually about.
- **The mid-service describe is declared last in `rush.test.ts`.** Its
  `beforeAll` re-runs the rush, which truncates the database every test above
  it reads. A describe added after it would silently be looking at a different
  service — the comment says so, because nothing enforces it.
- **The demo's ugly-case narration is derived, not printed.** Each line is
  guarded by the minute its case happens on. A demo that claims a no-show at
  minute 12 is a demo nobody checks twice.

**Found and fixed (a defect the sweep caught, not a C-019 regression):**
- **`status.spec.ts` closed the page that had just issued a cancel.** The spec
  taps "Out of an item" on the kitchen queue and immediately calls
  `kitchen.close()`, then loads the customer's status page expecting
  `cancelled`. Closing a page aborts an in-flight server action exactly the way
  a `goto` does, so the cancel never landed and the customer's page rendered
  `placed`. It had passed for two sessions on timing alone.
  *Fix:* assert the write's own receipt — a cancelled order leaves the queue,
  so `expect(kitchen.getByText('Jordan Vale')).toHaveCount(0)` — before
  closing. This is the THIRD instance of the same defect class in this project
  (C-014's `goto` racing the cart cookie, C-015's racing a price save); the
  first two are already in the write-up with the rule stated. What is new is
  that `page.close()` is a member of that class and nobody had said so.

**Left behind:**
- **`--until 12` is a hard-coded choice of "mid-service".** Minute 12 has all
  four queue states populated and 22 open orders, which is what makes a
  screenshot; nothing computes that, it was picked by looking.
- **Still nothing asserts what the queue LOOKED like.** The mid-service run
  makes a Playwright walk of the rush possible for the first time — there is
  finally a database state with live cards in it — but that spec is not
  written.

C-019 committed and pushed at 5a70972

## C-020 — Time in each state, on the report screen

**Built:**
- `packages/db/report.ts` — `loadStatusTimelines(since)`, one timeline per
  order in the window, selecting only `at` and `toStatus`.
- `apps/web/app/kitchen/report/page.tsx` — a "Time in each state" section:
  state, orders, average, total, using the same `Table` the rest of the report
  uses.
- `apps/web/lib/status-labels.ts` — `STATUS_LABEL`, lifted out of the kitchen
  queue so both screens call a state the same thing.
- 3 database tests, 2 e2e.

**Decided:**
- **Terminal states are not rows.** `picked_up`, `cancelled` and `abandoned`
  total zero by construction — the tally stops accruing at a terminal event —
  so printing "0.0 min" for them reads like a measurement rather than like
  arithmetic that cannot come out any other way. The filter is
  `!isTerminal(status)`, derived from the status module, not a written-out list.
- **The section renders even when nothing sold.** Every other block on the page
  lives inside the "no orders were picked up" branch; this one does not,
  because a report run mid-service has no sales and a queue full of orders, and
  how long they have been sitting is exactly the number worth reading then.
- **Unfinished orders count up to `now`, and the screen says so.** A busy lunch
  genuinely reads longer than a finished one. Hiding open orders would make the
  number stable and wrong; the honest answer needs one sentence of explanation
  and gets it.
- **The average's denominator is orders that ENTERED the state.** Four seeded
  orders were placed, three reached accepted, two preparing, one is on the
  shelf — so the "orders" column is a funnel, and the e2e asserts exactly those
  four numbers.
- **`STATUS_LABEL` moved rather than being copied.** The kitchen queue already
  had a `Record<OrderStatus, string>`; a second copy on the report is the same
  "two ways to say one thing" failure the status module exists to prevent, one
  layer up. A cook reading "Ready for pickup" on the queue and "ready" on the
  report has to work out they are the same row.
- **Durations switch to hours past 90 minutes.** A 90-day window's total in
  `preparing` is five figures of minutes, which is a number nobody reads.

**Left behind:**
- **No per-item or per-hour breakdown of time in state.** One row per state
  over the whole window. "Tuesdays are slow between 12 and 1" is the question
  a manager actually has, and it is a bucketing pass away.
- **The tally re-reads every event in the window on every page load.** Same
  ceiling as the rest of the report: fine at one restaurant, wrong at a chain,
  and the fix is a rollup rather than an index.
- **A long-open order dominates its column.** The seeded no-show sitting ready
  for 33 minutes moves the `ready` average more than the other 27 orders
  combined. A median would be more honest and is not what "average" means.

C-020 committed and pushed at 0d8407a

## C-021 — Editing a cart line in place

**Built:**
- An `Edit` link on every cart line → `/menu/<itemId>?line=<lineId>`.
- `apps/web/app/menu/[itemId]/page.tsx` resolves that line from the cart cookie
  server-side and hands the composer an `editing` prop.
- `Composer` takes `editing?: { lineId, composition }`: pre-filled state, a
  "Save changes" button, a back link to the cart, and `updateCartLine` instead
  of `addToCart` on submit.
- 2 e2e tests.

**Decided:**
- **The line id travels in the URL; the composition never does.** The query
  string names WHICH line, and the server reads what is in it from the cookie.
  A composition in a query string is a composition the client wrote, and this
  screen already has a rule about that.
- **`replaceLine`, not remove-then-add.** It keeps the line where it sat. A
  customer who edits the first of three lines and finds it at the bottom is
  looking at a different cart than the one they were reading — asserted by an
  e2e that edits the burrito with chips behind it and checks the order.
- **A stale or mismatched `?line=` composes a fresh one.** A line removed in
  another tab, or a line id belonging to a different item, falls through to an
  ordinary Add — no error page, no 404. Saving a bowl's line id under
  `/menu/burrito` would silently change what the customer ordered, so the guard
  is `line.composition.itemId === item.id` and there is a test for the stale
  case.
- **Pre-filled via `useState`'s initial value, not an effect.** The first
  render is already correct. An effect would paint an empty composer and then
  fill it in under someone's thumb.
- **No new server action.** `updateCartLine` has existed and been exported
  since C-005 with no caller, and `replaceLine` under it has been unit-tested
  just as long. This item is a screen, not an engine change.

**Found on the way (harness, not product):**
- **A `beforeEach` seed failed once and told us nothing.** One sweep failed in
  `menu-editing.spec.ts` with the entire diagnosis being `Error: Command
  failed: npm run db:seed:test`. The seed runs clean standalone and the next
  sweep was green, so it is a race — most likely the seed's `TRUNCATE` losing a
  lock to an in-flight `/api/updates` poll from a page a previous test left
  open, which is exactly the kind of thing you want the message for.
  *Fix:* one `reseed()` helper in `apps/web/e2e/reseed.ts`, replacing eight
  copies of the same `execSync`, capturing **stderr** instead of
  `stdio: 'ignore'` and re-throwing it. `stdio: 'ignore'` throws away the half
  of the output with the reason in it. The next occurrence will name its cause.

**Left behind:**
- **The seed/TRUNCATE lock race is diagnosable now, not fixed.** If it recurs
  with a message, the answer is probably closing pages before reseeding or
  giving the seed a lock timeout with a retry.
- **Editing is a navigation, not a modal.** Opening the composer leaves the
  cart page. On a phone that is the right shape; on a desktop a dialog would
  keep the totals visible.
- **No optimistic concurrency on the line.** Two tabs editing the same line
  both succeed and the last save wins. The cart is one person's cookie, so the
  race is a person being odd, not a defect.
- **The composer still cannot tell you what changed.** It shows the new price,
  never "was $13.45". The cart's own price-change banner (P0-3) covers the case
  that actually matters — a price moving under a customer — and this is a
  different, smaller thing.

C-021 committed and pushed at 8bf2c63

## C-022 — Menu integrity, in the database

**Built:**
- `packages/db/prisma/migrations/20260826070000_menu_integrity/` — five
  hand-written CHECK constraints, no schema change:
  `min >= 0`, `max >= 1`, `max >= min` on `ModifierGroup`;
  `basePriceCents >= 0` on `MenuItem`;
  `extraPriceDeltaCents IS NULL OR >= 0` on `ModifierOption`.
- 8 constraint tests, including one that the seeded menu — the fixture every
  price test is calculated against — satisfies all of them.

**Decided:**
- **The editor already refuses all five; that is not a reason to skip them.**
  `parseBounds` rejects `max < min` and `max < 1`, and the price parser rejects
  a negative base price. This is the other half of the house rule the order
  number and the idempotency key already follow: the database refuses, so
  correctness does not depend on the only screen that writes menu rows today
  staying the only one. The MESSAGE stays in the editor, where a manager can
  read it.
- **A negative modifier delta is deliberately NOT constrained.** "Small
  −$1.50" and "Veggie −$1.00" are ordinary options, and a constraint that
  forbade them would be a pricing policy invented by a migration. There is a
  test asserting a negative delta is accepted, so the next person to reach for
  `priceDeltaCents >= 0` has to delete an assertion that says why.
- **`max = 0` is refused rather than treated as "hidden".** A group whose
  options cannot be selected renders as a broken screen, not as a menu
  decision.
- **"`min` must not exceed the option count" stays OUT of the database.** It is
  a cross-row invariant a CHECK cannot see, and a trigger for it would have to
  fire on two tables and cope with a group being inserted before the options
  that satisfy it — which is exactly how the seed writes them. It stays in the
  editor, where C-015 put it after getting the bound backwards.
- **No schema.prisma change, so no drift.** CHECK constraints are not
  representable in the Prisma datamodel and are not diffed; the drift check was
  run locally against a shadow database and reports no difference. Same pattern
  as the gate's six constraints in C-011.

**Left behind:**
- **Nothing enforces that an item has a resolvable category or group.** Both
  are real foreign keys already, so the database carries it — but that is luck
  of the schema rather than a decision recorded anywhere until this line.
- **A group can still be saved with `min` above its option count by anything
  that is not the editor.** The seed and the tests are the only other writers,
  and both write valid groups.
- **No constraint relates a base price to its deltas.** An item at $0 with a
  −$1.50 size option prices to a negative line, which the price engine will
  happily compute. Cross-row again, and no menu has ever been written that way.

C-022 committed and pushed at 65b9216

## C-023 — The operator's settings screen

**Built:**
- `apps/web/app/kitchen/settings/page.tsx` — the week's opening hours, a
  one-tap "close for today", the auto-pause threshold, the pre-close cutoff and
  the two ready-time numbers. Linked from the kitchen queue.
- `apps/web/app/kitchen/settings/actions.ts` — `saveHours`, `saveService`,
  `setClosedToday`. Plain `<form action={…}>` posts, no client component.
- `packages/core/orders/business-day.ts` — `WEEKDAY_NAMES`, now shared with the
  gate's "we open on Thursday" message.
- 6 e2e tests, axe included.

**Decided:**
- **Every rule here is ALSO a CHECK constraint, on purpose.** The constraint is
  what makes the rule true (C-011, C-013, C-022); this is what makes it
  readable. A manager who types 900 into "minutes per order" is told the
  ceiling is 60, not handed a Postgres error string. The ranges are repeated
  rather than imported because a CHECK is SQL and cannot export anything — each
  one carries a comment naming its migration.
- **The week saves as a week, in one transaction.** `deleteMany` then
  `createMany`. A partial write would leave the restaurant open on days the
  manager just closed, and a day with no row IS a closed day, so the failure
  mode of a half-save is the worst possible one.
- **Closing at 00:00 means midnight at the END of the day.** `<input
  type="time">` cannot express 24:00, and the constraint that a close must be
  after its open makes the reading unambiguous — nothing can close at the start
  of its own day. Stored as 1440, shown as "00:00", and the screen says so.
- **"Close for today" computes the date from the RESTAURANT's clock.** Never
  from the form: a manager on holiday in another timezone would otherwise close
  the wrong day, and "today" is the only date that control can mean.
- **Timezone and tax rate are shown and not editable.** Changing the timezone
  moves the business day order numbers reset on and re-buckets every past
  report; changing the tax rate is a decision with a paper trail. Both are
  migration-shaped, not form fields. The screen says why rather than hiding
  them.
- **Refusals name the day and both times.** "Wednesday closes at 11:00, which
  is not after it opens at 18:00" — a generic "invalid hours" makes a manager
  check all seven rows.
- **The tests assert the CUSTOMER's gate, not the settings screen.** Closing
  today is proved by the checkout saying "We are closed today."; the prep
  numbers by the quoted estimate moving to 40 minutes. A form that saves a
  value it does not reach anything with is a form that passes its own test.

**Found on the way:**
- **A `'use server'` file may only export async functions.** `DAY_NAMES` — a
  plain const array — compiled, type-checked and lint-passed, and failed at
  BUILD time with "found object". This is the same class as C-007's `.js`
  specifiers: a build is a distinct kind of check, and this repo runs it only
  inside the e2e leg. *Fix:* the names moved to `packages/core`, which is where
  they belonged anyway — the gate already had a private copy indexed by the
  same weekday number.
- **`getByRole('alert')` is ambiguous in any Next app.** The router renders its
  own `role="alert"` route announcer on every navigation. *Fix:* a test id
  beside the role.
- **I broke this project's own rule about navigating before a write lands.**
  The estimate spec clicked Add to cart and went straight to `/checkout`,
  arriving at an empty one. Fourth instance (C-014, C-015, C-019, here) —
  which is the argument for a shared `addToCart` e2e fixture rather than for
  remembering harder.

**Left behind:**
- **One window per day.** `dayOfWeek` is the primary key, so split lunch/dinner
  service still cannot be expressed — a recorded ceiling since C-011, and this
  screen inherits it rather than fixing it.
- **No staff authentication**, the same standing scope line as every other
  `/kitchen` screen. This one now edits the restaurant's hours, which raises
  the stakes of that line without changing it.
- **`closedOnDay` can only be TODAY.** Closing next Tuesday in advance needs a
  date picker and a list of upcoming closures; the column holds one date.
- **No confirm step on hours.** The menu editor confirms a price change old →
  new (C-015); saving hours does not, even though closing a day is at least as
  consequential as repricing a burrito.

C-023 committed and pushed at 488927f

## C-024 — The build is a gate step

**Built:**
- `npm run gate` — `lint && typecheck && test && build:test && test:e2e`, in
  that order: cheapest check first, and the build named separately before
  Playwright can bury it.
- A `Production build` step in CI, ahead of the Playwright install.
- The gate line updated in the three places it is written down: `README.md`,
  `docs/backlog.md` and `CLAUDE.md`.

**Decided:**
- **The build earns its own step because it has failed twice on its own.**
  C-007's `.js` import specifiers (which `moduleResolution: "Bundler"` maps and
  Turbopack does not) and C-023's non-function export from a `'use server'`
  file. Neither is a type error, neither is a lint error, and both were green
  under the entire unit suite. A gate that builds only inside the e2e leg
  reports them as `webServer was not able to start` three minutes in — a
  message that names a port.
- **Order is cheapest-first, except the build.** Lint, typecheck and the unit
  suite take about ten seconds between them and should fail first; the build
  goes ahead of e2e because e2e cannot run without it and its failures are
  clearer on their own.
- **One `gate` script rather than a longer documented command line.** The
  four-part command was written out in three files and had already drifted
  from what CI ran. A script is one place to change it, and CI still runs the
  steps individually so a failure names which one.
- **It costs one cached rebuild.** `test:e2e` builds anyway; Next reuses the
  work, so the extra step is seconds.

**Left behind:**
- **Reseeding a live database under a running server has a visible window.**
  The e2e server intermittently logs `An operation failed because it depends on
  one or more records that were required but not found` — a `findUniqueOrThrow`
  for the settings row landing between a `beforeEach` reseed's TRUNCATE and its
  re-insert. It appeared in two of the last four sweeps, fails no test, and is
  the same root cause as C-021's seed-lock finding: the app is being served
  while its database is rebuilt underneath it. It has no production analogue —
  nobody truncates a live restaurant. The fix, if it ever fails a test, is to
  wrap the reset and the seed in one transaction (TRUNCATE is transactional in
  Postgres), which means threading a `tx` client through the seed helpers.
- **CI still cannot run.** Every run in this repo's history has died in about
  two seconds on an account billing block, so this step — like the drift check
  and the two TZ legs — has only ever been executed by hand.

C-024 committed and pushed at 48ca554

## C-025 — Shared e2e fixtures

**Built:**
- `apps/web/e2e/fixtures.ts` (was `reseed.ts`) — `reseed`, `card`,
  `addBurritoToCart`, `placeOrderFor`.
- Local copies deleted from `checkout.spec.ts` (its own
  `addBurritoToCart`), `availability.spec.ts` (`burritoWithGuacamole`),
  `status.spec.ts` (`placeOrderFor` and `card`), `kitchen.spec.ts` and
  `report.spec.ts` (`card`).

**Decided:**
- **This is a defect-class fix, not a tidy-up.** Four times a spec has clicked
  something that triggers a server action and navigated before the write
  landed: C-014's cart cookie, C-015's price save, C-019's `page.close()` after
  a cancel, C-023's checkout. Every one was a spec writing its own worse copy
  of a helper that already existed one file over, with the guard missing. The
  guard now lives in one function, and nothing else has to remember.
- **`addBurritoToCart` takes a `{ guacamole }` flag rather than becoming
  generic.** Three call sites wanted the same burrito and one wanted guacamole
  on it. A helper that takes a composition would be a second, worse composer;
  the composer's own suite still drives the screen by hand, which is what that
  suite is for.
- **`card` takes a `Page` rather than reading a test fixture.** Half its
  callers are driving a SECOND page — the kitchen tab beside the customer's —
  and a helper that could only see the default one would have been rewritten
  locally on the spot, which is the whole problem.
- **`placeOrderFor` asserts the link looks like a link before returning it.**
  A spec that goes on to `goto` it fails in the helper if placement quietly did
  not produce one, rather than three lines later on a 404.

**Left behind:**
- **`menu.spec.ts` and `menu-editing.spec.ts` still compose by hand,
  deliberately.** They are the specs ABOUT those screens; driving them through
  a helper would test the helper.
- **No fixture for the kitchen's advance buttons.** `report.spec.ts`'s `pickUp`
  walks a card to `picked_up` through the real labels and is used only there —
  one call site is not a pattern yet.
- **Nothing stops the next spec from writing its own copy.** The rule is a
  comment at the top of `fixtures.ts` explaining which four defects it exists
  to prevent. A lint rule banning `execSync` in a spec would cover a third of
  it and none of the rest.

C-025 committed and pushed at cee5fde

## C-026 — The confirm is checked against the number it showed

**Built:**
- `saveItemPrice`, `saveOptionPrice` and `saveGroup` take the values their
  confirm panel DISPLAYED and refuse if the database has moved since.
- `rejected(why?)` now carries a specific message; the editor's error banner
  renders it instead of the generic line when there is one.
- 3 e2e tests, each driving a second page — a real other manager, not a
  simulated one.

**Decided:**
- **The confirm panel was UX; now it is checked.** C-015 built the panel and
  made it re-read the current value on every render, which closes the big
  window: a screen left open through someone else's edit already shows the
  truth. What it could not cover is the window between that render and the tap,
  and this is a screen whose entire purpose is "here is the number you are
  replacing". Applying the change against a different number is the one failure
  it must not have. Exactly the pattern the idempotency key and the order
  number already follow: the visible control is the UX, the check is the
  mechanism.
- **The bound value is client input, so the check is a comparison against the
  database.** A server action's bound arguments arrive over the wire like any
  other; the panel's number is evidence of what the manager saw, never
  authority about what is true.
- **The message names both numbers.** "Burrito is $11.50 now, not the $10.95
  you were shown" — a manager who is told only "not saved" retypes the same
  edit and wins the race the second time.
- **A group carries three values, not a version column.** Name, min and max are
  what the panel displayed, so they are what gets compared. A `version` integer
  would be the general answer and would need a migration, a bump on every
  write, and a story for every other writer; three fields need none of that and
  say what actually changed.
- **The check is staleness, not paranoia.** An unchanged value still saves —
  there is a test for it, because a "have things moved?" check that also blocks
  the ordinary case is a check people route around.

**Found on the way (a latent defect this change exposed):**
- **`menu.spec.ts` asserted seeded prices without reseeding.** It was the only
  spec doing so, which made it quietly dependent on the state the previous
  spec file left behind — and `menu-editing.spec.ts`, which rewrites live menu
  rows, runs immediately before it. It passed for eleven sessions because that
  file happened to END on a test whose own `beforeEach` had reseeded. C-026
  appended three tests after it, the last of which leaves the burrito at
  $12.50, and four assertions about $10.95 fell over at once.
  *Fix:* `test.beforeEach(reseed)` in `menu.spec.ts`. An assertion about $10.95
  has to be an assertion about the SEED, not about test ordering — and the
  failure only looked like it belonged to C-026.

**Left behind:**
- **`smoke.spec.ts` still has no reseed**, correctly: it asserts a landing page
  that reads no seeded data.
- **The 86 toggles are still last-write-wins,** deliberately. Availability is a
  boolean a cook flips at arm's length and the intended state is obvious from
  the button they tapped; a staleness refusal there would be a dialog between a
  cook and a race they do not care about.
- **Delete is not staleness-checked.** Deleting a group someone else just
  renamed deletes it anyway. The confirm names the items it affects and those
  are read fresh; the group's own name moving does not change what deleting it
  does.
- **Still no version column, so two edits to DIFFERENT fields of one group
  conflict.** Renaming Salsa while someone else widens its max refuses, though
  both could have applied. Rarer than the case it catches, and the safe
  direction.

C-026 committed and pushed at c83d2d5

## C-027 — The intensity surcharge is editable

**Built:**
- A second price row on every option inside an intensity-enabled group:
  `Extra surcharge for <option>`, with its own confirm panel.
- `saveExtraSurcharge(optionId, priceText, seenFromCents)` — non-negative,
  staleness-checked like every other price (C-026), refused outright on a group
  that has no `extra` to choose.
- 4 e2e tests, including the composer proving the new surcharge reaches a
  customer's price.

**Decided:**
- **Blank is a value, and it means free.** `extraPriceDeltaCents` is nullable
  and null is the common case — most options cost nothing extra. The panel says
  "Was $0.75, will be free", never "$0.00", because those are different facts
  and one of them is the column's null. This was the last price in the system a
  manager could not change.
- **The panel says what the surcharge is added TO.** "added ON TOP of +$0.50"
  — a surcharge shown alone is a number with no meaning, and a manager
  comparing $0.75 against the wrong base sets the wrong price.
- **A surcharge on a non-intensity group is refused, not stored.** There is no
  `extra` to pick in such a group, so the value could never apply. The row does
  not render either, but the action refuses independently: the missing row is
  UX, the refusal is the mechanism.
- **Non-negative, mirroring the CHECK constraint from C-022.** Asking for extra
  cheese must not make the burrito cheaper. Unlike an option's own delta, which
  is deliberately allowed to be negative.
- **`PriceForm` grew a `what` prop rather than being copied.** An option now
  has two prices, and every accessible name on both rows is built from `what`
  — so "Price for Cheese" and "Extra surcharge for Cheese" are unambiguous to a
  screen reader and to a locator, which is the same reason C-015 used
  `exact: true` throughout.

**Left behind:**
- **Only `extra` is priced.** `light` still costs the same as `regular`, which
  is a C-002 decision (restaurants do not discount light sauce) and is not
  reopened by this.
- **Turning intensity OFF on a group leaves its surcharges in the column.**
  They stop applying — the composer offers no `extra` — and start applying
  again if it is turned back on, which is probably what someone wants and is
  certainly not decided anywhere.
- **No add, no delete, no reorder for options** — the standing C-015 line. This
  edits the prices of what is there.

C-027 committed and pushed at a6c32fc

## C-028 — The rush, on screen

**Built:**
- `apps/web/e2e/rush.spec.ts` — six tests against the kitchen queue with
  twenty-two live tickets on it: every section populated and the counts
  reconciling, the cancelled order gone and the stranded customer back, a
  negation unmistakable beside an addition on the same card, the ready shelf
  aging without every flag lit, every control ≥48px, axe clean.
- `seedMidServiceRush()` in `fixtures.ts` and `npm run db:rush:test`.
- The demo's anchor fixed: a run now ends NOW.

**Decided:**
- **This is the assertion C-017 could not make.** The rush was proved at the
  database grain — thirty orders, five ugly cases, zero stuck — and C-019 made
  a mid-service queue possible. Nothing had looked at the screen under that
  load, which is the thing the product is about: twenty-two tickets read at
  arm's length, in a hurry, with gloves on.
- **The tap-target check runs across the whole queue, not one card.**
  `kitchen.spec.ts` asserts 48px on a single card; a layout that holds for one
  card and collapses under a full column is the version a cook actually meets.
  Twenty-plus controls, every one measured.
- **The negation is asserted BESIDE an addition on the same card.** "NO onions"
  in bold next to "Guacamole" not in bold. Asserting the negation alone would
  pass on a card where everything is bold, which is the same failure with extra
  steps.

**Found and fixed (a defect I shipped in C-019):**
- **The live demo anchored a flat hour back**, so `--until 12` left the stop at
  48 minutes ago and every card on the queue 48+ minutes old — past the
  15-minute overdue flag, every ticket screaming. A queue that looked like a
  disaster rather than a lunch rush, which is precisely the opposite of what
  the flag is for. *Fix:* anchor so minute `until` is NOW. A full run ends now
  too, which also puts it inside the report's one-day window instead of an hour
  before the present for no reason. There is a test asserting nothing on the
  mid-service queue is flagged "Running late".

**Left behind:**
- **The spec asserts one moment, not the twenty minutes.** Driving the whole
  rush through the browser — advancing cards as they arrive, watching the alert
  fire — would be the real capstone demo and is a project of its own; this is a
  photograph of the hardest moment in it.
- **`db:rush:test` replaces the ordinary seed for one spec file.** Safe only
  because every spec that asserts seeded data reseeds (C-026), which is a
  property nothing enforces.
- **Nothing asserts the chime.** The new-order alert has its own tests in
  `kitchen.spec.ts`; a rush arriving mid-service should fire it, and this spec
  loads a queue where the alerting orders are already there.

C-028 committed and pushed at 70e91f5

## C-029 — Hours are confirmed before they are saved

**Built:**
- The hours form now opens a confirm panel (a GET to `?review=hours&…`)
  instead of writing. The panel diffs the submitted week against the current
  one and lists only the days that move, old → new.
- A distinct warning naming every day the save would CLOSE.
- "Nothing was changed" when the submitted week is the saved week, with no
  save button on it at all.
- 2 new e2e tests; the two existing hours tests now go through the panel.

**Decided:**
- **Closing a day earns the same guard as repricing a burrito.** C-023 shipped
  the hours with no confirm and said so in its own left-behind note. A week is
  seven checkboxes and fourteen time fields on a phone; unticking one by
  accident shuts online ordering for a day and nothing would have said so until
  a customer noticed.
- **Only the days that MOVED are listed.** A diff of all seven days is not a
  diff — it is the form again, and a manager scanning it for the one row that
  changed will find the wrong row eventually.
- **Closing is called out separately from changing.** "Wednesday 11:00–21:00 →
  12:00–20:00" and "Wednesday → closed" are different sizes of decision, and
  the amber banner names every day in the second category.
- **The panel is a URL carrying the submitted fields, and the action
  re-validates all of them.** Same shape as the menu editor's confirm: it
  survives a reload, works before hydration, and re-reads the CURRENT hours to
  diff against on every render. `saveHours` was not changed at all — the panel
  POSTs the same field names, and a field that made a round trip through a URL
  is client input like any other.
- **Cancel is a link, not a second submit.** Leaving without saving must never
  be one mis-tap away from saving — lifted verbatim from the menu editor,
  because it was right there.
- **The service numbers still save directly.** Changing "pause above 25 orders"
  to 30 is reversible and visible on the same screen a second later; closing
  Tuesday is neither.

**Left behind:**
- **The confirm does not say which day is TODAY.** Closing the day you are
  currently open on is the sharpest version of this mistake and reads exactly
  like closing any other.
- **No confirm on "close for today".** It is one button whose label is the
  whole consequence, and it has a one-tap undo sitting beside it.
- **The diff compares strings, not windows.** "11:00–21:00" versus
  "11:00–21:00" is equality by text; it happens to be exact here because both
  sides are formatted by the same function, but it is not a comparison of
  minutes.

C-029 committed and pushed at ac0fbbe

## C-030 — The write-up caught up with the project

**Built:**
- `docs/WRITEUP.md`: status line, "By the Numbers" and a new section — *What
  the twelve extra items were* — explaining where C-018 → C-029 came from.
- The C-028 demo-anchor defect written up properly, taking the recorded count
  to 11.

**Decided:**
- **The extra items came from the write-up's own "Left behind" lists, and that
  is worth saying out loud.** Every PROGRESS entry is required to record what
  it did not do at the moment it decided not to do it. Twelve items later,
  that turns out to be a backlog that generates itself — and a better one than
  a list written in advance, because every entry already knows why it was
  deferred. That is the most transferable thing this project produced and it
  was not in the plan.
- **The defect count is a headline number, not a confession.** Eleven, each
  with how it was found and what would catch it earlier. Four were found in the
  twelve post-backlog items, and three of those four were in code the earlier
  items had shipped green — which is the argument for the audit half of that
  list existing at all.
- **The numbers table is a snapshot and says its date.** It counts itself and
  will be stale the next time anything ships; the alternative is generating it,
  which is a script to maintain for a document written once.

**Left behind:**
- **The live-demo line still reads `_(Vercel, later)_`.** Deploying is a
  decision about hosting a real database, not a write-up task.
- **No screenshots.** A portfolio write-up about a screen read at arm's length
  with greasy gloves would be better with a picture of it.
