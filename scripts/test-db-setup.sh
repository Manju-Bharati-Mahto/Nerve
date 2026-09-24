#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# Create (or recreate) the dedicated test database, and write .env.test.
#
# Tests used to run against the developer's own `nerve` database because the
# configured test database had never been created. This script makes that
# database a one-command, repeatable thing rather than a piece of tribal
# knowledge — and it NEVER touches the development database.
#
#   npm run test:db:setup          create the test DB if it is missing
#   npm run test:db:reset          drop and recreate it from scratch
#
# Connection details are taken from .env.local's DATABASE_URL (host, port and
# credentials only) so this works against whatever Postgres the developer
# already runs — a local install, Docker, Postgres.app. Only the database NAME
# is changed.
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail
cd "$(dirname "$0")/.."

TEST_DB_NAME="${TEST_DB_NAME:-nerve_test}"
RESET="${1:-}"

# ── Safety: the name must say it is a test database ────────────────────────
case "${TEST_DB_NAME}" in
  *test*) ;;
  *) echo "✗ Refusing: TEST_DB_NAME='${TEST_DB_NAME}' does not contain 'test'." >&2; exit 1 ;;
esac

if [ ! -f .env.local ]; then
  echo "✗ .env.local not found — it supplies the Postgres host and credentials." >&2
  exit 1
fi

DEV_URL="$(grep -E '^[[:space:]]*DATABASE_URL[[:space:]]*=' .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"' ' || true)"
if [ -z "${DEV_URL}" ]; then
  echo "✗ No DATABASE_URL in .env.local." >&2
  exit 1
fi

# Swap only the database name; keep scheme, credentials, host, port and query.
BASE="${DEV_URL%/*}"                       # everything up to the last '/'
DEV_DB="${DEV_URL##*/}"; DEV_DB="${DEV_DB%%\?*}"
QUERY=""
case "${DEV_URL}" in *\?*) QUERY="?${DEV_URL#*\?}" ;; esac
TEST_URL="${BASE}/${TEST_DB_NAME}${QUERY}"
ADMIN_URL="${BASE}/postgres${QUERY}"

if [ "${DEV_DB}" = "${TEST_DB_NAME}" ]; then
  echo "✗ Refusing: the development database is already called '${TEST_DB_NAME}'." >&2
  echo "  Set TEST_DB_NAME to something else, or rename the development database." >&2
  exit 1
fi

redact() { printf '%s' "$1" | sed -E 's#//[^@/]*@#//<redacted>@#'; }
echo "  development : $(redact "${DEV_URL}")   ← never modified by this script"
echo "  test        : $(redact "${TEST_URL}")"
echo

psql_admin() { psql "${ADMIN_URL}" -v ON_ERROR_STOP=1 -q -t -A -c "$1"; }

if ! command -v psql >/dev/null 2>&1; then
  echo "✗ psql is not on PATH." >&2
  echo "  Install the Postgres client tools, or create the database by hand:" >&2
  echo "    CREATE DATABASE ${TEST_DB_NAME};" >&2
  exit 1
fi

if [ "${RESET}" = "--reset" ]; then
  echo "→ Dropping ${TEST_DB_NAME}…"
  psql_admin "DROP DATABASE IF EXISTS \"${TEST_DB_NAME}\" WITH (FORCE)" >/dev/null
fi

EXISTS="$(psql_admin "SELECT 1 FROM pg_database WHERE datname='${TEST_DB_NAME}'" || true)"
if [ "${EXISTS}" = "1" ]; then
  echo "→ ${TEST_DB_NAME} already exists."
else
  echo "→ Creating ${TEST_DB_NAME}…"
  psql_admin "CREATE DATABASE \"${TEST_DB_NAME}\"" >/dev/null
fi

# btree_gist backs the no-double-booking EXCLUDE constraint on equipment
# bookings, and pgvector backs the AI layer. Both must exist in the test
# database too, or the schema bootstrap fails partway through.
for EXT in btree_gist vector; do
  if psql "${TEST_URL}" -v ON_ERROR_STOP=1 -q -c "CREATE EXTENSION IF NOT EXISTS ${EXT}" >/dev/null 2>&1; then
    echo "→ extension ${EXT} ready."
  else
    echo "  ! extension ${EXT} unavailable — suites that need it will fail." >&2
  fi
done

# ── .env.test — read by server/test-db.ts, never by the application ────────
if [ -f .env.test ] && [ "${RESET}" != "--reset" ]; then
  echo "→ .env.test already present, left alone."
else
  cat > .env.test <<EOF
# Written by scripts/test-db-setup.sh. Used ONLY by the test suite, via
# server/test-db.ts. The application never reads this file.
DATABASE_URL=${TEST_URL}
SESSION_SECRET=integration-test-secret
SUPER_ADMIN_PASSWORD=integration-test-password
EOF
  echo "→ wrote .env.test"
fi

# ── Schema ────────────────────────────────────────────────────────────────
echo "→ Applying the schema bootstrap to ${TEST_DB_NAME}…"
TEST_DATABASE_URL="${TEST_URL}" npx tsx scripts/test-db-migrate.ts

echo
echo "✓ Test database ready. 'npm test' will now use ${TEST_DB_NAME}."
