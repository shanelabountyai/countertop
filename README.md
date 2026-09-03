# Countertop

Pickup-only online ordering for a fast-casual restaurant (sample business:
"Firebird Kitchen"). Learning build #5. Start with `START-HERE.md`; the product
source of truth is `prd-countertop-restaurant-ordering.md`, and the working
conventions are in `CLAUDE.md`.

## Setup

```bash
npm install
createdb countertop_dev && createdb countertop_test   # or: docker compose up -d
cp .env.example .env.local                            # DATABASE_URL/DIRECT_URL + STAFF_PASSCODE
npm run db:migrate:all
```

`.env.test` overrides only the database and inherits the rest from `.env.local`
(`dotenv -e .env.test -e .env.local`, first file wins) — with one exception:
`.env.test` needs its own `STAFF_PASSCODE`, because the e2e sweep signs into
`/kitchen` with it.

`STAFF_PASSCODE` gates every `/kitchen` screen (C-037). **Unset means locked,
not open**: with no value the kitchen refuses everyone and the login page says
so. Rotating it signs every device out.

## Running

```bash
npm run dev          # http://localhost:3400
npm run demo:rush    # the seeded rush, then open /kitchen/report
```

`demo:rush` RESETS the dev database and replays thirty orders through twenty
minutes of service, ugly cases included — a mid-rush 86, a wrong advance and
its undo, a no-show, a double-submit, and orders arriving while paused. It
finishes with every order in a terminal state, so the payoff screen is
`/kitchen/report`, not the queue.

**This repo owns port 3400** (storage 3000, rental 3100, bookable 3300). It is
the default in `apps/web/package.json` and `playwright.config.ts`, not an
environment variable — a forgotten `PORT=` must not be able to hijack a
neighbouring project's server.

## Data retention

A customer's name, phone and notes are removed from orders past
`RestaurantSettings.retentionDays` (default 365) by `npm run db:retention`, and
from one order on demand from the staff receipt. The same command deletes
loyalty members past that window and expires balances past
`loyaltyExpiryDays` — a CHECK holds the second window inside the first. The
procedure, what the windows are for, and what a forget deliberately does not
do: **[docs/RETENTION.md](docs/RETENTION.md)**.

## The gate

Nothing is done until all four pass:

```bash
npm run gate    # lint, typecheck, build, e2e, unit — in that order
```

e2e runs against a production build; `E2E_DEV=1 npm run test:e2e` restores the
dev server for stack traces when debugging a single spec.

## Layout

| Path | What lives there |
|---|---|
| `apps/web` | Next.js App Router — customer ordering, kitchen queue, manager screens |
| `packages/core` | The domain engine: pure functions, no database, no clock |
| `packages/db` | Prisma schema and hand-written migrations |
| `docs/` | `backlog.md`, `PROGRESS.md`, `RELEASE_NOTES.md`, `WRITEUP.md` |
