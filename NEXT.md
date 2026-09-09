# Next

**Debt fix shipped this session** (`fix: a stepper tap on a flagged line
says why the quantity didn't move`): the stepper's discarded `ActionResult`
(C-083 debt) — `stepCartLineForm` now redirects with `?stepError=lineId:msg`
when `updateCartLine` fails (e.g. an option 86'd out from under a flagged
line), and the cart page renders it on that line as "Quantity not changed:
…". Gate green (215 passed + 14 e2e skipped = 229, up by the one new spec;
929 unit).

**Next unblocked item:** none picked yet. Same options as before (see
"Still open" below for the rest of the debt list) — the header cart-count
bug (C-083) is the next same-shape one-line-fix if continuing the debt
sweep, otherwise P1-3/P1-4 need a product decision first.

---

**C-082 shipped** (`8db3b8b`, SHA recorded in `d3dba8f`, gate green: 214
passed + 14 skipped = 228 e2e, matches `--list`; 929 unit). The Open Question
gating it was asked and answered this session: re-open the recorded decision
now rather than wait on P1-3's unbuilt SMS. `/menu` now shows "Your order
#005 is cooking — track it" for any remembered order that is not terminal,
sourced from a second httpOnly cookie (`lib/recent-orders.ts`) written on
successful placement. No lookup surface added — same unguessable token,
same idiom as the cart cookie.

**PRD 5 is now fully done** — every P0 and both P1 items with no open gate
(P1-1 and P1-2) are shipped. What's left in that PRD is P1-3 (Photos) and
P1-4 (stop collecting the phone number, or use it) — both bigger, unscoped
items, not "next session" sized on their own.

**Next unblocked item:** none picked yet. Options, roughly ascending cost:
- **P1-4 (phone number)** — decide whether it's in scope to *use* the number
  (send the SMS P1-3 was a placeholder for) or *stop collecting* it. Mostly a
  product decision before any code.
- **P1-3 (Photos)** — M-sized per the PRD (migration + asset story), and the
  master PRD's Open Question on scope ("are photos in scope for a learning
  build") is unresolved — ask before starting.
- Pick up debt instead (see below) — several are one-line-to-small fixes with
  no gating question.

**Model:** whichever comes next, recommend at that item's start per the
usual rule — Opus for anything touching the payment/session work in PRD 6,
Sonnet for routine UI/data-model build like everything in PRD 5 has been.

## What C-082 leaves behind

- **A shared browser sees every order placed from it**, up to 5, until each
  finishes — there is no per-customer identity to separate them. Same
  limitation the cart cookie already accepts; not new here.
- **No log line for "customer used the strip."** Same shape as the
  no-per-batch-menu-change-event gap below — nobody currently writes an event
  for "a customer looked at X," and this doesn't start.

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
- **The header cart count includes 86'd and unpriced lines** (C-083).
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since. A timeout, not an assertion. Local `retries` is 0, CI's is 1.
  First place to look if a refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
