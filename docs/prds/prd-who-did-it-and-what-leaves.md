# PRD: Who Did It, And What Leaves The Building — attribution, observability, retention, and the integration seam

**Sample business:** "Firebird Kitchen" with a drawer $60 short on a Saturday, a customer at the counter at 7:10pm holding a confirmation screen for an order nobody can find, and an accountant who wants March
**Status:** Draft v1 — derived from the 2026-09-01 evaluations. Every requirement traces to a numbered finding in `review-ops.md` or `review-systems.md`; the trace is named inline.
**Relationship to the master PRD:** extends C-037 (staff auth) and P0-5's cursor design. It disputes the *stated reason* in one Non-Goal ("POS/printer integration — hardware integration is config, not logic") without disputing the Non-Goal itself.
**Consensus:** the operator and the systems reviewer independently landed on staff identity, from a coaching conversation and from a cash drawer respectively.

---

## Problem Statement

This codebase built a Postgres trigger to protect an append-only event log, and then made it unable to answer the three questions it exists to answer.

**Saturday.** The drawer is **$60 short**. Six orders were marked *Collected — mark paid* that shift. The event log can tell you the orders moved through the queue and cannot tell you who marked any of them paid, or when, because `collectPayment` does `prisma.order.updateMany(...)` and writes no event at all. Every staff-written event carries `actor: 'staff'` as a literal string. Meanwhile the passcode was shared with a delivery driver in March, has not rotated since, and rotating it signs out every tablet at once, so nobody rotates it. *(SYS 8, OPS 10)*

The same hole answers three other questions with silence: who advanced `#010` twice, who closed out Nate as a no-show, who comped the torta. That turns every coaching conversation into "someone did this" and every discrepancy into an argument — which is exactly what a log is supposed to prevent. *(OPS 10)*

**7:10pm.** A customer at the counter with a phone showing a confirmation screen. Staff search the queue by name and find nothing. There are exactly three possibilities — the order was never placed, it was placed and someone advanced it wrongly, or the page errored after the charge — and the product can distinguish **none** of them. There is not one `console.error`, logger call, or error-reporting dependency in `apps/web` or `packages`. A refused placement returns `{ ok: false, errors }` to the browser and writes nothing. A gate refusal — the pause that bounced eleven orders during the fryer outage — leaves no row anywhere. `placeOrder` throwing after 25 seq attempts surfaces as a Next.js error page and vanishes. The manager reprints and remakes the food, and the same failure recurs next Friday because nobody could name it. *(SYS 5)*

**Two more days that arrive on their own.** The restaurant buys the $200 impact printer the master PRD's own P2 list calls "the kitchen's seatbelt". The bridge needs "give me every order since ticket 4471, exactly once, in order, and let me re-ask after the printer jams". `queueCursor()` is a `count()` plus a max timestamp compared for equality — deliberately designed to say *that* something changed and never *what* — and `OrderEvent` has no monotonic sequence and no external id. So the bridge either polls the whole queue and de-duplicates in its own memory (losing everything on restart), or someone adds a second cursor and the two disagree. And the accountant asks for March, and there is no month, no export, and no read-only credential. *(SYS 9)*

**And in a filing cabinet nobody opened:** `Order.customerName` and `customerPhone` are written at placement and never touched again. Nothing in the repo deletes or anonymizes an order. `searchOrderHistory` does a case-insensitive `contains` on the name across all history, unbounded in time. A customer asking for their data to be deleted can only be served by a hand-written SQL `UPDATE` that nobody has documented; a breach of the deployed database yields years of names and mobile numbers with purchase histories, collected for a notification the product never sent. *(SYS 7)*

## Users and the moment of use

- **The GM on Saturday night**, $60 short, wanting a name and a time.
- **The manager at 7:10pm**, needing to distinguish three failures that currently look identical.
- **The builder next Friday**, trying to name a defect that produced no artifact.
- **The customer who emails asking to be forgotten**, and the person who has to comply.
- **Whoever writes the printer bridge**, who needs a durable, ordered, replayable stream.

## Requirements

### Must-Have (P0)

**P0-1: When it fails, there is something to look at** *(SYS 5)*
- [ ] A structured server-side log line on **every** placement outcome: success, each refusal reason, each throw — carrying the **idempotency key as the correlation id**, the failure class, and the instant
- [ ] Every `GateReason` refusal is logged and countable, so "the pause bounced eleven orders during the fryer outage" is a number rather than a memory
- [ ] `priceLine`'s throw on an unknown id (today: no handler, no log) is caught at the boundary and logged with the ids involved
- [ ] The `total_mismatch` event survives a placement that also fails validation — today it is only persisted if the surrounding write succeeds, so a tampered request that also fails validation is never recorded anywhere
- [ ] An error reporter is wired to the deployment (a small dependency, or the platform's own — this is not a place to hand-roll)
- [ ] No customer name, phone or status token appears in any log line. Correlation is by idempotency key and order id
- [ ] Test: force a placement throw and assert exactly one log line carrying the idempotency key and the failure class; assert each `GateReason` refusal produces a counted line

**P0-2: A name on the row** *(OPS 10, SYS 8)*
- [ ] Named staff identities behind the **existing** shared passcode session — four-digit PINs against a small `StaffMember` table. Not accounts, not roles, not a user table with permissions. Just a name on each row
- [ ] `OrderEvent` carries the identity alongside the existing `EventActor` enum, which keeps its `customer | staff | system` meaning — the enum answers *what kind of actor*, the new column answers *which one*
- [ ] Every staff-written event gets it: transitions, reverts, notes, payments, adjustments
- [ ] The passcode session is unchanged and still fails closed when `STAFF_PASSCODE` is unset; the PIN is a stamp on a write, not a second auth boundary
- [ ] Existing rows keep `actor: 'staff'` with a null identity — an honest "we did not record this", never a backfilled guess
- [ ] Test: two PINs, two advances, assert two events with different identities; assert an event written before the migration reads as unattributed rather than as anyone

**P0-3: A payment is attributed and timestamped** *(SYS 8's immediate half, OPS 10)*
- [ ] `collectPayment` writes an event. This is the smaller, earlier half of `prd-money-that-reconciles.md`'s P0-1 and lands here **if that PRD has not landed first** — the *when* must be recorded before the *who*, and neither should wait on the other
- [ ] Test: mark an order paid, assert an event exists with an instant, and that the instant is queryable by business day

**P0-4: The customer can be forgotten** *(SYS 7)*
- [x] A documented retention window with a job that nulls `customerName`, `customerPhone` and `orderNote` on orders past it, leaving `seq`, money, lines and events intact so every report is unaffected. **Shipped at C-091 with a FOURTH column, `OrderLine.note`** — the same free-text box one level down, and a forget that leaves it behind is a forget that reads complete on the header and is not
- [x] A staff-invocable "forget this customer" doing the same for one order, from the staff receipt. Behind a URL confirm, and it shares ONE write with the sweep so the two cannot drift
- [x] The procedure is written down in the repo, because an undocumented capability is one nobody uses when the email arrives. `docs/RETENTION.md`, linked from the README
- [x] Test: run the sweep against a seeded old order and assert the report totals are **byte-identical** while the name is gone; assert `searchOrderHistory` no longer finds it by name

### Nice-to-Have (P1)

- **P1-1: An ordered, replayable event feed** *(SYS 9)* — a monotonically increasing `seq BIGSERIAL` on `OrderEvent` and a `GET /api/events?after=N` returning ordered events. This is the substrate a printer or KDS bridge needs and the master PRD's Non-Goal reason ("hardware integration is config, not logic") is the sentence the systems reviewer disputes: the hard part of that integration is a durable ordered stream, and it does not exist. The existing `/api/updates` cursor is **not** replaced — it is deliberately a change *tip*, and the two answer different questions.
- **P1-2: Read-only export** *(SYS 9)* — the CSV half lands in `prd-reports-that-decide.md`; what belongs here is that an export is a boundary crossing and gets the same no-PII-by-default treatment as a log line, with the name column opt-in and logged.
- **P1-3: The multi-location widening plan, written down** *(SYS 12)* — not building it. Recording, next to the singleton CHECK in the schema, exactly which constraints widen and in which order: drop the `RestaurantSettings` singleton CHECK, re-key `StoreHours` to `(locationId, dayOfWeek)`, widen `@@unique([businessDay, seq])` to `(locationId, businessDay, seq)`, decide shared-vs-copied menu. So the migration is a written plan rather than a discovery, and the `(businessDay, seq)` collision on location B's first order cannot be the way anyone learns about it.
- **P1-4: Passcode rotation that does not sign out every tablet at once** *(SYS 8)* — the reason nobody rotates.

### Editorially added

**E-1: The idempotency key gets an entropy floor** *(this is defect **D3**'s fix and belongs in the defects list, not here.)* What belongs in this PRD is the requirement *after* the fix: the placement replay is bound to the session that placed it, so a valid key from one session cannot resolve another session's order even if the key is guessable. Listed here because the format check alone is a mitigation and the binding is the fix, and the two are separate sessions of work. Traces to SYS 6.

**E-2: `MAX_SEQ_ATTEMPTS`'s justification is stale.** The systems reviewer notes it in passing inside the invariants section rather than as a numbered finding: the constant reasons from the P0-6 throttle bounding concurrency, but the throttle counts *open* weight and `ready` orders are `open: false`, so a queue full of ready-for-pickup orders bounds nothing. The depth is still almost certainly ample; the stated argument no longer supports it. Editorially added because a comment that justifies a safety constant with a reason that has stopped being true is worse than no comment. One-line fix, one-line test.

## Non-Goals

- **Roles and permissions.** P0-2 is a stamp, not an authorization model. Nobody gets a different set of buttons; the shared passcode remains the boundary.
- **Per-cook accounts, password resets, or an identity provider.** The WRITEUP records per-cook accounts as "a different project" and this deliberately stops short of it.
- **Replacing `/api/updates`.** P1-1 adds a second endpoint answering a different question. The tip cursor stays exactly as designed.
- **Building the printer or KDS bridge.** Master PRD Non-Goal plus P2. P1-1 builds the substrate and nothing that plugs into it.
- **Multi-location.** Non-Goal / P2. P1-3 writes the plan, in a comment, and builds nothing.
- **A public API, API keys, or webhooks out.** `GET /api/events` sits behind the same staff boundary as everything else in `/kitchen`.
- **Log aggregation infrastructure.** Structured lines to the platform's own sink; not a stack.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `StaffMember` (new) | `id`, `name`, `pin` (hashed — a PIN is a credential even at four digits), `active` | **yes, hand-written** — unique on the PIN hash among active members, so two people cannot share a stamp |
| `OrderEvent` | `staffMemberId String?` with `onDelete: Restrict` — an event's attribution must outlive an employment | **yes**, additive nullable, no backfill |
| `OrderEvent` | `seq BigInt @default(autoincrement())` (P1-1) — backfillable in event order | **yes, hand-written**, and it must not disturb the append-only trigger |
| `OrderEventKind` (enum) | `payment` (P0-3) if `prd-money-that-reconciles.md` has not already added it | **yes, hand-written**, additive |
| `Order` | `customerName` is `VarChar(40)` **NOT NULL**, so P0-4 either writes a placeholder or the column becomes nullable | **yes if nullable** — and the placeholder is probably the better answer, because a null name breaks every receipt render |
| `RestaurantSettings` | a retention-window setting, with its CHECK | **yes, hand-written** |
| Schema comments only (P1-3) | the multi-location widening plan | none |

The append-only trigger on `OrderEvent` must survive every one of these. A new nullable column and a `BIGSERIAL` are both compatible with an insert-only table; nothing here adds an UPDATE path.

## Invariant impact

1. **Snapshot rule — touched by P0-4, and this is the sharp edge.** The retention sweep **UPDATEs a snapshot table**, which is the one thing this project's rules make hardest. It holds only because of what it touches: `customerName`, `customerPhone` and `orderNote` are identity, not composition and not money. Every column the receipt's arithmetic depends on — line names, option names, deltas, subtotal, tax, total, `taxRatePpm`, `prepWeight`, the quote — is untouched. The acceptance test is written to prove exactly that: report totals byte-identical, receipt arithmetic byte-identical, name gone. If that test cannot be made to pass, the sweep is wrong, not the test.
2. **Server is the price authority — untouched.** Nothing here computes money. P0-1's logging must not log a client-supplied total as if it were authoritative; it logs the mismatch, which is already the correct framing.
3. **One status module — untouched.** P1-1's event feed serializes what the log already holds; it must not restate a status list in SQL. The systems review already flags `packages/db/report.ts:94` doing exactly that without a paired test, and a second SQL status restatement in an events endpoint would be the same defect twice.
4. **One orderability function — untouched.**
5. **Idempotent placement — touched, and E-1 is the point.** The write side holds and stays holding. The read side gains a binding: the replay returns the existing order only when the presenting session matches the placing session, and otherwise refuses. The refusal must be a clean, named refusal — not a 500, and not silence — because a legitimate retry from a lost cookie will hit it.

**Time:** every log line and every event carries a `timestamptz` instant; the retention window is expressed in days and evaluated against the restaurant's business day, not against UTC. Nothing in `packages/core` reads the system clock.

## Acceptance criteria

- Forcing a placement throw produces exactly one structured log line carrying the idempotency key and a failure class; no log line in the suite contains a customer name, phone or status token.
- Each distinct `GateReason` refusal produces one counted line; eleven bounced orders are eleven lines.
- A `total_mismatch` on a request that *also* fails validation is recorded — asserted by a test that does both at once.
- Two staff PINs producing two advances yield two events with different identities; an event written before the migration reads as unattributed.
- Marking an order paid produces an event with an instant that is queryable by business day.
- The retention sweep over a seeded old order: report totals byte-identical, receipt arithmetic byte-identical, name and phone gone, `searchOrderHistory` no longer matching it by name.
- *(P1-1)* Consuming `GET /api/events?after=N` twice from the same cursor returns identical, ordered, complete output; a consumer that restarts from its last `seq` loses nothing and repeats nothing.
- *(E-1)* Two sessions presenting the same idempotency key: the second gets a named refusal, not the first session's confirmation.

## Open Questions

- **(Product — blocking P0-2's sequencing)** Do the comp and adjustment controls in `prd-money-that-reconciles.md` wait for staff identity? The systems reviewer says a cash control cannot ship anonymously; the operator says the same thing from the drawer's side. If the answer is yes, P0-2 moves ahead of that PRD's P0-3 and this document is no longer ranked last.
- **(Ops)** What is the retention window? Ninety days serves the "what did I order last week" dispute C-046 exists for. A year serves nothing this product does. Somebody has to name a number and be willing to defend it to a customer.
- **(Product)** Does a nulled `customerName` become a placeholder ("Removed") or does the column go nullable? The placeholder keeps every receipt render working and is a lie in the data; the null is honest and touches every reader.
- **(Builder)** Is `/api/events` worth building with no consumer? The reviewer's case is that the substrate is the hard part and the Non-Goal's stated reason is wrong. The counter-case is YAGNI, and a feed with no consumer is a feed with no test of whether it is the right shape.
- **(Ops)** Four-digit PINs on a shared tablet are shoulder-surfable and get shared like the passcode did. Is a name on the row worth an attribution that a determined person can fake? The reviewer's implicit answer is yes — an imperfect name beats "someone". Confirm it before building.

## Phasing — one item per session

- **C-084 — When it fails, there is something to look at** — P0-1, the structured placement and gate logging with the idempotency key as the correlation id, the `priceLine` throw handler, the `total_mismatch` persistence fix, and the no-PII assertion. Cheapest and highest-value item in this document; it should not wait for the rest.
- **C-085 — A payment leaves a timestamped record** — P0-3, if `prd-money-that-reconciles.md`'s C-063 has not already landed it. The *when* before the *who*.
- **C-086 — A name on the row** — P0-2, `StaffMember`, PINs, the identity column on `OrderEvent`, no backfill.
- **C-091 — The customer can be forgotten** — P0-4, the retention sweep and the per-order forget, with the byte-identical report assertion as the gate. *(Renumbered from C-087 on 2026-09-02: the brand item shipped under that number first. The number is bookkeeping; the dependency is not — `prd-loyalty.md` P0-5 is blocked on this item whatever it is called.)*
- **C-088 — The replay is bound to its session** — E-1, after defect D3's format check has landed.
- **C-089 — An ordered, replayable event feed** — P1-1, `seq BIGSERIAL` and `GET /api/events?after=N`, gated on its Open Question.
- **C-090 — The widening plan, written into the schema** — P1-3, plus E-2's one-line correction to the `MAX_SEQ_ATTEMPTS` comment and its test. A documentation session with two small code changes riding along.
