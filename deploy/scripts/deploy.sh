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

git config --system --add safe.directory "$APP_ROOT" || fail "unable to mark $APP_ROOT as safe git directory"

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

cp "$SHARED_ENV_FILE" .env

npm ci
npm run lint
npm test
npm run build

docker compose --env-file "$SHARED_ENV_FILE" up -d --build db api

release_dir="$RELEASES_DIR/release-$(date +%Y%m%d%H%M%S)"
mkdir -p "$release_dir"
rsync -a --delete dist/ "$release_dir"/
ln -sfn "$release_dir" "$CURRENT_LINK"

nginx -t
systemctl reload nginx

echo "Deployed release at $release_dir"
