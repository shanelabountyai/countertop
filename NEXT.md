# Next

**`prd-menu-under-pressure.md` P0-1 — the 86 that names what it hits.** PRD 3
is closed (C-070 was the last item), so the ranking's next unfinished body of
work is PRD 4, and its P0 half is the cheapest work in the whole set: the
affected-item warning **needs no migration and no new query**, because
`ItemModifierGroup` already holds the join. Read the PRD's P0 block first —
the INDEX names three P0 items and one of them (bulk/category 86) is bigger
than the other two.

Model: **Sonnet** for P0-1. It is a read-side warning over an existing join,
with the write path unchanged. Move to Opus if the item turns out to touch the
orderability function rather than just report on it.

## What C-070 leaves behind

- **PRD 3 is closed by a document, not by a fix.** The product still computes
  the wrong tax on a mixed order. What changed is that it now does so in a way
  somebody can find, cost and reverse — five ordered migration steps in
  `packages/db/prisma/schema.prisma` above `model OrderLine`.
- **Nothing enforces the plan.** No test fails if a future session adds
  `OrderLine.taxCents NOT NULL` with a backfill; the block is prose in a schema
  file. The version with teeth is a static check of the kind C-106 built —
  reading a migration's text and refusing an UPDATE against a snapshot table —
  and it is more machinery than a deferred item warrants until the migration is
  actually being written.
- **`Order.taxRatePpm` stops explaining the total on its own the moment M4
  lands**, for any order spanning two categories. The plan says the column is
  written as the `prepared` rate and that its comment must change. It is the
  one step that makes an existing column *less* true, and the easiest thing in
  the sequence to miss.

## Two traps this session re-confirmed, worth not re-paying for

- **`prisma format` reformats the whole file.** It re-aligned every model's
  columns — 62 deletions in a documentation commit — because the file was last
  formatted by a different CLI version. Nothing in the gate runs a format check
  (`package.json`, `ci.yml`, `scripts/ci-local.sh` all checked). Use it to
  prove a block parses, then `git checkout` the file and re-apply the edit.
- **A `///` comment in `schema.prisma` attaches to the node that FOLLOWS it.**
  A "this column is deliberately absent" marker written as `///` becomes the
  next real column's documentation. Plain `//` for anything that is not about
  the field underneath it.

## Still open from C-069 / C-071, if you would rather clear debt

- A void the provider refuses is chased by nothing (marked `ponytail:` in
  `settleAuthorization`); a real processor expires holds on its own.
- The rush no longer exercises a refund end to end — both its prepaid exits are
  voids now, which is C-069 working. ~six lines to restore.
- The staff receipt's payment line still reads "Pay at pickup" on a released
  hold; only the customer's status page got the honest sentence.
- A reversal cannot be pointed at a specific comp, and `refund_failed` rows
  accumulate uncapped on a stuck provider.
