# Countertop — the second-pass PRD set

Six PRDs and three defects, derived from three independent evaluations delivered 2026-09-01. A seventh PRD — `prd-loyalty.md` — was added afterwards and is **not** derived from those evaluations; it is a product-owner proposal, it re-opens a master-PRD Non-Goal, and it is ranked and labelled accordingly.

Nothing in this directory changes a decision the master PRD settled. Where an evaluator re-opened a Non-Goal or a resolved Open Question, it is named below under *Raised but not PRD'd* with the reason it stays closed. `prd-loyalty.md` is the one document that asks for a Non-Goal to be lifted rather than accepting it, and it says so in its own first blocking Open Question.

---

## How this was produced

Three evaluators read the shipped product independently, from three deliberately non-overlapping lenses, and none of them saw another's findings:

| Report | Lens | What they read |
|---|---|---|
| `review-dx.md` | **Digital experience lead** — the customer's screens and the staff's screens | the 14 captures in `docs/screenshots/`, the six customer routes and seven staff routes, the e2e test titles, WRITEUP's "The Screens" |
| `review-ops.md` | **Senior restaurant staffer / GM** — the shift, minute by minute | the queue under a real rush, the handoff, the shift change, the close; "would I run a Friday on this?" |
| `review-systems.md` | **Restaurant systems expert** — money, data, and integration boundaries | the schema, `packages/core`, `packages/db`, the invariants one by one, and what every downstream system a restaurant owns would need |

Thirty-six numbered findings, plus a handful of asides buried in the systems review's invariant audit.

**The ranking signal is consensus across lenses.** A finding two evaluators reached independently, from different evidence, is the strongest evidence available here that it is real and not a matter of taste. Three of the six evaluation-derived PRDs below exist because two or three lenses converged on the same ninety seconds of a Friday without coordinating. PRD 7 has no such backing, which is why it ranks where it does.

All three evaluators also independently confirmed that the **snapshot rule holds** — the systems reviewer could not construct a read path joining an order to a menu table, and the operator's phrasing was "a menu edit provably cannot touch a placed order." All three named the **end-to-end negation treatment** as the best thing in the product. Both are load-bearing and every PRD below is written to keep them true; the negation in particular must not be normalised into a grey chip by any redesign this set triggers.

---

## Confirmed defects — fix before building anything new

These are bugs in shipped behaviour, verified in the code. They are not PRDs, because a PRD for a bug is a category error. Each is one session.

### D1 — The advance button never names its target *(severity: highest)*

**Where:** `packages/core/orders/state-machine.ts:347` and `apps/web/app/kitchen/actions.ts:42`.

**The failure:** the state machine has an `unexpected_target` refusal built exactly for the stale-screen double-tap, and its own comment says *"the second tap names a target that is already behind, and is refused rather than skipping a state."* The guard reads `if (action.to !== undefined && action.to !== to)`. The only real caller passes `{ kind: 'advance', actor: 'staff' }` with **no `to`**, so the guard can never fire from the UI. The database's compare-and-set (`updateMany where: { id, status: current.status }`) catches two taps racing on the *same* read; it re-reads current status first, so a tap from a screen five seconds behind advances from wherever the order is *now*. With two screens open and a 5-second poll, the button labelled "Start cooking" will sometimes mark an order picked up: `#010` goes `ready → picked_up` in one tap, vanishes from both screens after the five-second undo, and the customer is told at the counter that her order was collected while the bag sits on the pass.

This is the same defect class as C-047 — the engine was right and the screen never asked.

**One-session fix:** the queue card posts the status it was rendered in; `advanceOrder(orderId, to)` passes it through to the engine as `action.to`. The refusal, its message and its reason already exist. Re-render on refusal so the operator sees the corrected board. Test: render a card at `preparing`, advance the order to `ready` out of band, then submit the stale card and assert `unexpected_target` by reason and that the order did not move. No migration.

### D2 — The sales report never reads `paymentState` *(severity: high)*

**Where:** `packages/db/report.ts` and `packages/core/orders/report.ts` — no reference to `paymentState` in either.

**The failure:** revenue is the sum of totals on orders whose `salesRole` is `sold`. C-038 made pay-at-pickup a real and common state (about a third of the seeded rush), and C-048 established that an order can be handed over and stay `unpaid` indefinitely — that is the entire reason the mark-paid control had to be added to the staff receipt. So the revenue total counts food nobody paid for. Sunday night the report says $478.55 for Friday and the till says $431, and no screen in the product reconciles the two. Six unpaid pickups on a busy Friday is normal.

The WRITEUP defends "revenue is what was charged, not collected" as a deliberate C-016 simplification, honest for a shop that takes payment at the counter. **Two items later that defence stopped holding**: the shop now has a durable record of who did not pay, and the report ignores it.

**One-session fix:** `loadReportOrders` selects `paymentState`; the report splits collected from outstanding and lists the unpaid orders by `seq`, name and amount. No migration. This is `prd-reports-that-decide.md`'s C-050 and it lands alone, before that PRD's features.

### D3 — The placement replay is a read handle with no entropy floor *(severity: moderate — a boundary defect, not a live break)*

**Where:** `apps/web/app/checkout/actions.ts:111` and `packages/db/placement.ts:122,159`.

**The failure:** `placeCartOrder` accepts **any non-empty string** as an idempotency key. `placeOrder` looks it up first, before anything else, and replays a hit through `ORDER_RECEIPT` — which is `include: { lines }` on `Order`, meaning every scalar column: `statusToken`, `customerName`, `customerPhone`, totals. So presenting a key is enough to receive a complete order and a permanent, non-expiring status link to it.

**Honest exploitability:** this is not a practical break today. The real browser client uses `crypto.randomUUID()` — 122 bits, unguessable — and that is the only thing making it safe. What *is* real is that the server enforces no entropy, no format and no session binding on a value that doubles as a read handle for a secret, and the seed and rush scripts in this repo already generate predictable keys (`seed-order-0`). The day a second client exists — a kiosk, a QR flow, a POS bridge, a retry wrapper — a well-meaning integrator writes `kiosk-2-0047`, and from that moment the read side of the replay is a leak. There is no test asserting a key from one session cannot resolve another session's order.

**One-session fix:** reject keys that are not UUIDs, at the action boundary, with a named refusal; regenerate the seed and rush scripts' keys as UUIDs. Test: a non-UUID key is refused; two sessions with the same UUID still produce one order and identical bodies. No migration. The *fix* — binding the replay to the placing session — is a second session and lives in `prd-who-did-it-and-what-leaves.md` as E-1, because a format check is a mitigation and the binding is the actual answer.

---

## The PRDs

**Ranking criterion: value ÷ cost, where value is set first by how many independent lenses raised the theme and second by the severity of the failure it prevents, and cost is sessions.** Consensus sets the floor; severity breaks ties; cost divides. Two places deviate from pure lens-count and say so in the notes.

| # | PRD | Themes it absorbs | Raised by | Size | The case |
|---|---|---|---|---|---|
| 1 | [`prd-reports-that-decide.md`](prd-reports-that-decide.md) | net sales vs. tax vs. gross; collected vs. charged; a "Today" bounded on the business day; attach rates that lead with the decidable row; p90 / ran-late / slowest-five; cancellations by reason; date range and CSV | **all three** (DX 8, 9 · OPS 8, 9, 12 · SYS 3, 9) | M — 7 sessions, one hand-written enum migration | The only theme every lens raised. The one screen that can change a purchasing or staffing decision currently buries every decision it holds — and it is also where defect D2's fix lands. Cheapest work with the broadest agreement. |
| 2 | [`prd-the-counter-handoff.md`](prd-the-counter-handoff.md) | Ready section first; lookup that highlights instead of hiding; undo where the tap was; revert past five seconds; where the bag is; a staff note on the ticket; a fourth ready escalation | DX + OPS (DX 1 · OPS 3, 4, 5, 6, 11) | M — 6 sessions, mostly S; three need no migration | Two lenses converged on the same ninety seconds from opposite ends — one from a 7,000px scroll, one from a smeared marker on a bag. The failure it prevents is the wrong bag going to the NO-ONIONS customer: the founding defect, arriving through the shelf. |
| 3 | [`prd-money-that-reconciles.md`](prd-money-that-reconciles.md) | comp / partial adjustment / remake; a payment as an event with an instant, actor and amount; a balance rather than a boolean; a refund that can fail; per-line tax (P1) | OPS + SYS (OPS 2 · SYS 1, 2, 3, 4, 10) | L — 8 sessions, several hand-written migrations | Ranked above a three-lens PRD deliberately: this is the highest-severity failure in the set. Cash leaves the building with no record, a prepaid no-show has no refund path, and there is no way to make an order right — which the operator names as one of the two things that make him lie about a shift. |
| 4 | [`prd-menu-under-pressure.md`](prd-menu-under-pressure.md) | an 86 that names what it hits; search on the availability board; category-level and bulk 86; dayparts (P1); effective-dated prices (P1); stations (P1) | **all three** (DX 7 · OPS 7 · SYS 11) | M–L — 6 sessions; P0 needs no migration at all | Three lenses, and the P0 half is the cheapest work in this whole set — the affected-item warning needs no migration and no new query, because `ItemModifierGroup` already holds the join. Ranked below money because the daypart half is the expensive part and can wait. |
| 5 | [`prd-the-customer-who-is-not-in-the-room.md`](prd-the-customer-who-is-not-in-the-room.md) | address / phone / hours on every customer screen; a status page that admits it is late; a last-call warning; menu descriptions and category nav; the "Skip" pill; focus to the error; a way back to your own order; cart quantity | DX (8 findings), with SYS 7 on the phone field | M — 7 sessions, one three-column migration | One lens, eight findings, nearly all S. It ranks on volume and cheapness: this is the only surface where a customer decides whether to order here at all, and it is the least designed one in the product. It also completes the master PRD's resolved answer "call the restaurant" by making the restaurant callable. |
| 6 | [`prd-who-did-it-and-what-leaves.md`](prd-who-did-it-and-what-leaves.md) | structured logging and error reporting; staff PINs stamping the event log; a payment event; retention and "forget this customer"; an ordered replayable event feed (P1); the multi-location widening plan (P1) | OPS + SYS (OPS 10 · SYS 5, 6, 7, 8, 9, 12) | L — 7 sessions, two hand-written migrations | Ranked last because most of it insures against futures — a second client, a subpoena, a printer — rather than this Friday. **Except its first item**, which is the cheapest high-value session in the entire set: today, when an order goes missing at 7:10pm, the product cannot distinguish "never placed" from "placed and eaten", because it writes no log line anywhere. Pull C-084 forward. |

| 7 | [`prd-loyalty.md`](prd-loyalty.md) | a member keyed on the phone already collected; an append-only points ledger; earn at pickup from the snapshot; redemption as a counter adjustment, after tax; expiry tied to the retention window; the program's own liability screen (P1) | **nobody** — no evaluator raised it; product-owner proposal | M — 7 sessions (6 P0 items), two hand-written migrations certain and a third conditional | **Ranked last, and the honest case is against it.** Every PRD above prevents a failure someone observed on a real Friday; this one prevents nothing and adds a product surface. It has zero lens consensus, which is the ranking signal this document is built on. It re-opens a Non-Goal both v2 reviewers respected. It adds durable customer data while `prd-who-did-it-and-what-leaves.md` P0-4 — the forget path — is still unbuilt, and it is blocked on that plus PRD 3's balance and adjustment. **The case for it, stated once so it is not strawmanned:** the paper punch card is the only thing the incumbent third-party app does that this product cannot, a pickup-only shop is the easiest place in food service to run one, and the design is cheap because it reuses PRD 3's adjustment rather than inventing a second money path. |

**Sequencing that is not the ranking:** D1, D2, D3 first, in that order. Then `C-084` (logging) out of PRD 6, because every other PRD's defects will be diagnosed with it. Then **staff identity** (PRD 6 P0-2), pulled forward by the decision below. Then the ranking above. PRD 7 sits outside this sequence entirely and does not enter it until its first Open Question is answered by the owner.

---

## Decisions taken — 2026-09-01

Four contradictions between evaluators, resolved. Recorded here and in each PRD's Open Questions. **Not re-opened**; a later session that wants to revisit one needs a reason that did not exist today.

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Does an unpaid `picked_up` order count into net sales? | **Count it, show the gap.** Net sales keeps its meaning; the report gains `Collected`, `Outstanding`, and the list of who owes what. | The smallest truthful change. It makes the gap visible without retroactively redefining what every past report's headline meant, which the cash-basis alternative would do. *(PRD 1 P0-2, and defect D2's shape.)* |
| 2 | Reconcile against the processor's settlement or the till? | **Neither yet.** Ship the outstanding list and stop. | Neither source exists in the system today, and a half-reconciliation is worse than an honest "the drawer is out of scope". A nightly drawer-count is also the chore staff skip on the bad night it would have mattered. **Trigger to revisit: the outstanding list stops explaining the variance.** |
| 3 | Can comps ship before staff identity? | **No — identity first.** PRD 6 P0-2 moves ahead of PRD 3. | The one thing here that cannot be retrofitted: every event written `actor: 'staff'` meanwhile is anonymous permanently and no backfill can invent a name. The typed-name middle option was rejected on this repo's own discipline — the constraint is the mechanism, and a typed name is the disabled-submit-button of accountability. **This reorders the set.** |
| 4 | Keep collecting the customer's phone number? | **Keep it, label it, give it a deletion path.** | The "unused PII" premise was wrong on inspection: `kitchen/orders/[id]/page.tsx:53` reads it onto the staff receipt so a customer whose order was wrong can be called. One real reader passes the use-it-or-stop-asking test. The actual defect is the missing retention limit and the form that never says why it asks. |

### Decisions taken later — 2026-09-01, after the defects and PRD 6's prerequisites landed

| # | Question | Decision | Why |
|---|---|---|---|
| 5 | Does `paymentState` stay the truth, or become a derived cache over a payment event stream? *(PRD 3's own text: "a human has to pick; the whole PRD's data model forks here")* | **The event stream is the truth.** `paymentState` stays as the fast read every surface already uses, and becomes a derived cache with a test asserting the two agree for every order in the seeded rush. | The only shape P0-2's balance and P0-4's "we tried and it failed" can live in — an enum holds terminal facts, and a refund in flight is not one. C-085 had already landed the events on both write paths, so the fork cost less than it did when the question was written. *(PRD 3 P0-1, C-063.)* |
| 6 | Do comps breach the master PRD's "no real payment processing" Non-Goal? | **No, and it is now written down.** An adjustment is an append-only record of a decision the counter made: it moves no money, calls no processor, and never touches the snapshot columns. | The question asked for one sentence of explicit agreement so a later reader would not have to re-derive it. *(PRD 3 P0-3, C-065.)* |

**What decision 3 changes about the ranking:** PRD 6 is no longer last in execution order even though its value ÷ cost still ranks it there. Its first two items — `C-084` structured logging and `C-085`-onward staff identity — are now prerequisites, not insurance.

---

## Consensus map

The strongest evidence in this document. Each row is a finding that at least two evaluators reached independently, from different evidence, without seeing each other's work.

| Finding | DX | OPS | SYS | Where it went |
|---|:--:|:--:|:--:|---|
| The report is not decision-grade — averages hide disasters, tautologies bury the real rate, there is no bounded period | ✓ (8, 9) | ✓ (9, 12) | ✓ (3, 9) | PRD 1 |
| Revenue counts food nobody paid for | | ✓ (8) | ✓ (3) | **Defect D2**, then PRD 1 P0-2 |
| The headline money number is wrong in a second way — it includes sales tax | | | ✓ (3) | PRD 1 P0-1 |
| An 86 does not say what it will hit, and the board cannot be searched or batched | ✓ (7) | ✓ (7) | ✓ (11, adjacent) | PRD 4 |
| The Ready/pickup moment is unsupported — the section is buried, the undo is five screens away, lookup blinds the board | ✓ (1) | ✓ (4, 5, 6, 11) | | PRD 2 |
| There is no way to make an order right — no comp, no partial, no remake, no refund after `preparing` | | ✓ (2) | ✓ (1) | PRD 3 |
| A payment is a column with no instant, no actor and no amount | | ✓ (8, implied) | ✓ (4, 8) | PRD 3 P0-1, PRD 6 P0-3 |
| Everyone is `staff` — the append-only log cannot answer who, and it now guards a cash button | | ✓ (10) | ✓ (8) | PRD 6 P0-2 |
| The customer has no way to reach the restaurant, and the product's own copy tells them to call | ✓ (2, 11) | | ✓ (7, adjacent) | PRD 5 P0-1 |
| Both screens go quiet under maximum pressure and neither offers a way out | ✓ (verdict) | ✓ (verdict) | | PRDs 2 and 5 |
| The snapshot rule holds, provably, and is the best thing in the codebase | ✓ | ✓ | ✓ | *confirmed — protect it* |
| The negation treatment is correct end to end and must not be diluted | ✓ | ✓ | ✓ | *confirmed — protect it* |
| Nothing auto-closes an order, and that refusal is right | ✓ | ✓ | | *confirmed — PRD 2 sizes the chore, never performs it* |

Single-lens findings that still earned requirements are in PRD 5 (the DX funnel work — eight findings, cheap, and the conversion surface) and PRD 6's observability half (SYS 5 — one lens, but it is the reason the *other* lenses' failures cannot be diagnosed).

---

## Raised but not PRD'd

Nothing from the three reports is dropped. Everything here is accounted for with the reason it did not earn a requirement.

**Already settled by the master PRD — all three evaluators checked these before writing, and I re-checked them:**

- Fixed 5-second polling, no backoff — resolved Open Question; WebSocket is P2 and the cursor design makes it a transport swap.
- Order numbers reset at midnight restaurant-time, not a 4am business-day boundary — resolved Open Question, deliberately rejected in the v2 addendum.
- Customers cannot cancel after `accepted` — resolved Open Question. PRD 5 makes "call the restaurant" work; it does not re-open the answer.
- No SMS/email "your order is ready" — P1-3, unbuilt. Named repeatedly as the real fix for counter congestion and no-shows; still deferred.
- No queue position on the status page — Open Question, non-blocking, deliberately not shown because it leaks pace information.
- No order-ahead time slots (P1-2); no reorder, tips, printer/KDS, station routing, prepay (P2).
- No delivery, real payments, loyalty, POS hardware, multi-restaurant — Non-Goals, re-affirmed under "Deliberately rejected". **The loyalty half of this line is the one thing in the set now under challenge**: `prd-loyalty.md` asks the owner to lift it, on the grounds that the same master PRD also lists loyalty under P2 futures, so the ask is a promotion rather than a reversal. Unanswered, and it blocks that document entirely.
- No mute or dismiss on the new-order chime — deliberate refusal (C-010); both evaluators independently endorsed it.
- The menu editor edits but cannot author — recorded caveat C-015. A seasonal special stays a SQL job.
- One opening window per day, no split lunch/dinner *hours*, no overnight service — recorded caveat C-011. PRD 4's dayparts are about which items are orderable, which is a different gate.
- An 86 on a shared option is an 86 everywhere, with no per-item override — recorded caveat C-012. PRD 4 P0-1 delivers only the warning that caveat itself names as "the cheaper half".
- 86s never restore themselves overnight — recorded caveat C-012, the safe direction. PRD 4's dayparts must not collapse into this boolean.
- Order history capped at 50 rows, one day at a time — recorded caveat C-046/C-049.
- A renamed item splits into two report rows — recorded caveat C-016, with the `menuItemId`-grouping fix named and rejected on snapshot-rule grounds.
- Estimate accuracy is not a P0 metric — P0-7; C-042 grades it after the fact and recommends nothing under ten quoted orders.
- The status link has no expiry and no revocation — P1-5 closed as satisfied, with `robots: noindex` as the recorded mitigation.
- No customer-side lookup by name, phone or number — recorded; all three are guessable and a lookup form is the enumeration hole the token closes.
- The placement re-check and write are not one transaction — recorded, with the operational answer (`cancel` with `out_of_item`) named.
- The cart is a cookie with a ~3,900-byte ceiling — recorded in C-005.
- The report is a full scan with rolling windows — recorded; the materialized rollup is named as the chain-scale upgrade.
- Prep weight is per item, not per modifier — recorded ceiling in C-041.
- Single flat tax rate — recorded in WRITEUP with the prepared-vs-packaged case named. SYS 10 disputes the *shape*, not the rate, and that lands in PRD 3 P1-2.
- "Revenue is what was charged, not collected" — recorded in C-016, and **this one has gone stale**: see defect D2.
- "A reprice reaches open carts" — recorded as a caveat and **the caveat is stale, not a gap**: `cart/page.tsx` already shows old → new per line and requires an explicit confirm. Worth correcting the WRITEUP; a stale caveat is worse than none.

**Too small for a PRD — file as backlog items:**

- **`MAX_SEQ_ATTEMPTS`'s justification is stale.** It reasons from the P0-6 throttle bounding concurrency, but the throttle counts *open* weight and `ready` orders are `open: false`. The depth is almost certainly still ample; the stated argument no longer supports it. One-line comment fix plus a test. → carried in PRD 6 as **E-2** on C-090.
- **`packages/db/report.ts:94` restates a status in SQL** with no paired test — the same dual-dialect risk the WRITEUP already flags for `isLeftOver`, without the test that one has. → carried in PRD 1 as part of C-054.
- **`priceLine` throws on unknown ids with no handler and no log.** → carried in PRD 6 P0-1.
- **The `total_mismatch` event is only persisted if the surrounding order write succeeds**, so a tampered request that also fails validation is recorded nowhere. → carried in PRD 6 P0-1.

**Raised by `prd-loyalty.md`, and deliberately not built by it:**

Loyalty is the one entry in this section whose parent document is itself asking for a Non-Goal to be lifted. Everything below is a thing PRD 7 names and refuses, so a later reader does not mistake its silence for an oversight.

- **Phone verification / SMS one-time codes.** The prerequisite for self-serve redemption at checkout, and therefore for a pre-tax reward. Master PRD P1-3, still unbuilt and still deferred. PRD 7 works around it by making redemption a counter action, and says so.
- **Self-serve redemption and a pre-tax discount.** PRD 7 P1-1, not phased. It needs verified identity plus a snapshotted `Order.discountCents` and a `subtotal − discount` tax base, because `priceOrder` currently defines `subtotalCents` as exactly the sum of the lines. That is a PRD of its own, not an item.
- **Stored value / gift cards.** Customer money held by the shop — a regulated liability and genuinely adjacent to the "no real payment processing" Non-Goal. Named explicitly in PRD 7's Non-Goals because "points worth cents" drifts here on its own.
- **Tiers, birthdays, referrals, streaks, bonus-point promotions.** The master PRD parks entitlement systems in the fitness-studio project. PRD 7 stops at one integer per member and marks a second entitlement dimension as the point where that Non-Goal is genuinely breached rather than promoted.
- **Any marketing use of the phone number.** No email, no campaign SMS, no "we miss you". The number is a key, not a channel — collecting it for one purpose and using it for another is exactly the failure PRD 6 P0-4 exists to prevent.
- **Point transfer, gifting, merging or a balance that follows a changed number.** Two numbers are two members; a staff `adjust` is the manual answer.
- **Automatic point clawback on a comp, a refund or a revert.** A recorded ceiling in PRD 7 P0-3: the earn reads the order's snapshotted subtotal and does not chase adjustments, so a comped order still earns once. The trigger to revisit is repeat names on PRD 3's comps line.
- **A loyalty number on the sales report.** PRD 7 P0-6 makes this a *requirement* rather than an omission — the report must read no loyalty table, which is what keeps PRD 6 P0-4's byte-identical forget test true. The program's own liability screen is separate (PRD 7 P1-2).
- **Multi-restaurant point pooling.** Non-Goal / P2. It would add one row to PRD 6 P1-3's widening plan and nothing else.

**Genuinely out of scope here:**

- **Stations as a first-class model** (OPS 7's "real version") — P2 station routing in the master PRD. PRD 4 ships the cheap version (category/bulk 86) and puts the station question in its Open Questions, because if the answer is "stations", the cheap version is the wrong shape.
- **Multi-location** (SYS 12) — Non-Goal / P2. Only the *written widening plan* earns work, in PRD 6 P1-3: which constraints widen and in which order, recorded next to the singleton CHECK so the migration is a plan rather than a discovery.
- **A printer or KDS bridge** (SYS 9) — Non-Goal plus P2. PRD 6 P1-1 builds the substrate the reviewer argues is the actually hard part; nothing plugs into it here. The reviewer disputes the Non-Goal's stated *reason* ("hardware integration is config, not logic"), not the Non-Goal, and that dispute is recorded rather than acted on.
- **Per-cook accounts with roles and permissions** — the WRITEUP calls this a different project and PRD 6 deliberately stops at a name stamped on a row.

---

## Adjacent products

Things that are really separate products, in the way `prd-reservations.md` is. Listed, not PRD'd.

- **Countertop Reserve** — already written up in `prd-reservations.md`. Table allocation under contention plus SMS confirm/change. Countertop's Non-Goals name it.
- **A kitchen production system** — stations, expo split screens, station-aware pacing and estimates. OPS 7's "real version" and the master PRD's P2 station routing. It is a different queue model with a different reader, not a feature of this one; PRD 4's category 86 is deliberately the cheap stand-in.
- **A KDS / impact-printer bridge** — a durable ordered event consumer with its own delivery state, retry and reconciliation. SYS 9's case is that this is a distributed-systems product wearing a hardware costume, and the substrate for it (PRD 6 P1-1) is the only part that belongs in this repo.
- **A multi-location back office** — menu-per-location, per-store hours, cross-location reporting. Master PRD Non-Goal, P2, and SYS 12's point is only that the constraints which make it expensive should be *documented* now.
- **Real payments** — a processor adapter with auth/capture, settlement import, chargeback handling and reconciliation. Master PRD Non-Goal. PRD 3 shapes the seam so the call has somewhere honest to go; it does not make the call.
