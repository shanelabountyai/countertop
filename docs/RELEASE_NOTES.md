# Release Notes — Countertop

The portfolio-facing history: one entry per backlog item, written for "walk me
through something you built." `docs/PROGRESS.md` is the mechanical version of
the same history.

---

## C-001 — Project scaffold and the gate that guards it

The first commit of a build is where you decide which mistakes are still
possible on the last one. This one closes four of them before any feature
exists.

**A restaurant's day is not UTC's day.** The order number resets at midnight
*in the restaurant's timezone*, and every sales report buckets by the
restaurant's hours. So CI runs the unit suite twice — once under `TZ=UTC` and
once under `TZ=Pacific/Kiritimati`, a zone a full day ahead — and demands
identical results. A test suite that only ever ran under one timezone would
pass all the way to the first evening a report showed yesterday's numbers. Five
lint rules back it up: `new Date(string)`, `Date.parse`, the `get*`/`set*` date
accessors, `getTimezoneOffset`, and `toISOString().slice(0,10)` are all compile
errors, because each is a silent read of whatever timezone the server process
happened to boot in.

**The pricing engine may never look at a clock.** A sixth rule, scoped to the
domain package, bans `Date.now()` and `new Date()` outright there. The engine
takes the current instant as a parameter. That's the difference between a bug
you can reproduce at will and one that only appears at 11:59pm.

**The database is rebuilt from scratch on every CI run**, from the committed
migration history, and then checked for drift against the schema file. The
constraints this project depends on — the unique daily order number, the
idempotency key that makes a double-tapped checkout button produce one order
instead of two — only exist in hand-written migration files. A schema pushed
directly from the model file would silently drop every one of them, and the
tests would still be green.

**End-to-end tests run against a production build, not a dev server**, on this
project's own dedicated port. Accessibility checks (axe, WCAG 2.1 AA) run from
the first commit rather than being added after the kitchen screens exist —
those screens will be read at arm's length by someone wearing gloves, and
accessibility retrofitted is accessibility argued about.

Nothing is built yet. Everything that would be expensive to add later is.

---

## C-002 — The part that decides what people get charged

Every restaurant ordering system is, underneath, one function: given what a
customer clicked, what does it cost and can the kitchen actually make it? This
is that function, written before any screen exists and tested against fixtures
calculated by hand on paper first — 53 of them, all confirmed failing before a
line of the engine was written.

**"No onions" is a thing you can order.** It is not the absence of a click; it
is a selection with an intensity of *none*, carried all the way to the kitchen
ticket where it will be rendered differently from an addition. That distinction
is the whole reason this product exists — a removal transcribed like an
addition is the phone-order bug that sends someone a burrito covered in the one
thing they can't eat.

It also created the sharpest decision of the session. A negation must **not**
count as a choice. If it did, a customer could satisfy a required "choose your
protein" group by selecting *chicken → none* and receive a burrito with no
protein in it, with nothing in the system aware a choice had been skipped. So
negations don't count toward a group's minimum or its maximum — "no onions plus
three toppings" is three picks, not four. Both directions have a test.

The related case: if the kitchen has run out of onions, "no onions" is still a
perfectly good order. A naive availability check refuses it. This one doesn't,
and that same rule means a cart holding "no onions" won't be flagged when
onions get 86'd mid-rush.

**The tax is exact, on purpose.** $10.00 at 8.25% is 82.5 cents — dead on the
rounding boundary, which is where money bugs live. The rate is stored as an
integer in parts per million and the tax is computed with integer arithmetic
only, so the half-cent rounds up because a rule says so, not because a floating
point number happened to land on the generous side. Basis points were the
obvious choice and were rejected for a boring reason: New York's 8.875% is
887.5 basis points, and you cannot store that.

**The client's price is evidence, not input.** The function that compares what
the browser claimed against what the server computed can only return "here is
the mismatch, log it." There is no code path where it returns the client's
number, because there is nowhere for that number to go.

---

## C-003 — Making "menu edits can't touch a placed order" a thing you can prove

The rule is easy to state and easy to violate: once an order is placed, it is a
**copy** of what the customer composed, not a set of pointers back into a menu
that keeps changing underneath it. Every field a receipt or a kitchen ticket
shows — item name, category, the name of each modifier group, each option, what
that option cost, the tax rate that was in force — is a column on the order
itself. Rendering a receipt touches no menu table at all.

The test is the interesting part. It places an order, then goes through every
menu row that order was built from and wrecks it: renames the category, renames
and reprices the item and marks it sold out, renames a modifier group and
changes its rules, renames and reprices an ordered option, **deletes an ordered
option outright**, and unhooks a group from the item. Then it asserts the
receipt is byte-for-byte what it was. If anyone ever adds a join back to the
menu to render a ticket, that test stops passing.

That "deletes an ordered option outright" step forced a real decision. The
conventional move is a foreign key from the order back to the menu row, set to
refuse deletion. It gives you clean analytics — and it also means any menu item
a single customer ever ordered can never be deleted, ever, and a manager
cleaning up last summer's specials just gets an error. The other conventional
option, blanking the reference on delete, is worse: it *edits a placed order*,
which is the one thing this whole design exists to prevent. So the reference is
a plain string with no foreign key. Deleting the option leaves a dangling id
that nothing reads, and the receipt doesn't notice.

**The order number is decided by the database, not by the code.** Two customers
checking out in the same second both want #47. There is no "check whether 47 is
taken, then take it" — that has a window between the check and the write, and a
Friday rush is a machine for finding windows. The pair (business day, number) is
unique in the database; both writes go, one loses, and the loser retries at 48.
A test fires eight simultaneous placements at the same number and asserts
exactly one survives.

**The order history cannot be edited or deleted.** A database trigger refuses
both. When a cook fat-fingers "ready" and undoes it, the undo is written as a
new event that says a revert happened — the mistake stays in the record. It also
means an order that has any history cannot be deleted at all, which the tests
confirm, and which is the correct answer for a record of money changing hands.

---

## C-004 — One table that every screen has to agree with

An order moves `placed → accepted → preparing → ready → picked_up`, with a
cancellation, a no-show, and an undo hanging off it. That is a small enough
lifecycle that the tempting thing is to write the rules where they are needed:
the kitchen queue filters on a couple of status strings, the checkout throttle
counts a couple more, the customer's page stops polling on a third set. Three
lists, written on three different days, that all have to mean the same thing.

They never do. In the previous project of this series the same shape shipped a
real defect: one reader knew about a state the others didn't, and orders in it
quietly stopped appearing.

So this build has one table. Each status answers nine questions in one place —
what comes next, what an undo puts it back to, whether it counts as work the
kitchen still owes, whether it's finished, whether it should be chiming for
attention, whether it belongs on the queue, and who (if anyone) can still
cancel it. Every list any screen uses is a *filter over that table*, computed
at import: the throttle's open-order set, the queue's groupings, the polling
stop condition, the alert set. Adding a state to this system doesn't require
remembering the readers — the type system refuses the new state until all nine
questions are answered, and the lists update themselves.

Two of those answers are worth their own sentence. **A `ready` order is on the
queue but doesn't count as open**, because the food is already made: it should
keep aging in front of the cooks, but it must not hold the "we're too busy"
checkout gate closed. And **an order that's already been picked up can still be
reverted** — the whole point of a five-second undo is that it covers the *last*
tap, which is exactly the one a fat finger gets wrong. A cancelled order can't
be, because cancelling may have issued a refund and un-cancelling would have to
re-charge; it refuses with a message that says to place a new order instead.

**Acknowledging a new order is not a separate step.** The kitchen tablet chimes
and flashes until someone taps the card, and that tap *is* the
`placed → accepted` transition — one function call, not an "acknowledge" flag
that a later "accept" button has to stay in sync with. The alert itself is
derived from the order's state rather than from a "new order arrived" event, so
reloading the page mid-rush doesn't silence anything.

**Every refusal says why.** `applyTransition` doesn't return false — it returns
a reason (`customer_cancel_too_late`, `abandon_not_allowed`,
`revert_not_allowed`, …) plus the sentence a staff member should read. That
matters for the tests as much as the UI: a test that only asserts "rejected"
passes against a machine that rejects everything. The test file writes out the
full 7-statuses × 5-actions grid longhand — 35 cases, every one naming either
the state it lands in or the reason it's refused — so changing a rule means
changing this table and defending it, rather than watching the assertions bend
to whatever the code now does.

The last piece is small and stops a specific kind of Friday: an advance can
carry the state it *expects* to move to. Two cooks tapping the same card half a
second apart used to mean the order skipped a state. Now the second tap names a
state that's already behind, and is refused.

---

## C-005 — A cart that cannot lie about the price

A cart is a place where food waits. While it waits, the menu moves: the kitchen
runs out of avocado, someone bumps the price of guacamole. Most online ordering
handles this by not handling it — the cart remembers what it was told at
add-time, and either charges a stale price or silently charges a new one.

So this cart stores almost nothing. Each line holds *what the customer
composed* — the item, the options, the intensities, the note — and the server
re-prices all of it from the live menu on every single read. The one price the
cart does remember is display-only, and it exists for exactly one purpose:
noticing that today's price is different from the one the customer saw.

That makes the two ugly cases fall out of the same function. **An option that
was 86'd while a burrito sat in the cart** comes back from the re-check as a
problem on that line, by name — "Guacamole is sold out" — with checkout blocked
until it's removed or fixed. **A price that moved** comes back as `old → new` on
that line, with checkout blocked until the customer says yes. Neither is a
special case bolted onto checkout; both are what "re-check the cart against the
menu as it is right now" returns.

Confirming a price change doesn't set a flag. It **re-baselines the line** — the
cart now remembers the new price, so there is no longer a change to confirm.
One fact instead of two facts that can disagree.

The cart lives in a single session cookie, with no database table behind it,
and that is safe for a specific reason rather than a lazy one: the cookie
carries no authority. Every number that reaches an order is computed on the
server from the live menu. A customer who edits their own cookie to claim a
burrito cost one cent doesn't get a cheap burrito — they get a confirmation
dialog reading "$0.01 → $13.45", and then they get charged $13.45. There's a
test that says so.

The quantity cap (20) and the 140-character note cap are enforced in the same
place as everything else — the one orderability function the menu screen, the
cart, and placement all call. Three call sites, one answer.
