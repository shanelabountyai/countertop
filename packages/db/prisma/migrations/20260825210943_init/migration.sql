-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('placed', 'accepted', 'preparing', 'ready', 'picked_up', 'cancelled', 'abandoned');

-- CreateEnum
CREATE TYPE "Intensity" AS ENUM ('none', 'light', 'regular', 'extra');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('unpaid', 'paid', 'refunded');

-- CreateEnum
CREATE TYPE "CancelReason" AS ENUM ('out_of_item', 'too_busy', 'other');

-- CreateEnum
CREATE TYPE "EventActor" AS ENUM ('customer', 'staff', 'system');

-- CreateEnum
CREATE TYPE "OrderEventKind" AS ENUM ('transition', 'revert', 'total_mismatch', 'refund');

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "basePriceCents" INTEGER NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierGroup" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "min" INTEGER NOT NULL,
    "max" INTEGER NOT NULL,
    "intensityEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ModifierGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModifierOption" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceDeltaCents" INTEGER NOT NULL,
    "extraPriceDeltaCents" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "ModifierOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemModifierGroup" (
    "itemId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,

    CONSTRAINT "ItemModifierGroup_pkey" PRIMARY KEY ("itemId","groupId")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "businessDay" CHAR(10) NOT NULL,
    "seq" INTEGER NOT NULL,
    "customerName" VARCHAR(40) NOT NULL,
    "customerPhone" VARCHAR(32),
    "orderNote" VARCHAR(140),
    "status" "OrderStatus" NOT NULL,
    "placedAt" TIMESTAMPTZ(3) NOT NULL,
    "statusChangedAt" TIMESTAMPTZ(3) NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "taxRatePpm" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "paymentState" "PaymentState" NOT NULL DEFAULT 'unpaid',
    "cancelReason" "CancelReason",
    "cancelNote" VARCHAR(140),
    "statusToken" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "menuItemId" TEXT,
    "itemName" TEXT NOT NULL,
    "categoryName" TEXT NOT NULL,
    "basePriceCents" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "lineTotalCents" INTEGER NOT NULL,
    "note" VARCHAR(140),

    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineOption" (
    "id" TEXT NOT NULL,
    "orderLineId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "modifierGroupId" TEXT,
    "modifierOptionId" TEXT,
    "groupName" TEXT NOT NULL,
    "optionName" TEXT NOT NULL,
    "intensity" "Intensity",
    "appliedDeltaCents" INTEGER NOT NULL,

    CONSTRAINT "OrderLineOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" "OrderEventKind" NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus",
    "actor" "EventActor" NOT NULL,
    "reason" TEXT,
    "detail" JSONB,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestaurantSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "timezone" TEXT NOT NULL,
    "taxRatePpm" INTEGER NOT NULL,

    CONSTRAINT "RestaurantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Category_sortOrder_idx" ON "Category"("sortOrder");

-- CreateIndex
CREATE INDEX "MenuItem_categoryId_sortOrder_idx" ON "MenuItem"("categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "ModifierOption_groupId_sortOrder_idx" ON "ModifierOption"("groupId", "sortOrder");

-- CreateIndex
CREATE INDEX "ItemModifierGroup_itemId_sortOrder_idx" ON "ItemModifierGroup"("itemId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "Order_statusToken_key" ON "Order"("statusToken");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Order_status_placedAt_idx" ON "Order"("status", "placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Order_businessDay_seq_key" ON "Order"("businessDay", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLine_orderId_lineNumber_key" ON "OrderLine"("orderId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineOption_orderLineId_sortOrder_key" ON "OrderLineOption"("orderLineId", "sortOrder");

-- CreateIndex
CREATE INDEX "OrderEvent_orderId_at_idx" ON "OrderEvent"("orderId", "at");

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModifierOption" ADD CONSTRAINT "ModifierOption_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemModifierGroup" ADD CONSTRAINT "ItemModifierGroup_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemModifierGroup" ADD CONSTRAINT "ItemModifierGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ModifierGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineOption" ADD CONSTRAINT "OrderLineOption_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES "OrderLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN. Everything below this line is what Prisma cannot express, and
-- is the reason this project never runs `prisma db push`: a schema pushed
-- straight from schema.prisma silently drops all of it, and every test that
-- does not specifically look for these still passes.
-- ---------------------------------------------------------------------------

-- The order event log is APPEND-ONLY (CLAUDE.md, "Database rules"). Undo is a
-- logged revert event, never a delete. A convention would be forgotten by the
-- third session; a trigger cannot be.
--
-- TRUNCATE is deliberately NOT blocked: it fires TRUNCATE triggers, not row
-- triggers, and it is how the test suite resets between files. Nothing in the
-- application issues one.
CREATE OR REPLACE FUNCTION order_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'OrderEvent is append-only: % is not permitted (order %). Write a revert event instead.',
    TG_OP, OLD."orderId";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER order_event_append_only
  BEFORE UPDATE OR DELETE ON "OrderEvent"
  FOR EACH ROW EXECUTE FUNCTION order_event_append_only();

-- Exactly one settings row, ever. Without this, "the restaurant's timezone" is
-- a query that can return two answers, and the daily order-number reset and
-- every report bucket depend on it returning one.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_singleton CHECK (id = 'singleton');
