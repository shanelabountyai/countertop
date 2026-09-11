# Next

**C-118 shipped this session** (`65dc197`): the checkout redemption control — PRD 7
P1-1's fourth, unphased piece, and the one that makes **P1-1 live**. A
customer with a full punch card can now verify their phone from their own
screen and take $10 off *before tax*: on the sample burrito that is $5.36
rather than the counter flow's $6.18, and the 82c difference is sales tax
the shop was remitting on a discount.

What landed: `planCheckoutRedemption` in `packages/core` (a second pure
decision beside `planRedemption`, bounded by the SUBTOTAL rather than by
what an order owes — two different questions, so two functions and not a
flag); `placeOrder` taking an optional `verifiedPhoneToken` and writing the
order and its `redeem` row in ONE transaction; `settleRedemptionForOrder`,
which hands the points back when the order dies and re-spends them if a
reverted no-show is collected after all; the "Use a reward" control on
checkout plus a `Punch card reward` line on all four receipts; and
`discountCents` as a fourth money column on the sales report.

**Both decisions NEXT.md flagged as "a guess, not a decision" were put to
the owner and answered before any code was written:**
1. *Which redemption path wins.* **Checkout, structurally, with no new
   mechanism.** Checkout is always first — the counter needs an order that
   exists — so the checkout `redeem` bound to the new `orderId` makes
   C-104's partial unique index and `planRedemption`'s own `alreadyRedeemed`
   refuse the counter path by the name they already had.
2. *`report.ts`'s `SalesTotals`.* **A fourth column; `subtotalCents` stays
   gross.** The identity is now `net − rewards + tax = gross` on every day
   row, every hour row and the window — the same one C-117's CHECK enforces
   at the row. Netting the reward into the subtotal was cheaper and would
   have made the punch card's cost in food invisible on the one screen an
   owner decides with.

A third question was asked and answered the same way: **a cancelled or
abandoned order hands the reward back**, as a logged `adjust` and never a
delete.

## Next unblocked item: the concurrent-checkout balance race

**This is the one real defect C-118 leaves, and it is named rather than
hidden.** Two checkouts for the same member, in flight at once, each read a
balance of 100 and each write a `redeem`. The partial unique index is per
*order*, so neither collides, and there is no constraint holding a member's
balance at or above zero — so the member ends at −100 and got two rewards
for one.

Pre-existing in *shape*: two counter redemptions on two different orders
have always been able to do this. **Widened by C-118**, because self-serve
makes two simultaneous checkouts something one person can actually do from
two tabs, deliberately, in ten seconds.

The shape of the fix, and the decision it needs: this repo's own rule is
*the constraint is the mechanism*, and a balance is a SUM over rows with no
column to constrain. So it is one of —
- a `SELECT … FOR UPDATE` on the member row inside placement's transaction
  (a lock, which this repo has deliberately avoided everywhere else — see
  placement's own `ponytail:` about not locking menu rows), or
- a materialised balance column with a `>= 0` CHECK and an agreement test
  against the ledger over the seeded rush (the `paymentState` shape,
  decision 5 — but C-100 refused a balance column *explicitly*, with a
  written reason, so this reverses a recorded decision and needs to say
  so), or
- a partial unique index on `(memberId)` over un-settled redemptions, which
  caps a member at one live redemption at a time and is the cheapest of the
  three — but changes the product rule from "one reward per order" to "one
  reward in flight per member", which is a product decision, not a schema
  one.

**Ask the owner which, before building.** All three are defensible and they
are not the same product.

**Model: Opus.** It reverses or reinterprets a recorded decision (C-100's
"there is no balance column, deliberately") and it touches the money path
under concurrency.

## What C-118 leaves behind

- **The balance race above.** The item.
- **No `PhoneVerification` sweep** (C-115's `ponytail:`) — and C-118 makes
  that table busier rather than less so, because every reward now costs at
  least one row.
- **A customer who abandons a checkout and comes back verifies again.** The
  new attempt gets a new `idempotencyKey` and the old token is bound to an
  attempt that no longer exists. That is C-116's binding working exactly as
  designed; it is also a second SMS for one order, and on a real carrier
  that is a real cost.
- **The rush script does not exercise a checkout redemption.** Its ugly-case
  list is the PRD's Success Metrics verbatim, so adding one is a deliberate
  decision about that list rather than a drive-by — but the rush is the
  capstone demo and the punch card is now a customer-visible feature that
  the demo never shows.
- **`Order.discountCents` has exactly one producer.** If a second ever
  appears (a promo code, a manager's pre-tax comp), `settleRedemptionForOrder`
  assumes the discount and the `redeem` row are the same fact.

## Environment note for whoever runs the gate next

**Ten e2e specs fail in a fresh container and it is not the code.**
`contact`, `last-call` ×2, `menu-editing` ×2, `menu` ×3 and `refund` ×2 die
with `Error: request for './menu/index' is from a module not been linked` —
an ESM loader failure in the fixtures that use a late
`await import('@countertop/db')` (`setDaypart`, `setLastOrderIn`,
`failRefundFor`, the staged-price helpers, `clearRestaurantContact`).
**Verified pre-existing by stashing all of C-118 and running those same ten
specs on `f239791`, where they fail identically.** Everything else is green:
218 passed + 14 skipped, loyalty 20/20. If you can reproduce this on the
developer's own machine it is a real bug and its own item; if you cannot, it
is the container's loader and belongs in this note rather than in the
backlog.

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
- **`e2e/cart.spec.ts:65`** ("the header cart count drops a line that gets
  86'd out from under it") failed once at 6.6s mid-sweep during C-113's gate
  run and passed 3/3 in isolation immediately after. Same shape as the refund
  flake above — a second data point for "timeout under load," not yet a
  pattern.
- **The queue's 15-minute "N min since ordered — running late" flag does
  not know about `requestedFor`** (C-114) — a scheduled order sitting
  untouched well before its slot can still redden. The "Pickup HH:MM" badge
  is the mitigation, not the fix; the fix touches `queueAging`, its own
  session.
- **Same-day only** for order-ahead (C-114) — multi-day is the master
  PRD's own catering/lead-time P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114) — no
  "nothing left today" copy.
- **No fixture pinned to an actual DST-transition date** (C-114) for
  `zonedTimeToInstant` — a `ponytail:` comment on the function names the gap.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
