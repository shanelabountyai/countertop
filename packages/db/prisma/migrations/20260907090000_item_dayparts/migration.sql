-- CreateTable
CREATE TABLE "MenuItemWindow" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,

    CONSTRAINT "MenuItemWindow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MenuItemWindow_itemId_dayOfWeek_startMinute_key"
  ON "MenuItemWindow"("itemId", "dayOfWeek", "startMinute");

-- CreateIndex
CREATE INDEX "MenuItemWindow_itemId_idx" ON "MenuItemWindow"("itemId");

-- AddForeignKey
ALTER TABLE "MenuItemWindow"
  ADD CONSTRAINT "MenuItemWindow_itemId_fkey"
  FOREIGN KEY ("itemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here, mirroring the `StoreHours` discipline C-011/C-023
-- established. A daypart is read by THE orderability function on every menu
-- render, every cart-add and every placement; a row that makes no sense does
-- not throw anywhere, it silently takes an item off the menu forever. These
-- make that a write-time failure instead.
-- ---------------------------------------------------------------------------

-- 0 = Sunday .. 6 = Saturday, matching `restaurantClock`. A 7 here is a window
-- that matches no day, i.e. an item nobody can ever order.
ALTER TABLE "MenuItemWindow"
  ADD CONSTRAINT menu_item_window_day_of_week_range
  CHECK ("dayOfWeek" BETWEEN 0 AND 6);

-- Minutes since local midnight. The start is a minute IN the day; the end is
-- EXCLUSIVE, so 1440 is legal and means "through the last minute of the day".
ALTER TABLE "MenuItemWindow"
  ADD CONSTRAINT menu_item_window_minutes_in_range
  CHECK ("startMinute" BETWEEN 0 AND 1439 AND "endMinute" BETWEEN 1 AND 1440);

-- Ending after starting. This forecloses an overnight window (22:00–02:00) the
-- same way `store_hours_closes_after_opening` forecloses overnight service,
-- and for the same reason: `daypartClosure` reads such a row as "never", which
-- is an item that vanishes with no error anywhere. A late-night item is two
-- rows on two days, and the write-up says so.
ALTER TABLE "MenuItemWindow"
  ADD CONSTRAINT menu_item_window_ends_after_start
  CHECK ("endMinute" > "startMinute");
