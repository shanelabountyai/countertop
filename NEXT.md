# Next

**C-122 shipped this session** (`e6daa5e`): the bulk 86 under two cooks. `setAvailability`
read the rows it was about to flip and then flipped them, so two overlapping
batches in the same second both claimed the same still-available row — and the
first undo put it back on the customer menu while the second cook's screen
still said sold out. **An item a customer can order and the kitchen does not
have is the founding failure of this product, and it was arriving through the
undo button.**

Fixed with `updateManyAndReturn` per grain: the `available: !available` guard
moves out of a preceding `SELECT` and into the `WHERE` of the `UPDATE`, which
Postgres re-evaluates against the row it just locked. The loser of the race
matches nothing, returns nothing, claims nothing. No migration, no lock, still
one transaction across both grains.

**Two things worth carrying forward, both in `docs/WRITEUP.md`'s C-122 entry:**
- **The `ponytail:` described its own defect backwards** — "an undo list that
  is short by the overlap", "nobody loses an 86". A probe printed the opposite
  before anything was changed: the lists come back LONG, and the lost 86 is
  the whole harm. The comment reasoned about the WRITE (both agree, so nothing
  is lost) and never about the RETURN VALUE, which is what the undo acts on.
  A comment that bounds a risk and gets the bound wrong is worse than none —
  it reads as a reason not to look, and this one went unchallenged for over a
  hundred items. **When a comment bounds a known risk, run it once before
  believing it.**
- **The C-119 lesson repeated.** The first undo test PASSED against the bug:
  it asserted "the row is back iff this cook claimed it", and under the bug
  BOTH cooks claimed it. Trying to make a concurrency test order-independent
  had made it bug-independent. Rewritten to assert the *other* cook's screen
  is still true. Two sessions running now: **revert the fix, run the new
  tests, require red before keeping them.**

## Next unblocked item: pick one — nothing is blocking

Same menu as last session, minus the one just taken. In rough order of what a
reader of this project would notice first:

1. **The rush no longer exercises a refund end to end.** Both its prepaid
   exits are voids, which is C-069 working correctly — but it means the
   refund machinery, `refund_failed`, and the exceptions list appear in no
   demo at all. ~six lines of rush script plus assertions. **Cheapest real
   gap.** Sonnet.
2. **The queue's 15-minute "running late" flag does not know about
   `requestedFor`** (C-114) — a scheduled order sitting untouched well before
   its slot still reddens. Touches `queueAging`; the "Pickup HH:MM" badge is
   the mitigation, not the fix.
3. **No `PhoneVerification` sweep** (C-115's `ponytail:`) — one row per
   verification request, forever, and C-120 made the rush issue two per run.
   The upgrade path is written on the model: a periodic delete past
   `expiresAt`, same shape as the retention sweep.
4. **`stagePrice` is the other read-modify-write in `menu.ts`** — a
   delete-then-create inside a transaction, scoped to the same
   `(target, effectiveDay)` the create writes. Not obviously wrong, and
   nothing asserts it under concurrency. **Worth thirty minutes of probing
   before deciding it is an item at all** — that is exactly what C-122 turned
   out to need.

**If you would rather clear the older debt**, the C-069/C-071 list at the
bottom of this file is still accurate.

## What C-122 leaves behind

- **Two cooks can still each get half of one selection**, and that is correct
  rather than a remaining gap: each report names what that cook actually
  flipped and each undo restores exactly that. Neither screen tells a cook
  that somebody else took the rest — `done=off` announces "Marked N sold out"
  with that cook's own N.
- **`stagePrice` is untouched.** Item 4 above.
- **No test drives the race through the SCREEN.** `setBulkAvailable` passes
  the return straight into the redirect, so the action is correct by
  construction; two browsers submitting in the same second is not something
  Playwright expresses cheaply.

## Still open from C-118 → C-121

- **`NotificationKind` has one value** (C-121). It exists because it is half
  the unique index's grain, not because anything writes a second. A second
  kind — a delay apology, a closing-soon nudge — is a product decision nobody
  has made.
- **Nothing reads `queueReadyNotification`'s return value** (C-121). "We told
  them" and "we had already told them" are different facts; the boolean is
  returned rather than discarded so the seam exists the day a caller wants it.
- **Still no append-only trigger on `NotificationOutbox`** (the model's own
  `ponytail:`) — and C-121's migration dedupe is exactly the kind of `DELETE`
  such a trigger would block. Worth remembering when one is added.
- **Nothing in the rush redeems at the COUNTER.** Both its redemptions are
  self-serve, so `redeemReward` and the staff receipt's reward button are
  demonstrated only by the e2e suite.
- **No member in the rush has a balance that expires.**
  `expireInactiveBalances` has unit tests and no demo.
- **Five portfolio captures are content-stale and were deliberately not
  regenerated** — `05-kitchen-queue`, `06-kitchen-card`,
  `10-kitchen-viewport`, `07-report-midservice`, `11-report-after`.
  Regenerating in a container re-renders every font, verifiably:
  `12-staff-login.png`, a static page that cannot have changed, comes back
  9007 → 7764 bytes. Run `SCREENSHOTS=1 PORT=3400 npm run test:e2e --
  screenshots.spec.ts` on the machine that produced their siblings.
  `15-loyalty.png` is committed and should be regenerated with the rest.
- **A customer who abandons a checkout and comes back verifies again.**
  C-116's binding working as designed; also a second SMS per order on a real
  carrier.
- **`Order.discountCents` has exactly one producer.** If a second appears,
  `settleRedemptionForOrder` assumes the discount and the `redeem` row are the
  same fact.
- **No deadlock is constructible on the member lock — an argument, not a
  test.**
- **`reward_terms_changed` has no test.** Reaching it needs the reward's cash
  value edited mid-placement and C-106 ships no control for that value.
- **Nothing bounds a staff `adjust` below zero.** Screen-level, pre-existing.
- **The sleeps in the member-lock test are 250ms.** If it flakes, raise them;
  do not delete the test.

## Environment notes for whoever runs the gate next

**Ten e2e specs fail in a fresh container and it is not the code.**
`contact`, `last-call` ×2, `menu-editing` ×2, `menu` ×3 and `refund` ×2 die
with `Error: request for './menu/index' is from a module not been linked` —
an ESM loader failure in the fixtures that use a late
`await import('@countertop/db')`. Verified pre-existing at C-118 by stashing
that whole change and running the same ten on `f239791`, where they fail
identically; unchanged since. Everything else is green: **218 passed + 15
skipped + 10 failed = 243, which is what `--list` reports.**

**`npm run ci:local` needs password-less local TCP auth**, which a dev machine
has and a fresh container does not — it builds its URL as
`postgresql://$(whoami)@localhost/...` with no password. In a container, set
`host … 127.0.0.1/32 trust` in `pg_hba.conf` and reload. Not a repo change;
the script is right for the machine it was written for. **It is worth running
for a migration session** — it is the only thing that applies the whole
migration history from nothing, asserts the five named invariants, and runs
the drift check.

**Also container-only:** Playwright wants browser build 1234 and the image
ships 1194. Symlinking `/opt/pw-browsers/chromium_headless_shell-1234/…` at
the expected path is what lets the e2e leg run.

## Still open from earlier items

- **No per-batch menu-change event** — PRD 4's builder Open Question, still the
  only thing open in that document.
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
- **Same-day only** for order-ahead (C-114) — multi-day is the master
  PRD's own catering/lead-time P2 item.
- **A fully-booked day degrades silently to ASAP-only** (C-114) — no
  "nothing left today" copy.
- **No fixture pinned to an actual DST-transition date** (C-114) for
  `zonedTimeToInstant` — a `ponytail:` comment on the function names the gap.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
