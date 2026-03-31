# Environment Variables

## Shared Variables

Set these in `/srv/nerve/shared/env/.env` on the VPS.

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `APP_BASE_URL` | Yes | Public URL used by the API and docs | `http://173.230.138.42` |
| `API_PORT` | Yes | Internal API port mapped to loopback | `3001` |
| `COOKIE_SECURE` | Yes | Use `false` on HTTP/IP, `true` after HTTPS | `false` |
| `SESSION_SECRET` | Yes | Session signing secret | long random string |
| `DATABASE_URL` | Yes | API connection string | `postgres://nerve_app:password@db:5432/nerve` |
| `POSTGRES_DB` | Yes | Database name for the db container | `nerve` |
| `POSTGRES_USER` | Yes | Database user | `nerve_app` |
| `POSTGRES_PASSWORD` | Yes | Database password | strong random password |
| `POSTGRES_DATA_DIR` | Yes | Host path for persistent PostgreSQL data | `/srv/nerve/data/postgres` |
| `SUPER_ADMIN_EMAIL` | Yes | Seeded super-admin login email | `super@parul.ac.in` |
| `SUPER_ADMIN_PASSWORD` | Yes | Seeded super-admin login password | strong temporary password |

## Frontend Variables

Local development or build-time variables:

| Variable | Required | Purpose | Default |
| --- | --- | --- | --- |
| `VITE_API_BASE_URL` | Yes | Frontend API base URL | `/api` |

## Secret Handling

What changed
- Secrets are kept out of git and loaded from `/srv/nerve/shared/env/.env`
- `.env.example` documents the required keys without real secrets

How to verify
- `cat /srv/nerve/shared/env/.env`
- `docker compose --env-file /srv/nerve/shared/env/.env config`

Rollback steps
- Restore the previous `.env` from your password manager or server backup
- Re-run the deploy script
