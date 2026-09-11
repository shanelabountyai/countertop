-- ---------------------------------------------------------------------------
-- PRD 7 P1-1 (C-115): the phone-verification mechanism self-serve redemption
-- needs. C-113's SMS stub is one-way — an outbox row, no reply channel, no
-- code to confirm against. This table is the other half: a one-time code, a
-- short window, and a capped number of guesses, so a customer typing a phone
-- number at checkout can prove they control it with nobody at the counter to
-- catch a lie.
--
-- HAND-WRITTEN for the two CHECKs, matching this repo's rule for any
-- migration carrying a constraint.
-- ---------------------------------------------------------------------------

CREATE TABLE "PhoneVerification" (
  "id"          TEXT NOT NULL,
  -- The same HMAC digest `LoyaltyMember.phoneDigest` uses. Never the phone
  -- itself, for the identical reason that table states.
  "phoneDigest" TEXT NOT NULL,
  -- SHA-256 of the code, domain-separated by the digest. Not peppered like
  -- the phone digest — a code is random and single-use, not a value a
  -- customer chose and might reuse, so the threat this hash defends against
  -- is a casual read of the table, not someone who already holds it.
  "codeHash"    TEXT NOT NULL,
  "expiresAt"   TIMESTAMPTZ(3) NOT NULL,
  "attempts"    INTEGER NOT NULL DEFAULT 0,
  -- Null forever on a code nobody ever got right. Set once, on the
  -- confirmation that matched — there is no negative row.
  "consumedAt"  TIMESTAMPTZ(3),
  -- APP-SUPPLIED, no DEFAULT. `expiresAt` is computed from the caller's own
  -- `now`; a `createdAt` defaulted to the database server's clock is exactly
  -- the skew this project's time rules rule out, and it is what a
  -- frozen-`now` test caught: the CHECK below failed in real time even
  -- though every column the application wrote was consistent under a fixed
  -- `now`.
  "createdAt"   TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PhoneVerification_pkey" PRIMARY KEY ("id")
);

-- NOT a unique index on phoneDigest: a resend is a new row, on purpose.
-- Confirmation always reads the NEWEST row for a digest, so an old,
-- unconsumed code simply stops being the one anybody is compared against —
-- no separate "invalidate" write, no unique index to fight with a resend.
CREATE INDEX "PhoneVerification_phoneDigest_createdAt_idx"
  ON "PhoneVerification"("phoneDigest", "createdAt");

-- The attempt count is read by `packages/core`'s `canAttemptVerification`
-- before every comparison; it can only ever move up by one.
ALTER TABLE "PhoneVerification"
  ADD CONSTRAINT phone_verification_attempts_not_negative
  CHECK ("attempts" >= 0);

-- A code that is already expired the instant it is written is a clock bug,
-- not a real row — catch it at the constraint rather than in a support call
-- about a code that "never worked".
ALTER TABLE "PhoneVerification"
  ADD CONSTRAINT phone_verification_expires_after_created
  CHECK ("expiresAt" > "createdAt");
