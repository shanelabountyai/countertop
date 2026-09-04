-- Two more cancellation reasons (PRD 1 P0-6, C-057).
--
-- Hand-written, per CLAUDE.md: `ALTER TYPE ... ADD VALUE` is additive and must
-- stay that way. The generated alternative for an enum whose values are not
-- appended at the END is to DROP and re-create the type, which rewrites every
-- `cancelReason` on every order — a backfill of history, on the one column
-- this requirement says must not be reclassified.
--
-- `BEFORE 'other'` because the engine's `CANCEL_REASONS` reads in that order
-- and `snapshot.test.ts` compares the two by `enumsortorder`. It is also the
-- order the cancel buttons render in, and `other` belongs last on the screen.
--
-- One file, unlike C-065's pair: nothing here USES the new values in the same
-- transaction (no CHECK names them), which is the only thing Postgres refuses.
-- Existing rows keep the reason they were cancelled under; there is no UPDATE
-- in this file and there must never be one.
ALTER TYPE "CancelReason" ADD VALUE IF NOT EXISTS 'customer_changed_mind' BEFORE 'other';
ALTER TYPE "CancelReason" ADD VALUE IF NOT EXISTS 'kitchen_error' BEFORE 'other';
