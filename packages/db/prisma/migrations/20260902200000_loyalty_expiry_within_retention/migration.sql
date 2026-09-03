-- C-105 — PRD 7 P0-5: a program that cannot outlive the data behind it.
--
-- The CHECK C-091 deliberately did not write. Both columns existed the moment
-- `retentionDays` landed, and it was held back until this migration because a
-- constraint tying two settings together means nothing until there is a sweep
-- that acts on both — one that expires a balance, and one that deletes the
-- member holding it.
--
-- WHY IT IS A CONSTRAINT AND NOT A NOTE IN THE SETTINGS SCREEN: the failure it
-- prevents is silent and arrives a year later. `loyaltyExpiryDays` longer than
-- `retentionDays` is a punch card whose purchase history was destroyed while
-- the balance was still spendable — the customer's points are live and nothing
-- can explain where they came from. There is no screen for either value today,
-- which is exactly why the guard goes in now: the screen is the part that
-- changes, and it will be written against a database that already refuses.
--
-- Both are 365 today, on the default and on every seeded row, so this cannot
-- fail an existing database. It is written as if it might.
ALTER TABLE "RestaurantSettings"
  ADD CONSTRAINT loyalty_expiry_within_retention
  CHECK ("loyaltyExpiryDays" <= "retentionDays");

-- A window of zero days — which would expire every balance the instant it is
-- earned — is already refused by `loyalty_settings_positive` (C-100), so there
-- is no second guard here. One constraint per claim.
