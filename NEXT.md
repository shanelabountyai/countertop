# Next

**C-079 shipped** (`00f97ba`, SHA recorded in the follow-up, gate green: 203
passed + 14 skipped = 217). PRD 5 P0-3 is done: `GateResult`'s open branch
carries `lastOrderMinute` and `minutesUntilLastOrder`, and one `LastCall`
component on `/menu`, `/cart` and `/checkout` says "Last online orders in 12
min — we stop taking them at 20:45" inside the last half hour.

**Next item: `C-080` — the menu says what the food is** (PRD 5 P0-4). A
`description` column rendered on `/menu` with no composer opened, editable in
the builder, plus the category jump strip. The trap is in the PRD's Invariant
Impact 1: `description` is a LIVE-menu field, so it must not follow onto the
confirmation, the receipt or the status page, where an item's name is a
snapshotted copy — a description there is a menu join, which is the defect this
project exists to prevent. The snapshot regression test is extended to rename
an item *and* rewrite its description, then assert every placed order's receipt
is byte-identical. Migration: one nullable text column.

Model: **Sonnet.** A column, a render, a builder field and one extended
regression test. Opus is warranted again at PRD 6's C-088 (binding the
placement replay to its session).

Also unbuilt in PRD 5 after C-080: **C-081** (the untouched "Skip" pill + focus
to the error), **C-082** (a way back to your own order — gated on a Product
Open Question), **C-083** (cart quantity steppers). Then **C-088, C-089,
C-090, C-093** in PRD 6.

## What C-079 leaves behind

- **The warning does not tick.** `/menu`, `/cart` and `/checkout` are
  `force-dynamic` server renders with no poll, so sitting on the page for
  twelve minutes still reads "in 12 min". Making it live means a client
  component and a second cursor for a number that is only a hint.
- **The last `minutesOut` minutes of the local day are unreachable from
  `setLastOrderIn`.** `closeMinute` is capped at 1440 by a CHECK and no hours
  row means "tomorrow", so `setLastOrderIn(40)` throws between 23:20 and
  midnight rather than clamping. The unit tests carry the real coverage and
  take a frozen `now`.
- **The seeded restaurant shows the warning after 23:30.** Round-the-clock
  hours with `cutoffMinutes: 0` puts last call at midnight. Truthful, nothing
  asserts its absence, but the screenshot specs would look different that late.
- **Nobody warns the customer already IN checkout when the door shuts.** The
  form was rendered while the gate was open; `placeOrder` refuses the POST,
  correctly, but as a failure rather than as this warning. The warning is a
  render and that customer is past the last one.
- **Thirty minutes is still the PRD's unanswered Open Question.**
  `LAST_CALL_MINUTES` is one const in `apps/web/app/checkout/last-call.tsx`.

## Rules C-079 established

- **Carrying a value out of a function is easy; the decision is where its
  derivatives get computed.** A raw `lastOrderMinute` handed to three callers
  invites three of them to subtract `now` three ways. Derive at the source and
  hand that out too — a second field on a return type is cheaper than a second
  clock. (`docs/WRITEUP.md`, C-079.)
- **"One component" is not the same as "one answer".** A single component
  mounted three times stops the SCREENS disagreeing. It does nothing about the
  screen and the server disagreeing, which is the pair that actually refuses an
  order.
- **`toEqual({ open: true })` was an exact-shape assertion** and eight tests
  used it. Adding a field to a union branch is where that bites; `toMatchObject`
  states what each test is actually about.

## Still open from earlier items

- **No per-batch menu-change event** — PRD 4's builder Open Question, still the
  only thing open in that document.
- **`setAvailability` is read-then-write** (`ponytail:` comment),
  last-write-wins.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out."
- **No daypart editor**, no overnight daypart window, no schedule view for
  staged prices, and superseded staged rows are never collected.
- **A sixth customer route can forget the footer** — `/menu/[itemId]` is a
  customer screen and is not in P0-1's five, and it is now not in P0-3's three
  either. C-080 touches the composer; if it grows another cross-screen element,
  do the `(customer)` route group then.
- **The status page reads the contact columns twice** — once for the panel's
  `tel:` link, once inside the footer.
- **The status page's estimate line is outside the `role="status"` region**
  (C-078). One attribute, but a second live region is a decision about which
  one wins when both change on the same poll.
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since, including C-079's. A timeout, not an assertion. Local `retries`
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
