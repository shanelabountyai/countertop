-- ---------------------------------------------------------------------------
-- PRD 7 P1-1 (C-117): the tax base. Adds Order.discountCents — a pre-tax
-- reward, snapshotted like every other money column here — and moves the
-- arithmetic identity a receipt reconciles against from
--   subtotalCents + taxCents = totalCents
-- to
--   subtotalCents - discountCents + taxCents = totalCents.
--
-- `subtotalCents` itself is untouched: it stays the true Σ lines, what the
-- sales report sums, so the discount is a separate, visible number rather
-- than a smaller subtotal wearing a different name.
--
-- No backfill. Zero is the honest historical value for every order placed
-- before this column existed — none of them ever applied a discount, the
-- same "the value is genuinely unknowable, so it is genuinely absent" shape
-- as the "PER-LINE TAX" block's nullable columns, except here the honest
-- value happens to be a real default rather than null: nothing before
-- C-117 had anywhere to put a discount even if it wanted to.
--
-- HAND-WRITTEN for the three CHECKs, matching this repo's rule for any
-- migration carrying a constraint.
-- ---------------------------------------------------------------------------

ALTER TABLE "Order" ADD COLUMN "discountCents" INTEGER NOT NULL DEFAULT 0;

-- A discount cannot be negative — that would be a surcharge wearing this
-- column's name.
ALTER TABLE "Order"
  ADD CONSTRAINT order_discount_cents_not_negative
  CHECK ("discountCents" >= 0);

-- A discount cannot exceed what there is to discount. Without this, a bug
-- upstream of the constraint could snapshot a negative tax base and this
-- migration's whole point — an honest, reconcilable receipt — would be the
-- first thing it broke.
ALTER TABLE "Order"
  ADD CONSTRAINT order_discount_not_exceeding_subtotal
  CHECK ("discountCents" <= "subtotalCents");

-- THE constraint this ticket exists to add: the receipt's arithmetic,
-- enforced at the row, not merely computed once in `priceOrder` and trusted
-- forever after. `subtotalCents + taxCents = totalCents` held only because
-- `discountCents` was always implicitly zero; this is its replacement, and
-- it can never again drift from the schema the way a comment-only invariant
-- can.
ALTER TABLE "Order"
  ADD CONSTRAINT order_total_reconciles_with_discount
  CHECK ("totalCents" = "subtotalCents" - "discountCents" + "taxCents");
