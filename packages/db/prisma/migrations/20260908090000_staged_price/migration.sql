-- CreateTable
CREATE TABLE "StagedPrice" (
    "id" TEXT NOT NULL,
    "itemId" TEXT,
    "optionId" TEXT,
    "effectiveDay" CHAR(10) NOT NULL,
    "priceCents" INTEGER NOT NULL,

    CONSTRAINT "StagedPrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StagedPrice_itemId_effectiveDay_key"
  ON "StagedPrice"("itemId", "effectiveDay");

-- CreateIndex
CREATE UNIQUE INDEX "StagedPrice_optionId_effectiveDay_key"
  ON "StagedPrice"("optionId", "effectiveDay");

-- CreateIndex
CREATE INDEX "StagedPrice_effectiveDay_idx" ON "StagedPrice"("effectiveDay");

-- AddForeignKey
ALTER TABLE "StagedPrice"
  ADD CONSTRAINT "StagedPrice_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedPrice"
  ADD CONSTRAINT "StagedPrice_optionId_fkey"
  FOREIGN KEY ("optionId") REFERENCES "ModifierOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here. Every row in this table is read by the price
-- authority on every menu render, every cart-add and every placement. A row
-- that makes no sense does not throw anywhere: it quietly reprices the menu,
-- which is the one failure mode this whole feature exists to take away from a
-- manager typing during lunch. These make it a write-time failure instead.
-- ---------------------------------------------------------------------------

-- Exactly one target. A row with neither is a price for nothing; a row with
-- both is a price for two things whose resolution would depend on which
-- branch the mapping happened to check first.
ALTER TABLE "StagedPrice"
  ADD CONSTRAINT staged_price_one_target
  CHECK (("itemId" IS NULL) <> ("optionId" IS NULL));

-- "YYYY-MM-DD", the same shape and the same CHECK as `CheckoutGate.closedOnDay`
-- (C-023). It is compared to `restaurantClock(...).day` as a STRING, and ISO
-- dates only sort chronologically while they all look like this.
ALTER TABLE "StagedPrice"
  ADD CONSTRAINT staged_price_effective_day_shape
  CHECK ("effectiveDay" ~ '^\d{4}-\d{2}-\d{2}$');

-- An ITEM that pays the customer to order it is a typo every time, and the
-- composition engine has no notion of one — the same rule `saveItemPrice`
-- enforces on a live price. An OPTION's delta may be negative on purpose
-- ("Small −$1.50"), so this is conditional rather than a blanket >= 0.
ALTER TABLE "StagedPrice"
  ADD CONSTRAINT staged_price_item_not_negative
  CHECK ("itemId" IS NULL OR "priceCents" >= 0);
