---
project_name: 'Nerve'
user_name: 'Opsa'
date: '2026-04-07T16:10:28+05:30'
sections_completed: ['technology_stack', 'language_rules', 'framework_rules', 'testing_rules', 'quality_rules', 'workflow_rules', 'anti_patterns']
existing_patterns_found: 8
status: 'complete'
rule_count: 86
optimized_for_llm: true
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

- Frontend: React 18.3.1, React DOM 18.3.1, React Router DOM 6.30.1
- State/data layer: TanStack React Query 5.83.0, custom React context providers in `src/hooks`
- Language/tooling: TypeScript 5.8.3, Vite 5.4.19, `@vitejs/plugin-react-swc` 3.11.0
- UI stack: Tailwind CSS 3.4.17, Radix UI primitives, class-variance-authority 0.7.1, lucide-react 0.462.0, shadcn-style components under `src/components/ui`
- Backend: Express 4.21.2 running as a separate Node service, `pg` 8.16.3, `connect-pg-simple` 10.0.0, Multer 2.1.1, Zod 3.25.76
- Database/runtime infra: PostgreSQL via `pgvector/pgvector:pg16`, Docker Compose for local and deployed environments
- Testing: Vitest 3.2.4 with jsdom and Testing Library, Playwright 1.57.0 present for browser automation
- Build/runtime split: frontend builds with Vite; server builds with `tsc -p tsconfig.server.json` into `dist-server`
- Import alias: `@/*` maps to `src/*`
- TypeScript strictness is intentionally split: frontend/app tsconfig is permissive (`strict: false`), while server tsconfig is strict (`strict: true`)
- Supabase artifacts still exist in the repo, but the active app/runtime path is the Express API plus current React frontend unless a task explicitly targets retained Supabase code

## Critical Implementation Rules

### Language-Specific Rules

- Treat the frontend and server as two different TypeScript environments: `src/**` uses permissive TS settings, but `server/**` must satisfy strict TypeScript in `tsconfig.server.json`
- Use ESM-style imports/exports consistently; server-side local imports should keep the emitted `.js` extension pattern used throughout `server/**`
- Prefer the `@/` alias for frontend imports that target `src/**`; avoid deep relative imports when an alias path is clearer
- Keep shared domain shapes aligned across frontend and server types; when API payloads change, update both `src/lib/app-types.ts` and the corresponding server-side types/schemas
- Validate incoming API payloads with `zod` at the Express boundary instead of trusting request bodies
- Prefer explicit fallback/default normalization when mapping DB rows or request payloads, following patterns like `row.field || ""`, `?? null`, and array guards
- Use `async`/`await` for asynchronous flows and wrap Express async handlers with the project’s `asyncHandler` pattern rather than leaving promise rejections unhandled
- Return JSON error payloads with a stable `message` field because the frontend request helper depends on `payload.message` for surfaced errors
- Keep browser fetch helpers centralized in `src/lib/api.ts`; do not scatter raw `fetch` calls across pages when the call belongs in the shared API client
- Preserve existing semicolon style in server files and existing no-semicolon style where already established in some frontend hook files unless you are intentionally normalizing the whole file
- Follow the repo’s current tolerance for unused parameters/locals when needed for framework signatures, but do not add unnecessary dead code just because lint permits it

### Framework-Specific Rules

- Keep the provider stack in `src/App.tsx` intact: `QueryClientProvider` -> `AuthProvider` -> `AppDataProvider` -> UI providers -> router
- Add authenticated pages under the shared `AppLayout` route tree unless the page is intentionally public like login, reset-password, or verify-email
- Protect role-based pages with `RoleGuard`; do not rely on navigation hiding alone for access control
- When adding routes, preserve the existing role/team model: `super_admin`, `admin`, `sub_admin`, `user`, with team-aware restrictions for `branding` and `content`
- Use `getRoleDashboard` and existing redirect patterns for unauthorized or legacy-route navigation instead of inventing new fallback routes
- Keep page-level business data flowing through shared hooks/providers first; prefer extending `useAuth`, `useAppData`, or `src/lib/api.ts` before adding isolated page-local data plumbing
- Reuse shadcn-style primitives from `src/components/ui` before creating new base components; new primitives should match the existing lower-case file naming in that folder
- Keep page and feature components in PascalCase files under `src/pages` and `src/components`; reserve lower-case file names primarily for UI primitives and utility modules
- Preserve the current API contract style: frontend requests send `credentials: "include"` and backend auth is session-cookie based, so new auth-sensitive endpoints must remain compatible with cookie-backed sessions
- Put public backend routes under `/api/auth/*` or other explicitly public paths; all other `/api` routes are expected to pass through the session-check middleware
- On the Express side, prefer small helper guards such as `requireBranding`, `requireBrandingAdmin`, and `requireBrandingLead` for role/team authorization instead of duplicating permission logic inline
- Use the shared `sendError` helper for predictable JSON error responses and rely on the central Express error middleware for unexpected failures
- For uploads, follow the existing Multer disk-storage pattern and expose files through `/uploads`; do not invent a second upload mechanism unless the feature truly needs one
- Treat the branding portal routes as an extension of the same API, not a separate service; keep their auth and response style aligned with the rest of `server/index.ts`

### Testing Rules

- Use Vitest for frontend/unit-style tests; the canonical command is `npm test` and watch mode is `npm run test:watch`
- Place test files under `src/**` using the existing `*.test.ts`, `*.test.tsx`, `*.spec.ts`, or `*.spec.tsx` naming convention matched by `vitest.config.ts`
- Assume the default frontend test environment is `jsdom`; browser-dependent behavior should rely on the shared setup in `src/test/setup.ts`
- Reuse the existing Testing Library and `@testing-library/jest-dom` setup for UI/component assertions instead of inventing custom DOM test helpers
- Extend `src/test/setup.ts` only when a missing browser API shim is broadly useful across tests; do not duplicate one-off `window` mocks in many files if they belong in shared setup
- Prefer testing user-visible behavior and route/provider outcomes over implementation details such as internal state setter calls
- When adding API-client or provider tests, mock network boundaries cleanly rather than hitting a live server from unit tests
- Keep unit/frontend tests separate from any future server integration tests; the current Vitest config does not automatically include `server/**` test files
- Playwright is available for browser automation, but its config is still mostly scaffolded; treat end-to-end coverage as explicit follow-up work, not something implicitly already wired up
- Because the repo currently has minimal test coverage, any non-trivial feature change should add at least focused regression coverage for the logic, route guard, form behavior, or API-client flow being changed
- If a change is hard to test directly, prefer extracting a small testable helper or isolating logic instead of skipping coverage without explanation

### Code Quality & Style Rules

- Run `eslint .`-compatible code, but do not assume ESLint alone defines all style decisions; match the surrounding file’s existing quote, semicolon, and spacing style
- Preserve local consistency inside each file rather than mixing styles; some frontend files use no-semicolon single-quote style while many shared/UI/server files use semicolons and double quotes
- Use PascalCase file names for pages, layouts, route components, and higher-level reusable components
- Use lower-case file names for shadcn-style UI primitives and small utility modules, especially under `src/components/ui`
- Prefer shared helpers before duplicating logic: use `cn` from `src/lib/utils.ts`, `getErrorMessage` from `src/lib/error-utils.ts`, and the centralized API client in `src/lib/api.ts`
- Keep domain types in `src/lib/app-types.ts` and constants/role enums in `src/lib/constants.ts` instead of redefining shapes inline in pages
- Favor small compatibility wrappers and composition patterns, like `NavLink.tsx`, instead of spreading library-specific glue code across many pages
- Reuse existing UI building blocks from `src/components/ui` before adding raw duplicated markup for common controls
- Keep comments sparse and useful; the repo uses occasional section-divider comments, but not heavy explanatory commenting
- Prefer explicit interface/type names for component props and domain records when the shape is reused or non-trivial
- Keep user-facing error handling readable and consistent by surfacing short fallback messages rather than raw unknown errors
- Avoid scattering magic strings for roles, teams, priorities, or entry types when constants already exist
- Follow the existing folder split: pages in `src/pages`, shared components in `src/components`, hooks in `src/hooks`, generic utilities/types in `src/lib`, and backend concerns in `server`
- Do not introduce a new architectural layer or helper abstraction unless at least two call sites clearly benefit from it; the repo generally favors direct, readable implementations over heavy indirection

### Development Workflow Rules

- For local feature work, prefer the documented full-stack entrypoint `npm run dev:local`; it starts Docker PostgreSQL plus the host API watcher and Vite dev server together
- Treat `.env.local` as the required local-development env file and `/srv/nerve/shared/env/.env` as the deployed/shared env source; do not hardcode secrets into code or checked-in config
- Server startup depends on required env validation in `server/config.ts`; features that add required configuration must update the documented env surface as well
- Keep frontend API calls compatible with `VITE_API_BASE_URL`, which defaults to `/api`; do not bake absolute localhost URLs into app code
- The normal validation path before release is `npm ci`, `npm run lint`, `npm test`, and `npm run build`, matching `deploy/scripts/deploy.sh`
- Production deployment expects the frontend and API to be released together: frontend assets are synced into a timestamped release directory and the backend is rebuilt via Docker Compose
- Do not assume deployment is a simple static-site publish; the running system includes Nginx, the Express API container, and PostgreSQL
- Preserve the symlink-based release model in deploy automation: `/srv/nerve/releases/current` points to the active frontend build
- If a change affects database behavior, env requirements, or operational procedures, update the matching runbook docs such as `ENVIRONMENT.md`, `DEPLOYMENT.md`, `OPERATIONS.md`, or `TROUBLESHOOTING.md`
- Use the existing healthcheck and verification conventions when validating runtime changes: `/api/health`, Docker Compose status, and documented local URLs/ports
- Keep local/dev assumptions aligned with the documented ports: frontend `127.0.0.1:8080`, API `127.0.0.1:3001`, PostgreSQL `127.0.0.1:5432`
- Deployment defaults to pulling from the configured upstream repo and branch, so changes that rely on untracked local machine state are not safe deployment assumptions

### Critical Don't-Miss Rules

- Do not implement against the older localStorage-only runtime described in legacy docs when the task is about the current app; prefer the active Express API plus PostgreSQL path unless the task explicitly targets retained or legacy code
- Do not assume Supabase is the active runtime just because related files remain in the repo; touch those paths only when the task explicitly calls for retained cloud architecture work
- Never expose password hashes, reset tokens, session secrets, SMTP credentials, or raw env values in API responses, logs, tests, or seeded fixtures
- Do not reintroduce the legacy super-admin default password; `server/config.ts` explicitly blocks it for deployed runtime configuration
- Do not trust client-supplied privileged fields such as `created_by`, role, or team assignment when the server should derive them from the authenticated session
- Do not rely on `RoleGuard` alone for security; every sensitive backend route still needs server-side authorization checks
- Preserve anti-enumeration behavior on auth flows like forgot-password and verification-related endpoints; avoid changes that confirm whether an email exists unless the feature explicitly requires it
- Keep API response shapes stable and JSON-based; if a payload shape changes, update the shared frontend client/types in the same change
- Do not add a second source of truth for auth or bootstrap data outside the existing providers and shared API client without a strong architectural reason
- For uploads, keep MIME and size validation on the server and do not trust client-side file filtering alone
- Missing SMTP credentials intentionally fall back to console logging in development; do not mistake that for real mail delivery or rely on it in production behavior
- The backend error middleware intentionally returns a generic internal error message; avoid leaking raw stack traces or DB error details to clients
- When docs and code disagree, prefer the active code path and update the docs rather than coding to stale documentation

---

## Usage Guidelines

**For AI Agents:**

- Read this file before implementing any code
- Follow all rules exactly as documented
- When in doubt, prefer the more restrictive option
- Update this file if new recurring patterns emerge

**For Humans:**

- Keep this file lean and focused on agent needs
- Update it when technology, deployment, or auth patterns change
- Review it periodically for stale rules
- Remove rules that become obvious or no longer match the codebase

Last Updated: 2026-04-07T16:10:28+05:30
