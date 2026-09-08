-- CreateEnum
CREATE TYPE "Station" AS ENUM ('fryer', 'grill', 'line', 'steam', 'drinks');

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN "station" "Station";

-- ---------------------------------------------------------------------------
-- HAND-WRITTEN from here: the backfill.
--
-- NO CHECK CONSTRAINT, deliberately. The invariant worth having is "an item
-- with prep weight has a station", and it cannot be added here without this
-- backfill being correct on every deployed database — which would make a data
-- migration load-bearing for a constraint whose only job is catching an
-- authoring mistake. Items are not authored through the editor (C-015); they
-- come from `SAMPLE_MENU`, where `sample-menu.test.ts` asserts the same rule
-- against the compiler's copy. When a station ever reaches the estimate, the
-- CHECK comes with it and this backfill will already have run.
--
-- Matched by the seeded slug ids. A database whose MenuItem ids are not these
-- slugs matches nothing and is left entirely alone — every station stays NULL,
-- the 86 board renders no station links, and nothing else in the app reads
-- this column. A no-op, never a wrong station.
-- ---------------------------------------------------------------------------

-- The station this feature exists for. Three categories, none of them wholly
-- fried — the evidence C-109 resolved the category grain against.
UPDATE "MenuItem" SET "station" = 'fryer'
  WHERE "id" IN ('chips', 'chips-guac', 'taquitos', 'nachos', 'churros');

UPDATE "MenuItem" SET "station" = 'grill'
  WHERE "id" IN ('taco-plate', 'enchilada-plate', 'fajita-plate', 'torta',
                 'quesadilla', 'breakfast-burrito', 'california-burrito');

UPDATE "MenuItem" SET "station" = 'line'
  WHERE "id" IN ('burrito', 'bowl', 'garden-bowl');

UPDATE "MenuItem" SET "station" = 'steam'
  WHERE "id" IN ('tamale-plate', 'rice-side', 'beans-side', 'elote');

UPDATE "MenuItem" SET "station" = 'drinks'
  WHERE "id" IN ('horchata', 'agua-fresca');

-- Left NULL on purpose: Mexican Coke, bottled water, tres leches and a paleta
-- are all prepWeight 0. Nobody makes them.
