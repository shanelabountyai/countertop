# Next

**PRD 3 P1-1 (`C-069`) — auth at placement, capture at pickup**, or the next
ranked PRD in `docs/prds/INDEX.md`. PRD 3's whole P0 block is now ticked,
including the P0-6 that C-071 wrote for itself.

What P1-1 asks for: the pickup-shaped answer to a no-show — it costs a **void**,
not a refund. Hang capture on `ready → picked_up`. Still against the mock
provider; the seam is what matters, and C-071 just proved the seam takes a
third caller without becoming a third path.

Two things C-071 leaves it:
- `settleRefund(orderId, now, staffId?, provider?, requestId?)` is the one
  attempt, with three callers. An auth/capture pair is the same shape pointed
  the other way — resist giving it its own writer.
- `refund_requested` may carry an amount now, and `refundRequestId` links an
  attempt to its ask. An authorization is the same idea (a durable row whose id
  is the key, settled later), so look at `packages/core/orders/refund.ts`
  before inventing a parallel model.

Model: Opus — money path again, and the trap is the same one: a guard whose
premise silently widens (see the C-071 WRITEUP entry on the `paymentState`
compare-and-set).

## Left behind by C-071, if you would rather clear debt

- A reversal cannot be pointed at a specific comp — it contradicts the adjusted
  total, not a row. Needs a link column and a per-row button; only worth it if
  the report wants "which comps were taken back".
- `refund_failed` rows accumulate uncapped on a stuck provider; nothing
  truncates them on the receipt's activity log.
- The seeded rush exercises only the cancel path's refund, not a deliberate one.
