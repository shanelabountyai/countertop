-- AlterTable
ALTER TABLE "RestaurantSettings" ADD COLUMN     "addressLine" VARCHAR(200),
ADD COLUMN     "name" VARCHAR(80),
ADD COLUMN     "phone" VARCHAR(40);

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here: the backfill, same shape as `item_station`.
--
-- Three nullable columns land NULL, and a deployed database's footer would
-- then render nothing at all until someone opened the settings screen — the
-- requirement not arriving, silently, on the only database anyone looks at.
--
-- Guarded on `name IS NULL`, so it fills a row that has never had contact
-- details and never overwrites one an operator has already typed into. On a
-- database with no singleton it matches nothing and is a no-op.
--
-- The values are the sample restaurant's, the same fiction as `SAMPLE_MENU`:
-- a real address would be somebody's actual building.
-- ---------------------------------------------------------------------------
UPDATE "RestaurantSettings"
   SET "name"        = 'Firebird Kitchen',
       "addressLine" = '1412 Junipero Ave, Long Beach, CA 90804',
       "phone"       = '(562) 555-0148'
 WHERE "id" = 'singleton' AND "name" IS NULL;
