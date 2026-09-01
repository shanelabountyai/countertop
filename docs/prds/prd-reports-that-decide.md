# PRD: The Report Someone Acts On — Countertop sales reporting, second pass

**Sample business:** "Firebird Kitchen" — the same fast-casual pickup shop, six months in, with a bookkeeper and an avocado invoice
**Status:** Draft v1 — derived from the 2026-09-01 evaluations. Every requirement traces to a numbered finding in `review-dx.md`, `review-ops.md` or `review-systems.md`; the trace is named inline.
**Relationship to the master PRD:** this extends P1-1 (`C-016`) and P1-4 (`C-042`). It does not re-open the report's architecture — full scan, rolling windows, snapshot-only reads — which the WRITEUP records as deliberate.
**Consensus:** the only theme all three evaluators raised independently.

---

## Problem Statement

Four people read this screen and three of them get a number they will act on that is wrong or unfindable.

Sunday night, the GM opens Sales and reads **$478.55 for Friday**. The till says **$431**. There is no screen in the product that reconciles the two, so she spends forty minutes deciding whether she has a theft problem or a software problem. She has neither: six orders were handed over unpaid on a six-deep line — `#013 Jonah Reddick at $28.09` was waved through because the bag was ready — and the report has never read `paymentState` in its life. *(OPS 8)*

The owner opens the same screen to decide whether to keep buying avocados at $70 a case. The attach-rate table sorts by rate descending, so the first twenty-five rows all read **100.0%** — "Agua fresca / Size: Small / 2 of 2", "Taco plate / Fillings: Al pastor / 3 of 3" — which is not information, it is arithmetic on required single-select groups. The row she came for, **"Burrito / Add-ons: Guacamole / 1 of 2 / 50.0%"**, is row 27 of 30. The PRD names that exact number as the point of the feature. *(DX 8)*

Monday 9am, deciding whether to add a 5pm–8pm body: the report says **"Preparing, 30 orders, 8.1 min average."** The kitchen is fine — for the twenty-four tickets that cleared in six minutes. The six that took thirty-one minutes between 6:35 and 6:55 produced the three phone calls and the one-star review, and they are invisible inside that average. *(OPS 9)*

Month end, the bookkeeper reads **$41,203** off the Sales screen and books it as revenue. Actual revenue is $38,062; $3,141 is a sales-tax liability owed to the state. The P&L is overstated by 8.25% and the tax line is understated by the same amount, because the headline stat is `Σ day.totalCents` and it is labelled `Revenue`. *(SYS 3)*

And the accountant asks for March. There is no month, no date range, no export — the windows are `[1, 7, 30, 90]` days rolling from `now` — so the answer is a screenshot of a 30-day window that includes four days of April. *(SYS 9)*

## Users and the moment of use

- **Owner/GM, Sunday night, cashing up.** Wants one number — what did we take — and wants it to match the drawer.
- **Owner/GM, Monday 9am, before the week's schedule goes out.** Wants the worst case, not the mean.
- **Bookkeeper, month end, in a spreadsheet.** Wants a bounded period, net of tax, exportable.
- **Owner, Sunday afternoon, with a produce invoice.** Wants one attach rate and will not scroll for it.

## Requirements

### Must-Have (P0)

**P0-1: Revenue means net sales; tax is its own number** *(SYS 3)*
- [ ] The headline stat is **Net sales** = Σ `subtotalCents` over the window; **Tax collected** = Σ `taxCents` is a sibling tile; **Gross** = Σ `totalCents` is shown but never labelled "Revenue"
- [ ] The By-day and By-hour tables carry the same three columns, and each day's three reconcile: `net + tax = gross`, asserted in the test, not just rendered
- [ ] Tax is read from the snapshot columns only (`Order.taxCents`, `Order.taxRatePpm`); no recomputation from `RestaurantSettings` anywhere on this path

**P0-2: Collected versus charged, with the exceptions named** *(OPS 8, SYS 3 — and the follow-on to defect D2)*
- [ ] `loadReportOrders` selects `paymentState`; the report splits the window into **collected** (`paid`) and **outstanding** (`unpaid`) and shows both against gross
- [ ] Every order contributing to *outstanding* is listed by `seq`, name, amount and business day — a chase list, not a count
- [ ] A `refunded` order is a third bucket and never silently nets into either of the other two
- [ ] The number of unpaid pickups is reported as a rate as well as a count, so "six on a Friday" is comparable across days
- [ ] Test: a fixture with one `picked_up`/`unpaid` order and one `picked_up`/`paid` order asserts `collected ≠ charged`, that the delta equals the unpaid order's total to the cent, and that the unpaid order appears in the list

**P0-3: A "Today" window bounded on the restaurant's business day** *(DX 9)*
- [ ] A `Today` window is added and is the default selection; it bounds on `restaurantClock(now, timezone).day`, the same business day the order-number reset and `businessDay` column already use — never a 24-hour instant range
- [ ] The partial-oldest-day disclaimer is suppressed for `Today` and retained for the rolling windows, whose behaviour does not change *(the WRITEUP records the partial-day bucketing as deliberate; this adds a window, it does not re-bucket the existing ones)*
- [ ] Test: with orders seeded on two adjacent business days, `Today` returns exactly one row in By-day, and the same fixture under `TZ=Pacific/Kiritimati` and `TZ=UTC` returns identical rows

**P0-4: The attach-rate table leads with the rows that can change a decision** *(DX 8)*
- [ ] Rows at 100% across every unit collapse behind a disclosure labelled "Always taken (required choices) — show", closed by default
- [ ] The visible table shows rates strictly between 0% and 100%, sorted by **attached volume** descending, not by rate
- [ ] Negations (`intensity: none`) stay excluded from attach counts — the existing behaviour, asserted again here so a re-sort cannot quietly change it
- [ ] Test: against the seeded rush, the guacamole row renders above the fold and no 100% row precedes it

**P0-5: Distribution, not just the average** *(OPS 9)*
- [ ] Each time-in-state row gains a **p90** beside its average and a **worst** value
- [ ] A "**Ran late**" count: tickets whose placed→ready elapsed exceeded the configured queue flag threshold (default 15 min), computed from the append-only event log — the same threshold the queue card turns red at, read from one place, not restated
- [ ] The **slowest five** tickets are listed by `seq` with their elapsed time and business day
- [ ] Test: a fixture of twenty-four 6-minute tickets and six 31-minute tickets asserts an average near 11, a p90 of 31, a ran-late count of exactly 6, and that all six appear in the slowest list

**P0-6: Cancellations by reason, with the two reasons that actually happen** *(OPS 9, OPS 12)*
- [ ] A cancellations-by-reason table over the window: count and value per reason, `other` shown with its free text
- [ ] `CancelReason` gains `customer_changed_mind` and `kitchen_error` — the two the operator names as most common and least countable today; `other` becomes the rare bucket
- [ ] Existing rows keep their stored reason untouched; no backfill reclassifies history
- [ ] Test: cancel one order under each reason and assert six rows with the right counts; assert an order cancelled before the migration still reports as `other`

### Nice-to-Have (P1)

- **P1-1: An arbitrary date range** *(SYS 9)* — two business-day inputs (`YYYY-MM-DD`, compared against the `businessDay` column as string equality, the same trick `historyWhere` uses at C-049 — no parsing, no timezone arithmetic in the path). "March" becomes answerable.
- **P1-2: CSV export of the current view** *(SYS 9)* — the rows on screen, with the window in the filename. The bookkeeper's actual ask; a server action returning a text body, no dependency.
- **P1-3: A no-show and ran-late trend line** *(OPS 9)* — the ran-late count from P0-5 plotted by day, so "was Friday unusual" stops being a memory question.

## Non-Goals

- **Changing how the rolling windows bucket.** The partial-oldest-day behaviour is recorded as deliberate in the WRITEUP; P0-3 adds a window beside it.
- **Grouping report rows by `menuItemId` so a rename merges.** Recorded and rejected on snapshot-rule grounds (C-016). A renamed item is still two rows and the page still says so.
- **A materialized rollup.** The full scan is recorded as adequate at this scale, with the rollup named as the chain-scale upgrade. Not this work.
- **Per-line tax categories.** Real, expensive, and belongs to `prd-money-that-reconciles.md`; this PRD reports the order-level tax that exists.
- **Anything that reads a live menu row to render a report.** `loadReportOrders`'s snapshot-only `select` is load-bearing and does not grow a join here.
- **Per-cook attribution on any report row.** Depends on staff identity; that is `prd-who-did-it-and-what-leaves.md`.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `Order` | none — `paymentState`, `taxCents`, `subtotalCents`, `businessDay` all already exist and are already snapshotted | none |
| `OrderEvent` | none — the ran-late and p90 computations read the existing log | none |
| `CancelReason` (enum) | two new values: `customer_changed_mind`, `kitchen_error` | **yes, hand-written** — `ALTER TYPE ... ADD VALUE` cannot run inside a transaction block in older PG and must not be generated blind; the migration is written by hand per CLAUDE.md and applied additively, never by re-creating the type |

`loadReportOrders`'s `select` widens by exactly one column (`paymentState`). That is a scalar on the order, not a join — it does not weaken the snapshot rule.

## Invariant impact

1. **Snapshot rule — touched, must keep holding.** Every new number is computed from columns already snapshotted on the order or from the event log. The temptation this PRD creates is the attach-rate re-sort reaching for a live `ModifierOption` to decide whether a group is required; it must not. Requiredness at the time of the order is already implied by the snapshot (`OrderLineOption` rows carry `groupName` and `optionName`), and a 100% rate across every unit is itself the signal — no menu join needed. The existing snapshot regression test is extended: after mutating every referenced menu row, the report's rows for that order must be byte-identical.
2. **Server is the price authority — untouched.** The report computes no prices; it sums snapshotted cents. Money stays integer cents throughout; the p90 and the rates are the only non-cent quantities and neither is money.
3. **One status module — touched.** `Ran late` and the slowest-five list must derive their "which orders count" from `salesRoleOf` and the exported status lists, never from a status literal. The systems review already flags `packages/db/report.ts:94` as restating a status in SQL with no paired test; P0-5 adds a reader on that path, so the paired dual-dialect test lands with it.
4. **One orderability function — untouched.**
5. **Idempotent placement — untouched.**

**Timezone:** every new bucket (`Today`, the date range, the trend line) uses `restaurantClock(now, timezone).day`. The CI TZ×2 run is the gate on this, and P0-3's test is written to fail under a UTC-only implementation.

## Acceptance criteria

- A fixture with one paid pickup ($20.00) and one unpaid pickup ($28.09) reports gross $48.09, collected $20.00, outstanding $28.09, and lists exactly one order in the chase list.
- `net + tax = gross` holds to the cent for every day row in every window, over the seeded rush.
- The headline tile is labelled "Net sales" and its value equals Σ`subtotalCents`; no tile in the page is labelled "Revenue".
- `Today` over a two-business-day fixture returns one By-day row, identically under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
- The seeded rush's guacamole attach row is rendered before any 100% row; the 100% rows are present but inside a closed disclosure.
- Over a 24×6-minute + 6×31-minute fixture: ran-late count = 6, p90 = 31, slowest-five contains the six longest by `seq`.
- Cancelling with `kitchen_error` produces a row in the by-reason table; an order cancelled before the migration still reports under `other`.
- The snapshot regression: mutate every menu row referenced by a reported order, re-run the report, assert byte-identical output.

## Open Questions

- **(Product)** Should an `unpaid` `picked_up` order count into net sales at all, or sit outside it until collected? The operator's read is "it is a sale I have not been paid for" (count it, show the gap); an accrual bookkeeper would agree, a cash-basis one would not. **This changes the headline number and needs a human answer before P0-2 is built.**
- **(Product)** The systems reviewer wants the report to reconcile against a processor settlement; the operator wants it to reconcile against the till. These are different reports with different sources. Which one ships first — and does the till count get entered by a human anywhere, or is "the drawer" forever out of the system?
- **(Ops)** Is 15 minutes the right "ran late" threshold for a *report*, or should the report threshold be separately configurable from the queue's visual flag? The queue flag is about attention; the report line is about staffing.
- **(Builder)** Adding two enum values is a hand-written migration; is it worth converting `CancelReason` to a lookup table now so the next two reasons are a row rather than a migration? Against: a table invites free-form reasons, which is exactly the un-countable `other` bucket the operator is complaining about.

## Phasing — one item per session

- **C-050 — The report reads `paymentState`** *(this is defect **D2**'s fix, not a feature; it lands first and alone)* — `loadReportOrders` selects the column, revenue splits collected/outstanding, the unpaid orders are listed. One migration-free session.
- **C-051 — Net sales, tax, and gross are three different numbers** — P0-1, plus the reconciliation assertion in the test.
- **C-052 — Today** — P0-3, the business-day window and the suppressed disclaimer, with the TZ×2 test.
- **C-053 — The attach-rate table leads with the decidable rows** — P0-4, and the snapshot-rule assertion that the re-sort added no menu join.
- **C-054 — p90, the ran-late count, and the slowest five** — P0-5, including the paired dual-dialect test for the SQL status restatement on `report.ts:94`.
- **C-055 — Cancellations by reason** — P0-6, with the hand-written `ALTER TYPE` migration.
- **C-056 — A date range and a CSV** — P1-1 and P1-2 together; both are the same query shape.
