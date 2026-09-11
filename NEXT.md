# Next

**C-115 shipped this session** (`af1c122`, SHA recorded in this same commit):
PRD 7 P1-1, session 1 of 3 — the phone-verification mechanism. Closes the
gap C-113's entry named: self-serve redemption at checkout needs proof a
customer controls the phone number they typed, and C-113's SMS is a
one-way stub with no reply channel and no code to confirm against.
`PhoneVerification` (hand-written migration), `packages/core/loyalty/
verification.ts`'s pure decision functions, `packages/db/verification.ts`'s
`startPhoneVerification`/`confirmPhoneVerification` and the
`SmsVerifyProvider` seam. The design decision — the stub echoes the code to
the requester via the seam's return type, never behind an env flag — is
recorded in `docs/prds/prd-loyalty.md`'s new "P1-1's own phasing" section.
Gate green: 985 unit (+28 over C-114's 957), 221 e2e passed + 14 skipped =
235 (unchanged — no UI shipped this session), lint/typecheck/build clean.

**Inert on purpose.** No customer or counter surface changed. `loyaltyEnabled`
and the existing staff-attended P0-4 redemption are untouched.

**Next unblocked item: C-116 — checkout wiring for P1-1.** Request a code,
confirm it, and design the bearer-token shape that carries "this phone was
verified" from confirmation through to placement with no session or cookie
— same idempotency-key discipline `newStatusToken` already applies
elsewhere in this codebase. After that, **C-117 — the tax base**:
`Order.discountCents`, snapshotted, and `priceOrder` computing tax on
`subtotal − discount`. P1-1 is not live (no customer-visible control exists)
until both land.

**Model:** C-116 is routine build once C-115's plumbing exists — Sonnet.
C-117 touches money (the tax base every receipt reconciles against) and
should get the same Opus treatment this session's design pass did.

## What C-115 leaves behind

- **No sweep ever deletes an old `PhoneVerification` row.** `ponytail:`
  comment on the model names the upgrade path (a periodic delete past
  `expiresAt`, same shape as the retention sweep) and the ceiling (fine
  until a shop sees far more than a few dozen redemption attempts a day).
- **A column-default clock-skew defect, caught and fixed this session, not
  left behind** — but worth re-reading before writing another table with a
  hand-written CHECK spanning two timestamp columns: `docs/WRITEUP.md`'s
  "A column default that was its own clock-skew bug" entry has the general
  shape (`DEFAULT now()` is only dangerous the moment something compares
  that column against a value from a different clock).

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

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
