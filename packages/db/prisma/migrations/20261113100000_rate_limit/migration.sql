-- ---------------------------------------------------------------------------
-- Scorecard K5 / SEC-02: a shared store for rate limits on the public writes
-- (kitchen passcode, checkout verification, placement, status-link reads).
-- Fixed windows, one row per (key, window), incremented by an atomic upsert
-- in `packages/db/rate-limit.ts`. No trigger, no CHECK: exactly what
-- schema.prisma declares, so the drift check sees it whole.
-- ---------------------------------------------------------------------------

CREATE TABLE "RateLimit" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("key","windowStart")
);
