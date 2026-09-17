-- ---------------------------------------------------------------------------
-- C-134: PRD 4's last open question, resolved per-batch.
--
-- One row per `setAvailability` call, never one per item or option it flipped
-- — a bulk 86 of six rows is one line on the report, the shape a human
-- actually wants to read back, per the PRD's own builder note. `setAvailability`
-- becomes the ONLY writer of `MenuItem.available` / `ModifierOption.available`:
-- the two single-tap board actions (`setItemAvailable`/`setOptionAvailable`)
-- now route through it too, so the log cannot miss the more common case
-- (single taps) the way a bulk-only log would have.
--
-- `items`/`options` are `{id, name}` pairs snapshotted at write time, JSONB —
-- the same reason a placed order copies a name instead of joining back to a
-- live menu row: a later rename must not rewrite what a cook read on the
-- board that day. This is a log, not the order snapshot, so it is JSONB and
-- not four columns of copied fields; nothing here is money or a receipt.
--
-- Append-only, same trigger shape as `OrderEvent` (20260825210943_init):
-- UPDATE and DELETE raise, TRUNCATE stays legal for the test suite's resets.
-- ---------------------------------------------------------------------------

CREATE TABLE "MenuChangeEvent" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "available" BOOLEAN NOT NULL,
    "actor" "EventActor" NOT NULL,
    "staffId" TEXT,
    "items" JSONB NOT NULL,
    "options" JSONB NOT NULL,

    CONSTRAINT "MenuChangeEvent_pkey" PRIMARY KEY ("id")
);

-- RESTRICT, like every other attribution FK: a name outlives the rows it is
-- on, and deactivation (never deletion) is how a staff member leaves.
ALTER TABLE "MenuChangeEvent"
  ADD CONSTRAINT "MenuChangeEvent_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "MenuChangeEvent_staffId_idx" ON "MenuChangeEvent"("staffId");

-- The report reads most-recent-first; nothing else queries this table.
CREATE INDEX "MenuChangeEvent_at_idx" ON "MenuChangeEvent"("at");

-- Undo is the existing "flip it back" action, which writes its OWN new event
-- naming what it restored — never an edit of what already happened.
CREATE OR REPLACE FUNCTION menu_change_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'MenuChangeEvent is append-only: % is not permitted (event %). Write a new event instead.',
    TG_OP, OLD."id";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER menu_change_event_append_only
  BEFORE UPDATE OR DELETE ON "MenuChangeEvent"
  FOR EACH ROW EXECUTE FUNCTION menu_change_event_append_only();
