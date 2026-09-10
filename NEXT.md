# Next

**C-113 shipped this session** (`2524c33`, SHA recorded in this same commit):
master PRD P1-3, the SMS stub outbox. One row in `NotificationOutbox` on the
transition into `ready`, gated on the order having a phone, rendered on the
staff receipt only. No phone column of its own — the number is read live off
`Order.customerPhone`, so "forget this customer" (PRD 6 P0-4) gains no second
place to reach. Gate green: 933 unit (+4), 218 e2e passed + 14 skipped = 232
(+2), lint/typecheck/build clean.

Picked over the other open P1 item (order-ahead slots) because it unblocks a
second PRD: loyalty's own P1-1 (self-serve redemption before tax) names SMS
as its hard prerequisite. **That prerequisite is still not satisfied** — the
stub is one-way with no reply channel and no code to confirm a phone
against, and `docs/prds/prd-loyalty.md` now says so explicitly rather than
"SMS is unbuilt."

**Next unblocked item:** none picked yet. Two real options now, both bigger
than a one-line fix:
- **Loyalty P1-1** — self-serve redemption before tax, now that SMS
  *exists*. Still needs a real answer to "what counts as verification" for a
  one-way stub before any code — likely needs its own small design pass, not
  just "start building."
- **P1-2 (order-ahead scheduling)** — "pickup at 12:30" slots with per-slot
  capacity, reusing slot-thinking from Bookable. No product-decision gate;
  straightforward next pick if loyalty's verification question stalls.

**Model:** whichever comes next, recommend at that item's start per the usual
rule. Loyalty P1-1 touches money (tax base, `discountCents`) — lean Opus for
the design of that one. P1-2 is routine build — Sonnet.

## What C-113 leaves behind

- **No customer-facing surface at all.** The PRD named only the outbox log;
  nothing here changes what a customer sees or receives.
- **One message, one trigger.** `readyMessage(seq)` exists as a function
  (not an inline template) specifically so a second trigger (placed, picked
  up) has one place to add its own wording later.
- **No append-only trigger on `NotificationOutbox`**, unlike `OrderEvent` —
  a `ponytail:` comment in the schema names the upgrade path (a real
  provider's delivery receipt needing to update a row here).

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
