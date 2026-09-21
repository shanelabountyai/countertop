-- ---------------------------------------------------------------------------
-- PRD 6 P1-1 (C-161): an ordered, replayable event feed — `OrderEvent.seq`.
--
-- A monotonically increasing number per event, for a printer or KDS bridge to
-- read forward from. It does NOT replace `/api/updates`' cursor, which is a
-- change TIP ("has anything happened"); this is a position ("give me what
-- happened after N"). Two questions, two mechanisms.
--
-- BIGSERIAL on an existing table numbers the existing rows in whatever order
-- the rewrite visits them. That is not event order, and it does not need to
-- be: a consumer starts from 0 once and reads forward, and every event written
-- from now on is numbered as it is inserted. `feedPage` in packages/core
-- handles the one real hazard — a number taken but not yet committed.
--
-- The append-only trigger is BEFORE UPDATE OR DELETE on rows. ADD COLUMN with
-- a default rewrites the table without firing row triggers, so it does not
-- trip over it.
-- ---------------------------------------------------------------------------
ALTER TABLE "OrderEvent" ADD COLUMN "seq" BIGSERIAL NOT NULL;

CREATE UNIQUE INDEX "OrderEvent_seq_key" ON "OrderEvent"("seq");
