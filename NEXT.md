# Next

**`prd-menu-under-pressure.md` P0-2 — the availability board can be searched,
shipping as `C-108`.** The same GET search box the queue already has, on the
page that is longer than the queue and used under more pressure. It must match
**option** names as well as item names — "guac" has to find the option, because
the option is the thing being 86'd. Read PRD 4's P0-2 block and copy the
queue's existing search rather than writing a second one.

Model: **Sonnet.** Another read-side item over `loadMenu()` — a query param, a
filter, no write path, no migration. Move to Opus only if the queue's search
turns out not to be liftable and the two screens would end up with different
matching rules.

## What C-107 leaves behind

- **`itemsUsingGroup` now lives in `packages/core/menu/reach.ts`** and both the
  calm menu editor (`/kitchen/menu`) and the 86 board read it. If P0-2's filter
  needs "which items carry this group", ask that function — do not add a third
  filter over `menu.items`.
- **The used-on line truncates at four names**, and four is fixed by the
  acceptance criterion that an option on four items shows all four. Changing
  `MAX_NAMED_ITEMS` in `apps/web/app/kitchen/availability/page.tsx` breaks the
  e2e that asserts the Guacamole row in full.
- **The line reports menu structure, not live carts.** "This stops four items"
  is true; "and two people are holding one" is a query the board does not make
  and P0-2 does not add either.
- **Item rows deliberately carry no used-on line.** If P0-2's filtering makes
  it tempting to unify item and option rows, that asymmetry is on purpose.

## The numbering trap, already sprung once

**PRD 4's phasing block claimed `C-071`–`C-076`, and `C-071` was already PRD 3's
refund item.** It has been renumbered to `C-107`–`C-112` in the PRD itself, and
`docs/backlog.md` now has a PRD 4 section. The register continues from `C-106`.
Check the next PRD's phasing block against `grep '^## C-' docs/PROGRESS.md`
before starting its first item — PRD 4 was not the only document drafted while
an earlier PRD was still consuming numbers.

## One flake, recorded rather than fixed

`e2e/refund.spec.ts:211` ("a no-show is offered a refund rather than given
one") failed once in a full sweep at 8.0s, and passed at 1.3–2.1s alone, as a
file, and in the three sweeps since. A timeout, not an assertion, and nothing
in C-107 touches refunds. Local `retries` is 0 and CI's is 1, so CI retries
past it silently. First place to look if a refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (marked `ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
