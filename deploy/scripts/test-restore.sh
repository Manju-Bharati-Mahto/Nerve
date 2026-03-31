#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/nerve/app}"
SHARED_ENV_FILE="${SHARED_ENV_FILE:-/srv/nerve/shared/env/.env}"
BACKUP_FILE="${1:-}"
TEST_DB="${TEST_DB:-nerve_restore_test}"

if [ -z "$BACKUP_FILE" ]; then
  echo "Usage: test-restore.sh /path/to/backup.sql.gz" >&2
  exit 1
fi

set -a
source "$SHARED_ENV_FILE"
set +a

docker compose --env-file "$SHARED_ENV_FILE" -f "$APP_ROOT/docker-compose.yml" exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $TEST_DB;"

docker compose --env-file "$SHARED_ENV_FILE" -f "$APP_ROOT/docker-compose.yml" exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "CREATE DATABASE $TEST_DB;"

gunzip -c "$BACKUP_FILE" | docker compose --env-file "$SHARED_ENV_FILE" -f "$APP_ROOT/docker-compose.yml" exec -T db \
  psql -U "$POSTGRES_USER" -d "$TEST_DB"

docker compose --env-file "$SHARED_ENV_FILE" -f "$APP_ROOT/docker-compose.yml" exec -T db \
  psql -U "$POSTGRES_USER" -d "$TEST_DB" -c "SELECT COUNT(*) AS users_count FROM users;"

docker compose --env-file "$SHARED_ENV_FILE" -f "$APP_ROOT/docker-compose.yml" exec -T db \
  psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS $TEST_DB;"

echo "Restore test succeeded using $BACKUP_FILE"
