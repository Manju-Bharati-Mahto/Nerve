#!/usr/bin/env bash
set -euo pipefail

# Adds the two public-portal proxy blocks to the LIVE nginx vhost.
#
# Why this exists instead of the `cp nginx/nerve.conf ...` line in DEPLOYMENT.md:
# the live vhost has diverged from the repo copy — it terminates TLS, speaks
# HTTP/2 and sets HSTS/CSP, none of which are in nginx/nerve.conf. Copying the
# repo file over it would drop TLS and take the site down. So this patches the
# live file in place, surgically and idempotently, and rolls back if nginx
# rejects the result.

CONF="${CONF:-}"
BACKUP_DIR="${BACKUP_DIR:-/srv/nerve/backups/nginx}"

fail() { echo "  ✗ $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run as root (nginx config + reload need it)"

# ── locate the live vhost ─────────────────────────────────────────────────
if [ -z "$CONF" ]; then
  for c in /etc/nginx/sites-enabled/nerve /etc/nginx/conf.d/nerve.conf; do
    [ -f "$c" ] && { CONF=$(readlink -f "$c"); break; }
  done
fi
[ -n "$CONF" ] && [ -f "$CONF" ] || fail "could not find the vhost; pass CONF=/path/to/conf"
echo "  vhost: $CONF"

# ── already patched? ──────────────────────────────────────────────────────
if grep -qE '^\s*location\s+/casting/\s*\{' "$CONF" && grep -qE '^\s*location\s+/request/\s*\{' "$CONF"; then
  echo "  ✓ portal blocks already present — nothing to do"
  exit 0
fi

# ── the SPA fallback is our anchor; we must sit strictly before it ────────
ANCHORS=$(grep -cE '^\s*location\s+/\s*\{' "$CONF" || true)
[ "$ANCHORS" = 1 ] || fail "expected exactly one 'location / {', found $ANCHORS — patch by hand, see the block printed by: grep -n 'location' $CONF"

# ── back up before touching anything ──────────────────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$BACKUP_DIR/$(basename "$CONF").$STAMP.bak"
cp -a "$CONF" "$BACKUP"
echo "  backup: $BACKUP"

# ── insert ────────────────────────────────────────────────────────────────
TMP=$(mktemp)
awk '
  /^[[:space:]]*location[[:space:]]+\/[[:space:]]*\{/ && !done {
    print "    # ── Public external portals (casting registration, media request intake) ──"
    print "    # Standalone pages served by the API container, NOT part of the React SPA"
    print "    # bundle. Without these the paths fall through to the SPA fallback below,"
    print "    # React Router matches nothing and renders its own 404."
    print "    location /casting/ {"
    print "        proxy_pass         http://127.0.0.1:3001;"
    print "        proxy_http_version 1.1;"
    print "        proxy_set_header   Host              $host;"
    print "        proxy_set_header   X-Real-IP         $remote_addr;"
    print "        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;"
    print "        proxy_set_header   X-Forwarded-Proto $scheme;"
    print "    }"
    print ""
    print "    location /request/ {"
    print "        proxy_pass         http://127.0.0.1:3001;"
    print "        proxy_http_version 1.1;"
    print "        proxy_set_header   Host              $host;"
    print "        proxy_set_header   X-Real-IP         $remote_addr;"
    print "        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;"
    print "        proxy_set_header   X-Forwarded-Proto $scheme;"
    print "    }"
    print ""
    done = 1
  }
  { print }
' "$CONF" > "$TMP"

cat "$TMP" > "$CONF"   # preserve original ownership/permissions
rm -f "$TMP"
echo "  patched — diff against backup:"
diff -u "$BACKUP" "$CONF" | sed 's/^/    /' || true

# ── validate, and undo if nginx is unhappy ────────────────────────────────
if ! nginx -t; then
  cp -a "$BACKUP" "$CONF"
  fail "nginx -t FAILED — config restored from backup, nginx NOT reloaded"
fi

nginx -s reload || systemctl reload nginx
echo "  ✓ nginx validated and reloaded"
