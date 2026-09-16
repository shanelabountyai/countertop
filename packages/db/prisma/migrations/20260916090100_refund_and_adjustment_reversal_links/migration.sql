-- ---------------------------------------------------------------------------
-- C-133: a refund and a comp can each be pointed at, and taken back, by name.
--
-- Two gaps closed together because they are the same gap twice. Neither
-- reversal could say WHICH decision it was correcting — a refund's reversal
-- did not exist at all, and a comp's reversal corrected the order's aggregate
-- net rather than any one comp, which reads fine until an order carries two
-- of them and a reversal cannot say which was wrong.
--
-- Four schema facts:
--
--   1. A REFUND REVERSAL POINTS AT ITS REFUND, an EQUIVALENCE in both
--      directions — this kind is new with this column, so there is no legacy
--      row to be lenient about, the same argument `authorizationId`'s CHECK
--      made in 20260906120100.
--
--   2. A REFUND MAY BE REVERSED ONCE, and the database is what says so. A
--      partial unique index, the same shape the settled-refund one takes:
--      a refund is corrected in full or not at all, so there is nothing to
--      leave room for a second attempt against the same row.
--
--   3. A COMP REVERSAL POINTS AT ITS COMP, ONE-DIRECTIONALLY — `adjustment_
--      reversed` has existed since C-071 (20260906090000_adjustment_reversed_
--      kind), so real rows predate this column and are honestly left null
--      rather than having a comp invented for them to point at. The same
--      leniency `refundRequestId`'s CHECK gives rows written before C-071.
--
--   4. `refund_reversed` JOINS THE MONEY-BEARING KINDS. Its amount is
--      mirrored from the refund it corrects, never typed again.
--
-- HAND-WRITTEN for the CHECKs, the partial index and the plain ones.
-- ---------------------------------------------------------------------------

-- --- 1. The reversal -> refund link, and its own EQUIVALENCE ----------------
ALTER TABLE "OrderEvent" ADD COLUMN "refundReversalOfId" TEXT;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_refundReversalOfId_fkey"
  FOREIGN KEY ("refundReversalOfId") REFERENCES "OrderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OrderEvent_refundReversalOfId_idx" ON "OrderEvent"("refundReversalOfId");

-- NO LEGACY ROW PREDATES THIS KIND, so unlike `refundRequestId`'s one-
-- directional CHECK, this one holds both ways: nothing that is not a
-- `refund_reversed` may claim this link, and nothing that is may leave it
-- null.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_refund_reversal_link_matches_kind
  CHECK (("kind" = 'refund_reversed') = ("refundReversalOfId" IS NOT NULL));

-- --- 2. One reversal per refund ----------------------------------------------
--
-- THE CONSTRAINT IS THE MECHANISM, the same argument `OrderEvent_settled_
-- refund_per_request` makes: two staff correcting the same wrongly-sent
-- refund at once must not both land, or the balance reads it reversed twice
-- over. PARTIAL, because the column is shared with nothing else that repeats
-- — a refund is corrected in full or not at all — so a plain unique index
-- would say the same thing; partial anyway, to read the same way its sibling
-- CHECK above reads, as a rule about `refund_reversed` rows specifically.
CREATE UNIQUE INDEX "OrderEvent_refund_reversed_once"
  ON "OrderEvent"("refundReversalOfId")
  WHERE "kind" = 'refund_reversed';

-- --- 3. The reversal -> comp link, ONE-DIRECTIONALLY -------------------------
ALTER TABLE "OrderEvent" ADD COLUMN "adjustmentReversalOfId" TEXT;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_adjustmentReversalOfId_fkey"
  FOREIGN KEY ("adjustmentReversalOfId") REFERENCES "OrderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "OrderEvent_adjustmentReversalOfId_idx" ON "OrderEvent"("adjustmentReversalOfId");

-- ONE-DIRECTIONAL, the same leniency `order_event_refund_link_matches_kind`
-- gives rows written before C-071: real `adjustment_reversed` rows predate
-- this column and are left null rather than backfilled with an invented
-- target. What this still enforces is the half that keeps the link
-- meaningful — nothing that is not a reversal may claim to be one.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_adjustment_reversal_link_matches_kind
  CHECK ("adjustmentReversalOfId" IS NULL OR "kind" = 'adjustment_reversed');

-- --- 4. `refund_reversed` joins the money-bearing kinds ----------------------
ALTER TABLE "OrderEvent" DROP CONSTRAINT order_event_amount_matches_kind;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_amount_matches_kind
  CHECK (
    CASE
      WHEN "kind" = 'refund_requested' THEN TRUE
      ELSE ("kind" IN ('payment', 'refund', 'adjustment', 'adjustment_reversed',
                       'authorization', 'capture', 'authorization_voided',
                       'refund_reversed'))
           = ("amountCents" IS NOT NULL)
    END
  );

-- The non-negative CHECK needs no change and deliberately gets none, for the
-- reason every prior money kind's migration gave: direction is the KIND,
-- never the sign. A reversed refund's amount is a positive number of cents
-- mirrored from the refund it corrects, and `paymentTotals` is what adds it
-- back onto what is owed.
