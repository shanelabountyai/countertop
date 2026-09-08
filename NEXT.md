# Next

**C-080 shipped** (`48956d7`, SHA recorded in the follow-up, gate green: 208
passed + 14 skipped = 222; 929 unit). PRD 5
P0-4 is done: `MenuItem.description` is mapped through `loadMenu`
absent-not-null, rendered on `/menu` (inside the tap target) and in the
composer, editable in the menu editor as a straight save, and a sticky
category strip of plain in-page anchors jumps to each `<section>`.

**Next item: `C-081` — an untouched choice looks untouched** (PRD 5 P0-5 and
P0-6 together). Both are composer-local and both are the same class of defect
— the UI stating something the customer did not say. P0-5: no intensity pill
carries the selected style until one is deliberately tapped, and the untouched
state carries a visible hint. P0-6: a failed add-to-cart moves focus into the
first violating group's fieldset and the message names the group ("Choose a
protein"), not "the choices above" — with the composer's axe assertions still
passing.

Model: **Sonnet.** Two rendering rules and a focus move inside one client
component, both with named test bullets. Opus is warranted again at PRD 6's
C-088 (binding the placement replay to its session).

Also unbuilt in PRD 5 after C-081: **C-082** (a way back to your own order —
gated on a Product Open Question), **C-083** (cart quantity steppers). Then
**C-088, C-089, C-090, C-093** in PRD 6.

## What C-080 leaves behind

- **Twenty-two of twenty-five items have no description.** The mechanism
  ships; `SAMPLE_MENU` describes `burrito`, `bowl` and `taco-plate` only, and
  `chips` is deliberately undescribed — it is what the absent branch is
  asserted against.
- **The category strip does not say where you are.** No active-section
  styling, because that is the scroll listener the anchors-only approach
  avoided. Fine at five categories, not at twenty.
- **The strip wraps rather than scrolls sideways.** `flex-wrap` on a phone is
  two rows at five categories; twelve would be a tall sticky block.
  `overflow-x-auto` + `flex-nowrap` is the swap.
- **Descriptions are not searchable and nothing indexes them.**
- **The staff receipt and the kitchen ticket still say only the item name**,
  which is correct and deliberate — see the PROGRESS entry before "fixing" it.

## Rules C-080 established

- **A byte-identical invariant test proves the receipt does not JOIN; it
  cannot prove the receipt does not COPY.** A snapshotted `itemDescription`
  column would sail through all thirteen mutations. Stability under mutation
  cannot distinguish "never read" from "read once and frozen", so the second
  claim needs its own assertion. (`docs/WRITEUP.md`, C-080.)
- **A locator that encodes layout is a test coupled to a decision it was never
  making.** Nine specs asserted `{ name: /Burrito \$10\.95/ }` — name
  immediately followed by price — which was an accident of the row being
  empty. Now one `menuRow(page, name, price)` fixture, so the next thing added
  to that row breaks nothing.
- **"No migration needed" and "no column needed" are different claims.** The
  handoff said one nullable column; the PRD said none. Both half right: the
  column existed since `init`, and `TEXT` is not a width, so the first writer
  is the first thing that can put a paragraph in it. `VARCHAR(200)`, matching
  C-077's address.

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
  Three items have now touched the composer without the `(customer)` route
  group getting done. C-081 is entirely composer-local; if it grows another
  cross-screen element, do the route group then.
- **The status page reads the contact columns twice** — once for the panel's
  `tel:` link, once inside the footer.
- **The status page's estimate line is outside the `role="status"` region**
  (C-078). One attribute, but a second live region is a decision about which
  one wins when both change on the same poll.
- **The last-call warning does not tick** (C-079) — `force-dynamic` renders
  with no poll, so twelve minutes on the page still reads "in 12 min".
- **`setLastOrderIn` cannot express the last `minutesOut` minutes of the local
  day** (C-079); it throws rather than clamping.
- **`e2e/refund.spec.ts:211`** ("a no-show is offered a refund rather than
  given one") failed once at 8.0s in a C-108-era sweep and has passed in every
  sweep since, including C-080's. A timeout, not an assertion. Local `retries`
  is 0, CI's is 1. First place to look if a refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
