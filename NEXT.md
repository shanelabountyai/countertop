# Next

**C-078 shipped** (`346a88d`, SHA recorded in the follow-up, gate green: 201
passed + 14 skipped = 215). PRD 5 P0-2 is done: the status page stops saying
"any minute now" once it is past the range the order was actually quoted, and
says "Running a bit behind — the kitchen still has your order" in the queue
card's own red.

**Next item: `C-079` — last call** (`docs/prds/prd-the-customer-who-is-not-in-the-room.md`
P0-3). `GateResult`'s open branch already computes `lastOrderMinute` inside
`orderingWindow()` and throws it away; carry it out, and when the gate is open
and `lastOrderMinute − now ≤ 30`, render "Last online orders in 12 min" from
ONE component on `/menu`, `/cart` and `/checkout`. The gate is already one code
path with three triggers and the warning must not become three. No migration.
Test: cutoff 10 min out renders it, 40 min out does not, identical under
`TZ=UTC` and `TZ=Pacific/Kiritimati`.

Model: **Sonnet.** One field carried out of an existing return type, one
component, three mount points, a TZ×2 test. Opus is only warranted again at
PRD 6's C-088 (binding the placement replay to its session).

Also unbuilt in PRD 5 after C-079: **C-080** (menu descriptions + category
strip), **C-081** (the untouched "Skip" pill + focus to the error), **C-082** (a
way back to your own order — gated on a Product Open Question), **C-083** (cart
quantity steppers). Then **C-088, C-089, C-090, C-093** in PRD 6.

## What C-078 leaves behind

- **The estimate line is outside the `role="status"` region.** The panel above
  it announces a status change under a poll; this paragraph flipping from a
  range to "running a bit behind" repaints silently. Pre-existing, and the fix
  is one attribute — but a second live region on the same page is a decision
  about which one wins when both change on the same poll.
- **No estimate for HOW late.** "Running a bit behind" says the promise is past
  and nothing about a new one. Deliberate: a revised range is a second promise
  from the same settings that got the first one wrong. P1-4's accuracy report
  is what would eventually make one honest.
- **Nothing tells the kitchen the customer can now see it.** The two screens
  agree, which is the item; whether that changes what an expo does with a red
  card is a product question nobody has asked.
- **`ageOrder` writes `placedAt` directly**, like `backdateQueue`. There is no
  way to make an order late through the screens and no way to wait twenty-five
  minutes for one, so it stays a fixture privilege.

## Rules C-078 established

- **When a requirement says "never says X", satisfy it in control flow, not in
  coverage.** The late branch goes FIRST so the two false sentences are
  unreachable; an assertion that they do not currently arise is only as good as
  the inputs somebody imagined. The trap here was real — the displayed range is
  computed from TODAY's open weight while lateness is measured against the
  SNAPSHOTTED quote, so a queue that grew after placement makes `remaining`
  non-null for an order that is already past its promise.
- **Reuse by narrowing the callee's parameter, not by widening the caller.**
  `isOverdue`'s `AgingThresholds` became `Pick<…, 'queueFlagMinutes'>` — the
  only field it read. Every existing caller still type-checks, and the new one
  passes the number it has instead of inventing a `readyFlagMinutes` beside it.
- **A fixture must NEVER `import('@countertop/core')` directly** (carried from
  C-077, and it bit again: `instantMinutesAfter` was the obvious helper for
  `ageOrder` and is unreachable). Reach core THROUGH `@countertop/db`. Also:
  `new Date(<millis>)` is banned by `no-time-axis` — use `new Date()` then
  `setTime()`, which crosses no calendar axis.

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
  customer screen and is not in P0-1's five. C-080 touches the composer; if it
  grows another cross-screen element, do the `(customer)` route group then.
- **The status page reads the contact columns twice** — once for the panel's
  `tel:` link, once inside the footer.
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since, including C-078's. A timeout, not an assertion. Local `retries`
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
