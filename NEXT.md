# Next

**This session (2026-09-21) shipped C-150 → C-163.** NEXT.md's whole
"Still open" list is now either built or closed with a reason (below). Checking
the PRDs against the backlog turned up eleven requirements that had never been
given a C-number (PRD 2 P0-7, PRD 3 P1-3, and nine P1s). All eleven are built.
Every PRD requirement is now either shipped or a named P2.

## Pick this up first

**Production is migrated and live (2026-09-21).** It had been serving 500s on
`/` and `/menu`: auto-deployed code was running against a schema 36 migrations
behind. `db:migrate:prod` applied all 36, `db:status:prod` reports up to date,
and `smoke:prod` passes 8/8. The account is in `docs/WRITEUP.md` → "The live
demo that was down for three weeks". **After any push that adds a migration,
run `npm run db:status:prod` and migrate**, or the live site breaks again.

Nothing is queued. The only remaining product work is the master
PRD's P2 list (WebSocket transport, a real payment provider, combos/nested
modifiers, reorder, tips, station routing, printer/KDS, real SMS, multi-location).
Each is its own session and needs a scoping decision before it starts.

## Read this before the next push

- **`npm run gate` is a manual discipline** (C-125). Anything touching code
  needs the full gate run before push.
- **Run `npm test` (the WHOLE unit suite), not only `packages/core`, before
  the gate.** C-157 broke a `packages/db` `toEqual` that the core run cannot
  see (C-154–159's first gate).
- **Before any e2e sweep, both kill lines** (C-128's incident):
  ```sh
  pkill -9 -f "$PWD.*playwright"
  lsof -ti :3400 | xargs -r kill -9
  ```
  Never `pkill -f 'node \(vitest'`: it matches every project's unit runs.
- **A local drift check needs a SCRATCH shadow database.**
  `prisma migrate diff --shadow-database-url` DROPS that database; pointed at
  `countertop_test` it wiped it (C-156). `createdb countertop_shadow`, use
  it, `dropdb` it.
- **The report page's source is scanned for `loyalt`** by P0-6's static test
  (`packages/db/report.test.ts`). A comment counts (C-153).
- **The Playwright web server runs with `STAFF_PASSCODE_PREVIOUS`** set to
  `ROTATED_OUT_PASSCODE` (C-158). A dev server you started yourself does not,
  so `auth.spec`'s rotation test fails against it. Let Playwright start it.
- **`npm run test:e2e -- --grep X` does NOT filter** (C-147). To run one spec,
  `cd apps/web` and call Playwright with the
  `dotenv -e ../../.env.test -e ../../.env.local --` prefix.
- **A hand-written migration's index needs a matching `@@index`/`@unique` in
  `schema.prisma`**, or CI's drift check fails.
- **Run `npm run db:migrate:all` after adding a migration**, before tests.
- **Never run `prettier --write`.**

## Closed this session without code, with the reason

- **Nothing bounds a staff `adjust` below zero.** Still no write path for an
  arbitrary `adjust`, and none was built. When the staff correction UI is
  scoped, use a `planStaffAdjustment` refusal, not a clamp.
- **`NotificationKind` has one value / nothing reads `queueReadyNotification`'s
  return / no append-only trigger on `NotificationOutbox`.** Seams waiting on
  a product decision (a second kind, a real SMS provider).
- **A customer who abandons a checkout and comes back verifies again.** C-116's
  binding working as designed: the token belongs to one attempt.
- **`Order.discountCents` has exactly one producer.** Still true, and C-152
  showed it is correct: a counter redemption is an `adjustment` beside the
  order, never a snapshot column.
- **No deadlock is constructible on the member lock.** The argument stands,
  and the rush now takes that lock three ways.
- **`MAX_STAGE_ATTEMPTS` exhausted throws a raw `P2002`; the staged-price retry
  and the `PhoneVerification` sweep are not observable.** Deliberate, the same
  ceiling as the retention sweep (`docs/RETENTION.md`).
- **`done=off` survives a reload** — decided at C-109.
- **Twenty-two of twenty-five items have no description** — the restaurant's
  copy to write (C-080). The same goes for photos (C-162).
- **`refund_failed` rows accumulate uncapped** — each is a real attempt in an
  append-only log.
- **Same-day only for order-ahead** — a P2.
