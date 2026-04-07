# Nerve Frontend Architecture

**Date:** 2026-04-07T16:15:44+05:30
**Part:** Frontend SPA (`src/`)

## Executive Summary

The frontend is a `Vite + React + TypeScript` single-page application that renders role-aware dashboards and operational screens for Parul University teams. It uses a small number of shared providers for auth and app bootstrap, centralizes network access in a single API client, and organizes routes by public pages, shared tools, and team-specific dashboards.

## Responsibilities

- Restore the current session and expose auth context
- Load shared bootstrap data after login
- Enforce route access through `RoleGuard`
- Render shared/admin/team-specific pages
- Send CRUD and workflow requests to the backend
- Present uploads, settings, and branding-specific workflow UIs

## Runtime Flow

1. `src/main.tsx` mounts the React app.
2. `src/App.tsx` composes providers in this order:
   `QueryClientProvider` -> `AuthProvider` -> `AppDataProvider` -> UI providers -> `BrowserRouter`.
3. `AuthProvider` calls `api.getMe()` on startup to restore the session.
4. `AppDataProvider` reacts to `user` presence and calls `api.bootstrap()` to load entries, users, teams, and branding rows.
5. `RoleGuard` gates route elements by role and optional team membership.
6. Pages call methods from `useAppData()` or `api` helpers to mutate backend state.

## Route Architecture

### Public Routes

- `/login`
- `/reset-password`
- `/verify-email`

### Shared Authenticated Shell

All authenticated routes live beneath `AppLayout`, which owns the shared shell/sidebar behavior.

### Role and Team Segments

- `super_admin/*`: global administration
- `branding/*`: branding team dashboards, browse, and team tools
- `content/*`: content team dashboards and team tools
- `/admin/export`, `/ai/query`, `/ai/newsletter`: shared tools
- `/add`: shared entry creation for non-branding teams
- `/browse`: authenticated browsing for all users

## State and Data Patterns

### Auth State

- Implemented in `src/hooks/useAuth.tsx`
- Stores `user`, `role`, `team`, and `loading`
- Provides `signIn`, `signOut`, and dashboard routing helpers

### App Data State

- Implemented in `src/hooks/useAppData.tsx`
- Keeps `entries`, `users`, `teams`, `brandingRows`, `loading`, and `error`
- Exposes mutation helpers that mirror the backend contract

### Network Access

- Centralized in `src/lib/api.ts`
- Uses `fetch`
- Sends `credentials: "include"` on every request
- Throws from a normalized `payload.message`

## Component Structure

### App Shell

- `AppLayout.tsx`: top-level authenticated frame
- `AppSidebar.tsx`: navigation shell
- `NavLink.tsx`: route-aware link abstraction
- `RoleGuard.tsx`: route access control wrapper

### Primitive UI Layer

`src/components/ui/` contains the reusable low-level design-system layer. It includes buttons, inputs, tables, dialogs, drawers, menus, tabs, toast systems, form wrappers, and layout helpers built around Radix primitives and Tailwind styling.

### Page Organization

- Shared pages in `src/pages/*.tsx`
- Branding pages in `src/pages/branding/*.tsx`
- Content pages in `src/pages/content/*.tsx`

This keeps route ownership close to the role/team domain while reusing the same provider and shell structure.

## API Integration

The frontend has a strict client-server split:

- `src/lib/api.ts` defines the transport contract
- `useAuth` owns session-related API calls
- `useAppData` owns bootstrap and CRUD synchronization
- Pages should prefer those shared entrypoints instead of direct `fetch` calls

Important backend entrypoints consumed by the frontend include:

- `/api/auth/me`, `/api/auth/login`, `/api/auth/logout`
- `/api/bootstrap`
- CRUD endpoints for entries, users, teams, and branding rows
- Branding portal endpoints for the branding-specific dashboards

## Retained and Legacy Frontend Paths

Two frontend-adjacent paths are important context but not the primary runtime:

- `src/lib/db.ts` preserves an older browser-only data store and seed dataset. It is useful as historical/reference context, but current auth/bootstrap flows call the API instead.
- `src/integrations/supabase/*` and `supabase/*` preserve the former cloud integration model. They should be treated as retained artifacts unless a task explicitly reconnects or migrates that path.

## Testing Strategy

- Test runner: Vitest
- DOM environment: jsdom
- Setup file: `src/test/setup.ts`
- Match pattern: `src/**/*.{test,spec}.{ts,tsx}`

Coverage is still light, so brownfield changes should add focused regression tests around route gating, provider behavior, or page-level workflows when practical.

## Frontend Constraints and Design Decisions

- Route protection happens in the UI through `RoleGuard`, but backend authorization remains the real security boundary.
- Team-specific dashboards are implemented as separate page trees instead of a single mega-dashboard with branching inside.
- The provider stack is intentionally small and centralized; spreading new app-wide state into page-local islands will make the app harder to reason about.
- The primitive UI folder is broad, so new features should reuse it before creating parallel component foundations.

## Risks and Brownfield Notes

- Legacy runtime references can be misleading if you only scan filenames. Prefer live provider and API flows over the retained local-store path.
- The branding area is feature-dense and coupled to a larger backend surface than the rest of the app.
- Because auth restore and bootstrap happen in separate providers, changes that affect either endpoint can ripple widely across the frontend.

## Useful References

- [project-overview.md](./project-overview.md)
- [component-inventory-frontend.md](./component-inventory-frontend.md)
- [development-guide-frontend.md](./development-guide-frontend.md)
- [integration-architecture.md](./integration-architecture.md)

---

_Generated using BMAD Method `document-project` workflow_
