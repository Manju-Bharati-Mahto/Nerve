#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Nerve, local, with no Docker.
#
# The sibling script dev-local.sh brings PostgreSQL up in Docker. This one is
# for a machine that already runs PostgreSQL natively (Homebrew, Postgres.app)
# — it uses the database that is already there and starts nothing it does not
# have to.
#
# It also checks the things that actually go wrong, and says which one did,
# rather than letting a process fail three layers down:
#
#   .env.local present · PostgreSQL reachable · ports free · engine optional
#
# The AI engine is deliberately OPTIONAL. Nerve runs fine without one; the
# assistant reports "not configured" and every dashboard, brief and automation
# still works, because none of them asks a model for a number.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.local}"
API_PID=""
WEB_PID=""

cleanup() {
  local code=$?
  trap - EXIT INT TERM
  for pid in "$WEB_PID" "$API_PID"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  wait "$WEB_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  exit "$code"
}

die() { echo "  ✗ $1" >&2; [ $# -gt 1 ] && echo "    $2" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "No $ENV_FILE" \
  "Copy .env.local.example to .env.local and fill in the secrets."

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

API_PORT="${API_PORT:-3001}"
WEB_PORT=8080

echo "Nerve — local development"
echo

# ── PostgreSQL ───────────────────────────────────────────────────────────────
DB_HOST="$(printf '%s' "${DATABASE_URL:-}" | sed -nE 's#.*@([^:/]+).*#\1#p')"
DB_PORT="$(printf '%s' "${DATABASE_URL:-}" | sed -nE 's#.*@[^:]+:([0-9]+).*#\1#p')"
DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-5432}"

if ! nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
  die "PostgreSQL is not answering on $DB_HOST:$DB_PORT" \
      "Start it with:  brew services start postgresql@17"
fi
echo "  ✓ PostgreSQL on $DB_HOST:$DB_PORT"

# ── Ports ────────────────────────────────────────────────────────────────────
for port in "$API_PORT" "$WEB_PORT"; do
  if nc -z 127.0.0.1 "$port" 2>/dev/null; then
    die "Port $port is already in use" \
        "Another Nerve is probably running:  lsof -ti:$port | xargs kill"
  fi
done
echo "  ✓ Ports $API_PORT and $WEB_PORT are free"

# ── The AI engine, if there is one ───────────────────────────────────────────
if [ -n "${AI_BASE_URL:-}" ]; then
  AI_HOST="$(printf '%s' "$AI_BASE_URL" | sed -nE 's#https?://([^:/]+).*#\1#p')"
  AI_PORT="$(printf '%s' "$AI_BASE_URL" | sed -nE 's#https?://[^:]+:([0-9]+).*#\1#p')"
  if [ -n "$AI_PORT" ] && ! nc -z "$AI_HOST" "$AI_PORT" 2>/dev/null; then
    echo "  ! AI engine not answering at $AI_BASE_URL"
    echo "    The assistant will report 'not configured'. Everything else works."
    echo "    Start it with:  ollama serve"
  else
    echo "  ✓ AI engine at $AI_BASE_URL (${AI_MODEL:-no model set})"
  fi
else
  echo "  · No AI engine configured — the assistant is off, the rest is unaffected."
fi

trap cleanup EXIT INT TERM
echo

( cd "$ROOT_DIR" && npm run dev:server ) & API_PID=$!
( cd "$ROOT_DIR" && npm run dev )        & WEB_PID=$!

echo
echo "  App    http://127.0.0.1:$WEB_PORT"
echo "  API    http://127.0.0.1:$API_PORT"
echo "  Login  ${SUPER_ADMIN_EMAIL:-super@parul.ac.in}  (SUPER_ADMIN_PASSWORD in .env.local)"
echo
echo "  Ctrl-C stops both."

# macOS ships bash 3.2, which has no `wait -n`.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 1
done
