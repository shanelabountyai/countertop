# Backlog — Countertop

One line per requirement, derived from the PRD's Timeline / Phasing section.
One item per session, in order, no skipping ahead. Mark ✅ when the gate passes
and the PROGRESS/RELEASE_NOTES entries are written.

The gate, unchanged for every item:

```
npm run gate    # lint, typecheck, build, e2e, unit — in that order
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
- [x] **C-015** — Safe menu editing *(P0-13)* — price confirm-on-save showing old → new, shared-modifier-group warning listing affected items, phone viewport.

## Phase 4 — the capstone

- [x] **C-016** — Sales report *(P1-1)* — items by day/hour in the restaurant's timezone, top sellers, modifier attach rates, no-show rate.
- [x] **C-017** — Seeded rush script — 30 orders / 20 minutes with the ugly cases: mid-rush option 86 hitting an open cart, a wrong advance undone, a no-show aging to `abandoned`, a deliberate double-submit, orders bouncing off the pause gate. Zero stuck, lost or duplicated orders. **Confirm the ugly-case list against the PRD's Success Metrics verbatim before building.**
- [x] **C-018** — The write-up finished — the four "Reserved for the end" sections of `docs/WRITEUP.md`, plus the two that had said "filled in as phases land" since C-001.
- [x] **C-019** — Stopping the rush mid-service — `runRush(anchor, untilMinute)` and `npm run demo:rush:live`, so `/kitchen` has live cards to look at. Found and fixed a `page.close()` racing a server action in `status.spec.ts`.
- [x] **C-020** — Time in each state on `/kitchen/report` — read off the append-only event log, terminal states excluded, `STATUS_LABEL` shared with the queue.
- [x] **C-021** — Editing a cart line in place — `?line=` re-opens the composer pre-filled from the cart cookie and saves through `replaceLine`, which keeps the line where it sat. Also folded eight copies of the e2e reseed into one helper that keeps stderr.
- [x] **C-022** — Menu integrity in the database — five hand-written CHECK constraints on `ModifierGroup`, `MenuItem` and `ModifierOption`, plus a test that a negative modifier delta stays legal.
- [x] **C-023** — The operator's settings screen — the week's hours, close-for-today, the auto-pause threshold, the pre-close cutoff and the two ready-time numbers, all previously columns with no UI. Every rule mirrors its CHECK constraint.
- [x] **C-024** — The build is a gate step — `npm run gate`, plus a Production build step in CI. The bundler has rejected code the whole rest of the gate passed, twice.
- [x] **C-025** — Shared e2e fixtures — `reseed`, `card`, `addBurritoToCart`, `placeOrderFor` in one file, with the write-then-navigate guard in it. Four defects have come from specs reinventing these without it.
- [x] **C-026** — The confirm is checked against the number it showed — a price or group whose value moved between the confirm panel's render and the tap is refused, naming both values. Exposed and fixed a latent ordering dependency in `menu.spec.ts`.
- [x] **C-027** — The intensity surcharge is editable — a second confirm-guarded price row on every option in an intensity group. Blank means free, which is the column's null and a different fact from $0.00.
- [x] **C-028** — The rush on screen — six e2e tests against a kitchen queue holding 22 live tickets, and a fix for the C-019 demo anchoring an hour back so every card read as overdue.
- [x] **C-029** — Hours are confirmed before they are saved — a diff of only the days that move, with a separate warning naming every day the save would close.
- [x] **C-030** — The write-up caught up — refreshed numbers, and a section on where the post-backlog items came from.
- [x] **C-031** — Screenshots of the real thing — 11 Playwright captures of the running app against the seeded rush, embedded in the write-up. Skipped unless `SCREENSHOTS=1`.
- [x] **C-032** — The portfolio page — `docs/portfolio/` and a private Claude artifact, built from the C-031 screenshots.
- [x] **C-033** — The gate runs before a push — `.githooks/pre-push` runs `npm run gate`, wired by `postinstall`. CI has been billing-blocked since C-029, so four items shipped unverified by anything but a local run someone remembered to do.
- [x] **C-034** — Reservations PRD — `prd-reservations.md`, the adjacent product Countertop's Non-Goals names: table allocation under contention, and SMS confirm/change as the primary guest interface.
- [x] **C-035** — The CI-only half runs locally too — `scripts/ci-local.sh`: a database built from nothing, the four hand-written invariant assertions, the drift check and the TZ=UTC / TZ=Pacific/Kiritimati double run. The pre-push hook runs it before the gate.
- [x] **C-036** — CI on a runner in the room — a self-hosted macOS runner and `ci-self-hosted.yml`, which buys the clean `npm ci` and the automatic trigger the pre-push hook cannot. Its own port (3450) and its own database (`countertop_runner`), so it can never collide with a local sweep.

## Deferred by decision (not backlog)

P1-2 order-ahead slots, P1-3 SMS notifications, P1-4 estimate tuning, P1-5 status-link
hardening, P1-6 end-of-day sweep, P1-7 prep-weight throttling, P1-8 payment-state
visibility, and everything in the PRD's P2 list.
