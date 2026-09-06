-- ---------------------------------------------------------------------------
-- PRD 3 P1-1 (C-069): the vocabulary for a hold.
--
-- `authorization` -> `capture` or `authorization_voided`, plus the
-- `PaymentState` value that says a card is held and nothing has been taken.
--
-- ITS OWN FILE, and not by preference — the same split C-065 and C-071 both
-- needed. Postgres refuses a new enum value used in the transaction that
-- created it, and the next migration's CHECK names all four of these.
-- ---------------------------------------------------------------------------
ALTER TYPE "OrderEventKind" ADD VALUE 'authorization';
ALTER TYPE "OrderEventKind" ADD VALUE 'capture';
ALTER TYPE "OrderEventKind" ADD VALUE 'authorization_voided';

ALTER TYPE "PaymentState" ADD VALUE 'authorized';
