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
