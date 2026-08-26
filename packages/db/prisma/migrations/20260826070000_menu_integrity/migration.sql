-- ---------------------------------------------------------------------------
-- HAND-WRITTEN, no schema change (C-022). The menu had no integrity rules at
-- all: nothing stopped a group being saved with `max` below `min`, or an item
-- priced below zero, or a surcharge that pays the customer to ask for extra.
--
-- The kitchen menu editor already refuses most of these (C-015), and that is
-- the right place for the MESSAGE. This is the other half of the same rule:
-- the database refuses, so correctness does not depend on the only screen that
-- writes menu rows today staying the only one.
--
-- Deliberately NOT here: "a group's `min` must not exceed its option count".
-- That is a cross-row invariant a CHECK cannot see, and a trigger for it would
-- have to fire on two tables and cope with a group being inserted before the
-- options that satisfy it — which is exactly how the seed writes them. It
-- stays in the editor, where C-015 put it after getting the bound backwards.
-- ---------------------------------------------------------------------------

-- "Choose at least none" is an optional group and is ordinary. A negative
-- minimum is not a looser rule, it is a number nobody wrote on purpose.
ALTER TABLE "ModifierGroup"
  ADD CONSTRAINT modifier_group_min_not_negative
  CHECK ("min" >= 0);

-- A group nobody can pick anything from is not a group. `max = 0` renders as a
-- section with options that cannot be selected, which reads as a broken screen
-- rather than as a menu decision.
ALTER TABLE "ModifierGroup"
  ADD CONSTRAINT modifier_group_max_at_least_one
  CHECK ("max" >= 1);

-- The unsatisfiable group: "choose at least 3, at most 2". Nothing composed
-- from it can ever validate, so every item carrying it silently stops being
-- orderable — the failure shows up at a customer's Add to cart, three screens
-- away from the edit that caused it.
ALTER TABLE "ModifierGroup"
  ADD CONSTRAINT modifier_group_max_not_below_min
  CHECK ("max" >= "min");

-- A free item is fine; an item that pays the customer to order it is not.
-- Modifier DELTAS may be negative by design ("Small −$1.50") and are
-- deliberately unconstrained here.
ALTER TABLE "MenuItem"
  ADD CONSTRAINT menu_item_base_price_not_negative
  CHECK ("basePriceCents" >= 0);

-- The `extra` surcharge is added ON TOP of the delta. Null means "extra is
-- free", which is the common case; a negative surcharge would mean asking for
-- extra cheese makes the burrito cheaper.
ALTER TABLE "ModifierOption"
  ADD CONSTRAINT modifier_option_extra_surcharge_not_negative
  CHECK ("extraPriceDeltaCents" IS NULL OR "extraPriceDeltaCents" >= 0);
