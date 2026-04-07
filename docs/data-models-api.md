# Nerve API Data Models

**Date:** 2026-04-07T16:15:44+05:30
**Part:** API and Data Layer (`server/`)

## Overview

The active backend data model is defined in startup SQL inside:

- `server/db.ts`
- `server/branding-db.ts`
- `server/settings-db.ts`

The application uses direct SQL and bootstraps tables on startup. A retained Supabase schema also exists under `supabase/migrations/`, but it is not the primary runtime persistence path today.

## Core Tables

### `teams`

Purpose: team catalog for role assignment and organization.

Key columns:

- `id` text primary key
- `name`
- `color`
- `is_built_in`
- `created_at`

Relationships:

- referenced by `users.team`

### `users`

Purpose: authenticated application users.

Key columns:

- `id` text primary key
- `full_name`
- `email` unique
- `department`
- `role` constrained to `super_admin | admin | sub_admin | user`
- `team` nullable FK -> `teams.id`
- `managed_by` nullable self-reference -> `users.id`
- `password_hash`
- `email_verified`
- `avatar_url`
- `created_at`
- `updated_at`

Relationships:

- parent of `entries.created_by`
- parent of daily report, KRA, project, design, and leave records
- parent of auth token tables

### `entries`

Purpose: main knowledge-base content records.

Key columns:

- `id`
- `title`
- `dept`
- `type`
- `body`
- `priority`
- `entry_date`
- `created_by` FK -> `users.id`
- `tags` text array
- `author_name`
- `academic_year`
- `student_count`
- `external_link`
- `collaborating_org`
- `created_at`
- `attachments` JSONB

### `branding_rows`

Purpose: branding-specific row tracking used by branding team workflows.

Key columns:

- `id`
- `category`
- `sub_category`
- `time_taken`
- `team_member`
- `project_name`
- `additional_info`
- `created_at`
- `updated_at`

## Settings and Auth Support Tables

### `app_settings`

Simple key-value settings store.

Key columns:

- `key` primary key
- `value`
- `updated_at`

Seeded keys include:

- site metadata
- auth settings
- branding delete window
- SMTP settings
- feature toggles for design gallery, daily reports, and KRA

### `password_reset_tokens`

Purpose: password reset token storage.

Key columns:

- `id`
- `user_id` FK -> `users.id`
- `token_hash` unique
- `expires_at`
- `used`
- `created_at`

### `email_verification_tokens`

Purpose: email verification token storage.

Key columns mirror password reset tokens, with token consumption also flipping `users.email_verified = true`.

## Branding Portal Tables

### Work Taxonomy

#### `work_categories`

- category name and sort order

#### `work_sub_categories`

- belongs to `work_categories`
- includes `is_others` guard for protected fallback entries

### Daily Reporting

#### `daily_reports`

- `user_id` FK -> `users.id`
- `report_date`
- `is_locked`
- `submitted_at`
- unique on `(user_id, report_date)`

#### `daily_report_rows`

- `report_id` FK -> `daily_reports.id`
- row ordering and work-description fields
- `collaborative_colleagues` as text array

### KRA / Appraisal

#### `kra_parameters`

- scoring rubric metadata

#### `self_appraisals`

- `user_id` FK -> `users.id`
- `month`, `year`
- `scores` JSONB
- unique on `(user_id, month, year)`

#### `peer_markings`

- `reviewer_id` FK -> `users.id`
- `reviewee_id` FK -> `users.id`
- `month`, `year`
- `scores` JSONB
- unique on `(reviewer_id, reviewee_id, month, year)`

#### `admin_kra_scores`

- `user_id` FK -> `users.id`
- `scores` JSONB
- `is_final_pushed`
- `pushed_at`
- `pushed_by` FK -> `users.id`
- unique on `(user_id, month, year)`

#### `peer_marking_settings`

- single-table toggle store for whether peer marking is enabled

### Branding Projects

#### `branding_projects`

- project metadata, deadline, and status
- `created_by` FK -> `users.id`

#### `branding_project_assignments`

- join table between projects and users
- `project_id` FK -> `branding_projects.id`
- `user_id` FK -> `users.id`
- `assigned_by` FK -> `users.id`
- unique on `(project_id, user_id)`

### Design Gallery

#### `branding_designs`

- title, description, category, tags
- `image_url`
- uploader metadata

#### `branding_design_votes`

- `design_id` FK -> `branding_designs.id`
- `user_id` FK -> `users.id`
- `vote_type` constrained to `up | down`
- unique on `(design_id, user_id)`

### Leave Management

#### `branding_leaves`

- `user_id` FK -> `users.id`
- `leave_date`
- `reason`
- `status` constrained to `pending | approved | rejected`
- `transfer_date`
- `reviewed_by` FK -> `users.id`
- unique on `(user_id, leave_date)`

## Relationship Summary

```text
teams
  └─< users
        ├─< entries
        ├─< password_reset_tokens
        ├─< email_verification_tokens
        ├─< daily_reports ─< daily_report_rows
        ├─< self_appraisals
        ├─< peer_markings (reviewer_id, reviewee_id)
        ├─< admin_kra_scores
        ├─< branding_projects
        ├─< branding_project_assignments
        ├─< branding_designs
        ├─< branding_design_votes
        └─< branding_leaves

work_categories
  └─< work_sub_categories

branding_projects
  └─< branding_project_assignments

branding_designs
  └─< branding_design_votes
```

## Seed and Bootstrap Notes

- Core seed users, teams, and entries are provided from `server/seed.ts`.
- Branding categories and KRA parameters are seeded inside `bootstrapBrandingDatabase()`.
- Settings defaults are seeded inside `bootstrapSettingsDatabase()`.
- The API also enables the Postgres `vector` extension during bootstrap, though vector-backed domain tables are not yet part of the active schema shown here.

## Retained Supabase Schema

The repo also contains retained Supabase migration tables such as:

- `profiles`
- `user_roles`
- `entries`
- `attachments`

Those are useful for historical or migration reference, but brownfield changes to the active runtime should primarily target the Express/Postgres schema described above.

## Brownfield Notes

- Schema evolution currently lives in app bootstrap code, so table changes affect startup behavior immediately.
- Several business domains use JSONB (`attachments`, appraisal score payloads), which makes flexible extension easier but requires contract discipline.
- Since sessions are also stored in PostgreSQL, DB outages affect both data access and login/session continuity.

---

_Generated using BMAD Method `document-project` workflow_
