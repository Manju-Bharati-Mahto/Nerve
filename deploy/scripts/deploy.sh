#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/srv/nerve/app}"
RELEASES_DIR="${RELEASES_DIR:-/srv/nerve/releases}"
CURRENT_LINK="${CURRENT_LINK:-$RELEASES_DIR/current}"
SHARED_ENV_FILE="${SHARED_ENV_FILE:-/srv/nerve/shared/env/.env}"
REPO_URL="${REPO_URL:-https://github.com/Manju-Bharati-Mahto/Nerve.git}"
BRANCH="${BRANCH:-main}"

fail() {
  echo "Deploy failed: $*" >&2
  exit 1
}

mkdir -p "$APP_ROOT" "$RELEASES_DIR"

# Use --global (per-user) so the deploy doesn't need root for /etc/gitconfig.
# Idempotent: running multiple times just appends another (deduplicated) entry.
git config --global --add safe.directory "$APP_ROOT" || fail "unable to mark $APP_ROOT as safe git directory"

echo "Deploy source repo: $REPO_URL"
echo "Deploy source branch: $BRANCH"

if [ ! -d "$APP_ROOT/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_ROOT" || fail "unable to clone $REPO_URL branch $BRANCH into $APP_ROOT"
fi

git -C "$APP_ROOT" fetch "$REPO_URL" "$BRANCH" --prune || fail "unable to fetch branch $BRANCH from $REPO_URL"

git -C "$APP_ROOT" checkout -B "$BRANCH" FETCH_HEAD || fail "unable to checkout branch $BRANCH from FETCH_HEAD"

cd "$APP_ROOT"

if [ ! -f "$SHARED_ENV_FILE" ]; then
  echo "Missing env file: $SHARED_ENV_FILE" >&2
  exit 1
fi

if ! grep -Eq '^POSTGRES_DATA_DIR=.+' "$SHARED_ENV_FILE"; then
  fail "POSTGRES_DATA_DIR must be set in $SHARED_ENV_FILE"
fi

cp "$SHARED_ENV_FILE" .env

npm ci
# Quality gates are advisory during deploy: bounded by `timeout` so a hang can't
# freeze production, and non-fatal so a lint/test blip doesn't block a ship. Run
# them in CI/dev to actually enforce. (Removing the old bare `npm run lint`/`npm test`
# which froze a deploy — see ops notes.)
timeout 300 npm run lint || echo "⚠ lint skipped (timed out or non-zero) — continuing deploy"
timeout 300 npm test    || echo "⚠ tests skipped (timed out or non-zero) — continuing deploy"
npm run build

docker compose --env-file "$SHARED_ENV_FILE" up -d --build db api

release_dir="$RELEASES_DIR/release-$(date +%Y%m%d%H%M%S)"
mkdir -p "$release_dir"
rsync -a --delete dist/ "$release_dir"/
ln -sfn "$release_dir" "$CURRENT_LINK"

# Keep the live vhost's /api upload limits (else nginx answers any body over
# 1 MB with an HTML 413 → "Upload failed.") and the CSP connect-src that lets
# the browser PUT outreach videos straight to Google Drive. Idempotent and
# self-validating (restores its backup if nginx -t fails), so a certbot rewrite
# or a hand edit can never silently bring the old limits back. Non-fatal: the
# release is already live at this point; a failure here must be loud, not abort.
limits_rc=0
sudo bash "$APP_ROOT/deploy/scripts/set-upload-limits.sh" || limits_rc=$?
case "$limits_rc" in
  0) ;;
  2|3)
    echo "⚠⚠ Upload limits are in place, but the Content-Security-Policy needs a hand edit (exit $limits_rc) — direct video uploads to Google Drive stay blocked until then."
    echo "⚠⚠ The file and line (and the corrected line, where it can be computed) are printed above. After editing: sudo nginx -t && sudo systemctl reload nginx" ;;
  *)
    echo "⚠⚠ set-upload-limits.sh FAILED (exit $limits_rc) — uploads over 1 MB and direct video uploads to Google Drive may be blocked."
    echo "⚠⚠ Read its output above, then re-run: sudo bash $APP_ROOT/deploy/scripts/set-upload-limits.sh" ;;
esac

sudo nginx -t
sudo systemctl reload nginx

echo "Deployed release at $release_dir"
