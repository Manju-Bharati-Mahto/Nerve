#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/nerve/app}"
SHARED_ENV_FILE="${SHARED_ENV_FILE:-/srv/nerve/shared/env/.env}"
BACKUP_DIR="${BACKUP_DIR:-/srv/nerve/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

set -a
source "$SHARED_ENV_FILE"
set +a

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_DIR/nerve-$timestamp.sql.gz"

docker compose --env-file "$SHARED_ENV_FILE" -f "$APP_ROOT/docker-compose.yml" exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$backup_file"

find "$BACKUP_DIR" -type f -name 'nerve-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete

echo "Backup created: $backup_file"
