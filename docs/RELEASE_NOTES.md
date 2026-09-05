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

## C-006 — Placing the order

An order is the moment a cart stops being a wish and becomes a promise, and
this is the session that made the promise binding.

**A placed order is a copy, not a link.** Every name and every price is written
into the order's own rows at placement: the item name, the category, the base
price, each option's name, and exactly what that option added to the price. The
receipt renders with zero joins to any menu table. Rename the burrito, reprice
it, 86 it, delete an option outright — the order is byte-identical afterwards,
and there is a test that mutates every referenced menu row and asserts precisely
that. The order numbers on it are the server's arithmetic, not the browser's.

**The order number is taken, not chosen.** Every order gets the next number for
the restaurant's own calendar day — #001, #002 — resetting at the restaurant's
midnight, not UTC's. That distinction is not pedantry: a Los Angeles kitchen
would otherwise roll its numbers over at 5pm, mid-dinner service. Twelve
checkouts landing in the same instant get twelve different numbers, because the
number is claimed with a database constraint and the loser of each race simply
takes the next one. No "check if 47 is free, then write 47" — that has a window,
and windows get hit at exactly the moment they cost the most.

**A double-tap is one order, and the same answer twice.** Each checkout attempt
carries a key. The second submission — a fat-fingered tap, a retried request, an
impatient reload — returns the *first* order's confirmation, not a new order and
not an error. Idempotency here means "the same answer", not merely "no
duplicate": a second tap that returned a different order number would send the
customer to the counter asking for food nobody is making. And the replay is
answered before the menu is even consulted, so a customer whose retry lands
after the guacamole runs out is not told their order failed when it is already
on the grill.

**A tampered total is logged, not honoured.** A request claiming the burrito
costs nothing gets an order at the real price and a `total_mismatch` event in
the append-only log saying what was claimed and what was charged. The client's
number is evidence. It is never an input.

The customer's confirmation comes back with the order number, their name, their
status link and the full priced receipt — and no internal id anywhere in it.
The number and the name are what a human calls across a counter; the UUID is
the server's business and stays there.

## C-007 — The screen a customer actually orders on

Until now this project was an engine with no windows. It could price a burrito
five different ways and refuse the wrong ones, and there was no burrito on a
screen anywhere. C-007 is the menu and the item composer.

**"NO onions" is a thing you pick, not a thing you fail to pick.** Every option
in an intensity group offers five choices — Skip, No onions, Light, Regular,
Extra — and the negation is one of them. That is the whole reason this product
exists. A phone order transcribed as "onions" when the customer said "no
onions" is a remade burrito and an angry Friday; a negation that is a real
selection travels all the way to the kitchen card as one. It is drawn in red
and struck through, it costs nothing, and — the part that would actually ship
food wrong — it does not satisfy a required group. "No chicken" is not your
protein choice.

**The price updates as you compose, and it is not the price you pay.** Add
guacamole and the button reads $13.45. Choose cheese at "extra" and it reads
$14.70, because "extra" costs the option's own price plus its extra surcharge.
Every one of those numbers is computed by the same functions the server uses at
cart-add and again at placement — not a second implementation that agrees today
and drifts next quarter. What the browser shows is a preview. What the database
stores is the server's own arithmetic.

**A blocked order says what is missing.** Skip the protein and the Add button
does not go grey and silent — it answers, "Choose your protein." A disabled
button explains nothing, cannot be focused by a keyboard or a screen reader,
and is why people phone the restaurant instead. And the requirements are shown
as hints from the start rather than as errors before anyone has touched
anything: a form that scolds you on arrival teaches you to ignore it.

**Sold out is shown, not hidden.** A burrito the kitchen has run out of is on
the menu, greyed, labelled. Removing it makes the site look broken to the
person who came for it. And "no onions" stays orderable when the kitchen is out
of onions — asking for none of a thing there is none of is trivially
satisfiable, and refusing it would be absurd.

The cart totals the composed lines, flags anything that changed under it, and
says plainly that checkout arrives in a later session. A button that leads
nowhere would be worse.

## C-008 — The screen the kitchen actually works from

A queue screen is read from four feet away, by someone holding a hot pan, with
a glove on. That constraint decides almost every choice on this one.

**The order number is the biggest thing on the card, and the advance button is
the biggest thing you can touch.** Tap targets are at least 48 pixels; the
advance is bigger still, because it is the tap that happens two hundred times a
shift. The item lines are large enough to read standing up. There is nothing
behind a hover, nothing behind a "show more" — the largest seeded order has
five lines and the card shows five lines.

**"NO onions" is not a word on a list.** It is inverted, white on red, in
capitals, sitting next to "Guacamole" rendered as ordinary text. A removal that
looks like an addition is the phone-order defect this product was built to
kill, and a queue card is the last place it can still happen.

**Two clocks, because a slow ticket and a cold pickup are different problems.**
Every card shows how long the *customer* has been waiting — from the moment
they ordered, not from the last time a cook touched it, so tapping "start
cooking" cannot make a late order look fresh. Past fifteen minutes the card
turns red. An order that is *ready* gets a second clock, from the moment the
food hit the shelf, escalating at ten, twenty and thirty minutes: that one is a
no-show taking shape, and it is why the "no-show" close-out is its own button
and its own recorded outcome, distinct from a cancellation.

**Every forward tap can be taken back for five seconds.** The undo is not a
flag in the browser — it is read from the order's own history, so it survives
the card jumping to another column, a reload, or a second screen. And it only
appears after a forward move: "undo" after a step backwards would walk the
order further back, which is not what anyone means by the word. Moving back
deliberately is a separate, always-available, always-logged control.

**Two cooks tapping the same card is the normal case.** The second tap is
refused by the database, not by hope: the write only lands if the order is
still in the state it was read in. Nobody skips a step, nothing is silently
overwritten, and every move — forward, backward, cancelled, closed out — is
another row in a log that only ever grows.

And the walk-up moment — "I'm here, where's my food" — is one box that takes
either a name or an order number, in the same shape the screen prints it.

## C-009 — The screen watches itself

Nobody in a kitchen reloads a page. The queue now keeps itself current: a new
order appears on every screen within a few seconds of a customer placing it,
and a card advanced on the expo's screen moves on the line cook's without
either of them touching anything.

**Every screen agrees, because the server decides what "current" means.** The
browser never compares clocks or timestamps. It holds a token the server gave
it, hands it back a few seconds later, and is told one thing: still current, or
not. A screen whose clock is ten minutes fast is a screen that behaves
identically to every other one.

**The tab you are not looking at costs nothing.** Move the queue behind the POS
window and it stops asking entirely; bring it back and it catches up
immediately rather than waiting out a timer.

**And the minutes on a card actually tick.** "12 min since ordered" was true
when the page last rendered; now it stays true, which is the difference between
an aging flag that means something and a number that turned red at some point
this morning.

The mechanism is deliberately small: the screen is told *that* something
changed, not *what*, and re-draws itself from the server. That is one place a
ticket is rendered instead of two, and it is the same message a push connection
would deliver — so moving off polling later changes how the message arrives and
nothing about what happens when it does.

## New orders announce themselves

A queue screen that shows a new order but does not say anything is a queue
screen someone discovers eight minutes later. An arriving order now rings a
chime, flags its card, and keeps ringing until a cook taps Accept.

**Accepting the order is the acknowledgment.** There is no "dismiss", and no
separate accept chore afterwards — the tap that stops the noise is the same tap
that tells the customer the kitchen has the order. The two cannot drift apart,
because they are one action.

**It survives a reload, a crashed tab, and a screen plugged in late.** The alert
is not a notification fired when the order arrived; it is a fact about an order
nobody has accepted. Reload the screen mid-rush and it starts ringing again.
Open a second screen and it is already ringing there.

**Searching for one order cannot silence the others.** The lookup box filters
what is on screen; it does not filter what the kitchen is being told about.

**And a muted screen says so.** Browsers refuse to play sound on a page nobody
has touched — which, on a wall-mounted screen, is every page. Rather than
failing quietly into exactly the silence this feature exists to prevent, the
screen shows a "this screen is muted" button until someone taps it once.

## The restaurant can close the door

Online ordering now stops when it should — and it stops in one place, so what
the customer is told, what the button does, and what the server accepts can
never disagree.

**Three reasons the door closes, one mechanism.** Staff hit "pause new orders"
from the kitchen screen. The kitchen hits its own order limit and pauses
itself, resuming when the queue drains. Or it is simply outside the hours the
restaurant keeps. All three produce the same gate, asked by the cart, by
checkout, and again by the server when the order is actually submitted.

**A customer who is told no is told why, and when.** Not "ordering
unavailable" — "we open at 11:00 today", "we stop taking online orders at
20:45, fifteen minutes before we close, come by the counter", or whatever the
cook typed into the pause box. A closed sign with no time on it is a customer
who does not come back.

**Staff see the real answer, not the switch.** The kitchen screen shows whether
ordering is actually open, so a restaurant that auto-paused at its order limit
says so in the same place the pause button lives — rather than leaving a cook
to wonder why the tickets stopped.

**Pausing never touches an order already placed.** The gate is asked about new
orders and nothing else, and a customer retrying a submission for food already
on the grill still gets their order back rather than a closed sign.

**And checkout itself is here**: name, optional phone, an order note for "blue
Honda out front", and an order number on a receipt. Placing twice by accident
still produces one order.

## When the kitchen runs out

Restaurants run out of things mid-service, and it is rarely the whole dish —
it is the avocado. Countertop now takes both, from one screen the kitchen can
reach with one hand.

**Two grains, because "out of guacamole" is not "out of burritos."** Mark a
whole item sold out, or mark a single option sold out and leave everything
else orderable. Out of avocado, the burrito still sells.

**A sold-out item stays on the menu, marked sold out.** It is not quietly
removed. A customer who cannot find the burrito assumes the site is broken; a
customer who sees it greyed out knows the kitchen ran out and orders something
else.

**"No onions" still works when the onions run out.** Asking for none of a
thing there is none of is not a problem to solve, and the screen does not
pretend it is.

**A cart that already held it is flagged, not silently repriced or emptied.**
The customer is told which line is affected and checkout waits until they fix
it — the same answer the server gives if they try anyway.

**And an order already placed does not change at all.** It was copied when it
was placed. The ticket on the kitchen line still says guacamole, whatever the
menu says thirty seconds later.

## Ready when it says it will be — honestly

**"About 15–25 min," never "20 min."** Countertop quotes a range, because a
single number is wrong the moment it passes and a customer who was promised
20 minutes is annoyed at 21. A range that holds is worth more than a precision
that does not.

**The quote moves with the queue.** It is the restaurant's own prep time plus
what is already on the line — recalculated every time the checkout page loads,
off the same count that decides whether the kitchen is at capacity.

**While ordering is paused, there is no time promise at all.** The pause
message takes its place. A restaurant that is not taking orders does not tell
you when your food will be ready.

## A link that answers "is it ready yet?"

**The receipt hands you a link, and the link is your order.** Order number,
your name, everything you asked for, and what it came to. Not a login, not an
account — one link, printed the moment you order.

**It updates itself.** Leave it open on the walk over and the page moves from
"Order received" to "Cooking now" to "Ready for pickup" without a reload and
without a refresh button. Once your food is in your hand, the page stops
asking — a finished order has no more news.

**The wait shrinks as you wait.** The estimate on the status page is the same
honest range from the checkout, minus the minutes already gone. When it runs
out, the page says "any minute now" rather than counting down to a zero it
cannot promise.

**A cancelled order says so, and says why.** Not a silent status change and not
a generic failure: the reason the kitchen picked, written for the person
waiting for the food — "The kitchen ran out of something in this order" —
plus whatever they typed. That is the call the restaurant no longer has to
make.

**The link is unguessable, and the order number is not the key.** #047 is a
counter; anyone could count. The status link is 128 bits of randomness, and it
is kept out of search engines.

---

## Changing a price without breaking a night

The menu gets edited on a phone, one-handed, standing at a prep table between
rushes. That is the device this screen was built for — not a laptop in an
office, which is where menu editors are usually designed and nowhere near where
they are used.

**Nothing saves without showing you the number.** Type a new price, tap review,
and the screen puts the old price beside the new one in large type: *Was
$10.95, will be $109.50.* That is the whole guard, and it has to be, because
$109.50 is a perfectly valid price — no amount of validation can tell it from
one you meant. What software can do is refuse to publish it silently.

**A shared modifier group tells you what else it touches.** One "Salsa" group
serves the burrito and the bowl. Making it required takes two seconds and
changes an item you were not thinking about — so before it applies, the screen
names every item, in full, not "affects 2 items". Deleting one warns the same
way, then removes it cleanly from each.

**Orders already placed do not move.** Reprice a burrito to $99 and every
ticket already on the line keeps the price it was ordered at, on the kitchen
card and on the customer's status page both. A placed order is a copy, not a
live lookup — this is the promise the whole system is built around, and the
menu editor is where it gets tested hardest.

**Built for gloves and thumbs.** Every button and every field clears 48 pixels,
nothing runs off the side of a 390-pixel screen, and cancel is a link rather
than a second button — so walking away from a change you did not mean to make
is never one mis-tap from saving it.

---

## What actually sold, in the restaurant's own hours

The report answers the questions an owner asks on a Sunday night: what sold,
when the rush really is, what people add to it, and how often food gets made
and never collected.

**The hours are the restaurant's hours.** A report bucketed in UTC would tell a
California kitchen its dinner rush happens at midnight — and every test would
still pass on a developer's laptop. The day and hour buckets come from the
restaurant's configured timezone, and the test suite runs twice under two
deliberately hostile timezones to keep it that way.

**Only food someone took counts as a sale.** An order still on the pass is
shown as still open rather than quietly booked, a cancelled order counts toward
nothing, and food made for a customer who never came is its own number — the
no-show rate — over the orders the kitchen actually finished. When nothing has
finished yet the rate reads "—", not "0%", because those are different facts.

**Attach rates, counted per plate.** "62% of burritos add guacamole" is
measured against every burrito sold, not every order — and a bowl's guacamole
is the bowl's own number. Three burritos on one line with guacamole is three
attached, not one.

**"NO onions" is never counted as onions.** A removal is a choice about an
option, not an order of one. Counting them together would produce a report
claiming half the burritos add onions off a column of people taking them off —
the same confusion, in a spreadsheet instead of on a phone call.

**Last month's sales stay under last month's menu.** Rename an item, reprice
it, take it off the menu entirely: the history it already earned does not move
a cent, because the report reads the orders, never the menu.

## A rush, including the parts that go wrong

Thirty orders arrive in twenty minutes and the kitchen works them all the way
through — but a demo where nothing goes wrong only proves that nothing went
wrong. So five things go wrong, on purpose, every time it runs.

**The kitchen runs out of guacamole in the middle of it.** One customer already
has it in their cart. Their order is refused at checkout — for the guacamole,
not for the burrito, because out of avocado is not out of burritos — and they
place it again a minute later without it. One order already on the grill had
guacamole on it, so staff cancel that one with the reason attached. The orders
already handed over do not move a cent: their receipts still say guacamole, at
the price it was sold at, an hour after the menu said otherwise.

**A cook marks the wrong ticket ready and undoes it.** The undo does not erase
the mistake — it appends a correction, which is why the report afterwards can
still say that ticket was on the grill twice, five minutes and then three.

**Someone orders and never comes to collect it.** The food sits on the shelf
for thirty-three minutes, past all three no-show marks, and is closed out as a
no-show rather than a cancellation. The two are different facts and the sales
report keeps them apart.

**A customer taps Place order twice.** One order exists, and both taps get the
same answer back — not merely "no duplicate", but the same order number, twice.

**The restaurant pauses mid-rush.** Three orders arrive during the pause and are
turned away with a reason rather than silently dropped. One of those customers
comes back after it lifts, and their order is a new one, not a replay.

**Zero stuck, zero lost, zero duplicated.** Every one of the thirty orders ends
somewhere final. The order numbers run 1 to 30 with no gaps and no repeats,
including the three that were submitted in the same instant.

**Twenty minutes of service, in under a second.** Nothing in the ordering engine
reads a clock — every price, every transition, every deadline is told what time
it is. That discipline was for correctness; the reward is that a rush can be
replayed as fast as a database can take it, which is what makes it a test and
not just a demo.

**`npm run demo:rush`** prints what happened: the five ugly cases, where the
orders ended up, how long they spent in each state, and the day's sales.

## Watching the rush instead of reading about it

The full seeded rush finishes with every order handed over, which is the right
result and a dull screenshot — the kitchen queue it leaves behind is empty.
`npm run demo:rush:live` stops the clock twelve minutes in instead: twenty-two
orders on the pass across all four states, one already cancelled because the
kitchen ran out of guacamole four minutes ago, and one that has been sitting
ready for five minutes with nobody there to collect it.

Nothing about it is a special mode. It is the same rush, stopped early — the
orders that had not arrived yet simply have not arrived, the pause has not
happened, and the report says twenty-two orders are still in flight rather than
claiming a day with no sales in it.

## How long orders actually take

The sales report now answers the question a kitchen asks itself every evening:
where does the time go? One row per state an order can still be sitting in —
how many orders reached it, how long they averaged there, how long in total.

It is read off the order log rather than off the order, which matters more than
it sounds. A ticket marked ready by mistake and sent back was on the grill
twice, and the log is the only thing that still knows that; a column holding
"when did this last change" could only ever report the second visit. The
mistake stays on the record, because a correction is appended rather than
erasing anything.

Orders still open count up to now, so a busy lunch reads longer than a finished
one — the screen says so rather than quietly excluding them. And states an
order has finished with are not listed at all: an order picked up an hour ago
has not been "picked up" for an hour. It is done.

## Changing your mind about a line

A cart line now has an Edit button. It re-opens the same composer you built it
in, already filled in — your protein still selected, your guacamole still
ticked, your quantity and your note where you left them — and the button says
Save changes instead of Add to cart.

Saving replaces that line where it sits rather than removing it and adding a
new one at the bottom. A three-line order that reshuffles itself because you
fixed the first line is a different order than the one you were reading.

And the link only carries which line you are editing, never what is in it. What
is in it comes off your cart on the server, so a hand-edited URL cannot invent
a burrito you never composed.

## A menu that cannot be saved broken

"Choose at least three, at most two" is a group nothing can ever be ordered
from — and until now the only thing stopping it being saved was the screen that
saves it. The rules now live in the database: a group cannot require more than
it allows, cannot allow nothing at all, an item cannot be priced below zero,
and asking for extra cheese cannot make a burrito cheaper.

The edit screen still explains the problem in words, which is where an
explanation belongs. The database is what makes the rule true regardless of
what is doing the writing.

One thing is deliberately still allowed: an option that costs less than
nothing. "Small −$1.50" is an ordinary menu decision, not a mistake, and there
is a test that says so.

## Running the restaurant without a database client

Opening hours, the point at which a queue gets too long and the door closes on
its own, how long before closing time the last online order is taken, and the
two numbers every "ready in about…" estimate is built from — all of these were
real settings the software already obeyed, and none of them could be changed
without writing SQL.

They now have a screen. A day is open or it is not; a day nobody ticks is a
closed day. There is a one-tap "close for today" for the mornings when the
answer is no, and it works out which day today is from the restaurant's own
clock rather than from the browser's, so it cannot close the wrong one from an
airport.

The screen refuses bad values by name — "Wednesday closes at 11:00, which is
not after it opens at 18:00" — and the database refuses them again underneath,
because the message and the rule are two different jobs.

Two things are shown and deliberately cannot be edited: the timezone and the
tax rate. Changing either reaches backwards into every report already run and
every order number already issued. The screen says so instead of pretending
they are not there.

## The number you were shown is the number that gets replaced

Changing a price shows you the old one beside the new one before anything is
saved — that guard has been there since the menu editor shipped, and it is what
catches $10.95 typed as $109.50.

It is now checked, not just displayed. If someone else changes that price
between the moment your confirm screen was drawn and the moment you tap Save,
the save is refused and told you why: "Burrito is $11.50 now, not the $10.95
you were shown." Nothing is written, and the other person's price stands until
you have looked at it.

The same goes for a modifier group's rules. Two people editing "Salsa" from two
phones on the same prep table is a normal Tuesday, and the one who tapped
second should find out rather than quietly win.

## Pricing "extra"

Options that come in light / regular / extra can charge for the extra — extra
cheese is fifty cents for the cheese and seventy-five more for the extra. That
second number was set when the menu was built and could not be changed
afterwards. It can now.

It gets the same confirm step as every other price, shows what it is added on
top of so the number means something, and refuses to go negative: asking for
more of something must never make the food cheaper.

Leaving it blank means extra is free, which is what most options are — and the
screen says "free" rather than "$0.00", because those are two different
statements about a menu.

## The screen, in the middle of the rush

The seeded rush proved the orders were right. This proves the screen is — the
kitchen queue with twenty-two live tickets on it, stopped twelve minutes into
service.

Every state has cards in it and the counts on the headings add up to the orders
that exist. The order cancelled four minutes ago when the guacamole ran out is
gone from the queue rather than sitting there greyed out, and the customer that
same shortage turned away is back on it, having reordered without it. "NO
onions" is unmistakable in bold on a card that also has guacamole on it in
plain text, which is the whole point of the product on the one screen where
getting it wrong costs a remake. Every button is still thumb-sized across a
full column, not just on a card by itself.

And nothing is flagged as running late, because nothing is — which is a smaller
fix than it sounds. The demo used to anchor its clock an hour back, so a queue
stopped twelve minutes in showed every ticket at forty-eight minutes and every
warning lit. A demo where the alarms are always on is a demo that teaches you
to ignore them.

## Closing a day, on purpose

Opening hours are seven checkboxes and fourteen time fields on a phone held in
one hand. Unticking one by accident shuts online ordering for a whole day, and
nothing used to say so until a customer noticed.

Saving now shows what changes first, and only what changes — the one day that
moved, old beside new, not all seven rows again. If the save would close a day
that is currently open, that gets its own warning naming the days: this is a
different size of decision from moving a closing time by half an hour.

Submitting the hours that are already saved says "nothing was changed" and
offers no save button at all.

## The gate moved to where the pushes are

Every push since late August has run a CI job that lasted three seconds and
failed before it started — an account billing block, not a test. The convention
says to watch CI go green before calling something done, and for four items
that sentence had nothing behind it.

Until CI runs again, the gate runs on the push itself: lint, typecheck, unit
tests, a production build and the end-to-end suite, all of it before the commits
leave the machine. It is a tracked hook rather than a dependency, and it is
wired up by `npm install` so a fresh clone cannot silently miss it.

It is a stopgap and the file says so in its first line. A laptop cannot run the
part of CI that matters most — migrations applied to an empty database from
scratch, and the unit suite run twice under two hostile timezones expecting
identical answers.

---

## C-037 — A lock on the kitchen door

Since C-008 the write-up has carried the same admission: `/kitchen` was
reachable by anyone who knew the path. Four server actions that advance,
revert, cancel and abandon orders, a menu editor, an 86 board and a pause
switch — all of it open. It was recorded as a deliberate scope line rather than
an oversight, and it was also the sentence that made "deploy this somewhere"
impossible to write.

**One guard, at the routing layer.** The tempting version is a `requireStaff()`
at the top of every server action, and there are fifteen of them. The version
that ships is a single `middleware.ts` matching `/kitchen/:path*`, because a
server action POSTs to the path it was rendered on — so protecting the route
protects the writes, and the sixteenth action added next month cannot forget.
The trade is recorded in the file: it is a *route* guard, so a kitchen action
imported into a customer page would slip past it. Nothing does that today, and
a test asserts the POST is refused.

**The cookie is a digest of the passcode, not a session id.** There is no
sessions table, no expiry sweep, and no second secret to keep in step with the
first — and rotating `STAFF_PASSCODE` signs every device out, everywhere, with
no deploy step beyond the variable. Both comparisons run in constant time over
fixed-length digests, including the typed passcode, which is hashed before it
is compared for exactly that reason.

**Unset means locked.** A development default is how a known passcode reaches
production, so there isn't one: with no `STAFF_PASSCODE`, the kitchen screens
refuse everyone and the login page says why. A deployment that forgets the
variable loses its queue screen rather than publishing it — which is the
failure you want to have.

**A GET redirects, a POST gets a 401.** Redirecting an unauthenticated POST
would make the browser re-submit the server action's payload at the login page.
The status code is the honest answer, and it surfaces in the app as the
action's own error rather than as a mystery navigation.

**Nine spec files needed a signed-in browser, and none of them mention it.**
Global setup mints the cookie once — it can, because the cookie is derived from
the passcode and needs no running server — and hands it to every context. The
one file that must run signed *out* opts back out. That is the same lesson as
C-025: a fixture nine specs each write their own copy of is a fixture with nine
slightly different bugs in it.

**What it does not do.** It answers "is this the kitchen?", not "which cook
advanced this order?" The event log's actor is still the literal `staff`.
Per-cook accounts are a different project, and the log is where they land.

## C-038 — Money the counter can see

Online ordering has two kinds of customer: the one who pays on the phone and
the one who pays at the counter. Both walk up to the same person holding the
same bag, and only one of them still owes money. Countertop now tells them
apart on the card, in the amount, before the bag moves.

**The schema already knew.** `paymentState` and its `unpaid` default have been
on the order since the data model went in, and the state machine has emitted a
mock refund event on cancelling a paid order for just as long. Nothing ever
wrote `paid`, so two of the three states were unreachable from the app and the
refund event described a transition the column never made. This release needed
no migration — only the wiring that makes the model true.

**The flag carries the amount.** A cook reading a card at arm's length gets
`PAY AT PICKUP — $11.85`, in amber rather than the red the running-late flags
own, with `Collected — mark paid` directly under the advance button. A badge
that says only "unpaid" sends someone to open the receipt, and mid-rush that
means the bag goes out first.

**It flags, it does not block.** Refusing to mark an order picked up until it
is paid would look stricter and be worse: a cook who cannot hand over food
because a screen disagrees about money will find a way around the screen, and
whatever they find is not something the log can see.

**The column follows the log.** Cancelling a paid order sets `refunded`
because the engine emitted a `refund` event — not because the database layer
re-derived the rule. One place knows when a cancellation refunds, one knows
what it cost, and they cannot drift apart.

**The rush shows both.** A third of the seeded thirty pay at the counter, fixed
by arrival minute so every run is the same demo. A flag that appears on every
card is decoration, and one that appears on none proves nothing.

## C-039 — Yesterday's queue is not today's work

An order nobody closed out does not go away at midnight. It sits on the
kitchen screen, mixed in among the tickets that are actually cooking, until
somebody notices — and the longer it sits, the more it looks like part of the
furniture. Countertop now knows the difference between a ticket and a leftover.

**The flag names the day.** A card from a service that has already ended wears
`LEFT OVER FROM 2026-08-25 — CLOSE IT OUT` in red, and a banner above the
queue counts them: "3 orders are still open from an earlier day, the oldest
from 2026-08-25." The count is what turns a card someone might scroll past
into a chore with a size.

**It stops chiming.** The new-order alert exists to say a customer is standing
at the counter right now. A `placed` ticket from Tuesday that rings on every
page load is an alarm staff learn to ignore, and an alarm that gets ignored is
worth nothing during the rush it was built for. Leftovers are flagged loudly
and silently — seen, not heard.

**It stops holding the door shut.** The auto-pause threshold counts the work
the kitchen still owes, and a three-day-old `preparing` row is not work: it is
a tap somebody forgot. Counted, it inflated every quoted wait time, and enough
of them would have held online ordering closed on a restaurant standing empty.
They no longer count. The banner is what keeps the pressure on instead.

**Flagged, never swept.** Nothing closes an order out automatically. Closing
one is a real transition to a real terminal state — `abandoned` for food that
was made and never collected, a reasoned `cancelled` for a ticket that never
got cooked — and only the person who was there knows which. Guessing on their
behalf would invent a no-show in the sales report, and a report that invents
numbers is worse than one that leaves a gap.

**One boundary, shared with the order numbers.** "Left over" means "from an
earlier business day" — the same line the daily order numbers reset on, in the
restaurant's own timezone. Flagging at closing time instead would flag the
ticket a cook is still bagging as the door shuts.

## C-040 — Pictures of the app that exists

The write-up's screenshots were taken at C-031 and had gone three items stale:
they showed a kitchen with no lock on the door, no money owed on any ticket,
and no way to tell yesterday's forgotten order from one that is cooking.

All fourteen are now captured from the running app against the seeded database
— the same Playwright run that asserts the behaviour takes the picture of it.
Six of the eleven that already existed came back different, which is the whole
argument for regenerating rather than adding: every kitchen card now carries
the payment badge that shipped two items ago.

Three surfaces are pictured for the first time: the staff sign-in, a ticket
flagged as still owing money with the one control that clears it, and a queue
carrying four orders from an earlier day, banner and all.

## C-041 — Ten bottled waters are not ten fajita plates

Until now the kitchen's auto-pause and the wait a customer was quoted both read
one number: how many orders were open. That number could not tell a queue of
drinks from a queue of plates, so four people buying bottled water pushed the
restaurant a sixth of the way to shutting online ordering off, and added four
minutes to everyone else's estimate.

Every menu item now carries a prep weight — a plate off the flat-top is 3, a
burrito 2, a scooped side 1, a bottle out of the fridge 0 — and an order copies
the sum of its lines' weight the way it copies its prices. The throttle and the
estimate both add up the open orders' weight instead of counting rows.

Two details worth the words. The weight is **snapshotted**, not looked up: an
order weighs what it weighed when it was placed, so re-weighting an item at 3pm
cannot change how heavy the 2pm queue was — asserted by the same regression
test that mutates every menu row a placed order came from. And the threshold's
conversion is **measured, not guessed**: the seeded rush averages 2.73 weight
an order and peaks at 47, so the old default of 25 orders became 60 points, and
the demo still fills a queue without tripping the pause.

The staff screen for it deliberately has no confirm step. A price gets one
because $1.50 typed as $15.00 is a valid price a customer pays; a prep point is
kitchen workload nobody is charged for, and a second ceremony on every row
would only teach people to tap through the one that matters.

## C-042 — Were we honest?

Every customer since C-013 has been shown a ready-time range at checkout, and
every one of those promises was thrown away the moment it was made. The
estimate recomputes on every render — right for someone watching the queue move
in front of them, useless afterwards, because a report asking "were the quotes
any good?" could only recompute the answer from today's settings and today's
queue and score itself full marks.

An order now saves what it was told, next to what it was charged and how heavy
it was: the range, and the size of the queue it was measured against. That is
the whole trick. Once the promise is a snapshot, grading it is subtraction.

The report grew a section for it. How many quoted orders reached the shelf, the
share that landed inside the range, and — the part that took the third column —
whether the misses got worse as the kitchen got busier. Orders are split at the
median queue depth: if both halves run late the base prep time is wrong, and if
only the busy half does, the per-unit-of-work number is. The screen names the
setting to move and which way, in the words the settings screen uses.

Two refusals in it are the point. **Early is a miss.** Someone told
"15–25 min" and handed a bag at six waited at the counter for nine minutes they
were told to spend elsewhere, and a report that scored that as a win would tune
the estimate in exactly the wrong direction. And **under ten quoted orders it
recommends nothing at all** — "not enough to say yet" is a real answer, and a
restaurant's first four tickets of the week must not be allowed to retune it.

## C-043 — The wipe refuses to leave this machine

Three scripts in this repo start by TRUNCATEing every table: the seed the test
suite runs on, the reset that rebuilds the test database, and the rush demo.
Until now that was safe for one reason — every database this repo could reach
was on localhost. That is an accident of setup, not a safety mechanism, and the
next item points the app at a hosted database with a real restaurant's orders
in it.

So the wipe now checks where it is pointed, and refuses if the answer is not
this machine. The connection string is what it reads, not `NODE_ENV`: an
environment variable nobody set cannot protect anything, and the string is the
thing that actually decides which rows disappear. `dropdb` gets its own check,
because it reads a different setting entirely and the two can disagree.

There is one override, and it takes the name of the host being wiped rather
than a yes. A blanket `=1` in a shell profile would switch the guard off on
every machine, in every repo, forever — six months from now, silently, which is
precisely the accident being prevented.

The whole thing hangs off a single call, because every destructive path in the
repo already funnelled through one TRUNCATE. One guard, nine test files, three
scripts and an end-to-end suite behind it.

## C-044 — The gate runs somewhere other than this laptop

For nineteen items the automated gate has run on a Mac sitting on a desk. Not
by design: GitHub-hosted runners have been billing-blocked since C-029, every
run dying in four seconds without executing a step, and a runner installed on
the developer's own machine was the only way to get a clean checkout tested by
something other than the person who wrote the code.

Public repositories get those minutes for free. So the repo is public, and the
fix for the billing block turns out to be the same action as putting the work
where it can be read.

Before flipping it, the history was audited again rather than taken on trust —
every commit, every ref, filenames and file contents both. One environment file
has ever been committed and it carries variable names with no values. The four
connection strings in the history are a throwaway container GitHub destroys
with the job, and a fake hostname in a test that asserts hosted databases are
refused. A public repository makes every version of every file readable
permanently, which makes the audit cheap and the alternative expensive.

The runner itself is now switched off, and that is the less obvious half. A
self-hosted runner executes the repository's code on the machine it lives on.
While the repo was private, only people who could already be trusted with that
machine could put code there. Public changes who can propose code, and a
workflow that a stranger's pull request can trigger is a stranger's commands
running on a laptop. Nothing here was ever reachable that way — the runner only
ever answered to pushes to the main branch — but the protection was a property
of two lines in a file, and the next person to edit that file has no reason to
know it. The runner is deregistered, the workflow is reduced to a manual
trigger, and the reason is written in the file in the imperative, addressed to
whoever opens it next.

The recipe stays. Retiring something as a dependency is not the same as
forgetting how it worked, and the day the billing block returns, the file that
solved it last time is still there.

### C-044, revisited — the repo went back to private

The repo was public for about half an hour and is private again, by decision.
The paragraphs above describe a state that no longer holds.

The half-hour was not wasted, because it answered a question that had been open
since C-029. The Linux pipeline had been written, reviewed and never once run —
every attempt died in four seconds on billing before executing a step. Given
free minutes it ran green twice, on two different Node versions, with the
end-to-end suite reconciling exactly. A pipeline that has never executed is a
guess about what would happen; that one is now a measurement.

What the revert costs is the ability to use it. The pipeline is not wrong, it
is unpaid.

The runner on the developer's machine is switched back on, and the reason is
worth stating precisely, because it is the same reason it was switched off. A
self-hosted runner executes the repository's code on the machine it lives on.
On a private repo that is safe by construction — the only people who can put
code in the repository are people already trusted with the machine. Public
breaks that equivalence, which is why the runner came off before the flip. It
goes back on for exactly the same reason it came off: visibility changed.

So the warning left in the workflow file changed too. The first version said
this repo is public, never add a trigger a fork can reach — true when written,
and quietly wrong within the hour. The version there now names the condition
instead of the conclusion: if this repo is ever made public again, remove the
push trigger and deregister the runner. A comment that states a fact about the
world has to say which fact it depends on, or it becomes confidently misleading
the moment that fact moves.

### C-045 — Countertop is deployed

**https://countertop-mu.vercel.app**

The app the rest of this document describes now runs on a URL. Next.js on
Vercel, Postgres on Neon, the menu and a mid-service rush already loaded, so
the link opens onto a restaurant in the middle of lunch rather than an empty
shell asking to be set up.

The customer side is open to anyone. Browse the menu, compose an item with its
modifiers, watch the total recomputed on the server at every step. The kitchen
side is behind a passcode, because a queue screen anyone can advance is not a
demo of a queue screen.

Two rules held through the deployment, and they are the ones worth stating.
The test suite still runs against a Postgres on the developer's machine and has
never been pointed at Neon — a cloud database is for deployed environments, not
for `npm test`. And the passcode exists in exactly one place, Vercel's
environment; it was never written into a config file, a default, or a fallback,
because an unset passcode locks the kitchen rather than opening it.

Deploying also found a defect that nothing local could have found. The database
client was being bundled into the application, and a bundled client cannot
locate the native engine it needs to run a query — so every page that reads
data returned 500 while every local check stayed green. The fix was to stop
bundling it. The full account is in the write-up; the short version is that a
build passing on the machine that built it is not the same claim as a build
that works where it ships.

## C-046 — A receipt that outlives the queue

The kitchen queue can find "Dana, or 047" — but only today's Dana. The moment
an order is picked up, cancelled, or ages past the queue entirely, it is gone
from staff's reach, and the only way back to it was the customer's own
tracking link. A dispute a day later — "you charged me for extra cheese I
never asked for" — had no receipt to point to on the restaurant's side of the
counter.

**Order history reaches every day, every status.** `/kitchen/orders` finds an
order by name or number regardless of how long ago it was placed or what
happened to it since, and opens onto the same receipt a customer sees — the
same negation styling, the same subtotal-tax-total breakdown, read off the
order's own snapshot rather than a menu that has since moved on.

**A number alone can mean more than one order.** Today's order number resets
every business day, so "#047" from a search box isn't the same promise
"#047" on today's queue is — there may be a #047 from three different
Tuesdays. Rather than guess which one a bare number means, a numeric search
matches every order with that number and lists them by date, same as a name
search would.

**It went looking for a second feature and found the PRD already had an
answer.** The same testing pass that turned up this gap also proposed a
dedicated end-of-day summary screen — until a check against the PRD showed
the leftover-flag sweep (C-039) already *is* the shipped, complete answer to
closing out a day. Not built, on purpose: a second mechanism for a question
already answered is not a feature, it's a fork.

## C-047 — The undo that had nowhere to live

**The five-second undo now exists on the two taps that most need it.** A cook
who marks the wrong order picked up, or closes out a customer as a no-show
thirty seconds before they walk in, has always had an undo in the engine —
and never on the screen. Both of those taps move an order off the queue, and
the card that would have carried the undo button stopped being drawn by the
very tap that started the countdown. There is now a "Just finished" strip
above the queue, holding those orders for exactly as long as the undo is live.

**Checkout stops contradicting itself.** If the cart emptied in another tab,
an item sold out, or the restaurant paused while a checkout screen sat open,
the server correctly refused the order — but the page around the form never
updated, so the customer read a full order summary, a live "Place order —
$11.85" button, and "your cart is empty" at the same time. The screen now
re-asks the server whenever it is refused, and a refusal no longer wipes the
name they just typed.

**Search for a percent sign, get orders with a percent sign.** The staff
history search passed what you typed straight into a SQL pattern match, so a
literal `%` quietly matched every order the restaurant had ever taken.

**Six back-links and a nav row that failed this project's own rule.** The
queue's cards are held to 48px tap targets; the links out of order history,
the cart, the menu and checkout were 17px tall, and the shortest header link
was 35px wide.

## C-048 — Money owed outlives the queue card

**An order handed over without paying can now be settled.** "Collected — mark
paid" only ever lived on a live queue card, so the moment an unpaid order was
handed to the customer it dropped off the queue and took the only way to
collect on it with it. The till said one thing, the system said another, and
no screen could reconcile them. The control is now on the order's receipt in
staff history too, reachable for as long as the order exists.

**And deliberately not on a no-show.** An order nobody came for is unpaid
forever, correctly — offering to collect on it would book revenue for food
that never left the counter, against the very orders the no-show rate is
counted from. Both screens ask the same question of the same rule, and so
does the server behind them.

**Four more back-links that failed the 48px rule** — availability, menu,
settings and sales, all 21px tall. Every staff screen's back link is now
measured by a test, because this is the third time this has been found on a
page whose own controls were fine.

**And a second look at everything the operator touches.** An exploratory pass
over menu editing, availability, settings and reporting confirmed the things
that matter most are holding: 86'ing a shared option shows "sold out" rather
than hiding it, flags an open cart, is refused server-side when the button is
forced, and is invisible to orders already placed — on the kitchen card, the
staff receipt and the customer's own tracking page alike.

## C-049 — The day a number belongs to

**Order numbers repeat, and now the search knows which day you mean.** Order
numbers start again at #001 every morning, so searching staff history for
"047" has always returned every #047 the restaurant has ever served — dated
and listed, deliberately, rather than guessing at one. That is the right
answer to the question and only half the lookup: after a few months of
service, the order the customer is standing there asking about is somewhere
down a list of fifty.

**Pick the day.** The history search now takes a date beside the name-or-
number box: "#047, on the 30th" is one order. A date on its own is a day's
service, every status, in one list. "Show all" clears both.

It uses the phone and laptop's own built-in date picker, and matches against
the day the restaurant assigned the order at the counter — not a UTC date
that rolls over mid-dinner-service.

## C-050 — The tap that meant one thing and did another

**A button on a stale screen could skip a step.** With two screens open on
the same queue — the ordinary setup in a kitchen — a tap on a card that had
fallen behind advanced the order from wherever it had got to, not from where
the person tapping could see. "Start cooking" on a five-second-old screen
could mark an order picked up: the food still on the pass, the system saying
it was collected, and the customer at the counter told the same.

Every movement button now names the step it meant. If the order has already
moved, the tap is refused with a message naming both states, and nothing
happens to the order.

The rule this enforces was written a year of commits ago and had never once
been reached from a screen — the kitchen's buttons had simply never told the
system which step they meant. Both directions are fixed, not just the
forward one: "Move back" had the same hole.

## C-051 — Sales counted food nobody paid for

**The report said one number and the till said another.** Orders can be handed
over unpaid — that is what "pay at pickup" means, and about a third of a busy
service goes out that way. Sales counted every one of them at full price and
said nothing about it, so Sunday night the screen read $478.55 for Friday, the
drawer held $431, and no screen in the product explained the gap.

**Sales now shows what actually came in.** Revenue still means what it always
meant — every order a customer took, paid or not, because changing it would
restate every past report. Beside it: **Collected**, **Outstanding**, and, when
there is one, **Refunded**. The three add up to revenue and never quietly
cancel each other out.

**And it names who to ask.** Every order handed over unpaid is listed with its
day, its number, the customer's name and the amount owed — a list you can work,
not a count of six.

## C-052 — An order key had to be unguessable, and nothing checked

**Placing an order carries a key, and the key can read the order back.** That
is what makes a double-tap safe: the second submit presents the same key and
gets the same order rather than making a new one. It also means presenting a
key returns the whole order — the customer's name, phone, totals and the
private link to their status page.

**The browser has always used an unguessable one.** The server never insisted.
Any text would do, and this project's own demo data used keys like
`seed-order-0`. Nothing was exposed in practice, because there is only one
client and it does the right thing — but the first extra client to number its
own orders `kiosk-2-0047` would have made every one of them readable by
counting.

**The server now insists.** An order key must be a UUID or the order is
refused, and the demo data was regenerated to match. The stronger fix — tying
the replay to the session that placed the order, so a stolen key is no use
either — is on the list and named.

## C-084 — When an order goes missing, there is now something to look at

**The product used to keep no record of a failed order.** A customer says they
ordered at 7:10 and there is nothing on the queue. Was the order never placed,
or was it placed and already handed to somebody else? Until now the only
honest answer was "we can't tell" — nothing was written down anywhere unless
the order succeeded.

**Every checkout attempt now leaves one line.** Placed, refused, or crashed —
with the reason, and with the key that ties a customer's retry to their first
attempt. When ordering is paused, each bounced order is a line, so "the pause
turned away eleven people during the fryer outage" is a number rather than a
guess.

**The lines never contain a customer.** No name, no phone number, no order
link — a support question is answered from the order number and the attempt
key, and neither of those is a person.

**One crash that used to be a blank screen is now a sentence.** If the kitchen
deletes something out from under an order mid-checkout, the customer gets
"Something went wrong placing that order. Try again." instead of a broken page,
and the shop gets a log line naming exactly what was missing.

## C-085 — Money now has a time on it

**"When did we take that?" had no answer.** An order was paid or it wasn't —
a yes or no, with nothing recorded about when the money actually arrived or
how much of it. A refund already left a proper record; the payment it reversed
did not.

**Every payment is now an entry in the order's history**, with its instant, its
amount, and whether it was taken at checkout or handed over at the counter —
which are two different things to reconcile and used to look identical.

**Two people tapping "Collected" at once is still one payment.** The record and
the order's payment state move together or not at all, so a busy counter cannot
book the same money twice.

## C-086 — The order history now says who

**Every action on an order was recorded as "staff".** Which one, nobody knew.
The log could say an order was moved back at 7:14, or that cash was collected
on it, and not who did either — on a screen three people share all shift.

**Whoever takes the pass now types a four-digit PIN once**, and their name goes
on everything they do until they end the shift. Not once per tap: a busy Friday
would make that a control people work around, and a log everyone works around
is worse than an empty one.

**The receipt shows the whole story.** Open any order and there is now an
Activity list — every step, when it happened, and who did it. Orders from
before today honestly say the name was not recorded, rather than guessing.

**Someone who leaves keeps their name on the work they did.** They can't start
a shift any more, and nothing they ever did loses its attribution.

*Not included: there is no screen for adding staff or changing a PIN yet.*

## C-063 — Money is recorded as things that happened, not as a label

**An order used to carry one word about money:** unpaid, paid, or refunded.
That word could not say how much, or when, or whether a refund had been
attempted and failed — and a word cannot be added up.

**The record is now the sequence of events**, each carrying the amount that
moved and the moment it moved. The word stays on the order because every
screen already reads it and it is fast; it is now a summary of the events
rather than the only thing the restaurant knows. A test checks the two agree
across an entire simulated service.

**Why it matters for what comes next:** "what is still owed on this order" and
"we tried to refund and the card failed" are both questions a single word
cannot answer. They are the next two items, and this is the foundation they
needed.

## C-064 — "Unpaid" became an amount

**A yes/no could not describe a partly settled order.** An order was paid or it
wasn't. If some of it came back, or some of it was never taken, no screen had a
way to say how much.

**Every screen that talks about money owed now shows the balance** — the queue
card's badge, the staff receipt, and the sales report's list of who still owes.
One calculation, three places, so they cannot disagree.

**The counter now collects the remainder.** If $10 is already down on a $35
ticket, "Collected" takes $25 — not another $35.

**And the order's own total never moves.** What a customer was charged is a
permanent record; the balance is worked out beside it, never by editing it.

## C-087 — The restaurant now looks like itself

**The site had no identity.** "Firebird Kitchen" was a line of default system
text at the top of the menu, in whatever face the browser reached for, next to
nothing. The logo set had been drawn and was sitting in the repo unused.

**The menu now opens with the real lockup** — the mark and the wordmark, in the
restaurant's own two typefaces. The wordmark is the slab serif it is supposed
to be, and everything else on every screen is now set in the brand's UI face
instead of the browser's default.

**The browser tab has the F.** Below a certain size the flame in the mark stops
being a flame and starts being three grey pixels, so the tab icon is the
monogram — which is exactly what the logo set says to do at that size.

**A screen reader hears no difference.** The heading still announces
"Firebird Kitchen"; the mark beside it is decorative and is skipped.

**NO ONIONS is untouched.** The brand sheet renders it white-on-red on a
printed ticket, which is what the kitchen screen has done since it was built.
Nothing was harmonised.

## C-065 — There is now a way to make an order right

**Before this, there wasn't one.** A burrito goes out wrong at 7:20. The order
is cooked, so it can't be cancelled — correctly; nobody wants a system that
lets a paid, collected order vanish. The only remaining control was to charge
the full amount. So the counter sorted it out off the books, and on Sunday the
report and the till disagreed by an amount nobody had written down.

**Open any order and there is now "Make it right."** Comp the whole thing, or
take a specific amount off. Pick a reason, add a note. It works on every order
in any state — including one already picked up or written off as a no-show,
which are exactly the ones a complaint arrives about.

**The order's total never changes.** What the customer was charged stays what
they were charged, permanently. The adjustment is recorded next to it, and
what's still owed is worked out from the two. That means a comped order stops
showing up as money outstanding — on the queue card, on the receipt, and on the
report — without anything rewriting history.

**Too much is refused, not quietly reduced.** Type $50 on an $11.85 order and
it says so and names the limit. Two half-comps can't add up to more than the
order was worth either.

**The customer's page tells them.** An adjusted order shows the adjustment and
what's actually left to pay — not the original figure as if nothing happened.
It doesn't show the reason or the note; those are the shop's.

**Every adjustment is signed.** Who made the call and when, on the order's
history, next to the amount.

## C-066 — A remake is now a real ticket, not a favour someone remembers

**Ivy is back at the counter at 6:52.** Her torta was meant to have no onions
and be cut in half, and it was neither. Before this, the system had nothing to
offer: the order was cooked, so it could not be cancelled, and the only way to
put it right was to sort it out off the books.

**"Remake it" now puts a real ticket on the line.** Its own order number, its
own place in the queue, ageing like any other — the same food, at the same
price it was sold at, even if the menu has been repriced since.

**What went wrong goes on the ticket.** The note the counter types appears on
the kitchen card above the customer's own instructions, so the cook sees the
correction rather than being told about it.

**Nothing is charged for it**, and nobody at the counter is shown a total to
collect. The original order keeps its money exactly as it was — if it was paid,
it stays paid.

**Both orders point at each other.** Open the original and it says which order
replaced it; open the remake and it says which one it replaces. Either is one
tap from the other.

**And Monday's numbers stay true.** A remake is not counted as a second sale,
its food is not added to the item counts, and it cannot put an "onions"
attachment on the remake of an order that asked for none. The report says how
many were remade, on its own line, and says why that number is not in the
totals above.

## C-100 — The groundwork for a loyalty program

**This is plumbing, and nothing is switched on yet.** The program is off by
default, no screen mentions it, and no customer or member data is recorded
anywhere until enrolment ships.

**A member is a phone number and nothing else.** No account, no password, no
portal to sign into. And the phone number itself is never kept in the loyalty
records — only a one-way scramble of it, computed with a secret that lives
outside the database. Anyone who got hold of the loyalty tables would not have
a customer list. The last four digits are kept in the clear, on purpose, so the
counter can say "the one ending 2233" without reading someone's number aloud.

**The points ledger can be added to and never edited.** A mistake is corrected
by writing a correction, with the staff member's name on it — the same rule the
order history already follows.

**The database itself refuses the ways this could go wrong.** Points can't be
recorded in the wrong direction. An order can't earn points twice, even if it
gets sent back and handed over again. A reward can't be recorded without what
it was worth.

**Deleting a member really deletes their points.** That is deliberate: a
balance is something held for the customer, not a financial record, and
refusing to delete it would defeat the whole point of being able to forget
someone. What they were charged and what was taken off their bill stays on the
order, where it belongs.

**The numbers are set: 1 point per dollar, 100 points for $10 off.** Ten
percent back, and they expire after a year of not visiting.

## C-101 — Joining the punch card

**One checkbox, on the form you were already filling in.** No pop-up, no second
screen, no "are you sure you don't want rewards?" — it sits under the phone
field at checkout, unticked, and ordering without it is exactly as easy as it
was before.

**It only appears when the restaurant has switched the program on.** With
loyalty off — which is how every restaurant starts — the checkout page is
character for character the page it was.

**The box stays greyed until there's a phone number to count it against**, and
says so in words rather than leaving you to guess why it won't tick. Your punch
card is your phone number; without one there is nothing to attach.

**We still never keep the number.** It is turned into a one-way code and only
the code is stored, alongside the last four digits so the counter can say "the
one ending 2233". The order itself keeps your number in the ordinary way, for
the ordinary reason: somebody may need to ring you about your food.

**Typed differently is still you.** `(555) 010-2233` today and `5550102233`
next week are one punch card, not two half-full ones.

**And the copy says what is kept and for how long** — your one-way code, your
name, and what you've earned, deleted after a year without an order.

**If joining fails, your order doesn't.** The food is placed first and the
punch card second, so a problem with one is never a problem with the other.

---

## C-102 — The first punch

**Points appear when the food does.** Not when you order, not when the kitchen
starts it — when you pick it up. Food you never collected earns nothing, and a
cancelled order earns nothing, because the punch is for a meal you actually
took home.

**A dollar of food is a point, and tax is not food.** $14.95 of burrito earns
14 points. The cents round down and the sales tax earns nothing, which is the
honest version: you did not buy that part, the state did.

**A cook's mistake cannot cost you your points or give you two lots of them.**
Tapping "picked up" by accident, undoing it, and tapping it again for real is a
thing that happens on a busy counter. It is one punch on your card either way —
guaranteed by the database and not by everyone remembering to be careful. And
undoing the tap does not take the points back off you.

**What you earned is what your receipt said.** The points come off the order as
it was written down. If the restaurant reprices the burrito that afternoon,
your points do not move — the same rule the receipt itself follows.

**Off is still off.** A restaurant that has not switched the program on has
nothing written anywhere, and its checkout, its kitchen queue and its sales
report are the ones it had yesterday.

---

## C-103 — What the counter can see

**"The one ending 2233, Ivy."** The staff receipt now shows the punch card
behind an order: the name, the last four digits, the points, and whether
there's a reward to offer. That is the sentence a person says out loud at a
counter, so it is what the screen shows.

**The counter never sees the phone number, because nobody kept it.** Four
digits and a name are enough to confirm you are you, and four digits are not an
identifier. The rest of the number was turned into a one-way code the day you
joined and there is nothing to display.

**It offers the reward before you have to ask for it.** "Reward available —
$10.00 off" sits on the screen the person serving you is already looking at.
Until then it counts down honestly: 90 points to the next one.

**Reading only.** Nothing on this panel spends anything yet — that is the next
item, and a button that looked like it might have worked would be worse than
none.

**And you finally get told you joined.** Ticking the punch card box at checkout
now says so on your receipt, along with when the points arrive: when you pick
the food up, not when you order it.

**Still nothing at all with the program switched off.** A restaurant that has
not turned loyalty on has the same receipt, the same checkout and the same
kitchen screens it had before any of this existed.

---

## C-104 — Spending what you earned

**"Use reward — $10.00 off the total."** One button on the screen the person
serving you is already looking at. They tap it, ten dollars comes off what you
owe, and a hundred points come off your card.

**Your receipt does not change.** The order was $11.85 and it stays $11.85 —
subtotal, tax and total are exactly what you agreed to. The reward is a line
below them: $10.00 off, $1.85 still owed. A restaurant that quietly rewrites
what it charged you is a restaurant whose receipts cannot be trusted, and the
history of this order shows why ten dollars came off, when, and who did it.

**A reward worth more than you owe is refused, not shrunk.** Order a $3 side
with a reward waiting and the screen says so rather than spending your hundred
points on three dollars. You keep them for a bigger order.

**Once per order, and the database says so.** Two taps on a slow connection
write one reward, not two — that is a constraint, not a disabled button.

**It comes off at the counter, so it needs something left to pay.** Choose
"pay at pickup" and the reward comes off what you hand over. Pay by card when
you order and there is nothing left for it to come off — your points stay
exactly where they are, for next time. Spending them at checkout is a bigger
change that is coming with the verified-by-text version.

**It only counts what you actually bought.** The reward comes off the total
after tax, which means the tax is still on the full amount. That is honest and
it is written down: taking it off before tax is a bigger change to how every
receipt adds up, and it comes with the version where you spend points yourself
at checkout.

## C-091 — Being forgotten

**"Take my details off your system."** Now there is an answer, and it takes one
tap. On the staff receipt: *Forget this customer* — a confirm, then the name,
the phone number and every note on that order are gone.

**The order stays an order.** #047 is still #047. The money is still the money.
The activity log still says who accepted it and when it went out. What leaves
is who it was, not what happened — which is exactly the line a restaurant's
records should be drawn on.

**And it happens on its own.** Anything older than a year is stripped the same
way by a job the shop runs. A year is not an arbitrary number: it is how long a
punch card lasts, and it is the only reason this product keeps a name for more
than a few days. The window and the punch card are tied together on purpose.

**Not one number moves.** Every report reads exactly the same before and after
— same sales, same top items, same busiest hour. That is asserted by a test
that compares the whole report byte for byte, because a privacy feature that
quietly rewrites last month's revenue is a worse problem than the one it solved.

**It is written down.** `docs/RETENTION.md` says what is kept, for how long,
how to remove it, and what a forget deliberately does not do. A capability
nobody can find is one nobody uses when the email arrives.

## C-105 — Points that end, and a punch card that can be deleted

**Points expire after a year of not using them.** No activity for twelve
months and the balance goes to zero — recorded as its own line in the ledger,
so the history still explains itself rather than quietly losing a number.

**Forgetting a customer now takes their punch card too.** The same one tap on
the staff receipt, and the confirm tells you what is about to go: *"Their punch
card goes too: 100 points and every order behind it, deleted for good."* It is
a real delete — the member and every row of their ledger — because a points
balance is something held on the customer's behalf, and a shop that will not
delete one on request has mistaken it for a receipt.

**The money stays.** A reward that was already spent is still ten dollars off
that order, with the staff member who gave it and the moment they did. That
fact was never on the loyalty side, which is why deleting the loyalty side
leaves it untouched — and every number on the sales report reads the same
before and after.

**The two windows cannot drift.** Points can never outlive the purchase history
that explains them: the database refuses a setting where they would. That is a
constraint, not a note — the failure it prevents is silent and arrives a year
later, as live points nobody can account for.

**One command still does all of it.** `npm run db:retention` now prints both
windows: orders forgotten, members deleted, points expired.

## C-106 — What the punch card costs, on a screen

**The liability is the number nobody builds.** A points balance is a bill the
shop has already agreed to pay, at a time the customer picks. *Punch card* on
the kitchen header is the screen that says how big it is: how many members, how
many points are outstanding, and what those points are worth.

**Two money figures, because they are genuinely different.** The accrual —
every point issued and not yet spent, valued at the reward rate — and what
could be handed over tomorrow, which counts whole rewards only. A customer with
forty points has cost the shop four dollars and can spend nothing. The screen
names the gap: *"$9.00 of that is stranded in part-finished cards."* Provision
against the first; expect the second at the counter.

**Per period: what was earned, what was spent, and what it cost.** Plus the
redemption rate — points spent over points issued — which is allowed to read
above 100% and says why when it does: a punch card is savings, so a good week
spends points saved up over months. A rate that quietly capped itself at 100%
would be a screen protecting its own arithmetic instead of telling you what
happened.

**The switch is here, next to what it costs.** One button turns the program on
and off, and the screen says plainly what switching off does *not* do: nobody
loses a point. New ones stop being earned and rewards stop being spent; every
balance stays exactly where it is.

**The reward terms and the expiry windows are shown and not editable, on
purpose.** Changing what a reward is worth restates the liability of every
point already earned. Raising the threshold takes a reward away from somebody
who has one. Shrinking the expiry window deletes balances on the next sweep.
Each of those needs to show you what it would destroy before it does it — so
the control does not ship until it can.

**Nothing about any of this appears on the sales report.** That is enforced,
not remembered: a test reads the report's own query and the page that renders
it and fails if the word "loyalty" turns up in either. Sales figures stay
readable by somebody who has never switched the program on.

## C-053 — Revenue is not what was charged

**The sales screen had one money tile and it was the wrong number.** It read
the total of every ticket — food plus sales tax — and it was labelled
*Revenue*. At a month end that is a P&L overstated by the tax and a tax line
understated by the same amount, off a screen a bookkeeper is entitled to read
literally.

**Three tiles now, because these are three facts.** **Net sales** is what the
shop earned. **Tax collected** is money held on the state's behalf and never
the shop's. **Gross** is what was charged. Gross is still shown — it is the
number the till is reconciled against — and it is no longer called revenue
anywhere on the page, including the column in Top sellers that had the same
word over a figure that was already net.

**The addition is a test, not a rendering.** Net plus tax equals gross on every
day, every hour and the window total, asserted in the suite. It holds by
construction today; the point of asserting it is the day it stops, because the
cause will be somebody widening a column and not this sum.

**The tax shown is the tax charged.** Every figure is read off the order's own
snapshot, never recomputed from today's rate — so raising the tax rate this
afternoon leaves last month's report exactly where it was. Nothing on this path
so much as loads the current rate.

## C-054 — Today

**The sales screen could tell you about the last 24 hours. It could not tell
you about today.** Those are different questions, and at 2pm they have very
different answers: the last 24 hours is half of today plus half of yesterday,
so a lunch that went badly is averaged against last night's dinner and a GM
reading the screen at close gets a day that starts and ends in the wrong place.

**Today is now a window, and it is the one the screen opens on.** It is the
restaurant's own business day in the restaurant's own timezone — the same day
the order numbers reset on, so the report's "today" and the counter's "#047
today" are the same day and cannot drift apart.

**It is a whole day, so it drops the small print.** The rolling windows count
back in exact 24-hour multiples and their oldest day is usually a fragment;
the screen has always said so. Today has no fragment to warn about, so it says
what it is instead, and the caveat stays where it is true.

**The whole page moves together.** Sales, time-in-state and the quote grades
are bounded by one window, not three — so nothing on the screen is describing
a different stretch of time than the tiles at the top.

## C-055 — The attach table leads with what you can act on

**Every required choice is 100%, and the table led with all of them.** If the
menu makes you pick a protein, then 100% of burritos took a protein — a true
number that tells nobody anything. Sorted by rate, those rows filled the top of
the table and the one row worth reading, *how many people paid extra for
guacamole*, sat underneath them.

**The table now ranks by how many were actually ordered.** The busiest optional
add-on leads, and the rows that could only ever have come out one way are
folded behind "Always taken (required choices)".

**Folded away, not thrown away.** One click opens them — because "this option
is at 100%" is also how you notice a group that was built as required when it
was meant to be optional.

**The removals are still nowhere near it.** "NO onions" has never counted as an
onion order, and it now has to stay uncounted in both tables — asserted
including inside the fold.

## C-056 — How long tickets actually took

**An average is the one number that can be true of a service nobody had.**
Twenty-four six-minute tickets and six half-hour ones average eleven minutes.
The report said eleven, and the six customers who waited half an hour were not
on the screen anywhere.

**Every state now states its spread.** Beside the average, a p90 and the single
worst — so "most tickets are quick and a few are terrible" is something the
table can say instead of hiding.

**"Ran late" is a count, at the same mark the kitchen card turns red at.** Not
a second threshold that drifts from the screen the number was learned on: it is
literally the same rule, read from one place.

**And the slowest tickets are named.** Order number, day, and how long it took
— because "six ran late" is a fact and "#003 took 31 minutes on the 14th" is
something you can go and find out about.

## C-057 — Why the cancelled ones were cancelled

**Cancelled orders count toward nothing on the sales report, and that is
exactly why nobody could count them.** No sale, no items, no attach rate —
correct on every line, and it meant "we killed eleven tickets on Friday" was
something the system knew and never said.

**Two new reasons on the cancel buttons: "Customer changed their mind" and
"Kitchen error".** They were the two most common things that happened and the
two least countable, because both were being typed into "Other" as free text —
so the difference between a demand problem and a kitchen problem was a pile of
sentences nobody read.

**A cancellations table on the report: how many, and what they were worth.**
The money that never came in, beside the reason it did not.

**And what staff wrote is listed underneath.** "Other" is meant to be the rare
one now. Whether it is, is something you can see.

**Nothing in history was reclassified.** An order cancelled last month under
"Other" is still under "Other" — the new reasons apply from here, and the
migration contains no update to any existing row.

## C-058 — March, and a file the bookkeeper can open

**You can now ask the report for any two dates.** From and to, both included,
whole business days in the restaurant's own calendar. The five buttons are
still there for the questions you ask every day; the date fields are for the
one you ask at month end.

**Type the dates the wrong way round and it still works.** Two date boxes have
no idea which is which — the report sorts them and shows you the range it
used.

**And any window can be downloaded as a CSV.** One click, the days you are
looking at, with the window in the filename — so a downloads folder full of
these tells you which month is which.

**The numbers in the file are numbers.** Not "$1,234.56". A spreadsheet cannot
add up a dollar sign, and adding the column up is the entire reason anyone
opens it.

**A link, not a button.** It works with JavaScript off, and you can paste it
into an email to your bookkeeper.

## C-059 — The shelf is at the top, and Find stops emptying the board

**"Ready for pickup" is now the first thing on the kitchen screen.** It used to
be the last, under every ticket still being cooked — so the section the counter
looks at all night was the one it scrolled furthest to reach. The cooks' three
sections follow it, in the same order they always were.

**Searching a name no longer hides the queue.** Type "Cass" and every ticket
stays where it is; hers gets a blue ring and a "Match" label. The next customer
in line is still on the screen, so answering one question does not cost you the
board for the length of it.

**It tells you how many it found.** One line under the box: "1 match for
Cass". Nothing found says so too, which matters when the board looks exactly
the same either way.

**A ticket that is shouting keeps shouting.** A new order nobody has accepted,
an order left over from yesterday, an order running late — none of them fade
because somebody typed a name in. The search can add a highlight; it cannot
take one away.

## C-060 — Undo where you tapped

**Mark an order picked up by mistake and the undo is right there.** The ticket's
place on the board is held for five seconds by a small amber tile with the
order number, the name and one button: *Undo*. Same spot, same column, no
scrolling.

**It used to be at the top of the page.** The undo has always been there — in
the "Just finished" strip — and on a busy board that is a thousand pixels above
whatever you just tapped, on a five-second timer, with a bag in your other
hand. The strip is still there for when you have looked away; the tile is for
when you have not.

**The section count does not lie about it.** "Ready for pickup (4)" means four
tickets of food on the shelf. The tile holding a place is not one of them.

**Undo puts the ticket back exactly where it was**, in the same slot, and it
goes on aging from when it was really placed.
