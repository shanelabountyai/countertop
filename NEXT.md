# Next

**`docs/prds/prd-menu-under-pressure.md` P1-3 — stations, shipping as `C-112`,
or the written decision not to.** A station attribute on each item,
`openWeight` summed per station, and the estimate reading the busiest one, so
sixteen points of fryer work stops looking like sixteen points spread across
three stations. It is the last item in PRD 4, it is an L with a migration, and
the PRD explicitly allows "or the written decision not to" — decide that first,
in one line, before building anything.

Model: **Opus.** It touches the estimate and the auto-pause threshold, which
are the two numbers a customer and the door both depend on. If the answer turns
out to be "not building it", Sonnet is enough to write the decision down.

## What C-111 leaves behind, that P1-3 will want

- **`loadMenu(now)` resolves staged prices and reads the restaurant's
  timezone.** It is no longer a pure mapping — it calls `loadClock` — so a
  caller with an instant in hand must pass it. `placeOrder`, `rush.ts` and
  `seed.ts` were all changed to do that; a new caller that forgets gets
  `new Date()` and prices a backdated order on today's menu.
- **`effectivePrices(now)` returns `{ today, items, options }`** — the day
  comes back with the prices deliberately, because the two callers that want
  one want the other, and two clock readings is how they disagree. If a station
  ever needs a per-day fact, copy that shape.
- **`writePrice(target, cents, effectiveDay | null, today)` in
  `packages/db/menu.ts`** is where the staged-versus-typed precedence lives,
  two functions below the resolution rule it is the inverse of. Any new writer
  of a menu price goes through it, not around it.
- **The migration to copy is `20260908090000_staged_price`**: one table with
  two nullable FKs and a `("itemId" IS NULL) <> ("optionId" IS NULL)` CHECK,
  tested in `constraints.test.ts` (`describe('staged prices')`, ten cases).
  A station on `MenuItem` is a simpler shape than that — a column, not a child
  table — because an item has one station.
- **`formatDayLabel` and `nextDay` in `packages/core/orders/business-day.ts`**
  are calendar arithmetic on calendar values, built with `Date.UTC` and read
  back in UTC. If anything else needs a day label, they are it; do not write a
  second one.

## Rules C-111 established that P1-3 must not break

- **A schedule and a human fact are different columns** — now settled twice,
  at C-110 (daypart vs 86) and at C-111 (staged price vs typed price), with
  the human winning both times. A station is neither; it is an attribute. If
  P1-3 ever grows "this station is down", that is a THIRD fact and it belongs
  beside `available`, not inside it.
- **The price authority never learns about a schedule.** `priceLine` is
  unchanged and all three call sites got staged prices for free, because the
  resolution happens in the one mapping. A station's weight must reach
  `openWeight` the same way — through the thing that already computes it, not
  through a fourth reader.
- **`loadMenu` is the one mapping and `menu.test.ts` round-trips
  `SAMPLE_MENU` exactly.** A `stationId` added to the schema and forgotten in
  the mapping fails there, not in an estimate.

## Ceilings recorded rather than fixed (C-111)

- **A staged change lands at local midnight and nowhere else.** The upgrade is
  an instant column plus a wall-clock → instant converter with a DST policy,
  and it is the same converter a "starts at 4pm" daypart editor would need.
  One job, two features.
- **No schedule view.** Queued changes render on the row they will hit and
  nowhere else. `loadStagedPrices()` already returns the future rows ordered by
  day, so what is missing is a page, not a mechanism.
- **The "extra" surcharge cannot be staged.** The only price on the editor that
  can be blank; a nullable staged value would need its own column, CHECK and
  resolution rule for the least-used price on the menu. The row has no date
  field at all rather than one that silently does nothing.
- **Superseded staged rows are never collected.** They survive until a live
  edit on the same row deletes them. Indexed and filtered in SQL, so reads stay
  cheap; the sweep belongs beside the C-091 retention job if it is ever worth
  writing.
- **`loadMenu` now throws without a settings row**, where before it returned a
  menu. Deliberate, and there is a test that says so.

## Still open from C-109 / C-110

- **No per-batch menu-change event.** PRD 4's builder Open Question is still
  unanswerable: neither the bulk path, nor the single toggles, nor a daypart,
  nor a staged price writes a menu-change event at all.
- **`setAvailability` is read-then-write** (`ponytail:` comment on it),
  last-write-wins.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out."
- **No daypart editor**, and no overnight daypart window. Both C-110's, both
  unchanged. The staging UI built here is the natural place a daypart editor
  would live — both are "a menu change with a time on it" — and it now has a
  working native date input to copy.
- **Category names are still not searched.** Do not add it out of obligation.

## One flake, still recorded rather than fixed

`e2e/refund.spec.ts:211` ("a no-show is offered a refund rather than given
one") failed once in a full sweep at 8.0s and has passed in every sweep since,
including C-109's, C-110's and C-111's. A timeout, not an assertion. Local
`retries` is 0 and CI's is 1, so CI retries past it silently. First place to
look if a refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (marked `ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
