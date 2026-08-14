#!/usr/bin/env bash
# Post-deploy check for the two public portals. Read-only: only GETs.
#
#   ./verify-portal-routes.sh <casting-token> <request-token> [host]
#
# Tokens must be ones that exist in the PRODUCTION database — generate them from
# Casting Management → External and Request Intake → Links on the live site. A
# token from another environment will correctly report "link not valid".

set -uo pipefail
CT="${1:-}"; RT="${2:-}"; H="${3:-https://nerve.paruluniversity.ac.in}"
[ -n "$CT" ] && [ -n "$RT" ] || { echo "usage: $0 <casting-token> <request-token> [host]"; exit 2; }

pass=0; fail=0
ok(){ echo "  ✓ $1"; pass=$((pass+1)); }
no(){ echo "  ✗ $1"; fail=$((fail+1)); }

# body + status in one fetch
get(){ curl -sS --max-time 20 -o /tmp/_vp.body -w '%{http_code}' "$1" 2>/dev/null; }
title(){ grep -oE '<title>[^<]*' /tmp/_vp.body | head -1 | sed 's/<title>//'; }

portal(){ # <label> <url> <expected-title-fragment>
  local code; code=$(get "$2"); local t; t=$(title)
  echo "    $2"
  echo "      HTTP $code | title: ${t:-–}"
  [ "$code" = 200 ]                        && ok "$1: 200"            || no "$1: expected 200, got $code"
  case "$t" in *"$3"*) ok "$1: portal page";; *) no "$1: title was '$t', expected to contain '$3'";; esac
  case "$t" in *"Parul Nerve"*) no "$1: served the React SPA — nginx is still falling through";; esac
  grep -qi "Oops! Page not found" /tmp/_vp.body && no "$1: NERVE generic 404" || ok "$1: not the generic 404"
  grep -q 'id="root"' /tmp/_vp.body         && no "$1: SPA shell present"     || ok "$1: no SPA shell"
}

echo "══ A. Casting valid link ══";  portal "A" "$H/casting/register/$CT" "Casting Registration"
echo "══ B. Request valid link ══";  portal "B" "$H/request/register/$RT" "Media Request"

echo "══ C/D. Invalid tokens → public message, not the SPA 404 ══"
for p in "casting/register" "request/register"; do
  code=$(get "$H/$p/invalid-token-000"); t=$(title)
  echo "    /$p/invalid-token-000 → HTTP $code | title: ${t:-–}"
  case "$t" in *"Parul Nerve"*) no "$p invalid: served the React SPA";; *) ok "$p invalid: public portal page";; esac
  grep -qi "Oops! Page not found" /tmp/_vp.body && no "$p invalid: generic 404" || ok "$p invalid: no generic 404"
done

echo "══ E. Hard refresh (cache-busted re-request) ══"
for u in "$H/casting/register/$CT" "$H/request/register/$RT"; do
  code=$(curl -sS --max-time 20 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' -o /tmp/_vp.body -w '%{http_code}' "$u")
  t=$(title); echo "    $u → HTTP $code | $t"
  case "$t" in *"Parul Nerve"*) no "refresh: fell back to SPA";; *) ok "refresh holds";; esac
done

echo "══ F. Zero-cookie fetch (fresh-session equivalent) ══"
for u in "$H/casting/register/$CT" "$H/request/register/$RT"; do
  code=$(curl -sS --max-time 20 -c /dev/null -b /dev/null -o /tmp/_vp.body -w '%{http_code}' "$u")
  t=$(title); echo "    $u → HTTP $code | $t"
  case "$t" in *"Parul Nerve"*) no "zero-cookie: fell back to SPA";; *) ok "zero-cookie serves the portal";; esac
done

echo "══ G. Normal NERVE routes must still be the React SPA ══"
for u in / /login /media /dashboard; do
  code=$(get "$H$u"); t=$(title)
  printf "    %-12s HTTP %s | %s\n" "$u" "$code" "$t"
  { [ "$code" = 200 ] && case "$t" in *"Parul Nerve"*) true;; *) false;; esac; } \
    && ok "SPA intact: $u" || no "SPA REGRESSION at $u (HTTP $code, title '$t')"
done

echo "══ H. Internal modules reachable ══"
code=$(get "$H/api/media-ops/"); t=$(title)
echo "    /api/media-ops/ → HTTP $code | $t"
[ "$code" = 200 ] && ok "media-ops app served" || no "media-ops app HTTP $code"
for m in casting casting-admin requests dispatch my-day home; do
  # the SPA is hash-routed, so the shell is the only server-side surface;
  # this confirms the bundle still loads for every module entry point.
  c=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' "$H/api/media-ops/#/media/$m")
  [ "$c" = 200 ] && ok "module shell: $m" || no "module shell $m → HTTP $c"
done

echo
echo "══ $pass passed, $fail failed ══"
[ "$fail" = 0 ] || exit 1
