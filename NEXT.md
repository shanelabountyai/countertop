# Next

**`docs/prds/prd-menu-under-pressure.md` P1-1 — an item that knows what time it
is, shipping as `C-110`.** The 4pm lunch-to-dinner changeover, which the PRD
calls the most common menu operation in fast casual and which is currently a
manager 86'ing eleven items and un-86'ing nine from a phone during the
changeover. A daypart child table, and a **third input to `validateComposition`
— not a fourth call site**.

Model: **Opus.** A hand-written migration with a CHECK constraint, a change to
the ONE orderability function every surface routes through, and the TZ×2 CI run
is exactly what would hide a bug here. Correctness-critical.

## The Open Question you have to answer before writing code

**Do dayparts and 86s share a column, or stay separate?** The PRD lists it as
open, but its own P1-1 text has already argued the answer: *"the two must never
collapse into one boolean, because the WRITEUP's C-012 decision that 86s never
restore themselves overnight depends on an 86 being a human fact."* Sharing is
one boolean and is genuinely tempting — an item is orderable or it is not.
Write the decision down rather than inheriting it silently, and note the
consequence either way: a shared column means 4pm un-86's something a cook
deliberately killed at 12:40pm.

**Second, smaller one, and the PRD names it too:** when a daypart closes on an
item sitting in an open cart, is that the 86 path (flag at checkout, fix or
remove) or something gentler? The 86 path is honest and already built, and it
is also a customer being told at 16:01 that the thing they added at 15:58 is
gone. Cheapest defensible answer is the existing path; say so out loud.

## What C-109 leaves behind

- **The PRD's category-vs-station question is RESOLVED and must not be
  re-opened**: the grain is an arbitrary selection. The evidence is in the menu
  — the fryer's output spans Sides, Plates and Sweets and none of those
  categories is wholly fried. **C-112 (stations) is untouched and still worth
  building**: a station would *seed* a selection, and the seeding mechanism now
  exists. Nothing has to be unbuilt for it.
- **`packages/core/menu/reach.ts` now has three callers of `itemsWithGroup`**
  (`itemsUsingGroup`, `searchMenu`, `selectionReach`). It is still the one
  place `menu.items` is filtered by group membership. Keep it that way.
- **`setAvailability` in `packages/db/menu.ts` returns the rows it FLIPPED**,
  not the rows it was handed. Anything that wants an honest undo over a batch
  should copy that shape rather than the selection.
- **The 86 board's selection lives in the URL beside `q`**, and every link on
  the page is rebuilt from the URL. If a daypart ever puts a third piece of
  state on that screen, it goes in the URL too — the board's whole robustness
  story is that it is a GET that works unhydrated.
- **`placement.test.ts`'s option-86 refusal is an `it.each` over both write
  paths.** P1-1's "refused at 15:59, accepted at 16:01" test at all three call
  sites should extend that file the same way rather than starting a new one.
- **Category names are still not searched, and the reason C-108 deferred them
  to C-109 expired** — the category grain was rejected, and a category's seed
  link is already on screen next to its own heading. Do not add it out of
  obligation.

## Ceilings recorded rather than fixed

- **`setAvailability` is read-then-write** (`ponytail:` comment on it).
  Last-write-wins, same posture as C-015's stale panels. Two cooks batching
  overlapping selections in the same second can leave one with an undo list
  short by the overlap. Nobody loses an 86. Fix is one `UPDATE ... RETURNING
  id` in raw SQL if it ever matters.
- **No per-batch event.** PRD 4's builder Open Question (one event per row, or
  one per batch?) is still open and still unanswerable, because neither the
  bulk path nor the single toggles write a menu-change event at all.
- **`done=off` survives a page reload**, so refreshing after a batch
  re-announces "Marked 6 sold out." It reports the URL, not an action.

## One flake, still recorded rather than fixed

`e2e/refund.spec.ts:211` ("a no-show is offered a refund rather than given
one") failed once in a full sweep at 8.0s and has passed in every sweep since,
including C-109's. A timeout, not an assertion. Local `retries` is 0 and CI's
is 1, so CI retries past it silently. First place to look if a refund spec
times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (marked `ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
