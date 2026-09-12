-- ---------------------------------------------------------------------------
-- C-121: one notification per order per kind.
--
-- THE DEFECT. `queueReadyNotification` (P1-3, C-113) wrote a row on every
-- transition INTO `ready`, with nothing stopping a second one. The state
-- machine permits a revert, so a cook who advances the wrong card and undoes
-- it puts the ticket through `ready` twice — and the customer is queued the
-- identical "#010 is ready for pickup" twice, minutes apart, about one bag of
-- food. C-113 even had a passing test asserting two rows; it carried no
-- comment defending the behaviour, which in this repo is the tell.
--
-- Found by the seeded rush the session it first carried a phone number
-- (C-120), because `queueReadyNotification` is gated on one and nothing in
-- the rush had ever had one.
--
-- HAND-WRITTEN for the unique index and the backfill, per CLAUDE.md's rule
-- for any migration carrying a constraint.
-- ---------------------------------------------------------------------------

-- The enum. One value today; the column exists because it is half of the
-- index's grain, and `(orderId)` alone would have meant "tell this customer
-- once, ever, about anything" — closing a door two comments in this codebase
-- were already holding open.
CREATE TYPE "NotificationKind" AS ENUM ('ready');

-- Added nullable, backfilled, then made NOT NULL. Every row that predates
-- this column is a ready notification — it is the only kind the code has ever
-- written — so unlike C-117's `discountCents` there IS a true historical
-- value here, and it is knowable rather than merely defaultable.
ALTER TABLE "NotificationOutbox" ADD COLUMN "kind" "NotificationKind";
UPDATE "NotificationOutbox" SET "kind" = 'ready' WHERE "kind" IS NULL;
ALTER TABLE "NotificationOutbox" ALTER COLUMN "kind" SET NOT NULL;

-- DEDUPE BEFORE THE INDEX, or this migration fails on any database that has
-- already served a reverted ticket — which includes the deployed demo, and
-- would have included every developer's local database seeded from the rush.
--
-- KEEPS THE EARLIEST ROW, not the latest. The first text is the one the
-- customer actually received; deleting it and keeping the duplicate would
-- move the recorded instant forward and make the outbox disagree with what
-- was sent. `id` breaks a tie on identical `createdAt` so the result is
-- deterministic rather than whatever order the planner returns.
DELETE FROM "NotificationOutbox" a
  USING "NotificationOutbox" b
  WHERE a."orderId" = b."orderId"
    AND a."kind" = b."kind"
    AND (a."createdAt", a."id") > (b."createdAt", b."id");

-- THE MECHANISM. `queueReadyNotification` lands on this with `skipDuplicates`
-- — `ON CONFLICT DO NOTHING` — exactly as `earnForOrder` lands on
-- `LoyaltyEvent_one_earn_per_order`, and for the identical reason: the second
-- `ready` is a SUPPORTED operation, not an error, so the write has to be
-- refused silently rather than throw. A bare `create` against this index
-- would raise P2002 inside `applyOrderAction`'s transaction and roll the
-- STATUS CHANGE back — the cook's correct second advance would fail because
-- of a text message.
CREATE UNIQUE INDEX "NotificationOutbox_one_per_order_kind"
  ON "NotificationOutbox"("orderId", "kind");

-- The old plain index on `orderId` alone, dropped: the unique index above
-- LEADS with `orderId`, so every lookup by order still uses an index and the
-- second one was write cost with no reader. Prisma's own drift check is what
-- keeps this honest — the schema declares the unique index and nothing else,
-- so a re-added `@@index([orderId])` would show up as drift rather than
-- quietly costing every insert.
DROP INDEX IF EXISTS "NotificationOutbox_orderId_idx";
