-- AlterTable
ALTER TABLE "RestaurantSettings" ADD COLUMN     "closedOnDay" CHAR(10),
ADD COLUMN     "cutoffMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "maxOpenOrders" INTEGER NOT NULL DEFAULT 25,
ADD COLUMN     "ordersPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "pauseMessage" VARCHAR(200);

-- CreateTable
CREATE TABLE "StoreHours" (
    "dayOfWeek" INTEGER NOT NULL,
    "openMinute" INTEGER NOT NULL,
    "closeMinute" INTEGER NOT NULL,

    CONSTRAINT "StoreHours_pkey" PRIMARY KEY ("dayOfWeek")
);

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here. The gate is only as trustworthy as the numbers it
-- reads: every branch in `checkoutGate` assumes a window that makes sense, and
-- a settings screen is one fat finger away from a restaurant that is open from
-- 21:00 to 11:00 — which the code would read as "closed all day, forever" with
-- no error anywhere.
-- ---------------------------------------------------------------------------

-- 0 = Sunday .. 6 = Saturday, matching `restaurantClock`.
ALTER TABLE "StoreHours"
  ADD CONSTRAINT store_hours_day_of_week_range
  CHECK ("dayOfWeek" BETWEEN 0 AND 6);

-- Minutes since local midnight. Opening is a minute IN the day; closing may be
-- midnight itself (1440), which is the only value above 1439 that means
-- anything.
ALTER TABLE "StoreHours"
  ADD CONSTRAINT store_hours_minutes_in_range
  CHECK ("openMinute" BETWEEN 0 AND 1439 AND "closeMinute" BETWEEN 1 AND 1440);

-- Closing after opening. This is what forecloses overnight service (17:00 to
-- 02:00) — a real thing for a late-night kitchen, and NOT what this schema
-- models. Refusing it loudly at write time beats a gate that silently reads
-- every minute of such a day as "closed" (recorded in docs/WRITEUP.md).
ALTER TABLE "StoreHours"
  ADD CONSTRAINT store_hours_closes_after_opening
  CHECK ("closeMinute" > "openMinute");

-- A threshold of zero pauses ordering permanently through a code path nobody
-- would think to look at; a negative one is nonsense. The manual switch is how
-- you stop taking orders.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_max_open_orders_positive
  CHECK ("maxOpenOrders" > 0);

-- A cutoff cannot be negative (that would extend ordering past close), and one
-- longer than a working day would close the restaurant permanently.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_cutoff_in_range
  CHECK ("cutoffMinutes" BETWEEN 0 AND 720);

-- The closed-today override is compared as a STRING against
-- `restaurantClock().day`. A value in any other shape can never match, so it
-- would read as "not closed today" — the failure mode being a restaurant that
-- announced it was shut and took orders anyway.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_closed_on_day_shape
  CHECK ("closedOnDay" IS NULL OR "closedOnDay" ~ '^\d{4}-\d{2}-\d{2}$');
