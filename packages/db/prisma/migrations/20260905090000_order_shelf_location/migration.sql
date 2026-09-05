-- C-062 — PRD 2 P0-5: where the bag is.
--
-- One nullable column, additive, no constraint. The width IS the constraint
-- worth having: sixteen characters holds "warmer left" and refuses a sentence,
-- and a shelf label that has become a paragraph is a note, which is P0-6's.
--
-- THE ONE MUTABLE COLUMN ON A SNAPSHOT TABLE, and the schema comment beside it
-- says why that is legal: it describes where the food physically is, not what
-- was sold. It is written after placement, edited freely because a bag gets
-- moved, read by no report, and unreachable from `ORDER_RECEIPT` — which omits
-- it, so the customer's status page and the staff receipt cannot render it
-- even by accident. The queue read is the only shape that carries it.
--
-- NULL is the honest default for every order that already exists: nobody wrote
-- a shelf on them, and a backfill would be inventing a location for food that
-- has long since left the building.
ALTER TABLE "Order"
  ADD COLUMN "shelfLocation" VARCHAR(16);
