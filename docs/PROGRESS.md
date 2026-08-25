# Progress Log — Countertop

Mechanical build log, one entry per backlog item: what it built, what it
decided, what it left behind. Pair with `docs/RELEASE_NOTES.md` for the
portfolio-facing version of the same history.

---

## C-001 — Monorepo scaffold, CI, and the four docs

**Built:**
- `apps/web`: Next.js 16 (App Router) + TypeScript + Tailwind v4 via `create-next-app`. **Port 3400 is baked into the `dev`/`start` scripts and into `playwright.config.ts`'s default** — never passed as `PORT=` on the command line. Two projects both defaulting to the same port fail silently, because Playwright's `reuseExistingServer` adopts whatever is already listening and the suite then tests the wrong app.
- `packages/core`: `package.json` + an empty `index.ts` naming which session fills it, and one scaffold test so the two CI timezone passes run a real suite rather than reporting green on zero tests.
- `packages/db`: Prisma client singleton, `schema.prisma` with datasource + generator only — no models. The header carries the rules C-003 has to obey (snapshot columns, integer cents, the two unique constraints, `@db.Timestamptz(3)`, never `db push`) so the schema session opens with them in front of it.
- ESLint: `eslint-rules/no-time-axis.mjs` exports two rule sets. `noTimeAxisRules` (the five CLAUDE.md bans — `new Date(string)`, `Date.parse`, `get/set*`, `getTimezoneOffset`, `toISOString().slice(0,10)`) applies to `packages/**` **and** `apps/web`. `noClockReadRules` adds a `packages/core`-only ban on `Date.now()` and bare `new Date()`, which is CLAUDE.md's "nothing in `packages/core` reads the system clock" made mechanical instead of remembered.
- Playwright + `@axe-core/playwright`, `workers: 1`, production build by default (`e2e:server` = build + start), `E2E_DEV=1` as the escape hatch. Two smoke specs: the app serves on 3400, and the landing page has zero axe violations at WCAG 2.1 AA.
- `.github/workflows/ci.yml`: throwaway Postgres, `prisma migrate deploy` from scratch, `prisma migrate diff --exit-code` drift check, an assertion that the gitignored Prisma client actually got generated, the unit suite twice (`TZ=UTC` and `TZ=Pacific/Kiritimati`), then the e2e leg on 3400.
- Local databases `countertop_dev` / `countertop_test` on the brew-managed Postgres cluster, with `.env.local` / `.env.test` (both gitignored) wired through the `dotenv -e .env.test -e .env.local` first-file-wins pattern.
- `docs/`: this file, `RELEASE_NOTES.md`, `WRITEUP.md`, and `backlog.md` (C-001 → C-017, derived from the PRD's four phases).

**Decided:**
- **Local dev uses the existing brew-managed Postgres, not `docker-compose.yml`.** Docker isn't installed on this machine and the sibling projects (`bookable_test`, `rental_test`, `storage_test`) already share this cluster. The compose file is committed anyway — it costs ten lines, it maps to what CI's service container provides, and it publishes on 5435 to stay clear of Bookable's 5434. Nothing downstream cares which one produced the `DATABASE_URL`.
- **The clock-read ban is scoped to `packages/core`, not repo-wide.** `apps/web` legitimately needs the current instant at the request boundary — that's the value it passes *into* the engine as `now`. Banning it everywhere would just produce a repo full of eslint-disable comments, which is a ban nobody reads.
- **The `deepmerge-ts` high-severity advisory is accepted, not fixed.** It reaches us only as a transitive dependency of the Prisma **CLI** (`prisma` → `@prisma/config` → `deepmerge-ts`), the vulnerability is stack exhaustion when merging recursive object graphs, and the only graph it merges here is our own committed config. `npm audit fix` cannot resolve it without a Prisma release. Recorded in `docs/WRITEUP.md`; revisit when Prisma bumps.
- **Verified rather than assumed, both in this repo's installed versions:** `dotenv-cli` tolerates a missing `-e` file (CI has neither `.env.test` nor `.env.local`, so the workflow's `env:` block is what applies), and the **first** `-e` file wins on conflict (which is what lets `.env.test` override only the database while inheriting everything else from `.env.local`).

**Left behind:**
- **No shadcn.** `create-next-app` gave Tailwind v4; `components.json` and the first component get pulled in C-007, when there is a screen that needs one. Installing a component library before any UI exists is inventory, not progress.
- **The drift check currently checks nothing** — there are no models and no migrations. It starts doing real work the moment C-003 writes the first migration, which is exactly when it matters.
- **No seed script.** `db:reset:test` recreates and migrates but does not seed; the `db:seed:*` scripts land with C-003's fixtures. CLAUDE.md's warning stands for later sessions: migrations applied with zero rows is a green `db:status` and a red sweep.
- **`e2e:server` rebuilds on every sweep** (~10s here, and it is what stops a stale `.next` testing yesterday's code). If the build cost becomes annoying once there are real screens, that is a trade to revisit, not a default to change.

C-001 committed and pushed at 5e9979b
