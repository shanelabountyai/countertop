# PRD: The Customer Who Is Not In The Room — the ordering funnel and the wait

**Sample business:** "Firebird Kitchen" and Dana, who has never been there, ordering from a link a colleague sent her at 12:15pm
**Status:** Draft v1 — derived from the 2026-09-01 evaluations. Every requirement traces to a numbered finding in `review-dx.md`, with two supporting notes from `review-systems.md`; the trace is named inline.
**Relationship to the master PRD:** completes User Story 1 ("a categorized menu **with photos** and prices" — never built and never in Non-Goals), and completes the resolved Open Question "customers cannot cancel after `accepted`: call the restaurant" by making the restaurant callable.
**Consensus:** one lens, eight findings. It ranks on volume and cheapness, not on agreement — and on the fact that this is the only surface in the product where a customer decides whether to order at all.

---

## Problem Statement

The product's founding premise is that phone orders tie up staff. It currently resolves both of its worst customer moments with a phone call it does not enable.

**Dana** orders from a link a colleague sent her, has never been to Firebird Kitchen, and gets "Ready for pickup — come to the counter". Which counter, on which street? There is no phone number, street address, map link, or opening-hours display on `/`, `/menu`, `/cart`, `/checkout` or `/status/[token]`, and `RestaurantSettings` has no such columns. She goes back to Google, and the third-party listing this product exists to route around is where she finds the answer. Worse: her order is cancelled `out_of_item` at 12:40, the page apologises, and gives her no way to ask what to do about lunch — while telling her, in the abandoned case, "Call the restaurant if that is wrong." *(DX 2)*

**12:10pm, quoted 15–25 minutes.** The kitchen is slammed and the order sits in `preparing`. At 12:55 the status page — which polls faithfully every five seconds — still reads **"Should be ready any minute now"**, which it has now said forty times. The kitchen screen *knows* this order is overdue: `queueAging` produces `overdue` and the card renders "— running late" in bold red past fifteen minutes. The customer screen has the same fact available and chooses the cheeriest sentence it owns. Combined with having no phone number, she has no recourse at all. *(DX 11)*

**20:39.** Close is 21:00, cutoff 15 minutes, so the last order is 20:45. A customer opens the menu, spends six minutes composing three burritos with intensity choices for a family, taps Checkout at 20:46 and gets "We stop taking online orders at 20:45." The cart survives; nothing about it can be placed; the six minutes were spent after the outcome was already decided. `orderingWindow()` already computes `lastOrderMinute` — nothing reads it until the door is shut. *(DX 3)*

**Before any of that**, the menu is 25 rows of name-and-price across five categories in one continuous scroll, with no descriptions, no photos and no category navigation. `MenuItem.description` is declared in the schema and is selected and rendered **nowhere**. A first-time customer scanning one-handed cannot tell a "Torta" ($11.50) from a "California burrito" ($12.95) except by price. She taps into three composers to read what they are — each a full page load and a back — or she orders the thing she recognises, which is chips. *(DX 4)*

**In the composer**, the default intensity choice is `null`, which maps to the `''`/"Skip" pill — and the selected pill style is black fill. So an untouched intensity group renders **"Skip" filled black**, four of them stacked down the page, carrying the same visual weight as the "Add to cart · $16.20" button. A hungry customer reads four black pills as "these are handled" and gets a burrito with no chipotle, no salsa verde, no pico and no cilantro. She blames the restaurant. This is the transcription bug the product exists to kill, arriving through the UI instead of the phone. *(DX 5)*

**And when validation fails**, one generic line appears above the button — "Fix the choices above before adding this to your cart" — 1,700px below the Protein group that is actually wrong. Nothing moves focus, nothing scrolls, and the sentence says "above", which is technically true of the entire page. *(DX 6)*

## Users and the moment of use

- **A first-time customer**, one-handed, on a phone, deciding in under a minute whether to order here or somewhere else.
- **A customer forty-five minutes into a twenty-five-minute wait**, who wants to be told the truth.
- **A customer at 20:39**, who does not know the door is about to close.
- **A customer whose tab got evicted**, who currently has no way back to their own order.

## Requirements

### Must-Have (P0)

**P0-1: The restaurant is findable and callable from every customer screen** *(DX 2)*
- [ ] Name, street address, phone as a `tel:` link, and today's hours in the footer of every customer route — `/`, `/menu`, `/cart`, `/checkout`, `/status/[token]` — sourced from `RestaurantSettings`
- [ ] The cancelled and abandoned status views carry the `tel:` link prominently, not only in the footer — those are the two screens whose copy already tells the customer to call
- [ ] Today's hours are computed in the restaurant's timezone through the existing clock, and read the same `StoreHours` rows the gate reads — one source, not a second copy
- [ ] The fields are editable on the existing settings screen, in the C-023 idiom
- [ ] Test: the status page for a cancelled order exposes a `tel:` link; the menu footer renders today's hours matching the gate's own answer

**P0-2: The status page admits an order is late** *(DX 11)*
- [ ] Past the top of the quoted range, the headline acknowledges it — "Running a bit behind — the kitchen still has your order" — using the **same** `overdue` computation the queue card uses, not a second one
- [ ] The quoted range is already snapshotted on the order (C-042), so the comparison is against what this customer was actually promised, not against today's settings
- [ ] "Should be ready any minute now" survives only for the window between the range's low end and its high end
- [ ] Test: an order whose elapsed time exceeds its snapshotted quoted high end renders the late copy, not "any minute now"; an order inside its range renders the range

**P0-3: A last-call warning before the door closes** *(DX 3)*
- [ ] `GateResult`'s open branch carries `lastOrderMinute` — it is already computed at `orderingWindow()` and thrown away
- [ ] When the gate is open and `lastOrderMinute − now ≤ 30`, the menu, cart and checkout show "Last online orders in 12 min", from **one component**, because the gate is already one code path with three triggers and the warning must not become three
- [ ] The same treatment fires when the auto-pause threshold is close, if that is cheap to express; if it is not, the requirement is the hours case and the pause case is P1
- [ ] Test: with hours set so the cutoff is 10 minutes out, `/menu` renders the warning; 40 minutes out, it does not; and the warning renders identically under `TZ=UTC` and `TZ=Pacific/Kiritimati`

**P0-4: The menu says what the food is** *(DX 4)*
- [ ] The menu row renders `MenuItem.description` under the name when present — the column is already in the schema and read by nothing
- [ ] A sticky category strip jumps to each `<section>`, so five categories are not one continuous scroll
- [ ] The composer header renders the description too
- [ ] Descriptions are editable in the existing menu editor, phone-viewport, per P0-13
- [ ] Test: an item with a description shows it on `/menu` without opening the composer; the category strip navigates to each section

**P0-5: An untouched choice does not look like a made choice** *(DX 5)*
- [ ] An untouched intensity group renders **no** filled pill; "Skip" takes the selected style only once deliberately tapped
- [ ] The untouched state carries a visible hint that no choice has been made
- [ ] This is about rendering the *absence* of a choice. The WRITEUP records "no default-included options" as a deliberate model decision and that decision does not change
- [ ] Test: render the composer with no selections and assert no pill in any intensity group carries the selected style

**P0-6: The error message takes you to the error** *(DX 6)*
- [ ] On a failed add-to-cart, focus moves to the first violating group's fieldset
- [ ] The general message names the group ("Choose a protein"), not "the choices above"
- [ ] Focus movement is announced to assistive technology, and the axe assertions on the composer continue to pass
- [ ] Test: submit a burrito with no protein and assert `document.activeElement` is inside the Protein fieldset and the message contains "protein"

### Nice-to-Have (P1)

- **P1-1: A way back to your own order** *(DX 10)* — placement appends the status token to a `recent-orders` cookie (the same mechanism the cart already uses), and `/menu` shows a strip: "Your order #005 is cooking — track it". No enumeration surface, because the token is still the only key and nothing is looked up by number. **This deliberately revisits a recorded decision**: the WRITEUP records "lose the link and the order is unreachable from the customer side (C-014)" with "the counter staff" as the recovery path — which is a person interrupting the expo mid-rush, the exact interruption the product exists to eliminate. P1-3's SMS is the real fix and is unbuilt; this costs a cookie in the meantime.
- **P1-2: Ordering for a group is not punished** *(DX 12)* — `−`/`+` on each cart line so 1 → 2 is a tap rather than a full navigation into a burrito composer, and "View cart (6)" in the menu header so the count is visible without being on the cart page.
- **P1-3: Photos** *(DX 4)* — the master PRD's User Story 1 asks for them and they are in neither Non-Goals nor the WRITEUP's caveats. M, plus a migration and an asset story.
- **P1-4: Stop collecting the phone number, or use it** *(SYS 7)* — the field is captured for the P1-3 SMS stub, which is unbuilt, so it is collected and used by nothing. Either send the link or stop asking. The retention half of this finding lives in `prd-who-did-it-and-what-leaves.md`.

## Non-Goals

- **Customer cancellation after `accepted`.** Resolved Open Question: no, call the restaurant. P0-1 makes that answer actually work; it does not change the answer.
- **Queue position ("3 orders ahead of you").** Open Question, deliberately left non-blocking because it leaks pace information some operators dislike.
- **SMS / email "your order is ready".** P1-3 in the master PRD, unbuilt. P1-1 here is explicitly the cheap placeholder, not a replacement.
- **Customer-side lookup by name, phone or order number.** Recorded in the WRITEUP: all three are guessable and a lookup form is the enumeration hole the token closes. P1-1's cookie holds the token and adds no lookup.
- **Order-ahead time slots.** P1-2 in the master PRD.
- **Reorder from a past order.** P2.
- **Accounts or login.** The tokenized link is the pattern and it stays.
- **Changing the honest-range estimate rule, or showing an estimate while paused.** Both are deliberate and both are correct; P0-2 makes the *late* case honest, which is the same discipline applied one step further.
- **Default-included modifier options.** Recorded model decision; P0-5 is about rendering, not defaults.

## Data model impact

| Table | Change | Migration |
|---|---|---|
| `RestaurantSettings` | `name`, `addressLine`, `phone` (nullable text) — the singleton row | **yes**, additive, three nullable columns |
| `MenuItem` | **none** — `description` is already declared and simply never read | none |
| `MenuItem` (P1-3 only) | an image reference | **yes**, plus an asset story |
| `Order` | none. P1-1's cookie holds the existing `statusToken` and nothing new is stored server-side | none |
| Everything else | none. P0-2, P0-3, P0-5, P0-6 and P1-2 are all pure UI over data that already exists | none |

## Invariant impact

1. **Snapshot rule — untouched, with one trap.** P0-4 renders `description` from the **live menu** on `/menu` and in the composer, which is correct — those are live-menu surfaces. It must not follow onto the order confirmation, the receipt or the status page, where an item's name is a snapshotted copy and a description would be a menu join. The snapshot regression test is extended: rename an item *and change its description*, then assert the placed order's receipt is byte-identical.
2. **Server is the price authority — untouched.** P1-2's `−`/`+` recomputes the line server-side through the existing cart path exactly as a composer save does; the client's arithmetic is display-only, and a quantity change that crosses the configured cap is refused server-side.
3. **One status module — touched lightly.** P0-2's late copy derives from the same `overdue` computation the queue card uses and from `STATUS_FACTS`, not from a status literal on the status page. The existing `status === 'cancelled'` literal there is legitimate (it renders one specific view) and does not multiply.
4. **One orderability function — untouched.** P0-3's warning reads the gate's result; it does not compute its own answer about whether the restaurant is open. The gate stays one code path with three triggers, and the warning is one component reading it — three call sites, one answer, exactly the existing rule.
5. **Idempotent placement — untouched.** P1-1's cookie is written after a successful placement and holds a token; a replay of the same idempotency key must append the same token once, not twice.

**Time:** today's hours (P0-1) and the last-call countdown (P0-3) are computed in the restaurant's configured timezone. The lint bans stay on; the countdown is minutes arithmetic against `lastOrderMinute`, not date construction.

## Acceptance criteria

- Every customer route renders the restaurant's name, address, a `tel:` link and today's hours; today's hours match what the gate would say about today.
- A cancelled order's status page exposes a `tel:` link outside the footer.
- An order whose elapsed time exceeds its **snapshotted** quoted high end renders the late copy; one inside its range renders the range; neither ever renders "any minute now" past the high end.
- With the cutoff 10 minutes out, `/menu`, `/cart` and `/checkout` all render the same warning string from the same component; at 40 minutes out none of them does; identical under `TZ=UTC` and `TZ=Pacific/Kiritimati`.
- An item with a description shows it on `/menu` with no composer opened; the category strip navigates to all five sections.
- A freshly rendered composer has zero pills carrying the selected style in any intensity group.
- Submitting a burrito with no protein leaves `document.activeElement` inside the Protein fieldset and the message naming "protein"; axe passes.
- Snapshot regression: rename an item and rewrite its description, assert every placed order's receipt is byte-identical.

## Open Questions

- **(Product)** P1-1 revisits a decision the WRITEUP recorded deliberately. The evaluator argues the recorded recovery path (walk to the counter) is the exact interruption the product exists to eliminate. **Is the recorded decision re-opened, or does it stand until P1-3's SMS ships?** A human has to say; the convention here is that recorded decisions are not re-opened silently.
- **(Product)** Thirty minutes for the last-call warning is a guess. Too early and it reads as pressure; too late and it does not save the six minutes it exists to save. What is the number?
- **(Product)** Photos are in the master PRD's User Story 1 and were never built or explicitly deferred. Are they in scope for a learning build, or is the honest move to move them to Non-Goals and say why?
- **(Product)** Does the customer's phone number keep being collected? It feeds an unbuilt feature today. Sending the status link by text is the reason it exists; not collecting it is the data-minimization answer. The two evaluators who touched this pull opposite ways.

## Phasing — one item per session

- **C-077 — The restaurant has an address and a phone** — P0-1, three nullable columns on the settings singleton, the footer on five routes, and the `tel:` link on the two views whose copy already asks for a call.
- **C-078 — The status page tells the truth about being late** — P0-2, reusing the queue's `overdue` computation against the snapshotted quote.
- **C-079 — Last call** — P0-3, `lastOrderMinute` carried on the open gate result, one component, three surfaces, TZ×2 test.
- **C-080 — The menu says what the food is** — P0-4, `description` rendered and editable, plus the category jump strip.
- **C-081 — An untouched choice looks untouched** — P0-5 and P0-6 together; both are composer-local and both are the same class of defect (the UI stating something the customer did not say).
- **C-082 — A way back to your own order** — P1-1, gated on the Open Question above.
- **C-083 — Ordering for six** — P1-2, cart quantity steppers and the header count.
