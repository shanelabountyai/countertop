# PRD: The Menu Under Pressure — 86s that say what they hit, and a menu that knows what time it is

**Sample business:** "Firebird Kitchen" at 12:40pm, out of guacamole, with the fryer down and the 4pm changeover coming
**Status:** Draft v1 — derived from the 2026-09-01 evaluations. Every requirement traces to a numbered finding in `review-dx.md`, `review-ops.md` or `review-systems.md`; the trace is named inline.
**Relationship to the master PRD:** extends P0-6 (availability at two grains) and P0-13 (safe menu editing). It does **not** re-open C-012's decision that an 86 on a shared option is an 86 everywhere, nor C-015's decision that the editor edits but does not author.
**Consensus:** all three evaluators, from three different angles — the screen, the shift, and the schema.

---

## Problem Statement

The menu has two editors: a calm one and a panicked one. The calm one is careful. The panicked one is not, and it is the one used during service.

**12:40pm.** The kitchen runs out of guacamole. A cook opens `/kitchen/availability`, scrolls a page that is 25 item rows plus every option of every group with **no search box** — while the queue one tap away has one — finds "Guacamole" under Add-ons and taps. She has just 86'd guac on the burrito, the bowl, the California burrito and the loaded nachos. Correct, because it is one ingredient. But she has **no idea she did it**, and nobody will until a customer asks. The between-rush menu editor *does* warn — "editing a shared modifier group names every item it touches" is an e2e test — so the safe-edit discipline of P0-13 exists on the calm screen and is absent on the panicked one. The reverse case is worse: an option reused as a menu-structure device gets 86'd across items that never needed it, and orders stop for food that is on the shelf. *(DX 7, and the WRITEUP's own C-012 caveat names this as "the cheaper half")*

**6:38pm.** The fryer goes down. Every churro, every chip order and the loaded nachos are dead — six menu rows across one screenshot alone. The choices are: tap through the availability board six times one-handed while the pass backs up, or hit "Pause new orders", type "Fryer is down until 2" and stop selling burritos too. There is nothing in between, and the estimate keeps quoting the same range to everyone because `openWeight` sums the whole kitchen and knows nothing about stations. *(OPS 7)*

**4:00pm, every single day.** The lunch-to-dinner switchover is the most common menu operation in fast casual and it is not modelled. `MenuItem`, `ModifierGroup` and `ModifierOption` have no `validFrom`/`validTo`, no daypart, no draft/published distinction, no version. So a manager does it by hand: 86'ing eleven lunch items and un-86'ing nine dinner ones from a phone, at 4pm, during the changeover, one tap at a time, with no batch and no undo. The first time it happens at 4:20 instead of 4:00, twenty minutes of customers order lunch items the line has already broken down. The first time somebody forgets to reverse it, the shop opens at 11am with the dinner menu live. Same shape for the annual price increase: there is no way to stage it, so it is typed live during service. *(SYS 11)*

## Users and the moment of use

- **A cook, mid-rush, one-handed, on a phone or a greasy tablet**, doing the fastest destructive operation in the product. Everything in P0 is judged against that posture.
- **A manager at 3:40pm**, staging a change they want to take effect at 4:00 and not one minute earlier.
- **A manager on a Sunday**, staging Monday's price increase without typing it during Monday's lunch.

## Requirements

### Must-Have (P0)

**P0-1: An 86 names what it will hit, before the tap** *(DX 7)*
- [ ] Every option row on `/kitchen/availability` names the items it affects: "Used on: Burrito, Burrito bowl, California burrito, Loaded nachos"
- [ ] The affected-item list is visible **before** the toggle, not in a confirmation after it — the panicked screen gets the same courtesy P0-13 gave the calm one
- [ ] Above a threshold count the list truncates with a count ("+3 more") but never hides the fact that it is more than one item
- [ ] `ItemModifierGroup` already holds the join and `loadMenu()` already returns it: **no migration, no new query**
- [ ] Test: an option used on four items shows all four names on the availability board without a tap; an option used on one shows one

**P0-2: The availability board can be searched** *(DX 7)*
- [ ] The same GET search box the queue has, filtering items and options by name, on the page that is longer than the queue and used under more pressure
- [ ] Search matches option names as well as item names — "guac" must find the option, which is the thing being 86'd
- [ ] Test: with the seeded 25-item menu, typing "guac" narrows to the guacamole option and the items carrying it

**P0-3: Kill a category in one action** *(OPS 7)*
- [ ] Multi-select on the availability board, plus a one-action **category-level 86** — "kill everything fried" is one operation, not six taps
- [ ] The action names every item and option it will affect before it applies, per P0-1, and reports what it did after
- [ ] It is reversible by the same mechanism (one action restores what one action killed), and the restore names the same list
- [ ] Nothing about the underlying model changes: this is a batch over the existing per-item and per-option toggles, so an 86 is still exactly what it is today
- [ ] Test: 86 the "Fried" category with six affected rows; assert all six render "sold out" on `/menu`, that an open cart holding one is flagged at checkout, and that placed orders are untouched

**P0-4: The 86 still reaches all three surfaces, in bulk** *(DX 7, OPS 7 — and the CLAUDE.md trap, asserted)*
- [ ] A bulk 86 propagates to the same three surfaces a single 86 does: the menu render ("sold out", never hidden), open carts (flagged at checkout), and **never** placed orders
- [ ] The existing single-86 propagation tests are extended to the bulk path rather than duplicated
- [ ] Test: the C-048 forced server-side submit case, run against a bulk 86 — a client that bypasses the UI still cannot place an order containing a bulk-86'd option

### Nice-to-Have (P1)

- **P1-1: Dayparts — an item that knows what time it is** *(SYS 11)* — an item carries zero or more windows (`16:00–21:00`), evaluated by the **existing** `validateComposition` / `restaurantClock` pair. No new decision point: a third input to the one orderability function, which means all three call sites get the answer for free. A daypart is a *schedule*, distinct from an 86, which is a human saying "we ran out" — and the two must never collapse into one boolean, because the WRITEUP's C-012 decision that 86s never restore themselves overnight depends on an 86 being a human fact.
- **P1-2: Effective-dated price changes** *(SYS 11)* — a price change staged with a start instant, applied by the clock rather than by a manager typing during lunch. The confirm-on-save diff (C-015/C-026) applies to the staged value the same way it applies to a live one.
- **P1-3: Stations** *(OPS 7)* — a station on each item, `openWeight` summed per station, and the estimate reading the busiest one, so sixteen points of fryer work stops looking like sixteen points spread across three stations. This is the real version of P0-3's cheap version and it is L with a migration.

## Non-Goals

- **Per-item override of a shared option's availability.** Recorded caveat C-012: an 86 on a shared option is an 86 everywhere. P0-1 delivers the *warning* that caveat itself names as the cheaper half; it does not change the model.
- **86s restoring themselves overnight.** Recorded caveat C-012, deliberate, and the safe direction. P1-1's dayparts are a schedule and explicitly not a self-restoring 86.
- **Authoring the menu.** Recorded caveat C-015: the editor edits, it does not add, remove or reorder items. A seasonal special is still a SQL job.
- **Split lunch/dinner *opening hours*.** Recorded caveat C-011 — one opening window per day, with a `closeMinute > openMinute` CHECK deliberately foreclosing overnight service. P1-1 is about which *items* are orderable, not about when the door is open. These are two different gates and must not be conflated.
- **Station routing / expo split screens.** P2 in the master PRD. P1-3 adds a station *attribute* for weight and estimates; it does not split the queue into station views.
- **Concurrent-edit resolution.** C-015 records last-write-wins for two managers on stale panels. Unchanged.
- **A draft/publish workflow for the whole menu.** P1-2 stages a price; it does not build a staging environment for the menu.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `MenuItem`, `ModifierOption`, `ItemModifierGroup` | **none** for all of P0. The join exists, `loadMenu()` already returns it, and the bulk action writes the same `available` booleans a single tap writes | none |
| `MenuItem` (P1-1) | a daypart window set — a child table `MenuItemWindow(itemId, dayOfWeek, startMinute, endMinute)` rather than columns, because an item can have more than one window | **yes, hand-written** — a CHECK that `endMinute > startMinute`, mirroring the `StoreHours` discipline C-023 established, and a unique on `(itemId, dayOfWeek, startMinute)` |
| `MenuItem`, `ModifierOption` (P1-2) | a staged price with an effective instant — a child table, not a nullable column pair, so more than one change can be queued | **yes, hand-written** |
| `MenuItem` (P1-3) | `stationId` / `station` enum, plus per-station weight aggregation | **yes** |
| `Order`, `OrderLine`, `OrderLineOption` | **never.** Nothing in this PRD writes to a snapshot table | none |

## Invariant impact

1. **Snapshot rule — untouched, and must stay that way.** Everything here happens on the live menu. The one risk P1-1 introduces is a reader thinking "an item outside its daypart should not render on an old receipt" — it must. A placed order's lines are copies; a daypart is a live-menu fact and is invisible to them. The existing snapshot regression test is extended with a daypart case: put an item outside its window, assert the placed order's receipt is byte-identical.
2. **Server is the price authority — touched by P1-2.** A staged price is a server-side fact resolved at cart-add and again at placement, by the same `priceLine` call. The client never sees or sends the effective date. A price that flips between a cart-add and a placement is the *existing* price-change path (old → new, explicit confirm, C-015/C-026) — staging must route into that path, not around it.
3. **One status module — untouched.**
4. **One orderability function — touched, and this is the load-bearing constraint.** The daypart check goes **inside** `validateComposition`, as a third input beside item availability and option availability, taking `now` as a parameter like everything else in `packages/core`. It must not become a fourth call site with its own answer, and the menu render, cart validation and placement must all get it without asking for it. The P1-1 test is explicitly written against all three call sites: an item with a 16:00–21:00 window is refused at a frozen 15:59 and accepted at 16:01, on the menu view, on cart validation and at placement.
5. **Idempotent placement — untouched.**

**Time:** the daypart window is minutes-since-midnight in the restaurant's configured timezone, evaluated through `restaurantClock`, never UTC and never the process timezone. The lint bans stay on. The TZ×2 CI run is the gate.

## Acceptance criteria

- An option used on four items renders all four item names on `/kitchen/availability` before any tap; an option used on one renders one.
- Typing "guac" into the availability search narrows the page to the guacamole option and the items carrying it, with the affected-item list still visible.
- 86'ing a category with six affected rows in one action: all six render "sold out" (not hidden) on `/menu`; a cart holding one is flagged at checkout with the fix-or-remove path; a forced server-side submit is refused; every already-placed order renders byte-identical.
- Restoring that category in one action returns exactly the six rows that were killed and nothing else.
- *(P1-1)* An item with a 16:00–21:00 Friday window is refused by `validateComposition` at a frozen Friday 15:59 and accepted at 16:01, asserted at all three call sites, and identically under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
- *(P1-1)* An order placed at 16:30 renders identically at 21:30 when the item is outside its window — snapshot regression, byte-identical.
- *(P1-2)* A price staged for Monday 00:00 does not affect Sunday's cart-add, does affect Monday's, and a cart that straddles the boundary hits the existing old → new confirm rather than repricing silently.

## Open Questions

- **(Ops)** Is category-level 86 the right grain for "the fryer is down", or is the real grain a **station**? The operator asked for the cheap version first and named stations as the real version. A category is a menu-organisation concept and may not map to equipment at all — "Sides" contains fried and non-fried things. **If the answer is stations, P0-3 is the wrong shape and should be built as a station attribute from the start.**
- **(Product)** Do dayparts and 86s share a column or stay separate? Sharing is one boolean and is tempting. Separating is the only way the C-012 decision ("86s never restore themselves overnight") survives contact with a schedule that restores things by design. The evaluators did not address this; it is the design decision P1-1 turns on.
- **(Ops)** When a daypart closes on an item that is in someone's open cart, is that the 86 path (flag at checkout, fix or remove) or something gentler? The 86 path is honest and already built. It is also a customer being told at 16:01 that the thing they added at 15:58 is gone.
- **(Builder)** Should the bulk 86 write one event per affected row or one event for the batch? Per-row is queryable and matches the existing model; per-batch is what a human would want to read back on the report.

## Phasing — one item per session

- **C-071 — The 86 board names what it hits** — P0-1. No migration, no new query; the join is already loaded. The single cheapest item in this document and the one the WRITEUP has been asking for since C-012.
- **C-072 — The 86 board can be searched** — P0-2, the same GET search the queue already has.
- **C-073 — Kill a category in one action** — P0-3 and P0-4 together, including extending the propagation tests and the forced-submit case to the bulk path.
- **C-074 — An item that knows what time it is** — P1-1, the daypart child table and the third input to `validateComposition`, with the all-three-call-sites test and the TZ×2 run. Gated on the shared-column Open Question.
- **C-075 — A price you can stage** — P1-2, effective-dated price changes routed through the existing old → new confirm.
- **C-076 — Stations** — P1-3, or the written decision not to. Gated on the first Open Question.
