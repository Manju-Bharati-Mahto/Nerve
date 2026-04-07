# Nerve API Development Guide

**Date:** 2026-04-07T16:15:44+05:30
**Part:** API and Data Layer (`server/`)

## Purpose

This guide covers the backend service workflow for the Express API, its PostgreSQL dependencies, and the operational expectations that come with schema-bootstrap-at-startup.

## Prerequisites

- Node.js 22.x
- npm
- Docker with Compose plugin
- PostgreSQL reachable through `DATABASE_URL`
- Required env values from `.env.local` or `/srv/nerve/shared/env/.env`

## Required Environment Variables

The API will fail fast without these:

- `DATABASE_URL`
- `SESSION_SECRET`
- `SUPER_ADMIN_PASSWORD`

Frequently used additional values:

- `API_PORT`
- `APP_BASE_URL`
- `COOKIE_SECURE`
- `SUPER_ADMIN_EMAIL`
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `SMTP_FROM`

See [../ENVIRONMENT.md](../ENVIRONMENT.md) for the repo-level env reference.

## Recommended Local Workflow

Bring up the full local stack:

```bash
cp .env.local.example .env.local
npm run dev:local
```

That starts:

- Docker PostgreSQL
- `tsx watch server/index.ts`
- Vite for the frontend

## API-Only Commands

When the database is already available:

```bash
npm run dev:server
npm run build:server
npm run build
npm run start:server
```

## Startup Behavior

On boot, the backend:

1. validates env config
2. connects to PostgreSQL
3. bootstraps core tables
4. bootstraps branding tables
5. bootstraps settings/token tables
6. starts listening on `API_PORT`

Because of that, schema-affecting changes should be tested with a real startup, not only static compilation.

## Backend Conventions

- Validate request payloads with Zod in route handlers.
- Use `sendError` for predictable JSON error payloads.
- Wrap async handlers with `asyncHandler`.
- Prefer small authorization helpers over duplicated inline permission logic.
- Keep uploads within the existing Multer + `/uploads` approach unless a feature truly needs a different mechanism.
- Preserve cookie-session compatibility for auth-sensitive endpoints.

## Health and Manual Verification

Useful checks:

```bash
curl http://127.0.0.1:3001/api/health
docker compose -f docker-compose.yml -f docker-compose.dev.yml --env-file .env.local ps
```

When debugging:

- inspect API logs
- verify DB connectivity
- confirm the seeded super-admin credentials
- check that browser cookies/session are being set correctly

## Deployment-Aware Backend Work

Backend changes often require matching updates to:

- `ENVIRONMENT.md`
- `DEPLOYMENT.md`
- `OPERATIONS.md`
- `TROUBLESHOOTING.md`
- deployment scripts under `deploy/scripts/`

That is especially true for changes involving:

- new env vars
- schema changes
- startup order
- upload paths
- auth behavior

## Verification Checklist

Before merging backend changes:

```bash
npm run lint
npm test
npm run build
```

And manually verify:

- API startup completes
- `/api/health` returns `{ ok: true, service: "nerve-api" }`
- affected protected routes still respect auth and role checks
- any upload or email path works or fails safely

## Brownfield Notes

- There is limited backend-specific automated test coverage today, so operational/manual checks matter.
- The repo still contains retained Supabase schema/function artifacts, but current server-side work should target `server/*.ts` and the Express/Postgres path.
- The branding portal is large enough that changes there should be treated as core backend work, not just a small feature branch on the side.

---

_Generated using BMAD Method `document-project` workflow_
