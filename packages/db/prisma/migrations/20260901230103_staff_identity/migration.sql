-- ---------------------------------------------------------------------------
-- PRD 6 P0-2 (C-086): a name on the row.
--
-- Every staff-written event since C-004 says `actor: 'staff'` and nothing
-- else. The append-only log can say a revert happened and cannot say who did
-- it, and since C-038 it guards a cash button. This is the one thing in the
-- second-pass set that CANNOT be retrofitted — the 2026-09-01 decision #3 put
-- it ahead of the money PRD for exactly that reason: every event written
-- anonymous meanwhile is anonymous permanently.
--
-- HAND-WRITTEN for the CHECKs and for this comment. Deliberately NOT a
-- backfill: existing rows keep a NULL `staffId`, which reads as "we did not
-- record this". Assigning them to anybody — the first staff member, the owner,
-- a synthetic "legacy" row — would put a person's name on writes they may
-- never have made, and a log that lies once is a log nobody can cite.
--
-- NOT an accounts table. No roles, no permissions, no per-person login: the
-- shared passcode (C-037) remains the only authentication boundary and
-- everyone behind it still sees the same buttons.
-- ---------------------------------------------------------------------------

CREATE TABLE "StaffMember" (
    "id" TEXT NOT NULL,
    "name" VARCHAR(40) NOT NULL,
    "pinDigest" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "StaffMember_pkey" PRIMARY KEY ("id")
);

-- Unique because two people called Sam is a naming problem for the restaurant
-- to solve at the point of hiring, not an ambiguity a permanent log should
-- carry. The same reason the order number is unique per business day.
CREATE UNIQUE INDEX "StaffMember_name_key" ON "StaffMember"("name");

-- Unique because two people who pick the same four digits make every event
-- either of them writes ambiguous, and the lookup that resolves a PIN to a
-- person would have to pick one. The CONSTRAINT is the mechanism: a second
-- person cannot be given 1234 by mistake.
CREATE UNIQUE INDEX "StaffMember_pinDigest_key" ON "StaffMember"("pinDigest");

-- A blank name puts an empty string on a ticket, which reads as unattributed
-- while being the opposite. Same shape as the C-022 menu CHECKs.
ALTER TABLE "StaffMember"
  ADD CONSTRAINT staff_member_name_not_blank
  CHECK (btrim("name") <> '');

-- The column holds a hex SHA-256 and nothing else. This is the constraint that
-- stops a future writer storing the PIN itself here "just for now" — four
-- digits would pass any length check and fail this one.
--
-- It is worth being precise about what the digest buys, because it is less
-- than it looks: a four-digit PIN has 10,000 possibilities and the salt is a
-- constant, so anyone holding this table can recover every PIN. That is
-- acceptable ONLY because the PIN is a stamp and not a credential — the
-- passcode is the boundary, whoever can type a PIN is already inside it, and
-- anyone with this table already has every order. The hash keeps the digits
-- out of a casual `SELECT *` and out of backups; it is not a defence.
ALTER TABLE "StaffMember"
  ADD CONSTRAINT staff_member_pin_digest_is_sha256_hex
  CHECK ("pinDigest" ~ '^[0-9a-f]{64}$');

-- --- The name on the row ----------------------------------------------------
--
-- `actor` is untouched and keeps its meaning: it says what KIND of actor wrote
-- the event. This says WHICH ONE. Two columns, two questions, neither
-- replacing the other — a `customer` or `system` event has no staff id by
-- construction, and a `staff` event written before today has none by history.
ALTER TABLE "OrderEvent" ADD COLUMN "staffId" TEXT;

-- RESTRICT, like the analytics FKs on the order snapshot: attribution must not
-- disappear because somebody tidied up a staff list. Deactivation is how a
-- person leaves; deletion is refused while any row still names them.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Postgres does not index a foreign key for you, and RESTRICT has to scan this
-- column on every attempted delete. It is also the column "what did Sam do on
-- Friday?" reads, which is the question the item exists to make answerable.
CREATE INDEX "OrderEvent_staffId_idx" ON "OrderEvent"("staffId");
