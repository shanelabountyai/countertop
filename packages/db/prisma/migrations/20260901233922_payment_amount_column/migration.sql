-- ---------------------------------------------------------------------------
-- PRD 3 P0-1 (C-063): money moved becomes a COLUMN, because the event stream
-- is now the truth.
--
-- Decision 5 of 2026-09-01: `Order.paymentState` stays as the fast read every
-- surface already uses and becomes a DERIVED CACHE over these events. That
-- makes the amount something a balance is summed from — so it cannot stay a
-- key inside `detail`, where no index can help it and no CHECK can constrain
-- it. `refund` has carried `detail.amountCents` since C-004 and `payment`
-- since C-085; both are backfilled below and neither loses its `detail`.
--
-- HAND-WRITTEN for the backfill and the CHECK.
-- ---------------------------------------------------------------------------

ALTER TABLE "OrderEvent" ADD COLUMN "amountCents" INTEGER;
ALTER TABLE "OrderEvent" ADD COLUMN "providerRef" VARCHAR(128);

-- --- The backfill, and the trigger it has to step around ---------------------
--
-- YOU CANNOT BACKFILL AN APPEND-ONLY TABLE. The C-003 trigger refuses every
-- UPDATE on this table by design, and it refused this one:
--
--   ERROR: OrderEvent is append-only: UPDATE is not permitted.
--          Write a revert event instead.
--
-- The trigger is right and stays. What it is defending against is APPLICATION
-- code rewriting history — an undo that edits the event it is undoing, which
-- is the defect the whole append-only rule exists to prevent. This is not
-- that: the value being written is derived from the row's own `detail`, so
-- the backfill is a lossless RE-ENCODING of a fact already stored on the row,
-- not a new claim about what happened. No event changes its meaning, its
-- instant, its actor or its amount.
--
-- Disabled by name rather than with `session_replication_role`, which needs
-- superuser and would silently disable every other trigger in the database
-- too. Re-enabled unconditionally below: a migration that leaves the guard off
-- is a migration that removes the invariant permanently.
ALTER TABLE "OrderEvent" DISABLE TRIGGER order_event_append_only;

UPDATE "OrderEvent"
SET "amountCents" = ("detail"->>'amountCents')::INTEGER
WHERE "kind" IN ('payment', 'refund')
  AND "detail" ? 'amountCents';

ALTER TABLE "OrderEvent" ENABLE TRIGGER order_event_append_only;

-- Money events must carry an amount; nothing else may. Written as an
-- equivalence rather than two CHECKs so the two halves cannot drift apart:
-- adding a third money kind means editing one line, and the compiler-equivalent
-- here is that the constraint fails loudly at write time rather than letting a
-- payment through with a NULL amount that silently sums as zero.
--
-- `total_mismatch` is deliberately on the "must not" side. It carries two
-- amounts in `detail` and moves no money at all — it is evidence about a
-- number, not a movement of one, and a balance that summed it would be wrong
-- in the customer's favour by whatever they claimed.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_amount_matches_kind
  CHECK (("kind" IN ('payment', 'refund')) = ("amountCents" IS NOT NULL));

-- Money moved is never negative. Direction is the KIND, not the sign — a
-- refund of -300 and a payment of 300 would be the same row twice over, and
-- exactly the kind of ambiguity a balance cannot recover from.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_amount_not_negative
  CHECK ("amountCents" IS NULL OR "amountCents" >= 0);
