# Nerve Media Ops — Architecture & Build Log

> Living document. Updated as the build progresses. Source of truth for the
> Media Crew production platform inside Nerve.
> Spec: **PRD/SRS v1.0 (22 Jul 2026)** + the interactive prototype
> (`public/media-ops/index.html`).

Media Ops is a **production-first operating system** for the Media Crew
department (~18 people producing 150+ events/tours/campaigns a year). It replaces
WhatsApp daily reporting + a hand-maintained Excel workbook with one queryable
system.

---

## 1. The spine (PRD §5.1)

```
Project → Shoots → Deliverables → Versions / Drive Links → Daily Task Logs
```

Everything else — dashboard, library, analytics, KRA, equipment, calendar — is a
**view over this chain**. One fact, one record, many views.

Key product decisions baked into the design:

| # | Decision | Where enforced |
|---|----------|----------------|
| D1 | Log-as-you-go (task logs during the day; the "daily report" is a review-and-submit) | `mo_report_tasks` + `mo_daily_reports` |
| D2 | Exception-based review — reports auto-approve at 48h unless flagged | `mo_daily_reports.status`, AUTO-13 |
| D3 | Project progress = weighted deliverable completion, **not** task % | `mo_deliverable_types.default_weight` |
| D4 | Three roles only + **duty flags** (custodian, PM…), never a 4th role | `mo_duty_flags` / `mo_user_duties` |
| D5 | Media files stay in Google Drive; we store validated structured links | `mo_drive_links` |

---

## 2. How it lives inside Nerve

The Media Ops UI is the **self-contained prototype**, served verbatim and wired to
a real backend (chosen build strategy — "serve the prototype, wire the backend").

- **Frontend mount:** React route `/media` (`src/pages/media/MediaOps.tsx`) renders
  the prototype full-screen in an `<iframe src="/media-ops/index.html">`. The
  prototype owns its own shell (sidebar + topbar + `#/media/*` hash routing), so it
  runs edge-to-edge with no surrounding app chrome. The iframe is same-origin, so
  the session cookie flows through to `/api/v1/media/*`.
- **Static UI asset:** `public/media-ops/index.html` (the prototype). Vite serves
  `public/` at the site root.
- **Routing in:** any user with `team = 'media'` is sent to `/media` by
  `getRoleDashboard()` in `src/hooks/useAuth.tsx`.

### Identity & role mapping

Media Ops does **not** own a users table — it reuses the global `users` table. A
Media Ops "user" is a Nerve user with `team = 'media'`. The prototype's 3-role model
maps onto Nerve roles:

| Media Ops role (PRD) | Nerve role (`users.role`, team=media) |
|----------------------|----------------------------------------|
| `admin`              | `admin` (+ `super_admin` sees all)     |
| `team_lead`          | `sub_admin`                            |
| `employee`           | `user`                                 |

Media-specific per-user attributes (designation, skills, duties, capacity) live in
`mo_user_profiles`, `mo_user_skills`, `mo_user_duties`.

---

## 3. Database (PRD §11)

All tables carry the `mo_` prefix and live in the same Postgres DB as the other
portals. Owned by **`server/mediaops-db.ts`** (`bootstrapMediaOpsDatabase()`, run
from the startup chain in `server/index.ts`). Idempotent — `CREATE TABLE IF NOT
EXISTS` + guarded lookup seed.

Table groups (≈45 tables):

- **§11.1 Identity/org** — `mo_departments`, `mo_campuses`, `mo_academic_years`,
  `mo_teams`, `mo_team_members`, `mo_duty_flags`, `mo_user_duties`, `mo_skills`,
  `mo_user_skills`, `mo_capacity_roles`, `mo_user_profiles`
- **§11.2 Projects/production** — `mo_project_types`, `mo_projects`,
  `mo_project_assignments`, `mo_shoots`, `mo_shoot_crew`, `mo_project_templates`,
  `mo_template_deliverables`
- **§11.3 Deliverables/assets** — `mo_deliverable_types`, `mo_deliverables`,
  `mo_deliverable_versions`, `mo_drive_links`, `mo_attachments`, `mo_tags`,
  `mo_entity_tags`
- **§11.4 Daily reporting** — `mo_task_categories`, `mo_daily_reports`,
  `mo_report_tasks`
- **§11.5 Equipment** — `mo_equipment_categories`, `mo_vendors`,
  `mo_equipment_items`, `mo_equipment_kits`, `mo_kit_items`,
  `mo_equipment_bookings`, `mo_equipment_transactions`, `mo_maintenance_records`
- **§11.6 Kanban/calendar/HR** — `mo_boards`, `mo_board_columns`, `mo_labels`,
  `mo_cards`, `mo_card_assignees`, `mo_card_labels`, `mo_card_checklist_items`,
  `mo_leave_types`, `mo_leave_requests`, `mo_leave_replacements`, `mo_holidays`,
  `mo_kra_cycles`, `mo_kras`, `mo_kra_reviews`, `mo_performance_snapshots`
- **§11.7 Platform** — `mo_comments`, `mo_notifications`,
  `mo_notification_preferences`, `mo_automation_rules`, `mo_audit_logs`,
  `mo_saved_views`, `mo_import_batches`, `mo_import_issues`

Integrity guarantees implemented at the DB level:

- `mo_daily_reports UNIQUE(user_id, report_date)` — **BR-3**, one report/day.
- Partial unique on `mo_project_assignments(project_id) WHERE is_project_manager` —
  **BR-2**, at most one PM per project.
- `mo_equipment_bookings EXCLUDE USING gist (equipment_item_id =, daterange &&)` —
  **AC-7**, double-booking is impossible even under concurrency (needs
  `btree_gist`).
- Partial unique on `mo_team_members(user_id) WHERE is_primary` — one primary team.
- `mo_deliverable_versions UNIQUE(deliverable_id, version_no)` — immutable versions.
- CHECK constraints encode every status machine (project, deliverable, report,
  equipment, leave).
- `mo_audit_logs` — append-only, indexed by entity and actor.

FK type note: `mo_*` PKs are `BIGINT GENERATED ALWAYS AS IDENTITY`; user references
are `TEXT` → `users(id)`.

Seeded lookups (idempotent, config-driven — **NFR-10**): departments, campuses,
academic years, capacity roles, duty flags, skills, project types (8), task
categories (12), deliverable types (14), equipment categories (11), leave types (5),
and the 14 automation rules (AUTO-1…14).

---

## 4. REST API (PRD §13) — plan

Versioned under **`/api/v1/media/*`**, enforced server-side against the §16
permission matrix (deny-by-default). Being built module by module (see status).

| Resource | Core endpoints |
|----------|----------------|
| Projects | `GET/POST /projects`, `GET/PATCH/DELETE /projects/:id`, `POST /projects/:id/status`, `.../assignments`, `.../activity` |
| Shoots | `GET/POST /projects/:id/shoots`, `PATCH /shoots/:id`, `PUT /shoots/:id/crew` |
| Deliverables | `GET/POST /projects/:id/deliverables`, `PATCH /deliverables/:id`, `POST /deliverables/:id/versions`, `POST /versions/:id/review`, `POST /deliverables/:id/deliver` |
| Reports | `GET /reports`, `GET/POST /reports/:date/tasks`, `PATCH/DELETE /tasks/:id`, `POST /reports/:date/submit`, `POST /reports/:id/review`, `.../unlock` |
| Equipment | `GET/POST /equipment`, `.../bookings`, `POST /equipment/transactions`, `GET /equipment/availability`, `POST /equipment/:id/damage` |
| Library | `GET /search`, `GET /library/export` |
| Team / Leave / KRA / Boards / Analytics / Platform | per §13 |

Business/validation rules (BR-1…16, VR-1…12) and the automation engine (AUTO-1…14,
`mo_automation_rules`) are applied at the API/service layer.

---

## 5. Build phases & status

| Phase | Scope | Status |
|-------|-------|--------|
| **0 — Foundations** | Full §11 schema + lookups, media team + users, `/media` mount serving the prototype, README | ✅ **done** |
| **1 — Kill WhatsApp & Excel** | Projects, Deliverables (+versions/approvals), Daily Reporting (+review queue, AUTO-13), Dashboard, lookups — REST API on the real schema | 🟡 **backend live** (`server/mediaops-api.ts`); frontend wiring pending the prototype install |
| **2 — Physical world** | Equipment + QR + kiosk, Shoots, unified Calendar, Leave (production-aware) | ⏳ |
| **3 — Insight** | Media Library + search + exports, Analytics + snapshots + month-close, KRA auto-metrics, Management Kanban | ⏳ |
| **4 — Intelligence & polish** | AI-1/2/3, PWA offline, Drive validation/provisioning, Gallery, ICS | ⏳ |

---

## 6. Running it locally

```bash
# DB + API + Vite (Docker path)
npm run dev:local
# or, against a native Postgres:
set -a; source .env.local; set +a
npm run dev:server   # API :3001, runs bootstrapMediaOpsDatabase()
npm run dev          # Vite (8080/8081)
```

- Open the app → log in as a **media-team** user → you land on `/media`.
- Until the prototype file is dropped in, `/media` shows an install card; save the
  attached `nerve-media-ops.html` as `public/media-ops/index.html` to serve the real
  UI.
- Demo media logins (fresh-seed DBs): `media-admin@parul.ac.in / media123`,
  `media-lead@parul.ac.in / medialead123`, `media-user@parul.ac.in / mediauser123`.

---

## 7. Change log

- **Phase 1 (backend):** `server/mediaops-api.ts` — `/api/v1/media/*` with the §16
  role model (super_admin/admin→admin, sub_admin→team_lead, user→employee),
  deny-by-default, and append-only audit. Endpoints: `GET /lookups`; Projects
  (list/get/create/status/assignments) with **FR-3.2** template auto-create,
  **BR-11** approval gate, **BR-1** state machine, **BR-2** one-PM; Deliverables
  (create/patch/versions/review/deliver) with **BR-5** (submitter ≠ reviewer) and
  **BR-6** (approved-version-before-delivered); Daily Reporting (get/tasks
  CRUD/submit/review) with **AUTO-13** flag evaluation, **BR-3** one-report/day,
  **VR-1/3/4/FR-2.8**; Dashboard aggregates. Verified end-to-end via the API.
  Frontend wiring is blocked on installing the prototype at
  `public/media-ops/index.html`.
- **Phase 0 (foundations):** reverted the earlier Branding-clone Media; built the
  full `mo_*` schema (`server/mediaops-db.ts`, §11) with DB-level integrity (BR-2,
  BR-3, AC-7) and seeded all lookups + 14 automation rules; registered the `media`
  team + demo users; mounted the prototype at `/media`
  (`src/pages/media/MediaOps.tsx`, `public/media-ops/`); routed media-team users to
  `/media`.
