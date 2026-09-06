# Next

**A refund that can be issued on purpose** — the money item C-067 and C-068 both
left behind, and the last thing PRD 3's money story is missing now that its
whole P0 block is ticked.

There is no `C-0xx` for it yet; write one as part of the work (C-071 is free —
C-069 and C-070 are the PRD's own P1 items and are not this).

What it asks for:
- Today the only thing that requests a refund is cancelling a paid order. A comp
  on an order that already paid reads as a zero balance rather than as money
  owed back — expressible since C-067, still not shippable.
- Needs a **form** (an amount in cents), a **bound** (what the restaurant is
  actually holding, from `orderBalance` — recomputed at the attempt, never
  frozen), and **its own refusal** (over the bound: refused, never clamped, the
  same discipline as `adjustmentEvent`).
- Plus the **reversing adjustment** C-065 and C-066 both deferred: a mistaken
  comp is corrected by a contradicting row, never a delete.
- `settleRefund` in `packages/db/refund.ts` is the one attempt and already has
  two callers; this is the third, and it must not become a second path.
- **Then** `abandon` can offer a refund, which is the half of C-068's phasing
  line deliberately not built — a no-show is not automatically a refund (the
  food was made), so it has to be an offer, and the offer needs this control.

Model: Opus — money path, a new writer against an append-only log, and the trap
is inventing a second refund path beside `settleRefund`.

The alternative, if you would rather move on: PRD 3 P1-1 (`C-069`, auth at
placement / capture at pickup) or the next ranked PRD in `docs/prds/INDEX.md`.
