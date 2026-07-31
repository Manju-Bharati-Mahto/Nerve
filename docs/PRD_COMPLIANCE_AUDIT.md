# Nerve Media Ops — PRD/SRS v1.0 Compliance Audit

**Audited:** 2026-07-31 · **Source of truth:** PRD/SRS v1.0 (22 Jul 2026). The HTML prototype and existing code are *reference*, not truth.
**Evidence base:** four independent code auditors read the real backend (`server/mediaops-api.ts`, `server/index.ts`), schema (`server/mediaops-db.ts`), the prototype SPA (`public/media-ops/index.html`, 8.2k lines), and cross-cutting layers. All findings below are file:line-cited.

> **How to read the score.** "Implemented" = present **and** persisted **and** rule-enforced end-to-end. A view that renders but whose action doesn't reach the DB is **Partial**, not done. This is the standard the PRD sets ("No dead UI… everything must work").

---

## 14. Final Compliance Score (headline first)

| Dimension | Score | Basis |
|---|---:|---|
| **Overall PRD compliance (weighted to Must)** | **~55%** | Phase 1–2 write-paths real; Phase 3–4 + cross-cutting largely partial/stub |
| Database schema (§11) | 92% | 58/59 tables, all key constraints (AC-2, BR-2, AC-7 EXCLUDE) real |
| Business Rules (BR-1…16) | 63% | 10/16 enforced; BR-1 not persisted, BR-4/BR-9 missing |
| Acceptance Criteria (AC-1…15) | ~40% | AC-1/5/6/7/8 pass; AC-3 partial; AC-4/11/12/13/14 fail |
| Automations (AUTO-1…14, §17) | 7% | Only AUTO-13 truly event-fired; **no scheduler exists** |
| Security / NFR-8 / §21 | 50% | RBAC gaps, no API rate-limit, SVG-upload XSS, no idempotency |
| AI (§7.15, AI-1…8) | ~38% | AI-1/3/7 real; AI-2/4/5/6/8 stub/UI-only |

**Phase view:** Phase 0 ~85% · Phase 1 ~65% · Phase 2 ~70% · Phase 3 ~45% · Phase 4 ~35%.

---

## 1. PRD Compliance Report (module by module)

Legend: ✅ Implemented · 🟡 Partial · 🔴 Missing · ⛔ Wrong.

| Module | Status | Evidence / gap |
|---|:--:|---|
| **M1 Dashboard (FR-1.x)** | 🟡 | Role-adaptive dashboard renders client-side (`index.html:2835`). Live counts. `GET /dashboard` exists (`mediaops-api.ts:1105`) but the **client never calls it** — all widgets computed in-browser over `/state`. FR-1.10 Recent Activity + FR-1.2 nudge are **client-only** (`nudgeAll` is a toast, `7193`). |
| **M2 Daily Reporting (FR-2.x)** | ✅ | Log-as-you-go (D1) ✅ AC-1 met. Submit/review wired. **BR-4 auto-approve after 48h now implemented (P2a)** — the automation engine flips `submitted`→`auto_approved` after 48h (unflagged) and audits it. **BR-9 edit-lock enforced (P0)**. Remaining: FR-2.10 offline queue still fake (P2/P3). |
| **M3 Project Mgmt (FR-3.x)** | 🟡 | CRUD, per-type templates (per-item ✅), assignments ✅, all 6 views render ✅. **BR-1 project status transitions are LOCAL-ONLY** — `MENUS.projStatus`, `projMore`, and Kanban drag set `p.status` with no persist (`index.html:7977,7994,8062`). `PATCH /projects/:id` (generic edit) **missing**. `GET /projects/:id/activity` missing. |
| **M4 Deliverables (FR-4.x)** | ✅ | Strong. Versions immutable, approval workflow, BR-5/BR-6 enforced server-side (`mediaops-api.ts:378,396`) and client (`applyDelivStatus`→wired, `8041`). **FR-4.5 social/mail status is LOCAL-ONLY** (`setSocial`/`setMail`, `7412`) — silently not saved. FR-4.7 import → see M-import. |
| **M5 Media Library (FR-5.x)** | 🟡 | Faceted browse + gallery render. **Search is a client substring filter of already-loaded data** (`2735`), **not** the Postgres FTS the UI claims (`4174`). No `GET /search`, no `GET /library/export`. Export is CSV-only. |
| **M6 Equipment (FR-6.x)** | ✅ | Strongest module. Catalog, QR, bookings with **real AC-7 double-booking prevention** (btree_gist EXCLUDE, `mediaops-db.ts:346`), checkout/checkin ledger, damage→maintenance, kiosk mode wired (`commitKiosk`, `4610`). Gaps: no `GET /equipment/availability` endpoint; BR-7 checkout only blocks on `status`, not on foreign active booking; FR-6.8 overdue engine not scheduled. |
| **M7 Team (FR-7.x)** | ✅ | **Now real (P1b).** `teams`/`team_members`/`duty_flags`/`user_duties`/`skills`/`user_skills` hydrated from `/state`, so **TL scoping (`myTeamIds`) and custodian-duty permission run on real data**. Team management wired: assign a member to a lead (`POST /crew/:id/team`, lazily creates the lead's team, enforces one-primary-team), grant/revoke duties (`POST /crew/:id/duties`) — both persist (were seed-only / local-only). Remaining nicety: `GET /team/:id/*` dedicated read endpoints (data currently rides `/state`). |
| **M8 Performance (FR-8.x)** | 🟡 | Snapshots table + views exist and hydrate. **Not computed/scheduled** — `performance_snapshots` populated only by seed; AUTO-11 month-close missing, so FR-8.1/8.5 monthly rollups don't happen. |
| **M9 KRA (FR-9.x)** | ✅ | **Now wired (P1b).** Endpoints `POST /kra/cycles`, `/kra/:cycleId/items` (BR-14 weight ≤100 enforced), `/kra/items/:id/review` (self=owner, manager=TL/Admin, upsert). UI: new cycle, add KRA (self or, for TL/Admin, any member), self-review + manager-review modals. FR-9.1–9.4 functional. Remaining nicety: final-score locking at cycle close (FR-8.5 immutability) pairs with the month-close scheduler (P2). |
| **M10 Leave (FR-10.x)** | 🟡 | Request + decide wired (conflict-aware). **FR-10.3 replacement assignment is LOCAL-ONLY** (`assignReplacement`, `7646`) — not persisted; `POST /leave/:id/replacements` missing. |
| **M11 Calendar (FR-11.x)** | ✅ | Layered calendar renders; scoping present. ICS feed endpoint real (`mediaops-api.ts:772`). Drag-reschedule not persisted. |
| **M12 Analytics (FR-12.x)** | 🟡 | Metrics computed **client-side** (real, mostly per §19) with **2 definition deviations**: *logged hours* counts draft/submitted not just approved (`2214`); *cycle time* uses planned span not approved→completed (`5275`). **Exports lie**: XLSX/PDF toggles emit CSV always (`7847`). No server `/exports`, no async job. |
| **M13 Audit (FR-13.x)** | 🟡 | **Server capture is REAL and broad** (~40 `audit()` sites → `mo_audit_logs`). **But FR-13.3 admin browser is not backed by it** — no read endpoint, `/state` omits it, client wipes `DB.audit_logs` on hydrate (`8149`) and shows session-local only. |
| **M-Kanban (FR-14.x)** | 🟡 | Cards create/move/checklist wired. **Column CRUD missing** (`newColumn` stub, `7664`), `editCard` stub, two-way sync setting LOCAL-ONLY (`toggleSync`). FR-14.1 employee-exclusion only nav-hidden, not route-guarded. |
| **AI (§7.15)** | 🟡 | AI-1 digest, AI-3 duplicates, AI-7 forecast are **real live computations** (`mediaops-api.ts:696,727,751`). AI-2/4/5/6/8 stub or static prose. |
| **Excel migration (FR-4.7)** | 🔴 | `mediaops-import.ts` loads the **prototype demo JSON**, not the 2026-27 workbook; no `xlsx` parser; `import_batches/issues` never populated; admin import view is demo rows. |

---

## 2. Feature Gap Report (Missing / Wrong, with *why*)

**Wrong (⛔) — looks done, isn't:**
1. **Project status changes don't persist (BR-1).** Menu + drag mutate memory only; revert on reload. *Why:* the status paths never call `moSync` while the deliverable path does (`index.html:8041` vs `8062`). Endpoint `POST /projects/:id/status` exists and is unused by these paths.
2. **Deliverable social/mail status not saved (FR-4.5).** `setSocial`/`setMail` mutate + toast, no persist. *Why:* these replace the Excel's core columns — silent data loss.
3. **Exports claim XLSX/PDF, always emit CSV** (`7847`). *Why:* format selector ignored.
4. **Audit browser shows session-only data**, presented as the department trail. *Why:* no read endpoint; `/state` excludes `mo_audit_logs`.
5. **"Postgres FTS" search is a client filter.** *Why:* UI copy overstates; no FTS route.

**Missing (🔴):**
- **Scheduler / automation engine** (§17) — no cron for any `mo_*` job; 11/14 AUTO rules are toggle-only config.
- **BR-4 report auto-approve (48h)**; **BR-9 task-edit lock**.
- **Notifications persistence + delivery** — tables unused, no endpoint, no email/push, no quiet-hours/prefs.
- **KRA create/review**, **leave replacement persist**, **performance snapshot compute (AUTO-11)**, **month-close leadership pack**.
- **Endpoints:** `PATCH /projects/:id`, `GET /projects/:id/activity`, `GET /search`, `GET /library/export`, `GET /equipment`, `GET /equipment/availability`, `GET /team`, `GET /team/:id/*`, `POST /users/:id/duties`, KRA `*`, `GET/POST /boards`, board columns CRUD, `GET /admin/audit`, notifications `*`, `GET /calendar`, `POST /exports`, `POST /leave/:id/replacements`, `POST /reports/:id/unlock`.
- **Offline write queue + idempotency (NFR-7/AC-13)**; **RFC-7807 problem+json (§13)**; **cursor pagination (§13)**; **API rate limiting (§13)**.
- **Real Excel importer (FR-4.7)**; **monthly audit partitions (§22)**; **FTS beyond projects (§20)**.

---

## 3. Architecture Audit
- **Shape:** modular monolith (matches §22 recommendation ✅). Prototype SPA served static by Express at `/api/media-ops/`; React shell redirects to it (`src/pages/media/MediaOps.tsx`).
- **Persistence pattern:** optimistic local mutate → `moSync` POST → re-hydrate `/state`. Reasonable, but `/state` returns the **entire transactional dataset unpaginated** (`mediaops-api.ts:128`) — violates §13 pagination and won't meet NFR-2 (50k deliverables) or NFR-1 (P95 < 1.5s).
- **Divergence root cause:** read path (`/state`) and write path (per-resource POST) don't fully mirror; audit/notifications are omitted from `/state`, forcing client-side fakes.
- **Tech debt:** 8.2k-line single HTML file with 137-key `ACTIONS` map — hard to test; no component isolation; no server-side render of the metrics.

## 4. UX Audit
- Design language matches §9 (green, serif titles, drawer-first, dark mode, kiosk). Good.
- **Dead UI (violates PRD "no fake interactions"):** ~18 stub actions (unlock, nudges, validate-links, edit-card, new-column, deactivate-user, KRA self-review, nl-search apply, ai-settings, schedule-pack) + ~11 LOCAL-ONLY toggles. Inventory in `docs` §2 above and the auditor tables.
- **Route-level access:** Boards/Analytics/Team are nav-hidden for employees but **not URL-guarded** — an employee typing the URL renders them (FR-14.1/AC-10 partial breach for read views).

## 5. Code Quality Audit
- Backend TypeScript is clean, parameterized SQL, consistent `audit()`/`requireMedia()` helpers. ✅
- Duplication: BR-5/BR-6 logic duplicated across `/review` and `/status` (acceptable). Two deliverable-status write paths (one wired, one not).
- Frontend: monolith; ephemeral `S` view-state well-structured; but persistence classification is inconsistent (some toggles wired, siblings not).

## 6. Database Audit (strongest layer)
- 58/59 §11 tables (users intentionally reused from global). Constraints real: **AC-2** unique report/day (`db:283`), **BR-2** one-PM partial-unique (`164`), one-primary-team (`83`), **AC-7** EXCLUDE + btree_gist fail-fast (`32,346`), all status CHECKs.
- **Gaps:** (a) **no triggers/functions at all** — `total_minutes`, `equipment_items.status`, `report_tasks.minutes` are app-maintained despite header claiming trigger-maintained; (b) **1 missing FK**: `mo_template_deliverables.deliverable_type_id` lacks `REFERENCES` (`db:194`, NFR-9); (c) audit not partitioned (§22); (d) FTS index on projects only (§20); (e) soft-delete `deleted_at` only on projects/deliverables/equipment.

## 7. Performance Audit
- `/state` unpaginated full-dataset fetch — the dominant risk for NFR-1/NFR-2.
- No cursor pagination on any list endpoint. No materialized views for analytics (§19 says add at 50+ users — acceptable now, flagged).
- Hot-path indexes exist (deadline, overdue, review queue) ✅. Equipment-overdue lacks a dedicated `ends_at` index.

## 8. Security Audit (NFR-8, §21) — action-required
1. **SVG/stored-XSS:** avatar/image upload accepts `image/*` by **client MIME only** (`index.ts:162`), `image/svg+xml` passes, files served from `/uploads` **before auth** with no `Content-Disposition`/nosniff → same-origin stored XSS. VR-5 (25MB, pdf/zip, AV scan) only partially met (3–10MB, no sniff/scan).
2. **No API rate limiting** — `express-rate-limit` only on auth routes; `/api/v1/media/*` unthrottled (§13 wants 100/min/user).
3. **Object-ownership RBAC gaps:** `PATCH/DELETE /tasks/:id` (any member edits/deletes another's timesheet, no audit), `PATCH /shoots/:id`, `POST /equipment/bookings/:id/cancel`, `PATCH /cards/:id` (asymmetric with TL/Admin-gated create). `/upload-image` is auth-only, not media-only.
4. **No RFC-7807** error format; **no idempotency keys** (NFR-7 dup risk).
5. **Positives:** SQL fully parameterized; generic `/lookups/:type` table name **is allowlisted**; DB-level concurrency constraints (AC-2/BR-2/AC-7) are real; nosniff/XFO/Referrer headers present.

## 10. Bug List (prioritized)
- **B1 (P0):** project status not persisted (BR-1). — *fixed this batch*
- **B2 (P0):** task edit/delete: no ownership, no BR-9 lock, no audit. — *fixed this batch*
- **B3 (P0):** SVG upload → stored XSS. — *fixed this batch*
- **B4 (P0):** no rate limit on media API. — *fixed this batch*
- **B5 (P0):** deliverable social/mail status silently not saved. — *fixed this batch*
- **B6 (P1):** notifications/audit never round-trip to server.
- **B7 (P1):** KRA module entirely unwired.
- **B8 (P1):** route guards missing for Boards/Analytics/Team.
- **B9 (P1):** teams/duties never hydrated → team-lead & custodian permissions run on seed.
- **B10 (P2):** missing FK on `mo_template_deliverables.deliverable_type_id`.

---

## 11 & 12. Missing Features → Implementation Roadmap

**P0 — correctness & security (in progress, this batch):**
persist project status · guard+lock+audit task edit/delete · block SVG upload + harden `/uploads` · rate-limit media API · persist social/mail status.

**P1 — functional integrity (next):**
notifications server round-trip (table→endpoint→/state→persist read-state) · audit browser backed by `GET /admin/audit` · KRA create/self/manager wiring · route-level permission guards · hydrate `teams/team_members/user_duties/user_skills` into `/state` · `PATCH /projects/:id` · persist leave replacement · `GET /equipment/availability` · add missing FK.

**P2 — PRD completeness:**
scheduler (`setInterval`/cron) firing AUTO-1/2/3/4/11 + BR-4 auto-approve + month-close snapshots · real XLSX/PDF exports + monthly leadership pack (AUTO-11) · server FTS `GET /search` + `/library/export` · real Excel importer (`xlsx`) + import-review queue · offline IndexedDB queue + idempotency keys (NFR-7/AC-13) · RFC-7807 errors · cursor pagination on lists.

**P3 — intelligence & polish:**
AI-2/4/5/6/8 · Drive-API link validation (AUTO-5) · performance snapshot computation · audit partitioning · WCAG AA + keyboard pass (AC-14) · policy-test suite encoding §16 (AC-10).

---

## 13. Validation Report

Each batch is verified with `tsc`, targeted API tests (curl), and Playwright browser checks against a live local backend, as a real (non-`mo-uN`) admin **and** an employee.

### Batch P0 — correctness & security (landed 2026-07-31)
| Bug | Fix | Verified |
|---|---|---|
| **B1** project status not persisted (BR-1) | wired `MENUS.projStatus`, `projMore` archive/cancel, and Kanban project-drag to `POST /projects/:id/status` | ✅ browser: planning → **in_production persisted** on `/state` |
| **B2** task edit/delete no ownership/lock/audit (BR-9, security) | `PATCH/DELETE /tasks/:id` now check report owner, block edits unless report is `draft`/`returned` (TL/Admin may unlock), and write `audit()` | ✅ own-draft 200, admin 200, **post-submit 403 (BR-9)** |
| **B3** SVG/filename stored-XSS on upload (VR-5, §21) | raster-only MIME allowlist (svg rejected); on-disk extension derived from validated MIME, not `originalname` | ✅ **SVG rejected**, PNG+`.html` filename saved as **`.png`** |
| **B4** no API rate limit (§13) | per-user `mediaApiLimiter` (300/60s burst) on `/api/v1/media/*` | ✅ `RateLimit-Policy: 300;w=60` headers present |
| **B5** social/mail status silently not saved (FR-4.5) | wired `setSocial`/`setMail` to `PATCH /deliverables/:id` | ✅ social status **posted persisted** on `/state` |

Known follow-up from this batch: SVG rejection currently returns 500 (should be a clean 400 — cosmetic, rejection itself is correct); B10 (missing FK) added to schema for fresh DBs only (existing DBs need an ALTER migration).

### Batch P1a — functional integrity, part 1 (landed 2026-07-31)
| Gap | Fix | Verified |
|---|---|---|
| **B6a** audit browser showed session-only client data | new `GET /audit` (admin-only, filterable) reads the real append-only `mo_audit_logs`; client `loadAudit()` fetches it and remaps actor → prototype id | ✅ 75 real rows loaded, admin 200 / **employee 403** |
| **B8** Boards/Analytics/Team not URL-guarded (FR-14.1/AC-10) | `roleDenied()` guard at the top of `viewBoards`/`viewAnalytics`/`viewTeam` | ✅ employee blocked on all three via direct URL |
| §13 `PATCH /projects/:id` missing | endpoint (owner/PM/TL/Admin, VR-6 validated) + "Edit details" action wired end-to-end | ✅ admin edit persists, **employee 403** |
| FR-10.3 leave replacement not persisted | `POST /leave/:id/replacements` (TL/Admin) + `assignReplacement` now `moSync`s | ✅ 201, `mo_leave_replacements` + `mo_shoot_crew` rows created |

### Batch P1b — KRA module (landed 2026-07-31)
| Gap | Fix | Verified |
|---|---|---|
| **B7** KRA entirely display-only | `POST /kra/cycles`, `POST /kra/:cycleId/items`, `POST /kra/items/:id/review`; wired new-cycle, add-KRA, self-review, manager-review in `viewKRA` | ✅ cycle+item persist; **BR-14 weight >100 → 400**; self by owner 201 / by non-owner 403; manager by TL/Admin 201; reviews stored (self:88, manager:85); UI smoke 0 errors |

### Batch P1b — team management + org hydration (landed 2026-07-31)
| Gap | Fix | Verified |
|---|---|---|
| **B9** teams/duties never hydrated → TL scoping + custodian duty ran on seed | added `teams`/`team_members`/`duty_flags`/`user_duties`/`skills`/`user_skills` to `/state`; `POST /crew/:id/team` (assign to a lead, lazy team create, one-primary-team) + `POST /crew/:id/duties` (grant/revoke); `teamStructure()` gains member-assign + duty-grant selects; `toggleDuty`/`assignTeamLead` persist | ✅ assign 200 (team_members row, lazy team), duty grant 200, **employee 403**; all 6 keys hydrate; **full route sweep both roles 0 errors** (myTeamIds admin 25 / employee 1); UI actions persist |

**✅ P1 (functional integrity) is complete.** Estimated compliance after P1: **~70%**.

### Batch P2a — the scheduler + automation engine (landed 2026-07-31)
| Gap | Fix | Verified |
|---|---|---|
| **No scheduler** (§17) → 11/14 automations dead; **BR-4** never fired; **B6** notifications faked client-side | `runMediaOpsAutomations()` (module-level, exported) wired into the existing 5-min `setInterval` + an 8s boot run. It: **(BR-4)** flips `submitted`→`auto_approved` after 48h unflagged (audited as `system`); generates **server-persisted** notifications (AUTO-1 report-not-submitted, AUTO-2 overdue deliverable, AUTO-3 overdue equipment, review-pending→PM), **deduped** on (user,kind,entity) while unread. New `GET /notifications` + `POST /notifications/read`; `/state` now returns the user's notifications; client hydrates them (no more client-side fabrication) and mark-read persists. | ✅ engine RUN1 `{autoApproved:1,notified:2}`, RUN2 `{0,0}` (dedupe); BR-4 report→`auto_approved`; mark-read persists; client badge from server; 0 console errors |

This single batch closes **BR-4** and the **notifications round-trip (B6)**, and gives AUTO-1/2/3 + review-pending real execution. Est. compliance now **~74%**.

**Remaining P2:** AUTO-11 month-close (compute `performance_snapshots` + leadership pack) · real XLSX/PDF exports · server FTS `GET /search` · real Excel importer (`xlsx`) · remaining automations (AUTO-5/6-trigger/7/8/9/10/12/14) · email/push delivery (needs SMTP/push config). Then **P3** intelligence/polish. Note the automations are best-effort/idempotent and run every 5 min; a true event-bus (§13) is a later refinement.

### Admin Config Connection Report (integration sprint, 2026-07-31)
Answers the per-entity validation: *consumer module · reading API · referencing tables · UI that updates · View/Edit/Duplicate/Archive functional · dependency-aware Delete · Force Delete super-admin-only.* All CRUD engine actions (View/Edit/Duplicate/Enable/Disable/Archive/Delete/Bulk/Audit/server-side Search+filters) are REAL for every module below; the table lists the operational consumers.

| Config module | Operational consumer(s) | Read via | Referenced by |
|---|---|---|---|
| Project Types | New-project type dropdown; project chips/filters everywhere | `/state.project_types` (DB) + create validates FK | `mo_projects`, `mo_project_templates` |
| Project Templates | Template auto-creation at project create (server reads DB) | `POST /projects` → `mo_project_templates` | `mo_template_deliverables` |
| **Template Items** (new module) | Deliverable generation: title/weight/due-offset drive every future create (verified: offset 99 ⇒ due +99d) | `POST /projects` | — leaf |
| Deliverable Types | New-deliverable form, board/library/pipeline labels, weights (D3 progress) | `/state.deliverable_types` | `mo_deliverables`, `mo_template_deliverables` |
| Task Categories | Task-log category chips, daily reports, analytics groupings | `/state.task_categories` | `mo_report_tasks` |
| Equipment Categories | Add-item form, catalog facets, asset-tag prefixes | `/state.equipment_categories` | `mo_equipment_items` |
| Leave Types | Leave-request form, balances | `/state.leave_types` | `mo_leave_requests` |
| Skills / Capacity Roles / Tags / Duty Flags | Team profiles, assignment pickers, project tags, custodian permission | `/state.*` | `mo_user_skills` / `mo_project_assignments`+`mo_shoot_crew` / `mo_entity_tags` / `mo_user_duties` |
| Academic Years / Campuses / Holidays | New-project year picker; campus fields; report-expectation suppression (FR-2.11) | `/state.*` | `mo_projects` / several / — |
| Vendors | Equipment add-item + maintenance records | `/state.vendors` | `mo_equipment_items`, `mo_maintenance_records` |
| Automation Rules | **Executable**: engine gates AUTO-1/2/3/4 on `is_enabled`; AUTO-13 reads `config` thresholds at submit | scheduler + `POST /reports/:date/submit` | — |
| Users & Roles | permissions (role map), sidebar, module access (`allowed_modules`), team scoping | `/state.users` + auth | everywhere |

**Force Delete:** super-admin only (platform role, typed `DELETE` confirm); nullable FKs → NULL, NOT-NULL → child rows removed, transactional, audited (`crud.force_deleted`). Verified 403/400/success paths.

**Known remaining disconnects (honest):** (1) `faculties` is still a client-side seed list — no DB table in §11; promote to a lookup table if desired. (2) The **Permission Matrix page** remains informational — the enforced model is §16 CAPS (client) + role checks (server) + per-user `allowed_modules`; they are consistent, but the matrix is code-defined policy, not a DB table (per PRD D4 three-role design). Making it DB-driven is a deliberate future decision, not an oversight. (3) `mo_holidays`/`mo_academic_years` CRUD edits hydrate, but holiday changes only affect report-expectation logic client-side today.
</content>
</invoke>
