-- ---------------------------------------------------------------------------
-- P1-4 (C-042): an order remembers what it was promised.
--
-- The P0-7 estimate has been recomputed on every render since C-013, which is
-- correct for a customer watching a queue move and useless afterwards: an
-- order placed into a quiet morning kept no record of the "10–20 min" it was
-- shown, so "were we honest?" had no data behind it. These three columns are
-- that record, snapshotted at placement beside the money and the prep weight,
-- under the same rule — a receipt is a COPY, never a re-derivation.
--
-- HAND-WRITTEN: it adds CHECKs, including one across three columns.
-- ---------------------------------------------------------------------------

-- NULLABLE, and deliberately not backfilled. Every other snapshot column could
-- be reconstructed from the rows that were there at the time; a promise cannot
-- — the queue depth at 12:04 last Tuesday is gone. Inventing one would make
-- the accuracy report grade orders against a quote nobody ever saw, which is
-- the exact dishonesty this item exists to remove. NULL means "we have no
-- record of what this customer was told", and the report skips those rows.
ALTER TABLE "Order" ADD COLUMN "quotedLowMinutes"  INTEGER;
ALTER TABLE "Order" ADD COLUMN "quotedHighMinutes" INTEGER;
ALTER TABLE "Order" ADD COLUMN "quotedOpenWeight"  INTEGER;

-- All three or none of the three. A half-written quote is worse than no quote:
-- a low end with no high end would be graded against a window the code has to
-- guess the width of, and the width is a constant that is allowed to change.
ALTER TABLE "Order"
  ADD CONSTRAINT order_quote_is_whole_or_absent
  CHECK (
    num_nonnulls("quotedLowMinutes", "quotedHighMinutes", "quotedOpenWeight") IN (0, 3)
  );

-- The estimate's own two rules, enforced where they cannot be forgotten: it is
-- a RANGE (high strictly above low, never a point), and its low end is at
-- least one rounding step, because "0–10 min" reads as "now" (P0-7).
ALTER TABLE "Order"
  ADD CONSTRAINT order_quote_is_a_range
  CHECK ("quotedLowMinutes" IS NULL OR "quotedHighMinutes" > "quotedLowMinutes");

ALTER TABLE "Order"
  ADD CONSTRAINT order_quote_low_is_positive
  CHECK ("quotedLowMinutes" IS NULL OR "quotedLowMinutes" > 0);

-- Zero is an empty queue and a real reading (P1-7 — a kitchen with nothing on
-- it). Negative would mean work was subtracted from the queue.
ALTER TABLE "Order"
  ADD CONSTRAINT order_quote_open_weight_not_negative
  CHECK ("quotedOpenWeight" IS NULL OR "quotedOpenWeight" >= 0);
