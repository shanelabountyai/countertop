-- ---------------------------------------------------------------------------
-- PRD 3 P0-3 (C-066): the remake link.
--
-- Decision 7 of 2026-09-02: a remake is a REAL SECOND ORDER — new
-- `(businessDay, seq)`, a real ticket that ages and advances — linked back to
-- the original, comped in full at creation, and skipped by the report.
--
-- The PRD asked the question and named the tension: "the kitchen needs a
-- ticket; the report needs a link". They do not pull evenly. Either shape
-- gives the report its number; only this one gives the kitchen something to
-- cook. A remake nobody is told to make is Bea remembering, which is the
-- transcription failure this product exists to kill.
--
-- ONE FILE, unlike C-065's pair. The rule that split those is that a value
-- added by `ALTER TYPE ... ADD VALUE` cannot be USED later in the same
-- transaction — and nothing here uses `remake`. Adding a column does not
-- reference the enum's values, and no CHECK names this kind: `remake` moves no
-- money, so it stays on the "must not carry an amount" side of
-- `order_event_amount_matches_kind` for free, with that constraint untouched.
-- ---------------------------------------------------------------------------
ALTER TYPE "OrderEventKind" ADD VALUE 'remake';

-- Which order this event points AT. One direction only: the remake's own event
-- names the original, and the original's receipt finds it by reverse lookup.
-- Recording it on both orders would be one fact stored twice, and two copies
-- of a fact are two things that can disagree.
ALTER TABLE "OrderEvent" ADD COLUMN "relatedOrderId" TEXT;

-- `Restrict`, like the analytics FKs and like `staffId`: the link between a
-- wrong order and its remake is the only record that either happened, and it
-- must not disappear because somebody tidied up an order.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_relatedOrderId_fkey"
  FOREIGN KEY ("relatedOrderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Postgres does not index a foreign key for you, and `Restrict` scans this
-- column on every attempted delete. It is also the reverse lookup the original
-- order's receipt does to find its own remake.
CREATE INDEX "OrderEvent_relatedOrderId_idx" ON "OrderEvent"("relatedOrderId");
