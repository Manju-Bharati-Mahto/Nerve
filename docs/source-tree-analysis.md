# Nerve - Source Tree Analysis

**Date:** 2026-04-07T16:15:44+05:30

## Overview

Nerve is organized as a multi-part application in a single repository. The active implementation centers on a React frontend in `src/` and an Express backend in `server/`, with shared operational assets at the repo root. Supporting folders include static assets, deployment automation, retained Supabase artifacts, and generated BMAD workflow output.

## Multi-Part Structure

This project is organized into 2 distinct parts:

- **Frontend SPA** (`src/`): Browser UI, routing, role-aware page trees, shared providers, and API calls
- **API and Data Layer** (`server/`): Auth, CRUD, branding workflows, DB bootstrap, uploads, and operational integrations

## Complete Directory Structure

```text
Nerve/
├── src/                          # Active React frontend
│   ├── components/               # App shell, guards, shared UI
│   │   └── ui/                   # shadcn-style primitive library (49 files)
│   ├── hooks/                    # Auth and bootstrap providers
│   ├── lib/                      # API client, types, constants, utilities
│   ├── pages/                    # Route-level screens
│   │   ├── branding/             # Branding-team dashboards and tools
│   │   └── content/              # Content-team dashboards
│   ├── integrations/supabase/    # Retained Supabase client/types
│   └── test/                     # Vitest setup and examples
├── server/                       # Active Express API
│   ├── index.ts                  # Route registration and startup
│   ├── db.ts                     # Core schema/bootstrap and CRUD
│   ├── branding-db.ts            # Branding portal schema and queries
│   ├── settings-db.ts            # Settings and auth token persistence
│   ├── config.ts                 # Required env validation
│   ├── mailer.ts                 # SMTP / fallback mail handling
│   ├── password.ts               # Password hashing helpers
│   └── seed.ts                   # Initial seed data
├── public/                       # Static images and browser assets
├── uploads/                      # Runtime-uploaded branding/avatar files
├── deploy/
│   └── scripts/                  # Deploy, backup, restore, validate scripts
├── nginx/                        # VPS Nginx config
├── supabase/                     # Retained cloud schema/functions
│   ├── functions/ai-chat/        # Retained Deno Edge Function
│   └── migrations/               # Retained Supabase SQL schema
├── docs/                         # Generated brownfield documentation
├── _bmad-output/                 # BMAD-generated implementation context
├── docker-compose.yml            # Base DB + API stack
├── docker-compose.dev.yml        # Local DB port override
├── Dockerfile.api                # API container build
├── package.json                  # Shared workspace scripts and deps
├── DEPLOYMENT.md                 # VPS deployment runbook
├── ENVIRONMENT.md                # Env variable reference
├── OPERATIONS.md                 # Backups and operational tasks
└── TROUBLESHOOTING.md            # Runtime/debugging guide
```

## Critical Directories

### `src/`

Primary frontend application code.

**Purpose:** Route composition, provider setup, UI behavior, and API consumption.
**Contains:** `App.tsx`, page components, hooks, API client, types, and test scaffolding.
**Entry Points:** `src/main.tsx`, `src/App.tsx`
**Integration:** Calls `/api/*` using `src/lib/api.ts`

### `src/components/ui/`

Reusable UI primitive library.

**Purpose:** Centralized presentation layer based on Radix/shadcn patterns.
**Contains:** 49 primitive component files for forms, overlays, tables, navigation, feedback, and layout.

### `src/pages/`

Route-level screens.

**Purpose:** Business-facing UI by role/team.
**Contains:** 27 route files split across shared, branding, and content areas.

### `server/`

Backend runtime implementation.

**Purpose:** REST API, session auth, SQL bootstrap, role checks, and integrations.
**Contains:** Entry point, DB modules, env config, mailer, password helpers, and seeds.
**Entry Points:** `server/index.ts`
**Integration:** Serves JSON to frontend, persists to PostgreSQL, writes uploads to disk, sends mail through SMTP

### `deploy/scripts/`

Operational automation.

**Purpose:** Deployment and database lifecycle operations.
**Contains:** `deploy.sh`, `backup-postgres.sh`, `restore-postgres.sh`, `test-restore.sh`.

### `nginx/`

HTTP serving and reverse proxy config.

**Purpose:** Serves SPA assets and proxies `/api` to the backend.
**Contains:** Production VPS site config and template.

### `supabase/`

Retained cloud implementation artifacts.

**Purpose:** Historical schema and optional future migration/reference material.
**Contains:** Supabase migrations, config, and AI Edge Function source.

## Part-Specific Trees

### Frontend SPA Structure

```text
src/
├── main.tsx
├── App.tsx
├── App.css
├── index.css
├── components/
│   ├── AppLayout.tsx
│   ├── AppSidebar.tsx
│   ├── NavLink.tsx
│   ├── RoleGuard.tsx
│   └── ui/
├── hooks/
│   ├── useAuth.tsx
│   ├── useAppData.tsx
│   ├── use-mobile.tsx
│   └── use-toast.ts
├── lib/
│   ├── api.ts
│   ├── app-types.ts
│   ├── constants.ts
│   ├── db.ts
│   └── utils.ts
├── pages/
│   ├── branding/
│   ├── content/
│   └── *.tsx
├── integrations/supabase/
└── test/
```

**Key Directories:**

- **`src/components`**: Shared app shell and navigation components
- **`src/components/ui`**: Reusable primitive design system
- **`src/hooks`**: Session restore and app bootstrap providers
- **`src/lib`**: Request layer, types, constants, and retained legacy store
- **`src/pages/branding`**: Branding dashboards and team experiences
- **`src/pages/content`**: Content dashboards and team experiences

### API and Data Layer Structure

```text
server/
├── index.ts
├── db.ts
├── branding-db.ts
├── settings-db.ts
├── config.ts
├── mailer.ts
├── password.ts
├── seed.ts
└── connect-pg-simple.d.ts
```

**Key Directories:**

- **`server/index.ts`**: Middleware, route registration, startup bootstrap
- **`server/db.ts`**: Core users/teams/entries/branding rows schema and CRUD
- **`server/branding-db.ts`**: Branding portal schema and data access
- **`server/settings-db.ts`**: Key-value settings and auth token tables

## Integration Points

### Frontend SPA -> API and Data Layer

- **Location:** `src/lib/api.ts`
- **Type:** Cookie-authenticated REST
- **Details:** All primary data mutations and bootstrap flows call `/api/*` with JSON payloads and `credentials: "include"`

### API and Data Layer -> PostgreSQL

- **Location:** `server/db.ts`, `server/branding-db.ts`, `server/settings-db.ts`
- **Type:** Direct SQL over `pg`
- **Details:** API startup bootstraps tables; runtime queries implement CRUD and workflow logic

### API and Data Layer -> Filesystem Uploads

- **Location:** `server/index.ts`, `uploads/`
- **Type:** Disk-backed upload storage
- **Details:** Avatar uploads go to `uploads/avatars`; branding design images go to `uploads/branding`

### API and Data Layer -> SMTP

- **Location:** `server/mailer.ts`
- **Type:** Email integration
- **Details:** Password reset and email verification flows send email when SMTP credentials are configured, otherwise fall back to console logging in development

### Frontend SPA -> Retained Supabase Artifacts

- **Location:** `src/integrations/supabase/*`, `supabase/*`
- **Type:** Retained reference path
- **Details:** Useful for migration/history context, but not part of the main runtime path today

## Entry Points

### Frontend SPA

- **Entry Point:** `src/main.tsx`
- **Bootstrap:** Mounts the React tree and hands off to `src/App.tsx`

### API and Data Layer

- **Entry Point:** `server/index.ts`
- **Bootstrap:** Validates env, configures middleware, bootstraps all DB modules, then starts listening on `API_PORT`

## File Organization Patterns

- Route screens live in `src/pages` and are separated by team when team-specific.
- Reusable structural components live in `src/components`, while low-level primitives live in `src/components/ui`.
- Frontend data access is centralized in `src/lib/api.ts`; hooks coordinate lifecycle and local state.
- Backend responsibilities are grouped by domain module instead of nested folders: core DB, branding DB, settings DB, config, and helpers.
- Operational runbooks stay in root markdown files, while executable automation stays under `deploy/scripts`.

## Key File Types

### Frontend Route Components

- **Pattern:** `src/pages/**/*.tsx`
- **Purpose:** Route-level UI and feature screens
- **Examples:** `src/pages/Login.tsx`, `src/pages/branding/BrandingAdminDashboard.tsx`

### Shared UI Primitives

- **Pattern:** `src/components/ui/*.tsx`
- **Purpose:** Design-system-style reusable primitives
- **Examples:** `src/components/ui/button.tsx`, `src/components/ui/dialog.tsx`

### Backend Runtime Modules

- **Pattern:** `server/*.ts`
- **Purpose:** API startup, persistence, auth, and integrations
- **Examples:** `server/index.ts`, `server/branding-db.ts`

### Operational Scripts

- **Pattern:** `deploy/scripts/*.sh`
- **Purpose:** Deploy, backup, restore, and verification tasks
- **Examples:** `deploy/scripts/deploy.sh`, `deploy/scripts/backup-postgres.sh`

### Retained Cloud Artifacts

- **Pattern:** `supabase/**`
- **Purpose:** Historical or optional cloud-side schema/function reference
- **Examples:** `supabase/functions/ai-chat/index.ts`, `supabase/migrations/*.sql`

## Asset Locations

- **Public browser assets**: `public/` (11 files)
- **Runtime uploads**: `uploads/` (branding images and avatar files)
- **Deployment/runtime templates**: `nginx/` and `deploy/`

## Configuration Files

- **`package.json`**: Shared scripts, dependencies, and build targets
- **`vite.config.ts`**: Frontend bundling configuration
- **`vitest.config.ts`**: Frontend test environment and aliases
- **`tsconfig.server.json`**: Strict backend TypeScript compilation
- **`docker-compose.yml`**: DB + API runtime composition
- **`docker-compose.dev.yml`**: Local DB port exposure
- **`nginx/nerve.conf`**: SPA serving and `/api` reverse proxy
- **`.env.example` / `.env.local.example`**: Required configuration examples

## Notes for Development

- Prefer the active `src/lib/api.ts` + `server/index.ts` flow over the retained local-storage and Supabase paths unless a task explicitly targets those artifacts.
- The frontend and backend compile differently; backend strictness is higher and deployment builds both parts together.
- For brownfield planning, treat `src/` and `server/` as separate implementation surfaces connected by a stable JSON API contract.

---

_Generated using BMAD Method `document-project` workflow_
