# Next

**C-120 shipped this session**: the punch card in the rush. The capstone demo
now shows the feature the last five sessions built — five of the thirty
customers are regulars, two spend a reward at checkout, and one of those two
is the guacamole cancellation, so C-119's settlement handing the points back
is on screen rather than only in a unit test.

**The rush's five ugly cases were not touched.** That list is the master PRD's
Success Metrics verbatim; a sixth case would have been editing acceptance
criteria to match the code. Seeding state alongside it was the owner's call
and the smaller change — and the rush already varies orders along axes the
Success Metrics never mention (`paidNow`, `slow`, which cook taps the card),
so "this customer has a punch card" is another such axis.

**The rush earned its keep on the first run**, which is the thing worth
reading `docs/WRITEUP.md`'s C-120 entry for. Two finds, both from looking at
what the system actually did rather than from anything the suite was asked to
check — see the next item, and the loyalty-screen copy that had quietly gone
stale two sessions ago and is now fixed.

## Next unblocked item: a reverted ticket is texted twice

**A real defect, found by C-120, deliberately not fixed by it.**

`queueReadyNotification` (P1-3, C-113) writes an outbox row on every
transition *into* `ready`, with nothing stopping a second one. Rae Sutton's
ticket is the rush's wrong-advance case — ready at minute 12, reverted at 13,
ready again at 16 — so she is queued the identical `#010 is ready for pickup`
**twice**, four minutes apart, for one bag of food.

- **Latent, not live.** Nothing sends these; the outbox is a stub log and the
  master PRD still parks real SMS on its P2 list. So this is a correctness
  problem, not an incident.
- **Invisible until C-120.** The function is gated on `customerPhone` and no
  rush order carried one before this session.
- **Already written down as a test that passes:** `TEXTS THE REVERTED TICKET
  TWICE — a defect this rush found, not a rule` in `rush.test.ts`, asserting
  `toHaveLength(2)` and a total of 5 with the reason in its own name. Fixing
  the defect makes it fail, which is the point — **edit that test as part of
  the fix, do not delete it.**

**The decision it needs before code.** The fix is a constraint, so a
hand-written migration (CLAUDE.md's rule), and the grain is the real question:
- a unique index on `NotificationOutbox(orderId)` — one notification per order
  **forever**, which is right for "ready" and closes the door on a second KIND
  of notification later (a delay apology, a "we're closing" nudge); or
- a partial unique index on `(orderId)` scoped to the ready message's kind,
  which needs a `kind` column the table does not have — a wider change, and
  the one that leaves room; or
- dedupe on the un-sent window only, so a genuine second service on one order
  (a remake?) can still notify.

**Ask the owner which.** The first is cheapest and is a door being closed; the
second is the shape this table probably wants eventually.

**Model: Opus.** It is a migration with a constraint whose grain is a product
decision, on the one table that will grow a second use.

## What C-120 leaves behind

- **The double "ready" notification.** The item above.
- **Nothing in the rush redeems at the COUNTER.** Both redemptions are
  self-serve, so `redeemReward` and the staff receipt's reward button are
  still demonstrated only by the e2e suite, not by the demo.
- **No member in the rush has a balance that expires.**
  `expireInactiveBalances` has unit tests and no demo; showing it needs a
  regular backdated past 365 days, which is a different fixture shape.
- **The rush still never exercises a refund end to end** — both its prepaid
  exits are voids, which is C-069 working. ~six lines, and it pairs naturally
  with any future rush work.
- **`15-loyalty.png` is the only screenshot of a screen with seeded loyalty on
  it.** The customer-facing reward control at checkout has no capture, because
  the screenshot block that seeds a rush is staff-side.
- **Five existing captures are now content-stale and were NOT regenerated.**
  `05-kitchen-queue`, `06-kitchen-card`, `10-kitchen-viewport` (mid-rush cards,
  one of which is now a $4.06 discounted ticket) and `07-report-midservice`,
  `11-report-after` (the report's new Rewards column). They were left alone
  on purpose: regenerating them **in a container re-renders every font**, and
  it is verifiable — `12-staff-login.png`, a static page that cannot have
  changed, comes back 9007 → 7764 bytes on a regeneration here. Committing
  that would have been fourteen binary diffs of which nine were pure noise.
  **Regenerate the whole set on the machine that produced their siblings:**
  `SCREENSHOTS=1 PORT=3400 npm run test:e2e -- screenshots.spec.ts`.
  `15-loyalty.png` IS committed — it is new, has no prior version to be
  inconsistent with, and the alternative was a documented screen with no
  capture — but it is this container's rendering and should be regenerated
  with the rest.

## Still open from C-118 / C-119

- **No `PhoneVerification` sweep** (C-115's `ponytail:`) — and C-120 makes that
  table busier still: every rush run now issues two codes.
- **A customer who abandons a checkout and comes back verifies again.** The
  new attempt gets a new `idempotencyKey`, so the old token is bound to an
  attempt that no longer exists. C-116's binding working as designed, and also
  a second SMS per order on a real carrier.
- **`Order.discountCents` has exactly one producer.** If a second appears (a
  promo code, a manager's pre-tax comp), `settleRedemptionForOrder` assumes
  the discount and the `redeem` row are the same fact.
- **No deadlock is constructible on the member lock — but that is an argument,
  not a test.** One row, taken once, at the top of both transactions.
- **`reward_terms_changed` has no test.** Reaching it needs the reward's cash
  value edited mid-placement and C-106 ships no control for that value.
- **Nothing bounds a staff `adjust` below zero.** Screen-level, pre-existing.
- **The sleeps in the lock test are 250ms.** If it ever flakes, raise them;
  do not delete the test.

## Environment note for whoever runs the gate next

**Ten e2e specs fail in a fresh container and it is not the code.**
`contact`, `last-call` ×2, `menu-editing` ×2, `menu` ×3 and `refund` ×2 die
with `Error: request for './menu/index' is from a module not been linked` —
an ESM loader failure in the fixtures that use a late
`await import('@countertop/db')`. Verified pre-existing at C-118 by stashing
that whole change and running the same ten on `f239791`, where they fail
identically; unchanged since. Everything else is green: **218 passed + 15
skipped + 10 failed = 243, which is what `--list` reports.** (The fifteenth
skip is C-120's new screenshot test; screenshots are `SCREENSHOTS=1` only.)

**Also container-only:** Playwright wants browser build 1234 and the image
ships 1194. Symlinking `/opt/pw-browsers/chromium_headless_shell-1234/…` at
the expected path is what lets the e2e leg run; not a repo change.

## Still open from earlier items

- **No per-batch menu-change event** — PRD 4's builder Open Question, still the
  only thing open in that document.
- **`setAvailability` is read-then-write** (`ponytail:` comment),
  last-write-wins. **C-119's member lock is the cheapest precedent in the repo
  for fixing exactly this shape.**
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
- The rush no longer exercises a refund end to end — ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
