# Countertop — Online Ordering for a Restaurant

Pickup-only online ordering for a fast-casual restaurant (sample: "Firebird Kitchen"). Learning project #5, built to professional standards. Same stack and working conventions as storage (`B-`), rental (`R-`), Bookable (`A-`), and BoxLoop (`S-`).

## How to work in this repo

- Product source of truth: `prd-countertop-restaurant-ordering.md` (Draft v2 — the Review Addendum's change log explains why each v2 requirement exists; the Open Questions marked *resolved* are settled, never re-open them).
- Stack: Next.js (App Router) + TypeScript, Postgres + Prisma, Tailwind + shadcn, Vitest/Playwright + axe, Vercel target. Monorepo: `apps/web`, `packages/core` (domain logic — the modifier/price engine and the order state machine live here as pure functions), `packages/db` (Prisma schema + hand-written migrations where constraints are involved).
- **This repo owns port 3400** (storage 3000, rental 3100, bookable 3300) — config default, so the cross-repo e2e footgun cannot recur.
- Money is **integer cents**, always. Tax = `round(subtotal × rate)` in cents, one rounding function, used everywhere.
- Build order: Phase 1 → 4 as the PRD's Timeline section lists them, one requirement per session. After completing an item: run the gate → mark it in the PRD/backlog → add its entry to `docs/PROGRESS.md` (what it built / decided / left behind) → add its entry to `docs/RELEASE_NOTES.md` (portfolio-facing) → commit (`C-004: order state machine`) → record the SHA in a follow-up commit, never by amending → **one push for both commits** → **watch CI green before saying "done"** (`gh run watch`).
- `docs/WRITEUP.md` exists from commit one and is appended per its own rules — scaling caveats (fixed 5s polling), simplifications (midnight order-number reset), and defects found go there as they happen, not at the end.

## The invariants this project exists to practice

**Snapshot rule (the one Claude drifts on across sessions).** A placed order is an immutable COPY of everything it was composed from — item names, option names, price deltas, computed lines, subtotal/tax/total — never a foreign key chased back to live menu rows for display or math. Menu edits after placement must be provably invisible to placed orders (there is a regression test for this; keep it passing). If an order row ever joins to a menu table to render a receipt, that is the defect.

**Server is the price authority.** Client prices are display-only. The server recomputes every line at cart-add and again at placement; a client-supplied total is input to a mismatch log, never to the database. Same for tax.

**One status module.** The state machine (`placed → accepted → preparing → ready → picked_up`, plus `cancelled`, `abandoned`, and logged reverts) lives in ONE module in `packages/core`. Every reader — queue filters, throttle's open-order count, report queries, alert logic — derives its status lists from it. Adding a state means the compiler finds the readers, not grep. (Rental's `VERIFIED` defect, structurally prevented — same rule as Bookable.)

**One orderability function.** Availability has two grains: item and modifier option. "Can this composition be ordered right now?" is answered by one function in `packages/core` that the menu view, cart validation, and placement all call. Three call sites, one answer. The checkout gate (manual pause / auto-pause threshold / store hours) is likewise ONE code path with three triggers.

**Idempotent placement.** Every checkout attempt carries a client-generated idempotency key with a unique constraint behind it. The constraint is the mechanism; the disabled submit button is UX. Same discipline as BoxLoop's billing runs: correctness never depends on the client behaving.

**Acknowledgment is a transition.** The new-order alert (chime + flash) derives from order state (`placed`, un-acked), not from a client-side event — it must survive a page reload. Acking IS `placed → accepted`. No separate accept chore.

## Time rules (lighter than Bookable's, still rules)

- The restaurant's timezone is a config value. Daily order-number reset and all report day/hour bucketing use it — never UTC, never the server's process timezone.
- Order timestamps are instants (`timestamptz`); the engine takes `now` as a parameter. Nothing in `packages/core` reads the system clock.
- The polling cursor is server-issued and echoed back by the client — never the client's clock. Clock skew is not a bug we accept.
- The lint bans carried from Bookable stay on: `new Date(string)`, `Date.parse`, `get/setHours`, `toISOString().slice(0,10)`, `getTimezoneOffset`.

## Database rules

- The daily order number is `(businessDay, seq)` with a unique constraint; concurrent placements contend on the constraint, not on a check-then-write. Map the violation to a retry, and test it under the seeded rush.
- Order snapshot tables (`Order`, `OrderLine`, `OrderLineOption`) carry copied names and prices as columns. FKs back to menu tables, if kept for analytics, are `onDelete: Restrict` and never read for display/pricing.
- The order event log is append-only (trigger, as in Bookable); undo writes a logged revert event, it never deletes.
- Migrations with constraints/triggers are hand-written (`prisma migrate dev --create-only`, then edit). Never `db push`. Never edit an applied migration.

## Traps that only fail at runtime

- **Intensity levels are options-squared.** "Light/regular/extra sauce" multiplies the fixture space — the price engine's tests need an intensity-enabled group with a priced "extra," and the kitchen ticket must render intensity distinctly from add/remove.
- **Negations are the founding use case.** "NO onions" must be visually distinct on the kitchen card — a remove rendered like an add recreates the phone-transcription bug this product exists to kill. There is an acceptance criterion for this; treat it like a test.
- **An 86 mid-flight touches three surfaces:** menu render ("sold out"), open carts (flag at checkout), and never placed orders (snapshots don't care). If 86'ing an option only updates the menu, the bug ships.
- **Estimates lie by default.** Never show a time estimate while paused; show ranges, not points. A precise wrong number is worse than an honest range.
- **The queue is read at arm's length with greasy gloves.** Tap targets ≥48px, advance is the biggest control, item lines ≥18px. Playwright + axe assert the sizes; the rush demo proves the flow.

## The gate

Nothing is done until all five pass:

```
npm run gate    # = lint && typecheck && test && build:test && test:e2e
```

- **The build is its own step** (added C-024). Twice a change has been green under `tsc`, ESLint and the whole unit suite and failed only in the bundler — C-007's `.js` import specifiers, C-023's non-function export from a `'use server'` file. Neither is a type error; both are build errors, and a gate that only builds inside the e2e leg reports them as "webServer was not able to start" three minutes in.
- e2e runs against a production build; `E2E_DEV=1` restores the dev server for stack traces.
- Read the e2e summary, not the tail: `passed + skipped + flaky` must reconcile against `--list`'s total.
- CI applies all migrations to a throwaway Postgres from scratch with a drift check, and runs the unit suite under `TZ=Pacific/Kiritimati` and `TZ=UTC` expecting identical results (the report-bucketing and order-number-reset tests are exactly what a UTC-only CI would hide).
- The seeded rush script is both the capstone demo and a test: 30 orders/20 min including the ugly cases (mid-rush option 86 with an affected cart, wrong-advance + undo, a no-show aging to `abandoned`, a deliberate double-submit, orders arriving while paused). Zero stuck, lost, or duplicated orders.

## Test suite rules

- Every engine test supplies a frozen `now`; the seed anchors to a fixed date constant, not the clock.
- Price fixtures are hand-calculated and include: required-group block, min/max enforcement, negative delta, intensity-priced "extra," quantity math, tax rounding at a boundary cent, and a tampered-total rejection.
- State-machine tests enumerate the full transition table — valid AND ≥8 invalid transitions asserted by *reason*, not just by failure.
- The double-submit test asserts exactly one order AND that the second response body equals the first — idempotency means same answer, not just no duplicate.
- Snapshot regression: place an order, then mutate every referenced menu row (rename, reprice, 86, delete an option), then assert the order's rendered receipt and stored totals are byte-identical.
