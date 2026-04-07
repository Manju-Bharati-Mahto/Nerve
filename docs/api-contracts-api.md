# Nerve API Contracts

**Date:** 2026-04-07T16:15:44+05:30
**Part:** API and Data Layer (`server/`)

## Contract Conventions

- Base path: `/api`
- Authentication: cookie-backed session for all protected routes
- Content type: JSON unless noted as multipart upload
- Error format: `{ "message": "..." }`
- Protected-route current user: loaded into `res.locals.currentUser`

## Public and Auth Routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | Public | Health check |
| GET | `/api/auth/me` | Public | Return current session user or `null` |
| POST | `/api/auth/login` | Public | Authenticate and set session |
| POST | `/api/auth/logout` | Public | Destroy session |
| POST | `/api/auth/forgot-password` | Public | Issue password-reset email without enumeration |
| POST | `/api/auth/reset-password` | Public | Consume reset token and set new password |
| POST | `/api/auth/send-verification` | Public | Send verification email |
| GET | `/api/auth/verify-email` | Public | Consume verification token |

### Key Auth Payloads

- `POST /api/auth/login`
  - request: `{ email, password }`
  - response: `{ user }`
- `POST /api/auth/forgot-password`
  - request: `{ email }`
  - response: `{ ok: true }`
- `POST /api/auth/reset-password`
  - request: `{ token, password }`
  - response: `{ ok: true }`

## Core App Routes

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/settings` | `super_admin` | Read app settings |
| PATCH | `/api/settings` | `super_admin` | Update allow-listed app settings |
| GET | `/api/bootstrap` | Authenticated | Load entries, users, teams, and branding rows |
| GET | `/api/entries` | Authenticated | List entries |
| POST | `/api/entries` | Authenticated | Create entry |
| DELETE | `/api/entries/:id` | Authenticated | Delete entry |
| GET | `/api/users` | Authenticated | List users |
| POST | `/api/users` | Super admin or constrained admin | Create managed user |
| PATCH | `/api/users/me` | Authenticated | Update own profile basics |
| POST | `/api/users/me/avatar` | Authenticated, multipart | Upload own avatar |
| PATCH | `/api/users/:id` | `super_admin` or branding admin | Update target user with extra restrictions |
| DELETE | `/api/users/:id` | `super_admin` or branding admin | Delete target user with restrictions |
| GET | `/api/teams` | Authenticated | List teams |
| POST | `/api/teams` | `super_admin` | Create team |
| DELETE | `/api/teams/:id` | `super_admin` | Delete team if unassigned |
| GET | `/api/branding-rows` | Branding team | List branding rows |
| POST | `/api/branding-rows` | Branding team | Create branding row |
| PATCH | `/api/branding-rows/:id` | Branding team | Update branding row |
| DELETE | `/api/branding-rows/:id` | Branding team | Delete branding row |

### Core Payload Notes

- `POST /api/entries`
  - request fields: `title`, `dept`, `type`, `body`, `priority`, `entry_date`, optional tags/metadata
  - server derives `created_by` from current session
- `POST /api/users/me/avatar`
  - multipart field: `avatar`
  - response: `{ user, avatar_url }`

## Branding Portal: Taxonomy

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/branding/portal/categories` | Branding team | List work categories and sub-categories |
| POST | `/api/branding/portal/categories` | Branding admin/super | Create category |
| PATCH | `/api/branding/portal/categories/:id` | Branding admin/super | Rename category |
| DELETE | `/api/branding/portal/categories/:id` | Branding admin/super | Delete category |
| POST | `/api/branding/portal/categories/reorder` | Branding admin/super | Reorder categories |
| POST | `/api/branding/portal/categories/:id/sub` | Branding admin/super | Create sub-category |
| PATCH | `/api/branding/portal/sub-categories/:id` | Branding admin/super | Rename sub-category |
| DELETE | `/api/branding/portal/sub-categories/:id` | Branding admin/super | Delete sub-category |

## Branding Portal: Daily Reports and Analytics

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/branding/portal/report` | Branding team | Get or create current user's report for a date |
| PUT | `/api/branding/portal/report/:reportId/rows` | Branding team | Save report rows |
| POST | `/api/branding/portal/report/:reportId/submit` | Branding team | Submit and lock a report |
| GET | `/api/branding/portal/reports` | Branding team | Query reports with filters |
| GET | `/api/branding/portal/analytics` | Branding team | Get analytics for a user/date range |
| GET | `/api/branding/portal/team/report-status` | Branding lead/admin/super | Team report completion status |

### Report Query Parameters

- `date`
- `userId` for admin/super paths
- `dateFrom`, `dateTo`
- `typeOfWork`
- `subCategory`
- `collaborator`
- `lockedOnly`

## Branding Portal: KRA Appraisal

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/branding/portal/kra/parameters` | Branding team | List KRA parameters |
| GET | `/api/branding/portal/kra/peer-marking-enabled` | Branding team | Check peer-marking toggle |
| PATCH | `/api/branding/portal/kra/peer-marking-toggle` | Branding admin/super | Enable or disable peer marking |
| GET | `/api/branding/portal/kra/self-appraisal` | Branding team | Read self appraisal by month/year |
| POST | `/api/branding/portal/kra/self-appraisal` | Branding team | Submit self appraisal |
| GET | `/api/branding/portal/kra/peer-marking/completed` | Branding team | List colleagues already marked |
| POST | `/api/branding/portal/kra/peer-marking` | Branding team | Submit peer marking |
| GET | `/api/branding/portal/kra/report/:userId/:month/:year` | Branding team with restrictions | Fetch compiled KRA report |
| GET | `/api/branding/portal/kra/admin/dashboard` | Branding admin/super | Admin KRA dashboard |
| GET | `/api/branding/portal/kra/admin/score/:userId/:month/:year` | Branding admin/super | Read admin score |
| POST | `/api/branding/portal/kra/admin/score` | Branding admin/super | Upsert admin score |
| POST | `/api/branding/portal/kra/admin/final-push` | Branding admin/super | Lock/finalize KRA |
| GET | `/api/branding/portal/kra/admin/peer-markings` | Branding admin/super | List peer markings |

## Branding Portal: Admin Stats, Design Gallery, Projects, Leave

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| GET | `/api/branding/portal/super-admin/stats` | `super_admin` | Read branding portal stats |
| GET | `/api/branding/portal/designs` | Branding team | List designs with filters |
| POST | `/api/branding/portal/designs` | Branding team, multipart | Upload design |
| POST | `/api/branding/portal/designs/:id/vote` | Branding team | Cast or clear vote |
| GET | `/api/branding/portal/designs/:id/voters` | Branding admin/super | List voters |
| DELETE | `/api/branding/portal/designs/:id` | Branding team with ownership/time rules | Delete design |
| GET | `/api/branding/portal/projects` | Branding team | List projects |
| POST | `/api/branding/portal/projects` | Branding admin/super | Create project |
| PUT | `/api/branding/portal/projects/:id` | Branding admin/super | Update project |
| DELETE | `/api/branding/portal/projects/:id` | Branding admin/super | Delete project |
| POST | `/api/branding/portal/leave` | Branding team | Apply for leave |
| GET | `/api/branding/portal/leaves` | Branding team | List own or all leaves |
| PATCH | `/api/branding/portal/leave/:id` | Branding team/admin with branch rules | Review leave or update transfer date |
| DELETE | `/api/branding/portal/leave/:id` | Branding team | Cancel own pending leave |
| GET | `/api/branding/portal/leave/date/:date` | Branding team | Check leave status for a date |

## Authorization Summary

- Public routes are limited to `/health` and `/auth/*`.
- All other `/api/*` routes require a valid session.
- Additional route-level checks enforce:
  - `super_admin` only
  - branding team only
  - branding admin/super only
  - branding lead/admin/super only
  - target-user ownership/team rules

## Response Shape Notes

Common success payload wrappers:

- `{ ok: true }`
- `{ user }`
- `{ users }`
- `{ entry }`
- `{ entries }`
- `{ team }`
- `{ teams }`
- `{ brandingRow }`
- `{ brandingRows }`
- `{ report }`
- `{ reports }`
- `{ analytics }`
- `{ project }`
- `{ projects }`
- `{ leave }`
- `{ leaves }`

## Brownfield Notes

- Keep response wrappers stable when extending the API because frontend hooks depend on them directly.
- Auth-sensitive additions should stay compatible with cookie-backed sessions and the existing `/api` middleware gate.
- If a request changes shape, update both backend validation and the frontend client/types in the same change.

---

_Generated using BMAD Method `document-project` workflow_
