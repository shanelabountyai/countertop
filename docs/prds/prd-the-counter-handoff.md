# PRD: The Counter Handoff — the last ninety seconds of an order

**Sample business:** "Firebird Kitchen" at 6:44pm on a Friday, three people deep at the counter and five bags on the shelf
**Status:** Draft v1 — derived from the 2026-09-01 evaluations. Every requirement traces to a numbered finding in `review-dx.md` or `review-ops.md`; the trace is named inline.
**Relationship to the master PRD:** extends P0-4, P0-11 and P1-6. It does not re-open the queue's data model, the alert, or the two-clock design, all of which both evaluators singled out as correct.
**Consensus:** raised independently by the digital-experience lead and the operator, from opposite ends — one from the screen, one from the shelf.

---

## Problem Statement

The product is excellent up to the moment the food is cooked and completely absent for the ninety seconds after it.

**6:47pm.** A delivery driver has moved three bags to get at his. `#002` (Ada Nkemelu, burrito, **NO ONIONS**, $14.56 unpaid) and `#001` (Ben Sorensen, burrito bowl, $18.35 unpaid) are both burritos in identical bags and the marker on `#002` has smeared. Danny has two customers, two unpaid badges, two bags, and a screen that can tell him everything about both orders except which bag is which. One of them gets the wrong food and it is the one with NO ONIONS on it — the exact defect this product was built to kill, arriving through the shelf instead of the phone. *(OPS 6)*

**Same minute, three feet away.** Cass Iverson is at the front asking about `#003`; Ada is behind her. To answer Cass, Danny types "Cass" into the Find box — which filters *everything*, so while he answers her the queue is invisible, and to answer Ada he clears it and types again. Meanwhile "Ready for pickup" is the **last** section on a 7,124-pixel page, under New, Accepted and eleven Preparing cards: the section the counter needs constantly is the one it scrolls furthest to reach. *(OPS 5, DX 1)*

**6:41pm, the mis-tap.** The expo taps "Picked up" on `#009` at the bottom of the board and immediately realises the customer took `#003`. The card vanishes. The only undo control renders in the "Just finished" strip at the *top* of that 7,000-pixel scroll — five screens away — and the five-second window expires during the scroll. *(DX 1)*

**8:05pm.** `#009` (Rae Sutton, enchilada plate + 2 horchata) was closed out as a no-show at 7:48 when the shelf needed the space. Rae walks in at 8:05, apologetic, parking. The food is still in the warmer. The engine permits `abandoned → ready` — `abandoned.previous = 'ready'` is right there in the state machine — but past five seconds no screen in the product offers it. Danny hands her the bag and writes nothing down. *(OPS 4)*

**7:15pm, shift change.** `#017` (Nate Boateng, taco plate, unpaid $15.70) has been ready eleven minutes; Nate phoned at 7:05 to say he is stuck and will arrive at 7:40. Bea knows. Danny does not, because there is no staff-writable field on a live order anywhere in the app. At 7:30 the card reads "On the shelf 26 min — no-show?" in red and Danny closes it out. *(OPS 3)*

**9:20pm, cashing up.** `#023` (Sol Nakamura, $27.55) went ready at 7:10 and has been red since 7:40. It looks identical to the two tickets that went ready at 9:05, because `readyFlagMinutes` caps at `[10, 20, 30]` and nothing escalates past thirty. Half the time nobody reads every red card, and it surfaces as a leftover banner at 11am tomorrow. *(OPS 11)*

## Users and the moment of use

- **The counter/expo person**, standing, one hand on a bag, three people waiting, reading a tablet at arm's length with greasy gloves. Every requirement here is judged at that distance.
- **The closing manager at 9:20pm**, deciding which red cards are real.
- **The incoming shift at 7:15pm**, who knows nothing that is not written on a ticket.

## Requirements

### Must-Have (P0)

**P0-1: Ready is the section you can always see** *(OPS 5, DX 1)*
- [x] "Ready for pickup" renders **first** on the queue, above New/Accepted/Preparing — the counter reads it constantly and the kitchen reads its own section by walking to it
- [x] The section is reachable without scrolling at a 22-live-order queue depth, asserted by Playwright at the tablet viewport the existing size tests use
- [x] The existing order-within-a-state rule (placement time ascending) is unchanged; only the section order moves
- [x] Tap targets stay ≥48px and item lines ≥18px — the existing axe/Playwright size assertions run against the reordered page unchanged

**P0-2: Lookup highlights in place instead of hiding the queue** *(OPS 5)*
- [x] The Find box marks matching cards and dims non-matches, keeping every card on the page — answering one customer never blinds the screen for the next one
- [x] A match count is shown ("2 matches"), and clearing is one tap at ≥48px
- [x] Test: with 22 live orders, searching a name that matches one order still renders 22 cards, with exactly one carrying the match style

**P0-3: The undo stays where the tap was** *(DX 1)*
- [x] After an advance into a terminal state (`picked_up`, `abandoned`), the card's grid slot keeps a placeholder tile — same position, same size — carrying the undo control, for as long as `undoRemainingMs > 0`
- [x] The "Just finished" strip stays as it is; this adds the in-place tile, it does not move the strip
- [x] Test: with 20 seeded orders, tap "Picked up" on the **last** card in the Ready section and assert the undo control is inside the viewport with no scrolling, and that tapping it restores the order

**P0-4: The revert control follows the order past the queue card** *(OPS 4)*
- [x] The staff receipt at `/kitchen/orders/[id]` carries the same explicit, logged revert the engine already permits, for `picked_up` and `abandoned` — reached at any time, not for five seconds
- [x] The control asks for a reason (short preset + optional text) and writes a `revert` event; it never deletes and never rewrites the original transition — the append-only trigger is the mechanism
- [x] The receipt refuses to offer a revert the engine would refuse; the button's presence is derived from `STATUS_FACTS`, never from a status literal on the page
- [x] Test: abandon an order, revert it from the receipt at T+30 minutes, assert it is `ready` and on the queue, and assert the event log holds transition → transition → revert with nothing removed

**P0-5: Where the bag is** *(OPS 6)*
- [x] The `ready` transition captures an optional **shelf location** (free text, ≤16 chars: "shelf 3", "warmer left"), entered on the same tap that marks the order ready
- [x] It renders in large type on the Ready card and in the walk-up lookup result — the two places a person is holding a bag
- [x] It is editable afterwards from the card, because the bag moves
- [x] It is a **live operational field, not part of the order snapshot**: it describes where the food is now, not what was ordered. It never appears on a customer-facing receipt and never enters a report
- [x] Test: mark an order ready with "shelf 3", assert the string renders on the Ready card at the queue's minimum type size and in the lookup result

**P0-6: Somebody can write on the ticket** *(OPS 3)*
- [ ] A staff note control on the queue card and the staff receipt, appended to the append-only event log with its instant and actor, never overwriting a previous note
- [ ] Notes render on the card in the same amber treatment customer notes already use, visually distinguished from the customer's own text — a staff note and a customer note are different facts and must not read as one
- [ ] Notes are never shown to the customer on the status page
- [ ] Test: write "customer called, arriving 7:40" on a ready order, reload the queue, assert it renders on the card, is attributed as staff, and appears in the event log with its instant

**P0-7: A ready order past an hour stops looking like one past thirty minutes** *(OPS 11)*
- [ ] A fourth escalation level past a configurable threshold (default 60 min) visually separates "past an hour" from the existing 10/20/30 flags
- [ ] At the pre-close cutoff the queue shows a sized closeout prompt in the same idiom as the C-039 leftover banner — "3 orders have been ready over an hour; close them out before you cash up" — flagged, never auto-swept
- [ ] Nothing auto-abandons. Both evaluators name the refusal to auto-close as correct and it does not change here
- [ ] Test: an order ready 61 minutes renders the level-4 treatment; three such orders produce a banner naming the count; no order transitions without a tap

### Nice-to-Have (P1)

- **P1-1: "Waiting at counter"** *(OPS 5)* — a tap that pins a card to the top of Ready and marks it on every screen, cleared by the pickup transition. Needs an event kind; the operator wants it, and it is the half of Finding 5 that is not layout.
- **P1-2: The shelf field on the walk-up lookup keyboard path** *(OPS 6)* — search by shelf as well as by name and number, for the reverse lookup ("whose is the bag on shelf 3?").

## Non-Goals

- **Printed tickets, label printers, KDS hardware.** Master PRD Non-Goal plus P2. P0-5 is deliberately *not* a printing feature — the operator's own framing is that physical findability is a missing field, not a missing printer.
- **Auto-closing anything.** Both evaluators name "nothing closes an order out on its own" as correct. P0-7 sizes the chore; it never performs it.
- **Station routing / expo split screens.** P2 in the master PRD, and the station model belongs to `prd-menu-under-pressure.md`'s Open Questions.
- **Customer-side cancellation after `accepted`.** Resolved Open Question in the master PRD: no.
- **Per-cook identity on the note or the revert.** Both would be better with a name attached; that is `prd-who-did-it-and-what-leaves.md` and it is a hard dependency on the *value* of P0-6, not on its shipping.
- **A dismiss or mute on the new-order chime.** Deliberate refusal (C-010) and re-affirmed by both evaluators.
- **SMS "your order is ready".** P1-3, unbuilt, and the real fix for counter congestion. Named, not built here.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `Order` | `shelfLocation String? @db.VarChar(16)` — a live operational field, explicitly outside the snapshot | **yes**, one nullable column, additive, no constraint |
| `OrderEventKind` (enum) | one new value: `note` (P0-6). P1-1's "waiting" flag would be a second value | **yes, hand-written** — `ALTER TYPE ... ADD VALUE`, additive, per CLAUDE.md |
| `RestaurantSettings` | one integer for the fourth ready-escalation threshold (default 60), with its CHECK mirrored in the settings screen the way C-023 established | **yes**, hand-written for the CHECK |
| `OrderEvent` | none structurally — the revert (P0-4) and the note (P0-6) are rows on the existing append-only table with the existing trigger | none |

P0-1, P0-2 and P0-3 need no migration at all.

## Invariant impact

1. **Snapshot rule — touched, and this is the one to watch.** `shelfLocation` is a mutable column on `Order`, which is a snapshot table, and that is a genuine tension. It holds because the field describes the *physical present*, not the composition: it is written after placement, edited freely, never rendered on a customer receipt, never read by pricing, and never read by a report. The schema comment must say so, next to the column, in the same voice as the existing `prepWeight` and `quotedLowMinutes` comments. The snapshot regression test is extended to assert that setting and changing `shelfLocation` leaves the rendered receipt and all stored totals byte-identical.
2. **Server is the price authority — untouched.** Nothing here computes or changes money. P0-4's revert deliberately does **not** touch `paymentState`; an order reverted out of `picked_up` keeps whatever payment fact it had, and the money question is `prd-money-that-reconciles.md`'s.
3. **One status module — heavily touched, and the whole point.** P0-1's section order, P0-3's placeholder tile, P0-4's receipt revert and P0-7's escalation all derive from `STATUS_FACTS` and its exported lists — `UNDOABLE_EXIT_STATUSES`, `TERMINAL_STATUSES`, `QUEUE_STATUSES`. No new status literal is introduced on any page. Adding a state must still make the compiler find these readers.
4. **One orderability function — untouched.**
5. **Idempotent placement — untouched.** P0-4's revert is a transition, guarded by the existing `updateMany where: { id, status }` compare-and-set, so two staff reverting the same order produce one revert and one clean refusal.

**Time:** the escalation threshold and the pre-close prompt read the restaurant's timezone through the existing clock; nothing in `packages/core` reads the system clock, and `now` stays a parameter.

## Acceptance criteria

- At 22 live orders on the tablet viewport, "Ready for pickup" is the first section and its first card is above the fold with zero scroll.
- Searching a name with 22 orders live renders 22 cards; exactly one is highlighted; the match count reads 1.
- Tapping "Picked up" on the last Ready card leaves an undo control inside the viewport; tapping it within 5s returns the order to `ready` and writes a `revert` event.
- An order abandoned at 19:48 is reverted from its receipt at 20:05, is `ready` on the queue, and its event log contains the abandon transition *and* the revert — three rows, none removed.
- Marking an order ready with "shelf 3" renders "shelf 3" on the card at ≥18px and in the walk-up lookup; the customer status page for that order contains no such string.
- A staff note written on `#017` survives a reload, renders distinctly from the customer's own note, appears in the event log with its instant and actor, and never appears on `/status/[token]`.
- An order ready 61 minutes carries a distinct treatment from one ready 31 minutes; three of them produce a banner naming "3"; no order changes state without a tap.
- Snapshot regression: setting, changing and clearing `shelfLocation` and appending three notes leaves the receipt and every stored total byte-identical.

## Open Questions

- **(Ops)** Is the shelf location free text or a fixed picker from configured slots? Free text is one session and survives a shelf being rearranged; a picker is countable and un-typo-able but needs a settings screen and goes stale the day someone adds a warmer. **Needs an operator's answer, not a builder's.**
- **(Ops)** Does the Ready section going first cost the kitchen anything? The DX read is that Preparing is the cook's section and cooks work off tickets in front of them; the operator's read is that the counter is the constant reader. Neither evaluator addressed the cook's scroll cost directly, and this is a screen two different jobs share.
- **(Product)** Should a revert out of `abandoned` (P0-4) un-count the no-show in the report retroactively, or leave the no-show recorded with a revert beside it? The append-only philosophy says the second. The GM cashing up on Sunday probably wants the first. These conflict and the report has to pick one.
- **(Ops)** Sixty minutes for the fourth escalation is a guess. What is the number where a ready order is genuinely a problem rather than a slow customer?

## Phasing — one item per session

*(Renumbered 2026-09-04. This section was drafted as C-057–C-062; PRD 1 ranked
ahead of it and shipped C-053–C-058 first, so the two lowest numbers were gone
before this document's first item was built. Items 1–4 slide down into the free
block, items 5–6 take the next free pair. The numbers are bookkeeping — the
order and the dependencies below are not.)*

- **C-059 — Ready comes first, and lookup stops hiding the queue** — P0-1 and P0-2 together; both are pure layout on one page, neither needs a migration, and they are the two cheapest wins in this document.
- **C-060 — The undo where the tap was** — P0-3, the in-place placeholder tile, with the deep-queue Playwright test the existing wrong-advance spec never had.
- **C-061 — The revert follows the order** — P0-4, the receipt-side revert with its reason, derived from `STATUS_FACTS` and guarded by the existing compare-and-set.
- **C-062 — Where the bag is** — P0-5, the `shelfLocation` column with its schema comment and its extension to the snapshot regression test.
- **C-092 — Somebody can write on the ticket** — P0-6, the `note` event kind and its rendering, hand-written `ALTER TYPE` migration.
- **C-093 — A ready order past an hour** — P0-7, the fourth escalation and the pre-close closeout prompt.
