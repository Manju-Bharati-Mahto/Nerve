# Nerve Deployment Guide

**Date:** 2026-04-07T16:15:44+05:30

## Deployment Shape

Production deployment targets an Ubuntu VPS with:

- Nginx serving the SPA from `/srv/nerve/releases/current`
- an Express API container bound to `127.0.0.1:3001`
- a PostgreSQL container using `pgvector/pgvector:pg16`
- shared env configuration in `/srv/nerve/shared/env/.env`

## Runtime Components

### Frontend

- Built with `npm run build:client`
- Published into timestamped release directories under `/srv/nerve/releases/`
- Activated via a symlink switch at `/srv/nerve/releases/current`

### API

- Built from `Dockerfile.api`
- Runs `npm run start:server`
- Receives environment from Docker Compose

### Database

- Runs in Docker Compose service `db`
- Stores data on `${POSTGRES_DATA_DIR}`
- Healthchecked with `pg_isready`

### Reverse Proxy

- `nginx/nerve.conf` serves SPA files
- `/api/` is proxied to `http://127.0.0.1:3001/api/`

## Primary Deployment Workflow

The deploy script is `deploy/scripts/deploy.sh`.

High-level steps:

1. ensure app and releases directories exist
2. clone or fast-forward the configured git repo/branch
3. copy the shared env file into `.env`
4. run:
   - `npm ci`
   - `npm run lint`
   - `npm test`
   - `npm run build`
5. rebuild and start `db` and `api` with Docker Compose
6. rsync `dist/` into a timestamped release directory
7. update `/srv/nerve/releases/current`
8. run `nginx -t`
9. reload Nginx

## Required Server Paths

- `/srv/nerve/app`
- `/srv/nerve/releases`
- `/srv/nerve/shared/env/.env`
- `/srv/nerve/data/postgres`
- `/srv/nerve/backups/postgres`

## Key Environment Variables

- `APP_BASE_URL`
- `API_PORT`
- `COOKIE_SECURE`
- `SESSION_SECRET`
- `DATABASE_URL`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DATA_DIR`
- `SUPER_ADMIN_EMAIL`
- `SUPER_ADMIN_PASSWORD`

Optional but important when used:

- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

## Local Deployment-Style Testing

For branch-based local work:

```bash
cp .env.local.example .env.local
npm run dev:local
```

Useful verification commands:

```bash
curl http://127.0.0.1:3001/api/health
npm run lint
npm test
npm run build
```

## Backup and Restore

Operational scripts live in `deploy/scripts/`:

- `backup-postgres.sh`
- `restore-postgres.sh`
- `test-restore.sh`

See [../OPERATIONS.md](../OPERATIONS.md) for the runbook details.

## Deployment Risks and Notes

- Backend schema bootstrap runs on startup, so deploys can fail if env or DB assumptions drift.
- The deploy script assumes the repo and branch are reachable and can fast-forward cleanly.
- SPA and API are deployed together; this is not a static-only hosting model.
- Upload persistence depends on the mounted uploads path, not the release directory.

## References

- [../DEPLOYMENT.md](../DEPLOYMENT.md)
- [../ENVIRONMENT.md](../ENVIRONMENT.md)
- [../OPERATIONS.md](../OPERATIONS.md)
- [../TROUBLESHOOTING.md](../TROUBLESHOOTING.md)

---

_Generated using BMAD Method `document-project` workflow_
