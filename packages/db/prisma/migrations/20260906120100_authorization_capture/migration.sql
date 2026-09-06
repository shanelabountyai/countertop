-- ---------------------------------------------------------------------------
-- PRD 3 P1-1 (C-069): auth at placement, capture at pickup.
--
-- The pickup-shaped answer to a no-show. Until now a `paidNow` checkout wrote
-- a `payment` — the restaurant held $34.20 of somebody's money before a
-- tortilla had been touched — so the customer stuck on the freeway cost a
-- REFUND: a provider call that can fail, an exceptions list, and a person
-- chasing it. A hold that was never captured costs a VOID, which cannot go
-- wrong in the customer's disfavour, because nothing left their card.
--
-- Two schema facts:
--
--   1. A SETTLEMENT POINTS AT ITS HOLD. Same shape as C-071's attempt -> request
--      link, and the hold's own row id is likewise the idempotency key the
--      provider is handed.
--
--   2. A HOLD HAS EXACTLY ONE EXIT, and the database is what says so. `picked_up`
--      is revertable on purpose — the fat-fingered advance needs its undo — so
--      "advance, undo, advance" is an ORDINARY sequence at a counter, and
--      without a constraint it charges the same card twice. A guard derived
--      from the log would work today and would be the same guard C-071 had to
--      replace: one whose premise silently widens. A UNIQUE index cannot be
--      talked out of it.
--
-- PLAIN UNIQUE, where the refund's had to be partial. A refund request may fail
-- many times and succeed once, so only the success is unique; a capture that
-- fails RELEASES the hold rather than retrying it, so there is nothing to leave
-- room for. Prisma can express a plain unique, so it is in the schema and
-- `prisma migrate diff` sees it — unlike the CHECK below.
--
-- HAND-WRITTEN for the CHECKs. No backfill: every order placed before this has
-- a `payment` or nothing, and inventing a hold behind a payment that already
-- happened would be a claim about a card nobody read.
-- ---------------------------------------------------------------------------

-- --- 1. The settlement -> authorization link --------------------------------
ALTER TABLE "OrderEvent" ADD COLUMN "authorizationId" TEXT;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT "OrderEvent_authorizationId_fkey"
  FOREIGN KEY ("authorizationId") REFERENCES "OrderEvent"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- One exit per hold. This is the guard, and it is also the index Postgres needs
-- for the `RESTRICT` scan above.
CREATE UNIQUE INDEX "OrderEvent_authorizationId_key" ON "OrderEvent"("authorizationId");

-- --- 2. Only a settlement may name a hold -----------------------------------
--
-- An EQUIVALENCE in both directions, unlike C-071's one-directional link: there
-- are no rows predating this column with a settlement in them to be lenient
-- about, so "a capture names a hold" can be enforced as well as "nothing else
-- claims to be one". A `transition` that slipped into this column would occupy
-- a hold's only exit and silently make it uncapturable.
ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_authorization_link_matches_kind
  CHECK (("kind" IN ('capture', 'authorization_voided')) = ("authorizationId" IS NOT NULL));

-- --- 3. The money-bearing kinds ---------------------------------------------
--
-- All three new kinds carry an amount, and only one of them moves money.
-- That is not a slip: `adjustment` set the precedent in C-065 — a decision
-- whose amount IS the whole of what it says. A hold's amount is what may still
-- be taken, and a void's is what was let go, and `paymentTotals` subtracts one
-- from the other to answer "is anything owed at the counter" by arithmetic
-- rather than by following the link. Making the void amount-free would have
-- forced every `MoneyEvent` select in the product to grow two columns.
ALTER TABLE "OrderEvent" DROP CONSTRAINT order_event_amount_matches_kind;

ALTER TABLE "OrderEvent"
  ADD CONSTRAINT order_event_amount_matches_kind
  CHECK (
    CASE
      WHEN "kind" = 'refund_requested' THEN TRUE
      ELSE ("kind" IN ('payment', 'refund', 'adjustment', 'adjustment_reversed',
                       'authorization', 'capture', 'authorization_voided'))
           = ("amountCents" IS NOT NULL)
    END
  );

-- The non-negative CHECK needs no change and deliberately gets none, for the
-- reason C-065's migration gave and C-071's repeated: direction is the KIND,
-- never the sign. A void is a positive number of cents subtracted from the held
-- figure by `paymentTotals`, and a negative one would be a second hold wearing
-- a release's name.
