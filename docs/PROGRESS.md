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
