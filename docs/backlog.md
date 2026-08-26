# Backlog — Countertop

One line per requirement, derived from the PRD's Timeline / Phasing section.
One item per session, in order, no skipping ahead. Mark ✅ when the gate passes
and the PROGRESS/RELEASE_NOTES entries are written.

The gate, unchanged for every item:

```
npm run lint && npm run typecheck && npm test && PORT=3400 npm run test:e2e
```

## Phase 1 — pure logic, tested before any UI exists

- [x] **C-001** — Monorepo scaffold, Postgres wiring, Playwright + axe, CI (TZ×2, migrate-from-scratch, drift check), the four docs
- [x] **C-002** — Menu model + price engine + tax *(P0-1, P0-2, P0-9)* — `packages/core/menu` and `packages/core/pricing`, pure, TDD from the hand-calculated fixture matrix. Includes the one composition-validity function ("is this orderable?") and the one rounding function.

## Phase 2 — the order as a persisted object

- [x] **C-003** — Data model + hand-written migrations *(P0-3 snapshot, P0-8, P0-10)* — snapshot columns proving a receipt renders with zero menu joins; `(businessDay, seq)` and idempotency-key unique constraints; append-only event-log trigger. **Pause for schema review before writing it.**
- [x] **C-004** — Order state machine *(P0-4)* — one module in `packages/core`, full transition table, every reader-facing status list exported from it, `now` as a parameter.
- [x] **C-005** — Cart *(P0-3)* — session-persisted, composed lines editable/removable, 140-char note cap and quantity cap enforced server-side.
- [x] **C-006** — Placement flow *(P0-3, P0-8, P0-9, P0-10)* — server recomputes every line and the tax at placement, snapshots it, assigns `(businessDay, seq)`, honours the idempotency key, records name/phone/order note.

## Phase 3 — the two live surfaces

- [x] **C-007** — Customer menu + item composer *(P0-1, P0-2 display side)* — categories, required/optional groups, min/max, intensity, live price that is display-only.
- [x] **C-008** — Kitchen queue view *(P0-4, P0-11)* — grouped by state, elapsed time with aging flags, ≥48px taps, negations visually distinct, name/number lookup. Playwright + axe assert the sizes.
- [x] **C-009** — Polling with a server-issued cursor *(P0-5)* — changes-since endpoint, background-tab pause, stop on terminal states.
- [x] **C-010** — New-order alert & acknowledge *(P0-12)* — chime + flash derived from order state so it survives a reload; the ack **is** `placed → accepted`.
- [x] **C-011** — The checkout gate *(P0-6)* — one code path, three triggers: manual pause, auto-pause at the open-order threshold, store hours + closed-today + pre-close cutoff.
- [x] **C-012** — Availability at two grains *(P0-6, P0-3)* — item and modifier-option 86, rendered "sold out" not hidden, in-cart lines flagged at checkout.
- [x] **C-013** — Estimated ready time *(P0-7)* — base + per-open-order increment, shown as a range, replaced by the pause message while paused.
- [x] **C-014** — Customer status page *(P0-5, P0-7, P0-8)* — tokenized link, order number + name, live status, distinct cancelled view with reason.
- [ ] **C-015** — Safe menu editing *(P0-13)* — price confirm-on-save showing old → new, shared-modifier-group warning listing affected items, phone viewport.

## Phase 4 — the capstone

- [ ] **C-016** — Sales report *(P1-1)* — items by day/hour in the restaurant's timezone, top sellers, modifier attach rates, no-show rate.
- [ ] **C-017** — Seeded rush script — 30 orders / 20 minutes with the ugly cases: mid-rush option 86 hitting an open cart, a wrong advance undone, a no-show aging to `abandoned`, a deliberate double-submit, orders bouncing off the pause gate. Zero stuck, lost or duplicated orders. **Confirm the ugly-case list against the PRD's Success Metrics verbatim before building.**

## Deferred by decision (not backlog)

P1-2 order-ahead slots, P1-3 SMS notifications, P1-4 estimate tuning, P1-5 status-link
hardening, P1-6 end-of-day sweep, P1-7 prep-weight throttling, P1-8 payment-state
visibility, and everything in the PRD's P2 list.
