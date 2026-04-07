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

git config --global --add safe.directory "$APP_ROOT" || fail "unable to mark $APP_ROOT as safe git directory"

echo "Deploy source repo: $REPO_URL"
echo "Deploy source branch: $BRANCH"

if [ ! -d "$APP_ROOT/.git" ]; then
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_ROOT" || fail "unable to clone $REPO_URL branch $BRANCH into $APP_ROOT"
fi

git -C "$APP_ROOT" remote set-url origin "$REPO_URL" || fail "unable to set origin to $REPO_URL"
git -C "$APP_ROOT" fetch origin "$BRANCH" --prune || fail "unable to fetch branch $BRANCH from $REPO_URL"

if git -C "$APP_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git -C "$APP_ROOT" checkout "$BRANCH" || fail "unable to checkout branch $BRANCH"
else
  git -C "$APP_ROOT" checkout -B "$BRANCH" "origin/$BRANCH" || fail "unable to create branch $BRANCH from origin/$BRANCH"
fi

git -C "$APP_ROOT" pull --ff-only origin "$BRANCH" || fail "unable to fast-forward branch $BRANCH from $REPO_URL"

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
npm run lint
npm test
npm run build

docker compose --env-file "$SHARED_ENV_FILE" up -d --build db api

release_dir="$RELEASES_DIR/release-$(date +%Y%m%d%H%M%S)"
mkdir -p "$release_dir"
rsync -a --delete dist/ "$release_dir"/
ln -sfn "$release_dir" "$CURRENT_LINK"

sudo nginx -t
sudo systemctl reload nginx

echo "Deployed release at $release_dir"
