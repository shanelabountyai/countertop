-- HAND-WRITTEN. Overnight daypart windows (C-140).
--
-- `menu_item_window_ends_after_start` foreclosed 22:00–02:00 because the old
-- `daypartClosure` read an inverted row as "never served". It now reads a row
-- whose end is at or before its start as wrapping past midnight into the next
-- day, so the only nonsense left is a window that starts and ends on the same
-- minute: empty, or all 24 hours — ambiguous either way. [0, 1440) is how a
-- whole day is written.
ALTER TABLE "MenuItemWindow" DROP CONSTRAINT menu_item_window_ends_after_start;

ALTER TABLE "MenuItemWindow"
  ADD CONSTRAINT menu_item_window_not_empty
  CHECK ("endMinute" <> "startMinute");
