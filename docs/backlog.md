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
- [x] **C-037** — Staff auth on `/kitchen` — one shared passcode, one middleware, fails closed when `STAFF_PASSCODE` is unset. The write-up has called this "the first thing a real deployment needs" since C-008.
- [x] **C-036** — CI on a runner in the room — a self-hosted macOS runner and `ci-self-hosted.yml`, which buys the clean `npm ci` and the automatic trigger the pre-push hook cannot. Its own port (3450) and its own database (`countertop_runner`), so it can never collide with a local sweep.

- [x] **C-038** — Payment-state visibility *(P1-8)* — checkout takes a mock card charge or leaves the order as pay-at-pickup; the kitchen card flags the unpaid ones with the amount and a `Collected — mark paid` button; cancelling a paid order moves the column to `refunded` alongside the refund event the engine already wrote. The column and the `refund` event kind have been in the schema since C-003 — this item is what makes `paid` and `refunded` reachable, and it needed no migration.

- [x] **C-039** — The end-of-day sweep *(P1-6)* — `isLeftOver` in `packages/core`, one predicate with three readers: the kitchen flags an order left over from an earlier business day with its date, the new-order chime stops counting it, and the P0-6 throttle and P0-7 estimate stop counting it too. Flagged, never swept — closing one out is a staff transition to the terminal state only they can pick. No migration.

- [x] **C-040** — The screenshots caught up — all fourteen captures regenerated from the running app, three of them new: the staff sign-in (C-037), an unpaid ticket with its collect control (C-038), and a queue carrying leftovers from an earlier day (C-039). Six of the eleven that already existed came back different. The portfolio page rebuilt on top of them.

- [x] **C-041** — Prep-weight throttling & estimates *(P1-7)* — every menu item carries an integer prep weight, an order snapshots the sum of its lines' weight × quantity beside its money, and the P0-6 auto-pause threshold and the P0-7 estimate both read that sum instead of a row count. Ten bottled waters weigh 0; ten fajita plates weigh 40. Two settings renamed with their CHECKs (`maxOpenWeight` default 60, `prepPerWeightMinutes`), the menu editor grows a confirm-free prep-points field, and the snapshot regression test now re-weighs the item it mutates.

- [x] **C-042** — Estimate tuning *(P1-4)* — an order snapshots the ready-time range it was quoted at checkout and the open prep weight that quote was computed against, so "were we honest?" is answerable from the orders themselves instead of from a recomputation that always scores full marks. `estimateAccuracy` in `packages/core` grades early / on-time / late off the median miss, splits the samples at the median queue depth, and names which of the two P0-7 settings to move. Early counts as a miss; under ten quoted orders it recommends nothing.

- [x] **C-043** — A production guard on the destructive scripts — `db:seed`, `db:reset:test` and `demo:rush` all begin by TRUNCATEing every table, and today that is safe only because every database this repo can reach is on localhost. Refuse to run against a non-local host (the URL, not `NODE_ENV` — an env var nobody set is not a safety mechanism), with one deliberate override. **Must land before C-045**, because a cloud database with no guard in front of these is one mistyped `dotenv -e` away from wiping a live restaurant.
- [~] **C-044** — The repo went public, CI was proven, and the flip was reverted — public repos get free GitHub-hosted Actions minutes, which is the direct fix for the billing block that has stood since C-029 and made the C-036 self-hosted runner the only working CI. The C-042 history audit was re-run rather than trusted (filenames and contents, every ref): one `.env.example`, names only. The item's unwritten half was the self-hosted runner — `runs-on: self-hosted` executes repo code on the developer's Mac, and public changes who can propose that code, so the runner is deregistered and `ci-self-hosted.yml` is reduced to `workflow_dispatch`. The recipe stays in the file; the dependency does not. **Reverted the same day:** the repo is private again by decision, so `ci.yml` is billing-blocked once more and the runner is re-registered with its `push` trigger restored (safe by construction while private). What survives is the proof — `ci.yml` ran fully green twice during the public window, on Node 22 and on Node 24, e2e 105+14 skipped = 119 and unit 418/418 under both timezones, having never executed a single step since C-029. Ticked as `~`: the CI question is answered, the visibility decision is open and belongs with C-045.
- [x] **C-045** — Deployed: Vercel + Neon *(the PRD's stated target)* — the app the write-up describes, on a URL the portfolio page can link. Neon holds the deployed database ONLY; `.env.test` stays on local Postgres, per the standing rule that tests never point at a remote database. `STAFF_PASSCODE` set in Vercel and nowhere else. **Live at https://countertop-mu.vercel.app**, seeded with a rush stopped at minute 12. Cost three deploys to a defect no local check could see: Turbopack bundled the Prisma client, and a bundled client cannot locate its query engine — fixed by moving the client back to its default output so `serverExternalPackages` can name it.

## Deferred by decision (not backlog)

**A GitHub organization for the five projects** — deferred 2026-08-27, not
rejected. **Trigger to revisit: the second project that needs this CI
treatment.** Until then one runner serves one repo, which matches the
one-project-at-a-time convention.

- *Why it would earn its keep:* private-repo **reusable workflows only work
  inside an org**, so five projects could call one gate workflow instead of
  drifting five copies — the same drift `ci-self-hosted.yml` and
  `ci-local.sh` already show in miniature. Plus org-level secrets, one runner
  shared serially (five per-repo runners would run parallel sweeps on one Mac,
  which the conventions ban), an org profile as a portfolio surface, and a
  separate billing surface that *might* restore free GitHub-hosted Actions —
  unverified, and it may follow the payment method rather than the account.
- *Money:* $0. Free covers unlimited private repos, collaborators and
  self-hosted runners. Team ($4/user/mo) only adds branch protection and
  required reviews on private repos — theatre for a solo project.
- *One-time cost:* re-register the runner at org level (`config.sh remove`,
  re-config), `git remote set-url` on every checkout, and Vercel
  re-authorizing against the new owner. Transfers leave redirects, so old
  links keep working.

P1-2 order-ahead slots, P1-3 SMS notifications, and everything in the PRD's P2
list. (P1-4 and P1-7 were on this line until they shipped as C-042 and C-041 —
this list is the one that goes stale, so check it against the ticks above.)

**P1-5 needs no item: it shipped inside P0.** The status token is
`randomBytes(24)` — 192 bits, above the ≥128 the requirement names — the order
is looked up by that token and never by its number, so counting order numbers
reaches nothing, and C-014 already renders the distinct terminal view. Closed
as satisfied 2026-08-27 rather than built twice.
