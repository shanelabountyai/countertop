# Next

**C-081 shipped** (`aceeeab`, SHA recorded in the follow-up, gate green:
210 passed + 14 skipped = 224 e2e, 929 unit). PRD 5 P0-5 and P0-6 are done:
an untouched intensity row shows no filled pill (Skip included) and a visible
"No choice made yet" hint; a failed add-to-cart moves focus to the first
violating group's fieldset, `aria-describedby` announces its own error text
to assistive technology, and the bottom summary names the group in its own
sentence rather than repeating the fieldset's or saying "the choices above".

**Next item is gated.** PRD 5's remaining P0 item is **C-082 — a way back to
your own order** (P1-1), but its own Open Question is unresolved: it
deliberately revisits the recorded decision that losing the status link
means walking to the counter, and the PRD says recorded decisions are not
re-opened silently. **Ask before building it**: is that decision re-opened,
or does it stand until P1-3's SMS ships?

**If the answer is "leave it, build the next unblocked thing" — that's
`C-083` — ordering for six** (PRD 5 P1-2): `−`/`+` steppers on each cart
line so 1 → 2 is a tap rather than a full composer round-trip, plus
"View cart (6)" in the menu header. Recomputes server-side through the
existing cart path exactly as a composer save does — no new price logic.

Model: **Sonnet** either way — C-082 is a cookie write plus one menu strip
with no lookup surface; C-083 is a stepper wired to the existing
`addToCart`/`updateCartLine` actions. Opus is warranted again at PRD 6's
C-088 (binding the placement replay to its session).

## What C-081 leaves behind

- **The focus ring on the programmatically focused fieldset uses `:focus`,
  not `:focus-visible`** — a `.focus()` call right after a mouse click on
  the submit button doesn't reliably trigger `:focus-visible` in Chromium, so
  the ring is unconditional. Minor visual redundancy for a keyboard user who
  tabs there by hand, not a defect.
- **Only intensity-enabled groups got touched-tracking.** A plain
  checkbox/radio option's unchecked state IS its neutral native look — there
  is no "Skip" pseudo-option colliding with untouched there.
- **Two defects were caught by the sweep before they reached a commit, not
  by review**, both from reusing text/state without checking what already
  reads it: Skip's native `checked` was `null === null`-true on every
  untouched row (an accessibility bug hiding under a styling one), and the
  first draft of the P0-6 summary repeated the fieldset's own message
  verbatim, which put duplicate text on the page and broke an unrelated
  spec's exact-text locator via a Playwright strict-mode violation. Full
  account in `docs/WRITEUP.md`, C-081 — worth reading before touching this
  composer again, since both traps are "the value already exists nearby,
  reach for the SAME one" mistakes that recur under different names.

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
  C-081 touched only the composer's insides, not its wrapper, so this is
  still open. If C-083 grows another cross-screen element, do the
  `(customer)` route group then.
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

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
