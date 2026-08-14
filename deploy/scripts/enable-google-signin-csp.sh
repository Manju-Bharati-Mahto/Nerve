#!/usr/bin/env bash
set -euo pipefail

# Widens the live nginx Content-Security-Policy so Google Identity Services can
# load on the public casting/request portals.
#
# The deployed policy is `script-src 'self' 'unsafe-inline'`, which blocks
# https://accounts.google.com/gsi/client outright — verified in a browser: the
# script fires onerror and `google.accounts.id` stays undefined, so the sign-in
# button never renders no matter how the Google client id is configured.
#
# As with add-portal-routes.sh this patches the LIVE vhost rather than copying
# the repo copy over it, because certbot has edited the live file in place and
# overwriting it would drop TLS.

CONF="${CONF:-}"
BACKUP_DIR="${BACKUP_DIR:-/srv/nerve/backups/nginx}"

# Origins required by Google Identity Services. accounts.google.com serves the
# client script, its stylesheet and the sign-in iframe; lh3 serves the account
# avatar shown in the button.
CSP="default-src 'self'; \
script-src 'self' 'unsafe-inline' https://accounts.google.com; \
style-src 'self' 'unsafe-inline' https://accounts.google.com; \
img-src 'self' data: blob: https://lh3.googleusercontent.com; \
font-src 'self'; \
frame-src https://accounts.google.com; \
connect-src 'self' https://accounts.google.com; \
frame-ancestors 'none';"

fail() { echo "  ✗ $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "run as root (nginx config + reload need it)"

if [ -z "$CONF" ]; then
  for c in /etc/nginx/sites-enabled/nerve /etc/nginx/conf.d/nerve.conf; do
    [ -f "$c" ] && { CONF=$(readlink -f "$c"); break; }
  done
fi
[ -n "$CONF" ] && [ -f "$CONF" ] || fail "could not find the vhost; pass CONF=/path/to/conf"
echo "  vhost: $CONF"

if grep -q "accounts.google.com" "$CONF"; then
  echo "  ✓ CSP already allows accounts.google.com — nothing to do"
  exit 0
fi

N=$(grep -ci 'add_header[[:space:]]\+Content-Security-Policy' "$CONF" || true)
[ "$N" = 1 ] || fail "expected exactly one Content-Security-Policy add_header, found $N — patch by hand"

mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/$(basename "$CONF").$(date +%Y%m%d-%H%M%S).bak"
cp -a "$CONF" "$BACKUP"
echo "  backup: $BACKUP"

TMP=$(mktemp)
CSP="$CSP" awk '
  BEGIN { csp = ENVIRON["CSP"] }
  tolower($0) ~ /add_header[[:space:]]+content-security-policy/ && !done {
    match($0, /^[[:space:]]*/); indent = substr($0, 1, RLENGTH)
    always = ($0 ~ /always[[:space:]]*;[[:space:]]*$/) ? " always" : ""
    print indent "add_header Content-Security-Policy \"" csp "\"" always ";"
    done = 1
    next
  }
  { print }
' "$CONF" > "$TMP"

cat "$TMP" > "$CONF"   # preserve ownership/permissions
rm -f "$TMP"
echo "  patched — diff against backup:"
diff -u "$BACKUP" "$CONF" | sed 's/^/    /' || true

if ! nginx -t; then
  cp -a "$BACKUP" "$CONF"
  fail "nginx -t FAILED — config restored from backup, nginx NOT reloaded"
fi

nginx -s reload || systemctl reload nginx
echo "  ✓ nginx validated and reloaded"
echo
echo "  Verify:  curl -sI https://nerve.paruluniversity.ac.in/casting/register/test | grep -i content-security"
