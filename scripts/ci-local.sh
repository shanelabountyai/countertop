#!/bin/sh
# The half of CI a laptop gate cannot reach, run on the laptop anyway, because
# GitHub Actions is billing-blocked. Mirrors .github/workflows/ci.yml's
# database steps and its TZ double run — that file stays the original.
# Delete this the day CI runs again.
set -e

DB=countertop_ci
SHADOW=countertop_ci_shadow
PGUSER_=${PGUSER:-$(whoami)}
URL="postgresql://$PGUSER_@localhost:5432/$DB"
SHADOW_URL="postgresql://$PGUSER_@localhost:5432/$SHADOW"
SCHEMA=packages/db/prisma/schema.prisma

cleanup() { dropdb --if-exists "$DB" >/dev/null 2>&1 || true; dropdb --if-exists "$SHADOW" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "ci-local: building $DB from nothing"
cleanup
createdb "$DB"
createdb "$SHADOW"
DATABASE_URL="$URL" DIRECT_URL="$URL" npx prisma migrate deploy --schema "$SCHEMA"

echo "ci-local: asserting the hand-written invariants"
psql -d "$DB" -v ON_ERROR_STOP=1 -q <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='order_event_append_only') THEN
    RAISE EXCEPTION 'the OrderEvent append-only trigger is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='restaurant_settings_singleton') THEN
    RAISE EXCEPTION 'the RestaurantSettings singleton CHECK is missing';
  END IF;
  -- Prisma emits these as unique INDEXES, not table constraints: pg_class, not
  -- pg_constraint. Checking the wrong catalog is a green assertion that
  -- verifies nothing.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='Order_businessDay_seq_key') THEN
    RAISE EXCEPTION 'the (businessDay, seq) unique index is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname='Order_idempotencyKey_key') THEN
    RAISE EXCEPTION 'the idempotency key unique index is missing';
  END IF;
END $$;
EOSQL

echo "ci-local: drift check (schema.prisma vs migration history)"
npx prisma migrate diff \
  --from-migrations packages/db/prisma/migrations \
  --to-schema-datamodel "$SCHEMA" \
  --shadow-database-url "$SHADOW_URL" \
  --exit-code

echo "ci-local: unit suite under TZ=UTC"
TZ=UTC npm test --silent
echo "ci-local: unit suite under TZ=Pacific/Kiritimati"
TZ=Pacific/Kiritimati npm test --silent

echo "ci-local: OK"
