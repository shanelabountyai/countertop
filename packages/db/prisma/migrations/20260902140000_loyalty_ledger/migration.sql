-- ---------------------------------------------------------------------------
-- PRD 7 P0-1 and P0-2 (C-100): the loyalty ledger.
--
-- DECISION 8 of 2026-09-02: the master PRD's loyalty Non-Goal is LIFTED, by the
-- owner. `docs/prds/prd-loyalty.md`'s own recommendation was to shelve this;
-- that was read and overruled, which is the owner's call and not the builder's.
-- The Non-Goal's original reason survives as a BOUNDARY rather than a bar: the
-- program stops at one integer per member, and a second entitlement dimension
-- is where the fitness-studio lesson genuinely begins.
--
-- DECISION 9: 1 point per dollar of subtotal, 100 points, $10 off.
-- DECISION 10: 365 days of inactivity before expiry.
--
-- HAND-WRITTEN for the trigger, the four CHECKs and the partial unique index.
-- Every one of them is a mechanism the application code is then allowed to be
-- careless about, which is the discipline this repo applies to order numbers,
-- idempotency keys and money amounts.
-- ---------------------------------------------------------------------------

CREATE TYPE "LoyaltyEventKind" AS ENUM ('earn', 'redeem', 'adjust', 'expire');

-- --- The member -------------------------------------------------------------
--
-- A member is a PHONE NUMBER and nothing else: no account, no password, no
-- portal. The resolved tokenized-link decision is not re-opened.
--
-- THE PHONE IS NEVER STORED HERE. `phoneDigest` is an HMAC-SHA256 of the
-- normalised number under a pepper held in the ENVIRONMENT, not in this
-- database, so a dump of these tables does not hand anybody a customer list.
-- `Order.customerPhone` still holds the number in clear and is unchanged —
-- that is a different fact with a different retention story, and PRD 6's
-- forget path is what deletes it.
--
-- The pepper is an env secret where `StaffMember`'s PIN salt is a constant,
-- and the difference is deliberate: a four-digit PIN behind a shared passcode
-- is already only worth so much, while a ten-digit phone number has a small
-- enough keyspace that an unpeppered digest is decorative — anybody holding
-- the table could enumerate every number in the country in minutes.
CREATE TABLE "LoyaltyMember" (
  "id"             TEXT NOT NULL,
  "phoneDigest"    TEXT NOT NULL,
  -- In clear, for counter disambiguation: "the one ending 2233". Four digits
  -- is not an identifier, and staff need something a person can confirm out
  -- loud without reading their own number back to them.
  "phoneLast4"     VARCHAR(4) NOT NULL,
  -- Copied at enrolment, like every other snapshot in this codebase. A member
  -- who changes the name on a later order does not rewrite this one.
  "displayName"    VARCHAR(40) NOT NULL,
  "enrolledAt"     TIMESTAMPTZ(3) NOT NULL,
  -- What expiry is measured from (P0-5). Moved by an earn or a redeem, never
  -- by simply looking someone up.
  "lastActivityAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LoyaltyMember_pkey" PRIMARY KEY ("id")
);

-- One member per number. The digest is the identity; two spellings of the same
-- phone normalise to one digest and therefore to one member, which is P0-1's
-- test.
CREATE UNIQUE INDEX "LoyaltyMember_phoneDigest_key" ON "LoyaltyMember"("phoneDigest");

-- Exactly four digits, always. A partial write that left this empty or short
-- would give the counter a lookup that matches everybody, which is worse than
-- a lookup that matches nobody.
ALTER TABLE "LoyaltyMember"
  ADD CONSTRAINT loyalty_member_last4_is_four_digits
  CHECK ("phoneLast4" ~ '^[0-9]{4}$');

ALTER TABLE "LoyaltyMember"
  ADD CONSTRAINT loyalty_member_name_not_blank
  CHECK (length(btrim("displayName")) > 0);

-- --- The ledger -------------------------------------------------------------
CREATE TABLE "LoyaltyEvent" (
  "id"          TEXT NOT NULL,
  "memberId"    TEXT NOT NULL,
  -- Nullable: an `expire` is written by the system against no order at all.
  "orderId"     TEXT,
  "at"          TIMESTAMPTZ(3) NOT NULL,
  "kind"        "LoyaltyEventKind" NOT NULL,
  -- SIGNED here, unlike OrderEvent.amountCents. A ledger's direction is its
  -- sign because the balance is a plain sum and nothing else has to know the
  -- kinds; money's direction is its KIND because a balance that trusted a sign
  -- could not tell a refund from a negative payment.
  "points"      INTEGER NOT NULL,
  -- Only a redemption moves money, and the money itself lives on OrderEvent as
  -- an `adjustment`. This column is the ledger's own copy of what the reward
  -- was worth, so the two can be reconciled to the cent.
  "amountCents" INTEGER,
  "reason"      TEXT,
  "staffId"     TEXT,
  CONSTRAINT "LoyaltyEvent_pkey" PRIMARY KEY ("id")
);

-- The member's ledger dies WITH the member (P0-5). This is the one Cascade in
-- the model and it is the whole reason the forget path can be a real delete:
-- a loyalty balance is an entitlement held for the customer's benefit, not a
-- financial record, and refusing to delete it is exactly the behaviour the
-- forget path exists to prevent.
ALTER TABLE "LoyaltyEvent"
  ADD CONSTRAINT "LoyaltyEvent_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "LoyaltyMember"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- An order and a staff member OUTLIVE every ledger row that points at them.
-- The asymmetry with the Cascade above is the design, not an oversight.
ALTER TABLE "LoyaltyEvent"
  ADD CONSTRAINT "LoyaltyEvent_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LoyaltyEvent"
  ADD CONSTRAINT "LoyaltyEvent_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "StaffMember"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "LoyaltyEvent_memberId_at_idx" ON "LoyaltyEvent"("memberId", "at");
-- Postgres does not index a foreign key for you, and both Restricts scan on
-- every attempted delete.
CREATE INDEX "LoyaltyEvent_orderId_idx" ON "LoyaltyEvent"("orderId");
CREATE INDEX "LoyaltyEvent_staffId_idx" ON "LoyaltyEvent"("staffId");

-- The sign IS the kind, checked. Written as one CHECK over a CASE rather than
-- four, so a fifth kind cannot be added without this expression being edited —
-- the same reason C-063's money CHECK is an equivalence.
--
-- `ELSE false` IS THE HALF THAT MAKES THAT TRUE, and it is not decoration. A
-- CASE with no ELSE returns NULL for an unmatched kind, and a CHECK PASSES on
-- NULL — so without this line a fifth enum value would ship silently
-- unconstrained, which is the exact failure the one-expression form was chosen
-- to prevent. The constraint would read as enforced and would not be.
--
-- `adjust` is the only kind allowed either direction: a correction goes both
-- ways by definition. It may not be zero, because a zero adjustment is a row
-- that records a decision nobody made.
ALTER TABLE "LoyaltyEvent"
  ADD CONSTRAINT loyalty_event_sign_matches_kind
  CHECK (
    CASE "kind"
      WHEN 'earn'   THEN "points" > 0
      WHEN 'redeem' THEN "points" < 0
      WHEN 'expire' THEN "points" < 0
      WHEN 'adjust' THEN "points" <> 0
      ELSE false
    END
  );

-- Money on the ledger exactly where a reward was spent, and nowhere else.
-- Same equivalence shape as OrderEvent's.
ALTER TABLE "LoyaltyEvent"
  ADD CONSTRAINT loyalty_event_amount_matches_kind
  CHECK (("kind" = 'redeem') = ("amountCents" IS NOT NULL));

-- A reward's cash value is never negative. Direction is the POINTS column.
ALTER TABLE "LoyaltyEvent"
  ADD CONSTRAINT loyalty_event_amount_not_negative
  CHECK ("amountCents" IS NULL OR "amountCents" >= 0);

-- P0-3's WHOLE MECHANISM, landed here rather than with the earn that uses it.
-- The state machine permits reverts, so `ready -> picked_up` can happen twice
-- on one order; without this, the second advance earns the points again. The
-- constraint is the mechanism and the code path's care is UX — the same
-- sentence this repo has written about idempotency keys and order numbers.
CREATE UNIQUE INDEX "LoyaltyEvent_one_earn_per_order"
  ON "LoyaltyEvent"("orderId") WHERE "kind" = 'earn';

-- Append-only, the same shape `OrderEvent` has had since C-003. A mistaken
-- entry is contradicted by an `adjust`, never edited away.
--
-- NOTE the one deliberate difference from OrderEvent's: DELETE is permitted
-- here, because P0-5's forget path is a real delete and the Cascade above is
-- how it reaches these rows. Blocking DELETE would make "forget this customer"
-- either impossible or a lie. UPDATE is what the append-only rule is actually
-- about, and it is refused.
CREATE OR REPLACE FUNCTION loyalty_event_no_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LoyaltyEvent is append-only: % is not permitted (member %). Write an adjust event instead.',
    TG_OP, OLD."memberId";
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER loyalty_event_no_update
  BEFORE UPDATE ON "LoyaltyEvent"
  FOR EACH ROW EXECUTE FUNCTION loyalty_event_no_update();

-- --- The program's settings -------------------------------------------------
--
-- DEFAULT FALSE, and P0-1 makes that load-bearing: with the program off no
-- loyalty copy renders anywhere, no ledger row is written, and the seeded rush
-- passes unchanged. A feature that cannot be turned off has to be right the
-- first time.
ALTER TABLE "RestaurantSettings"
  ADD COLUMN "loyaltyEnabled"        BOOLEAN NOT NULL DEFAULT false,
  -- Decision 9. Editable, which is NOT the same as changeable: moving these
  -- once customers hold balances devalues those balances visibly, and that is
  -- the thing the PRD's open question existed to stop happening by accident.
  ADD COLUMN "pointsPerDollar"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "rewardThresholdPoints" INTEGER NOT NULL DEFAULT 100,
  ADD COLUMN "rewardValueCents"      INTEGER NOT NULL DEFAULT 1000,
  -- Decision 10. The `loyaltyExpiryDays <= retentionDays` CHECK that P0-5
  -- requires is NOT here: `retentionDays` does not exist yet and lands with
  -- PRD 6's forget item (C-091). Adding half of a constraint now would be a
  -- guarantee that reads as enforced and is not.
  ADD COLUMN "loyaltyExpiryDays"     INTEGER NOT NULL DEFAULT 365;

ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT loyalty_settings_positive
  CHECK (
    "pointsPerDollar" > 0
    AND "rewardThresholdPoints" > 0
    AND "rewardValueCents" > 0
    AND "loyaltyExpiryDays" > 0
  );
