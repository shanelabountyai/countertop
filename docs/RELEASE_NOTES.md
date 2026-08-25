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
