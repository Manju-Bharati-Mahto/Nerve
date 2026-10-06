#!/usr/bin/env bash
set -euo pipefail

# Makes the LIVE nginx vhost accept uploads, and lets the browser send outreach
# videos straight to Google Drive.
#
# 1. Upload limits on /api.
#    nginx's default client_max_body_size is 1 MB. Anything larger is refused by
#    nginx itself with an HTML "413 Request Entity Too Large" before the API is
#    reached, and the client shows "Request failed." / "Upload failed.". That
#    broke BrandOps delivery/work-order photos (10 x 10 MB) and the outreach
#    video fallback upload (multer allows 2 GB) — every multipart upload in the
#    app goes through /api/.
#
# 2. Content-Security-Policy connect-src.
#    The live vhost sends "default-src 'self'; ..." with no connect-src, so the
#    browser may only fetch same-origin. Outreach videos are now PUT by the
#    browser directly to Google Drive's resumable upload URL
#    (https://www.googleapis.com/upload/drive/v3/...) so they never touch Nerve's
#    disk or database; CSP blocks that until connect-src allows googleapis.
#
# Why patch in place: same reason as add-portal-routes.sh — the live vhost
# terminates TLS, speaks HTTP/2 and sets HSTS/CSP; nginx/nerve.conf has none of
# that, so it must never be copied over the live file.
#
# Where the limits go: inside EVERY location block whose path is /api or under
# /api/ (prefix, ^~, = or regex), in every server block of the vhost. Location
# level is the only place guaranteed to win: a client_max_body_size already in a
# location (the template used to ship "20M", a hand edit might say "1m")
# overrides anything at server or http level, and an http-level conf.d snippet
# would also loosen every other vhost on the box. The certbot :80 block only
# redirects (no /api location), so it needs nothing; if a :80 block DOES proxy
# /api, it is patched too.
#
# Where the CSP is: every `add_header Content-Security-Policy "..."` line in the
# vhost. If the vhost has none, the files it includes (recursively) are searched
# and patched instead — unless another enabled site (sites-enabled/*,
# conf.d/*.conf) or nginx.conf includes the same file: editing it would change
# that site's CSP too, so it is reported for a hand edit and left alone. If the
# vhost and its includes have no CSP at all, one `nginx -T` dump is searched;
# a CSP set at http level (nginx.conf, conf.d) or in another block for the same
# server_name is reported with file:line and the corrected line, never edited.
# Only connect-src is touched:
#   - no connect-src  → "connect-src <default-src sources> https://www.googleapis.com;"
#                       is inserted right after default-src (for the live policy
#                       that is exactly "connect-src 'self' https://www.googleapis.com;")
#   - connect-src without googleapis → the host is appended to it
#   - already allows googleapis      → left alone
#
# Idempotent: managed /api lines carry the "nerve:upload-limits" marker and are
# rewritten on every run; pre-existing copies of the same directives inside the
# /api blocks are REPLACED, never duplicated. If every result is byte-identical
# to the live files, nothing is backed up or reloaded. If `nginx -t` rejects the
# result, every touched file is restored from its backup and nginx is not
# reloaded.
#
# Exit codes (the upload limits are applied and validated for 0, 2 and 3):
#   0 done, or nothing to do
#   1 failed — nothing changed, or every file restored from backup
#   2 a CSP line in the vhost/its includes is in a shape this script will not
#     edit (odd quoting, split over lines, connect-src 'none') — hand edit
#   3 the CSP is set outside the vhost (nginx.conf / conf.d / a file other
#     sites include too) and blocks Google Drive — hand edit, see the message
#   (3 wins when both apply; deploy.sh reports 2 and 3 as "hand edit needed")
# nginx -T is run once, up front, into a temp file; every later check reads it
# (no `nginx -T | grep -q`, which pipefail turns into a false "not found").
#
# Runs on every deploy (deploy.sh) so a certbot rewrite or a hand edit can
# never silently bring the 1 MB limit or the blocking CSP back.
#
# Test-only overrides (defaults are the real thing): NGINX_BIN (fake nginx),
# SKIP_ROOT_CHECK=1, NGINX_CONF_DIR (where relative includes resolve).

CONF="${CONF:-}"
BACKUP_DIR="${BACKUP_DIR:-/srv/nerve/backups/nginx}"
NGINX_BIN="${NGINX_BIN:-nginx}"

# Largest legitimate request: one outreach video on the proxy fallback path,
# multer cap 2 GiB (server/index.ts videoUpload) + multipart framing and fields.
API_BODY_MAX="${API_BODY_MAX:-2100m}"
# Max gap between two reads of the client's body (not the total upload time).
CLIENT_BODY_TIMEOUT="${CLIENT_BODY_TIMEOUT:-300s}"
# Max gap between two writes to / reads from the API. The fallback video POST
# answers only after the API has pushed the file on to Google Drive, so the read
# timeout must cover that whole hand-off.
PROXY_SEND_TIMEOUT="${PROXY_SEND_TIMEOUT:-300s}"
PROXY_READ_TIMEOUT="${PROXY_READ_TIMEOUT:-900s}"

# The browser's direct-to-Drive upload target (resumable session URLs).
CSP_HOST="https://www.googleapis.com"

MARK="nerve:upload-limits"
MANAGED_RE='client_max_body_size|client_body_timeout|proxy_send_timeout|proxy_read_timeout|proxy_request_buffering'

fail() { echo "  ✗ $*" >&2; exit 1; }
warn() { echo "  ⚠ $*" >&2; }

if [ "${SKIP_ROOT_CHECK:-}" != 1 ]; then
  [ "$(id -u)" = 0 ] || fail "run as root (nginx config + reload need it)"
fi
command -v "$NGINX_BIN" >/dev/null || fail "nginx not found ($NGINX_BIN)"

# ── locate the live vhost ─────────────────────────────────────────────────
if [ -z "$CONF" ]; then
  for c in /etc/nginx/sites-enabled/nerve /etc/nginx/conf.d/nerve.conf; do
    [ -f "$c" ] && { CONF=$(readlink -f "$c"); break; }
  done
fi
[ -n "$CONF" ] && [ -f "$CONF" ] || fail "could not find the vhost; pass CONF=/path/to/conf"
CONF=$(readlink -f "$CONF")
echo "  vhost: $CONF"

# Relative `include` paths resolve against the directory of nginx.conf.
if [ -z "${NGINX_CONF_DIR:-}" ]; then
  NGINX_CONF_DIR=$("$NGINX_BIN" -V 2>&1 | tr ' ' '\n' | sed -n 's/^--conf-path=//p')
  NGINX_CONF_DIR=$(dirname "${NGINX_CONF_DIR:-/etc/nginx/nginx.conf}")
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# ── the effective config, dumped ONCE and reused by every check below ──────
# Never `nginx -T | grep -q`: under pipefail, grep -q exiting at the first
# match kills nginx with SIGPIPE and the pipeline reports "not found".
DUMP="$WORK/dump"; DUMP_OK=0
if "$NGINX_BIN" -T > "$DUMP" 2> "$WORK/dump.err"; then DUMP_OK=1; fi
: > "$WORK/dumped"   # every file nginx loads, symlinks resolved
if [ "$DUMP_OK" = 1 ]; then
  sed -n 's/^# configuration file \(.*\):$/\1/p' "$DUMP" > "$WORK/dumped.raw"
  while IFS= read -r p; do
    readlink -f "$p" 2>/dev/null || echo "$p"
  done < "$WORK/dumped.raw" > "$WORK/dumped"
  # Catches a CONF that is not the enabled vhost before anything is patched.
  if grep -qxF "$CONF" "$WORK/dumped"; then
    echo "  ✓ nginx loads this vhost (nginx -T)"
  else
    warn "nginx -T does not load $CONF — is it actually the enabled vhost? (patching it would change nothing nginx serves)"
  fi
else
  warn "nginx -T failed, so nginx.conf / conf.d cannot be checked for a CSP:"
  sed 's/^/      /' "$WORK/dump.err" >&2
fi

# server_name values of the vhost ("_" dropped), to tell this site's server
# blocks from other sites' in the dump.
VHOST_NAMES=$(awk '{ sub(/#.*/, "") } $1 == "server_name" {
  for (i = 2; i <= NF; i++) { s = tolower($i); sub(/;.*/, "", s); if (s != "" && s != "_") printf " %s", s }
}' "$CONF")

# ── the rewriter ──────────────────────────────────────────────────────────
# One awk pass per file. api=1 for the vhost (limits + CSP), api=0 for an
# included file (CSP only). Output goes to a temp file; the live file is not
# touched until every file has been rewritten and validated. Plain POSIX awk
# (Ubuntu ships mawk): no gawk-only functions, no {n} intervals, no [[:space:]].
rewrite() {  # rewrite <api 0|1> <in> <out> <report>
  awk -v api="$1" -v mark="$MARK" -v managed="^($MANAGED_RE)$" -v report="$4" \
      -v body="$API_BODY_MAX" -v cbt="$CLIENT_BODY_TIMEOUT" \
      -v pst="$PROXY_SEND_TIMEOUT" -v prt="$PROXY_READ_TIMEOUT" -v host="$CSP_HOST" '
    function strip(s) { sub(/#.*/, "", s); return s }
    function opens(s,  t) { t = s; return gsub(/\{/, "", t) }
    function closes(s, t) { t = s; return gsub(/\}/, "", t) }
    function rtrim(s) { sub(/[ \t]+$/, "", s); return s }

    # Does this list of CSP sources already let the browser reach googleapis?
    function allows(srcs,   n, t, i, s) {
      n = split(srcs, t, /[ \t]+/)
      for (i = 1; i <= n; i++) {
        s = tolower(t[i]); sub(/\/$/, "", s)
        if (s == tolower(host) || s == "www.googleapis.com" || s == "https://*.googleapis.com" ||
            s == "*.googleapis.com" || s == "*" || s == "https:") return 1
      }
      return 0
    }
    function has_none(srcs) { return (" " tolower(srcs) " ") ~ /[ \t]'"'"'none'"'"'[ \t]/ }

    # Returns the policy with connect-src fixed; sets cstate to
    # patched / ok / open (no default-src: connect is unrestricted) / none.
    function fix_policy(pol,   n, d, i, name, k, dk, srcs, tail, out) {
      n = split(pol, d, ";")
      dk = 0; k = 0
      for (i = 1; i <= n; i++) {
        name = d[i]; sub(/^[ \t]+/, "", name); sub(/[ \t].*/, "", name); name = tolower(name)
        if (name == "connect-src" && !k) k = i
        if (name == "default-src" && !dk) dk = i
      }
      if (k) {
        srcs = d[k]; sub(/^[ \t]*[^ \t]+/, "", srcs)
        if (allows(srcs)) { cstate = "ok"; return pol }
        if (has_none(srcs)) { cstate = "none"; return pol }
        tail = d[k]; sub(/.*[^ \t]/, "", tail)          # keep "; " spacing exactly
        d[k] = rtrim(d[k]) " " host tail
      } else if (dk) {
        srcs = d[dk]; sub(/^[ \t]*[^ \t]+/, "", srcs)
        if (allows(srcs)) { cstate = "ok"; return pol }  # default-src already covers it
        # connect-src replaces default-src for fetch/XHR, so it starts from the
        # same sources (\x27none\x27 dropped: it cannot be combined with a host).
        gsub(/'"'"'[Nn][Oo][Nn][Ee]'"'"'/, "", srcs); srcs = rtrim(srcs); sub(/^[ \t]+/, "", srcs)
        if (srcs == "") srcs = "'"'"'self'"'"'"
        if (dk < n) d[dk] = d[dk] "; connect-src " srcs " " host
        else        d[dk] = rtrim(d[dk]) "; connect-src " srcs " " host
      } else { cstate = "open"; return pol }
      out = d[1]
      for (i = 2; i <= n; i++) out = out ";" d[i]
      cstate = "patched"
      return out
    }

    # A CSP add_header line, or the line unchanged.
    function csp(line,   code, lc, start, rest, len, pol, np) {
      code = strip(line); lc = tolower(code)
      if (lc !~ /content-security-policy/ || lc ~ /content-security-policy-report-only/) return line
      if (lc !~ /^[ \t]*add_header[ \t]/ && lc !~ /more_set_headers/) return line   # e.g. proxy_hide_header
      if (lc !~ /^[ \t]*add_header[ \t]+"?content-security-policy"?[ \t]+"[^"]*"([ \t]+always)?[ \t]*;[ \t]*$/) {
        print "csp unsafe: " NR ": " line > report      # odd quoting / multi-line / headers-more
        return line
      }
      match(lc, /content-security-policy"?[ \t]+"/)
      start = RSTART + RLENGTH                             # first char of the policy
      rest = substr(line, start); len = index(rest, "\"") - 1
      pol = substr(rest, 1, len)
      np = fix_policy(pol)
      if (cstate == "patched") {
        print "csp patched: " NR > report
        return substr(line, 1, start - 1) np substr(line, start + len)
      }
      if (cstate == "none") print "csp unsafe: " NR ": connect-src '"'"'none'"'"' — " line > report
      else print "csp " cstate ": " NR > report
      return line
    }

    BEGIN { blocks = 0; seen = 0; bad = 0; inapi = 0 }

    {
      line = csp($0)
      code = strip(line)

      if (api) {
        # /api or anything under /api/ — but not /apiary, /api-docs, /api_v2.
        isapi = (code ~ /^[ \t]*location[ \t]+([=~^*]+[ \t]+)?"?\^?\/api([\/ \t{"$]|\([\/$]|$)/)
        if (isapi) seen++

        # an /api location opening, alone on its line, ending in "{"
        if (!inapi && isapi && code ~ /\{[ \t]*$/) {
          print line
          ind = line; sub(/[^ \t].*/, "", ind); ind = ind "    "
          print ind "# Uploads: BrandOps photos (10 x 10 MB), outreach video fallback (2 GB). " mark
          print ind "client_max_body_size    " body ";  # " mark
          print ind "client_body_timeout     " cbt ";  # " mark
          print ind "proxy_request_buffering on;  # " mark " (Node 22 requestTimeout is 300s; let nginx absorb slow clients)"
          print ind "proxy_send_timeout      " pst ";  # " mark
          print ind "proxy_read_timeout      " prt ";  # " mark
          blocks++; inapi = 1; depth = opens(code) - closes(code)
          next
        }

        if (inapi) {
          if (index(line, mark)) next                     # our own lines from a previous run
          n = split(code, tok, /[ \t;]+/)
          first = (tok[1] == "" ? tok[2] : tok[1])
          if (depth == 1 && first ~ managed && code ~ /^[ \t]*[a-z_]+[ \t]+[^;]*;[ \t]*$/) {
            print "replaced: " line > report              # old value, now superseded
            next
          }
          if (code ~ ("(^|[ \t;{])(" substr(managed, 3, length(managed) - 4) ")[ \t]")) {
            print "unsafe: " NR ": " line > report        # nested block / several statements on one line
            bad = 1
          }
          depth += opens(code) - closes(code)
          if (depth <= 0) inapi = 0
        }
      }
      print line
    }
    END {
      print "blocks: " blocks > report
      print "seen: " seen > report
      if (bad) exit 3
    }
  ' "$2" > "$3"
}

# Files whose rewrite differs from the live copy: "live<TAB>rewritten" lines.
CHANGES="$WORK/changes"; : > "$CHANGES"
CSP_FOUND=0; CSP_UNSAFE=0

note_csp() {  # note_csp <file> <report>
  local f="$1" r="$2" n
  n=$(grep -cE '^csp (patched|ok|open|unsafe):' "$r" || true)
  CSP_FOUND=$((CSP_FOUND + n))
  sed -n "s|^csp patched: \(.*\)|    CSP connect-src: added $CSP_HOST — $f:\1|p" "$r"
  sed -n "s|^csp ok: \(.*\)|    CSP connect-src: already allows googleapis — $f:\1|p" "$r"
  sed -n "s|^csp open: \(.*\)|    CSP has no default-src/connect-src, connections unrestricted — $f:\1|p" "$r"
  if grep -q '^csp unsafe:' "$r"; then
    CSP_UNSAFE=1
    grep '^csp unsafe:' "$r" | sed "s|^csp unsafe: |    $f:|" >&2
    warn "the Content-Security-Policy line above needs a hand edit (odd quoting, split over lines, or connect-src 'none') — make its connect-src include \"$CSP_HOST\", or direct video uploads to Google Drive stay blocked"
  fi
}

# A CSP response-header line (not report-only, not commented out, not e.g.
# proxy_hide_header) — the same test the rewriter uses.
CSP_LINE_AWK='function is_csp(s,  lc) { sub(/#.*/, "", s); lc = tolower(s)
  return lc ~ /content-security-policy/ && lc !~ /content-security-policy-report-only/ &&
         (lc ~ /^[ \t]*add_header[ \t]/ || lc ~ /more_set_headers/) }'

csp_lines() {  # csp_lines <file>: "<line no><TAB><line>" per CSP header line
  awk "$CSP_LINE_AWK"' is_csp($0) { print NR "\t" $0 }' "$1"
}

# Every CSP header line in the nginx -T dump: "<file><TAB><line><TAB><where><TAB><text>",
# where = http (not inside a server block of its own file: nginx.conf's http{},
# a conf.d snippet, …), server-ours (a server block whose server_name is one of
# the vhost's) or server-other (another site's server block).
dump_csp() {
  awk -v names=" $VHOST_NAMES " "$CSP_LINE_AWK"'
    function flush(   i, k, n, t, w) {
      w = "server-other"
      n = split(snames, t, /[ \t]+/)
      for (k = 1; k <= n; k++) if (t[k] != "" && index(names, " " t[k] " ")) w = "server-ours"
      for (i = 1; i <= nb; i++) print bf[i] "\t" bl[i] "\t" w "\t" bt[i]
      nb = 0; snames = ""; sdepth = 0
    }
    /^# configuration file .*:$/ {
      if (sdepth) flush()
      file = $0; sub(/^# configuration file /, "", file); sub(/:$/, "", file)
      ln = 0; depth = 0; next
    }
    {
      ln++
      code = $0; sub(/#.*/, "", code)
      if (!sdepth && code ~ /^[ \t]*server[ \t]*\{/) sdepth = depth + 1
      if (sdepth && code ~ /^[ \t]*server_name[ \t]/) {
        s = tolower(code); sub(/^[ \t]*server_name[ \t]+/, "", s); sub(/;.*/, "", s); snames = snames " " s
      }
      if (is_csp($0)) {
        if (sdepth) { nb++; bf[nb] = file; bl[nb] = ln; bt[nb] = $0 }
        else print file "\t" ln "\thttp\t" $0
      }
      t = code; o = gsub(/\{/, "", t); t = code; c = gsub(/\}/, "", t)
      depth += o - c
      if (sdepth && depth < sdepth) flush()
    }
    END { if (sdepth) flush() }
  ' "$DUMP"
}

# include_closure <file> <out>: every file <file> includes, recursively (globs
# expanded, relative paths against nginx.conf's dir, symlinks resolved). Never
# descends into the vhost itself.
include_closure() {
  local f pat inc
  local -a queue=("$1")
  : > "$2"
  while [ "${#queue[@]}" -gt 0 ]; do
    f="${queue[0]}"; queue=("${queue[@]:1}")
    while IFS= read -r pat; do
      case "$pat" in /*) ;; *) pat="$NGINX_CONF_DIR/$pat" ;; esac
      for inc in $pat; do   # unquoted on purpose: expands the include's glob
        [ -f "$inc" ] || continue
        inc=$(readlink -f "$inc")
        [ "$inc" != "$CONF" ] || continue
        grep -qxF "$inc" "$2" && continue
        echo "$inc" >> "$2"
        queue+=("$inc")
      done
    done < <(sed -e 's/#.*//' "$f" | sed -n 's/^[[:space:]]*include[[:space:]]\{1,\}\([^;[:space:]]*\)[[:space:]]*;.*/\1/p')
  done
}

# others_closure: "<included file><TAB><includer>" for every OTHER enabled site
# (sites-enabled/*, conf.d/*.conf) and for nginx.conf's own include lines.
# Built once, on first use.
others_closure() {
  [ -f "$WORK/others" ] && return 0
  : > "$WORK/others"
  local s r main="$NGINX_CONF_DIR/nginx.conf"
  for s in "$NGINX_CONF_DIR"/sites-enabled/* "$NGINX_CONF_DIR"/conf.d/*.conf; do
    [ -f "$s" ] || continue
    r=$(readlink -f "$s")
    [ "$r" != "$CONF" ] || continue
    include_closure "$r" "$WORK/oc"
    awk -v by="$r" '{ print $0 "\t" by }' "$WORK/oc" >> "$WORK/others"
  done
  # nginx.conf: its direct includes only (following them would walk into the
  # sites, the vhost among them).
  if [ -f "$main" ]; then
    sed -e 's/#.*//' "$main" | sed -n 's/^[[:space:]]*include[[:space:]]\{1,\}\([^;[:space:]]*\)[[:space:]]*;.*/\1/p' > "$WORK/main.inc"
    while IFS= read -r pat; do
      case "$pat" in /*) ;; *) pat="$NGINX_CONF_DIR/$pat" ;; esac
      for s in $pat; do
        [ -f "$s" ] || continue
        printf '%s\t%s\n' "$(readlink -f "$s")" "$(readlink -f "$main")" >> "$WORK/others"
      done
    done < "$WORK/main.inc"
  fi
}

# outside <why> <file> <line> <text>: a CSP line this script must not edit.
# Fine as it is (already allows googleapis / no default-src) → noted. Otherwise
# queued for the loud end-of-run report with the corrected line, and exit 3.
CSP_OUTSIDE="$WORK/outside"; : > "$CSP_OUTSIDE"
outside() {
  local why="$1" f="$2" ln="$3" text="$4" fix=""
  printf '%s\n' "$text" > "$WORK/one"
  rewrite 0 "$WORK/one" "$WORK/one.out" "$WORK/one.report" || true
  if grep -q '^csp ok:' "$WORK/one.report"; then
    echo "    CSP connect-src: already allows googleapis — $f:$ln ($why)"; return 0
  fi
  if grep -q '^csp open:' "$WORK/one.report"; then
    echo "    CSP has no default-src/connect-src, connections unrestricted — $f:$ln ($why)"; return 0
  fi
  grep -q '^csp patched:' "$WORK/one.report" && fix=$(cat "$WORK/one.out")
  text="${text#"${text%%[![:space:]]*}"}"; fix="${fix#"${fix%%[![:space:]]*}"}"
  printf '%s:%s — %s\t%s\t%s\n' "$f" "$ln" "$why" "$text" "$fix" >> "$CSP_OUTSIDE"
  warn "the CSP at $f:$ln ($why) does not allow $CSP_HOST — NOT edited, see the end of this output"
}

# ── 1. the vhost: /api limits + CSP ───────────────────────────────────────
set +e
rewrite 1 "$CONF" "$WORK/vhost" "$WORK/vhost.report"
rc=$?
set -e
[ "$rc" = 0 ] || { sed 's/^/    /' "$WORK/vhost.report" >&2; fail "a managed directive sits somewhere this script will not edit safely — patch by hand, nothing was changed"; }

BLOCKS=$(sed -n 's/^blocks: //p' "$WORK/vhost.report")
SEEN=$(sed -n 's/^seen: //p' "$WORK/vhost.report")
[ "$SEEN" -ge 1 ] || fail "no 'location /api… {' block found — check: grep -n location $CONF"
[ "$BLOCKS" = "$SEEN" ] || fail "found $SEEN /api location lines but could only patch $BLOCKS (brace on its own line, nested, or a one-line block?) — patch by hand, nothing was changed"
echo "  /api location blocks: $BLOCKS"
grep '^replaced: ' "$WORK/vhost.report" | sed 's/^/    /' || true
cmp -s "$CONF" "$WORK/vhost" || printf '%s\t%s\n' "$CONF" "$WORK/vhost" >> "$CHANGES"
note_csp "$CONF" "$WORK/vhost.report"

# ── 2. no CSP in the vhost? then it comes from an included file … ──────────
if [ "$CSP_FOUND" = 0 ]; then
  include_closure "$CONF" "$WORK/includes"

  i=0
  while IFS= read -r inc; do
    csp_lines "$inc" > "$WORK/inc.lines"
    [ -s "$WORK/inc.lines" ] || continue
    i=$((i + 1))
    echo "  CSP is set in an included file: $inc"

    # Shared with another site? Then editing it would change that site's CSP
    # too — report it for a hand edit instead.
    others_closure
    sharers=$(awk -F'\t' -v f="$inc" '$1 == f { print "      " $2 }' "$WORK/others" | sort -u)
    if [ -n "$sharers" ]; then
      CSP_FOUND=$((CSP_FOUND + $(wc -l < "$WORK/inc.lines")))
      warn "$inc is also included by (not edited — that would change their CSP too):"
      echo "$sharers" >&2
      while IFS="$(printf '\t')" read -r ln text; do
        outside "a file other sites include too" "$inc" "$ln" "$text"
      done < "$WORK/inc.lines"
      continue
    fi

    set +e
    rewrite 0 "$inc" "$WORK/inc.$i" "$WORK/inc.$i.report"
    set -e
    cmp -s "$inc" "$WORK/inc.$i" || printf '%s\t%s\n' "$inc" "$WORK/inc.$i" >> "$CHANGES"
    note_csp "$inc" "$WORK/inc.$i.report"
  done < "$WORK/includes"
fi

# ── … or from outside the vhost altogether (nginx.conf, conf.d) ────────────
if [ "$CSP_FOUND" = 0 ]; then
  if [ "$DUMP_OK" = 1 ]; then
    dump_csp > "$WORK/dump.csp"
    relevant=0
    while IFS="$(printf '\t')" read -r file ln where text; do
      rfile=$(readlink -f "$file" 2>/dev/null || echo "$file")
      # The vhost and its includes were searched above (nothing usable there).
      { [ "$rfile" = "$CONF" ] || grep -qxF "$rfile" "$WORK/includes"; } && continue
      case "$where" in
        server-other)
          echo "    (a CSP in another site's server block, not this vhost's — ignored: $rfile:$ln)" ;;
        server-ours)
          relevant=1; outside "another server block for this site's server_name" "$rfile" "$ln" "$text" ;;
        *)
          relevant=1; outside "http level: nginx.conf / conf.d, outside the vhost" "$rfile" "$ln" "$text" ;;
      esac
    done < "$WORK/dump.csp"
    [ "$relevant" = 1 ] \
      || echo "  CSP: nginx does not set one for this vhost (checked nginx -T) — the browser is not restricted, nothing to do"
  else
    warn "no CSP in the vhost or its includes, and nginx -T failed, so nginx.conf / conf.d were NOT checked — run: nginx -T | grep -in content-security-policy"
  fi
fi

# ── 3. /uploads/ (report only) ────────────────────────────────────────────
if awk '{ sub(/#.*/, "") } /^[ \t]*location[ \t]+(\^~[ \t]+)?\/uploads\/?[ \t]*\{/ { f = 1 } END { exit !f }' "$CONF"; then
  echo "  ✓ location /uploads/ present"
else
  warn "no 'location /uploads/' in the vhost — uploaded images (/uploads/...) fall through to the SPA and show the app instead of the file. Add a block proxying /uploads/ to http://127.0.0.1:3001 (see deploy/nginx.conf.template)"
fi

# ── the verify hint, shown whether or not anything changed ───────────────
SITE="${VHOST_NAMES# }"; SITE="${SITE%% *}"; SITE="${SITE:-localhost}"
SCHEME=http; grep -qE '^[[:space:]]*listen[[:space:]].*(443|ssl)' "$CONF" && SCHEME=https
verify_hint() {
  echo "  verify (run one at a time):"
  echo "    head -c 5000000 /dev/zero | curl -sS -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- $SCHEME://$SITE/api/brandops/materials"
  echo "      → 401 (any code but 413; 413 means the 1 MB limit is still in force)"
  echo "    curl -sI $SCHEME://$SITE/ | grep -i content-security"
  echo "      → shows connect-src with googleapis"
}

finish() {  # exit code reflects a CSP line that still needs a hand edit
  verify_hint
  if [ -s "$CSP_OUTSIDE" ]; then
    {
      echo
      echo "  ⚠⚠⚠ THE CSP IS SET OUTSIDE THE NERVE VHOST — THIS SCRIPT DID NOT EDIT IT ⚠⚠⚠"
      echo "  The upload limits are applied. Direct video uploads to Google Drive stay"
      echo "  blocked until connect-src on the line(s) below includes $CSP_HOST"
      echo "  (for a policy like the live one: connect-src 'self' $CSP_HOST)."
      while IFS="$(printf '\t')" read -r where text fix; do
        echo "    $where"
        echo "      now:       $text"
        if [ -n "$fix" ]; then echo "      change to: $fix"
        else echo "      change to: (edit by hand — the line is in a shape this script cannot rewrite)"; fi
      done < "$CSP_OUTSIDE"
      echo "  Then, as root: nginx -t && systemctl reload nginx"
      echo "  (nginx only inherits an http-level add_header into a server/location block"
      echo "  that has no add_header of its own — confirm with the curl -sI check above.)"
    } >&2
    exit 3
  fi
  if [ "$CSP_UNSAFE" = 1 ]; then exit 2; fi
  exit 0
}

# ── already in the desired state? ─────────────────────────────────────────
if [ ! -s "$CHANGES" ]; then
  if [ -s "$CSP_OUTSIDE" ]; then
    echo "  ✓ upload limits ($API_BODY_MAX, read ${PROXY_READ_TIMEOUT}) already set — no file needs changing"
  else
    echo "  ✓ upload limits ($API_BODY_MAX, read ${PROXY_READ_TIMEOUT}) and CSP already set — nothing to do"
  fi
  finish
fi

# ── back up every file before touching anything ───────────────────────────
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
: > "$WORK/backups"
while IFS="$(printf '\t')" read -r live new; do
  backup="$BACKUP_DIR/$(basename "$live").$STAMP.bak"
  cp -a "$live" "$backup"
  printf '%s\t%s\n' "$live" "$backup" >> "$WORK/backups"
  echo "  backup: $backup"
done < "$CHANGES"

restore_all() {
  while IFS="$(printf '\t')" read -r live backup; do cp -a "$backup" "$live"; done < "$WORK/backups"
}

while IFS="$(printf '\t')" read -r live new; do
  cat "$new" > "$live"   # preserve original ownership/permissions
done < "$CHANGES"

echo "  patched — diff against backup:"
while IFS="$(printf '\t')" read -r live backup; do
  diff -u "$backup" "$live" | sed 's/^/    /' || true
done < "$WORK/backups"

# ── validate, and undo if nginx is unhappy ────────────────────────────────
if ! "$NGINX_BIN" -t; then
  restore_all
  fail "nginx -t FAILED — config restored from backup, nginx NOT reloaded"
fi

"$NGINX_BIN" -s reload || systemctl reload nginx
echo "  ✓ nginx validated and reloaded"

# ── nginx buffers each fallback upload to disk before handing it to the API ─
TEMP_DIR=$("$NGINX_BIN" -V 2>&1 | tr ' ' '\n' | sed -n 's/^--http-client-body-temp-path=//p')
TEMP_DIR="${TEMP_DIR:-/var/lib/nginx/body}"
if [ -d "$TEMP_DIR" ]; then
  FREE_KB=$(df -Pk "$TEMP_DIR" | awk 'NR==2 {print $4}')
  [ "${FREE_KB:-0}" -ge $((5 * 1024 * 1024)) ] \
    || warn "only $((FREE_KB / 1024)) MB free under $TEMP_DIR — a fallback (non-direct) 2 GB video upload is staged here first"
fi

finish
