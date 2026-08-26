-- AlterTable
ALTER TABLE "RestaurantSettings" ADD COLUMN     "prepBaseMinutes" INTEGER NOT NULL DEFAULT 12,
ADD COLUMN     "prepPerOrderMinutes" INTEGER NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here (P0-7). The estimate is arithmetic on two numbers a
-- settings screen will one day let someone type into, and a negative one
-- SHORTENS the promise as the queue grows — a wrong number in the direction
-- that makes customers arrive early and wait.
-- ---------------------------------------------------------------------------

-- Zero base is allowed (the floor in `readyEstimate` covers it); negative is
-- not. The upper bound is a working day: a four-hour ticket is a catering
-- lead-time rule, which this model does not have (P2).
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_prep_base_in_range
  CHECK ("prepBaseMinutes" BETWEEN 0 AND 240);

-- Same reasoning, per order. The ceiling is deliberately low: at the default
-- 25-order auto-pause threshold, 60 minutes each would quote a full day.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_prep_per_order_in_range
  CHECK ("prepPerOrderMinutes" BETWEEN 0 AND 60);
