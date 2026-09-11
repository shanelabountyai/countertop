# Next

**C-119 shipped this session**: the member lock — the defect C-118 named and
left, closed on **both** redemption paths. PRD 7 P1-1 is live *and* safe
under concurrency.

The defect was reproduced before anything was written — a throwaway probe
firing two checkouts for one member returned `placements ok = 2, redeems = 2,
balance = -100`. One customer, two $10 rewards, one punch card. C-104's
partial unique index cannot catch it: that index is per ORDER, and these are
two orders.

**The fix is two statements in the other order.** `lockMemberBalance` runs
the `lastActivityAt` UPDATE a redemption owes anyway *first* — taking
Postgres's row lock — and sums the ledger behind it, so the second attempt
blocks, wakes, and finds the points gone.
`confirmCheckoutRedemption` re-asks `planCheckoutRedemption` the same
question the plan was built from, inside placement's transaction and
**before** `Order.create` so a refusal leaves no gap in the day's numbers.
Both paths *throw* their refusal rather than returning it, because inside a
transaction a returned refusal commits what preceded it. No migration, no
balance column — **C-100's written refusal of one stands** — and no change to
what the product promises anyone. `redeemReward` got the same reorder; it has
had this defect since C-104.

**Read `docs/WRITEUP.md`'s C-119 entry before writing another concurrency
test.** The short version: the six obvious regression tests all passed, and
then five of six *kept* passing with the lock deliberately neutered, because
two `placeOrder` calls do enough work before their transactions that the
first commits before the second opens. The mechanism needed a test that holds
one transaction open on purpose. "The test passes" and "the test would fail
if the code were wrong" are different claims and only the second is worth
anything.

## Next unblocked item: the rush script does not show the punch card

Pick this one unless you would rather clear debt below. It is the largest
gap between what the product *does* and what its capstone demo *shows*.

The seeded rush is both the portfolio demo and a test — CLAUDE.md says so —
and self-serve redemption is now a customer-visible feature it never
exercises. Nothing in `rush-demo.ts` enrols a member, earns points, or spends
a reward, so the one recording that is supposed to walk somebody through this
product ends without ever mentioning the thing the last five sessions built.

**This needs a decision before it needs code, and it is a real one.** The
rush's ugly-case list is the master PRD's Success Metrics *verbatim* — a
mid-rush option 86 with an affected cart, a wrong-advance and undo, a no-show
aging to `abandoned`, a deliberate double-submit, orders arriving while
paused. Adding a sixth case means either:
- **amending the Success Metrics** to name a redemption, which is editing the
  master PRD's acceptance criteria and should be recorded as a decision with
  a reason, not done quietly; or
- **seeding loyalty state alongside the rush without adding a rush case** —
  a member with a balance, one order carrying a checkout redemption — so the
  queue, the receipts and the loyalty screen all have something real on them
  during the demo, while the thirty-orders-in-twenty-minutes script stays
  exactly as specified.

The second is smaller, keeps a specified list specified, and still fixes the
demo. **Ask the owner which.** Whichever way it goes, the rush is a *test* as
well as a demo, so the case that gets added has to assert something — "zero
stuck, lost or duplicated orders" is the bar the other five are held to, and
the redemption equivalent is that the ledger and the snapshots reconcile at
the end of the rush.

**Model: Sonnet is probably enough** if the decision above is taken first and
the answer is the second option — it is seed data and assertions against
mechanisms that already exist and are already tested. Opus if the Success
Metrics are being amended, because that is a PRD change.

## What C-119 leaves behind

- **No deadlock is constructible — but that is an argument, not a test.** The
  lock is one row, taken once, at the top of both transactions. A second lock
  taken anywhere in either would change that, and nothing enforces it.
- **`reward_terms_changed` has no test.** Reaching it needs the reward's cash
  value edited between a plan and its confirmation, and C-106 deliberately
  ships no control for that value, so the only way to exercise it is a raw
  settings write mid-transaction. Recorded rather than faked.
- **Nothing bounds a staff `adjust` below zero.** Both plan functions refuse
  it and the CHECKs hold each row's sign, but a person typing −500 into the
  correction control still can. Pre-existing, screen-level, not this item's.
- **The sleeps in the lock test are 250ms each.** Deterministic in practice
  and not a guarantee. If it ever flakes, it is the machine being slower than
  half a second, not the lock failing — raise the pauses, do not delete the
  test.

## Still open from C-118

- **No `PhoneVerification` sweep** (C-115's `ponytail:`) — every reward costs
  at least one row and nothing ever deletes them.
- **A customer who abandons a checkout and comes back verifies again.** The
  new attempt gets a new `idempotencyKey`, so the old token is bound to an
  attempt that no longer exists. C-116's binding working as designed, and
  also a second SMS per order on a real carrier.
- **`Order.discountCents` has exactly one producer.** If a second ever
  appears (a promo code, a manager's pre-tax comp),
  `settleRedemptionForOrder` assumes the discount and the `redeem` row are
  the same fact.

## Environment note for whoever runs the gate next

**Ten e2e specs fail in a fresh container and it is not the code.**
`contact`, `last-call` ×2, `menu-editing` ×2, `menu` ×3 and `refund` ×2 die
with `Error: request for './menu/index' is from a module not been linked` —
an ESM loader failure in the fixtures that use a late
`await import('@countertop/db')` (`setDaypart`, `setLastOrderIn`,
`failRefundFor`, the staged-price helpers, `clearRestaurantContact`).
Verified pre-existing at C-118 by stashing that whole change and running the
same ten specs on `f239791`, where they fail identically; unchanged this
session. Everything else is green: 218 passed + 14 skipped. If you can
reproduce this on the developer's own machine it is a real bug and its own
item; if you cannot, it is the container's loader and belongs in this note
rather than in the backlog.

**Also container-only:** Playwright wants browser build 1234 and the image
ships 1194. Symlinking `/opt/pw-browsers/chromium_headless_shell-1234/…` at
the expected path is what let the e2e leg run at all; it is not a repo
change and there is nothing to commit for it.

## Still open from earlier items

- **No per-batch menu-change event** — PRD 4's builder Open Question, still the
  only thing open in that document.
- **`setAvailability` is read-then-write** (`ponytail:` comment),
  last-write-wins. **Worth re-reading now**: C-119's lock is the cheapest
  precedent in the repo for fixing exactly this shape.
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
  flake above — a second data point for "timeout under load," not a pattern.
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
  voids now, which is C-069 working. ~six lines to restore. **Pairs naturally
  with the rush item above.**
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
