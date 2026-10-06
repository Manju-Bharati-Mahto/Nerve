# Troubleshooting

## App Loads but Login Fails

Checks:

```bash
docker compose --env-file /srv/nerve/shared/env/.env -f /srv/nerve/app/docker-compose.yml logs api --tail=100
docker compose --env-file /srv/nerve/shared/env/.env -f /srv/nerve/app/docker-compose.yml exec db psql -U nerve_app -d nerve -c "SELECT email, role FROM users;"
```

Common fixes
- Confirm `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD`
- Make sure the API can connect to `db:5432`
- Clear browser cookies and try again

What changed
- Verified auth seed data and session connectivity

How to verify
- `curl http://173.230.138.42/api/health`
- Successful login in the browser

Rollback steps
- Restore the previous env file or database backup

## Nginx Shows 502 Bad Gateway

Checks:

```bash
systemctl status nginx --no-pager
docker compose --env-file /srv/nerve/shared/env/.env -f /srv/nerve/app/docker-compose.yml ps
curl http://127.0.0.1:3001/api/health
```

Common fixes
- Restart the API container
- Confirm `API_PORT=3001`
- Re-test Nginx config with `nginx -t`

What changed
- Verified proxy target and API health

How to verify
- `curl http://173.230.138.42/api/health`

Rollback steps
- Repoint Nginx to the previous working release and reload

## "Request failed." / "Upload failed." on Uploads

Small saves work but photo or video uploads fail. Usually nginx itself refused
the body with an HTML `413 Request Entity Too Large` (its default limit is 1 MB),
so the request never reached the API. If outreach videos fail at once in the
browser while other uploads work, the CSP is blocking the direct upload to
Google Drive instead (browser console: "Refused to connect to
https://www.googleapis.com").

Checks (single-line commands, run one at a time):

```bash
head -c 5000000 /dev/zero | curl -sS -o /dev/null -w '%{http_code}\n' -X POST --data-binary @- https://nerve.paruluniversity.ac.in/api/brandops/materials
```

```bash
curl -sI https://nerve.paruluniversity.ac.in/ | grep -i content-security
```

```bash
sudo nginx -T 2>/dev/null | grep -in 'client_max_body_size\|content-security-policy\|^# configuration file'
```

Common fixes
- The fix is `deploy/scripts/set-upload-limits.sh`. It reaches the server only when this branch is merged to `main` (`deploy.sh` deploys `main` only); after the merge the next `deploy.sh` run applies it automatically, because `deploy.sh` calls it on every deploy: `bash /srv/nerve/app/deploy/scripts/deploy.sh`
- To re-run it on its own (e.g. after a hand edit or a certbot rewrite of the vhost): `sudo bash /srv/nerve/app/deploy/scripts/set-upload-limits.sh`
- Exit code `2`: a CSP line in the vhost is in a shape the script will not edit; the output names the file and line — make its `connect-src` include `https://www.googleapis.com`, then `sudo nginx -t && sudo systemctl reload nginx`
- Exit code `3`: the CSP is set outside the vhost (`nginx.conf`, `conf.d/`, or a snippet another site also includes), so the script did not edit it; the upload limits are applied. The output ends with the file, line and the exact corrected line — paste it in, then `sudo nginx -t && sudo systemctl reload nginx`

What changed
- `/api` accepts bodies up to 2100m with longer timeouts; CSP `connect-src` allows `https://www.googleapis.com`

How to verify
- The first check prints `401`, the second shows `connect-src 'self' https://www.googleapis.com`

Rollback steps
- The script prints its backup path under `/srv/nerve/backups/nginx/`: `sudo cp <backup> <live file>`, then `sudo nginx -t && sudo systemctl reload nginx`

## Database Container Fails to Start

Checks:

```bash
docker compose --env-file /srv/nerve/shared/env/.env -f /srv/nerve/app/docker-compose.yml logs db --tail=100
ls -ld /srv/nerve/data/postgres
```

Common fixes
- Check disk space with `df -h`
- Confirm the data directory exists and is writable
- Verify the database password variables match

What changed
- Verified container startup inputs and persistent volume path

How to verify
- `docker compose ... ps`
- `docker compose ... exec db pg_isready -U nerve_app -d nerve`

Rollback steps
- Stop the stack and restore the previous data directory backup

## Build or Deploy Script Fails

Checks:

```bash
cd /srv/nerve/app
git status
npm run lint
npm test
npm run build
```

Common fixes
- Make sure the upstream repo and `main` branch are reachable, or set `REPO_URL` and `BRANCH` overrides before running the deploy script
- Re-run `npm ci`
- Check the shared `.env` path used by the deploy script

What changed
- Isolated whether the failure is code, env, or infrastructure

How to verify
- The deploy script exits cleanly and Nginx reload succeeds

Rollback steps
- Switch `/srv/nerve/releases/current` back to the previous release
- Redeploy the last known-good commit

## Local Dev Script Fails

Checks:

```bash
test -f .env.local
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.local ps
curl http://127.0.0.1:3001/api/health
```

Common fixes
- Copy `.env.local.example` to `.env.local` and replace the placeholder secrets
- Confirm `DATABASE_URL` uses `127.0.0.1:5432` for host-based API development
- Stop any process already using ports `8080`, `3001`, or `5432`

What changed
- Isolated whether the issue is local env setup, Docker PostgreSQL startup, or host dev processes

How to verify
- `docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.local ps`
- `curl http://127.0.0.1:3001/api/health`

Rollback steps
- Stop the script with `Ctrl+C`
- Remove the dev stack with `docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.local down`
