# Next

**Countertop is closed (decided 2026-09-21).** The C-164 closure deliverables are
shipped (URLs are in `docs/RELEASE_NOTES.md` → C-164), production is migrated, and
nothing is queued. Work moved to another project.

If you reopen this repo, the only work left is the master PRD's P2 list. Each
item needs a scoping decision before it starts.

**Before any demo:** `npm run demo:rush:live`, then `npm run dev:demo`, then
`npm run smoke:demo`. **After any push that adds a migration:** run
`npm run db:status:prod`, then migrate, or the live site breaks.
