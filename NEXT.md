# Next

**`docs/prds/prd-menu-under-pressure.md` P0-3 + P0-4 — kill a category in one
action, shipping as `C-109`.** The first item of PRD 4 that is not read-side:
multi-select plus a category-level 86, naming every item and option it will
affect BEFORE it applies and reporting what it did after, reversible by the
same mechanism. P0-4 rides with it — the bulk path has to reach the same three
surfaces a single 86 does, and the C-048 forced server-side submit case has to
be run against it.

Model: **Opus.** This is the first write-path item in PRD 4 and it is a
destructive batch: six rows flipped in one tap, an undo that has to return
exactly the six it killed and nothing else, and a propagation test that must be
EXTENDED to the bulk path rather than duplicated. Correctness-critical, and the
PRD leaves a genuine design call open (below).

## The Open Question you have to answer before writing code

**PRD 4's first Open Question is not settled: is a category the right grain for
"the fryer is down", or is the real grain a station?** "Sides" contains fried
and non-fried things, so a category-level 86 can kill food that is on the
shelf — which is the exact reverse-case failure the PRD's own problem statement
names as *worse*. The PRD says plainly: **if the answer is stations, P0-3 is
the wrong shape and should be built as a station attribute from the start**
(that is C-112/P1-3, an L with a migration). Decide it, write the decision
down, then build. Do not build the category version by default because it is
the cheaper one.

## What C-108 leaves behind

- **`searchMenu` and `itemsUsingGroup` both live in
  `packages/core/menu/reach.ts` and share `itemsWithGroup`**, which is now the
  one place `menu.items` is filtered by group membership. A bulk selection
  needs the same reach answer — ask that file, do not grow a fourth filter.
- **The board now filters.** `/kitchen/availability` renders only the rows
  matching `?q=`, and empty categories and groups disappear heading and all. A
  multi-select has to decide what a selection means when the filter changes
  underneath it — the laziest honest answer is that selection lives in the URL
  alongside `q`, so the whole screen stays a GET and keeps working unhydrated.
- **The used-on line stays at FULL reach inside a filter** — a row shown under
  "guac" still names all four items. P0-3's "names every item and option it
  will affect" must hold to the same rule: the preview is the real blast
  radius, never the visible subset.
- **The queue's `matchesLookup` and the board's `searchMenu` diverge on
  purpose** (marks vs narrows) and each file's comment says why. Do not unify
  them.
- **Substring matching only.** "guaq" finds nothing. Behind `searchMenu`, one
  function, no call sites — the fix if anyone is ever stranded by a typo.
- **Category names are not searched.** Deliberately deferred TO C-109, because
  that is the item that makes the category grain first-class.

## The numbering trap, still worth checking

PRD 4's phasing block was drafted while PRD 3 was consuming numbers and claimed
`C-071`–`C-076`; it is renumbered to `C-107`–`C-112` and the register continues
from `C-108`. **Check the next PRD's phasing block against
`grep '^## C-' docs/PROGRESS.md` before starting its first item** — PRD 4 was
not the only document drafted while an earlier PRD was still open.

## One flake, still recorded rather than fixed

`e2e/refund.spec.ts:211` ("a no-show is offered a refund rather than given
one") failed once in a full sweep at 8.0s, and has passed in every sweep since,
including C-108's (179 passed + 14 skipped = 193, zero flaky). A timeout, not
an assertion. Local `retries` is 0 and CI's is 1, so CI retries past it
silently. First place to look if a refund spec times out again.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (marked `ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
