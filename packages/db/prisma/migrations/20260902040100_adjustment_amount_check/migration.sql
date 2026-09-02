-- ---------------------------------------------------------------------------
-- PRD 3 P0-3 (C-065): `adjustment` joins the money-bearing kinds.
--
-- A SEPARATE FILE from the `ALTER TYPE` above, and not by preference — see
-- that migration's header. This one only names the value; it is the first
-- transaction that is allowed to.
--
-- C-063 wrote this constraint as an EQUIVALENCE rather than as two CHECKs,
-- precisely so that adding a third money kind would be one line here instead
-- of two that could drift apart. This is that line, and the design paying off:
-- an `adjustment` row with a NULL amount is now rejected by the database, not
-- by a code path somebody remembered to write.
--
-- `total_mismatch` stays on the "must not" side, unchanged. It holds amounts
-- in `detail` and moves none of them.
--
-- The non-negative CHECK needs no change and deliberately gets none: direction
-- is the KIND, never the sign. A comp is a positive number of cents the
-- restaurant chose not to ask for — `orderBalance` subtracts it — and a
-- negative "adjustment" would be a surcharge wearing a comp's name.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrderEvent" DROP CONSTRAINT order_event_amount_matches_kind;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_amount_matches_kind
  CHECK (("kind" IN ('payment', 'refund', 'adjustment')) = ("amountCents" IS NOT NULL));
