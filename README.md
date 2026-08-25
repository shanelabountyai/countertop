# Countertop

Pickup-only online ordering for a fast-casual restaurant (sample business:
"Firebird Kitchen"). Learning build #5. Start with `START-HERE.md`; the product
source of truth is `prd-countertop-restaurant-ordering.md`, and the working
conventions are in `CLAUDE.md`.

## Setup

```bash
npm install
createdb countertop_dev && createdb countertop_test   # or: docker compose up -d
cp .env.example .env.local                            # then fill in DATABASE_URL/DIRECT_URL
npm run db:migrate:all
```

`.env.test` overrides only the database and inherits the rest from `.env.local`
(`dotenv -e .env.test -e .env.local`, first file wins).

## Running

```bash
npm run dev          # http://localhost:3400
```

**This repo owns port 3400** (storage 3000, rental 3100, bookable 3300). It is
the default in `apps/web/package.json` and `playwright.config.ts`, not an
environment variable — a forgotten `PORT=` must not be able to hijack a
neighbouring project's server.

## The gate

Nothing is done until all four pass:

```bash
npm run lint && npm run typecheck && npm test && PORT=3400 npm run test:e2e
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
