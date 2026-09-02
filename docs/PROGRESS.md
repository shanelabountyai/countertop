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

C-030 committed and pushed at edd0dc2

## C-031 — Screenshots of the real thing

**Built:**
- `apps/web/e2e/screenshots.spec.ts` — 11 captures, skipped unless
  `SCREENSHOTS=1`, written to `docs/screenshots/`.
- `seedFinishedRush()` and `npm run db:rush:test:full`, so the report can be
  photographed with a day's service behind it as well as mid-lunch.
- A **The Screens** section in `docs/WRITEUP.md` with all of them.

**Decided:**
- **They are e2e specs, not a standalone Playwright script.** `webServer`
  already knows how to build the app and start it on the right port; a second
  launcher would be a second thing to keep in step with how this project
  actually serves itself. The cost is one `test.skip` guard.
- **Skipped, not excluded.** They appear in `--list`'s total, which is exactly
  why the house rule reconciles `passed + skipped + flaky` rather than reading
  the tail. A spec directory nobody counts is a spec directory that rots.
- **The report is photographed TWICE.** Mid-service it reads $0.00 revenue and
  a "—" no-show rate over 22 open orders; after service, $478.55 and 3.4%. The
  first one is the more interesting picture, because it is the screen refusing
  to print a zero it cannot justify.
- **The queue gets a full-page AND a viewport capture.** The tall one shows the
  load; the viewport one shows what a cook sees without scrolling, which is the
  honest version of "does this work at arm's length".
- **Nothing is staged.** Every number on every screenshot comes from the seeded
  rush and is asserted somewhere in the suite — the report's 4 h 3 min in
  `Preparing` is the same 243 minutes `rush.test.ts` hand-tallies in a comment.
  A screenshot of a mockup would be a nicer picture and would prove nothing.

**Left behind:**
- **1.6 MB of PNGs in the repo.** Regenerable, and they will drift the first
  time a screen changes without someone re-running the command. The honest
  alternative — generating them in CI — needs CI.
- **No dark mode, no mobile customer flow.** The phone captures are the two
  staff screens that are actually used on a phone; the customer's are desktop.
- **The queue screenshot has one card mid-undo.** That is real — a cook had
  just advanced it — but it is luck of the timing rather than a staged detail.

C-031 committed and pushed at 604c2c9

## C-032 — The portfolio page

**Built:**
- `docs/portfolio/` — `head.html` (design tokens and type), `body.html` (the
  words, with named image slots) and `build.mjs`, which inlines the
  screenshots as data URIs. The built page is ~1.1 MB and gitignored.
- Published as a private Claude artifact:
  https://claude.ai/code/artifact/40b1ec20-d478-4b63-8db2-08d660788255

**Decided:**
- **The page opens on the bug, not the product.** A red NO ONIONS badge at
  display scale, reproducing the app's own kitchen-card treatment. The page's
  accent is literally the colour the product uses to prevent the failure the
  product exists to prevent — which is a better reason for a palette than
  liking the colour.
- **Steel neutrals, not warm cream.** The obvious "restaurant" palette is cream
  and terracotta with a serif display face, which is both a cliché and what
  every generated page looks like. A stainless pass under service light is the
  material this product is actually used on.
- **Section eyebrows are the project's real requirement ids** — `P0-11`,
  `C-017`, `P1-1`. Decorative `01 / 02 / 03` markers imply a sequence; these
  encode something true and are greppable in the repo.
- **Three fragments and a build script, not one HTML file.** The head carries
  tokens and nothing else, the body carries the words, and images are wired in
  by NAME — so a renamed screenshot fails loudly in the build rather than
  rendering a broken image on a portfolio page.
- **The built file is not committed.** 1.1 MB of base64 that is entirely
  derived from two fragments and eleven PNGs already in the repo.
- **Both themes designed, not inverted.** Tokens at `:root`, redefined under
  `prefers-color-scheme` and again under an explicit `data-theme`, so all three
  viewer states resolve as a set. Verified by rendering the page locally in
  both before publishing.

**Left behind:**
- **The artifact link is private and not in the README.** Anyone cloning the
  repo would get a dead link; the page is shared deliberately or not at all.
- **The page's numbers are hand-copied from the write-up.** They will drift the
  next time anything ships, and the honest fix is to stop editing the numbers
  in two places rather than to generate them.
- **Screenshots are light-mode UI on a dark page in dark theme.** The
  application has no dark mode; the steel frame around each figure is what
  keeps that from reading as a mistake.

C-032 committed and pushed at 33639f8

## C-033 — The gate runs before a push

**Built:**
- `.githooks/pre-push` — runs `npm run gate` and refuses the push on a non-zero
  exit. `git push --no-verify` is the deliberate escape hatch, named in the
  hook's own comment.
- `git config core.hooksPath .githooks`, wired into `postinstall` so a fresh
  clone gets it without anyone remembering.

**Decided:**
- **A tracked `.githooks/` directory, not husky and not `.git/hooks/`.** Husky
  is a dependency for a three-line shell script. `.git/hooks/` is untracked, so
  it exists only on the laptop that created it — which is exactly the failure
  mode this item is about.
- **The hook is the stopgap, and says so in its first comment.** The gate
  belongs in CI. Running it on a laptop makes a push slow and makes the machine
  the authority, which is the thing CI exists to stop being true. The comment
  tells whoever finds it to delete the hook once CI runs.
- **CI's failure was never in the code.** Every run since C-029 died in 2–4
  seconds: *"the job was not started because recent account payments have
  failed or your spending limit needs to be increased."* Four items — C-029
  through C-032 — were pushed under a convention that says "watch CI green
  before saying done," against a CI that never started. The two real fixes are
  clearing the billing block or making the repo public for free minutes; both
  are account decisions, not commits.

**Left behind:**
- **The gate on a laptop is not the gate in CI.** It runs against this machine's
  Postgres, this machine's timezone, and whatever is already built. CI's
  migrate-from-scratch, drift check, and the `TZ=Pacific/Kiritimati` × `TZ=UTC`
  double run are precisely what a local gate cannot reproduce.
- **A slow pre-push invites `--no-verify`.** The full gate is minutes. The first
  time it is skipped in a hurry, this item's value goes with it.

## C-034 — The reservations PRD

**Built:**
- `prd-reservations.md` — "Countertop Reserve," the product Countertop's
  Non-Goals list names and declines: table reservations with SMS confirm and
  change. Twelve P0s, eight P1s, success metrics, phasing, build notes, plus
  two appendices — fourteen verbatim message templates and the inbound keyword
  grammar as a table.

**Decided:**
- **A separate product, not a Countertop feature.** Countertop's Non-Goals say
  reservations are "adjacent business, different feature family." Bolting them
  on would have made the menu model and the floor plan share a repo for no
  reason beyond both belonging to a restaurant.
- **The two learning artifacts are allocation-under-contention and an inbound
  channel that mutates state.** Tables are not slots: they combine, they have
  minimums, and a turn is a function of party size. And every prior project's
  writes came from a browser session the app controlled — here a stranger with
  a phone can move a state machine, which makes the webhook a trust boundary.
- **A change is a re-allocation, never an edit.** The tempting shortcut frees
  the old table before securing the new one, and there is a window where the
  guest owns nothing. The PRD states the failing case as an acceptance
  criterion so it cannot be rediscovered at runtime.
- **`CHANGE` sends a link; only confirm/cancel/stop/help are parsed.** Free-text
  time parsing ("can we do 8ish sat?") is an NLP project wearing a reservation
  costume.
- **Consent, quiet hours and STOP are P0 and not simplifiable.** They are the
  one part of this product with a regulator attached. STOP is parsed before
  reservation lookup, and it never cancels the booking — opting out of texts is
  not opting out of dinner.
- **Message bodies are snapshotted onto the reservation.** Rendering history by
  chasing a template FK is the same defect class as joining an order to a live
  menu row — the rule this project exists to practise, in a second product.

**Left behind:**
- **No release-notes entry.** It is a specification for a different product; the
  portfolio-facing notes are Countertop's.
- **Quiet hours want an operator review.** 21:00 is almost certainly too early
  for a room that seats until 22:00 — left open in the PRD rather than guessed,
  the same way Countertop's v2 addendum handled store hours.
- **No backlog derived from it.** The PRD phases the work; nothing has claimed
  port 3500 or created a repo.

C-033 and C-034 committed and pushed at c60a0f6

## C-035 — The CI-only half runs locally too

**Built:**
- `scripts/ci-local.sh` + `npm run ci:local` — drops and recreates
  `countertop_ci` and `countertop_ci_shadow`, applies every migration from
  nothing, asserts the four objects Prisma cannot express (the append-only
  trigger, the settings singleton CHECK, and the two unique indexes), runs the
  drift check against a real shadow database, and runs the unit suite twice
  under `TZ=UTC` and `TZ=Pacific/Kiritimati`. The throwaway databases are
  dropped on exit via a trap, pass or fail.
- `.githooks/pre-push` now runs `ci:local` **before** the gate — the cheap,
  fast-failing half first.

**Decided:**
- **The workflow file stays the original; this mirrors it.** Generating one from
  the other would be a build step for two consumers. The script says in its
  first comment that `ci.yml` is the source and that this is deleted the day CI
  runs again.
- **Throwaway databases, not the test database.** `db:reset:test` rebuilds the
  database everything else depends on; a CI check that scribbles on the suite's
  own database is a check that changes what it measures. `countertop_ci` exists
  for ninety seconds and is dropped by a trap.
- **The invariant SQL is copied verbatim, catalog comment included.** Those four
  assertions are the reason a from-scratch build exists at all: a migration that
  drops the append-only trigger passes every local test against a database that
  still has it.
- **Cheap enough to be unconditional.** The whole script is ~90 seconds, most of
  it the two unit runs. Anything that made the pre-push hook slower would get
  `--no-verify`'d within a week.

**Left behind:**
- **It is still this laptop.** One Postgres version, one architecture, one Node.
  `ubuntu-latest` with a `postgres:16` service container is a different machine
  and that difference is a real part of what CI buys.
- **`npm ci` from a clean checkout is not covered.** CI installs from the
  lockfile into an empty tree; this runs against whatever `node_modules` is
  already here, so a missing dependency that happens to be installed locally
  still slips through.
- **Two files now describe the same checks.** They will drift. The mitigation is
  that the local one is meant to be deleted, not maintained.

## C-036 — CI on a runner in the room

**Built:**
- A self-hosted GitHub Actions runner (`countertop-mac`, labels `macOS`,
  `ARM64`, `countertop`) in `~/actions-runner-countertop`, installed as a
  launchd agent so it comes back at login.
- `.github/workflows/ci-self-hosted.yml` — `npm ci` into a clean checkout, then
  `ci:local`, lint, typecheck, a database built from scratch, the unit suite,
  the production build as its own step, and e2e.

**Decided:**
- **`ci.yml` is untouched and stays the original.** It is what runs on a real
  `ubuntu-latest` with a `postgres:16` service container the day billing is
  unblocked. The self-hosted file is the stand-in, and says so in its header.
- **The runner gets its own port and its own database.** 3450, not 3400, and
  `countertop_runner`, not `countertop_test`. Both exist for the same reason:
  the runner shares a machine with a developer, and a job triggered by a push
  must never adopt a dev server or drop a database a local sweep is using.
- **What it actually buys is two things, and the header says only two.**
  `npm ci` from the lockfile into an empty tree — which the pre-push hook
  structurally cannot do — and a run that happens because of the push rather
  than because someone remembered. It does not buy a different machine.
- **One runner serves one repo.** A personal account cannot own account-level
  runners; sharing across projects needs a GitHub organization and the repos
  moved into it. Running one runner per repo on this Mac would let two sweeps
  run at once, which is the thing the conventions ban outright.

**Left behind:**
- **Settled: the billing block does not reach self-hosted runners.** The
  GitHub-hosted `CI` workflow still dies in four seconds on the same pushes
  this one goes green on. Self-hosted minutes are not metered, so nothing about
  payment gates them. No public repo, no payment.

**What it caught, on its first four runs:**
1. **The runner's database was created after the tests that connect to it.**
   Eighteen `packages/db` tests died on `PrismaClientInitializationError`.
   Invisible on a laptop, where `countertop_test` has existed for weeks.
2. **`PORT` was never actually overridable.** `apps/web/package.json` read
   `next start -p 3400`, so the runner's 3450 was ignored: Playwright waited
   five minutes on 3450 while a healthy server served 3400. The convention had
   claimed the override worked since C-001; no caller had ever wanted a
   different port, so nothing tested the claim. Now `-p ${PORT:-3400}`.
3. **An orphaned server held the port.** Self-inflicted — a manual
   verification's `next start` survived a `pkill -f "next start"`, because the
   live process is `next-server`. The workflow now frees its port by port
   before e2e and again in an `always()` step; freeing by port rather than by
   `pkill` is what keeps it from taking a sibling project's sweep with it.

**Green at last:** run 33020960765, 2m32s — 370 unit tests under both
timezones, 86 e2e passed + 11 skipped reconciling against 97.
- **435 MB and a launchd agent.** `~/actions-runner-countertop/svc.sh stop`,
  `svc.sh uninstall`, then `config.sh remove` reverses all of it.
- **A push now runs the suite twice** — once in the hook, once on the runner.
  The hook is the one that can block a bad push; the runner is the one that
  reports. Dropping the hook is the obvious simplification once the runner has
  proven itself.

C-033 through C-036 pushed; first green CI run at 33020960765 (commit d4bd3ea range).

## C-037 — Staff auth on /kitchen

**Built:**
- `apps/web/lib/staff-auth.ts` — the cookie name, the salted SHA-256 token, a
  constant-time compare, `isStaff()`, and `safeNext()`.
- `apps/web/middleware.ts` — matcher `/kitchen/:path*`, `/kitchen/login`
  excepted. GET redirects to the login with `?next=`; anything else gets 401.
- `apps/web/app/kitchen/login/` — the passcode form and `signIn`/`signOut`,
  with the error state in the URL like C-015's and C-023's confirms.
- A `Sign out` form in the kitchen header.
- `apps/web/e2e/global-setup.ts` + `use.storageState` — every context starts
  signed in; `auth.spec.ts` is the one file that opts out.
- `STAFF_PASSCODE` in `.env.example` and in both CI workflows.

**Decided:**
- **The guard is the middleware, not fifteen `requireStaff()` calls.** A server
  action POSTs to the path it was rendered on, so a route matcher covers every
  write on the route. Recorded in the file as a route-layer ceiling: an action
  imported into a page outside `/kitchen` would bypass it. Nothing does.
- **The cookie is a digest of the passcode.** No session table, no expiry
  sweep, no second secret. Rotation is the revocation mechanism, and it is
  global by construction.
- **Unset fails closed.** A dev default is how a known passcode reaches
  production. The login page names the missing variable instead.
- **GET redirects, non-GET is 401.** A 307 on a server action's POST makes the
  browser re-POST the payload at the login page.
- **The cookie is scoped `path=/kitchen`,** so customer surfaces never receive
  it — in the browser or in the test fixtures.
- **Global setup mints the cookie without touching the server**, which keeps it
  independent of whether Playwright starts `webServer` before or after it.

**What it caught:**
- **`getByRole('alert')` is a strict-mode violation on every page in this app.**
  Next's route announcer is itself a `role="alert"` live region. The new spec
  asserted the wrong-passcode message by role and failed in 164ms. By text now.
- **The `Sign out` button broke P0-11 the moment it was added.** `rush.spec`
  asserts every visible `<button>` on a full queue is ≥48px tall; a 20px text
  button in the header failed it at test 76 of 103. The spec was right and the
  tempting fix — excluding the header from the selector — is how the exceptions
  start. It is `min-h-12` now, like everything else staff can tap.

**Left behind:**
- **One shared passcode answers "is this the kitchen?", not "which cook?"** The
  event log's `actor` is still the literal `staff`. Per-cook accounts are a
  different project and the log is where they would land.
- **The C-031 screenshots predate the `Sign out` link** in the kitchen header.
  Re-run with `SCREENSHOTS=1` when the portfolio page is next rebuilt.

C-037 committed at 8670bfa.

## C-038 — Payment state, made reachable

**Built:**
- `paidNow` on `PlacementInput` — a boolean, not a `PaymentState`. `refunded`
  is something that happens to an order later, never something a checkout
  request may ask for.
- A Payment fieldset on checkout: "Pay now — card" (default) or "Pay at
  pickup". The receipt and the customer's status page both say which, and the
  unpaid ones name the amount due.
- `PAYMENT_LABEL` beside `STATUS_LABEL` — one map, three readers.
- The kitchen card's amber `PAY AT PICKUP — $11.85` badge and its
  `Collected — mark paid` button, directly under the advance button.
- `markOrderPaid`, an `updateMany` guarded on `paymentState: 'unpaid'`.
- `transitions.ts` sets `refunded` when the engine emitted a `refund` event.
- `packages/db/payment.test.ts` (4), `apps/web/e2e/payment.spec.ts` (4), and
  `payAtPickup` on the shared `placeOrderFor` fixture.

**Decided:**
- **No migration, and that is the finding.** The column, its `unpaid` default
  and the `refund` event kind have been in the schema since C-003, and the
  engine has written the refund event since C-004. Two of the three states
  were simply unreachable from the app. The item was wiring, not modelling.
- **The column follows the LOG, not a second copy of the rule.** `refunded` is
  set when `decision.events` contains a `refund` — so one place knows when a
  cancellation refunds, and one knows what it cost. Re-deriving "was it paid
  and is this a cancel" in the db layer is how the two drift.
- **Flag, don't block.** The PRD says the card flags unpaid so the counter
  collects; it does not say `ready → picked_up` is refused. A cook who cannot
  hand over food because a screen disagrees about money will find a way around
  the screen, and the way around is worse than the flag.
- **The amount is on the badge.** A cook who has to open the receipt to find
  out what to collect will wave the order through.
- **Amber, not red.** The aging flags own red on this screen. Money owed is
  not the same alarm as food going cold.
- **`markOrderPaid` is guarded on `unpaid`, not on the id.** A card left open
  on a second screen since before the refund must not be able to re-mark a
  refunded order as paid. Zero rows matched is the answer "someone already
  handled this", not an error.
- **A third of the seeded rush pays at pickup**, derived from the arrival
  minute so the mix is identical on every run. A badge on every card is not a
  signal and a badge on none is not a demo.
- **P1-5 was closed as already satisfied**, not built: the status token is
  192 bits, lookup is by token only, and C-014 shipped the terminal view.

**Left behind:**
- **Payment is a column, not a history.** There is no `payment` event kind, so
  an order collected at the counter carries a state and no instant. Marked
  with a `ponytail:` comment in `markOrderPaid`; a real provider makes it a
  logged event with a provider reference, and `refund` is the shape to copy.
- **The C-031 screenshots still predate both this and C-037's sign-out link.**
  Re-run with `SCREENSHOTS=1` when the portfolio page is next rebuilt.

C-038 committed at 59ece61.

## C-039 — The end-of-day sweep

**Built:**
- `isLeftOver(order, today)` in `packages/core/orders/queue.ts` — one predicate,
  three readers. Appended to the queue module rather than given a file of its
  own: it is a fact about what the kitchen queue shows, and it already had the
  `QUEUE_STATUSES` import it needs.
- `loadGateState(now)` — the open-order count is now scoped to
  `businessDay >= today`, so the P0-6 throttle and the P0-7 estimate stop
  counting leftovers. Four call sites now pass the `now` they already had.
- The kitchen banner (count + oldest day) and the per-card
  `LEFT OVER FROM <day> — CLOSE IT OUT` badge, which outranks the un-acked
  styling and suppresses the "New — not yet accepted" badge.
- The un-acknowledged count excludes leftovers, so the chime and the screen
  agree about what is new.
- `backdateQueue()` in the e2e fixtures, 5 tests in `closeout.spec.ts`
  (including axe), 5 unit tests, and one db test.

**Decided:**
- **Flag, don't sweep.** The PRD says "flagged for closeout". Closing an order
  out is a transition to a specific terminal state, and only the person who was
  there knows which: `abandoned` for food that was made and never collected,
  `cancelled` with a reason for a ticket that never got cooked. An automatic
  sweep would have to pick one, and picking `abandoned` for an order that was
  in fact handed over quietly invents a no-show in the P1-1 report. It would
  also need a `system` actor, which the state machine refuses for both
  transitions — correctly.
- **The business day, not closing time.** It is the same boundary the daily
  order numbers reset on, which is what the requirement ties them together by.
  Flagging at close would flag the ticket a cook is still bagging as the door
  shuts. The store-hours CHECK constraints cap `closeMinute` at 1440, so
  service cannot cross midnight and the two boundaries cannot invert.
- **Leftovers stop counting toward the throttle, and that is the defect this
  item actually fixes.** `OPEN_STATUSES` means work the kitchen owes. Stale
  rows inflated every quoted wait and, at enough of them, would have held the
  auto-pause shut permanently — online ordering refused, on a restaurant
  standing empty, because of rows nobody tapped. The screen keeps showing them;
  only the counter stops.
- **The chime is for someone standing there now.** A leftover `placed` ticket
  ringing on every load is an alarm staff learn to ignore, and then the alert
  is worth nothing during the rush it exists for. Excluded from the count, and
  its "New — not yet accepted" badge suppressed, because that badge names the
  wrong tap: the answer for a leftover is Cancel, not Accept.
- **A string comparison, not a date.** `businessDay` is `Char(10)` "YYYY-MM-DD",
  which sorts lexicographically exactly as it sorts chronologically. Nothing is
  parsed, so the `new Date(string)` ban is untouched. Tested across the month
  and year rollovers, which is where an unpadded format would have failed.
- **No new file, no migration, no bulk button.** The predicate went into the
  module that already owned the queue's shape; nothing about the schema changed;
  and a "close them all out" control would have to choose the terminal state
  the whole item refuses to guess.
- **`loadGateState` gave up its single round trip.** The count needs the
  restaurant's calendar, which needs the settings row, so settings-and-hours
  now resolve before the count. The property that file's header warns about is
  preserved: the gate and the estimate still read exactly ONE count.

**Left behind:**
- **Local midnight is hard-coded as the service boundary.** A venue whose
  service runs past it would see every live ticket flag at 00:00. Not reachable
  today — the C-022 CHECK constraints refuse a `closeMinute` past 1440 — and
  marked with a `ponytail:` comment naming the upgrade: a service-day offset in
  settings that `businessDayOf` subtracts.
- **`isLeftOver` is expressed twice, in two dialects** — once in TypeScript for
  the screen, once as a Prisma `businessDay: { gte: today }` for the count. The
  comment at the where-clause names it as the negation of the predicate. Doing
  it in one dialect would mean loading every open order into memory to filter
  it, which is unbounded exactly when it matters.
- **Nothing prompts staff at opening.** The banner is there when someone looks
  at the queue. A restaurant that opens the screen at 11:05 sees it then, not
  at 11:00, and there is no notification. P1-3's outbox is the shape that would
  carry one.
- **The C-031 screenshots still predate C-037, C-038 and this.** Re-run with
  `SCREENSHOTS=1` when the portfolio page is next rebuilt.

C-039 committed at de31384.

## C-040 — The screenshots caught up

**Built:**
- Three new captures in `screenshots.spec.ts`: `12-staff-login` (C-037),
  `13-unpaid-card` (C-038) and `14-leftover` (C-039) — the three surfaces that
  shipped after C-031 and had no picture anywhere.
- All fourteen regenerated. Six of the eleven existing ones changed: every
  kitchen and status shot now carries the C-038 payment badge, which is the
  point — the old set showed an app that no longer exists.
- The three new blocks in `docs/WRITEUP.md`'s *The Screens*, and the portfolio
  page rebuilt (`node docs/portfolio/build.mjs`, 1.14 MB).

**Decided:**
- **The sign-in shot is the one taken signed out**, in its own `describe` with
  `test.use({ storageState: { cookies: [], origins: [] } })` — the same opt-out
  `auth.spec.ts` uses, and for the same reason: global setup hands every other
  context a cookie that makes the login page unreachable.
- **The unpaid ticket is placed through the real checkout**, not written to the
  database. A screenshot of a hand-built row would be a picture of a fixture;
  this one is the badge a real pay-at-pickup order carries, priced by the
  server.
- **No new portfolio section.** The page's seven slots are arguments, not a
  gallery, and none of the three new items is an argument it makes. The rebuild
  is what the item owed; the images inside it are now current. The one edit
  there is `IMG_CARD`'s alt text, which described a card that has since grown a
  payment badge.
- **The login shot was re-taken at 760×380.** At 900×700 it was two-thirds
  white space — an honest picture of an empty page, and a bad one.

**Left behind:**
- **`backdateQueue()` moves `businessDay`, not `placedAt`,** so the leftover
  card reads "2 min since ordered" under a badge saying 2020-01-01. True to
  what the fixture edits, and slightly odd to look at. Ageing the timestamp too
  would make the picture prettier and the fixture less honest about which
  column the feature reads.
- **Nothing checks that the screenshots match the app.** They are regenerated
  by hand when someone remembers, which is exactly the debt this item paid off
  — C-031's set went three items stale. A gate step cannot own it: the captures
  write into `docs/`, and the gate must not touch the working tree.

C-040 committed at 07ead94.

## C-041 — The queue is measured in work

**Built:**
- `MenuItem.prepWeight` (integer, default 1, `CHECK BETWEEN 0 AND 50`) and
  `Order.prepWeight` — the second one snapshotted at placement as
  `Σ item.prepWeight × quantity`, with its default dropped after the backfill
  so placement must supply it.
- `checkoutGate` now reads `openWeight >= maxOpenWeight`; `readyEstimate` now
  reads `prepBaseMinutes + prepPerWeightMinutes × openWeight`. Both settings
  columns were RENAMED with their CHECK constraints, so the compiler and the
  database moved together.
- `loadGateState` swapped its `count()` for an `aggregate({_sum: prepWeight})`
  under the same `businessDay >= today` filter — still ONE read feeding both
  the throttle and the estimate.
- The sample menu weighs itself: a plate off the flat-top 3 (fajitas 4), a
  burrito 2, a scooped side 1, a bottle out of the fridge 0.
- The menu editor grows a prep-points field per item — a POST that saves
  straight away — and the settings screen's two service numbers now say "prep
  points" instead of "orders".
- Tests: an `openWeight` unit case in the gate ("a queue of drinks is not a
  queue of plates"), a quantity-multiplied snapshot case in `placement.test`,
  a `weighs the work, not the tickets` case in `gate.test` placing four
  bottled waters for zero weight, two e2e cases on the new field, and
  `prepWeight: 50` added to the item mutation in the snapshot regression.

**Decided:**
- **Weight is snapshotted, not joined.** `Order.prepWeight` is a copied number
  like the prices are. Re-weighting a fajita plate at 3pm must not change how
  heavy the 2pm queue was — the same rule that makes a receipt immutable, and
  it is now asserted by the regression test that mutates every referenced menu
  row.
- **Rename, don't add-and-drop.** `maxOpenOrders → maxOpenWeight` and
  `prepPerOrderMinutes → prepPerWeightMinutes` are the same settings with a new
  unit, and a rename carries the value, the CHECK and the NOT NULL across.
  Existing values are converted by `ROUND(× 2.4)` — the same factor the new
  default comes from (25 orders × 2.4 = 60), deliberately under the 2.7 the
  seeded rush actually measures, because erring toward pausing early is the
  safe direction for a kitchen.
- **Measured, not guessed.** The 2.4/2.7 numbers are from the seeded rush:
  30 orders, mean weight 2.73, heaviest 5, and a live-demo peak of 47 open
  weight against the new threshold of 60. The demo still fills the queue
  without tripping the auto-pause, which is what it is for.
- **Prep points get no confirm panel.** The price confirm exists because
  $1.50 → $15.00 is a valid price a customer pays. A weight is not money and no
  customer sees it, so a second ceremony on every row would only teach staff to
  tap through the one that matters. Said out loud on the screen: "Prep points
  save straight away — they are kitchen workload, not money."
- **Zero is a legal weight.** A canned drink costs the kitchen nothing, so it
  should neither hold the door shut nor lengthen anyone else's quote. The
  CHECK allows 0 and the estimate's existing floor keeps a queue of drinks from
  reading as "right now".

**Left behind:**
- **Weight is per ITEM, not per modifier.** A burrito with eight add-ons weighs
  the same as a plain one. Pricing every option for labour is a model this
  product does not have; the upgrade is an additive field on the option and a
  second term in one reduce, which is the shape the item weight already has.
- **`OrderLine` carries no weight column.** The order-level sum is what both
  readers need, so a per-line copy would be a column nobody reads. It also
  means the report cannot say which LINE of an order was the heavy one.
- **Nothing recomputes the estimate a customer was already quoted.** The
  status page recomputes on every poll, as it always did, but an order placed
  when the queue was light keeps no record of what it was promised — so
  "were we honest?" is still unanswerable, which is exactly what P1-4 is for.
- **The write-up's By-the-Numbers table is stale again** — 5 migrations and 13
  CHECK constraints now, and it still says 4 and 11 (it was last refreshed at
  C-030, ten items ago). Half-updating the rows this item touched would make
  the table read as current when its test counts are not, so it stays for a
  C-030-style catch-up.
- **The 2.4 conversion factor is a one-time judgement.** A restaurant whose
  menu is mostly drinks would want a different one, and the migration cannot
  know that. The operator screen is the answer, and the bound (1–500) is wide
  enough for either extreme.

C-041 committed at b7addfd.

## C-042 — An order remembers what it was promised

**Built:**
- `Order.quotedLowMinutes`, `quotedHighMinutes`, `quotedOpenWeight` — three
  NULLABLE integers, snapshotted at placement off the SAME `loadGateState`
  read the checkout gate already made, so the quote stored on the order is the
  one the checkout screen showed and not a second reading of a queue that moved
  in between.
- Four hand-written CHECKs: all-three-or-none (`num_nonnulls(...) IN (0, 3)`),
  high strictly above low (it is a range, never a point), low above zero
  ("0–10 min" reads as "now"), and a non-negative open weight.
- `estimateAccuracy` in `packages/core/orders/estimate.ts` — pure, alongside
  the function whose promises it grades. Counts early / on-time / late, takes
  the MEDIAN signed minutes outside the window, splits the samples at the
  median queue depth, and returns a `QuoteAdjustment` naming which of the two
  P0-7 settings to move and which way.
- `loadQuoteSamples(since)` in `packages/db/report.ts` — the third loader on
  the report screen, filtering to orders that carry a quote AND reached
  `ready`, pairing each with the LAST `ready` event off the append-only log.
- A "Were the quotes honest?" section on `/kitchen/report`: four stat tiles, a
  two-row light-half / busy-half table, and one sentence naming the setting to
  move in the words the C-023 settings screen uses.
- Tests: ten `estimateAccuracy` unit cases, four db placement cases (the quote
  is snapshotted, the second order is quoted against the first, a settings
  change does not rewrite it, a double-submit replays the ORIGINAL quote), five
  constraint cases, five loader cases including the wrong-advance-then-undo,
  and two e2e.

**Decided:**
- **The quote is a snapshot, and the third column is why.** Two columns prove
  the estimate is wrong; three say which of the two settings is wrong.
  `quotedOpenWeight` is the queue that was in front of the order, and without
  it P1-4's actual headline — "adjust the increment" — is unanswerable, because
  a flat bias and a queue-shaped bias look identical.
- **Nullable, and deliberately not backfilled.** Every other snapshot column
  could be reconstructed from rows that existed at the time; a promise cannot,
  because the queue depth at 12:04 last Tuesday is gone. Inventing one would
  make the report grade orders against a quote nobody ever saw — the exact
  dishonesty the item exists to remove. NULL means "no record", and the loader
  skips those rows.
- **Early is a miss.** A customer told "15–25 min" and handed a bag at six
  waited nine minutes at the counter they were told to spend elsewhere. Scoring
  that as a win would tune the estimate in precisely the wrong direction, so
  `early`, `onTime` and `late` are three counts and only the middle one is
  good.
- **The miss is measured from the nearest EDGE, and taken as a MEDIAN.** Inside
  the range is zero — grading against the centre would score a correct quote as
  a miss, which defeats the point of quoting a range. And one ticket that sat
  on the pass for two hours because nobody tapped it is a data-entry story, not
  a prep-time story; a mean would let it rewrite the setting.
- **Under ten samples it recommends nothing.** "Not enough to say yet" is a
  real answer and a different one from "the quotes are holding up" — the screen
  prints them as different sentences. Same discipline as C-016's null no-show
  rate.
- **The LAST `ready`, not the first.** An order advanced by mistake and sent
  back (the C-004 logged revert) was not ready the first time somebody said so.
  The correction is the truth, and the append-only log is the only thing that
  still knows both happened.
- **The engine decides the fact, the page writes the words.** `QuoteAdjustment`
  is `{setting, direction}` — no sentence in `packages/core`, so the wording
  can change without touching a tested function.

**Left behind:**
- **No least-squares fit.** A two-parameter regression over (openWeight,
  actual) would name both numbers at once instead of one, and the median-split
  comparison is the lazy stand-in. Deliberate: thirty orders across a narrow
  band of queue depths is not enough to fit two parameters against, and a
  suggestion that swings every service is worse than none. Marked `ponytail:`
  in `estimate.ts` with the fit as the named upgrade path.
- **Nothing applies the suggestion.** The report names a setting and a
  direction; a human types the number on the settings screen. An auto-tuning
  loop that silently moved a customer-facing promise is exactly what C-023
  exists to prevent, and it would also need a guard against tuning itself off
  its own output.
- **The suggestion has no magnitude.** "Raise the base prep time" does not say
  by how much, because the honest number is the median miss and saying so would
  read as arithmetic the screen had already done. The median miss IS on the
  table two lines above it.
- **The split is halves, not buckets.** Light-versus-busy is two rows; a
  restaurant with a genuinely non-linear kitchen (fine below a threshold, falls
  off a cliff above it) would want the curve, and this cannot show one.
- **The status page still shows a live recomputed estimate**, not the quote the
  order carries. That is deliberate — a customer watching a queue get busier
  should see the window move — but it does mean the number on a customer's
  screen and the number this report grades can differ, and nothing says so on
  the page.
- **The report screenshot is stale as of this commit.** `/kitchen/report` has
  grown a section the C-040 capture does not show, and the portfolio page is
  built on that capture. Not regenerated here — the screenshot sweep is its own
  item (C-040 was one, C-031 before it) and half-refreshing one image out of
  fourteen is how a set drifts.
- **The write-up's By-the-Numbers table is stale again** — counted off the
  database rather than off the last entry: 6 migrations and **20** CHECK
  constraints, against the 4 and 11 the table still claims. Worth noting that
  C-041's entry said 13, which was already wrong; a number nobody re-counts
  drifts whether or not the table is refreshed. Untouched here for the same
  reason as C-041 — half-updating it makes it read as current.

C-042 committed at 8fdf37d.

## C-043 — The wipe refuses to leave this machine

**Built:**
- `packages/db/local-guard.ts` — `assertLocalDatabase(action, env)`, plus the
  two small pure functions it is made of: `databaseHost(url)` (the authority,
  or the socket directory libpq takes from `?host=`) and `isLocalHost(host)`.
- One call site: `resetDatabase()` in `packages/db/testing/index.ts`. Every
  destructive path in the repo — `db:seed:test`, `demo:rush`, `db:rush:test`,
  the e2e `reseed()` (which shells out to `db:seed:test`), and all nine
  packages/db test files — routes through that TRUNCATE, so the guard is one
  call rather than one per caller.
- A CLI entry point in the same file, for the one destructive script that
  never touches Prisma: `db:reset:test` now runs
  `dotenv -e .env.test -- tsx packages/db/local-guard.ts "db:reset:test"`
  before its `dropdb`. It prints the refusal and exits 1 — the message, not a
  stack trace, because that is an operator reading a refusal.
- `COUNTERTOP_ALLOW_REMOTE_WIPE`, the one deliberate override. It takes the
  HOST being wiped, not a boolean.
- Eight unit cases, all pure — no database, which is the point: the guard has
  to decide before anything connects. Local in four shapes, a Neon URL refused
  by name, a remote `PGHOST` refused while `DATABASE_URL` is local, an
  unparseable URL refused, and the override accepted for the exact host and
  rejected as `1` or as some other host.

**Decided:**
- **The URL is the subject, never `NODE_ENV`.** An env var nobody set is not a
  safety mechanism, and the variable that actually decides which rows get wiped
  is the connection string. `NODE_ENV` is unset in exactly the situation this
  guards against — someone running a script by hand at a terminal.
- **`PGHOST` is checked too, separately.** `db:reset:test`'s `dropdb` and
  `createdb` read `PGHOST` and never look at `DATABASE_URL`; the two settings
  are independent and can disagree. Checking only the Prisma URL would have
  left the one script that drops a whole database unguarded.
- **The override names the host.** A boolean `=1` exported once in a shell
  profile disarms the guard on every machine, in every repo, forever — which is
  the failure mode the guard exists to prevent, arriving six months later. A
  value that has to be re-typed per host cannot rot into a default.
- **Unparseable refuses.** An empty or malformed `DATABASE_URL` is not
  "probably local"; `databaseHost` returns `<unparseable>` and the guard says
  no. Nothing that wipes tables should treat a missing connection string as
  permission.
- **A unix socket is local by construction.** `postgresql:///db?host=/tmp` has
  no network to be remote over, so a host starting with `/` passes.

**Left behind:**
- **The migration scripts are not guarded.** `db:migrate:dev` and
  `db:migrate:all` can reach a cloud database and are meant to — C-045 has to
  migrate Neon deliberately. Applying a migration is not the failure mode this
  item names; TRUNCATE is.
- **The seed and rush print a stack trace, not a clean refusal.** They throw
  from inside `resetDatabase()`, so Node's default handler renders it. The
  message is the first line and reads fine; the tidy exit path exists only on
  the CLI entry point, where there was no caller to carry the error.
- **`db:reset:test` still hardcodes `countertop_test`** rather than dropping
  the database `DATABASE_URL` names. Loading `.env.test` in front of it now
  means the guard and the `dropdb` at least read the same file, but they are
  still two statements of the same fact.
- **Nothing stops a remote `DATABASE_URL` from being *read*.** This is a wipe
  guard, not a connection policy. The standing rule that tests never point at a
  remote database is still a rule, not a mechanism — a remote URL under
  `npm test` gets caught by the first `resetDatabase()`, which is early, but it
  is not the same as refusing to connect.
- **The write-up's By-the-Numbers table is still stale** — 6 migrations and 20
  CHECK constraints against the 4 and 11 it claims, unchanged since C-042 said
  the same thing. This item added no migration and no constraint, so it did not
  make it worse.

C-043 committed at 6ae6186.

## C-044 — The repo goes public, and CI comes back

**What it built:** nothing, in the sense of application code. This item changed
a repository setting and hardened one workflow file, and its whole value is
that the gate now runs somewhere other than this laptop again.

The billing block has stood since C-029: every `CI` run on a GitHub-hosted
runner died in about four seconds without executing a step, and the C-036
self-hosted runner has been the only working CI since. Public repositories get
GitHub-hosted Actions minutes for free, so the flip is the direct fix — not a
workaround for the block, the thing the block was asking for.

**What it decided:**
- **The history audit was re-run, not trusted.** C-042 audited it and the
  memory of that audit is not evidence. Filename scan across every commit
  reachable from every ref returns exactly one match, `.env.example`, names
  only. A content scan for connection strings with passwords, `sk-`/`ghp_`/
  `github_pat_`/`AKIA` prefixes and PEM private-key headers returns four
  distinct hits, all deliberate: `postgres:postgres@localhost` in `ci.yml`
  (a throwaway container GitHub destroys with the job) and
  `u:p@ep-cool-name-123...neon.tech` in `local-guard.test.ts`, which is a
  fixture asserting that a Neon host is refused. `STAFF_PASSCODE=ci-runner`
  appears in the self-hosted workflow and is the disposable value gating a
  queue screen on a throwaway database. A public repo makes every blob
  readable forever; the audit costs two commands and the alternative is
  rotating a credential after the fact.
- **The self-hosted runner is deregistered, and its workflow is
  `workflow_dispatch`-only.** This is the part C-044's backlog entry did not
  anticipate. `runs-on: self-hosted` executes the checked-out repository's
  code on the developer's Mac. On a private repo only trusted people can push
  that code; on a public one, a fork-reachable trigger is a stranger's pull
  request running arbitrary commands on this machine, which is why GitHub
  documents self-hosted runners as unsafe for public repositories. Neither
  existing trigger — `push` to `main`, `workflow_dispatch` — is fork-reachable,
  so nothing was exploitable at any point. The hazard is not the current file,
  it is the next edit to it.
- **The workflow file survives the runner.** Retiring the runner as a
  *dependency* is the goal; deleting the knowledge of how to run CI on this
  machine is not. The file keeps its full recipe and gains a comment naming the
  hazard in the imperative, because the failure mode is a future session adding
  `pull_request` to it in good faith.
- **`ci.yml` needed no change to go public.** Its `pull_request` trigger runs
  on GitHub-hosted runners with a read-only token and no access to secrets,
  which is exactly the arrangement that makes fork PRs safe.

**Left behind:**
- **The runner's absence is a comment, not a mechanism.** Nothing in the repo
  prevents a future edit from adding `pull_request` to
  `ci-self-hosted.yml` — the protection is that no runner would pick the job
  up, which lasts precisely until someone re-registers one. A ruleset or a
  workflow-lint would be the mechanism; a warning in a header is what this item
  shipped.
- **`ci.yml` has never completed a run.** It has been correct-on-paper since
  C-029 and dying on billing ever since, so this item is the first time any of
  it executes. Steps that never ran on Linux — the Playwright browser install,
  the `psql` heredoc, the port-3400 e2e leg — are unproven there in a way the
  macOS runner could not test.
- **The self-hosted workflow is now unreachable in practice.** Dispatching it
  with no runner registered queues the job rather than failing it. That is the
  documented escape hatch behaving as designed, but the first person to use it
  will wait on a spinner before realising a `gh` re-registration comes first.
- **The write-up's By-the-Numbers table is still stale** — 6 migrations and 20
  CHECK constraints against the 4 and 11 it claims, called out at C-042 and
  again at C-043. This item added no migration and no constraint.

C-044 committed at 0d492ee.

### C-044 addendum — the flip was reverted the same day

The repo was returned to **private** about half an hour after going public, by
decision, and the runner was re-registered. What the item proved survives the
revert; where it landed does not match what the entry above describes.

**What the public window proved.** `ci.yml` has been correct-on-paper since
C-029 and had never executed a step. While public it ran green twice, and both
runs reconciled: e2e 105 passed + 14 skipped = 119 against `--list`, unit
418/418 under `TZ=UTC` and `TZ=Pacific/Kiritimati`, zero failed steps. The
first ran on Node 22 (`v22.23.2`), the second on Node 24 (`v24.19.0`) after
`86ee14d` swapped `node-version` for `node-version-file: .nvmrc`. So the Linux
leg, the `psql` heredoc, the Playwright install and the port-3400 e2e run are
no longer unproven — the "left behind" note above saying they had never run is
now answered.

**What the revert costs.** Private re-arms the billing block, so `ci.yml` is
dead again. It is not wrong, it is unpaid.

**The runner is back, and its safety is conditional.** It was deregistered as
the precondition for being public, which briefly left the repo with no CI at
all. It is re-registered and `ci-self-hosted.yml` has its `push` trigger back,
because `runs-on: self-hosted` is safe on a private repo by construction — only
people already trusted with the machine can put code in the repo. The header
now states the condition rather than the conclusion: the trigger comes off and
the runner gets deregistered *if the repo is ever public again*. The earlier
version of that comment said "this repo is public, never add a fork-reachable
trigger", which would have been quietly wrong the moment visibility changed
back. Visibility is what decides, so the comment has to name visibility.

**Left behind by the revert:**
- **C-045 has a prerequisite this addendum did not resolve.** Deploying to
  Vercel and Neon does not require a public repo, but it does mean a hosted
  database exists — and CI is currently the self-hosted runner only, on a
  machine that also holds the local Postgres the C-043 guard protects.
- **`.nvmrc` says 24, local Node is 26.3.1.** `86ee14d`'s stated goal was to
  stop local and CI drifting apart, and it pinned CI to a third version instead
  of either. `engines: ">=24"` permits 26, so nothing complains. CI is green on
  24 and the laptop is green on 26; the drift the commit set out to close is
  still open, now with a file that claims otherwise.
- **The C-044 entry above reads as if the repo is public.** It is left as
  written rather than rewritten, because it is an accurate record of the item;
  this addendum is the correction.

C-044's addendum committed at a91f5f0.

## C-045 — Deployed

**What it built:** the PRD's stated target. Next.js on Vercel, Postgres on
Neon, a live URL — **https://countertop-mu.vercel.app** — with the menu and a
mid-service rush already in it. Plus `scripts/deploy-smoke.mts`
(`npm run smoke:prod`), an eight-check Playwright pass against the *deployment*
rather than a local build, and `db:migrate:prod` / `db:status:prod`.

**What it decided:**
- **A standalone Neon account, not Vercel's marketplace resource.** The
  marketplace route provisions and wires the connection strings in one command,
  which is genuinely less work; it also puts the database in a Vercel-linked
  org and couples its lifetime to the project. The database is the thing worth
  keeping, so it lives where its owner can see it.
- **`db:migrate:prod` exists; `db:seed:prod` deliberately does not.** The
  migrate and status scripts are the same shape as their `:dev` and `:test`
  siblings and read a gitignored `.env.production.local`. They are NOT added to
  `db:migrate:all` — production stays a separate command, per the standing
  rule. There is no committed script that wipes and re-seeds the deployed
  database, because a one-liner that truncates production is a footgun with a
  name and a tab-completion. The rush was seeded once, by hand, with
  `COUNTERTOP_ALLOW_REMOTE_WIPE` naming the Neon host — the single deliberate
  override C-043 built the guard around, used exactly once, for exactly this.
- **`--until 12`, not a full rush.** A complete rush ends with every order in a
  terminal state and an empty queue, which is the correct result and a useless
  first impression. Stopping at minute 12 leaves twenty-two orders live across
  `accepted`, `preparing` and `ready`, plus the 86 and the no-show.
- **The functions are pinned to `cle1`** in `apps/web/vercel.json`, because
  Vercel defaults to `iad1` (us-east-1) and the Neon project is us-east-2.
- **The passcode was generated, not chosen.** It is set in Vercel as a
  Sensitive variable and recorded in the gitignored `.env.production.local`,
  which is the only local copy — Vercel cannot read a Sensitive value back out.
- **The Prisma client moved to its default output location.** This was forced
  by the deploy-only defect below, and it is the item's one real code change.

**The defect, because it took three deploys:** every database-backed page
returned 500 with `could not locate the Query Engine for runtime
"rhel-openssl-3.0.x"`. Not a missing engine — Vercel builds on Linux, where
`native` *is* that target. Not a tracing failure either; `binaryTargets` and
`outputFileTracingIncludes` were both added, both did nothing, and both were
reverted. The cause was `config.isBundled = true` in the build log: Turbopack
bundled the Prisma client, and a bundled client has no directory to resolve its
`.so` against. `serverExternalPackages` is the mechanism for keeping a package
out of the bundle, and it takes package *names* — which a client generated to
`packages/db/generated/client` and imported by relative path does not have. The
custom output path, chosen so the client would sit beside its schema, is what
made it unexcludable. Dropping it makes the client `@prisma/client`, an
ordinary name, which the config excludes and Turbopack leaves alone.

**What that touched:** `packages/db/index.ts` imports `@prisma/client`;
`.gitignore` and `eslint.config.mjs` lost their now-dead `packages/db/generated`
entries; `ci.yml`'s "did postinstall run" assertion now checks
`node_modules/.prisma/client`.

**Left behind:**
- **CI did not run this item.** The repo is private, so `ci.yml` is still
  billing-blocked; the self-hosted runner is what verified the push. The gate
  ran locally in full.
- **Nothing re-anchors the deployed rush.** The orders age from the instant
  they were seeded and never refresh. Re-seeding is one command; a scheduled
  job to keep a demo looking alive was judged more machinery than the demo is
  worth.
- **`smoke:prod` hardcodes the production URL as its default** and reads the
  passcode from `.env.production.local`, so it runs on this machine and nowhere
  else. It is not in `npm run gate` — the gate must not depend on a network or
  on live data.
- **The smoke is read-only.** It signs in and looks. Placing a real order
  against the deployment would prove more and would also put test rows in the
  only database a visitor sees.
- **`.env.production.local` is now the single copy of the passcode.** Vercel
  stores it as Sensitive and will not hand it back. Losing the file means
  rotating the variable, which signs every device out — the documented
  behaviour, not a surprise, but there is no second copy.
- **The By-the-Numbers table is still stale** — 6 migrations and 20 CHECK
  constraints against the 4 and 11 it claims. Called out at C-042, C-043 and
  C-044; this item added neither, and did not fix the table either.

C-045 committed at 82aadc6.

### C-045 addendum — why `regions: ["cle1"]`, and why the reason is not in the file

`cle1` is us-east-2, the same AWS region as the Neon endpoint. Vercel's
default is `iad1` (us-east-1), which puts a cross-region hop on every query of
every request.

That explanation was originally written into `apps/web/vercel.json` as a
`"comment"` key, and it broke production: Vercel validates that file against a
strict schema and **rejects unknown properties outright**. The deployment did
not warn or ignore the key — it failed with

    The `vercel.json` schema validation failed with the following message:
    should NOT have additional property `comment`

The preceding deploy had been green, so the only change was the file this
repo's own convention says should explain itself. JSON has no comment syntax
and Vercel's schema allows no substitute, so the note lives here instead —
this is the one class of file in the repo where the reasoning cannot sit
beside the code it explains.

## Housekeeping — C-044 ticked, the By-the-Numbers table caught up

Two loose ends left after C-045, neither of which needed new code.

C-044 was left `[~]` because its own text deferred the visibility decision
to C-045. C-045 shipped with the repo private, which answers it — ticked to
`[x]`, and the backlog line now says so instead of pointing forward at an
item that has since landed.

The By-the-Numbers table (called stale at C-042, C-043, C-044, and C-045
itself) is recounted from the tree rather than incremented by guess: 45
items shipped, 99 commits, 16,914 TS/TSX lines across 108 files (41% tests),
418 unit tests in 22 files, 119 e2e tests in 14 files, 7 migrations carrying
25 CHECK constraints, 12 recorded defects, build window 2026-08-25 →
2026-08-29. No `left behind` this time — the table checks its own numbers
against the repo every time it's touched, that's just not automated.

Committed at f35d8fc.

## Housekeeping — .nvmrc actually pinned to what runs here

`86ee14d`'s own commit message named the drift it meant to close — "local dev
ran whatever nvm last selected (26.3.1 here, against CI's 20/22/24)" — and
then pinned `.nvmrc` to 24 anyway, closing the gap on the wrong side. The
laptop was still 26.3.1; only the number in the file changed.

`.nvmrc` now reads `26`, matching what's actually installed here and on the
self-hosted runner (same machine). `engines: ">=24"` is unchanged — it's a
floor, not a pin, and 26 already satisfies it. `ci.yml`'s
`node-version-file: .nvmrc` picks this up automatically; it hasn't run since
the repo went private, so this is unverified there the same way the rest of
C-044/C-045 is, until CI or the self-hosted dispatch actually executes it.

Committed at c68d1fb.

## C-046 — A receipt that outlives the queue

Found by running exploratory e2e testing against the deployed app's shape: an
admin-agent pass verified the snapshot rule by placing an order, then had no
way to pull that order back up once it left the live queue — the only route
back to it was the customer's own tracking link. `/kitchen` never grows a
route for "what did we serve this person last week," and staff have no way to
answer a dispute about a picked-up order without asking the customer to find
their receipt link.

The same pass turned up a second candidate — a dedicated end-of-day
reconciliation screen — but that one was checked against the PRD before being
built, and turned out to already be answered: P1-6 (C-039)'s leftover-flag
sweep is documented as the complete, shipped mechanism, and a second one would
compete with it rather than fill a gap. Skipped, not built.

**Built:**
- `packages/db/history.ts` — `searchOrderHistory(query)` and
  `findOrderByIdForStaff(id)`, both built on `ORDER_RECEIPT` from
  `placement.ts` (never a menu `include`, so a repriced or renamed menu row
  still reads back exactly as it was on the day this order was placed). No
  `QUEUE_STATUSES` filter anywhere in this file — the entire point is every
  status, not just the open ones.
- `historyWhere(query)`, the one function here with a decision in it, pulled
  out on its own so it gets a test that never touches Postgres: a bare number
  matches `seq` alone, not `seq` scoped to a business day. `seq` resets every
  day (`packages/db/placement.ts`), so unlike the live queue's own
  `matchesLookup` — which only ever has today's orders to disambiguate — a
  number typed into history search can legitimately match more than one day's
  `#047`. Returned as a list, dated, rather than silently picking one.
- `apps/web/app/kitchen/orders/page.tsx` — the search list, a plain GET form
  matching the queue's own lookup UX (`?q=`, works before hydration, "Show
  all" clears it).
- `apps/web/app/kitchen/orders/[id]/page.tsx` — the receipt itself. Read-only
  by construction: no server action is imported into this file, so there is
  nothing here to route-guard beyond the `/kitchen/:path*` middleware every
  other staff page already gets for free. Renders the same
  `describeSelection` negation styling as the status page and checkout.
- `apps/web/lib/format-time.ts` — `formatPlacedAt`, an `Intl.DateTimeFormat`
  read against the restaurant's own timezone (never the server's), next to
  `formatCents` and the other display-only formatters. Nothing here reads a
  clock or guesses an offset by hand.
- A nav link ("Order history") on the kitchen queue header, and five e2e
  tests: name search, number search, an empty-result state plus "Show all,"
  reaching an order a `seedFinishedRush()` has already carried past
  `picked_up` (asserted by absence of every OPEN-queue status label, so the
  test would fail if this page secretly reused `loadQueue()`), and an
  accessibility pass on both the list and the detail screen.

**Decided:**
- **Checked the PRD before writing code, for both candidates from the same
  testing pass.** One (this item) was a genuine gap — never mentioned, in
  scope or out. The other (a closeout screen) was already resolved by C-039
  and would have been a second, competing answer to a question the PRD only
  asks once. The Open Questions rule ("resolved means resolved, never
  re-open") extends naturally to "shipped means shipped, don't reship."
- **The internal `id`, not the customer's `statusToken`, keys the staff
  route.** The token exists because a URL that leaves the building must not
  be a key a stranger can enumerate; a staff-only page behind the same
  middleware as every write action has no equivalent reason to hide its id.
- **Capped at 50 results, unconditionally.** A bare search box against every
  order this restaurant has ever taken is one empty query away from becoming
  the report page's job by accident.

**Left behind:**
- **No pagination past the 50-result cap.** A restaurant old enough for a
  common name to return more than fifty orders needs a narrower search
  (a date range, most likely) before this stops being enough — not built,
  because nothing in the seeded data or the rush demo is old enough to hit it.
- **The detail page has no link back to a specific search.** "← Order
  history" always lands on the unfiltered list, dropping whatever query led
  there. A `?returnTo=` round-trip would fix it; the walk-up dispute this item
  exists for is a single lookup, not a session of back-and-forth, so it was
  judged not worth the extra parameter yet.

C-046 committed at 3252dda.

## C-047 — The undo that had nowhere to live

A second exploratory pass, run the same way C-046's was: three agents driving
the running production build black-box — one as a customer, one as kitchen
staff, one as the operator — alongside a green Playwright suite. The admin
lane died partway through on an account rate limit, so the settings / menu
editing / 86-propagation surfaces got only a partial pass (settings field
validation, which it cleared with no findings, and no lasting mutations). That
half is genuinely untested by this session and is written down as such rather
than counted.

The headline finding is not a typo-class bug. `STATUS_FACTS.picked_up.previous`
is `'ready'` and `abandoned.previous` is `'ready'` — both deliberate, both
commented ("the fat-fingered advance needs its undo"), both covered by unit
tests, and `undoRemainingMs` computes a real countdown for them off the event
log. None of it was reachable. `loadQueue()` selects `QUEUE_STATUSES`, and
`picked_up`/`abandoned` are `inQueue: false`, so the tap that starts the
five-second countdown is the same tap that stops the card carrying the button
from being drawn. The engine was right and the screen never asked it.

**Built:**
- `UNDOABLE_EXIT_STATUSES` in the state machine — every status that leaves the
  queue while still having a `previous`. Derived from `STATUS_FACTS`, not
  spelled out, so a future terminal state joins the strip by existing.
  `cancelled` is excluded by the same derivation, correctly: it has no
  `previous`, because un-cancelling would have to un-refund.
- `loadRecentlyFinished()` in `packages/db/queue.ts` — a separate query, not a
  wider `loadQueue`, because the queue's list is what the leftover sweep, the
  un-acknowledged count and the groupings are all derived from and none of
  them mean the same thing with finished orders mixed in. Ordered by
  `statusChangedAt` and capped at ten rather than filtered against a cutoff
  instant, so it does no date arithmetic at all.
- The "Just finished — undo if that was a mistake" strip on `/kitchen`, above
  the status groups and deliberately not filtered by the lookup box: a cook
  who has typed a name in is still the person who just mis-tapped. It renders
  only while `undoRemainingMs` is non-zero, so it can never become a second,
  competing list of finished orders — that is `/kitchen/orders`.
- Checkout now catches up with its own refusal. Every error the server returns
  there means the screen is stale — the cart emptied in another tab, an option
  was 86'd, a price moved, the gate shut — and the summary, the estimate and
  the button all come from the server component *around* the form, which never
  re-rendered. A stale tab showed a full order summary, a live-looking "Place
  order — $11.85" button, and "Your cart is empty" underneath it,
  simultaneously.
- The same form now submits through `onSubmit` rather than `action`, because
  React resets a form after an action resolves — which on a *refusal* threw
  away the name the customer had just typed and made fixing a flagged line
  cost a retype. Nothing is lost: the idempotency key is generated
  client-side, so this form has never worked without JavaScript.
- Six back-links that were 17px tall in a codebase that holds its own queue
  cards to 48, and the header nav links, which cleared 48 in height but not in
  width — "Sales", the shortest label, was a 35px-wide target.
- `historyWhere` escapes LIKE metacharacters. `contains` compiles to SQL
  `LIKE` and Prisma passes the term through unescaped, so a typed `%` matched
  every order the restaurant has ever taken. Verified against real Postgres
  both ways: `%` matched 4 of 4 before, 0 of 4 after, and `Dana` still
  matches 1.

**Decided:**
- **The strip reuses `QueueControls` whole rather than growing a compact
  variant.** What a card offers is already derived from `STATUS_FACTS`, so a
  finished order gets exactly the undo (and, while unpaid, the collect
  control) and nothing else — no advance, no cancel, no no-show. A dedicated
  component would have had to re-derive that, and a `compact` prop would have
  been a flag standing in for a fact the status table already holds.
- **`statusChangedAt` + `take: 10`, not a cutoff instant.** The obvious
  version — `new Date(now.getTime() - UNDO_WINDOW_MS)` — is banned by this
  repo's own time lint, which refuses any `new Date(…)` that is not
  `Date.UTC`. The ban is over-broad on purpose and the right response was to
  find the query that needs no arithmetic, not to add the codebase's second
  lint exemption.
- **The closeout test's assertion was rewritten, not relaxed.** It had said
  "`abandoned` is not a queue status, so the card leaves the screen entirely",
  which was true and is now deliberately false — closing out a leftover is as
  mis-tappable as any other advance. It now asserts the card is out of the
  *queue* and in the strip, which is the fact that actually matters.

**Left behind:**
- **An unpaid order that reaches `picked_up` can never be marked paid.** The
  collect control only renders on a queue card, and the history receipt is
  read-only by construction. The strip gives it a five-second window it did
  not have, which is a mitigation and not a reconciliation path. The real fix
  turns a deliberately read-only page into a write surface and deserves its
  own item.
- **The admin/config exploratory lane never finished.** Menu editing,
  86-propagation across the three surfaces, the hours confirm flow and the
  report's timezone bucketing were not exercised by a human-style pass this
  session. All four have dedicated e2e specs; none of them had a black-box
  pass, which is exactly the difference that found everything above.
- **A search that is a bare number still cannot be narrowed by date.** Noted
  at C-046 and still true; the escaping fix touched the same function without
  changing that.

C-047 committed at 3d54de9.

## C-048 — Money owed outlives the queue card, and the lane that never ran

Two things C-047 left behind, done together because the first is what the
second was supposed to have found.

**The unpaid order that could never be settled.** "Collected — mark paid"
rendered only on a queue card, so an order handed over with the money not
collected became permanently uncollectable the moment it left the queue —
the till and the system disagreeing, with no screen able to reconcile them.
C-047's undo strip gave it a five-second window, which is a mitigation and
not a path.

The fix is a predicate, not a button. `canCollectPayment(status,
paymentState)` in the state machine answers "is there money to collect on
this?" for three readers: the queue card, the history receipt, and the server
action behind both. `unpaid` turns out to be necessary and not sufficient —
on a `cancelled` or `abandoned` order it is the correct *permanent* answer,
because nobody took the food, and collecting would invent revenue against a
no-show that is the numerator of a rate the owner acts on. Derived from
`salesRole`, so the question is asked of the one status module rather than
re-decided per screen.

That reading also caught a small wrongness C-047 itself introduced: an
`abandoned` order sitting in the new "Just finished" strip was offering to
collect, because `QueueControls` tested `paymentState === 'unpaid'` alone.
The same predicate fixes both call sites, which is the point of having one.

**The re-run admin lane.** C-047's third exploratory agent died on an account
rate limit with its whole lane untested. Re-run here, alone on the app this
time. It came back with one defect and a long list of things that are right,
which is worth as much: 86'ing a shared modifier option was correctly "sold
out" and not hidden on the menu, flagged in an open cart at both `/cart` and
`/checkout`, refused server-side when the disabled button was re-enabled by
hand, and invisible to an order already placed — checked on the queue card,
the staff receipt AND the customer status page. A live reprice, a unicode
group rename, the stale-confirm guard, close-before-open hours, negative and
absurd prices, blank-vs-$0.00 on an intensity surcharge, all three gate
triggers with no estimate ever shown while paused, and the report's
zero-data path all behaved.

**Built:**
- `canCollectPayment` in `packages/core/orders/state-machine.ts`, and its
  three readers moved onto it.
- The collect control on `/kitchen/orders/[id]`. That page's header comment
  changed from "read-only" to read-only *about the order* — it still has no
  advance, no undo, nothing that moves an order through the state machine,
  and the one write it now carries is guarded by the same middleware and
  re-asked by the server action.
- `collectPayment(formData)`, a form-shaped wrapper, so the receipt stays a
  server component with no client JavaScript of its own.
- `markOrderPaid` now refuses on the rule rather than only on `unpaid`, keeps
  its `updateMany` guard for the two-people-tapping-at-once case, and
  revalidates the `/kitchen` subtree rather than the one page.
- Four more 21px back-links — availability, menu, settings, report — and a
  loop that measures the back link on every staff screen. This class of miss
  has now happened three times, each on a page whose own controls were fine.
- `pickUp` moved from `report.spec.ts` into the shared fixtures on acquiring
  its second caller.
- The `actions.ts` header comment saying "there is no staff authentication in
  P0" — false since C-037, and exactly the kind of comment this project's own
  write-up has a lesson about.

**Decided:**
- **A plain form, not a client component.** The receipt has no client
  JavaScript and the reconciliation it exists for is one button. The refusal
  is swallowed rather than rendered, which is honest only because every
  refusal it can produce is legible in the re-render — the control is gone if
  it worked or if someone else got there first, and still there if it did
  not apply. A client component with an error line is the upgrade if that
  stops being true.
- **The `cancelled`/`abandoned` exclusion is the interesting half.** The naive
  fix — put the button wherever `paymentState === 'unpaid'` — would have
  shipped a button that books revenue against a no-show.

**Left behind:**
- **The report's timezone bucketing still has no black-box pass.** Both
  exploratory rounds declined it for the same honest reason: it needs the
  server's wall clock moved, which destabilises a shared environment. CI runs
  the unit suite under `TZ=UTC` and `TZ=Pacific/Kiritimati`, which is the
  assurance that actually covers it.
- **A history search that is a bare number still cannot be narrowed by date.**
  Third session carrying this.

C-048 committed at fd06d98.

## C-049 — The day a number belongs to

The last thing carried forward from C-046, named as left behind in three
consecutive PROGRESS entries: a history search that is a bare number could
not be narrowed by date.

**Why it was a real gap and not a nicety.** `historyWhere` matches a bare
number by `seq` ALONE, deliberately — `seq` resets every business day, so
"#047" is not a unique key across history the way it is on today's queue.
C-046 chose to show a dated LIST rather than silently pick a day, which is
the honest answer to an ambiguous key but only half a lookup: on a restaurant
with a few months of service behind it, "#001" is one row per day it opened,
capped at 50, newest first — and the order the customer is asking about is
the one that fell off the end.

**A native date input, and string equality.** `businessDay` is
`String @db.Char(10)` holding "YYYY-MM-DD" in the restaurant's timezone
(schema.prisma, where `@db.Date` is banned), and that is exactly what
`<input type="date">` submits. So the whole filter is `{ businessDay: day }`
— no picker library, no parsing, and, more to the point, no timezone
arithmetic anywhere in the path. A day boundary is the one thing this project
has the most rules about; the column having already decided it is why this
item is small.

**Built:**
- `historyWhere(query, day)` — the day sits BESIDE the term, not inside it.
  Prisma ANDs top-level fields, so a day narrows the `seq`/name `OR` instead
  of joining it, which is the difference between "#001 or that day" and
  "#001 on that day".
- `businessDayFilter`, which is where the trust boundary is: anything that is
  not `YYYY-MM-DD` is ignored rather than refused.
- The date field on `/kitchen/orders`, `Show all` clearing both halves, and a
  four-branch empty state so "no orders on 2026-08-30" reads as a sentence.
- Four unit tests and one e2e that backdates the seeded queue, places a fresh
  order today, and proves two different #001s exist and that the day picks
  one.

**Decided:**
- **Ignore a malformed day, don't refuse the search.** The only way to
  produce one is by hand-editing the URL; the date input renders blank for a
  value it cannot parse, so unfiltered results beside a blank date box is the
  state the screen would show anyway. An error page for a query string nobody
  typed is worse.
- **One date, not a range.** The question this answers is "which day's #047",
  and the answer is a day. A range is a report, and the report already
  exists.

C-049 committed at 786000e.

## C-050 — The tap that meant one thing and did another (defect D1)

The first of three defects the second-pass evaluation found. Not a backlog
item: a bug in shipped behaviour, and the highest-severity one in the set.

**What was wrong.** `applyTransition` has carried an `unexpected_target`
refusal since C-004, with a comment saying exactly what it is for — "two
cooks tapping the same card: the second tap names a target that is already
behind, and is refused rather than skipping a state." It fires on
`action.to !== undefined && action.to !== to`. Neither real caller passed a
`to`. The guard could not fire from a screen, in either direction, and never
had.

The database's compare-and-set (`updateMany where: { id, status }`) is not
the same protection. It catches two taps racing on the SAME read; it re-reads
current status first, so a tap from a card five seconds behind advanced the
order from wherever it had since got to. Two screens open on one board — the
ordinary case in a kitchen, not the exotic one — and a five-second poll made
the button labelled "Start cooking" mark an order picked up. The bag sits on
the pass while the customer is told at the counter that it was collected.

**Why it was found by an evaluator and not by a test.** The state machine's
own suite asserts the refusal thoroughly, by reason, and passes: the engine
was always right. What no test asserted was that the *screen* asks for it.
That is C-047's lesson repeating word for word — the engine was right and the
screen never asked — and it is now a test that fails if the target is ever
dropped again, verified by reverting the fix and watching it fail before it
was kept.

**Built:**
- `readTarget`, one guard in `kitchen/actions.ts`, treating the rendered
  status as what the file's own header already says every argument is:
  untrusted input. `undefined` stays legal, because the seed, the rush and
  the db tests drive the engine with no screen and have no rendered state to
  name.
- `advanceOrder(orderId, to)` **and `revertOrder(orderId, reason, to)`**. The
  ticket was about the forward tap; the backward one had the identical hole
  and the identical guard waiting for it, so fixing one and not the other
  would have left "Move back" walking an order back from a state the tapper
  never saw.
- The card passes `facts.next` and `previous` — the values it already had in
  hand to draw the button labels with. No new prop, no new query.
- One e2e test with two real pages, the stale one's poll blocked with
  `page.route()` so the assertion is deterministic rather than racing the
  five-second cursor.

**Decided:**
- **No revalidate on refusal.** C-047 established that revalidating on a
  rejection remounts `<QueueControls>` and destroys the error before anyone
  reads it. That decision stands: the refusal message names both states
  ("This order is accepted; the next state is preparing, not accepted"), and
  the poll brings the board current within five seconds on its own. Showing
  the reason beats silently correcting the screen.
- **The rendered target, not a version number.** A generic optimistic-
  concurrency token would work and would be a bigger change; the status the
  card drew is already the exact fact in dispute, and the engine already
  refuses on it.

C-050 committed at 42edee1.

## C-051 — The defence that expired two items after it was written (defect D2)

The second of the three defects. Not a backlog item and not a missed case
either: this one was written down, in `docs/WRITEUP.md`, as a deliberate
simplification with a reason — and the reason stopped being true.

**What was wrong.** `salesReport` sums the totals of every order whose
`salesRole` is `sold` and has never read `paymentState`. C-016 defended that
in the caveat list: *"revenue is what was charged, not what was collected"*,
honest for a shop that takes payment at the counter. C-038 made pay-at-pickup
a real and common state — about a third of the seeded rush — and C-048
established that an order can be handed over and stay `unpaid` indefinitely,
which is the entire reason the mark-paid control had to be added to the staff
receipt. Two items later the shop had a durable record of who had not paid,
and the report ignored it. Sunday night the screen says $478.55 for Friday,
the till says $431, and nothing in the product reconciles the two.

**Why the caveat list did not catch it.** Because a caveat list is read as
history. It described the behaviour accurately the whole time; what nobody
re-read was whether its *premise* still held after two items had gone to
work on the same column. Both C-038 and C-048 touched `paymentState` and
neither looked at what read it. Two independent evaluators found it from
opposite lenses (the GM's shift and the systems audit), which is the
strongest signal in the second-pass set.

**Built:**
- `PaymentSplit` on `SalesReport`: `collectedCents`, `outstandingCents`,
  `refundedCents`, the `outstanding` list, and `unpaidRate`. The three
  buckets sum to the window's revenue and none of them nets into another.
  Accumulated in the existing `sold` branch of the one loop — no second pass
  over the orders, no second query.
- The `switch` over `PaymentState` is exhaustive with a `satisfies never`
  default. Not decoration: "paid, else owed" would silently make a fourth
  payment state into money somebody owes, and this is the money path.
- `loadReportOrders` selects three more columns — `paymentState`, `seq`,
  `customerName`. The header comment that said names are never selected is
  corrected rather than quietly falsified: a chase list that says "$14.30 is
  owed" with nobody to ask is not a chase list. They are snapshot columns
  like everything else in that select; no menu table joined the query.
- A "Collected versus charged" section on `/kitchen/report`, first among the
  sales sections, plus an amber line under the stat row when anything is
  outstanding and a "Charged, not collected" note on the Revenue stat itself.
  The refunded stat renders only when non-zero — a $0.00 row is arithmetic,
  not a measurement, the same rule the hour bars already follow.
- Tests at all three grains: the engine's arithmetic (delta equals the unpaid
  order's total to the cent, the chase list is chronological, a refund lands
  in neither other bucket), the loader's shape against a real placement, and
  one e2e that pays one seeded order at the counter, walks both to picked up,
  and asserts the report names Dana and not Morgan.
- One line in the rush demo, so the capstone prints what it collected.

**Decided:**
- **Net sales keeps counting uncollected food** (2026-09-01 decision #1, not
  re-opened). Cash-basis revenue would retroactively redefine what every past
  report's headline meant, to fix a gap that a second number states directly.
- **The split covers exactly the set revenue covers.** Money taken for an
  order nobody collected is a till question, and the till is out of scope by
  decision #2 until the outstanding list stops explaining the variance. Said
  in a comment on the type, so the next person does not read the scope as an
  oversight.
- **The day comes from the same clock reading the day bucket used**, not from
  a second read of the `businessDay` column. One reading per order was
  already the rule here for DST reasons; a chase list is not the place to
  start a second way of deciding what day it is.
- **`refunded` gets its bucket even though it is structurally empty today.**
  The only refund the engine writes accompanies a `cancel`, and a cancelled
  order is not a sale — so the bucket totals zero and the screen hides it.
  It exists so that a refund which survives a pickup cannot land in
  "collected" the day somebody adds one.

**Left behind:**
- **C-050 had no `Defects Found` entry in the write-up.** The repo's own rule
  is that defects go there as they happen. Written now, from the PROGRESS
  entry, alongside this item's.
- **No reconciliation against a till or a processor.** Named above as a
  decision, repeated here because it is the thing someone will look for.
- **The rest of PRD 1** — gross versus net versus tax on the headline, a
  "Today" bounded on the business day, p90 and ran-late, cancellations by
  reason, date range and CSV. This item is that PRD's prerequisite defect
  fix, not its first feature.
- **Nothing re-audits an expiring caveat.** The habit this defect argues for —
  when an item makes a state common that a caveat assumed rare, re-read the
  caveat in the same session — is written into the WRITEUP and enforced by
  nobody. A checklist item in CLAUDE.md is the cheap version; it is not
  added here because one instance is not yet a pattern.

C-051 committed at 2615098.

## C-052 — A read handle with no entropy floor (defect D3)

The last of the three second-pass defects, and the one the evaluator was
careful to call a boundary defect rather than a live break.

**What was wrong.** `placeCartOrder` accepted any non-empty string as an
idempotency key. `placeOrder` looks that key up *first*, before the menu is
even read, and replays a hit through `ORDER_RECEIPT` — which is every scalar
column on the order: `statusToken`, `customerName`, `customerPhone`, totals.
So presenting a key was enough to receive a complete order and a permanent,
non-expiring status link to it. The server enforced no format, no entropy and
no session binding on a value that doubles as a read handle for a secret.

**Honest exploitability, unchanged from the evaluator's write-up.** This was
not a practical break. The real client is `crypto.randomUUID()` — 122 bits —
and that was the only thing making it safe. What was real: the seed and the
rush wrote `seed-order-0` and `rush-Dana-11`, and the *deployed* demo has a
table full of them. The day a second client exists — a kiosk, a QR flow, a POS
bridge, a retry wrapper — a well-meaning integrator writes `kiosk-2-0047` and
from that moment the read side of the replay is a leak.

**Built:**
- `isIdempotencyKey` in `packages/core/orders/placement.ts`. Canonical
  8-4-4-4-12, case-insensitive, version nibble 1-8 and the RFC variant. The
  variant is checked and not just the dashes, because
  `00000000-0000-0000-0000-000000000000` is 36 characters of nothing and
  passes a shape-only test.
- One call at the action boundary, replacing the old `key === ''` check, with
  its own `idempotency_key_invalid` refusal kind. Its own kind rather than
  folding into `malformed_request` because this is the one refusal aimed at a
  *programmer* — the customer's browser cannot produce it — and until C-084
  puts a log line behind it, the kind is the only name it has. The message
  stays customer-safe: the screen renders it, and "must be a UUID" is a
  sentence nobody at a counter should have to read.
- `derivedIdempotencyKey` in `packages/db/placement.ts`, and the seed and the
  rush now use it. Name-based like a UUIDv5, so the same name always yields
  the same UUID, with the version nibble saying `5` — the truthful one. This
  value is derived, not random, and claiming `4` would be a lie told to a
  regex.
- Tests at three grains: the predicate against the real generator ten times
  over and against every near miss, including both keys this repo itself was
  writing; the derived key round-tripping through a real placement and its
  replay; and one e2e that overrides `crypto.randomUUID` in the page before
  navigation, so the test is a *second client*, not a hand-built POST.

**Decided:**
- **The check is at the action boundary, not inside `placeOrder`.** Grepping
  the callers is what settles it: the action is the only one behind a request.
  The seed, the rush and seven db test files drive `placeOrder` directly with
  readable keys and are trusted. Pushing the check down would have converted
  21 call sites and made every test key an opaque UUID, for no boundary that
  is not already covered.
- **The scripts' keys were regenerated anyway**, even though the boundary
  check alone closes the hole — nothing can present `seed-order-0` through the
  only public entry point any more. Defence in depth, and it means the
  deployed demo stops holding a table of guessable handles.
- **A format check is a floor, not a proof**, and the code says so in the
  place someone would otherwise mistake it for the fix. It cannot tell a
  random v4 from a hand-typed one and it does not stop replay by someone who
  has a real key. The actual answer is binding the replay to the session that
  placed the order — PRD 6 E-1, a separate item, and named in the comment.

**Left behind:**
- **The real fix, E-1.** Session binding. This item is the mitigation the PRD
  asked for and says so.
- **The deployed database still holds the old `seed-order-*` rows.** Re-seeding
  production is a destructive script against a live URL and is not something to
  do as a side effect of a defect fix. The boundary check means those keys are
  unusable through the app regardless; the rows go when the demo is next
  re-seeded deliberately.
- **`idempotency_key_required` in `placeOrder` is now unreachable from the
  app** — the boundary refuses an empty key before placement sees it. Kept,
  because it is the guard for the trusted callers and its test still drives it
  directly.
- **No log line behind the refusal.** The whole reason the new error kind
  carries the name is that nothing writes it anywhere yet. C-084.

C-052 committed at 75931a5.

## C-084 — When it fails, there is something to look at (PRD 6 P0-1)

Pulled forward out of the lowest-ranked PRD, because the INDEX's sequencing
note is right: every other PRD's defects will be diagnosed with this, and
today, when an order goes missing at 7:10pm, the product cannot distinguish
"never placed" from "placed and eaten". It writes no line anywhere.

**Built:**
- `packages/core/orders/observability.ts` — `placementLogLine`, pure. The sink
  is three lines in `apps/web/lib/log.ts`; everything that *decides* what a
  line says lives where it can be tested. A sink cannot be unit-tested, and a
  rule that only lives in an untested file is a rule that drifts.
- **No PII, structurally.** `PlacementLogInput` has no field for a customer
  name, a phone or a status token, so a caller cannot put one in by accident.
  Correlation is by idempotency key and order id — the two identifiers a
  support question is answerable from, neither of which is a person. There is
  a test that serialises every outcome and asserts the absence anyway, to
  notice if somebody widens the type.
- **The one free-text channel is allow-listed, not trusted.** A thrown error's
  message passes through only when it matches the engine's own unknown-id and
  subtotal guards, where the id *is* the diagnostic. Anything else — a Prisma
  error quoting the row it choked on — logs its class and `messageWithheld`.
  A withheld message is a worse log line; a leaked phone number is a defect.
- **Three outcomes, exhaustively:** `placed` (with `orderId` and `replayed`,
  so a double-tap's two lines are distinguishable), `refused` (every refusal
  kind at once, plus the `GateReason` when the gate was one of them, so "the
  pause bounced eleven orders" is countable), and `threw`.
- **`priceLine`'s throw finally has a handler.** It refuses an unknown id
  rather than pricing it as zero — C-002's deliberate choice — and until now
  that throw had no catch and no log: a 500 and a customer looking at a blank
  screen. Caught at the boundary, logged, and answered with a named
  `placement_failed` refusal.
- **The `total_mismatch` defect, fixed.** The mismatch was computed *inside*
  the write path, so a request that tampered with the total AND failed
  validation returned before anything looked at the client's number — recorded
  nowhere at all. `totalTampering` now runs before the early return and the
  evidence comes back on the failure result.

**Decided:**
- **No logging dependency.** The deployment target parses JSON lines off
  stdout into structured, queryable logs, which is exactly what P0-1 means by
  "the platform's own". A logging library here would buy transports nothing in
  this product sends to.
- **`totalTampering` is silent when the totals differ honestly.** A cart with
  an 86'd line prices only what still prices; a cart whose price moved is a
  customer looking at an older number for a good reason. Both would produce a
  "mismatch" that is noise, and a noisy log is an unread log. What is left —
  a client claiming a different number for a composition the server prices
  cleanly — is the thing worth seeing. There is a db test driving the 86 case
  against a real cart to prove the suppression is real and not asserted.
- **The evidence is returned, not logged, by `placeOrder`.** That function has
  four callers and only one is behind a request. The boundary decides what
  reaches a log; the seed and the rush stay quiet.
- **Logged at the action, not inside `placeOrder`**, for the same reason —
  and because the boundary is the only place that can catch a throw and still
  answer the request.

**Found while building, by going looking for the evidence:**

Playwright pipes the web server's stderr by default and **ignores its stdout**,
so the first green gate produced exactly zero placement log lines — an
observability item with no local proof it ever fired. `stdout: 'pipe'` in
`playwright.config.ts` fixed the visibility, and the very first sweep with it
on returned seventeen real lines and one wrong one:

```
{"result":"refused","refusals":["empty_cart"],"clientTotalCents":1185,"serverTotalCents":0}
```

That is the "cart emptied in another tab" spec. The customer's screen honestly
still showed $11.85 and the server now prices nothing; calling it a tampered
total is precisely the noise `totalTampering` was written to suppress. The
cause was that the function **re-derived** "is this cart cleanly priced?"
instead of asking — `CartReview.placeable` is already
`lines.length > 0 && !needsFix && !needsPriceConfirmation`, and the hand-rolled
version dropped the first clause. The fix is smaller than the bug: one
`if (!review.placeable) return null`. Same lesson as the snapshot rule and the
status module, in a new place: when the answer already exists as a named field,
asking is not just shorter than re-deriving, it is the version that stays right.

**Left behind:**
- **The boundary wiring is not covered end to end.** The pure builder has 15
  tests and the failure-path mismatch has two db tests, but nothing asserts
  that a line actually reaches stdout — Playwright cannot read the web
  server's output, and the throw path is deliberately near-unreachable
  (`reviewCart` refuses a bad cart before `buildOrderSnapshot` can throw on
  it). Recorded as untested rather than counted, the C-047 rule.
- **Only placement is logged.** Transitions, payment collection and the menu
  editor's saves write nothing. P0-1 names placement because that is where the
  missing-order question starts, but the queue's own actions are the obvious
  second item.
- **No log line has a request id or a session.** The idempotency key
  correlates one checkout attempt; it cannot join two attempts by the same
  person. That is PRD 6 E-1's territory (binding the replay to a session) and
  arrives with it.
- **Nothing counts the lines.** "Eleven orders bounced" is countable from the
  log by whoever queries it; no screen in the product shows it. PRD 1's
  cancellations-by-reason row is the nearest thing and is a different source.

C-084 committed at 9c6cda3.

## C-085 — A payment is something that happened (PRD 6 P0-3)

The `ponytail:` comment on `markOrderPaid` has named this ceiling since the day
it was written: *"the column is the record; there is no `payment` event, so a
counter-collected order carries no instant. A real provider makes this a logged
event with a provider reference, and that is where the timestamp lands — the
`refund` kind is the shape to copy."* This item copies it.

**What was wrong.** `paymentState` has been on the order since C-003 and
reachable since C-038, but flipping it recorded nothing else. No instant, no
actor, no amount — the systems review's complaint word for word. "When did we
take that money?" had no answer at all for an order collected at the counter,
and the money PRD that comes next has to reconcile against something.

**Built:**
- A fifth `OrderEventKind`, `payment`, and `paymentEvent(now, amountCents,
  where)` in the state machine — deliberately the mirror of the `refund` draft
  `applyTransition` already pushes on a cancelled paid order. Same amount, same
  shape, opposite direction.
- `where: 'checkout' | 'counter'` is the thing the column could never say.
  Both are the restaurant taking money, but they reconcile against different
  things, and a payment event that cannot tell the drawer from the processor is
  one nobody can use. The actor follows: the customer's own tap at checkout,
  staff at the counter.
- `packages/db/payment.ts` — `collectOrderPayment`. The rule, the column and
  the event moved out of the server action and into a database module, because
  a column and its event have to move in ONE transaction and that is something
  only a database module can promise. It also means this write finally has a
  test of its own; it never did, which is how the ceiling survived two items.
- **The event only if the column actually moved.** `updateMany` matching zero
  rows is the compare-and-set, the same one the queue's transitions use. Two
  people tapping Collect at once is the ordinary case at a counter and it is
  ONE payment — a second event would be a second payment in every report that
  ever reads the log. There is a test that fires both concurrently.
- **Checkout writes one too.** The bullet only asks for `collectPayment`, but
  about two thirds of a service pays at checkout, and recording only the
  counter half would have made "every payment has a time" false for most
  orders.
- One hand-written migration, one statement: Postgres will not let a value
  added by `ALTER TYPE … ADD VALUE` be *used* later in the same transaction and
  Prisma runs each migration in one, so adding the value and writing a row that
  uses it cannot share a file. Nothing to backfill anyway — every payment taken
  before today genuinely has no recorded instant, and inventing one would be a
  lie about money.

**Found while building:**
- `time-in-state.ts` documented that `refund` carries a null `toStatus`. It
  does not — the engine gives it the `cancelled` it accompanied. Found by
  asserting the property the comment promised for the new kind. Harmless today
  (the span it opens is zero-length because it shares an instant with the
  transition it follows, and `visited` is a `Set` so the duplicate cannot
  inflate an entry count) but inconsistent. **The comment is corrected; the
  behaviour is not**, because changing an existing money event under an
  unrelated item is how a small inconsistency becomes a silent report change.
  PRD 3's payment rework settles the money events together.
- The rush's ugly-case-2 assertion counted seven events and now sees eight.
  Updated to assert the payment explicitly and to walk the statuses with the
  money event stepped over — which is the more precise test it should always
  have been.
- The lint ban on `new Date(<expr>)` caught `new Date(DINNER.getTime() + …)` in
  a new test. The ban is blanket by design and it was right: `instantMinutesAfter`
  exists for exactly this.

**Left behind:**
- **No screen shows the instant.** Paid/unpaid is already on both the queue
  card and the receipt; what is new is *when*, and nothing renders it. PRD 3
  builds the payment surface and this is the substrate it needs. Recorded
  rather than half-built.
- **`refund`'s `toStatus`**, above.
- **No provider reference.** `provider: 'mock'` is honest about there being no
  processor. A real one puts its charge id here, which is the seam PRD 3 shapes.
- **Nothing reconciles yet.** C-051 gave the report `Collected` and
  `Outstanding`; this gives every collection an instant. Joining the two — "what
  came in between 5 and 9" — is PRD 1's date-range work, not this.

C-085 committed at 8a74af1.

## C-086 — A name on the row (PRD 6 P0-2)

The last of the three items the 2026-09-01 decisions pulled ahead of the
ranked PRDs, and the one that could not have waited: every event written
`actor: 'staff'` meanwhile is anonymous **permanently**. No backfill can
invent the names later, which is why decision #3 put identity in front of the
money PRD rather than letting comps ship first.

**What was wrong.** Since C-004 every staff-written event says `actor: 'staff'`
and nothing else. The append-only log can say a revert happened and cannot say
who did it — and since C-038 it guards a cash button. Both the operator and the
systems reviewer reached that independently, from opposite ends.

**Built:**
- One hand-written migration. `StaffMember` (unique name, unique PIN digest,
  a CHECK for a non-blank name and a CHECK that the digest column holds a hex
  SHA-256 and nothing else) plus a nullable `OrderEvent.staffId`,
  `onDelete: Restrict`, with its own index — Postgres does not index a foreign
  key for you and `Restrict` scans it on every attempted delete.
- **Nothing backfilled.** Existing rows keep a null. Assigning them to
  anybody — the first staff member, the owner, a synthetic "legacy" row —
  would put a person's name on writes they may never have made, and a log that
  lies once is a log nobody can cite.
- `actor` is untouched and keeps its meaning: what KIND of actor. `staffId`
  answers WHICH ONE. `eventRow` stamps only drafts the engine attributes to
  staff, so the system's `refund` does not inherit the cook's name off the
  cancel that triggered it — she did not write that row, the engine did.
- **One PIN per shift, not per tap.** Thirty orders in twenty minutes makes the
  per-tap version something staff route around within a day, and a control
  everyone routes around leaves the log confidently wrong rather than honestly
  empty. `startShift` / `endShift`, a keyed cookie, and the sign-on bar on the
  queue screen itself.
- The cookie's stamp is keyed on `STAFF_PASSCODE`, so rotating the passcode
  ends every shift as well as every session — the right blast radius, and no
  second secret to keep in step with the first. What it prevents is the one
  forgery that matters inside the boundary: a cook editing their own cookie to
  put a colleague's name on a revert.
- **The append-only log finally has a reader.** An "Activity" section on the
  staff receipt — instants, what happened, and who. Writing a name onto every
  row and rendering it nowhere would have shipped the column and not the
  feature, which is the pattern this backlog has already had to come back and
  fix three times (the operator settings, the intensity surcharge, payment
  state).
- The rush stamps two cooks, alternating deterministically like its paid/unpaid
  mix, so the capstone demo shows attribution rather than a column.
- 19 new tests: the PRD's own (two PINs, two advances, two identities), the
  unattributed row, the refund that must not be stamped, `Restrict` refusing a
  delete, four CHECK assertions, the four cookie-forgery cases, and a six-test
  e2e covering the handover, a refused PIN, tap targets and axe.

**Decided:**
- **A stamp, not a credential, and the code says so in three places.** Four
  digits is 10,000 possibilities and the salt is a constant, so anyone holding
  the table can recover every PIN. That is acceptable *only* because the
  passcode is the boundary, whoever can type a PIN is already through it, and
  anyone with the table already has every order. The digest keeps the digits
  out of a casual `SELECT *`; it is not a defence, and pretending otherwise in
  a comment would be worse than the weakness.
- **`active` is a flag, never a delete.** Somebody who leaves cannot start a
  shift and their name stays on every row they wrote. `staffByPin` refuses
  them; `staffById` still resolves them.
- **One message for "no such PIN" and "that person left".** Whether a person
  exists is not something a keypad should teach whoever is typing at it.
- **The staff id never travels through a request.** Every write reads it from
  the cookie itself, in one place. A staff id in a form field is a staff id
  anybody can type, which is the opposite of accountability.
- **The crypto lives in `packages/db`, not in the app's auth module**, because
  `apps/web` has no unit suite and this is the guard against the forgery the
  item exists to prevent. C-084 had just finished teaching that a rule living
  only in an untested file is a rule that drifts.

**Found while building:**
- **The edge middleware does not have `node:crypto`** — and `staff-auth.ts`
  says so in its own header, which I read and then broke anyway. Putting a
  two-line shift-cookie wrapper in that file pulled `node:crypto` and the
  Prisma client into the middleware bundle and took every `/kitchen` route down
  with `Native module not found`. The failure alarm caught it on the first e2e
  spec and the sweep was killed rather than left to finish. Fixed by moving the
  whole shift surface into `lib/shift.ts`, which nothing on the edge imports,
  and the incident is now written into `staff-auth.ts`'s header underneath the
  warning that had already been there — a warning with evidence reads
  differently from a warning without.
- `events.map(eventRow)` was point-free, and `eventRow` gained a second
  parameter, so `map` started handing it the index as a staff id. The compiler
  caught it. Point-free is exactly as safe as the arity it was written against.

**Left behind:**
- **No UI for managing staff.** Members come from the seed; there is no add,
  rename, deactivate or change-PIN screen. Same shape as C-015's "the editor
  edits but cannot author", and the same answer: a restaurant does this in SQL
  until somebody asks for the form.
- **No per-person view.** "What did Noor do on Friday" is answerable from the
  database — the index is there for it — and from no screen.
- **The `refund` event stays unattributed**, which is right today (the engine
  wrote it) and probably wrong once PRD 3 makes refunds a staff action with an
  amount somebody chooses.
- **Nothing stamps a menu edit, a settings change or a pause.** Those are
  writes with consequences and no event log at all — a different item, and it
  needs an event table that is not `OrderEvent`.

C-086 committed at 4cfbe2a.

## C-063 — The event stream becomes the truth about money (PRD 3 P0-1)

The first item of PRD 3, and it starts with a decision rather than with code:
the PRD's own text said *"a human has to pick; the whole PRD's data model forks
here."* Asked and answered on 2026-09-01.

**Decisions taken (recorded in the PRD's Open Questions and the INDEX, not
re-opened):**
- **Decision 5 — the event stream is the truth.** `Order.paymentState` stays,
  stays indexed, and stays the read every existing surface uses — it becomes a
  *derived cache*. Both halves matter: rewriting the queue card, the receipt
  and the report to sum a log on every render would be a worse product for no
  gain. What changes is which one is allowed to be wrong. If they disagree,
  the events are right.
- **Decision 6 — a comp is a record, not a charge.** Written into the PRD as
  the sentence it asked for, so P0-3 can ship without anyone re-deriving
  whether it breaches the master PRD's "no real payment processing" Non-Goal.
  It does not: nothing here processes a payment.

**Built:**
- `OrderEvent.amountCents` and `OrderEvent.providerRef` as **columns**. A
  balance summed out of a JSON key is one no index can help and no constraint
  can defend, and the balance is what P0-2 builds next.
- A CHECK written as an **equivalence** — `(kind IN ('payment','refund')) =
  (amountCents IS NOT NULL)` — so the two halves cannot drift apart. Money
  events must carry an amount and nothing else may. `total_mismatch` is
  deliberately on the "must not" side: it holds two amounts in `detail` and
  moves no money, and a balance that summed it would be wrong in the
  customer's favour by whatever they claimed.
- A second CHECK: amounts are never negative. **Direction is the kind, never
  the sign** — a refund of -300 and a payment of 300 would be the same row
  twice over.
- `derivePaymentState` and `paymentTotals` in `packages/core/orders/payment.ts`.
- **The assertion the decision was really about**: for every order in the
  seeded rush, the column agrees with the stream. Over a whole simulated
  service with a real mix of states, not a fixture built to agree, and it
  reports *which* order disagrees rather than "false is not true".

**Found while building:**
- **You cannot backfill an append-only table.** The migration's `UPDATE` to
  copy `detail.amountCents` into the new column was refused by the C-003
  trigger, by name, with its own error message: *"OrderEvent is append-only:
  UPDATE is not permitted. Write a revert event instead."* The trigger is
  right and stays. What it defends against is application code rewriting
  history; this is a lossless **re-encoding** of a fact already on the row —
  no event changes its meaning, instant, actor or amount. The migration
  disables that one trigger **by name** (not `session_replication_role`, which
  needs superuser and would silently disable every other trigger in the
  database) and re-enables it unconditionally, with the reasoning written above
  the statement. A migration that leaves the guard off removes the invariant
  permanently.
- Editing an already-applied migration file forced a `db:reset:test`. Cheap
  here and worth remembering: the moment a migration has run anywhere that
  matters, the fix is a new migration, not an edit.

**Left behind:**
- **A partial refund reads as `paid`.** Captured 3420, refunded 300 → the enum
  has no better value, and the honest answer ("3120 still ours") needs P0-2's
  balance. Written into `derivePaymentState`'s own doc comment so it reads as
  the enum being lossy rather than the derivation being wrong.
- **An order paid before C-085 has no `payment` event**, so the derivation
  returns `unpaid` for it while the column says `paid`. That is the migration
  being honest — nothing recorded when that money arrived, and inventing an
  event would be a lie about a payment. The agreement test is scoped to orders
  written since the events existed, and says so.
- **Nothing recomputes the cache at write time.** The writers set the column
  and the test proves they agree; there is no reconciliation job and no
  read-path that derives. That is the intended shape at this size — the
  alternative is a job nobody runs — but it means the invariant is enforced by
  the suite rather than by the database.
- **`providerRef` is null on every row**, and will be until there is a
  processor. It exists now because adding a column later means a migration
  over a table that only ever grows.

C-063 committed at cb58f8e.

## C-064 — A balance, not a boolean (PRD 3 P0-2)

**What was wrong.** `paymentState` can say paid, unpaid or refunded. It cannot
say "$31.20 of $34.20", and that is the answer the moment anything is partial —
a partial refund now, a comp when C-065 lands. Three surfaces asked the enum
"is money owed" and got a yes/no where the truthful answer is an amount.

**Built:**
- `orderBalance` in `packages/core/orders/payment.ts` — `collectedCents` and
  `outstandingCents`, integer cents, no float. Both clamp at zero and the
  clamps mean different things: a refund exceeding capture is a data error and
  "we hold minus three dollars" should never reach a screen; an overpayment is
  money owed to the *customer*, and a negative debt would invite somebody to
  collect it again.
- **`canCollectPayment` now takes an amount, not the enum.** A number rather
  than the balance object, so the status module stays ignorant of the payment
  stream — the two are deliberately uncoupled and the caller does the one
  computation.
- **All three readers converted**, which was the point: the queue's unpaid
  badge, the staff receipt, and the report's outstanding list. `QUEUE_ORDER`
  and `ORDER_RECEIPT` now carry the money events; the report's scan selects
  them too. Leaving one reader on the enum is precisely the drift this
  codebase keeps coming back to undo.
- The chase list's `totalCents` became `owedCents`. A partly settled order
  belongs on it for the remainder, not for the whole ticket.
- The PRD's acceptance case, to the cent: $34.20 captured, $3.00 refunded →
  3120 collected, and `totalCents` still 3420. A balance is computed *beside*
  the money, never by editing it.
- A db test that proves it changes behaviour rather than just arithmetic: with
  $10 already down, the counter collects **the remainder**, not another $35.07.

**Decided:**
- **A refunded order now shows as OUTSTANDING**, where under the enum it fell
  out of the split entirely. The customer has the food and we hold nothing —
  that is money owed, and it belongs on the chase list. Unreachable today (a
  refund only accompanies a cancel, and a cancelled order is not a sale) and
  written into the test for the day C-067 makes it reachable.
- **`collected + outstanding` is now exactly the revenue booked.** The enum
  could not hold that invariant, because refunded orders counted toward
  neither half. There is a test for it.
- **The comp term PRD 3 P0-2 names is absent**, because nothing writes a comp
  yet. It arrives as one more case in `paymentTotals` and the arithmetic does
  not change shape when it does.

**Left behind:**
- **The report's scan got heavier** — every order in the window now carries its
  money events. At one restaurant's volume this is milliseconds against a scan
  the WRITEUP already flags as the wrong shape at chain scale; it is recorded
  because the honest reason to accept it was consistency, not cost.
- **Nothing writes a partial payment or a partial refund.** Both db tests
  insert the events directly. C-065 and C-067 are where writers appear.

## C-087 — The logo set, implemented

`docs/design/Firebird Logo Set.dc.html` arrived in the repo the day before with
its spec written out as greppable values in `docs/design/README.md`, and
nothing in the app used any of it. This item is **brand assets, not a
redesign** — the deliberate line, because the same session could have turned
into a re-skin of eight screens and the invariants those screens carry.

**Built:**
- **The two faces, via `next/font/google`.** Archivo (variable, 400–900) and
  Zilla Slab (500/600/700, not variable, so its weights are named). Both land
  as CSS variables and are wired in `globals.css`: `--font-sans` becomes
  Archivo, which makes the UI face automatic for the whole document through
  Tailwind's preflight, and `--font-display` becomes Zilla Slab, which stays a
  choice a component makes. That split is deliberate — *"never set the wordmark
  in the UI sans"* is one of the sheet's four don'ts, and the half of the type
  system a person can break is the half a default cannot fix.
- **The palette as `@theme` tokens** — `--color-brand-red`, `--color-ink`,
  `--color-border-black`, `--color-paper`. Two of the four are unused by
  today's screens and are defined anyway: this is the *whole permitted
  palette*, not a starting set, and the point of a token is that the next
  person reaches for it instead of typing a hex.
- **The sheet's greys are Tailwind's own `stone` ramp**, value for value
  (`#57534e` = stone-600 … `#d6d3d1` = stone-300). Checked before writing
  anything; nothing was redefined. A second name for a colour that already has
  one is how two greys drift apart.
- **The mark redrawn as inline SVG.** The sheet builds it from CSS borders —
  `border-left: 22px solid transparent` and so on — which is the right tool for
  a static sheet and the wrong one for a product: a border triangle cannot be
  recoloured by a token, cannot scale with its box, and cannot be printed
  one-colour. Geometry normalised to a 100-unit square off the 88px primary
  (a 44-wide, 38-tall flame centred, a 12-tall base bar), and cross-checked
  against the 64px and 48px instances, which agree to a rounding.
- **Four colourways and no others**, as a lookup rather than props. Only full
  colour carries the ink base bar; the single-colour versions knock the flame
  out of a solid square, where a bar would have nothing to sit against. That is
  in the sheet and easy to miss — three of the four colourway examples simply
  have no bar `div`.
- **`app/icon.svg` is the monogram, not a small mark.** Every favicon size is
  below the sheet's 48px floor where the flame drops out and only the F
  survives — and it is a real rule, not a stylistic one: a 25-unit white wedge
  inside a 32px square is three grey pixels.
- **The one true wordmark instance becomes the lockup.** `/menu`'s `<h1>` was
  the only place "Firebird Kitchen" was *set* rather than mentioned inside a
  sentence or a `<title>`. The mark is `aria-hidden`, so the heading's
  accessible name is unchanged and `auth.spec.ts`'s existing assertion holds
  without being touched.

**Decided:**
- **The size floor is code, not a comment.** `Mark` switches to the monogram
  below `FLAME_MIN_PX`. It could have been two components and a rule in a
  README; it is one component and a constant, because the README version is
  the one that gets forgotten at the call site.
- **The kitchen header was left alone.** The sheet has an "in place" example of
  it — a black bar, a 32px red square, `FIREBIRD · LINE`, a clock — and
  building it would have been a redesign of the highest-consequence screen in
  the product under an item scoped to assets. Recorded as the obvious next
  thing, not done here.
- **The favicon's F resolves to Georgia.** A webfont cannot be loaded from
  inside an SVG favicon, so the `font-family` falls to the brand's own declared
  Zilla Slab fallback. Converting the glyph to a path is the alternative and
  needs font tooling this repo does not have; a serif F on brand red is
  correct in every browser either way, and it is never the UI sans.

**Tested:** two e2e cases, because both failure modes here look like nothing at
all — a font that never loaded still renders text, an SVG the bundler dropped
still leaves a heading. So: the heading's accessible name is still
"Firebird Kitchen"; the mark is `aria-hidden` and carries exactly one
`polygon`, i.e. the flame version rather than the monogram; the wordmark's
**computed** `font-family` contains Zilla Slab, which is the only one of the
four don'ts a stylesheet can regress on its own; and the favicon is served
`200`, contains an `F`, and contains no polygon.

**Left behind:**
- **Nothing on the staff screens uses the brand.** `/kitchen` and its six
  sub-screens are still the neutral greys they were built in. Deliberate per
  the scope line above, and the sheet's kitchen-header example is where that
  work starts.
- **`--color-paper` and `--color-border-black` are defined and unused.** The
  body background is still the browser default, because setting it to paper
  interacts with the `dark:` classes several pages carry, and the light-mode-only
  call in `docs/DESIGN_BRIEF.md` is one of the two things still waiting on the
  owner. Tokens first; surfaces when that is answered.
- **The stacked lockup and the counter stamp are not built.** Bags, cups and
  signage are not screens. They are in the sheet when something needs them.

## C-065 — Making it right (PRD 3 P0-3)

The operator's complaint, word for word: *there is no way to make an order
right.* A burrito goes out wrong at 7:20 and the product's only money controls
were `cancel` — which the state machine correctly refuses on cooked food — and
collecting the full amount anyway. So the counter did the honest thing
off-system, and the till and the report disagreed by an amount nobody wrote
down.

**What the shape had to be.** Decision 6 of 2026-09-01, now in the schema
comment: an adjustment is an append-only **record of a decision the counter
made**. It moves no money and calls no processor, so the master PRD's "no real
payment processing" Non-Goal is untouched. The obvious implementation — comp
it, subtract from the total — mutates a write-once snapshot column and is
refused. `Order.totalCents` is what the customer was charged at placement,
forever; the balance is a computation beside it.

**Built:**
- **`adjustment`, a sixth `OrderEventKind`**, and **two hand-written
  migrations** rather than one. Not a preference: Postgres will not let a value
  added by `ALTER TYPE … ADD VALUE` be USED in the transaction that added it,
  and Prisma runs each file in one — so the CHECK that has to name it is the
  next *file*, not the next statement. C-085 hit this first and recorded it,
  which is why it cost nothing this time.
- **C-063's equivalence paid off exactly as designed.** The money CHECK was
  written as `(kind IN (…)) = (amountCents IS NOT NULL)` rather than as two
  CHECKs, specifically so a third money kind would be one line. It was one
  line. An `adjustment` row with a null amount is now rejected by the database
  rather than by a code path somebody remembered to write.
- **Two kinds: `comp` and `partial`.** `remake` is the third in P0-3 and is
  deliberately absent — it carries a link to the order it replaces, and a
  remake kind with no link is a word on a screen rather than the number "we
  remade six tickets Friday". C-066 adds the column and the kind together.
- **`adjustableRemainingCents`, its own function with two readers** — the
  validator and the screen. This is the item's one real trap and the
  requirement's own wording hides it: *"an adjustment larger than the order
  total is refused"* reads as a single-amount check, and a single-amount check
  lets two $10 comps land on a $13.75 order. **The bound is cumulative.** There
  is a test named for exactly that case.
- **A comp takes no amount from the client at all.** It is defined as "the
  whole order, zero to the customer", so the server derives it from the order's
  own snapshot. Strictly stronger than validating a number it never needed —
  the test hands it `amountCents: 999999` and asserts the event carries the
  order's total.
- **Refused, never clamped**, and the refusal names the bound. A clamp turns
  "comp $50 of this $11.85 order" into a legal $11.85 comp and tells nobody a
  wrong number was typed; the counter finds out at close, from the till.
- **`paymentTotals` gains a third direction and `orderBalance` subtracts it
  from what is OWED**, not from what was collected. Two different sentences:
  comping an unpaid order means the restaurant collected nothing and is owed
  nothing; comping a paid one means it holds the money and owes it back.
- **Every money surface followed for free.** The queue's unpaid badge, the
  staff receipt and the report's outstanding list all read `orderBalance`
  already (C-064), so a comped order drops off all three without one of them
  being edited. This is the single-source discipline paying a dividend rather
  than costing one.
- The **staff control on the receipt**, reachable in *every* state including
  `picked_up` and `abandoned` — the two the product had no money control for at
  all, and the two where a wrong order is actually discovered. Money is
  decoupled from status, which is what will let P0-5's cancel refusal stop
  being a dead end without changing which states can be cancelled.
- The **customer's status page says an order was adjusted** and structurally
  cannot say why: one number, off the same events, with no preset, no note and
  no staff name anywhere in the component.

**Decided:**
- **`derivePaymentState` deliberately ignores adjustments.** An adjustment is
  not money arriving, so a comped unpaid order is still honestly `unpaid`. The
  enum's job is what the till did; the balance's job is what is owed. Folding
  comps in would make the cache disagree with the column for every order the
  counter ever made right — and C-063's agreement test over the seeded rush is
  the thing that would have failed.
- **The refusal goes in the URL, not swallowed.** `collectPayment` can swallow
  a refusal because the re-render is legible (the button is gone, or it is
  not). An adjustment cannot: the form comes back looking identical and the
  counter believes the comp landed.
- **Only four refusals are echoed back to the screen.** The two that
  interpolate the caller's own string into their message are unreachable from
  the rendered form, and reaching them means a hand-made request — so they get
  a generic sentence. C-084's rule applied a second time: name what may travel
  down a free-text channel rather than sanitising what does.
- **`parsePriceInput` was reused, not rewritten.** The menu editor has parsed
  dollars into integer cents with it since C-015. A second parser would have
  been a second set of edge cases (`1.5`, `1.555`, a bare `$`) to get right
  twice.

**One correction to C-064's entry, which claimed the opposite.**
`collected + outstanding` is no longer exactly the revenue booked, once an
order is comped. That is correct rather than broken — a comped order booked no
revenue — and it is the reason the report's comps line is P1-3, a line of its
own, rather than an adjustment to net sales.

**Tested:** 28 core cases (the arithmetic, every refusal by *reason*, the PRD's
$13.75 acceptance case to the cent, and the cumulative-bound case), 10 db cases
(the snapshot columns and the payment cache untouched, reachable in `picked_up`
and `abandoned`, the counter collecting the *remainder*, the CHECK rejecting a
null and a negative amount, and the append-only trigger still covering the new
kind), a new case in the **snapshot regression** — comp it, partially adjust
it, refund it, then move the menu underneath, and assert the receipt is
byte-identical — and 5 e2e including axe.

**Left behind:**
- **Nothing reverses an adjustment.** The log is append-only and the honest
  answer is a contradicting adjustment, which does not exist: today a comp
  typed on the wrong order stands, and the only recourse is that the event says
  who did it and when. The reversing kind belongs with C-066's `relatedOrderId`
  work, which is the other thing that needs an event pointing at another row.
- **A comp on an order that already PAID reads as a zero balance, not as a
  refund owed.** `outstandingCents` clamps, exactly as C-064 documented, and
  the money owed back to that customer is invisible to the product. C-067's
  refund path is where that becomes expressible; showing it as a negative debt
  meanwhile would invite somebody to collect it twice.
- **The report has no comps line.** Net sales is unchanged by a comp, by
  design — P1-3 in this PRD, and the tables land in
  `prd-reports-that-decide.md`. What *did* change for free is the outstanding
  list, which now correctly omits comped orders.
- **A cancel reason still renders as its raw preset key** in the activity log,
  as it has since C-004. `describeEventReason` maps adjustment reasons only;
  fixing the cancel side would change a string four specs assert on, under an
  item about money.

## C-066 — The remake link (PRD 3 P0-3, the rest)

6:52pm. Ivy is back at the counter with `#012` — a torta she ordered with
onions **off**, and a note saying "cut it in half please", and she got neither.
Bea remakes it. Before this the system offered nothing: the till loses $13.75
with no record, the report counts one torta sold at full price, the attach rate
records "Onions — attached" on an order that said NO onions, and the only trace
is Bea telling the GM at close.

**The fork, and why it was not even.** The PRD left this as an open Builder
question and named the tension exactly: *"the kitchen needs a ticket; the
report needs a link."* Decision 7 of 2026-09-02 — **a real second order**. The
two needs do not pull evenly. Either shape gives the report its number; only
one gives the kitchen something to cook, and a remake nobody is told to make is
precisely the transcription failure this product exists to kill. Taking the
kitchen's side costs an order-creation path. Taking the report's side costs the
feature.

**Built:**
- A new order with its own `(businessDay, seq)`, `placed`, alerting, ageing —
  a ticket like any other, because that is the entire point.
- **The lines are copied from the original's snapshot, never re-priced.** Two
  reasons and both are the snapshot rule: it has to be the same food (the
  negation and the customer note are the scenario), and it has to be the same
  money, so the comp beside it cancels exactly what was charged. There is a
  test that reprices and renames the menu item first.
- **Comped in full at creation**, reusing C-065's `adjustmentEvent` — the one
  function that validates and constructs together. Without it the counter is
  shown "$11.85 due" on a ticket nobody will ever be charged for.
- **The report exclusion, which is the load-bearing half.** A remake is `sold`
  by every rule the report otherwise applies — it is a real order that really
  got picked up — so it is taken out *before* the status roles are consulted.
  Left in, it books a second sale, doubles the top-item units, and records an
  onions attach on the remake of an order that said NO onions.
- `remakes` on `/kitchen/report`, in its own row rather than a fifth stat tile,
  with copy saying why it is deliberately not in the totals above.
- **One migration file.** C-065 needed two because a value added by
  `ALTER TYPE … ADD VALUE` cannot be *used* in the same transaction — and
  nothing here uses it. No CHECK changes either: a remake carries no amount, so
  it stays on the "must not" side of `order_event_amount_matches_kind` for
  free.
- **The link is stored once, in one direction** — on the remake's own event,
  naming the original. The original's receipt finds it by reverse lookup off
  the new index. One fact in two places is two things that can disagree.

**Decided:**
- **The seq-retry loop was extracted, not copied.** A remake became the second
  thing needing an order number, and the mechanism CLAUDE.md names is that
  concurrent placements contend on the *constraint*, never on a
  check-then-write. A second hand-written copy of that loop is the obvious
  place for it to be got subtly wrong. One loop, two callers.
- **Its own section and its own form on the receipt.** Two reasons, both real:
  a remake must stay reachable on an order that has already been comped — the
  PRD's own scenario is Ivy getting her money back AND a new torta, and the
  adjust section vanishes once nothing is left to adjust — and a form's
  implicit submission fires its first submit button, so sharing one form would
  have made Enter in the note field mint a kitchen ticket.
- **The quote columns stay null on a remake.** Nobody promised Ivy eight
  minutes. Copying the original's quote would feed a stale promise into
  C-042's accuracy grading as though it had been made tonight, and the schema
  already calls null "no record".
- **The placement event's actor is `staff`, not `customer`.** Bea put this
  ticket on the line. It is the one place a remake's placement honestly differs
  from a real one.

**A defect its own test found.** The first version of the concurrency test
failed, and the reason was not the test: two taps genuinely in flight both
derive the same idempotency key, and the extracted retry loop's recovery
handler was not passed on the remake path — so the loser **threw** instead of
reading the winner's order. Written sequentially the test would have passed and
shipped the bug, because two sequential calls are two deliberate remakes and
are *supposed* to make two tickets. Concurrency is what distinguished them.

**Left behind:**
- **Nothing reverses a remake.** A remake minted on the wrong order is a real
  ticket and a real comp, and the recourse is the same as for an adjustment:
  cancel the ticket, and the log says who made it. The reversing-adjustment
  work I said in C-065 belonged here did **not** land — this item was already
  a migration, a new order path, a report change and an extraction, and
  bolting a fourth concept on would have made all four worse. It moves to
  C-067's neighbourhood with the rest of the "we tried and it failed" work.
- **A remake's comp is invisible to the future comps line.** The report skips
  remake orders entirely, so when PRD 3 P1-3 lands the comps line, the comps
  written *by* remakes will not appear in it. That is the right default —
  a remake is not a comp decision, it is a cooking decision — but it is a
  choice, and P1-3 should restate it rather than rediscover it.
- **A remake does not inherit the original's payment.** If Ivy had paid, her
  original stays paid and the remake is comped; nobody is charged twice and
  nobody is refunded. Money owed *back* on a comped-and-paid original is still
  C-067's problem, unchanged by this item.

## C-100 — The loyalty ledger (PRD 7 P0-1 schema, P0-2)

The first item of a PRD that exists because the owner said so, and that is
recorded rather than smoothed over. **Decision 8 of 2026-09-02** lifted the
master PRD's loyalty Non-Goal; `prd-loyalty.md`'s own recommendation was to
shelve it, on the grounds that no evaluator asked for loyalty and lens
consensus is the ranking signal this whole PRD set is built on. That
recommendation was read and overruled, which is the owner's call and not the
builder's. What survives of the Non-Goal is a **boundary**: one integer per
member, and a second entitlement dimension — tiers, birthdays, streaks — is
where the objection it encoded genuinely begins.

**Built:**
- `LoyaltyMember`, `LoyaltyEvent`, `LoyaltyEventKind`, and five columns on
  `RestaurantSettings`. One hand-written migration.
- **The phone is never stored.** `phoneDigest` is an HMAC-SHA256 of the
  normalised number under a pepper held in the **environment**, not in the
  database, so a dump of these tables is not a customer list.
  `Order.customerPhone` still holds it in clear and is untouched — a different
  fact with a different retention story, and PRD 6's forget path is what
  deletes it.
- **The pepper is an env secret where `StaffMember`'s PIN salt is a constant**,
  and the schema says why. A four-digit PIN behind a shared passcode is already
  only worth so much; a ten-digit phone number has a small enough keyspace that
  an unpeppered digest is decorative — anybody holding the table could
  enumerate every number in the country.
- **Four CHECKs and a trigger**, each a mechanism the application is then
  allowed to be careless about:
  - the sign tied to the kind as a single `CASE`, so a fifth kind cannot ship
    without that expression being edited — C-063's equivalence trick applied to
    a different column. **`ELSE false` is what makes that true**, and it was
    missing on the first pass: a `CASE` with no `ELSE` returns NULL for an
    unmatched kind and a CHECK passes on NULL, so the constraint would have
    admitted a fifth kind with any sign at all while reading as enforced. Found
    by reading the migration before the commit; written up in `WRITEUP.md`;
  - money non-null exactly on `redeem`, and never negative;
  - `phoneLast4` exactly four digits, because a partial write leaving it short
    is a counter lookup that matches everybody;
  - the settings numbers all positive.
- **The partial unique index on `(orderId) WHERE kind = 'earn'` — P0-3's whole
  mechanism, landed here rather than with the earn that uses it.** The state
  machine permits reverts, so `ready → picked_up` can happen twice on one
  order; the constraint is the mechanism and the code path's care is UX.
  Partial, so a redemption on the same order is unaffected.
- The pure balance function in `packages/core/loyalty`, plus `pointsForOrder`,
  `hasReward`, `pointsToNextReward` and `planRedemption` — all pure, no clock,
  no database.

**Decided:**
- **`points` is SIGNED, where `OrderEvent.amountCents` is not**, and the
  asymmetry is deliberate rather than an inconsistency. A ledger's direction is
  its sign because the balance is a plain sum and nothing has to know the
  kinds. Money's direction has to be its KIND, because a balance that trusted a
  sign could not tell a refund from a negative payment — they would sum
  identically. Both files say so, so the next reader does not "fix" one to
  match the other.
- **The append-only trigger blocks UPDATE and deliberately permits DELETE.**
  `OrderEvent`'s blocks both, and that difference is the design: P0-5's forget
  is a real delete and the member Cascade is how it reaches these rows.
  Blocking DELETE here would make "forget this customer" either impossible or
  a lie, and a loyalty balance is an entitlement held for the customer's
  benefit, not a financial record.
- **Two Cascades, two Restricts, asymmetric on purpose.** A member's ledger
  dies with the member; an order and a staff member outlive every row pointing
  at them.
- **`Order` gains no column and no foreign key**, which P0-6 states as a
  requirement rather than an omission. A member FK on the order would make the
  forget either cascade — changing a report count — or restrict, blocking it.
  The link runs one way: `LoyaltyEvent.orderId → Order`.
- **`loyaltyEnabled` defaults false, and that is load-bearing.** With the
  program off, no ledger row is written and the seeded rush passes unchanged.
- **The reward is applied AFTER tax**, and `planRedemption`'s comment carries
  the price of that rather than hiding it: the customer pays tax on food they
  did not pay for. The honest version needs a snapshotted `Order.discountCents`
  and `subtotal − discount` as the tax base, because `priceOrder` defines
  `subtotalCents` as exactly the sum of the lines. That is P1-1 and it moves
  with SMS verification or not at all. The copy therefore says "$10 off your
  total" and never "a free burrito".

**Left behind:**
- **The `loyaltyExpiryDays <= retentionDays` CHECK P0-5 requires is not here.**
  `retentionDays` does not exist until C-091. Adding half of a constraint now
  would be a guarantee that reads as enforced and is not, so the column ships
  with its default and the CHECK arrives with the column it depends on.
- **Nothing writes a ledger row yet.** Enrolment is C-101, earning is C-102,
  redemption is C-104. Every test here inserts events directly, which is the
  same shape C-063 left behind and for the same reason.

---

## C-101 — Enrolment (PRD 7 P0-1)

The punch card gets its first row. A member is a **phone number and nothing
else** — no account, no password, no portal, and the resolved "tokenized link,
no auth project" decision is not re-opened. Enrolment is one checkbox on the
form the customer was already filling in.

**Built:**
- `normalizePhone` / `isEnrollablePhone` in `packages/core/loyalty/phone.ts`.
  Pure, and the reason `(555) 010-2233` and `5550102233` are one member rather
  than two: the digits are stripped, an optional leading `1` is dropped, and
  anything that is not then ten digits is refused.
- `packages/db/loyalty.ts` — `phoneDigest` (HMAC-SHA256 under
  `LOYALTY_PHONE_PEPPER`), `enrolMember` (an upsert on the digest), and
  `memberByPhone`, the counter lookup that **hashes the typed number and
  matches the digest so the plaintext never reaches a `where`**. The same
  discipline `staffByPin` applies, and here it is load-bearing: a `contains`
  on a phone column is the query that turns a loyalty program into a
  searchable customer index.
- The checkbox on `/checkout`, rendered only when the program is on, unchecked
  by default, **disabled until the typed phone is one a membership can be keyed
  on** — asked of the same `isEnrollablePhone` the writer uses. Copy that says
  what is kept ("a one-way code, not the number itself") and for how long
  (365 days of inactivity), which is the requirement and also the reason this
  is one checkbox rather than an interstitial.
- The loyalty offer rides on `loadGateState`'s existing settings read, so the
  screen that offers enrolment and the writer that performs it are looking at
  one row rather than two reads of it.
- An `enrolment` field on the placement log line — one word from a closed set,
  and the type still has no field for a phone number.
- `LOYALTY_PHONE_PEPPER` named in `.env.example`, both CI workflows, and both
  local env files. No migration: C-100 landed the schema.

**Decided:**
- **An unset pepper refuses by name; it never hashes under an empty key.**
  `phoneDigest` throws, `enrolMember` returns `loyalty_pepper_unset`, and the
  checkout screen does not render the checkbox at all — `offered` is
  `loyaltyEnabled && hasLoyaltyPepper()`, one expression, checked identically
  by the screen and the writer. The alternative is worse than it looks: an
  empty-key HMAC is perfectly stable, so it would enrol members happily and
  orphan every one of them the day the pepper is configured.
- **Rotating the pepper orphans every member** — balances become unreachable,
  not wrong. Stated in `.env.example` beside the variable, the same way
  rotating `STAFF_PASSCODE` is stated to end every shift. That is the price of
  the phone not being in the table and it is worth paying.
- **A returning customer keeps the name and the instant they enrolled under.**
  The upsert's `update: {}` is deliberate: `enrolledAt` is what expiry and
  retention are both counted from, and `lastActivityAt` moves on an earn or a
  redeem (C-102, C-104), never on somebody ordering again.
- **Enrolment happens in the checkout action, after the order exists, and
  cannot fail it.** A punch card that could not be written must not cost a
  customer their food, so the call is wrapped and every outcome — including a
  throw, whose message is deliberately dropped because a Prisma error quotes
  the row it choked on — becomes one word on the log line.
- **The name and phone come off the placed order, not off the request.** They
  have already been trimmed and length-checked by `normalizeIdentity`, and
  `displayName` has a 40-character column the raw field does not respect.
- **NANP only, and it is a `ponytail:` ceiling rather than an oversight.** A
  `+44` number, an extension, or a half-typed one is not enrollable; the
  checkbox stays disabled and says why, rather than the enrolment failing
  invisibly after the order is placed. The order itself is unaffected —
  `Order.customerPhone` keeps whatever was typed, because that field is for a
  human to ring back and has never had a format rule. The upgrade path is a
  real E.164 parser, which is a dependency and not a regex.

**Left behind:**
- **Nothing switches the program on through a screen.** `loyaltyEnabled` is a
  column with no operator control, so the e2e fixture writes it directly. The
  toggle belongs with C-106, the program's own screen, and putting it on the
  service settings form now would be a control for a feature with no numbers
  behind it yet.
- **No ledger row is written yet.** Enrolment creates the member; C-102 is the
  earn that first gives them a balance. `memberByPhone` already sums one, so
  C-103's counter panel is a render away.
- **The receipt does not confirm enrolment.** A customer who ticks the box sees
  their order number and nothing about the punch card. That is a real gap and
  the natural home for it is C-103, where the member's balance first exists to
  be shown.

---

## C-102 — Earning at pickup (PRD 7 P0-3)

The punch card gets its first punch. Points are earned **once, at pickup, from
the snapshot** — and the thing that makes "once" true is a unique index, not a
careful code path, because the state machine permits reverts and
`ready → picked_up` twice on one order is a supported operation rather than an
edge case.

**Built:**
- `earnForOrder` in `packages/db/loyalty.ts` — reads the settings row, finds
  the member by the digest of the order's `customerPhone`, computes
  `pointsForOrder(order.subtotalCents, terms)` and writes one `earn` row.
  Returns one word from a closed set (`earned`, `already_earned`,
  `loyalty_disabled`, `loyalty_pepper_unset`, `not_a_member`,
  `nothing_to_earn`), the same discipline enrolment's refusals use: "no points
  appeared" is a support call and the answer has to be nameable.
- The call site in `applyOrderAction`, **inside the transaction that changes
  the status**, guarded by `salesRoleOf(decision.status) === 'sold'`. Two
  snapshot columns joined the existing `findUnique` — `subtotalCents` and
  `customerPhone` — rather than being re-fetched.
- Seven tests in `packages/db/loyalty.test.ts`: the revert-and-re-advance
  producing exactly one row, `lastActivityAt` moving, a menu repriced under a
  placed order earning the same 14 points, `abandoned` and `cancelled` earning
  nothing, a non-member and a phoneless order being quiet no-ops, the program
  switched off writing nothing, and a sub-dollar order refusing by name rather
  than writing a zero.
- No migration. C-100 landed the index this whole item rests on.

**Decided:**
- **The earn is INSIDE the transition's transaction, and enrolment is not
  inside placement's.** The two look like the same shape and are not.
  Enrolment hangs off a placement and must never fail it, because a punch card
  that did not start must not cost a customer their food — there is a later
  moment to fix it. A `picked_up` that committed without its ledger row is a
  customer who paid, took the food and earned nothing, and there is no later
  moment to retry from: the order is terminal and nothing will touch it again.
  So the earn commits with the status or not at all.
- **`skipDuplicates`, which is `ON CONFLICT DO NOTHING`, and not a
  check-then-write.** A `findFirst` in front of the insert would be two cooks'
  taps away from a double earn, and it would also turn the ordinary
  re-advance into a rolled-back transaction — a second `earn` insert throwing
  inside the transition would take the cook's tap down with it. The index
  swallows it and the re-advance succeeds, which is the behaviour the queue
  needs.
- **Derived from `salesRoleOf`, never from `=== 'picked_up'`.** `SOLD_STATUSES`
  is `['picked_up']` today; a second sold status makes the compiler find this
  reader, which is the entire reason the status module exists.
- **`lastActivityAt` moves on the earn and only when a row was actually
  written.** A re-advance that earned nothing must not restart the twelve-month
  expiry clock — otherwise a cook's fat finger silently extends how long a
  named person's data is held, which is precisely the thing P0-5 exists to
  bound.
- **Nothing under a dollar is written.** `pointsForOrder` returns 0, and a
  zero-point `earn` would fail C-100's sign CHECK and roll back the pickup. The
  refusal is by name and the tap commits.
- **A revert does not claw back.** The recorded ceiling from the PRD, restated
  because it looks like an oversight and is not: an automatic reversal makes a
  balance a function of a status HISTORY rather than of a set of facts, and the
  staff `adjust` is the correction.

**Left behind:**
- **Nobody can see the points yet.** `memberByPhone` sums a balance and nothing
  renders it — C-103's counter panel is the reader, and until it lands the only
  proof a punch was recorded is a test.
- **The receipt still says nothing about the punch card**, which is now a
  customer who earned 14 points and was told nothing. Same home as C-101 left
  it: C-103.
- **No `redeem` path.** The balance only goes up. C-104.
- **The seeded rush earns nothing**, because `loyaltyEnabled` defaults false
  and the rush does not turn it on. Deliberate — the rush is the counter
  handoff's demo and a loyalty column in it would be C-106's screen leaking
  into somebody else's capstone.

---

# Carried forward — read this first in a new session

State at the end of the 2026-09-02 session.

**Pushed and CI-green:** C-051, C-052, C-084, C-085, C-086, C-063, C-064,
C-087, C-065, C-066, C-100, C-101. **C-102 is this entry.**

**PRD 3 has two items left:** C-067 (a refund that can fail — and the home for
the reversing adjustment C-065 and C-066 both deferred) and C-068 (the cancel
refusal that names the adjustment path).

**THE PROJECT'S NEXT RUN IS THE LOYALTY PROGRAM.** The owner instructed it on
2026-09-02 and four decisions were taken and recorded in
`docs/prds/INDEX.md` (decisions 7-10) and in `docs/prds/prd-loyalty.md`:

- **Decision 8 — the master PRD's loyalty Non-Goal is LIFTED.** The loyalty
  PRD's own recommendation was to shelve it; that was read and overruled,
  which is the owner's call. Recorded as such rather than softened: this is
  the one PRD in the set with zero lens consensus.
- **Decision 9 — the economics: 1 point per dollar of subtotal, 100 points,
  $10 off.** 10% back. Editable in `RestaurantSettings`, which is not the same
  as changeable — moving it once balances are held devalues them visibly.
- **Decision 10 — expiry is 365 days of inactivity**, and the P0-5 CHECK
  therefore widens `retentionDays` to 365. **The cost is that loyalty now
  drives this product's PII retention policy** — nothing else needs a named
  person's history for a year.
- **PRD 6 P0-4 (retention + the forget path) is being built as part of the
  run**, ahead of loyalty's expiry item, because it is loyalty's hard
  prerequisite and it is what makes the durable customer data defensible.

**Order of the loyalty run:** ~~C-100 ledger~~ → ~~C-101 enrolment~~ →
~~C-102 earning~~ (all three done) → **C-103 counter panel is next** →
C-104 redeeming →
**C-091 retention + forget** → C-105 expiry + forget → C-106 the program's own
screen.

**What C-103 inherits, and must not re-decide:**
- **A balance exists and nothing renders it.** `memberByPhone` already returns
  one; C-103 is a read-only render of what is already summed, not a second way
  to compute it. There is no balance column and adding one is a later decision
  with a written reason (C-100).
- **The earn is written inside the transition's transaction** and leans on
  C-100's partial unique index via `skipDuplicates`. Do not put a
  check-then-write in front of it, and do not move it outside the transaction:
  a `picked_up` that committed without its ledger row has no later moment to
  retry from.
- `LOYALTY_PHONE_PEPPER` exists, is in `.env.example` and both CI workflows,
  and an unset value **refuses by name** rather than hashing under an empty
  key. `hasLoyaltyPepper()` is half of `loadGateState`'s `loyalty.offered`.
- **`lastActivityAt` is deliberately not moved by enrolling again.** The earn
  is the first thing that moves it, which is what P0-5 counts expiry from.
- A member is found by `memberByPhone`, which hashes what it is given. **The
  earn's job is to find the member for an order's `customerPhone`** — a
  member's identity is the digest, and the order has never held one.
- Enrolment happens in the checkout action, after the write, and cannot fail
  the order — the earn is deliberately the opposite shape, and C-102 wrote down
  why the asymmetry is not an inconsistency.
- **The program still has no operator switch.** `setLoyaltyEnabled` in
  `apps/web/e2e/fixtures.ts` is how a spec turns it on; the toggle is C-106's.

**The trap C-100 re-proved, and it is new to this project:** a SQL `CASE` with
no `ELSE` returns NULL for an unmatched value and **a CHECK constraint passes
on NULL**. A constraint written as one `CASE` over an enum — the shape this
repo likes, because it forces an edit when a variant is added — only forces
that edit if it ends in `ELSE false`. Without it the guard reads as enforced,
tests green on every variant that exists, and admits the first one that does
not. Check the *unmatched* branch of any constraint expression, not the
matched ones.

**Numbering correction:** PRD 6's forget item was written as `C-087`; the brand
item shipped under that number first, so the forget item is now **C-091**. Both
PRDs are updated. The number is bookkeeping; the dependency is not.

**Two traps carried forward from C-065 and C-066, both cheap to re-trip:**
- `ALTER TYPE … ADD VALUE` cannot be USED in the transaction that adds it.
  C-065 needed two migration files; C-066 needed one, because nothing used the
  new value. Check which case you are in before splitting.
- **A money bound stated as "larger than the order total" is cumulative.** The
  per-amount reading lets two $10 comps land on a $13.75 order.

**Still waiting on the owner:** the two calls in `docs/DESIGN_BRIEF.md` (no
shadcn; light-mode-only tokens). C-087 left the body background unset and two
palette tokens unused because of it.

C-100 committed at 40ce2e2. C-101 committed at be83261. C-102 committed at
a4179a4.
