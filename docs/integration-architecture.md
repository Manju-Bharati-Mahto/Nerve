# Nerve Integration Architecture

**Date:** 2026-04-07T16:15:44+05:30

## Overview

Nerve is a multi-part application with a browser SPA and a single backend API service. The integration model is simple but important: the frontend speaks only to the Express API, and the API owns persistence, sessions, uploads, and external service calls.

## Primary Integration Paths

### Frontend -> API

- **Type:** REST over same-origin `/api`
- **Transport:** browser `fetch`
- **Auth:** session cookie via `credentials: "include"`
- **Main client module:** `src/lib/api.ts`

Primary frontend consumers:

- `AuthProvider` -> `/api/auth/me`, `/api/auth/login`, `/api/auth/logout`
- `AppDataProvider` -> `/api/bootstrap`
- pages and actions -> CRUD and branding portal endpoints

### API -> PostgreSQL

- **Type:** direct SQL using `pg`
- **Modules:** `server/db.ts`, `server/branding-db.ts`, `server/settings-db.ts`
- **Responsibility:** app data, workflow data, settings, auth tokens, and session store

### API -> Filesystem

- **Type:** local disk persistence
- **Paths:** `uploads/avatars`, `uploads/branding`
- **Usage:** avatar and branding design uploads

### API -> SMTP

- **Type:** outbound email
- **Usage:** password reset and email verification
- **Fallback:** logs to console when SMTP credentials are missing in development-friendly setups

### Nginx -> API and SPA

- **Type:** reverse proxy + static serving
- **Behavior:** serves built frontend files and forwards `/api/` traffic to `127.0.0.1:3001`

## Request/Data Flow

### Login and Session Restore

1. User opens the SPA.
2. Frontend calls `/api/auth/me`.
3. If no session exists, the user stays on public/login routes.
4. On login, the backend verifies credentials, stores `session.userId`, and returns the user payload.
5. Future frontend requests include the session cookie automatically.

### App Bootstrap

1. `AppDataProvider` sees an authenticated user.
2. It calls `/api/bootstrap`.
3. The API returns entries, users, teams, and branding rows in one payload.
4. Frontend context hydrates shared state for the current session.

### Branding Workflow Example

1. Branding user loads a branding route.
2. Frontend calls branding portal endpoints under `/api/branding/portal/*`.
3. Backend permission helpers verify branding/team access.
4. Backend reads or writes branding workflow tables.
5. JSON responses update the frontend state/UI.

## Integration Boundaries

### Frontend-Owned

- routing and page composition
- local UI state
- presentation and user interactions

### Backend-Owned

- auth truth
- permission enforcement
- persistence
- uploads
- email/token lifecycle

## Retained Integration Paths

The repo still contains retained Supabase artifacts:

- generated client/types under `src/integrations/supabase`
- SQL migrations under `supabase/migrations`
- a Deno Edge Function under `supabase/functions/ai-chat`

These are not part of the active primary integration chain, but they may matter for historical understanding or future migration/reconnect work.

## Brownfield Implications

- Frontend changes that affect auth or bootstrap almost always require backend coordination.
- Backend payload shape changes should be treated as cross-part contract changes.
- The branding portal is backend-heavy; many frontend screens are thin wrappers over a wide server API surface.
- Operational failures in PostgreSQL affect auth/session behavior and application data simultaneously.

---

_Generated using BMAD Method `document-project` workflow_
