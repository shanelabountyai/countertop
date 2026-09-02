# PRD: The Punch Card — a loyalty program for a shop that deliberately has no customers

**Sample business:** "Firebird Kitchen" on a Tuesday, where Ivy Castellanos has bought a torta forty-one times and the system has never once known it was her
**Status:** Draft v1 — **not derived from the 2026-09-01 evaluations.** No evaluator raised loyalty. This is a product-owner proposal, and the ranking in `INDEX.md` says so.
**Relationship to the master PRD:** this **re-opens a stated Non-Goal.** "Loyalty/rewards — entitlement systems are the fitness-studio project's lesson" is a v1 Non-Goal, and "Breaking any v1 non-goal (real payments, delivery, loyalty, POS hardware, multi-location)" is under *Deliberately rejected*. The same document's P2 list contains "Loyalty / repeat-customer recognition", so what this asks for is a **promotion from P2**, not a reversal of a judgement. Either way it needs the owner to lift it in writing. That is the first Open Question and it blocks every item below.
**Consensus:** none. Zero of three lenses raised it. That is a real argument against building it and it is not being hidden.

---

## Problem Statement

**Tuesday, 12:40pm.** Ivy orders the same torta she has ordered forty-one times since March. The shop has, in its database, forty-one order rows that say `customerName: 'Ivy Castellanos'` and `customerPhone: '+1…'`, and it has no idea they are the same person, because nothing in this product ever joins two orders together. `searchOrderHistory` does a `contains` on the name (`packages/db/history.ts:82`) and is capped at 50 rows, one day at a time (C-046/C-049). There is no customer record. There is no customer id. There is deliberately no account: the resolved Open Question chose a tokenized status link precisely so this project would never grow an auth surface.

That is a good decision and this PRD does not undo it. But it means the shop's fortieth-best decision and its best customer are the same to the software, and the third-party app that takes 15–30% — the reason this product exists at all — has a punch card.

**The counter, 12:42pm.** Bea would like to say "that's your tenth, this one's on us." She cannot, because there is no tenth. The paper punch card in the drawer, which several of these shops actually run, is the incumbent, and it beats this product on exactly one axis: it remembers.

**And the thing that makes this hard rather than fun.** Loyalty is durable customer data by definition. `prd-who-did-it-and-what-leaves.md` P0-4 has not shipped: today nothing in the repo deletes or anonymises a customer, and the fix for that (a retention window and a staff-invokable forget) is written but unbuilt. A points ledger is a second, *worse* pile of the same thing — a permanent record of what a named person eats and how often — and it is the kind of record that argues for keeping data forever, because a balance that expires is a balance the customer complains about. **A loyalty program built before the forget path exists makes the forget path harder to build, not easier.** This document is written to keep P0-4 implementable, and if it fails that test it should be shelved rather than softened.

## Users and the moment of use

- **The counter person at pickup**, who has ten seconds and a line, and who needs to know *before the customer asks* whether there is a reward on this order.
- **Ivy at the counter**, who wants to be recognised and does not want to install anything, create anything, or remember anything.
- **The owner on Sunday**, who needs to know what the program costs — points outstanding is a liability, and a program whose cost is invisible is a program that quietly eats the margin on every burrito.
- **The person who has to answer "delete my data"**, six months from now, with a ledger in the way.

## Requirements

### Must-Have (P0)

**P0-1: A member is a phone number, and there is no account**
- [ ] Membership is keyed on the customer's phone — the field checkout already collects (`apps/web/app/checkout/checkout-form.tsx:118`, optional, and PRD 6 decision 4 kept it and gave it a deletion path). No email, no password, no login, no member portal. The resolved "tokenized link, no auth project" decision is not re-opened
- [ ] Enrolment is a checkbox on the checkout form, enabled only when a phone is entered, with copy that states what is kept and for how long. Unchecked is the default and ordering without it stays a first-class path — no interstitial, no dark pattern, no second screen
- [ ] `LoyaltyMember` stores `phoneDigest` (HMAC-SHA256 of the normalised phone under a pepper held in the environment, **not** in the database) and `phoneLast4` in clear for counter disambiguation. It does **not** store the phone. Staff lookup hashes the typed number and matches the digest, so the plaintext never reaches a `where` — the same discipline `packages/db/staff.ts:38` already applies to PINs
- [ ] The pepper is an env secret and the PIN's constant salt is not — the difference is deliberate and stated in the schema comment. `staff.ts:22` already admits its salt is a constant and that anybody holding the table can recover every PIN; a ten-digit phone number is small enough that the same choice here would make the digest decorative
- [ ] A `loyaltyEnabled` setting, **default false**. With it off, no loyalty copy renders on any screen, no ledger row is written, and the seeded rush passes unchanged
- [ ] Test: enrol two orders with the same phone typed two ways (`(555) 010-2233` and `5550102233`) and assert one member; assert no column anywhere holds the phone in clear except `Order.customerPhone`, which is unchanged; assert the whole customer flow renders identically with `loyaltyEnabled: false`

**P0-2: The ledger is append-only and the balance is one pure function**
- [ ] `LoyaltyEvent` is append-only, enforced by the same trigger shape the migration already uses for `OrderEvent`. Kinds: `earn`, `redeem`, `adjust`, `expire`. Points are integers; a `redeem` also carries `amountCents`
- [ ] The balance is `Σ points` over a member's events, computed by **one pure function in `packages/core`** that takes the events and returns the balance. It reads no clock, no database and no order row — same shape as `derivePaymentState` in `packages/core/orders/payment.ts`, and for the same reason: it has to be drivable over the whole seeded rush in a unit test
- [ ] There is **no balance column.** A cached balance is a second answer that can disagree with the ledger, and unlike `paymentState` there is no existing surface whose read cost justifies one. If one is ever added it is a derived cache with an agreement test, and that is a later decision with a written reason
- [ ] A correction is an `adjust` event with a reason, free text, and the writing staff member's id (C-086's `staffId`, which already exists). Never a delete, never an edit
- [ ] Test: `earn +14`, `earn +9`, `earn +100`, `redeem −100`, `adjust +5` balances to 28; a `redeem` that would take a balance below zero is refused by name before it is written; an `UPDATE` and a `DELETE` against `LoyaltyEvent` both raise

**P0-3: Points are earned once, at pickup, from the snapshot**
- [ ] Earning fires on the transition **into `picked_up`** — derived from `salesRoleOf(status) === 'sold'`, never from a status literal. `SOLD_STATUSES` is `['picked_up']` today and the earn path must keep reading it from the status module, so adding a state makes the compiler find this reader
- [ ] Points = `floor(subtotalCents / 100) × pointsPerDollar`, read from the order's **snapshotted `subtotalCents`**. Tax earns nothing. No live menu row and no recomputation is involved; the number is a function of columns already written and frozen
- [ ] Exactly one `earn` event per order, enforced by a **unique constraint on `(orderId, kind='earn')`**. The state machine permits reverts, so `ready → picked_up` can happen twice on the same order; the constraint is the mechanism and the code path's care is UX. Same discipline as placement
- [ ] An order that is cancelled or abandoned earns nothing. An order reverted back out of `picked_up` keeps the points it earned — nothing is clawed back automatically; a staff `adjust` is the correction. This is a recorded ceiling, not an oversight: an automatic reversal makes the ledger a function of a status history rather than of a set of facts
- [ ] Test: advance an order to `picked_up`, revert it, advance it again, assert exactly one `earn` event; assert a $23.47 subtotal earns 23 points and a $23.99 subtotal also earns 23; assert an `abandoned` order has no `earn` row

**P0-4: A reward is redeemed at the counter, as an adjustment, after tax**
- [ ] Redemption is a **staff action** on the staff receipt at `/kitchen/orders/[id]`, attributed to a named staff member. It is not a self-serve control at checkout. That is what makes an unverified phone number safe to use as a key — see the fraud paragraph below
- [ ] Redemption writes **two rows**: a `redeem` event on the loyalty ledger (points out) and an `adjustment` event on `OrderEvent` with `amountCents` and a `loyalty_reward` reason (money off the bill). This PRD introduces **no new money mechanism** — the money side is `prd-money-that-reconciles.md` P0-3's adjustment, and the amount owed is P0-2's balance. **Hard dependency: C-064 and C-065 land first**
- [ ] It therefore **never touches `subtotalCents`, `taxCents` or `totalCents`.** The order was charged what it was charged; the reward is a second fact beside it. The snapshot regression test grows a case
- [ ] The reward is applied **after tax**, to the amount owed, and the customer-facing copy says "$10 off your total", never "a free burrito". Rationale and its cost are in the invariants section — this is a real decision with a real price, not a technicality
- [ ] At most one reward per order, and a redemption exceeding the order's outstanding balance is **refused by name, not clamped** — the same rule PRD 3 applies to an over-large adjustment, and the same reason
- [ ] Test: redeem a $10 reward against a $13.75 order; assert `totalCents` is still 1375, `taxCents` unchanged, the balance owed is 375, one `redeem` event and one `adjustment` event exist and agree to the cent; assert a second redemption on the same order is refused by name; assert redeeming against a $6.00 order is refused, not clamped to $6.00

**P0-5: Points expire, and a forgotten customer is actually forgotten**
- [ ] Points expire after `loyaltyExpiryDays` of member inactivity, zeroed by a system `expire` event. Expiry is not a nicety — an immortal balance is an unbounded liability and, worse, it is the argument for keeping a named person's purchase history forever
- [ ] A **CHECK constraint** enforces `loyaltyExpiryDays <= retentionDays`. It is impossible to configure a program that needs PII kept longer than the retention policy allows. **Hard dependency: PRD 6 C-087 lands the retention setting first**
- [ ] "Forget this customer" (PRD 6 P0-4) **deletes** the `LoyaltyMember` row and its ledger. A real delete, not an append. The append-only rule protects the order event log, which is a financial record; a loyalty ledger is an entitlement held for the customer's benefit, and refusing to delete it is the exact behaviour the forget path exists to prevent
- [ ] The financial facts survive the forget, because they were never on the loyalty side: every redemption's money already lives on `OrderEvent` as an `adjustment` with its amount, its instant and its staff member. Deleting a member removes who it was, not what happened
- [ ] Test: run the forget against a member with an earn history and one redemption; assert the member and every ledger row are gone, the order's `adjustment` event is intact with its amount, and every number on the sales report is **byte-identical** — the same assertion PRD 6 P0-4 uses, extended over the loyalty tables

**P0-6: Loyalty is provably invisible to the order snapshot and the sales report**
- [ ] `Order` gains **no column** and **no foreign key** to any loyalty table. The link runs one way only: `LoyaltyEvent.orderId → Order`. A member FK on the order would make the forget in P0-5 either cascade (changing a report count) or restrict (blocking the forget), and both are wrong
- [ ] The sales report reads **no loyalty table.** No loyalty number appears on `/kitchen/report`. `loadReportOrders`'s snapshot-only `select` does not widen and does not grow a join. The program's own numbers live on their own screen (P1-2)
- [ ] Test: a static check that the report query path imports nothing from the loyalty modules; the existing snapshot regression, re-run with a fully enrolled and redeemed order in the fixture, still byte-identical

### Nice-to-Have (P1)

- **P1-1: Self-serve redemption at checkout, before tax.** The version customers actually want, and it is one feature with three prerequisites. It needs a **verified** identity, because a customer typing a phone number at checkout to spend the balance behind it is theft with no counter-party present. Verification needs SMS, which is master-PRD P1-3 and unbuilt. Applying the reward before tax then needs a snapshotted `Order.discountCents` and `subtotal − discount` as the tax base — because `priceOrder` currently defines `subtotalCents` as exactly the sum of the lines, and a discount that breaks that identity breaks every receipt that reconciles. All three move together or none of them do.
- **P1-2: The program's own screen.** Members, points outstanding **valued in cents as a liability**, redemptions and their cost per period, and the redemption rate. Deliberately its own page, not a tile on the sales report, per P0-6. The owner cannot judge whether the program is worth running without the liability number, and the liability number is the one nobody builds.
- **P1-3: A member chip on the queue card.** "Member — reward available" so the counter offers it rather than waiting to be asked, which is most of the emotional value of the whole program. P1 because it modifies the queue card, which `prd-the-counter-handoff.md` owns, and it must not compete with the negation treatment for attention on that card.

## Non-Goals

- **Anything that survives the master PRD's Non-Goal staying in place.** If the owner does not lift it, this document is shelved, not trimmed. It is not built in a smaller form.
- **Accounts, logins, passwords, email addresses, or a customer portal.** The resolved tokenized-link decision stands. A member has a phone number and a balance and nothing else.
- **Stored value, gift cards, or a prepaid balance.** Points are an entitlement to a discount the shop chooses to honour; stored value is customer money the shop is holding, which is a regulated liability and genuinely adjacent to the "no real payment processing" Non-Goal. Named explicitly because "points worth cents" drifts here on its own if nobody writes it down.
- **Tiers, birthday rewards, referrals, streaks, or bonus-point promotions.** The master PRD parks entitlement systems in the fitness-studio project and this deliberately stops at one integer per member. A second entitlement dimension is the point at which that Non-Goal is genuinely breached rather than promoted.
- **Marketing.** No email, no SMS campaign, no push, no "we miss you". The only thing this program ever says to a customer is said on their own status page or by a person at the counter. The phone number is a key, not a channel — collecting it for one purpose and using it for another is the failure PRD 6 was written to prevent.
- **Points for anything other than food bought and collected.** No points for signing up, reviewing, or referring.
- **Transferring, gifting, merging or selling a balance.** Two phone numbers are two members. A customer who changes number starts again, and staff can `adjust` them whole.
- **Multi-restaurant point pooling.** Master PRD Non-Goal; `prd-who-did-it-and-what-leaves.md` P1-3's widening plan would gain a row if it were ever real, and that is the whole treatment it gets.
- **Automatic clawback of points on a comp, a refund or a revert.** Recorded ceiling in P0-3, with the staff `adjust` as the manual answer.
- **A loyalty line on the sales report.** P0-6, and it is a requirement rather than an omission.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `LoyaltyMember` (new) | `id`, `phoneDigest` (unique), `phoneLast4 VarChar(4)`, `displayName VarChar(40)` copied at enrolment, `enrolledAt`, `lastActivityAt`, all `timestamptz` | **yes, hand-written** — unique on the digest, and a CHECK that `phoneLast4` is exactly four digits so a partial write cannot leave a lookup that matches everybody |
| `LoyaltyEvent` (new) | `id`, `memberId` (`onDelete: Cascade` — the forget in P0-5 is the one delete this model has, and it must take the ledger with it), `orderId String?` (`onDelete: Restrict`), `at`, `kind`, `points Int`, `amountCents Int?`, `reason`, `staffId String?` (`onDelete: Restrict`) | **yes, hand-written** — the append-only trigger, a CHECK that `points` sign matches the kind, a CHECK that `amountCents` is non-null exactly on `redeem`, and a **partial unique index on `(orderId)` where `kind = 'earn'`** which is P0-3's whole mechanism |
| `LoyaltyEventKind` (enum, new) | `earn`, `redeem`, `adjust`, `expire` | part of the same hand-written migration |
| `RestaurantSettings` | `loyaltyEnabled Boolean @default(false)`, `pointsPerDollar Int`, `rewardThresholdPoints Int`, `rewardValueCents Int`, `loyaltyExpiryDays Int` | **yes, hand-written** — the singleton CHECK already lives here, and this adds the `loyaltyExpiryDays <= retentionDays` CHECK from P0-5 |
| `Order` | **none.** No column, no FK, stated as a requirement rather than an omission (P0-6) | none |
| `OrderEvent` | **none** — redemption reuses PRD 3's `adjustment` kind and its `amountCents` column, which already exists | none, **unless** PRD 3 lands its adjustment reason preset as a Postgres enum, in which case this needs an additive hand-written `ALTER TYPE ... ADD VALUE` for `loyalty_reward`. If the preset is a string constant in `packages/core`, none |

Two Cascades and two Restricts, and the asymmetry is the design: a member's ledger dies with the member, an order and a staff member outlive every ledger row that points at them.

## Invariant impact

1. **Snapshot rule — touched, and it is what forces the after-tax decision.** A redemption cannot change what an order was charged, because the order was already charged it and the columns are frozen. So the reward is an appended fact and the amount owed is a computation, exactly as PRD 3 shaped it for comps. **The cost of that, stated plainly:** applying the reward after tax means the shop computes and remits sales tax on money the customer never handed over. At 8.25% on a $10 reward that is 83 cents per redemption, and the customer pays 83 cents more than a pre-tax discount would have cost them. The alternative — recomputing tax on a discounted base — requires either mutating `taxCents` on a placed order (forbidden, and there is a regression test that catches it) or maintaining a second "effective tax" number that no receipt can reconcile against `taxRatePpm`. Both are worse than 83 cents. The mitigation is copy: a reward denominated as "$10 off your total" is honest under after-tax treatment; a reward denominated as "a free burrito" is not, because the customer will read the receipt. **The correct fix is P1-1** — a reward applied before `priceOrder` runs, snapshotted into the order as a discount — and it is P1 because it needs a verified identity to be safe. The two deferrals are the same deferral.
2. **Server is the price authority — touched, and it extends.** No points arithmetic ever originates on a client. The earn amount is computed server-side from the order's own snapshotted subtotal; the redemption amount comes from `RestaurantSettings`, never from the request; a client-supplied point total or reward value is not an input to anything. A redemption that exceeds the outstanding balance is refused by name rather than clamped, for the same reason a tampered total is logged rather than accepted.
3. **One status module — touched, and the discipline transfers unchanged.** The earn trigger derives from `salesRoleOf(status) === 'sold'` and never from `status === 'picked_up'`. If a later state joins the `sold` role, the compiler finds this reader along with the report's. Loyalty adds no status enum of its own: a member is not a state machine, and a balance is an integer.
4. **One orderability function — untouched, and it must stay untouched.** A reward is not an orderable thing. It never enters `priceLine`, never becomes a menu item, never gains an availability grain. The moment a reward becomes "a free item" that has to be checked against an 86, this PRD has grown a third availability grain and should be rewritten. That is one more reason the reward is an amount off a total.
5. **Idempotent placement — touched by analogy, and P0-3 is the transfer.** One `earn` per order, guaranteed by a unique constraint and not by the transition path being careful. The state machine's revert is a supported operation, so the double-earn is not hypothetical.

**Money:** integer cents everywhere, one rounding function, and points are integers that are not money — the only place the two meet is `rewardValueCents`, which is a configured constant, not a computation. **Time:** every ledger row carries a `timestamptz` instant; expiry is expressed in days and evaluated against the restaurant's business day, never UTC. Nothing in `packages/core` reads the system clock — the balance function takes events, the expiry function takes `now` as a parameter.

**PII:** the pepper for `phoneDigest` is an environment secret. Against a stolen database dump this holds; against a compromised server it does not, and the schema comment says so rather than implying otherwise. Ten digits is a small enough space that a constant salt would be decorative.

**Fraud.** Four defences, all of them cheap, all of them structural:
- **Earning fires at pickup, not placement.** An order that is never collected earns nothing. Free — the state machine already draws the line.
- **One `earn` per order, by constraint.** Revert-and-re-advance cannot double-earn.
- **The floor makes splitting orders strictly worse.** `floor(subtotalCents / 100)` discards the change on every order, so ten $10.90 orders earn 100 points where one $109.00 order earns 109. There is no split-the-basket exploit because the arithmetic already penalises it.
- **Redemption is a staff action, attributed and countable.** This is the one that makes an *unverified* phone number safe as a key. Knowing a stranger's number lets you add points to their balance, which is not a crime anybody commits; spending it requires standing at the counter and lying to a person who is looking at you. That is precisely the fraud surface a paper punch card has, and restaurants already run those.

**Deliberately not defended:** phone verification (needs SMS; the whole reason self-serve redemption is P1). Velocity limits and same-phone anomaly detection — a 10%-back program is not farmable at a profit, and the detector would be a rule nobody tunes. Staff self-dealing beyond attribution — C-086 puts a name on every redemption and PRD 3's report line makes the total visible, and a shop that wants more than that wants an authorization model, which PRD 6 explicitly refuses to build. The staff phone lookup is an oracle for "is this number a member", behind the staff passcode; recorded, not mitigated.

## Acceptance criteria

- `(555) 010-2233` and `5550102233` enrol as one member; no table outside `Order.customerPhone` holds a phone number in clear.
- With `loyaltyEnabled: false`, every customer and staff screen renders identically to today and the seeded rush produces zero loyalty rows.
- A $23.47 subtotal and a $23.99 subtotal both earn 23 points; tax earns nothing.
- Advancing to `picked_up`, reverting, and advancing again produces exactly one `earn` event.
- A cancelled order and an abandoned order each produce zero `earn` events.
- An `UPDATE` or a `DELETE` against `LoyaltyEvent` raises; deleting a `LoyaltyMember` removes its ledger and nothing else.
- Redeeming a $10 reward against a $13.75 order leaves `subtotalCents`, `taxCents` and `totalCents` untouched, sets the amount owed to 375, and writes one `redeem` event and one `adjustment` event that agree to the cent.
- A second redemption on the same order is refused by name. A $10 redemption against a $6.00 order is refused by name, and nothing is written.
- Forgetting a member with an earn history and a redemption leaves every sales-report number **byte-identical** and leaves the order's `adjustment` event intact with its amount and its staff member.
- Configuring `loyaltyExpiryDays` greater than `retentionDays` is rejected by the database, not by the form.
- The snapshot regression, re-run with an enrolled and redeemed order in the fixture, is byte-identical after mutating every menu row the order referenced.
- No module on the report query path imports from the loyalty modules.

## Open Questions

- **(Product — blocking C-100, and blocking this entire document)** The master PRD lists loyalty under *Non-Goals* and again under *Deliberately rejected*, where both v2 reviewers are recorded as respecting the learning scope. The same document lists it under P2 futures. **The fork:** (a) lift the Non-Goal in the master PRD with a written reason, promoting the P2 item, and accept that "entitlement systems are the fitness-studio project's lesson" now half-lands here; or (b) leave it closed and shelve this document. There is no middle version — a smaller loyalty program is still a loyalty program. My recommendation is (b) **for now**: nothing in three independent evaluations asked for this, three of the six existing PRDs exist because two or three lenses converged on a real Friday failure, and this converges on none. The case for (a) is that the punch card is the incumbent's one advantage and a pickup-only shop is the easiest place to run one. Somebody has to choose, and it is not a builder's choice.
- **(Product — blocking C-104)** The reward economics. This document assumes 1 point per dollar of subtotal, 100 points, $10 off — 10% back, which is aggressive for fast casual and generous enough that customers notice. **The fork:** 10% back and a program people talk about, or 5% (200 points / $10) and a program that is cheaper than the food cost of a giveaway burrito. The number is a permanent margin decision on every order the program touches and it cannot be quietly changed later without visibly devaluing balances people are holding. The owner names it and defends it; the builder should not default it.
- **(Ops — blocking C-105)** The expiry window, which cannot be answered before PRD 6's still-open retention-window question, because P0-5's CHECK makes expiry the tighter of the two. **The fork:** twelve months of inactivity (a real punch card's lifetime; requires a retention window of at least twelve months, which is longer than the ninety days PRD 6 floats and much longer than anything this product's own features need), or ninety days matching retention (which is a "use it this quarter" program and a different product). Answering PRD 6's question first is the cheaper order.
- **(Product)** A comped order still earns points, because the earn reads the order's snapshotted subtotal and does not chase adjustments. So "complain, get comped, keep the points" works once. Decided this way because the alternative makes the balance a function of a mutable running total and re-opens the ledger every time an adjustment lands. **Trigger to revisit:** the comps line on the report (PRD 3 P1-3) shows repeat names.
- **(Builder)** Should `adjust` have a cap? Today any staff member behind the passcode can grant any number of points, attributed. A cap of one reward's worth per event would make a runaway typo survivable without adding an authorization model. Cheap either way; the reason it is a question and not a decision is that a cap that is too low turns into staff writing five `adjust` events, which is worse than one.

## Phasing — one item per session

Nothing here starts until the first Open Question is answered. **Hard prerequisites outside this document:** PRD 3's `C-064` (the balance) and `C-065` (the adjustment control), and PRD 6's `C-087` (the retention setting and the forget path). All three are already ranked ahead of this and none of them is optional here.

- **C-100 — The ledger** — P0-2 and the schema: `LoyaltyMember`, `LoyaltyEvent`, the enum, the settings columns, the append-only trigger, the sign and amount CHECKs, the partial unique index, and the pure balance function in `packages/core` with its tests. **Two sessions** — one for the hand-written migration and its constraint tests, one for the core function. **Hand-written migration.**
- **C-101 — Enrolment** — P0-1: the checkout checkbox, phone normalisation, the peppered digest, the counter-lookup helper, and the `loyaltyEnabled: false` invisibility test. **One session.** No migration.
- **C-102 — Earning at pickup** — P0-3: the earn on the `sold` transition, reading `salesRoleOf`, with the revert-and-re-advance test proving the constraint carries it. **One session.** No migration — C-100 landed the index.
- **C-103 — The counter panel** — the staff-receipt view of a member: last four, display name, balance, whether a reward is available. Read-only. **One session.** No migration.
- **C-104 — Redeeming** — P0-4: the redemption control writing both rows, the after-tax application, the one-per-order and over-balance refusals, and the snapshot-untouched assertion. **One session**, plus a hand-written `ALTER TYPE` **only if** PRD 3 landed its reason preset as a Postgres enum.
- **C-105 — Expiry, and the forget** — P0-5: the expiry sweep, the `loyaltyExpiryDays <= retentionDays` CHECK, and extending PRD 6's forget path over the loyalty tables with the byte-identical report assertion. **One session.** **Hand-written migration** for the CHECK. Blocked on `C-087`.
- **C-106 — The program's own screen** — P1-2: members, points outstanding valued in cents, redemptions and their cost, redemption rate. On its own page, and P0-6's static check proves it did not reach the sales report. **One session.** No migration.

**Total: six P0 items over seven sessions, plus one P1 session.** Two hand-written migrations certain (C-100, C-105), a third conditional (C-104). P1-1 and P1-3 are not phased — P1-1 is a program of work gated on SMS that would be its own PRD, and P1-3 belongs to whoever next opens the queue card.
