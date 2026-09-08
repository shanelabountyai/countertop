# Next

**PRD 4 is closed.** C-112 shipped stations as the attribute and wrote down the
decision against the per-station arithmetic; the only thing still open in
`docs/prds/prd-menu-under-pressure.md` is its **(Builder)** question about a
per-batch menu-change event, which no item in P0 or P1 needed.

**Next item: `C-077` — the restaurant has an address and a phone**
(`docs/prds/prd-the-customer-who-is-not-in-the-room.md` P0-1). PRD 5 is ranked
5 in `docs/prds/INDEX.md` and is entirely unbuilt — C-077 through C-083. Three
nullable columns on the settings singleton, a footer on five routes, and a
`tel:` link on the two views whose copy already tells the customer to call.
The product currently says "call the restaurant" and gives them no number.

Model: **Sonnet.** Three nullable columns, a component and a link — no money
path, no clock arithmetic, no snapshot. Opus is only warranted again when PRD
6's C-088 (binding the placement replay to its session) comes up.

Also unbuilt after PRD 5: **C-088, C-089, C-090, C-093** in PRD 6.

## What C-112 leaves behind

- **`MenuItem.station` is nullable and NULL means no kitchen work.** Four items
  (`mexican-coke`, `bottled-water`, `tres-leches`, `paleta`) are `prepWeight: 0`
  and have none. `sample-menu.test.ts` asserts that pairing in both directions;
  add an item with weight and no station and it fails there.
- **`seedable(rows)` in `availability/page.tsx` is the ONE rule** for what a
  "Select these N" link adds: on screen, and not already picked. Both the
  station row and the category link call it. A third grain calls it too.
- **`STATIONS` / `STATION_LABELS` live in `packages/core/menu/types.ts`**, and
  `['Station', STATIONS]` is in the vocabulary test in
  `packages/db/snapshot.test.ts` — the Postgres enum and the engine's list are
  pinned position for position. Adding a station means: the enum, `STATIONS`,
  `STATION_LABELS` (a type error if forgotten), and a migration.
- **The migration `20260908120000_item_station` backfills by seeded slug id**
  and is a verified no-op on any database that does not use them. Copy that
  shape for any column that wants to reach the deployed menu without a reseed.

## Rules C-112 established

- **A station is an attribute, not a third availability fact.** C-110 settled
  schedule-vs-86 and C-111 staged-vs-typed, both with the human winning. A
  station says nothing about whether food can be ordered. If "this station is
  down" ever becomes stored, it is a FOURTH column beside `available`, never
  inside it and never inside `station`.
- **The estimate and the auto-pause threshold read ONE open weight**, and that
  is now a decision with three reasons behind it, not an omission. Do not
  "improve" it into a per-station maximum without first shipping all three of:
  a station and a weight on `OrderLine`, a staffing input, and a many-to-many
  for the items that touch two stations.
- **A requirement whose falsity is invisible to the suite is the one to check
  against the data model first.** Every existing test supplies `openWeight`
  directly, so the busiest-station swap would have gone green.

## Ceilings recorded rather than fixed (C-112)

- **One station per item, and it is already wrong once.** A California burrito
  is fryer work and flat-top work; it is on `grill`.
- **No CHECK for "work has a station".** Fixture-level only, because the
  constraint would have made a data backfill load-bearing for a rule that only
  catches an authoring mistake, in a repo where items are authored only in
  `SAMPLE_MENU` (C-015). It comes with the estimate work if that ever happens.
- **No station editor**, same as `prepWeight` and for the same reason.
- **Stations are not searched.** Five links already on screen; a search box
  that also matched "fryer" would be a second way to do a one-tap thing.

## Still open from C-109 / C-110 / C-111

- **No per-batch menu-change event** — PRD 4's builder Open Question, still
  unanswerable: nothing in the bulk path, the single toggles, a daypart, a
  staged price or a station writes a menu-change event at all.
- **`setAvailability` is read-then-write** (`ponytail:` comment), last-write-wins.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out."
- **No daypart editor**, and no overnight daypart window.
- **A staged change lands at local midnight and nowhere else**; no schedule
  view; the "extra" surcharge cannot be staged; superseded staged rows are
  never collected.

## One flake, still recorded rather than fixed

`e2e/refund.spec.ts:211` ("a no-show is offered a refund rather than given
one") failed once in a full sweep at 8.0s and has passed in every sweep since,
including C-109's through C-112's. A timeout, not an assertion. Local `retries`
is 0 and CI's is 1, so CI retries past it silently. First place to look if a
refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (`ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
