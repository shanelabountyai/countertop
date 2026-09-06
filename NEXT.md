# Next

**PRD 3 P1-2 (`C-070`) — per-line tax, or the written plan not to**, which is
the last item in PRD 3 and is *gated on its own Open Question*. Read that
question before building anything: the honest answer may be a schema comment
recording exactly which columns move and in which order, not a migration. The
PRD says a wrong backfill silently restates a filed tax period, which is why it
is P1 rather than P0.

If the answer is "not now", the item is small and the session should then move
to the next ranked PRD in `docs/prds/INDEX.md` — PRD 3's P0 block and P1-1 are
both done, so the ranking's next unfinished body of work is
`prd-menu-under-pressure.md`, whose P0 half needs no migration at all.

Model: **Opus** for P1-2 if it is built (snapshot columns and a backfill),
**Sonnet** if the answer is the written plan.

## What C-069 leaves the next money item

- `PaymentProvider` in `packages/db/provider.ts` is now the one seam, with a
  named `ProviderOperation` (`authorize` / `capture` / `void` / `refund`). Any
  further money movement goes through it rather than beside it.
- `paymentTotals` is the only place that knows there are two kinds of money
  arriving (`payment` and `capture`). Add a third and this is the one function
  that changes — nothing outside it sums the log.
- A hold is neither collected nor owed: `orderBalance` subtracts
  `authorizedCents` from `outstandingCents`, which is what keeps the counter
  from being offered cash on a card that is already held.

## Left behind by C-069, if you would rather clear debt

- **A void the provider refuses is not chased by anything.** Nothing is
  written, so the order stays `authorized` and no screen lists it. Marked
  `ponytail:` in `settleAuthorization`. A real processor expires holds on its
  own; an exceptions list for a mock that never fails would be machinery for a
  failure this product cannot have.
- **The rush no longer exercises a refund end to end.** Its two prepaid exits
  are both voids now, which is the item working. Adding a counter collection to
  one rush ticket restores it in about six lines.
- **The staff receipt's payment line still reads "Pay at pickup" on a released
  hold.** Only the customer's status page got the honest sentence. The activity
  log says "Card hold released" either way.

## Still open from C-071

- A reversal cannot be pointed at a specific comp — it contradicts the
  adjusted total, not a row.
- `refund_failed` rows accumulate uncapped on a stuck provider; nothing
  truncates them on the receipt's activity log.
