# PRD: Countertop — Online Ordering for a Restaurant

**Sample business:** "Firebird Kitchen," a fast-casual spot doing pickup orders (works for any QSR)
**Builder:** Solo, in Claude Code
**Status:** Draft v2 — reviewed by a senior restaurant-tech product owner and a 25-year QSR owner-operator; see the Review Addendum at the end for verdicts and the change log
**Learning objectives:** variant/modifier data modeling, order-queue state transitions, near-real-time UI updates, price computation from composed selections, kitchen-facing vs. customer-facing views

---

## Problem Statement

Phone orders tie up staff during the rush, get transcribed wrong ("no onions" becomes extra onions), and give the kitchen no queue visibility. Third-party platforms solve this but take 15–30% commission (typical published marketplace rates; treat as context, not a claim to verify in-app). A restaurant needs its own ordering flow where customers compose exactly what they want, the kitchen sees a live prioritized queue, and order status is visible to everyone without anyone answering a phone.

The builder-side problem this project targets: **menu variant modeling** (sizes × modifiers × combos) and **live order-queue flow** — two feature families the rental, storage, appointment, and subscription projects never touch.

## Goals

1. A customer can compose a customized order (size, modifiers, quantity, notes) and see an accurate price at every step.
2. The kitchen sees a live queue, is **actively alerted** to new orders, and moves orders through states with one tap; customers see status without refreshing manually.
3. Menu changes (86'd items **or 86'd modifier options**, price updates) take effect immediately without breaking in-flight orders.
4. Order totals are always correct: item price + modifier deltas × quantity, **plus tax**, verified server-side.
5. Every order has a **human-callable identity** (number + name) so the pickup handoff physically works.
6. **(Builder goal)** Exercise variant data modeling, status-driven queues, and polling/live-update patterns.

## Non-Goals

- **Delivery logistics** (drivers, routing, tracking) — that's the field-service project's territory. Pickup only.
- **Real payment processing** — mock provider behind an interface, same convention as BoxLoop. "Pay at pickup" is also a valid v1 flow.
- **Table reservations / dine-in service** — adjacent business, different feature family (that's scheduling, already covered by Bookable).
- **POS/printer integration** — hardware integration is config, not logic.
- ~~**Loyalty/rewards** — entitlement systems are the fitness-studio project's lesson.~~ **LIFTED 2026-09-02 by the owner** (decision 8, `docs/prds/INDEX.md`), promoting the P2 item below. `docs/prds/prd-loyalty.md` is the PRD and its own recommendation was to leave this closed; that was read and overruled, which is the owner's call. The Non-Goal's original reason still holds and is now a *boundary* rather than a bar: the program stops at ONE integer per member, and a second entitlement dimension — tiers, birthdays, streaks — is where the fitness-studio lesson genuinely begins.
- **Multi-restaurant marketplace** — that's project #4. One restaurant, one menu.

## Personas

- **Customer** — browses menu, composes items, orders, watches status.
- **Kitchen staff** — works the live queue, acknowledges and advances order states, 86's items and options.
- **Manager/Owner** — edits menu, sets hours/prep capacity, reads sales reports.

## User Stories (priority order)

1. As a customer, I want to browse a categorized menu with photos and prices so that I can decide quickly.
2. As a customer, I want to customize an item (size, required choices, optional add-ons, "no X" / "light X" / "extra X", special instructions) and see the price update live so that I get exactly what I want at a known cost.
3. As a customer, I want a cart that holds multiple composed items so that I can order for a group.
4. As kitchen staff, I want new orders to be **announced — sound and flash — until someone acknowledges them** so that nothing gets missed during a rush.
5. As kitchen staff, I want to advance an order (received → preparing → ready) with one tap — **with a few seconds to undo a fat-fingered tap** — so that status stays current under pressure.
6. As a customer, I want to see my order's live status, **my order number**, and an estimated ready time so that I show up when it's actually ready.
7. As a manager, I want to 86 an item **or a single modifier option (out of guac ≠ out of burritos)** instantly so that customers can't order what we've run out of. *(edge: item or option already in someone's open cart)*
8. As a manager, I want to edit items, modifiers, and prices — **safely, on my phone, between rushes** — so that the menu stays accurate. *(edges: price change while an order is in-flight — the order keeps its placed price; editing a modifier group shared across items warns before applying)*
9. As a manager, I want daily sales by item and hour **in my restaurant's timezone** so that I can see what sells and when.
10. As kitchen staff, I want new orders paused automatically when we're slammed — and manually anytime — so that we don't promise what we can't deliver. *(throttle: max open orders configurable)*
11. As a customer, I want checkout to ask for my name so that staff can call my order and find it when I walk up.
12. As a manager, I want to set store hours and a "closed today" override so that nobody orders at 2am into an empty kitchen.
13. As kitchen staff, I want ready orders that nobody picks up to age visibly and be closeable as abandoned so that the queue reflects reality.

## Requirements

### Must-Have (P0)

**P0-1: Menu data model** *(core learning artifact #1)*
Categories → items → modifier groups → modifier options. Modifier groups have rules: required vs. optional, min/max selections, per-option price deltas (can be negative or zero).
- [ ] Given a burrito with a required "protein" group (pick exactly 1) and an optional "add-ons" group (pick 0–3), when a customer skips protein, then checkout is blocked with a clear message
- [ ] An option with a price delta (e.g., +$2.50 guac) changes the composed item price immediately
- [ ] One modifier group (e.g., "spice level") is reusable across multiple items without duplication
- [ ] Item variants (S/M/L) are modeled as a required single-select modifier group with price deltas — one mechanism, not two
- [ ] Modifier structure is exactly one level deep: item → modifier group → option; options cannot own nested groups (combos/nesting deferred to P2)
- [ ] A modifier group can optionally enable per-option intensity (none/light/regular/extra), with "extra" optionally priced — customers ask for "light sauce," not "no sauce" *(OPS)*

**P0-2: Server-side price computation**
Client-side prices are display-only; the server recomputes every line item at cart-add and again at order placement.
- [ ] Given a tampered client request claiming a $0 total, when the order is placed, then the server-computed total is used and a mismatch is logged
- [ ] Line item price = (base + Σ modifier deltas) × quantity; order total = Σ lines + tax (per P0-9); totals covered by unit tests against hand-calculated fixtures, including a zero-tax and a nonzero-tax fixture

**P0-3: Cart and order placement**
- [ ] Cart persists per session; composed items are editable and removable
- [ ] Placing an order snapshots the full composed state (names, options, prices at time of order) — later menu edits never mutate a placed order
- [ ] Given an item — or a selected modifier option — 86'd while sitting in a cart, when the customer proceeds to checkout, then that line is flagged and must be removed or fixed before placing
- [ ] Given a price changed while an item sat in the cart, when the customer proceeds to checkout, then the changed line is highlighted with old → new price and the customer must confirm before placing (no silent repricing)
- [ ] Per-item special instructions are capped at 140 characters; line quantity is capped at a configurable max (default 20), enforced server-side
- [ ] Placement captures order identity per P0-8 and is idempotent per P0-10

**P0-4: Order lifecycle & kitchen queue** *(core learning artifact #2)*
States: `placed → accepted → preparing → ready → picked_up`; `placed|accepted → cancelled` (by staff, or by customer before `accepted`); `ready → abandoned` (staff closes out a no-show). Acknowledging a new order's alert (P0-12) **is** the `placed → accepted` transition — accepting is never a separate chore.
- [ ] Invalid transitions rejected; the transition table lives in one module (single source of truth for every reader — queue filters, reports, throttle counts)
- [ ] Backward moves (e.g., ready → preparing) require an explicit staff "revert" action that's logged; every forward advance shows a 5-second undo, and undo is logged as a revert
- [ ] Cancelling a paid (mock-paid) order writes a mock refund record via the payment interface; staff pick a cancel reason from a short preset list ("out of item," "too busy," "other" + optional text); the customer status page shows a distinct cancelled view with the reason
- [ ] Kitchen queue orders by placement time, groups by state, and shows elapsed time per order with a visual flag past a configurable threshold (default 15 min); `ready` orders get a second aging flag (10/20/30 min) so no-shows are visible
- [ ] Every transition is timestamped for reporting (time-in-state); `abandoned` is distinct from `cancelled` in the data (no-show rate is a business signal)
- [ ] Kitchen queue tap targets are ≥ 48px, state-advance is the largest control on each card, and card text is legible at arm's length (item lines ≥ 18px equivalent) — greasy gloves and knuckle-taps are the input device

**P0-5: Live updates (polling)**
- [x] Kitchen queue and customer status views poll every 5–10 seconds; new orders are announced per P0-12, not merely rendered
- [x] The update fetch is an endpoint returning changes since a server-issued cursor (echoed from the previous response — never the client's clock), so a later WebSocket upgrade (P2) swaps the transport, not the logic
- [x] Customer status page pauses polling when the tab is backgrounded and stops on terminal states (`picked_up`, `cancelled`, `abandoned`)

**P0-6: Availability, pause, and hours** *(one checkout gate, three triggers)*
- [x] Manager or kitchen can toggle **item** availability instantly; unavailable items render as "sold out," not hidden
- [x] Manager or kitchen can toggle **modifier option** availability independently (out of avocado ≠ out of burritos); composing an item with an unavailable option is blocked, and in-cart lines holding one are flagged per P0-3
- [x] A "pause new orders" switch stops checkout with a clear customer-facing message; in-flight orders continue
- [x] When open orders (`placed|accepted|preparing`) reach a configurable max (default 25), checkout auto-pauses with the same message; it auto-resumes below the threshold, and the manual switch always overrides *(upgraded to open prep WEIGHT, default 60, in C-041 — P1-7)*
- [x] Configurable weekly store hours plus a "closed today" override gate checkout through the same code path as pause, with a clear "we open at 11:00" message; new orders cut off a configurable N minutes before close (default 15)

**P0-7: Estimated ready time**
Simple v1: configurable base prep time + per-open-order increment.
- [x] Estimate shown at checkout and on the status page, recalculated on each poll
- [x] The estimate is an honest range (e.g., "15–25 min"), never a precise wrong number; while ordering is paused (manual or auto) the checkout estimate is replaced by the pause message — never a stale time promise
- [x] Accuracy is not a P0 metric — existence and recalculation are; tuning is P1

**P0-8: Order identity — number, name, contact** *(new in v2 — PO + OPS)*
Every order gets a short human-callable identity at placement: a daily-resetting sequential order number (e.g., #047, reset per restaurant-timezone day) plus a required customer name and optional phone.
- [ ] Placing an order assigns the next sequential number for the current restaurant-timezone day; two concurrent placements never share a number (unique constraint tested under the seeded rush)
- [x] Checkout requires a name (1–40 chars); phone is optional and feeds the P1-3 notification stub
- [x] Order number + name appear on the kitchen queue card, customer status page, and order confirmation; the internal UUID never appears in any UI
- [x] An optional order-level note (e.g., "blue Honda out front," ≤140 chars) is captured at checkout and shown on the kitchen card

**P0-9: Tax line (explicit decision)** *(new in v2 — PO)*
Order totals carry an explicit tax field computed server-side from a single configurable flat rate (default 8.25%); subtotal, tax, and total are distinct persisted fields on the order snapshot.
- [ ] Tax = round(subtotal × rate) in integer cents, computed and snapshotted server-side at placement
- [x] Receipt/status/checkout views show subtotal, tax, and total as separate lines
- [ ] Tampered client tax values are ignored, same as P0-2 totals

**P0-10: Idempotent order placement** *(new in v2 — PO)*
Checkout submissions carry a client-generated idempotency key; retries and double-taps of the same attempt return the original order instead of creating a duplicate.
- [ ] Two submissions with the same key create exactly one order; the second response returns the first order's confirmation
- [ ] The submit button disables on first tap client-side, but the server guarantee holds without it
- [ ] The seeded rush script exercises at least one deliberate double-submit and asserts a single resulting order

**P0-11: Kitchen ticket content** *(new in v2 — PO + OPS)*
Each queue card shows everything the line cook needs without tapping through: order number + name, per-line quantity, item name, selected options grouped by modifier group, and notes — with removals/negations ("NO onions") visually emphasized and notes rendered large, never truncated behind a hover.
- [ ] A seeded order with a "no X" selection and a special instruction renders both on the card, with the negation visually distinct from additive modifiers
- [ ] Quantity > 1 is prominent (e.g., "2×" before the item name), not a footnote
- [ ] Card renders correctly for the largest seeded order (5+ lines) without hiding lines
- [ ] The queue screen supports lookup by name or order number for the "I'm here, where's my food" walk-up moment

**P0-12: New-order alert & acknowledge** *(new in v2 — OPS: "a silent queue screen is a dead queue screen")*
- [x] A new order triggers a repeating audible chime and a visually flashing card until a staff tap acknowledges it; acknowledgment is the `placed → accepted` transition (P0-4)
- [x] Unacknowledged orders are visually distinct from every other state, and the alert survives a page reload (derived from state, not from a client-side event)
- [ ] The seeded rush demo shows alerts firing and being acknowledged — an order arriving silently is a test failure

**P0-13: Safe menu editing** *(new in v2 — OPS: edited on a phone, one-handed, in 90 seconds)*
- [x] Price edits confirm-on-save showing old → new (the $1.50 → $15.00 fat-finger is the target defect)
- [x] Editing or deleting a modifier group shared across items warns with the list of affected items before applying
- [x] Menu editing screens are usable on a phone viewport (the between-rush device is a phone, not a laptop)

### Nice-to-Have (P1)

- **P1-1: Sales report** ✅ *(C-016)* — items sold by day/hour, top sellers, modifier attach rates (e.g., % of burritos adding guac — a genuinely fun query to write), plus no-show (`abandoned`) rate. All day/hour bucketing uses the restaurant's configured timezone, not UTC; the seeded rush report is the regression fixture.
- **P1-2: Order-ahead scheduling** — "pickup at 12:30" slots with per-slot capacity; reuses slot-thinking from Bookable
- **P1-3: SMS-style status notifications** — outbox log on `ready`, same stub convention as prior projects; uses the phone captured in P0-8
- **P1-4: Estimated-time tuning** ✅ *(C-042)* — the quoted range and the queue depth behind it are snapshotted on the order, and `/kitchen/report` compares them against the actual `ready` timestamps from the P0-4 event log, naming which of the two P0-7 settings to move. Suggested, never auto-applied
- **P1-5: Status page hardening** ✅ *(shipped inside P0 — closed as satisfied, not built twice)* — the tokenized status link is ≥128-bit random and unguessable; enumeration of sequential order numbers cannot resolve another customer's status page; terminal states render a final view
- **P1-6: End-of-day sweep** ✅ *(C-039)* — any orders still open at close are flagged for closeout so tomorrow's queue and order numbers start clean
- **P1-7: Prep-weight throttling & estimates** ✅ *(C-041)* — per-item integer prep weight (default 1); the P0-6 auto-pause threshold and the P0-7 estimate compute from open *weight* instead of order count — ten bags of chips ≠ ten catering bowls
- **P1-8: Payment-state visibility** ✅ *(C-038)* — orders carry `unpaid | paid | refunded` (mock provider); the kitchen card flags unpaid ("pay at pickup") orders so the counter collects before handoff

### Future Considerations (P2)

- WebSocket transport for live updates (P0-5's design makes this a swap)
- Real payment provider adapter (interface already mocked) — with a prepay-required option: prepay is how you make `abandoned` rare
- Combos/meal deals and nested modifiers (bundle pricing — hardest pricing case; keep price computation in one module now)
- "Reorder" / order-again from a past order — requires re-validating a snapshot against the live menu (86'd items, changed prices), its own small engine
- Tips at checkout — pure money-math add-on once real payments land; pickup tip rates run 10–15% when the prompt exists
- Kitchen station routing / expo view (grill vs. fry split screens) — the multi-queue version of P0-4
- Ticket printer / KDS hardware — screens fail and grease kills tablets; a $200 impact printer is the kitchen's seatbelt
- Real SMS "order ready" notifications — cuts counter congestion more than any UI feature; the phone field makes this a flip of a switch
- Loyalty / repeat-customer recognition; delivery hand-off; multi-location (menu-per-location, per-store hours); catering / large-order lead-time rules (P1-2 grown up)

## Success Metrics (evaluated against seeded demo data)

**Leading**
- Price computation: 100% pass on a fixture matrix (required groups, min/max rules, intensity levels, negative deltas, quantity math, tax rounding, tampered-total rejection)
- State machine: 100% of valid transitions and ≥8 invalid-transition rejections tested, including `abandoned` and undo-as-logged-revert
- Snapshot integrity: menu edits after order placement produce zero changes to placed-order data (regression test)
- Idempotency: the double-submit fixture produces exactly one order

**Lagging (simulated)**
- A seeded rush (30 orders in 20 minutes via script) flows through the queue with zero stuck or lost orders — **and the rush includes the ugly cases, or the demo proves nothing** *(OPS)*: one mid-rush modifier-option 86 with an affected in-cart order, one wrong-order advance + undo, one no-show that ages out to `abandoned`, one deliberate double-submit, and orders arriving while paused
- Time-in-state report matches hand-tallied values for the seeded rush
- Order numbers are sequential with no duplicates across the rush's concurrent placements

Measurement method: seed script builds a ~25-item menu with 8 modifier groups (including one reused group, one min/max group, and one intensity-enabled group) plus a scripted rush-hour order generator.

## Open Questions

- **(Builder)** Poll interval vs. server load — fixed 5s or exponential backoff when idle? V1: fixed 5s, note it in WRITEUP.md as a scaling caveat. *(resolved)*
- **(Builder)** Guest checkout only, or reuse Bookable's tokenized-link pattern for order status? Tokenized link — proven pattern, no auth project needed. *(resolved)*
- **(Product)** Should customers cancel after `accepted`? V1: no — call the restaurant; log how often the cancel button is hit post-acceptance in seed sims. *(non-blocking)*
- **(Product)** Does "pay at pickup" coexist with mock-pay in v1? **V2 decision: yes, both** — the order carries a payment-state field (P1-8); it costs little and exercises the payment interface. *(resolved in v2)*
- **(Product)** `accepted` mechanics: separate accept tap or merged with the alert acknowledgment? **V2 decision: merged** (P0-12) — a state customers can stall in while staff ignore it is worse than not having the state. *(resolved in v2)*
- **(Builder)** Daily order-number reset: midnight restaurant-time or a configurable "business day" boundary (e.g., 4 AM) for late-night service? V1: midnight restaurant-time; note the business-day boundary as a known simplification. *(non-blocking)*
- **(Product)** Should the status page show queue position ("3 orders ahead of you") alongside the estimate? Derivable from P0-4 data and sets expectations better than a raw ETA — but leaks pace information some operators dislike. *(non-blocking)*
- **(Product)** Store hours were a PO-vs-operator split: the PO would defer hours entirely; the operator calls the 2am orphan order a week-one kill. **V2 decision: minimal hours ship in P0-6** (weekly hours + closed-today override through the pause code path) — the gate exists anyway, hours are one more trigger. *(resolved in v2)*

## Timeline / Phasing

- **Phase 1:** P0-1, P0-2, P0-9 (menu model + price engine + tax) — build these as pure logic with tests before any UI; the modifier model is this project's slot engine
- **Phase 2:** P0-3, P0-4, P0-8, P0-10 (cart, placement snapshot + identity + idempotency, lifecycle + kitchen queue)
- **Phase 3:** P0-5, P0-6, P0-7, P0-11, P0-12, P0-13 (polling + alerts, availability/pause/hours gate, estimates, ticket content, safe menu editing)
- **Phase 4:** P1 sales report + the scripted rush — including the ugly cases — as the capstone demo

Scope note (v2): P0 grew from 7 items to 13. P0-8/9/10 are each small (a schema field set, one computation, one unique key); P0-11/12/13 are UI discipline on screens being built anyway. The genuinely new machinery is option-level availability (P0-6) and intensity levels (P0-1) — both are deliberate extensions of the modifier model, which is the point of the project.

## Build Notes for Claude Code

- TDD the modifier/price module first — it's this project's highest-defect-risk pure logic, same role the slot engine played in Bookable
- The order snapshot rule (placed orders are immutable copies, never references to live menu rows) is the convention Claude will drift on across sessions — put it in CLAUDE.md alongside the money-as-integer-cents rule carried over from BoxLoop
- Availability now has two grains (item and modifier option) — keep "is this composition orderable?" in one function in `packages/core`, or the cart, checkout, and menu views will each grow their own slightly different answer
- The transition table, the throttle's open-order count, and every queue filter must read from one status module — the rental build's `VERIFIED` defect, structurally prevented (same rule as Bookable's CLAUDE.md)
- Drop WRITEUP.md + the CLAUDE.md write-up block in at repo creation, not at the end — the write-up rules only work if they're present from commit one
- The rush-hour simulation script is the portfolio demo: one command, watch the kitchen queue fill, alert, and drain — ugly cases included

---

## Review Addendum (v2)

Two persona reviews were run against Draft v1 on 2026-08-25. Their full findings were merged into the requirements above; this addendum preserves the verdicts and maps every change to its source. **PO** = senior product owner, restaurant tech. **OPS** = owner-operator, 25 years QSR/fast-casual.

### PO verdict

> A strong PRD for a learning build — the modifier model, server-side price authority, snapshot-on-placement rule, and transport-swappable polling design are exactly the right load-bearing decisions, stated testably. The biggest risk is that the order itself is under-specified as an operational object: no order number/pickup identity, no customer name on the ticket, no tax decision, no idempotent placement — the four things that break first in any real ordering system. Buildable as written, but the kitchen queue would render orders no expo could call out.

### OPS verdict

> Smarter than half the commercial demos I've been pitched — server-side pricing, order snapshots, and the 86-in-cart edge are things vendors get wrong at $300/month. But I would not run a Friday on it as written: no new-order alert (a silent queue screen is a dead queue screen), no store hours (I'd walk in at 6am to twelve orders placed at 2am), no undo on state advances, and no way to 86 guacamole without 86'ing every burrito. Those four gaps are all week-one kills, and all four fit inside the existing scope.

### Change log (v1 → v2)

| Change | Source | Where it landed |
|---|---|---|
| Daily order number + required name + optional phone + order-level note | PO + OPS | P0-8 |
| Explicit tax line (flat configurable rate, snapshotted) | PO | P0-9, P0-2 |
| Idempotent placement (double-tap = one order) | PO | P0-10 |
| Kitchen ticket content spec (negations emphasized, qty prominent, lookup) | PO + OPS | P0-11 |
| New-order alert: chime + flash until acknowledged; ack = `accepted` | OPS | P0-12, P0-4, P0-5 |
| Store hours + closed-today override + pre-close cutoff | OPS (PO would defer; operator won) | P0-6 |
| Modifier-option-level 86 | OPS (PO had deferred it) | P0-6, P0-3 |
| Modifier intensity levels (none/light/regular/extra) | OPS | P0-1 |
| `abandoned` terminal state + ready-order aging | OPS | P0-4, P1-1, P1-6 |
| 5-second undo on state advances | OPS | P0-4 |
| Cancel = preset reason + mock refund + customer-visible view | PO + OPS | P0-4 |
| Price-change-in-cart reconfirmation (no silent repricing) | PO | P0-3 |
| Notes cap (140 chars) + quantity cap (default 20) | PO | P0-3 |
| One-level modifier nesting limit stated | PO | P0-1 |
| Server-issued polling cursor (never client clock); background-tab pause; poll-stop on terminal states | PO + OPS | P0-5 |
| Auto-pause threshold requirement (story 10 previously had no matching requirement) | PO | P0-6 |
| Honest range estimates; no estimate while paused | OPS + PO | P0-7 |
| Safe menu editing (price confirm, shared-group warning, phone viewport) | OPS | P0-13 |
| Restaurant timezone for reports and order-number reset | PO | P1-1, P0-8 |
| Kitchen tap targets ≥48px, arm's-length legibility | PO + OPS | P0-4 |
| Status-link hardening + terminal-state rendering | PO | P1-5 |
| Prep-weight throttling/estimates | OPS | P1-7 (count-based ships in P0) |
| Payment-state field, unpaid flagged on kitchen card | PO (open question) + OPS | P1-8 |
| Rush simulation must include the ugly cases | OPS | Success Metrics |
| Future list: reorder, tips, printer, real SMS, station routing, prepay, catering | PO + OPS | P2 |

### Deliberately rejected

- **Breaking any v1 non-goal** (real payments, delivery, loyalty, POS hardware, multi-location) — both reviewers respected the learning scope; their cases for these live in P2 with rationale.
- **Full prep-weight model in P0** (OPS wanted it) — count-based throttling ships in P0-6; weight is P1-7. The estimate is honest about being rough (P0-7's range rule) until then.
- **Order-level "business day" boundary for number resets** — midnight restaurant-time is the v1 simplification, recorded in Open Questions.
