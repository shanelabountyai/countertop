# Next

**C-116 shipped this session** (`61f7d23`, SHA recorded in this same commit):
PRD 7 P1-1, session 2 of 3 — checkout wiring for phone verification. A
bearer token (`issueVerifiedPhoneToken`/`verifiedPhoneFromToken` in
`packages/db/verification.ts`, same signed shape as `staff.ts`'s
`shiftStamp`/`staffIdFromStamp`) carries a confirmed phone-verification code
from confirmation to placement, bound to the checkout attempt's own
`idempotencyKey` so it cannot be replayed onto a different order. No new
session or cookie. `packages/core/loyalty/verification.ts` gained
`canUseVerifiedToken` (the pure decision on an already-signature-checked
token); `apps/web/app/checkout/actions.ts` gained
`requestCheckoutVerification`/`confirmCheckoutVerification` and
`placeCartOrder` validates an optional `verifiedPhoneToken` against the
placed order's own snapshotted phone. Gate green: 999 unit (+14 over
C-115's 985), 221 e2e passed + 14 skipped = 235 (unchanged — no UI shipped
this session), lint/typecheck/build clean.

**Scope decision, recorded in `docs/prds/prd-loyalty.md`'s phasing section
and `docs/WRITEUP.md`: no checkout FORM control renders this session.** The
backlog bullet's own words ("the self-serve control itself") read like a UI
requirement on a fast pass; the PRD's own next sentence ("no checkout
control exists... until all three ship") says otherwise, and a "verify your
phone" widget with no `discountCents` yet to spend against would be a
control that does nothing for the customer who used it. The mechanism is
real and tested end to end in `packages/core`/`packages/db`; it has no
caller from a rendered form yet.

**Next unblocked item: C-117 — the tax base.** `Order.discountCents`,
snapshotted, and `priceOrder` computing tax on `subtotal − discount` rather
than `subtotal` — the change that makes a reward honest before tax instead
of after it. This is also very likely where the actual "redeem your reward"
checkout UI belongs: once there is a price effect to show, C-116's
`confirmCheckoutVerification`/`verifiedPhoneToken` plumbing has something
worth calling it for. Read `docs/prds/prd-loyalty.md`'s "P1-1's own
phasing" section fully before starting — it is last "deliberately, because
it is the one change that touches every receipt's arithmetic and deserves
to land with nothing else moving in the same diff."

**Model: C-117 touches money — the tax base every receipt reconciles
against — Opus, not Sonnet.**

## What C-116 leaves behind

- **Still no checkout control a customer can reach.** Same "plumbing, not
  wired" shape C-115 left, one layer further along — `requestCheckoutVerification`/
  `confirmCheckoutVerification` have no caller yet.
- **The verified-phone outcome is logged (`VerifiedPhoneLogOutcome`), never
  persisted.** No new column this session, deliberately — C-117 is what
  decides whether a placed order needs to remember `verified` beyond its
  own log line.
- **No e2e or `apps/web` unit coverage** — there is nothing to click yet,
  and `apps/web` has no unit suite. Every claim this session makes is
  proven in `packages/core` and `packages/db`.
- **`VERIFY_TOKEN_TTL_MINUTES` (10) is a guess**, not a measurement — long
  enough to get through the rest of the checkout form after verifying,
  short enough not to be a "remembered device." Revisit if the rush demo or
  real use says otherwise.

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
