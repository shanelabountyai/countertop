# PRD: Money That Reconciles — comps, adjustments, and a payment that leaves a record

**Sample business:** "Firebird Kitchen" at 6:52pm, with a remade torta on the pass and $13.75 in the till that belongs to nobody
**Status:** Draft v1 — derived from the 2026-09-01 evaluations. Every requirement traces to a numbered finding in `review-ops.md` or `review-systems.md`; the trace is named inline.
**Relationship to the master PRD:** extends P1-8 (`C-038`) and P0-4's cancel/refund branch. It does **not** breach the "real payment processing" Non-Goal — the provider stays mocked behind its interface. What this PRD adds is the *shape* of the record, which both money-facing evaluators independently called the weakest boundary in the product.
**Consensus:** the operator and the systems reviewer arrived at the same 6:52pm counter transaction from opposite directions, neither having read the other.

---

## Problem Statement

**6:52pm.** Ivy Castellanos is back at the counter with `#012` — torta, carnitas, extra tortilla, onions — and she ordered it with onions **off**. She also typed "cut it in half please" and got neither. Bea remakes it. Now: the till has $13.75 in it that is being given back or comped; the report will count `#012` as one torta sold at full price; the attach rate will record "Torta / Toppings: Onions — attached"; and the only record that any of it happened is Bea telling the GM at close. Multiply by four on a bad Friday and Monday's numbers are fiction.

The system offers exactly nothing here. `cancelled` is unreachable from `ready` by design — correct, cooked food is not a cancellation — and unreachable from `picked_up` at all. There is no comp, no void, no partial adjustment, no remake link, no discount, and `Order.subtotalCents/taxCents/totalCents` are written once and never updated by any code path. *(OPS 2)*

**Same night, 7:40pm.** A customer prepaid **$34.20** for a family order, got stuck on the freeway, never came. At 8:15 staff close it out as `abandoned` — the correct operational action, and the one the aging flag pushes them toward. The card was charged; nothing in Countertop records that money exists; `abandon` writes **no refund event at all**; and the order contributes $0.00 to the day's revenue and $0.00 to the day's tax because the report skips `no_show` before any bucket is touched. *(SYS 1)*

**Tuesday.** The card batch settles for **$2,847.15** and the owner asks which orders that covers. The only answer available is "orders whose `paymentState` column currently reads `paid`" — a *current* fact with no instant. An order collected at 11:58pm Monday and one at 12:02am Tuesday are indistinguishable. An order marked paid by mistake and never corrected is indistinguishable from one actually charged. In March a chargeback arrives citing a processor transaction id that appears nowhere in this database. *(SYS 4)*

**And the day the real processor is wired in**, the call goes where the boolean was. A cancel at 12:14pm writes `paymentState: 'refunded'` inside the same `$transaction` as the status change; the Stripe call times out at the gateway; the customer's status page says *Refunded*; the report drops the order entirely as `cancelled`; and the money is still on the processor until the customer calls back in nine days. The append-only trigger means the row cannot even be corrected — only contradicted by a later row nothing reads. *(SYS 2)*

## Users and the moment of use

- **The counter person / shift lead at 6:52pm**, deciding to make it right, with a customer in front of them and a line behind. Whatever this costs must fit in the same motion as handing over the remade food.
- **The GM on Sunday night**, asking what the comps cost this week.
- **The bookkeeper at month end**, needing the day to reconcile in both directions.
- **The developer wiring a real processor in six months**, who will put the network call exactly where the boolean is today.

## Requirements

### Must-Have (P0)

**P0-1: A payment is an event, not a column** *(SYS 4, SYS 8's immediate half)*
- [ ] `OrderEventKind` gains `payment`. Every payment state change writes one — the checkout path (`paidNow` at placement) *and* the counter path (`collectPayment`, which today writes no event at all)
- [ ] The event carries `at`, `actor`, `amountCents`, and a nullable `providerRef` for the day a real processor supplies one
- [ ] `Order.paymentState` remains and remains the fast read; it becomes a **derived cache of the event stream**, and a test asserts the two agree for every order in the seeded rush
- [ ] Test: mark an order paid at the counter, assert an event row exists with the staff actor, the instant and the amount; assert a settlement query bounded on the previous business day excludes it

**P0-2: A balance, not a boolean** *(SYS 1, SYS 3)*
- [ ] Collected balance per order = `Σ captured − Σ refunded − Σ comped`, computed by one function in `packages/core` and read by every surface that shows money owed — the staff receipt, the queue's unpaid badge, and the report's outstanding list
- [ ] `canCollectPayment` (C-048's predicate, three readers) is rewritten against the balance rather than the enum, keeping its single-source discipline
- [ ] Money stays integer cents everywhere; the balance function takes and returns cents and has no float in it
- [ ] Test: a $34.20 order, captured in full then refunded $3.00, has a balance of 3120 and an unchanged `totalCents` of 3420

**P0-3: Making it right — comp, partial adjustment, and remake** *(OPS 2, SYS 1)*
- [x] An `adjustment` control on the staff receipt at `/kitchen/orders/[id]`, reachable for an order in **any** state including `picked_up` and `abandoned` — the states the current model has no money control for at all
- [x] Three kinds: **comp** (the whole order, zero to the customer), **partial** (an amount, in cents), and **remake** (which links to the original order id, so "we remade six tickets Friday" is a number)
- [x] Every adjustment carries an amount in cents, a reason from a short preset, and free text, and is written as an append-only event — it **never** updates `subtotalCents`, `taxCents` or `totalCents`
- [x] An adjustment larger than the order total is refused with a named reason, not clamped
- [x] The customer's status page shows an adjusted order honestly (it does not silently show the original total as if nothing happened) without exposing the internal reason text
- [x] Test: comp a `picked_up` $13.75 order; assert `totalCents` is still 1375, the balance is 0, the report's net sales drops by the comped amount, and the comps line shows one entry

**P0-4: A refund is attempted, then recorded — with a state for the attempt that failed** *(SYS 2)*
- [x] `PaymentState` (or the event stream that supersedes it) can express **requested**, **succeeded** and **failed** — today it can express only three terminal facts and none of them is "we tried"
- [x] The provider call is made **outside** the status transaction. The status change and the refund attempt are not one atomic write, because they are not one fact
- [x] A failed attempt surfaces on a staff-visible exceptions list and does **not** set the customer-facing "Refunded" copy
- [x] The refund attempt carries an idempotency key of its own, so a retry cannot double-refund
- [x] Test: stub a provider that throws; assert the order shows *refund pending*, appears on the exceptions list, and that `paymentState` is not `refunded`

**P0-5: A cooked order can be made whole without being cancelled** *(OPS 2, SYS 1)*
- [x] The state machine's refusal to cancel from `ready` and `picked_up` is **unchanged** — it is correct and both evaluators agree
- [x] Money is therefore decoupled from status: P0-3's adjustment is available in exactly the states where cancellation is refused, and the refusal message says so ("cooked food cannot be cancelled — comp or adjust it instead") rather than being a dead end
- [x] Test: attempt to cancel a `ready` order, assert the existing refusal by reason, and assert the refusal names the adjustment path

**P0-6: A refund that can be issued on purpose** *(added 2026-09-06 — the gap C-067 and C-068 both left behind)*
- [x] A refund control on the staff receipt taking an **amount in cents**, reachable in any state and in particular on `picked_up` and `abandoned` — the states cancellation cannot reach, which are exactly where this is needed
- [x] The amount is bounded by what the restaurant is actually **holding** (`orderBalance`'s `collectedCents`), recomputed at the attempt and never frozen at the ask
- [x] Over the bound is **refused with a named reason, never clamped** — the same discipline P0-3 set for the adjustment, and it applies twice: once where a person can see it, and again at the moment money leaves
- [x] It goes through `settleRefund`, which becomes a **third caller of one path** rather than a second implementation of the thing money leaves through
- [x] A **partial** refund leaves `paymentState` at `paid`, because `refunded` means every captured cent went back — the column is written from `derivePaymentState`, not compare-and-set to a literal
- [x] More than one refund per order is answerable: an attempt names its request, and a settled one cannot make an unsettled one read as sent
- [x] A mistaken adjustment is corrected by a **contradicting row** (`adjustment_reversed`), never a delete — the deferral C-065 and C-066 both recorded
- [x] `abandon` **offers** a refund rather than issuing one: a no-show is not automatically a refund, because the food was made (C-068's phasing line)
- [x] Test: comp a paid order, assert the balance reads zero owed and the full total still held; refund part of it and assert `paid` with the remainder held; refund the rest and assert `refunded`; two concurrent settles of one request produce exactly one `refund` row

### Nice-to-Have (P1)

- **P1-1: Auth at placement, capture at pickup** ✅ *(C-069)* *(SYS 1)* — the pickup-shaped answer: a no-show costs a void, not a refund. Hang capture on `ready → picked_up`. Still against the mock provider; the seam is what matters.
- **P1-2: Per-line tax, snapshotted** *(SYS 10)* — the seeded menu already has bottled drinks and bagged chips, which in most US states are taxed differently from the burrito beside them, so the product is already computing legally wrong tax on a real menu. The remediation is the expensive shape: `MenuItem.taxCategory`, plus `taxCents`/`taxRatePpm` **snapshotted per `OrderLine`**, with the order-level fields kept as the sum. A wrong backfill silently restates a filed tax period, which is why this is P1 with an Open Question rather than P0.
- **P1-3: A comps and adjustments line on the sales report** *(OPS 2)* — the reporting half; the tables land in `prd-reports-that-decide.md`, the events land here.

## Non-Goals

- **A real payment processor.** Master PRD Non-Goal, unchanged. Everything here runs against the mock provider behind its existing interface. What changes is that the interface is now shaped so a real call *can* fail.
- **Tips.** P2 in the master PRD, explicitly "a pure money-math add-on once real payments land".
- **Prepay-required as a no-show cure.** P2, reasoned about in the master PRD, and named there as the actual fix. P1-1's auth/capture is the seam it would use, not the feature.
- **Rewriting `totalCents` on an adjusted order.** Explicitly refused. The order's money is a snapshot; an adjustment is a second fact beside it. This is the snapshot rule and it is not negotiable here even though it makes the balance a computation rather than a column.
- **Changing which states can be cancelled.** `ready`/`picked_up` stay uncancellable.
- **Reconciling against a card processor's settlement file.** There is no real processor; the settlement *query shape* is built (P0-1), the import is not.
- **Attributing the comp to a named person.** The one place a restaurant genuinely cannot ship without attribution — and it is a hard dependency, see Open Questions. The identity work is `prd-who-did-it-and-what-leaves.md`.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `OrderEventKind` (enum) | `payment`, `adjustment`, and refund attempt states — the smallest version is `payment` + `adjustment` with the attempt state in `detail` | **yes, hand-written** — additive `ALTER TYPE ... ADD VALUE` |
| `OrderEvent` | `amountCents Int?` — a money column on the event, integer cents, nullable because most event kinds carry no amount. Plus a nullable `providerRef String?` | **yes, hand-written** — a CHECK that `amountCents` is non-null exactly for the money-bearing kinds is the constraint that makes this honest |
| `OrderEvent` | a nullable `relatedOrderId` for the remake link (P0-3), `onDelete: Restrict` | **yes**, additive |
| `PaymentState` (enum) | `refund_pending` / `refund_failed`, **or** the enum is demoted to a cache and the truth moves to the events. See the Open Question — this is a real fork | **yes**, either way |
| `Order` | no change to `subtotalCents` / `taxCents` / `totalCents`. They stay write-once | none |
| `OrderLine` (P1-2 only) | `taxCents`, `taxRatePpm` per line — **the snapshot table**, the expensive kind, needing a defensible backfill | **yes, hand-written**, and gated on the Open Question |

The append-only trigger already covers `OrderEvent` and must keep covering it: an adjustment is appended, a mistaken adjustment is contradicted by a reversing adjustment, and nothing is ever deleted.

## Invariant impact

1. **Snapshot rule — touched hard, and it is the reason this PRD is shaped the way it is.** The obvious design — "comp it, subtract from the total" — would mutate a snapshot column and is refused. `Order.totalCents` remains what the customer was charged at placement, forever; the adjustment is an appended fact and the balance is a computation. The snapshot regression test grows a case: comp an order, partially refund it, mutate every menu row it referenced, and assert the receipt's *line-level* rendering and its `subtotal/tax/total` are byte-identical to before.
2. **Server is the price authority — touched, and it extends.** An adjustment amount arrives from a client and must be validated server-side exactly as a cart total is: bounded by the order's own snapshotted total, in integer cents, refused (not clamped) when out of range. The client's number is input to a decision, never a value written blind.
3. **One status module — touched, and the discipline transfers.** `canCollectPayment` already lives in the state machine with three readers; P0-2 rewrites it against the balance and it stays there, with the same reader count. The adjustment's availability by status is likewise derived from `STATUS_FACTS`, not from a list of statuses on a page. If payment state grows its own small state machine, it lives in **one module** next to the order one — the same rule, applied to a second concept.
4. **One orderability function — untouched.**
5. **Idempotent placement — touched by extension.** P0-4's refund attempt carries its own idempotency key with a constraint behind it, for the same reason placement does: a retry must produce the same answer, not a second refund. The correctness never depends on the client not retrying.

**Money:** integer cents throughout, one rounding function, no exceptions. **Time:** every event carries a `timestamptz` instant; the settlement query buckets on the restaurant's business day, never UTC.

## Acceptance criteria

- Marking an order paid at the counter writes exactly one `payment` event with actor, instant and amount; a settlement query for the previous business day excludes an order collected at 00:02 today.
- For every order in the seeded rush, `paymentState` equals the state derived from that order's payment events.
- A $34.20 order captured in full and refunded $3.00 has balance 3120 and `totalCents` 3420 unchanged.
- Comping a `picked_up` $13.75 order leaves `totalCents` at 1375, sets the balance to 0, and produces one row in the comps list.
- An adjustment of $50.00 against a $13.75 order is refused by name; nothing is written.
- A stubbed provider that throws on refund leaves `paymentState` not equal to `refunded`, puts the order on the exceptions list, and leaves the customer-facing page not saying "Refunded".
- Two refund attempts with the same key produce one provider call and identical responses.
- Cancelling a `ready` order is still refused, and the refusal names the adjustment path.
- Abandoning a prepaid order leaves a non-zero balance and offers a refund; the report shows it as outstanding money, not as $0.00.
- Snapshot regression: comp + partial refund + full menu mutation leaves the receipt byte-identical.

## Open Questions

- **(RESOLVED 2026-09-01 — the event stream is the truth.)** `Order.paymentState` becomes a **derived cache** over the payment event stream, and a test asserts the two agree for every order in the seeded rush. *Why this way:* it is the only shape P0-2's balance arithmetic and P0-4's "we tried and it failed" can live in — an enum holds terminal facts and a refund attempt in flight is not one. The enum stays, and stays the fast read every existing surface already uses, so nothing is rewritten to gain the honest model. C-085 had already landed the events on both write paths, which made the fork cheaper to take than it looked when this was written. **Not re-opened.**
- **(RESOLVED 2026-09-01 — agreed in writing: a comp is a record, not a charge.)** An adjustment is an append-only **record of a decision the counter made**. It moves no money, calls no processor, and never updates `subtotalCents`, `taxCents` or `totalCents`. The master PRD's Non-Goal ("no real payment processing") is therefore untouched — nothing here processes a payment — and P0-3 may ship. This is the sentence the question asked for; it exists so a later reader does not have to re-derive it. **Not re-opened.**
- **(RESOLVED 2026-09-01 — identity first.)** P0-3 waits. Staff identity (PRD 6 P0-2) is pulled forward ahead of this PRD, and no comp control ships until an event can name who wrote it. *Why this way:* it is the one thing here that cannot be retrofitted — every event written with `actor: 'staff'` in the meantime is anonymous permanently, and no backfill can invent the name. Both evaluators reached this from opposite directions, and C-048 has already put a money button behind a shared passcode. The typed-name middle option was rejected on this repo's own discipline: the constraint is the mechanism, and a typed name is the disabled-submit-button of accountability. **This reorders the set — PRD 6 is no longer last.** Not re-opened.
- **(RESOLVED 2026-09-06 — not now, and here is exactly what "later" costs.)** Per-line tax is **not built**; the migration shape is recorded normatively in `packages/db/prisma/schema.prisma` above `model OrderLine`, in five ordered steps. *Why this way:* the question framed the cost as the backfill being expensive, and the answer is stronger than that — **the backfill has no defensible answer at all**, for two reasons that hold independently. `OrderLine` is a snapshot table, and the only precedent for updating one (C-091's retention sweep) is legal exactly because it touches *who ordered* and never *what was sold*; per-line tax is entirely the second kind. And there is no input to backfill from: splitting March's single figure needs today's category assignments, which did not exist in March, and re-rounding per line does not reproduce the total actually charged because round-then-sum is not sum-then-round — so the output is a restated filed period tied to no receipt any customer holds. The recorded plan is therefore **forward-only by construction**: nullable columns, no backfill ever, `null` meaning "placed before per-line tax existed". The middle option was rejected on the same reasoning that rejected the typed name for comps — columns populated forward only, with no screen admitting that two eras of orders answer the same question differently, is a schema that lies quietly. Reviewed against the seeded menu rather than in the abstract: `Bottled water`, `Mexican Coke` and `Chips & salsa` are already on it, so the flat rate is legally wrong on a real menu and not merely coarse; what keeps it shippable is that it is *explainable*, the rate being snapshotted beside the money it produced. **Not re-opened** until a second jurisdiction, a filing export with a real consumer, or this shop being in a state where those three items are exempt. *(C-070.)*
- **(RESOLVED 2026-09-02 — a real second order, linked, and not counted.)** A `remake` creates a genuinely new order: new `(businessDay, seq)`, a real ticket that ages and advances, linked to the original by `OrderEvent.relatedOrderId`. It is comped in full at creation, and the report skips it. *Why this way:* the two directions the question named do not actually pull evenly. The kitchen's need is the product's founding one — a remake with no ticket is Bea remembering, which is the transcription failure this whole product exists to kill — while the report's need is satisfied by either shape. Taking the kitchen's side costs an order-creation path; taking the report's side costs the feature. The comp is what stops the counter being shown "$13.75 due" on a ticket nobody will be charged for, and it reuses C-065 rather than inventing a second zero-money concept. The exclusion from `sold`, units and attach rates is not a nicety: without it the remake inflates the exact numbers this PRD's opening scenario names as the bug — two tortas sold where one left the building, and an onions attach on an order that said NO onions. **Not re-opened.**

## Phasing — one item per session

- **C-063 — A payment leaves a record** — P0-1, the `payment` event kind on both write paths, plus the `paymentState`-agrees-with-events test. Lands after the Open Question above is answered.
- **C-064 — The balance** — P0-2, one function in `packages/core`, `canCollectPayment` rewritten against it, three readers unchanged.
- **C-065 — Making it right** — P0-3's comp and partial adjustment on the staff receipt, with the amount validated server-side and the snapshot columns provably untouched.
- **C-066 — The remake link** — the rest of P0-3: `relatedOrderId`, the kitchen ticket for the remake, and "we remade six tickets Friday" as a number.
- **C-067 — A refund that can fail** — P0-4, the provider call outside the transaction, the attempt states, the exceptions list, the refund idempotency key.
- **C-068 — Cooked food gets a way out** — P0-5, the refusal message that names the adjustment path. The abandon-offers-a-refund half was deliberately phased into C-071, which is where the control it offers was built.
- **C-071 — A refund that can be issued on purpose** — P0-6: the form, the bound, its refusal, the per-request refund model, the reversing adjustment, and the no-show's offer.
- **C-069 — Auth at placement, capture at pickup** ✅ — P1-1, against the mock provider. `authorization` / `capture` / `authorization_voided`, the settlement link with its unique index, and `authorizedCents` in the balance so a held card is neither collected nor owed.
- **C-070 — Per-line tax, or the written plan not to** ✅ — P1-2. The Open Question above was answered **not now**, so the item is the written plan: the normative five-step migration shape in `schema.prisma` above `model OrderLine`, cross-referenced from the three columns it names, plus the WRITEUP caveat stating why the backfill is forward-only by construction. No migration, no schema change. **This closes PRD 3.**
