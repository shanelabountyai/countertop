# Next

**C-114 shipped this session** (SHA to be recorded in a follow-up commit,
never by amending): master PRD P1-2, order-ahead scheduling. A "When" picker
at checkout offers ASAP or a pickup slot, off by default. `availableSlots` is
a sibling gate to `checkoutGate` — same manual-pause/closed-today precedence,
deliberately NOT the throttle, since a slot's own remaining prep weight
(same scale `maxOpenWeight` uses) is its own capacity check. Gate green: 957
unit (+24 over C-113's 933), 221 e2e passed + 14 skipped = 235 (+3), lint/
typecheck/build clean.

Picked over loyalty's P1-1 (self-serve redemption before tax) because that
item needs its own design pass first — "what counts as verification for a
one-way SMS stub" has no answer yet — and this one had a straightforward
build once C-113 existed.

**Next unblocked item:** none picked yet. Real options:
- **Loyalty P1-1** — still gated on the verification-design question
  `docs/prds/prd-loyalty.md` names. Needs a small design pass before code,
  not a straight build.
- **P2 items off the master PRD** — nothing else has a product-decision
  gate; see the master PRD's "Future Considerations" list. WebSocket
  transport, a real payment adapter, combos/nested modifiers, reorder,
  tips, kitchen station routing, a ticket printer, real SMS, and the
  catering/multi-day-scheduling growth of this session's own item are all
  candidates with no design blocker.

**Model:** whichever comes next, recommend at that item's start per the
usual rule. Loyalty P1-1 touches money (tax base, `discountCents`) — lean
Opus for the design of that one. Most P2 items are routine build — Sonnet.

## What C-114 leaves behind

- **The queue's 15-minute "N min since ordered — running late" flag does not
  know about `requestedFor`.** A scheduled order sitting untouched well
  before its slot can still redden — `queueAging` reads only `placedAt`. The
  "Pickup HH:MM" badge on the card is the mitigation (a cook sees why), not
  the fix. The real fix touches `queueAging`, which the P0-6 throttle and
  P0-7 estimate also depend on — its own session, not a rider.
- **Same-day only.** No multi-day slot picker — the master PRD's own P2 list
  names "catering / large-order lead-time rules" as P1-2 grown up, a
  different and larger feature, not this one with an extra input.
- **A fully-booked day degrades silently to ASAP-only** — no "nothing left
  today" copy, the same way loyalty-off degrades to no punch card.
- **The confirmation screen renders the pickup time in the customer's OWN
  device clock**, not the restaurant's — a deliberate, reasoned exception to
  this project's time rules (see the component's own comment and the
  WRITEUP entry). The status page and kitchen queue use the restaurant's
  timezone as normal.
- **No fixture pinned to an actual DST-transition date** for
  `zonedTimeToInstant` — a `ponytail:` comment on the function names the gap.

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
  customer screen and is in none of P0-1's five, P0-3's three, or P0-4's two.
  Still open; touch it if another cross-screen element grows there.
- **The status page reads the contact columns twice** — once for the panel's
  `tel:` link, once inside the footer.
- **The status page's estimate line is outside the `role="status"` region**
  (C-078). One attribute, but a second live region is a decision about which
  one wins when both change on the same poll.
- **The last-call warning does not tick** (C-079) — `force-dynamic` renders
  with no poll, so twelve minutes on the page still reads "in 12 min".
- **`setLastOrderIn` cannot express the last `minutesOut` minutes of the local
  day** (C-079); it throws rather than clamping.
- **Twenty-two of twenty-five items have no description** (C-080) — the
  mechanism ships, the copy is a restaurant's job.
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since. A timeout, not an assertion. Local `retries` is 0, CI's is 1.
  First place to look if a refund spec times out again.
- **`e2e/cart.spec.ts:65`** ("the header cart count drops a line that gets
  86'd out from under it") failed once at 6.6s mid-sweep during C-113's gate
  run and passed 3/3 in isolation immediately after, unrelated to anything
  C-113 touched. Same shape as the refund flake above — a second data point
  for "timeout under load," not yet enough to call it a pattern.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
