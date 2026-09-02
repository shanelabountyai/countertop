-- C-091 — PRD 6 P0-4: the retention window.
--
-- One column and one CHECK. The JOB that reads it is `packages/db/retention.ts`
-- and the procedure for running it is `docs/RETENTION.md`, because an
-- undocumented capability is one nobody uses when the email arrives.
--
-- 365 by default, which is decision 10 of 2026-09-02 read the other way round:
-- loyalty points expire after 365 days of inactivity, so the purchase history
-- behind them has to outlive that. Nothing else in this product needs a named
-- person's history for a year, and the write-up says so.
ALTER TABLE "RestaurantSettings"
  ADD COLUMN "retentionDays" INTEGER NOT NULL DEFAULT 365;

-- A zero or negative window would forget every order the instant it is placed,
-- including the one on the pass. The CHECK is the mechanism; there is no
-- settings control that can produce one, and that is exactly why it is here —
-- the control is the part that changes.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT retention_days_positive CHECK ("retentionDays" > 0);

-- DELIBERATELY NOT HERE: the `loyaltyExpiryDays <= retentionDays` CHECK from
-- PRD 7 P0-5. Both columns now exist, so it is finally possible — but it is
-- C-105's, landing with the expiry sweep that gives it something to protect.
-- Adding it here would tie the two settings together before either the sweep
-- or its test exists to prove the tie means anything.
