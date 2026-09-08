# Next

**C-077 shipped** (`1a79be7`, SHA recorded in `8c0fc9c`, CI green). PRD 5 P0-1
is done: three nullable contact columns on the settings singleton, a footer on
the five customer routes, and the `tel:` link inside the cancelled and
abandoned status panels.

**Next item: `C-078` — the status page tells the truth about being late**
(`docs/prds/prd-the-customer-who-is-not-in-the-room.md` P0-2). The status page
polls faithfully every five seconds and says "Should be ready any minute now"
forty times while the kitchen screen already knows the order is `overdue` and
renders "— running late" in bold red. Reuse the queue's OWN `overdue`
computation (`isOverdue` / `queueAging` in `packages/core/orders/queue.ts`),
compared against the quote SNAPSHOTTED on the order at C-042 — not against
today's settings. No migration.

Model: **Sonnet.** One comparison, one copy change, two tests. The `overdue`
computation already exists and the snapshotted quote already exists; the whole
item is wiring them to a sentence. Opus is only warranted again at PRD 6's
C-088 (binding the placement replay to its session).

Also unbuilt in PRD 5 after C-078: **C-079** (last call), **C-080** (menu
descriptions + category strip), **C-081** (the untouched "Skip" pill + focus to
the error), **C-082** (a way back to your own order — gated on a Product Open
Question), **C-083** (cart quantity steppers). Then **C-088, C-089, C-090,
C-093** in PRD 6.

## What C-077 leaves behind

- **A sixth customer route can forget the footer, and one already has.** The
  composer at `/menu/[itemId]` is a customer screen and is not in P0-1's five.
  A `(customer)` route group with a layout makes it structural — and moves six
  directories, which is the change to make when a SECOND thing belongs on every
  customer screen, not for this one. C-080 touches the composer; if it grows
  another cross-screen element, do the route group then.
- **The status page reads the contact columns twice** — once for the panel's
  `tel:` link, once inside the footer. A prop would fix it and would also be
  the thing a page can render the footer without.
- **An extension in the phone field dials as digits.** `(562) 555-0148 ext. 2`
  becomes `tel:56255501482`. Deliberate: the alternative is a parser, and a
  parser wrong about a real number is worse than a dialler right about most.
- **No map link.** The address is text; a maps URL is a second decision about
  which map.

## Rules C-077 established

- **A fixture must NEVER `import('@countertop/core')` directly.** It loads
  under Playwright's transform as plain CJS and leaves the broken copy in the
  require cache, so the next spec to reach `@countertop/db/menu` dies on
  `Unexpected token 'export'` — in a file that did nothing wrong, a hundred
  tests later, and it passes in isolation. Reach core THROUGH `@countertop/db`
  (`loadClock()` is the clock). The reason is a comment in `fixtures.ts`.
- **Adding a database read to a component is a statement about every page that
  renders it.** `/` was the last statically prerendered route and nothing
  failed — the tell was the `○` beside `/` in the build's own route table where
  every other customer route had `ƒ`. Check that table whenever a shared
  component starts reading something.
- **A footer's hours are a WORDING of the gate's state, not a second reading.**
  `todaysHours` takes the same `GateState` `checkoutGate` takes. It says
  nothing about the cutoff or the pause switch — those decide whether an order
  can be PLACED; the hours are when the door is open.

## Still open from earlier items

- **No per-batch menu-change event** — PRD 4's builder Open Question, still the
  only thing open in that document.
- **`setAvailability` is read-then-write** (`ponytail:` comment),
  last-write-wins.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out."
- **No daypart editor**, no overnight daypart window, no schedule view for
  staged prices, and superseded staged rows are never collected.
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since, including C-077's. A timeout, not an assertion. Local `retries`
  is 0, CI's is 1. First place to look if a refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
