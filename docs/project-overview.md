# Nerve - Project Overview

**Date:** 2026-04-07T16:15:44+05:30
**Type:** Multi-part web application
**Architecture:** React SPA + Express REST API + PostgreSQL

## Executive Summary

Nerve is a role-based internal knowledge hub for Parul University teams. The current implementation is a single repository that contains two active runtime parts: a `Vite + React + TypeScript` frontend under `src/` and an `Express + PostgreSQL` backend under `server/`. Together they provide session-based authentication, team-aware dashboards, CRUD flows for entries and users, branding-specific workflow modules, file uploads, and deployment automation for an Ubuntu VPS.

The codebase also contains two retained but non-primary paths that matter for brownfield work:

- `src/lib/db.ts` preserves an older browser-only `localStorage` data model that is no longer the active app runtime.
- `supabase/` preserves earlier cloud schema and Edge Function artifacts that can inform future reconnect/migration work, but the live code path now runs through the local Express API and PostgreSQL schema bootstrap.

## Project Classification

- **Repository Type:** Multi-part repository
- **Project Type(s):** `web` frontend + `backend` API
- **Primary Language(s):** TypeScript, SQL, Bash
- **Architecture Pattern:** SPA client, cookie-session REST API, Postgres-backed service layer

## Multi-Part Structure

This project consists of 2 distinct parts:

### Frontend SPA

- **Type:** Web frontend
- **Location:** `src/`
- **Purpose:** Browser UI, routing, role-aware page composition, and API consumption
- **Tech Stack:** React 18, React Router, TanStack React Query, Tailwind CSS, Radix/shadcn-style UI, Vite

### API and Data Layer

- **Type:** Backend service
- **Location:** `server/`
- **Purpose:** Session auth, CRUD endpoints, branding portal workflows, DB bootstrap, uploads, SMTP-backed auth emails
- **Tech Stack:** Express 4, `pg`, `express-session`, `connect-pg-simple`, Zod, Multer, PostgreSQL/pgvector

### How Parts Integrate

The frontend calls the backend over `/api` using `fetch` with `credentials: "include"` in `src/lib/api.ts`. The backend uses cookie-backed sessions stored in PostgreSQL, exposes uploads from `/uploads`, and returns JSON payloads shaped for the frontend providers in `src/hooks/useAuth.tsx` and `src/hooks/useAppData.tsx`.

## Technology Stack Summary

### Frontend SPA Stack

| Category | Technology | Notes |
| --- | --- | --- |
| Runtime | React 18.3.1 | Main UI runtime |
| Routing | React Router DOM 6.30.1 | Route tree and redirects |
| Data loading | TanStack React Query 5.83.0 | Provider present; app state still mostly custom context-driven |
| Styling | Tailwind CSS 3.4.17 | Utility styling |
| UI primitives | Radix UI + shadcn-style components | `src/components/ui` |
| Build | Vite 5.4.19 + SWC React plugin | Frontend bundling |
| Testing | Vitest + Testing Library + jsdom | Frontend unit/component coverage |

### API and Data Layer Stack

| Category | Technology | Notes |
| --- | --- | --- |
| HTTP server | Express 4.21.2 | Single API entrypoint in `server/index.ts` |
| Validation | Zod 3.25.76 | Request payload validation |
| Sessions | `express-session` + `connect-pg-simple` | Cookie session store in Postgres |
| Database | PostgreSQL 16 via `pgvector/pgvector:pg16` | Core persistence and session store |
| DB client | `pg` 8.16.3 | Direct SQL access |
| Uploads | Multer 2.1.1 | Avatar and branding design uploads |
| Email | Nodemailer 8 | Password reset and verification emails |
| Packaging | TypeScript build to `dist-server/` | Backend compile step |

## Key Features

- Role-based login and dashboard routing for `super_admin`, `admin`, `sub_admin`, and `user`
- Team-aware paths for `branding` and `content`
- Knowledge entry creation, browsing, deletion, and bootstrap loading
- User and team administration
- Branding row tracking and branding portal workflows
- Branding daily reports, analytics, KRA self/peer/admin scoring, design gallery, project assignment, and leave management
- SMTP-assisted forgot-password and email verification flows
- Deployment automation for a VPS with Docker, Nginx, and PostgreSQL

## Architecture Highlights

- The active frontend boot sequence is `src/main.tsx` -> `src/App.tsx` -> provider stack -> route tree.
- Auth restoration happens through `/api/auth/me`; app bootstrap data loads through `/api/bootstrap`.
- The backend protects almost all `/api/*` routes through a session middleware wrapper placed after public auth endpoints.
- Database schema is code-bootstrapped on API startup through `bootstrapDatabase()`, `bootstrapBrandingDatabase()`, and `bootstrapSettingsDatabase()`.
- Branding portal logic is intentionally kept inside the same API service, not split into a separate microservice.
- Retained Supabase assets remain useful context, but they are not the current primary runtime path.

## Development Overview

### Prerequisites

- Node.js 22.x
- npm
- Docker with Compose plugin
- A local `.env.local` or deployed `/srv/nerve/shared/env/.env`

### Getting Started

The main local workflow is `npm run dev:local`. That script starts PostgreSQL through Docker Compose, sources `.env.local`, launches the API watcher on `127.0.0.1:3001`, and launches Vite on `127.0.0.1:8080`.

### Key Commands

#### Frontend SPA

- **Install:** `npm ci`
- **Dev:** `npm run dev`

#### API and Data Layer

- **Install:** `npm ci`
- **Dev:** `npm run dev:server`

## Repository Structure

The repo root combines app code, runtime config, deployment scripts, retained Supabase artifacts, BMAD planning output, and uploaded static assets. The most important production paths are `src/`, `server/`, `deploy/`, `nginx/`, `public/`, and the root Docker/env files.

## Documentation Map

For detailed information, see:

- [index.md](./index.md) - Master documentation index
- [architecture-frontend.md](./architecture-frontend.md) - Frontend architecture
- [architecture-api.md](./architecture-api.md) - Backend architecture
- [source-tree-analysis.md](./source-tree-analysis.md) - Directory structure
- [development-guide-frontend.md](./development-guide-frontend.md) - Frontend workflow
- [development-guide-api.md](./development-guide-api.md) - Backend workflow

---

_Generated using BMAD Method `document-project` workflow_
