# Next

**C-117 shipped this session** (`a1f8faa`): PRD 7
P1-1, session 3 of 3 — the tax base. `Order.discountCents` (snapshotted,
`@default(0)`, hand-written migration with three CHECKs — not negative, not
exceeding `subtotalCents`, and `totalCents = subtotalCents - discountCents +
taxCents` enforced at the row) and `priceOrder` computing tax on `subtotal −
discount` rather than the raw subtotal. `buildOrderSnapshot` threads the new
parameter through; `remakeOrder` now copies `discountCents` so a remade
order of a (future) discounted one can't silently drop it and fail its own
new CHECK. Gate green: 1007 unit (+8 over C-116's 999), 221 e2e passed + 14
skipped = 235 (unchanged — no UI shipped this session), lint/typecheck/build
clean.

**Corrected in the PRD this session, not just shipped:** the phasing section
said P1-1 goes live once all three of C-115/C-116/C-117 ship. That was an
undercount. The three sessions are the *mechanism* — a verified phone, a
token that carries it, somewhere honest for a reward to land in the tax
math — and none of them is a checkout control. Nothing calls
`planRedemption`, computes a `discountCents`, and hands it to `placeOrder`
yet. `docs/prds/prd-loyalty.md`'s C-117 entry and `docs/prds/INDEX.md` both
say so now.

**Next unblocked item: the checkout self-serve redemption control —
unphased, the fourth piece P1-1 actually needs.** Read
`docs/prds/prd-loyalty.md`'s C-117 entry (the closing paragraph) before
starting. Shape, roughly: a "use your reward" affordance on the checkout
form, gated on a verified phone (C-116's `verifiedPhoneToken`) and an
available balance (`planRedemption`), that computes a `discountCents` and
passes it through `placeOrder` → `buildOrderSnapshot` → `priceOrder`. Two
things this needs a decision on, not just code:
1. **P0-4's after-tax counter redemption and this before-tax checkout
   redemption are now two different mechanisms that both spend the same
   balance.** They need to agree on which one runs when both are possible
   for the same order — likely "whichever happens first wins, and the other
   is refused as already-redeemed," but that's a guess, not a decision.
2. **`report.ts`'s `SalesTotals`** currently sums `subtotalCents`/
   `taxCents`/`totalCents` and its own test asserts `subtotalCents +
   taxCents === totalCents` per bucket — true only because `discountCents`
   is always 0 today. The first real discount breaks that identity, and the
   report needs a `discountCents` bucket and an updated invariant before or
   in the same session a real discount can be produced.

**Model: this item is customer-facing money UI on top of the arithmetic
C-117 just landed — still Opus**, not Sonnet: it decides how two redemption
paths interact and touches what a receipt shows.

## What C-117 leaves behind

- **No checkout control a customer can reach — still.** Same shape C-115
  and C-116 left, one layer further along: the tax base exists and is
  tested, but nothing produces a nonzero `discountCents` yet.
- **`redeemReward`/`planRedemption` (P0-4) are untouched and still
  after-tax.** Deliberately — C-117's own scope was "nothing else moving in
  the same diff." They become the interaction problem above the moment a
  before-tax path exists alongside them.
- **`report.ts`'s `subtotalCents + taxCents === totalCents` comment and test
  are accurate today and stale the moment a real discount exists.** See
  point 2 above — this is the first place a real discount will break
  something that isn't a schema CHECK.
- **No receipt anywhere renders `discountCents`.** Checkout page, cart page,
  status page, staff order-detail page — none of them read the new field.
  The UI work is entirely in the next item, not this one.

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
- **The queue's 15-minute "N min since ordered — running late" flag does
  not know about `requestedFor`** (C-114) — a scheduled order sitting
  untouched well before its slot can still redden. The "Pickup HH:MM" badge
  is the mitigation, not the fix; the fix touches `queueAging`, its own
  session.
- **Same-day only** for order-ahead (C-114) — multi-day is the master
  PRD's own catering/lead-time P2 item, not this one grown up early.
- **A fully-booked day degrades silently to ASAP-only** (C-114) — no
  "nothing left today" copy, the same way loyalty-off degrades to no punch
  card.
- **No fixture pinned to an actual DST-transition date** (C-114) for
  `zonedTimeToInstant` — a `ponytail:` comment on the function names the gap.
- **No sweep ever deletes an old `PhoneVerification` row** (C-115).
  `ponytail:` comment on the model names the upgrade path (a periodic
  delete past `expiresAt`, same shape as the retention sweep) and the
  ceiling (fine until a shop sees far more than a few dozen redemption
  attempts a day).

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
