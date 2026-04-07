# Nerve API Architecture

**Date:** 2026-04-07T16:15:44+05:30
**Part:** API and Data Layer (`server/`)

## Executive Summary

The backend is a single Express service that provides cookie-session authentication, core CRUD APIs, branding-specific operational workflows, file uploads, and email-driven auth support. It boots its own PostgreSQL schema at startup and keeps most domain logic in a small set of server modules rather than a deep folder hierarchy.

## Runtime Responsibilities

- Validate required environment variables
- Start the Express server on `API_PORT`
- Bootstrap database schema and seed records
- Authenticate users with session cookies stored in PostgreSQL
- Serve JSON API responses for the frontend
- Manage uploads under `/uploads`
- Send password reset and email verification messages
- Enforce role/team authorization on sensitive routes

## Startup Sequence

1. `server/config.ts` validates `DATABASE_URL`, `SESSION_SECRET`, and `SUPER_ADMIN_PASSWORD`.
2. `server/index.ts` configures Express, JSON parsing, static uploads, and session middleware.
3. Route handlers are registered, including public auth routes and protected `/api` routes.
4. `bootstrapDatabase()` creates core tables.
5. `bootstrapBrandingDatabase()` creates branding workflow tables.
6. `bootstrapSettingsDatabase()` creates app settings and token tables.
7. The app begins listening on `config.apiPort`.

## Middleware and Request Pipeline

### Global Middleware

- `express.json()`
- `/uploads` static file serving
- `express-session` with `connect-pg-simple`

### Public Route Window

The following remain public:

- `/api/health`
- `/api/auth/*`

### Protected Route Gate

An `app.use("/api", ...)` middleware checks for an authenticated session user and stores that user in `res.locals.currentUser`. Every protected route after that point assumes a current user exists.

### Error Handling

- Expected user-facing failures use `sendError(res, status, message)`
- Async route wrappers use `asyncHandler(...)`
- Unhandled errors fall through to a generic `500 Internal server error` response

## Authorization Model

### Role System

- `super_admin`
- `admin`
- `sub_admin`
- `user`

### Team Model

- `branding`
- `content`
- Custom teams are supported in the core schema

### Authorization Helpers

The backend uses small helper functions instead of a large policy framework:

- `isBrandingManager(...)`
- `requireBranding(...)`
- `requireBrandingAdmin(...)`
- `requireBrandingLead(...)`
- `canCreateManagedUser(...)`

This keeps route-level permission checks explicit and readable.

## Domain Modules

### `server/db.ts`

Core schema/bootstrap and CRUD for:

- teams
- users
- entries
- branding rows

Also exports the shared `pg` pool and seed/bootstrap helpers.

### `server/branding-db.ts`

Branding portal data model and query logic for:

- work categories and sub-categories
- daily reports
- KRA appraisal and peer marking
- branding projects and assignments
- design gallery and voting
- leave workflow

### `server/settings-db.ts`

Settings and auth support persistence for:

- key-value app settings
- password reset tokens
- email verification tokens
- `users.email_verified` evolution

### Supporting Modules

- `server/password.ts`: password hashing and verification
- `server/mailer.ts`: SMTP integration with dev fallback behavior
- `server/seed.ts`: initial admin/team/entry seed data

## Persistence Architecture

The backend uses direct SQL through `pg` instead of an ORM.

### Characteristics

- Tables are created with `CREATE TABLE IF NOT EXISTS`
- Small safe migrations are applied with `ALTER TABLE ... IF NOT EXISTS`
- JSONB is used where flexible scoring or attachment structures are useful
- The same Postgres instance stores both application data and session state

### Operational Implication

Because schema bootstrap happens in app startup code, runtime and schema evolution are tightly coupled. Backend changes that affect persistence should be reviewed alongside deployment/runbook docs.

## API Design

### Contract Style

- JSON request/response bodies
- Stable `{ message }` error payloads
- Session cookie auth for protected routes
- `multipart/form-data` only for upload endpoints

### Major Route Groups

- Public auth and session flows
- Settings and bootstrap
- Core CRUD for entries, users, teams, branding rows
- Branding portal domain routes

Detailed endpoint coverage is documented in [api-contracts-api.md](./api-contracts-api.md).

## File Upload Architecture

Two disk-backed Multer upload pipelines are configured:

- avatars -> `uploads/avatars`, max 3 MB, image MIME types only
- branding designs -> `uploads/branding`, max 10 MB, image MIME types only

Uploaded files are served from `/uploads`.

## External Integrations

- PostgreSQL over `DATABASE_URL`
- SMTP via `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- Nginx reverse proxy to `/api`
- Frontend SPA consuming all JSON contracts

The repo also retains a Supabase Edge Function under `supabase/functions/ai-chat`, but the Express service is the active backend path today.

## Testing and Quality Posture

There is currently strong operational documentation but limited backend-specific automated test coverage in the repo. That means backend changes should be validated with:

- targeted route testing where added
- local manual verification through `npm run dev:local`
- `curl /api/health`
- full deploy pipeline commands when release-related

## Brownfield Constraints

- Do not rely on frontend route guards as the only access control; backend checks are required.
- Changes to auth, env validation, or table definitions can block startup completely.
- Some docs in the repo still describe earlier architectures, so prefer live `server/*.ts` code when resolving conflicts.
- Branding features add a large API surface to a single service, so changes there can have broad operational impact.

## Useful References

- [api-contracts-api.md](./api-contracts-api.md)
- [data-models-api.md](./data-models-api.md)
- [development-guide-api.md](./development-guide-api.md)
- [integration-architecture.md](./integration-architecture.md)

---

_Generated using BMAD Method `document-project` workflow_
