# Nerve Frontend Development Guide

**Date:** 2026-04-07T16:15:44+05:30
**Part:** Frontend SPA (`src/`)

## Purpose

This guide covers the frontend-facing development workflow for the React SPA. It assumes the backend and database are available through the local stack or another reachable environment.

## Prerequisites

- Node.js 22.x
- npm
- Docker with Compose plugin for the local full-stack workflow
- `.env.local` copied from `.env.local.example`

## Install

```bash
npm ci
```

## Recommended Local Workflow

Use the full-stack local entrypoint:

```bash
cp .env.local.example .env.local
npm run dev:local
```

Expected local ports:

- Frontend: `http://127.0.0.1:8080`
- API: `http://127.0.0.1:3001`
- PostgreSQL: `127.0.0.1:5432`

## Frontend-Only Commands

If the API is already running elsewhere, you can run just the frontend:

```bash
npm run dev
```

Other useful commands:

```bash
npm run build:client
npm run lint
npm test
npm run preview
```

## Environment Notes

Key frontend variable:

- `VITE_API_BASE_URL` defaults to `/api`

That means the SPA expects either:

- the dev server to proxy or share origin with the API, or
- a deployment environment where Nginx proxies `/api` to the backend

## Frontend File Ownership

- `src/App.tsx`: route tree and provider composition
- `src/hooks/useAuth.tsx`: session restore and auth state
- `src/hooks/useAppData.tsx`: bootstrap and mutation state
- `src/lib/api.ts`: transport layer
- `src/components/`: shell and cross-page components
- `src/pages/`: route implementations

## Adding or Changing Screens

1. Add or update the route-level file under `src/pages/`.
2. Register or update the route in `src/App.tsx`.
3. Protect it with `RoleGuard` if it is not public.
4. Extend `src/lib/api.ts` or provider hooks before adding ad hoc `fetch` calls in a page.
5. Reuse `src/components/ui/*` primitives before introducing new low-level UI building blocks.

## Testing

Frontend tests use Vitest with jsdom:

```bash
npm test
```

Conventions:

- Place tests under `src/**`
- Use `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx`
- Shared DOM/test setup lives in `src/test/setup.ts`

## Common Frontend Pitfalls

- Do not build new features against the retained `src/lib/db.ts` browser store unless the task explicitly targets that legacy path.
- Keep session-dependent logic aligned with `/api/auth/me` and `/api/bootstrap`.
- Remember that route access in the UI is not the only security control; backend authorization still matters.
- The repo contains retained Supabase wiring, but the current frontend uses the Express API client path.

## Verification Checklist

Before merging frontend changes:

```bash
npm run lint
npm test
npm run build:client
```

And manually verify:

- login flow
- dashboard routing by role/team
- affected CRUD or branding portal flow

---

_Generated using BMAD Method `document-project` workflow_
