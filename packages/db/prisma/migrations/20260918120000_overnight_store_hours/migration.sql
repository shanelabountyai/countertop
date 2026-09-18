-- HAND-WRITTEN. Overnight store hours (C-141).
--
-- `store_hours_closes_after_opening` foreclosed 17:00–02:00 because the old
-- `checkoutGate` read an inverted row as closed all day. It now reads a close
-- at or before the open as running past midnight into the next day, owned by
-- the day it opens — the rule C-140 set for item dayparts. The only nonsense
-- left is a close on the minute of the open: empty, or all 24 hours. [0, 1440)
-- is how a whole day is written.
ALTER TABLE "StoreHours" DROP CONSTRAINT store_hours_closes_after_opening;

ALTER TABLE "StoreHours"
  ADD CONSTRAINT store_hours_not_empty
  CHECK ("closeMinute" <> "openMinute");
