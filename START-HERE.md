# Start here — running Countertop with Claude Code

This starter is C-000: the reviewed PRD (Draft v2, with the persona-review addendum and change log) and the working conventions in `CLAUDE.md`. Everything below is how to drive the rest.

## The loop

One requirement per session, in phase order, no skipping ahead:

1. Read the requirement in `prd-countertop-restaurant-ordering.md`, its user stories, and any *resolved* Open Question it touches.
2. Build it. Tests are part of the item, not a follow-up.
3. Run the gate: `npm run lint && npm run typecheck && npm test && PORT=3400 npm run test:e2e`
4. Mark the item ✅ in the PRD (or `docs/backlog.md` once Session 1 creates it).
5. Add the entry to `docs/PROGRESS.md` — what it built, what it decided, what it left behind.
6. Add the entry to `docs/RELEASE_NOTES.md` — the portfolio-facing version, written for "walk me through something you built."
7. Commit (`C-00N: <thing>`). Record the SHA in a small follow-up commit, never by amending. One push for both. Watch CI green before saying done.

## Session 1 — C-001, the scaffold

> Read CLAUDE.md and prd-countertop-restaurant-ordering.md fully — including the Review Addendum, which explains why v2 requirements exist. Then build C-001: the monorepo scaffold — Next.js App Router + TypeScript in apps/web, Prisma + Postgres in packages/db (docker-compose for local Postgres; port 3400 as the config default), an empty packages/core with the vitest wiring, Playwright + axe, and CI that (a) applies all migrations to a throwaway Postgres from scratch with a drift check and (b) runs the unit suite under TZ=Pacific/Kiritimati and TZ=UTC, asserting identical results. Create docs/PROGRESS.md, docs/RELEASE_NOTES.md, docs/WRITEUP.md, and docs/backlog.md (derive the backlog from the PRD's four phases, one line per requirement, C-002 through C-0NN). Preserve CLAUDE.md's gate command exactly. Do not implement any domain logic yet.

## Session 2 — C-002, the modifier & price engine (the slot engine of this project)

The highest-defect-risk pure logic. TDD it before any schema or UI exists.

> Build C-002: packages/core/menu and packages/core/pricing as pure functions with no database. Model P0-1 exactly: category → item → modifier group → option, one level deep, groups with required/optional + min/max rules, per-option price deltas (negative and zero allowed), group reuse across items, S/M/L as a required single-select group, and optional per-group intensity (none/light/regular/extra, "extra" optionally priced). Then the price engine per P0-2 and P0-9: line = (base + Σ deltas) × quantity, order = Σ lines + round(subtotal × taxRate), all integer cents, one rounding function. TDD: write the hand-calculated fixture matrix from CLAUDE.md's test rules FIRST (required-group block, min/max, negative delta, priced "extra" intensity, quantity math, tax rounding at a boundary cent) and confirm every fixture fails before implementing. A composition-validity function ("is this selection orderable?") is part of this module — cart, checkout, and menu will all call it later.

## Session 3 — C-003, the data model

The highest-leverage session. Do not let it get rushed.

> Build C-003 from docs/backlog.md. Read the PRD's P0-3, P0-4, P0-8, P0-10 and CLAUDE.md's Database rules first. Before writing the schema, show me: (1) the full entity list, (2) the exact snapshot columns on Order/OrderLine/OrderLineOption proving a receipt renders with zero joins to menu tables, (3) the unique constraints for the daily order number (businessDay, seq) and the idempotency key — and wait for my confirmation. Then write the schema, hand-write the migrations (append-only event log trigger included), and add tests that (a) place an order, mutate every referenced menu row, and assert the order's stored data is byte-identical, and (b) insert colliding order numbers and idempotency keys directly against the database and assert refusal.

The pause before the schema is the point: the snapshot columns are the decision the whole project builds against.

## Session 4 — C-004, the order state machine

> Build C-004: the order lifecycle in one module in packages/core per P0-4 — placed → accepted → preparing → ready → picked_up, cancellations (staff anytime pre-ready with preset reason + mock refund record; customer before accepted), ready → abandoned, and logged reverts (undo is a revert, never a delete). Every reader-facing status list (open-order set for the throttle, queue groupings, terminal states, alert-eligible set) is exported from this module. Enumerate the full transition table in tests, valid and ≥8 invalid transitions asserted by reason. The engine takes `now` as a parameter.

## Sessions 5+ — follow the backlog

Phase 2 remainder (cart + placement flow wiring P0-3/P0-8/P0-10 into routes), then Phase 3 (polling with the server-issued cursor, the alert-and-acknowledge flow where ack IS the accepted transition, the one checkout gate with three triggers, option-level 86, ticket content, safe menu editing, estimates-as-ranges), then Phase 4 (the sales report in restaurant timezone, and the rush script).

Session-3-style pauses to repeat: before building P0-12, confirm the alert derives from order state (reload-proof) — and before the rush script, confirm its ugly-case list matches the PRD's Success Metrics verbatim.

## The capstone

One command seeds the menu and fires the rush: 30 orders in 20 minutes, including a mid-rush guac 86 hitting an open cart, a fat-fingered advance undone, a no-show aging to abandoned, a double-submit resolving to one order, and orders bouncing off the pause gate. Watch the queue fill, alert, and drain. That recording is the portfolio demo.
