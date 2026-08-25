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
