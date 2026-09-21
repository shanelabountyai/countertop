-- ---------------------------------------------------------------------------
-- PRD 5 P1-3 (C-162): photos — `MenuItem.imageUrl`.
--
-- The asset story is the smallest honest one: the restaurant hosts its photos
-- (its website, its ordering-platform account, a bucket) and pastes the link.
-- No upload pipeline, no storage bill, no image processing in this product.
--
-- A LIVE-MENU field like `description`: rendered on `/menu` and in the
-- composer, and never copied into an order snapshot.
--
-- HTTPS ONLY, as a CHECK and not only in the form: a plain-http image on an
-- https page is mixed content the browser blocks, and a `javascript:` or
-- `data:` value is not a photo. The action refuses with a sentence first; this
-- is the backstop for any other writer.
-- ---------------------------------------------------------------------------
ALTER TABLE "MenuItem" ADD COLUMN "imageUrl" VARCHAR(500);

ALTER TABLE "MenuItem"
  ADD CONSTRAINT menu_item_image_https CHECK ("imageUrl" IS NULL OR "imageUrl" LIKE 'https://%');
