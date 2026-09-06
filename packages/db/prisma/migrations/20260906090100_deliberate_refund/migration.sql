-- ---------------------------------------------------------------------------
-- PRD 3 P0-6 (C-071): a refund that can be issued on purpose.
--
-- Until now the ONLY thing that could ask for a refund was cancelling a paid
-- order. That made a request a by-product of a status change, and it made
-- "one refund per order" an assumption everything downstream quietly took:
-- `deriveRefundState` answered "where did the refund get to" about the ORDER,
-- and `settleRefund` sent back the whole balance because nothing else had a
-- claim on it. Its own comment named the day this would break.
--
-- Three schema facts, and each is a hole the product could otherwise fall
-- through:
--
--   1. A request may CARRY AN AMOUNT. The cancellation's still does not, and
--      that stays deliberate — it cannot know what will be held at the moment
--      of the attempt, so it declines to say and `orderBalance` answers later.
--      A deliberate refund is the opposite case: somebody typed a number, and
--      that number is the ask. So the amount CHECK stops being an equivalence
--      over one list and grows an exception for exactly this kind.
--
--   2. An attempt POINTS AT ITS REQUEST. Without the link, a second request
--      reads as settled by the first request's success — the customer is told
--      their money went back and it did not. This is the column the whole item
--      turns on.
--
--   3. A request may be settled ONCE, and the database is what says so. The
--      old guard was a compare-and-set on `paymentState` going `paid` ->
--      `refunded`, which worked only because every refund was total. A partial
--      refund leaves the column at `paid`, so that guard silently stops
--      guarding and two people tapping Send at the same instant write two
--      `refund` rows against one provider call. A partial unique index cannot
--      be talked out of it.
--
-- HAND-WRITTEN for the CHECKs, the partial index and the backfill.
-- ---------------------------------------------------------------------------

-- --- 1. The attempt -> request link -----------------------------------------
ALTER TABLE "OrderEvent" ADD COLUMN "refundRequestId" TEXT;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_refundRequestId_fkey"
  FOREIGN KEY ("refundRequestId") REFERENCES "OrderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Postgres does not index a foreign key for you, and `RESTRICT` scans this
-- column on every attempted delete. It is also the reverse lookup the
-- exceptions list does: "which requests have no `refund` against them".
CREATE INDEX "OrderEvent_refundRequestId_idx" ON "OrderEvent"("refundRequestId");

-- --- 2. The backfill, and the trigger it has to step around ------------------
--
-- Same argument as C-063's, which is the precedent this follows: the
-- append-only trigger is defending against APPLICATION code rewriting history,
-- and this is not that. Every `refund` and `refund_failed` row written since
-- C-067 belongs to the one and only `refund_requested` on its order — that was
-- the assumption of the model it was written under — so naming that request is
-- a lossless RE-ENCODING of a fact the row already implied. No event changes
-- its meaning, its instant, its actor or its amount.
--
-- Rows OLDER than C-067 are deliberately left null and the CHECK below is
-- written to allow them. Before C-067 a cancellation pushed a bare `refund`
-- with no request at all, so there is nothing for those to point at, and
-- inventing a request for them would be a claim that somebody asked for
-- something nobody recorded. They are settled refunds against no request,
-- which is exactly what `pendingRefunds` reads them as: nothing owed.
--
-- Disabled BY NAME rather than with `session_replication_role`, which needs
-- superuser and would silently disable every other trigger in the database.
-- Re-enabled unconditionally: a migration that leaves the guard off is one
-- that removes the invariant permanently.
ALTER TABLE "OrderEvent" DISABLE TRIGGER order_event_append_only;

UPDATE "OrderEvent" AS attempt
SET "refundRequestId" = request."id"
FROM "OrderEvent" AS request
WHERE attempt."kind" IN ('refund', 'refund_failed')
  AND attempt."refundRequestId" IS NULL
  AND request."orderId" = attempt."orderId"
  AND request."kind" = 'refund_requested';

ALTER TABLE "OrderEvent" ENABLE TRIGGER order_event_append_only;

-- --- 3. Only an attempt may name a request ----------------------------------
--
-- ONE-DIRECTIONAL on purpose, where the amount CHECK below is an equivalence.
-- "Every refund names a request" is not true of the pre-C-067 rows the
-- backfill just declined to invent history for, and a constraint that is false
-- of committed data is a migration that cannot be applied to production. What
-- this does enforce is the half that keeps the link meaningful: nothing that
-- is not an attempt may claim to be one, so a `transition` or an `adjustment`
-- can never appear in `refundAttempts` and quietly settle a request.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_refund_link_matches_kind
  CHECK ("refundRequestId" IS NULL OR "kind" IN ('refund', 'refund_failed'));

-- --- 4. One settled refund per request ---------------------------------------
--
-- THE CONSTRAINT IS THE MECHANISM, exactly as it is for placement's
-- idempotency key: the provider's own idempotency (it is handed the request's
-- row id) is what stops the customer being paid twice, and this is what stops
-- the LOG recording it twice. A duplicated `refund` row is not a cosmetic
-- problem — `orderBalance` sums the log, so it would show a customer's money
-- as having gone back twice and the exceptions list would go quiet about a
-- balance that is now wrong in the restaurant's favour.
--
-- PARTIAL, because `refund_failed` shares this column and there may be many of
-- those per request: retrying a stuck refund is the ordinary case and each
-- attempt writes its own row. Only the success is unique.
--
-- Prisma cannot express a `WHERE` on an index, so this lives in the migration
-- only. `prisma migrate diff` ignores partial indexes exactly as it ignores
-- the CHECK constraints above — verified against this migration history before
-- relying on it — and CI asserts it by name in `pg_class` for the same reason
-- it asserts those.
CREATE UNIQUE INDEX "OrderEvent_settled_refund_per_request"
  ON "OrderEvent"("refundRequestId")
  WHERE "kind" = 'refund';

-- --- 5. A request may name its amount ----------------------------------------
--
-- C-063 wrote this as an EQUIVALENCE so that a further money kind would be one
-- line rather than two that drift. That paid off twice (C-065's `adjustment`,
-- and `adjustment_reversed` below) and this is the first kind it cannot
-- describe: `refund_requested` is honest EITHER WAY.
--
--   * NULL is the cancellation's, and stays the cancellation's. It cannot know
--     what the restaurant will be holding at the moment of the attempt — a
--     comp or a counter payment can land in between — so it declines to say,
--     and `orderBalance` is asked instead.
--   * A NUMBER is a deliberate refund's. Somebody typed it, and it is the ask.
--     `settleRefund` may refuse it against the balance at the attempt; it may
--     never revise it, because revising it would be the product deciding how
--     much of a customer's money to give back.
--
-- The exception is spelled as a CASE rather than bolted on with `OR`, so the
-- kind that is exempt is named once and reads as the exception it is.
ALTER TABLE "OrderEvent" DROP CONSTRAINT order_event_amount_matches_kind;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_amount_matches_kind
  CHECK (
    CASE
      WHEN "kind" = 'refund_requested' THEN TRUE
      ELSE ("kind" IN ('payment', 'refund', 'adjustment', 'adjustment_reversed'))
           = ("amountCents" IS NOT NULL)
    END
  );

-- The non-negative CHECK needs no change and deliberately gets none, for the
-- reason C-065's migration gave: direction is the KIND, never the sign. A
-- reversal is a positive number of cents subtracted from the adjusted total by
-- `paymentTotals`, and a negative one would be a comp wearing a reversal's
-- name.
