# Project Write-Up: Countertop — Online Ordering for a Restaurant

> Portfolio write-up. Appended as the build happens, per CLAUDE.md — scaling
> caveats, deliberate simplifications, and defects found go in **as they
> happen**, not reconstructed at the end. A write-up assembled afterwards is a
> write-up with no failure story in it.

**Repo:** https://github.com/shanelabountyai/countertop (private)
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
| Tax rate as an integer in parts per million | a float percentage, or basis points | A float rate rounds the boundary cent by luck. Basis points cannot express 8.875% (New York) — ppm can |
| Intensity `none` is a selection that does **not** count toward min/max | counting every selection alike | Otherwise "chicken → none" satisfies a required protein group and the burrito ships with no protein in it |
| `min > 0` is what "required" means — no separate flag | a `required` boolean alongside `min`/`max` | Two ways to say one thing is two ways to disagree; `required: true, min: 0` has no meaning and someone writes it eventually |
| Snapshot rows reference the menu by plain string, no foreign key | FK `onDelete: Restrict`, or `SetNull` | Restrict forbids ever deleting a menu row someone ordered; SetNull *edits a placed order*. The ids are for analytics and are never resolved for display |
| Two timestamp columns + the append-only event log | a denormalized column per status | Seven columns can disagree with the log, and a logged revert has to invent a rule about un-setting one |
| No cart tables — client-side cart, server prices every mutation | `Cart` / `CartLine` tables | They would mirror `OrderLine` field for field and need session keying and an expiry job that nothing in P0 reads |
| Every status list is a filter over one nine-field table | status strings written at each reader | Queue filters, the throttle count, the polling stop set and the alert set all have to mean the same thing. A new state is a compile error until all nine questions are answered — the readers cannot be forgotten |
| `ready` is on the kitchen queue but does **not** count as open | one "active" set for both | The food is made: it should keep aging in front of the cooks, but it must not hold the too-busy checkout gate closed |
| `picked_up` and `abandoned` are terminal *and* revertable; `cancelled` is not | no undo past the last state, or undo everywhere | The five-second undo exists for the last tap, which is the one a fat finger gets wrong. Un-cancelling would have to re-charge a refund |
| An advance may carry the state it expects to reach | advance = "whatever comes next" | Two cooks tapping the same card half a second apart otherwise skips a state. The stale tap names a state already behind, and is refused |
| The mock refund is an append-only event | a payment interface with one implementation | The event is the record either way, and an interface with one implementation carries no information. The real adapter is P2 |

## Scaling Caveats and Deliberate Simplifications

Recorded as they are made, with the ceiling each one has.

- **Fixed 5-second polling** (P0-5, resolved Open Question). Every open kitchen screen and every customer status page polls on a fixed interval — no backoff when idle. At one restaurant with a handful of screens this is free; it is linear in connected clients, so it is the first thing to change under load. The endpoint is designed as "changes since a server-issued cursor" precisely so a WebSocket upgrade swaps the transport and not the logic.
- **The daily order number resets at midnight restaurant-time**, not at a configurable business-day boundary. A late-night kitchen serving past midnight will see the number reset mid-service. Recorded in the PRD's Open Questions as the accepted v1 simplification.
- **The tax rate is a single flat configurable rate.** Real jurisdictions have category-dependent rates (prepared food vs. packaged). One rate, one rounding function, snapshotted per order.
- **Throttling counts open orders, not prep weight** (P0-6; P1-7 is the upgrade). Ten bags of chips and ten catering bowls count the same. The estimate is honest about being rough — it is shown as a range, never a point.
- **`light` intensity costs the same as `regular`** (C-002). Restaurants do not discount light sauce, and inventing a discount rule nobody asked for is a pricing policy smuggled in as a default. If a menu ever needs per-intensity pricing beyond the "extra" surcharge, it is an additive field on the option.
- **No default-included options** (C-002). "NO onions" is expressed as selecting Onions at `none`, not as deselecting something the item ships with. Default-inclusion changes what the composer screen renders and is not in P0-1; adding it later is additive to the group type.
- **The five-second undo window is UI, not engine** (C-004). `applyTransition` allows a revert whenever the transition table does; the button is what expires. Correctness never depends on a client-side timer — same reasoning as the idempotency constraint versus the disabled submit button.
- **Staff can cancel through `preparing`, not only `placed|accepted`** (C-004). The PRD's state line reads `placed|accepted → cancelled`; the wider reading was taken deliberately, because "out of item" — the first reason on the preset list — is usually discovered with the pan already hot. Cancelling food that is already `ready` is still refused: a no-show is `abandoned`, which is a different business signal.
- **The cart is a cookie, not a table** (C-005). It holds compositions and one display-only price, never authority — every total is recomputed server-side from the live menu on each read. The ceiling is the browser's ~4KB cookie limit: `writeCart` refuses over 3,900 bytes and the action returns `cart_full`, because a cookie silently dropped at 4,097 bytes would read as a lost cart. The upgrade, if real carts ever approach it, is a cart table keyed by a session id — not a bigger cookie.
- **An abandoned cart is never cleaned up, because there is nothing to clean** (C-005). No rows, no reaper job, no TTL sweep. The cart dies with the browser session.
- **Caps are per line, not per cart** (C-005). Quantity (20) and note length (140) are enforced on every line; the number of lines is bounded only by the cookie ceiling above.
- **The placement re-check and the placement write are not one transaction** (C-006). `placeOrder` re-prices and re-validates the cart against the live menu, then writes the snapshot; an 86 landing in the milliseconds between the two is snapshotted anyway. Deliberate: that order is indistinguishable from one placed a second *before* the 86, which no isolation level prevents either, and the operational answer already exists — staff cancel it with reason `out_of_item` and the customer sees why. Locking every menu row read at checkout would buy a millisecond off a window that stays open for minutes regardless.
- **The daily order number is `max(seq) + 1`, retried on the unique constraint** (C-006). Not a Postgres sequence, which cannot reset per business day, and not a counter row, which would serialize every checkout behind one lock. The ceiling is contention: each retry costs one extra round trip, and the loop gives up after 25 — which is already a harder simultaneous rush than the P0-6 throttle (default 25 *open* orders) permits. If a restaurant ever exceeds it, the upgrade is a per-day counter row taken with `SELECT … FOR UPDATE`, trading throughput for a bounded retry.
- **Placement trusts that the cart cookie is this customer's cart** (C-006). There is no session identity beyond the httpOnly cookie itself, because a pickup order needs no account. The cart is never accepted as an argument — it is read from the cookie server-side — so the attack it forecloses is "post me a cart with a $0 burrito". What it does not foreclose is someone pasting their own cookie into another browser, which places their own order twice. That is a customer being odd, not a threat.
- **`deepmerge-ts` high-severity advisory accepted, not fixed** (C-001). It arrives only through the Prisma **CLI** (`prisma` → `@prisma/config` → `deepmerge-ts`); the vulnerability is stack exhaustion when merging recursive object graphs, and the only graph merged here is our own committed config. No runtime path, and `npm audit fix` cannot resolve it without an upstream release. Revisit on the next Prisma bump.

## Defects Found

**C-001 — the drift check could never have passed.** CI's schema-drift step runs
`prisma migrate diff --from-migrations packages/db/prisma/migrations …`. With no
migrations written yet, that directory did not exist, and Prisma fails with
"Could not determine the connector from the migrations directory (missing
`migration_lock.toml`)" — not a clean no-op. Every other gate step was green, so
nothing local pointed at it.

*How it was found:* GitHub Actions refused to run the job (an account billing
block), so the CI steps got executed by hand locally instead of being trusted.
The drift command failed on the first try. Had CI been available, this would
have shipped as a red first run; had CI been available *and* the step been
written to tolerate the error, it would have shipped as a check that silently
verified nothing until C-003.

*Fix:* commit `packages/db/prisma/migrations/migration_lock.toml` with
`provider = "postgresql"` — the file Prisma would have written with the first
migration anyway — so the history has a declared connector from zero migrations
onward.

*What I'd instrument next time:* a CI step that can only pass vacuously is worth
running against an empty repo state before there's anything for it to check.

**C-003 — a lint ban too broad to obey.** The time-axis rules ban `new Date(...)`
with arguments, because `new Date('2026-07-04')` parses through whatever
timezone the server booted in. But the selector also caught
`new Date(Date.UTC(...))` — the one argument form that provably *cannot* read
the process timezone, and the exact way every test builds the frozen instant the
engine takes as a parameter.

*How it was found:* the first database tests failed lint, not assertions.

*Fix:* narrow the selector to exempt that one shape, verified against a probe
file where a string, a bare epoch number, and `Date.UTC(...) + 1000` are all
still rejected. The `packages/core` clock ban was narrowed the same way, to
zero-argument `new Date()` and `Date.now()` — which is what "reads the clock"
actually means.

*Why it mattered more than it looks:* left alone, the workaround was an
`eslint-disable` at the top of every test file from here to the end of the
project. A rule that is routinely disabled is not a rule, and the disable
comment would have quietly covered the real violations too.

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
