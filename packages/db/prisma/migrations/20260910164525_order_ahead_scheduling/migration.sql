-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "requestedFor" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "RestaurantSettings" ADD COLUMN     "maxSlotWeight" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "scheduledOrdersEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slotIntervalMinutes" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "slotLeadMinutes" INTEGER NOT NULL DEFAULT 20;

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here (P1-2, C-114). Same house rule as `checkout_gate`:
-- every bound the settings screen enforces is ALSO a CHECK here, so a manager
-- typing straight into the database cannot configure a slot picker that makes
-- no sense.
-- ---------------------------------------------------------------------------

-- Five minutes is the shortest a slot picker is still useful at (finer than
-- that and it is just the ASAP queue with extra steps); an hour is the widest
-- before "pickup at 12:30" starts meaning "sometime this hour".
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_slot_interval_in_range
  CHECK ("slotIntervalMinutes" BETWEEN 5 AND 60);

-- Zero is legal (the very next slot boundary is bookable); four hours is the
-- same-day ceiling this feature deliberately does not grow past (P2's
-- catering lead-time rule is the version that would).
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_slot_lead_in_range
  CHECK ("slotLeadMinutes" BETWEEN 0 AND 240);

-- Same shape as `restaurant_settings_max_open_weight_positive`: a cap of zero
-- would silently refuse every slot forever through a code path nobody would
-- think to look at, and the enabled switch is how you turn scheduling off.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT restaurant_settings_max_slot_weight_positive
  CHECK ("maxSlotWeight" > 0);
