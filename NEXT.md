# Next

**`docs/prds/prd-menu-under-pressure.md` P1-2 — a price you can stage, shipping
as `C-111`.** An effective-dated price change: staged with a start instant and
applied by the clock, rather than by a manager typing during lunch. A child
table (not a nullable column pair, so more than one change can queue), and it
must route INTO the existing old → new confirm from C-015/C-026, not around it.

Model: **Opus.** A hand-written migration, money, and a change that lands in
`priceLine`'s path — the server-is-the-price-authority invariant is the one
this could break quietly. Correctness-critical.

## What C-110 leaves behind, that P1-2 will want

- **`loadClock()` in `packages/db/menu.ts` is the one place the menu request
  path reads a clock**, and `RestaurantClock` is now threaded through
  `validateComposition`, `addLine`, `replaceLine`, `reviewCart` and
  `confirmPrices`. A staged price is resolved at the same two moments the
  daypart is, off the same reading. **P1-2 needs an INSTANT, not a wall-clock
  reading** — "effective Monday 00:00" is a `timestamptz` comparison, not a
  `minuteOfDay` one — so it probably takes `now` rather than the clock. Do not
  reach for `restaurantClock` unless the price actually buckets by local day.
- **`daypartClosure` returns `{ label, message }` — two renderings of one
  answer.** If a staged price needs both a short badge on the editor and a
  sentence in the confirm panel, copy that shape rather than growing a second
  function.
- **The migration to copy is `20260907090000_item_dayparts`**: a child table
  with CHECK constraints written by hand, tested in `constraints.test.ts`
  (`describe('item daypart windows')`, eight cases including the cascade).
- **`loadMenu` maps `windows` absent-not-empty**, the same
  `exactOptionalPropertyTypes` care `extraPriceDeltaCents` needs. The
  `SAMPLE_MENU` round-trip in `menu.test.ts` is what enforces it — a staged
  price mapped as `null` instead of absent fails there, not in a receipt.

## Rules C-110 established that P1-2 must not break

- **A schedule and a human fact are different columns.** C-110 resolved that
  for dayparts vs 86s. P1-2 has the same shape one level down: a STAGED price
  and the LIVE price are two facts, and the staged one must not overwrite the
  live one until its instant passes. A single column with a "pending" flag is
  the same tempting collapse.
- **Precedence must be explicit and tested.** `validateComposition` reports the
  86 OR the daypart, never both, and there are three tests saying so. If a
  staged price and a manual edit can both be true at once, decide which wins
  and test it, in the same session.
- **Never seed a time-dependent fixture.** No item carries a daypart in the
  seed, deliberately (`docs/WRITEUP.md`, and `seedSettings`' own comment). A
  price staged for a fixed date will rot; stage it relative to the
  restaurant's clock in a fixture, the way `setDaypart` in
  `apps/web/e2e/fixtures.ts` does.

## Ceilings recorded rather than fixed (C-110)

- **No daypart editor.** SQL or the test fixture only. It is a form over four
  integers plus the confirm-on-save diff that already exists — and it is the
  first thing to build if this ever ran anywhere. P1-2's staging UI is the
  natural place to add it, since both are "a menu change with a time on it".
- **No overnight window** (`menu_item_window_ends_after_start`), same line
  C-011 drew for opening hours. A 22:00–02:00 item is two rows on two days.
  Fixing it once — "does any window contain now" over a midnight-spanning set —
  would fix both.
- **The composer's clock is a server-render snapshot**, like the prices beside
  it. Re-checked at cart-add and at placement.
- **Dayparts are item-grain only.** An option cannot carry one; the shared-
  option problem C-012 recorded is why.

## Still open from C-109

- **No per-batch menu-change event.** PRD 4's builder Open Question is still
  unanswerable, because neither the bulk path nor the single toggles write a
  menu-change event at all. C-110 did not change that — a daypart writes no
  event either.
- **`setAvailability` is read-then-write** (`ponytail:` comment on it),
  last-write-wins.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out." It reports the URL, not an action.
- **Category names are still not searched**, and C-108's reason for deferring
  expired at C-109. Do not add it out of obligation.

## One flake, still recorded rather than fixed

`e2e/refund.spec.ts:211` ("a no-show is offered a refund rather than given
one") failed once in a full sweep at 8.0s and has passed in every sweep since,
including C-109's and C-110's. A timeout, not an assertion. Local `retries` is
0 and CI's is 1, so CI retries past it silently. First place to look if a
refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (marked `ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
