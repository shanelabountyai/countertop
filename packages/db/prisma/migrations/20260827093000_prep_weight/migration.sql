-- ---------------------------------------------------------------------------
-- P1-7 (C-041): the queue is measured in WORK, not in tickets.
--
-- Until now the P0-6 auto-pause threshold and the P0-7 estimate both read one
-- number — the count of orders in OPEN_STATUSES — which said that four bottled
-- waters and four fajita plates are the same kitchen. This migration gives
-- every menu item an integer prep weight, snapshots each order's total weight
-- alongside its money, and converts the two settings that read the count.
--
-- HAND-WRITTEN throughout: it backfills, renames, and adds CHECKs.
-- ---------------------------------------------------------------------------

-- Default 1 so an existing menu means exactly what it meant before this ran:
-- every item one unit of work.
ALTER TABLE "MenuItem" ADD COLUMN "prepWeight" INTEGER NOT NULL DEFAULT 1;

-- Same on placed orders, then backfilled: under the old model every item was
-- worth 1, so an order's weight WAS its total quantity. An order with no lines
-- cannot exist (the empty cart is refused at placement), but COALESCE keeps
-- this deterministic rather than NULL if one ever did.
ALTER TABLE "Order" ADD COLUMN "prepWeight" INTEGER NOT NULL DEFAULT 1;

UPDATE "Order" o
SET "prepWeight" = COALESCE(
  (SELECT SUM(l."quantity") FROM "OrderLine" l WHERE l."orderId" = o."id"),
  0
);

-- The default goes away once the backfill is done: placement computes this
-- from the menu snapshot and must always supply it. A column that defaults to
-- 1 would let a writer that forgot silently record a fajita plate as a bottle
-- of water, and the throttle would believe it.
ALTER TABLE "Order" ALTER COLUMN "prepWeight" DROP DEFAULT;

-- Zero is a real weight (a can out of the fridge). The ceiling is a ceiling,
-- not a policy: 50 units at the default minute-per-weight would quote most of
-- a working day, which is the catering lead-time rule this model does not have
-- (P2). Same shape as the C-022 menu CHECKs.
ALTER TABLE "MenuItem"
  ADD CONSTRAINT menu_item_prep_weight_in_range
  CHECK ("prepWeight" BETWEEN 0 AND 50);

-- No upper bound on the order: it is a sum of already-bounded weights times
-- already-bounded quantities. Negative is the only impossible value, and it
-- would subtract work from the queue.
ALTER TABLE "Order"
  ADD CONSTRAINT order_prep_weight_not_negative
  CHECK ("prepWeight" >= 0);

-- --- The two settings that read the count now read the weight ----------------
--
-- RENAME rather than add-and-drop: it is the same setting with a new unit, and
-- a rename carries the existing value, the CHECK and the NOT NULL with it.
ALTER TABLE "RestaurantSettings" RENAME COLUMN "maxOpenOrders" TO "maxOpenWeight";
ALTER TABLE "RestaurantSettings" RENAME COLUMN "prepPerOrderMinutes" TO "prepPerWeightMinutes";

ALTER TABLE "RestaurantSettings"
  RENAME CONSTRAINT restaurant_settings_max_open_orders_positive
  TO restaurant_settings_max_open_weight_positive;
ALTER TABLE "RestaurantSettings"
  RENAME CONSTRAINT restaurant_settings_prep_per_order_in_range
  TO restaurant_settings_prep_per_weight_in_range;

-- The stored value is still counted in ORDERS at this point, so it is scaled
-- by what an order WEIGHS. The seeded rush measures 2.7 weight an order and
-- peaks at 47 open weight; 2.4 is deliberately under that, which lands the
-- converted threshold a little tighter than the count it replaces. Erring
-- toward pausing early is the safe direction for a kitchen, and the operator
-- screen (C-023) is where it gets tuned from here.
--
-- The factor is the same one the new column default comes from: 25 orders x
-- 2.4 = 60, so a restaurant that never changed the default lands exactly on
-- the new one and a restaurant that did keeps its own decision, converted.
UPDATE "RestaurantSettings" SET "maxOpenWeight" = ROUND("maxOpenWeight" * 2.4);

ALTER TABLE "RestaurantSettings" ALTER COLUMN "maxOpenWeight" SET DEFAULT 60;

-- `prepPerWeightMinutes` keeps its value and its 0..60 bound. The number did
-- not change; what it multiplies did, which is the whole point of the item —
-- a minute per unit of work instead of a minute per ticket.
