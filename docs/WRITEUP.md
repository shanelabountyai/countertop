# Project Write-Up: Countertop — Online Ordering for a Restaurant

> Portfolio write-up. Appended as the build happens, per CLAUDE.md — scaling
> caveats, deliberate simplifications, and defects found go in **as they
> happen**, not reconstructed at the end. A write-up assembled afterwards is a
> write-up with no failure story in it.

**Repo:** _(added with the first push)_
**Live demo:** _(Vercel, later)_
**Built with:** Claude Code + Next.js (App Router) · TypeScript · Postgres/Prisma · Tailwind · Vitest/Playwright + axe
**Status:** In progress · Started 2026-08-25

---

## The Business Problem

Phone orders tie up staff during the rush, get transcribed wrong ("no onions"
becomes extra onions), and leave the kitchen with no idea what's coming.
Third-party delivery platforms fix the ordering but take a large cut of every
ticket. Countertop is a fast-casual restaurant's own pickup-ordering flow:
customers compose exactly what they want at a price the server guarantees, and
the kitchen works a live queue that announces itself when a new order lands.

## What I Built

_(Filled in as phases land.)_

## How It's Built

_(Filled in as phases land.)_

**Key design decisions**

| Decision | Alternative considered | Why |
|---|---|---|
| Money is integer cents everywhere, one rounding function | floats, or `Decimal` that becomes a float at the boundary | Float rounding corrupts money math, and it corrupts it quietly — the failure shows up as a receipt that's a cent off, months later |
| A placed order is an immutable **copy** of what it was composed from | foreign keys back to live menu rows | A price edit at 4pm must not change what a 2pm receipt says. If an order row joins a menu table to render, that's the defect |
| The server recomputes every line and the tax at placement | trusting the client's total | Client prices are display-only; a client-supplied total is input to a mismatch log, never to the database |
| A unique constraint on the idempotency key | a disabled submit button | The disabled button is UX. Correctness never depends on the client behaving |
| One status module every reader derives from | status strings inlined at each call site | Adding a state should make the compiler find every reader, not require grep |

## Scaling Caveats and Deliberate Simplifications

Recorded as they are made, with the ceiling each one has.

- **Fixed 5-second polling** (P0-5, resolved Open Question). Every open kitchen screen and every customer status page polls on a fixed interval — no backoff when idle. At one restaurant with a handful of screens this is free; it is linear in connected clients, so it is the first thing to change under load. The endpoint is designed as "changes since a server-issued cursor" precisely so a WebSocket upgrade swaps the transport and not the logic.
- **The daily order number resets at midnight restaurant-time**, not at a configurable business-day boundary. A late-night kitchen serving past midnight will see the number reset mid-service. Recorded in the PRD's Open Questions as the accepted v1 simplification.
- **The tax rate is a single flat configurable rate.** Real jurisdictions have category-dependent rates (prepared food vs. packaged). One rate, one rounding function, snapshotted per order.
- **Throttling counts open orders, not prep weight** (P0-6; P1-7 is the upgrade). Ten bags of chips and ten catering bowls count the same. The estimate is honest about being rough — it is shown as a range, never a point.
- **`deepmerge-ts` high-severity advisory accepted, not fixed** (C-001). It arrives only through the Prisma **CLI** (`prisma` → `@prisma/config` → `deepmerge-ts`); the vulnerability is stack exhaustion when merging recursive object graphs, and the only graph merged here is our own committed config. No runtime path, and `npm audit fix` cannot resolve it without an upstream release. Revisit on the next Prisma bump.

## Defects Found

_(Each one gets: how it manifested, how it was found, what fixed it.)_

## Skills Learned / Functions Unlocked

_(Filled in as phases land — menu variant modeling, order-queue state
transitions, near-real-time UI updates, price computation from composed
selections.)_

## The Hardest Bug

_(Reserved. There will be one.)_

## What I'd Do Differently

_(Reserved for the end.)_

## By the Numbers

_(Reserved for the end.)_
