// ═══════════════════════════════════════════════════════════════════════════
// NERVE MEDIA OPS — database layer (PRD/SRS v1.0 §11)
// ═══════════════════════════════════════════════════════════════════════════
// A production-first operating system for the Media Crew department. This file
// owns the full §11 schema, faithfully implemented with an `mo_` prefix so it
// stays isolated from the Branding/Design/Outreach portals in the same DB.
//
// Identity: Media Ops does NOT own a users table — it reuses the global `users`
// table (a media-ops "user" = a Nerve user with team = 'media'). Every user FK
// below references users(id) (TEXT). Media-specific attributes (skills, duties,
// capacity) live in mo_* satellite tables.
//
// The spine (PRD §5.1):  Project → Shoots → Deliverables → Versions/DriveLinks
//                        → Daily Task Logs.  Everything else is a view over it.
//
// Design decisions honoured at the schema level:
//   D3  project progress = weighted deliverable completion (mo_deliverable_types.default_weight)
//   D4  three roles only + duty flags (mo_duty_flags / mo_user_duties) — never a 4th role
//   BR-3  one report per user per day       → UNIQUE(user_id, report_date)
//   BR-2  at most one PM per project         → partial unique index
//   AC-7  no equipment double-booking        → EXCLUDE USING gist (btree_gist)
//   §11.8 immutable audit + version tables; trigger-maintained denormalisations
// ═══════════════════════════════════════════════════════════════════════════
import { pool } from "./db.js";

export async function bootstrapMediaOpsDatabase() {
  // Postgres range-overlap exclusion for equipment bookings (AC-7 / VR-8).
  // btree_gist backs the AC-7 no-double-booking EXCLUDE constraint on
  // mo_equipment_bookings. If the app DB role can't create extensions, a superuser
  // must run it once — fail fast with an actionable message rather than a cryptic one.
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      "[media-ops] FATAL: could not enable the btree_gist extension (needed for the " +
      "equipment no-double-booking constraint). Ask a Postgres superuser to run once:\n" +
      "    CREATE EXTENSION IF NOT EXISTS btree_gist;\n" +
      "Original error:", (e as Error).message,
    );
    throw e;
  }

  // The 'media' team must exist (global team seeding only runs on empty DBs).
  await pool.query(
    `INSERT INTO teams (id, name, color, is_built_in) VALUES ('media', 'Media Crew', 'green', true)
     ON CONFLICT (id) DO NOTHING`,
  );

  // ── §11.1 Identity & organisation ────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_departments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_campuses (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL, code TEXT UNIQUE NOT NULL, city TEXT, is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_academic_years (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      label TEXT UNIQUE NOT NULL, start_date DATE NOT NULL, end_date DATE NOT NULL,
      is_current BOOLEAN NOT NULL DEFAULT false
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_teams (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL,
      lead_user_id TEXT REFERENCES users(id) ON DELETE SET NULL, is_active BOOLEAN NOT NULL DEFAULT true
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_team_members (
      team_id BIGINT NOT NULL REFERENCES mo_teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_primary BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (team_id, user_id)
    )`);
  // One primary team per user (§11.1).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_primary_team ON mo_team_members(user_id) WHERE is_primary`);
  // Organization Management: teams are Admin-managed master data, not fixtures.
  // Presentation lives on the row so every consumer renders a team identically.
  // A project converted from an intake request is a third provenance, alongside
  // hand-created and Excel-imported.
  await pool.query(`ALTER TABLE mo_projects DROP CONSTRAINT IF EXISTS mo_projects_source_check`);
  await pool.query(`ALTER TABLE mo_projects ADD CONSTRAINT mo_projects_source_check
                    CHECK (source IN ('app','excel_import','request'))`);
  await pool.query(`ALTER TABLE mo_teams ADD COLUMN IF NOT EXISTS description TEXT`);
  await pool.query(`ALTER TABLE mo_teams ADD COLUMN IF NOT EXISTS color TEXT`);
  await pool.query(`ALTER TABLE mo_teams ADD COLUMN IF NOT EXISTS icon TEXT`);
  await pool.query(`ALTER TABLE mo_teams ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE mo_teams ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
  // Seed a stable order for teams that predate sort_order (all default to 0).
  await pool.query(`UPDATE mo_teams t SET sort_order = s.rn
                      FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn FROM mo_teams) s
                     WHERE s.id = t.id AND t.sort_order = 0`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_duty_flags (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT ''
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_user_duties (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      duty_flag_id BIGINT NOT NULL REFERENCES mo_duty_flags(id) ON DELETE CASCADE,
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL, granted_at DATE NOT NULL DEFAULT CURRENT_DATE,
      PRIMARY KEY (user_id, duty_flag_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_skills (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT UNIQUE NOT NULL, category TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_user_skills (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      skill_id BIGINT NOT NULL REFERENCES mo_skills(id) ON DELETE CASCADE,
      proficiency SMALLINT NOT NULL DEFAULT 3 CHECK (proficiency BETWEEN 1 AND 5),
      certified_until DATE,
      PRIMARY KEY (user_id, skill_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_capacity_roles (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT UNIQUE NOT NULL
    )`);
  // Media-specific per-user profile fields (designation lives on our users.department elsewhere).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_user_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      designation TEXT NOT NULL DEFAULT '', mo_role TEXT NOT NULL DEFAULT 'employee'
        CHECK (mo_role IN ('admin','team_lead','employee')),
      color TEXT, joined_on DATE, campus_id BIGINT REFERENCES mo_campuses(id),
      allowed_modules JSONB   -- NULL = unrestricted (role-based); array = restrict to these module keys
    )`);
  // Existing DBs: add the column if it predates the module-access feature.
  await pool.query(`ALTER TABLE mo_user_profiles ADD COLUMN IF NOT EXISTS allowed_modules JSONB`);
  // Module keys now mirror the sidebar one-for-one (key = route minus '#/media/'),
  // replacing the old coarse grouping. Expand any legacy key into the sidebar
  // entries it used to cover so nobody silently loses access. Idempotent: the new
  // keys contain no legacy names, so a second run matches nothing.
  await pool.query(`
    WITH legacy(old, new) AS (VALUES
      ('dashboard',   ARRAY['home']),
      ('reporting',   ARRAY['my-day','reports']),
      ('projects',    ARRAY['projects','pipeline','boards','calendar']),
      ('performance', ARRAY['performance','kra']),
      ('admin',       ARRAY['team','analytics','spec','admin/automations','admin/audit','admin/users']),
      ('settings',    ARRAY['admin/settings'])
      -- 'library', 'ai', 'equipment' and 'leave' keep their keys unchanged
    ),
    expanded AS (
      SELECT p.user_id,
             jsonb_agg(DISTINCT k) AS mods
        FROM mo_user_profiles p
        CROSS JOIN LATERAL jsonb_array_elements_text(p.allowed_modules) AS m(key)
        CROSS JOIN LATERAL unnest(COALESCE((SELECT l.new FROM legacy l WHERE l.old = m.key),
                                           ARRAY[m.key])) AS k
       WHERE p.allowed_modules IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.allowed_modules) x(k)
                      WHERE x.k IN (SELECT old FROM legacy))
       GROUP BY p.user_id
    )
    UPDATE mo_user_profiles p SET allowed_modules = e.mods
      FROM expanded e WHERE e.user_id = p.user_id`);

  // ── §11.2 Projects & production ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_project_types (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL, slug TEXT NOT NULL,
      color TEXT, icon TEXT, sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true,
      default_template_id BIGINT
    )`);
  // Academic Units (faculties / schools / university-wide) — Admin-configurable
  // master data, replacing the old hard-coded `faculty_served` free-text field.
  // Referenced by projects; archived units stay referencable so historical
  // projects keep rendering correctly (VR-11 deactivate-never-delete).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_academic_units (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id),
      name TEXT NOT NULL, slug TEXT, short_name TEXT, notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_academic_units_name ON mo_academic_units(lower(name))`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_projects (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), campus_id BIGINT REFERENCES mo_campuses(id),
      academic_year_id BIGINT REFERENCES mo_academic_years(id),
      project_type_id BIGINT NOT NULL REFERENCES mo_project_types(id),
      code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      academic_unit_id BIGINT REFERENCES mo_academic_units(id),
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
        ('proposed','approved','planning','in_production','in_review','delivered','completed','archived','on_hold','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
      owner_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
      start_date DATE, end_date DATE, cover_image_url TEXT, type_meta JSONB NOT NULL DEFAULT '{}'::JSONB,
      source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','excel_import','request')),
      archived_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // ── Migration: faculty_served (free text) → mo_academic_units FK ──────────
  // Idempotent and lossless: every distinct legacy value becomes a unit, every
  // project is re-pointed at it, and only then is the old column dropped.
  await pool.query(`ALTER TABLE mo_projects ADD COLUMN IF NOT EXISTS academic_unit_id BIGINT REFERENCES mo_academic_units(id)`);
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='mo_projects' AND column_name='faculty_served') THEN
      INSERT INTO mo_academic_units (department_id, name, slug, is_active, sort_order)
        SELECT 1, TRIM(p.faculty_served),
               regexp_replace(lower(TRIM(p.faculty_served)), '[^a-z0-9]+', '-', 'g'), true, 0
          FROM (SELECT DISTINCT faculty_served FROM mo_projects
                 WHERE faculty_served IS NOT NULL AND TRIM(faculty_served) <> '') p
         WHERE NOT EXISTS (SELECT 1 FROM mo_academic_units a
                            WHERE lower(a.name) = lower(TRIM(p.faculty_served)));
      UPDATE mo_projects p SET academic_unit_id = a.id
        FROM mo_academic_units a
       WHERE p.academic_unit_id IS NULL
         AND p.faculty_served IS NOT NULL
         AND lower(a.name) = lower(TRIM(p.faculty_served));
      -- Only drop once nothing is left unmapped.
      IF NOT EXISTS (SELECT 1 FROM mo_projects
                      WHERE faculty_served IS NOT NULL AND TRIM(faculty_served) <> ''
                        AND academic_unit_id IS NULL) THEN
        ALTER TABLE mo_projects DROP COLUMN faculty_served;
      END IF;
    END IF;
  END $$`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_status ON mo_projects(department_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_unit ON mo_projects(academic_unit_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_deadline ON mo_projects(end_date)
                    WHERE status NOT IN ('completed','archived','cancelled')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_fts ON mo_projects
                    USING GIN (to_tsvector('english', coalesce(name,'') || ' ' || coalesce(description,'')))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_project_assignments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES mo_projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      capacity_role_id BIGINT REFERENCES mo_capacity_roles(id),
      is_project_manager BOOLEAN NOT NULL DEFAULT false,
      assigned_by TEXT REFERENCES users(id), assigned_at DATE NOT NULL DEFAULT CURRENT_DATE, removed_at TIMESTAMPTZ
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_assign_unique ON mo_project_assignments(project_id, user_id) WHERE removed_at IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_one_pm ON mo_project_assignments(project_id) WHERE is_project_manager AND removed_at IS NULL`);

  // ── Work Types (unified "Assign Work") ───────────────────────────────────
  // Admin-configurable catalogue of the kinds of work that can be assigned.
  // form_template drives which form the UI renders and which record the API
  // writes — never a hard-coded name check.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_work_types (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id),
      name TEXT NOT NULL, slug TEXT, icon TEXT,
      form_template TEXT NOT NULL DEFAULT 'standard_task'
        CHECK (form_template IN ('standard_task','shoot')),
      sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_work_types_name ON mo_work_types(lower(name))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_shoots (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES mo_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, shoot_date DATE NOT NULL, call_time TEXT, end_time TEXT,
      location TEXT, location_url TEXT, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done','cancelled'))
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_shoots_date ON mo_shoots(shoot_date)`);
  // BR-13: shoots are soft-deletable too (A2).
  await pool.query(`ALTER TABLE mo_shoots ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_shoot_crew (
      shoot_id BIGINT NOT NULL REFERENCES mo_shoots(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      capacity_role_id BIGINT REFERENCES mo_capacity_roles(id),
      is_replacement BOOLEAN NOT NULL DEFAULT false, replaced_user_id TEXT REFERENCES users(id),
      PRIMARY KEY (shoot_id, user_id)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_project_templates (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_type_id BIGINT NOT NULL REFERENCES mo_project_types(id), name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_template_deliverables (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      template_id BIGINT NOT NULL REFERENCES mo_project_templates(id) ON DELETE CASCADE,
      deliverable_type_id BIGINT NOT NULL, title_pattern TEXT NOT NULL,
      default_weight SMALLINT NOT NULL DEFAULT 1, days_offset_due INTEGER NOT NULL DEFAULT 5
    )`);
  // Task/Assignment layer — a TL/Admin assigns scheduled work to crew inside a
  // project. Distinct from mo_project_assignments (membership → "My Projects") and
  // from mo_report_tasks (self-logged work). Surfaces in the assignee's "Today's
  // Assignments" when the current date falls within [start_date, due_date].
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_assignments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES mo_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, assigned_by TEXT REFERENCES users(id),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','done','blocked','cancelled')),
      start_date DATE, due_date DATE, start_time TEXT, end_time TEXT, notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_assignment_users (
      assignment_id BIGINT NOT NULL REFERENCES mo_assignments(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (assignment_id, user_id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_assign_sched ON mo_assignments(start_date, due_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_assign_user ON mo_assignment_users(user_id)`);
  // ── Unified Assign Work: both record kinds carry their work type ─────────
  await pool.query(`ALTER TABLE mo_shoots ADD COLUMN IF NOT EXISTS work_type_id BIGINT REFERENCES mo_work_types(id)`);
  await pool.query(`ALTER TABLE mo_assignments ADD COLUMN IF NOT EXISTS work_type_id BIGINT REFERENCES mo_work_types(id)`);
  // Attribution. Every row in an employee's Today's Assignments shows who assigned
  // it, so a shoot must carry the same attribution a standard task already has.
  await pool.query(`ALTER TABLE mo_shoots ADD COLUMN IF NOT EXISTS created_by TEXT REFERENCES users(id)`);
  // Seed the starter catalogue once (Admin can edit/extend it from Settings).
  await pool.query(`
    INSERT INTO mo_work_types (department_id, name, slug, icon, form_template, sort_order, is_active)
    SELECT (SELECT id FROM mo_departments ORDER BY id LIMIT 1), x.name, x.slug, x.icon, x.tpl, x.so, true FROM (VALUES
      ('General Task','general-task','◆','standard_task',1),
      ('Shoot','shoot','◉','shoot',2),
      ('Drone Shoot','drone-shoot','✈','shoot',3),
      ('Podcast Recording','podcast-recording','♪','shoot',4),
      ('Editing','editing','✂','standard_task',5),
      ('Photography','photography','▣','standard_task',6),
      ('Videography','videography','▶','standard_task',7),
      ('Animation','animation','◈','standard_task',8),
      ('Meeting','meeting','☎','standard_task',9)
    ) AS x(name, slug, icon, tpl, so)
    WHERE NOT EXISTS (SELECT 1 FROM mo_work_types w WHERE lower(w.name)=lower(x.name))`);
  // Migrate legacy records: every shoot is a 'Shoot'; every pre-existing
  // assignment becomes a 'General Task' (neutral — we don't invent a category).
  await pool.query(`UPDATE mo_shoots SET work_type_id=(SELECT id FROM mo_work_types WHERE slug='shoot')
                     WHERE work_type_id IS NULL`);
  await pool.query(`UPDATE mo_assignments SET work_type_id=(SELECT id FROM mo_work_types WHERE slug='general-task')
                     WHERE work_type_id IS NULL`);
  // ── §11.3 Deliverables & assets ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_deliverable_types (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL, slug TEXT NOT NULL,
      icon TEXT, default_weight SMALLINT NOT NULL DEFAULT 1, default_unit TEXT NOT NULL DEFAULT 'items',
      review_exempt BOOLEAN NOT NULL DEFAULT false, is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_deliverables (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES mo_projects(id) ON DELETE CASCADE,
      deliverable_type_id BIGINT NOT NULL REFERENCES mo_deliverable_types(id),
      title TEXT NOT NULL, owner_id TEXT REFERENCES users(id), due_date DATE, completed_at DATE,
      quantity_target INTEGER, quantity_delivered INTEGER, unit TEXT, spec_notes TEXT NOT NULL DEFAULT '',
      weight SMALLINT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN
        ('not_started','in_progress','in_review','changes_requested','approved','delivered','not_required','cancelled')),
      social_status TEXT NOT NULL DEFAULT 'na' CHECK (social_status IN ('na','scheduled','posted')),
      social_post_url TEXT, social_posted_at DATE,
      mail_status TEXT NOT NULL DEFAULT 'na' CHECK (mail_status IN ('na','pending','sent')), mail_sent_at DATE,
      -- Scheduling: a deliverable is project scope, NOT today's work. It only
      -- surfaces in an assignee's Today's Assignments once a TL/PM schedules it
      -- for a date. NULL scheduled_date = backlog (project page only).
      scheduled_date DATE,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
      estimated_hours NUMERIC(5,1),
      approval_status TEXT NOT NULL DEFAULT 'pending' CHECK (approval_status IN ('pending','approved','changes_requested','rejected')),
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Existing DBs: add the scheduling/model columns if they predate this feature.
  // Admin-configurable default: how many days after the project end date this
  // type is normally due. Pre-fills project creation; never overwritten by a
  // project-level override (PRD §3/§6).
  await pool.query(`ALTER TABLE mo_deliverable_types ADD COLUMN IF NOT EXISTS default_due_offset_days INTEGER NOT NULL DEFAULT 5`);
  // Three values kept SEPARATE (PRD §6):
  //   mo_template_deliverables.days_offset_due → template default
  //   mo_deliverables.due_offset_days          → this project's override
  //   mo_deliverables.due_date                 → the actual date
  // due_date_source records whether the date still tracks the offset ('offset')
  // or was hand-picked ('manual'); manual dates are never auto-recalculated (§9).
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS due_offset_days INTEGER`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS due_date_source TEXT NOT NULL DEFAULT 'offset'
                    CHECK (due_date_source IN ('offset','manual'))`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS scheduled_date DATE`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(5,1)`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending'`);
  // Who marked it Delivered, and when the approval state last moved — shown on
  // the Delivered Outputs cards and used by the Team Lead review queue.
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS delivered_by TEXT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  // Back-fill: seed each type's default offset from its most common template
  // value so existing installs keep the numbers people already expect.
  await pool.query(`
    UPDATE mo_deliverable_types dt SET default_due_offset_days = src.d
      FROM (SELECT deliverable_type_id, MODE() WITHIN GROUP (ORDER BY days_offset_due) AS d
              FROM mo_template_deliverables GROUP BY deliverable_type_id) src
     WHERE src.deliverable_type_id = dt.id AND dt.default_due_offset_days = 5 AND src.d IS NOT NULL`);
  // Back-fill existing deliverables so their stored offset matches reality.
  await pool.query(`
    UPDATE mo_deliverables d SET due_offset_days = GREATEST(0, (d.due_date - p.end_date))
      FROM mo_projects p
     WHERE p.id = d.project_id AND d.due_offset_days IS NULL
       AND d.due_date IS NOT NULL AND p.end_date IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_scheduled ON mo_deliverables(scheduled_date, owner_id)
                    WHERE scheduled_date IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_project ON mo_deliverables(project_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_owner ON mo_deliverables(owner_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_overdue ON mo_deliverables(due_date)
                    WHERE status NOT IN ('delivered','not_required','cancelled')`);

  // G1/A1 self-heal: soft-delete any deliverable whose parent project is already
  // soft-deleted (orphans created before the cascade existed). Idempotent.
  await pool.query(`UPDATE mo_deliverables d SET deleted_at=NOW() WHERE d.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM mo_projects p WHERE p.id=d.project_id AND p.deleted_at IS NULL)`);
  await pool.query(`ALTER TABLE mo_assignments ADD COLUMN IF NOT EXISTS deliverable_id BIGINT REFERENCES mo_deliverables(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE mo_assignments ADD COLUMN IF NOT EXISTS estimated_hours NUMERIC(5,1)`);
  // ── Migration: deliverable-backed assignments → deliverable scheduling ────
  // Project creation used to auto-generate one mo_assignments row per deliverable
  // owner, which pushed un-scheduled project scope straight into Today's
  // Assignments. Deliverables now carry their own schedule, so fold those rows
  // back into the deliverable and drop them. Idempotent: it only ever matches
  // assignments that still have a deliverable_id.
  await pool.query(`
    UPDATE mo_deliverables d SET
      scheduled_date  = COALESCE(d.scheduled_date, a.start_date),
      estimated_hours = COALESCE(d.estimated_hours, a.estimated_hours),
      priority        = CASE WHEN d.priority='normal' THEN COALESCE(a.priority, d.priority) ELSE d.priority END,
      owner_id        = COALESCE(d.owner_id, (SELECT au.user_id FROM mo_assignment_users au WHERE au.assignment_id=a.id LIMIT 1))
    FROM mo_assignments a
    WHERE a.deliverable_id = d.id`);
  await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id IN (SELECT id FROM mo_assignments WHERE deliverable_id IS NOT NULL)`);
  await pool.query(`DELETE FROM mo_assignments WHERE deliverable_id IS NOT NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_drive_links (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('project','deliverable','deliverable_version','report_task','equipment')),
      entity_id BIGINT NOT NULL, label TEXT, url TEXT NOT NULL, added_by TEXT REFERENCES users(id),
      validation_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (validation_status IN ('unchecked','ok','broken','no_permission')),
      last_validated_at DATE, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_links_entity ON mo_drive_links(entity_type, entity_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_deliverable_versions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      deliverable_id BIGINT NOT NULL REFERENCES mo_deliverables(id) ON DELETE CASCADE,
      version_no SMALLINT NOT NULL, drive_url TEXT, note TEXT, submitted_by TEXT REFERENCES users(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','changes_requested')),
      reviewed_by TEXT REFERENCES users(id), reviewed_at TIMESTAMPTZ, review_comment TEXT NOT NULL DEFAULT '',
      UNIQUE (deliverable_id, version_no)
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_attachments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entity_type TEXT NOT NULL, entity_id BIGINT NOT NULL, file_name TEXT, mime TEXT, size_bytes INTEGER,
      storage_path TEXT, uploaded_by TEXT REFERENCES users(id), uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_tags (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL, color TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_entity_tags (
      tag_id BIGINT NOT NULL REFERENCES mo_tags(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL, entity_id BIGINT NOT NULL,
      PRIMARY KEY (tag_id, entity_type, entity_id)
    )`);

  // ── §11.4 Daily reporting ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_task_categories (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL, icon TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true, sort_order INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_daily_reports (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, report_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','flagged','approved','auto_approved','returned')),
      submitted_at TIMESTAMPTZ, note TEXT NOT NULL DEFAULT '', flagged_reason TEXT,
      reviewed_by TEXT REFERENCES users(id), reviewed_at TIMESTAMPTZ, review_comment TEXT NOT NULL DEFAULT '',
      total_minutes INTEGER NOT NULL DEFAULT 0, late BOOLEAN NOT NULL DEFAULT false,
      auto_approved BOOLEAN NOT NULL DEFAULT false, flag_rules JSONB NOT NULL DEFAULT '[]'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- Re-review trail: any content change after submission invalidates the
      -- approval and sends the report back to the reviewer (never silently).
      last_edited_at TIMESTAMPTZ, last_edited_by TEXT REFERENCES users(id),
      edited_after_submit BOOLEAN NOT NULL DEFAULT false,
      revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE (user_id, report_date)  -- BR-3: one report per user per calendar day
    )`);
  // Existing DBs: add the re-review columns if they predate this feature.
  await pool.query(`ALTER TABLE mo_daily_reports ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE mo_daily_reports ADD COLUMN IF NOT EXISTS last_edited_by TEXT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE mo_daily_reports ADD COLUMN IF NOT EXISTS edited_after_submit BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE mo_daily_reports ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_reports_queue ON mo_daily_reports(status) WHERE status IN ('submitted','flagged')`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_report_tasks (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      daily_report_id BIGINT NOT NULL REFERENCES mo_daily_reports(id) ON DELETE CASCADE,
      project_id BIGINT REFERENCES mo_projects(id), task_category_id BIGINT REFERENCES mo_task_categories(id),
      deliverable_id BIGINT REFERENCES mo_deliverables(id), description TEXT NOT NULL DEFAULT '',
      start_time TEXT, end_time TEXT, minutes INTEGER NOT NULL DEFAULT 0,
      progress_before SMALLINT, progress_after SMALLINT, quantity INTEGER, unit TEXT,
      status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','in_progress','blocked')),
      blocker_note TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0,
      evidence JSONB NOT NULL DEFAULT '[]'::JSONB
    )`);
  // Task-log rows carry their own timestamps so My Day can show "last updated"
  // and tell a still-running task from a finished one.
  await pool.query(`ALTER TABLE mo_report_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE mo_report_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_tasks_deliv ON mo_report_tasks(deliverable_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_tasks_report ON mo_report_tasks(daily_report_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_tasks_project ON mo_report_tasks(project_id)`);

  // ── §11.5 Equipment ──────────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_equipment_categories (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL,
      tracking_mode TEXT NOT NULL DEFAULT 'individual' CHECK (tracking_mode IN ('individual','pooled')),
      icon TEXT, sort_order INTEGER NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_vendors (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL, contact TEXT, phone TEXT, email TEXT, notes TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_equipment_items (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), campus_id BIGINT REFERENCES mo_campuses(id),
      category_id BIGINT NOT NULL REFERENCES mo_equipment_categories(id),
      asset_tag TEXT UNIQUE NOT NULL, qr_uid TEXT UNIQUE, barcode TEXT, make TEXT, model TEXT, serial_no TEXT,
      purchase_date DATE, purchase_cost NUMERIC(12,2), vendor_id BIGINT REFERENCES mo_vendors(id),
      warranty_until DATE, insurance_policy_no TEXT, insurance_until DATE,
      condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('excellent','good','fair','poor')),
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','checked_out','booked','maintenance','retired','lost')),
      pool_quantity INTEGER, photo_url TEXT, notes TEXT NOT NULL DEFAULT '', deleted_at TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_equip_status ON mo_equipment_items(category_id, status)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_equipment_kits (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, description TEXT, is_active BOOLEAN NOT NULL DEFAULT true
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_kit_items (
      kit_id BIGINT NOT NULL REFERENCES mo_equipment_kits(id) ON DELETE CASCADE,
      equipment_item_id BIGINT NOT NULL REFERENCES mo_equipment_items(id) ON DELETE CASCADE,
      PRIMARY KEY (kit_id, equipment_item_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_equipment_bookings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      equipment_item_id BIGINT NOT NULL REFERENCES mo_equipment_items(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id), shoot_id BIGINT REFERENCES mo_shoots(id),
      project_id BIGINT REFERENCES mo_projects(id), starts_at DATE NOT NULL, ends_at DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','active','completed','cancelled')),
      created_by TEXT REFERENCES users(id),
      -- AC-7: the DB itself prevents a double-booking of one item over overlapping windows.
      EXCLUDE USING gist (
        equipment_item_id WITH =,
        daterange(starts_at, ends_at, '[]') WITH &&
      ) WHERE (status IN ('reserved','active'))
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_equipment_transactions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      equipment_item_id BIGINT NOT NULL REFERENCES mo_equipment_items(id) ON DELETE CASCADE,
      booking_id BIGINT REFERENCES mo_equipment_bookings(id), holder_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL CHECK (action IN ('check_out','check_in')), quantity INTEGER NOT NULL DEFAULT 1,
      condition_noted TEXT, expected_return_at DATE, occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recorded_via TEXT NOT NULL DEFAULT 'desktop' CHECK (recorded_via IN ('desktop','mobile','kiosk')),
      recorded_by TEXT REFERENCES users(id)
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_txn_item ON mo_equipment_transactions(equipment_item_id, occurred_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_maintenance_records (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      equipment_item_id BIGINT NOT NULL REFERENCES mo_equipment_items(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('maintenance','repair','damage_report')), description TEXT,
      cost NUMERIC(12,2), vendor_id BIGINT REFERENCES mo_vendors(id), reported_by TEXT REFERENCES users(id),
      started_at DATE, resolved_at DATE, next_due_at DATE
    )`);

  // ── §11.6 Kanban, calendar, HR-adjacent ──────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_boards (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL,
      is_management BOOLEAN NOT NULL DEFAULT true, sync_status BOOLEAN NOT NULL DEFAULT false,
      description TEXT NOT NULL DEFAULT '', created_by TEXT REFERENCES users(id), is_active BOOLEAN NOT NULL DEFAULT true
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_board_columns (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      board_id BIGINT NOT NULL REFERENCES mo_boards(id) ON DELETE CASCADE, name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, wip_limit INTEGER, maps_to_status TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_labels (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, color TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_cards (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      board_id BIGINT NOT NULL REFERENCES mo_boards(id) ON DELETE CASCADE,
      column_id BIGINT NOT NULL REFERENCES mo_board_columns(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      linked_entity_type TEXT CHECK (linked_entity_type IN ('project','deliverable')), linked_entity_id BIGINT,
      priority TEXT NOT NULL DEFAULT 'normal', due_date DATE, sort_order INTEGER NOT NULL DEFAULT 0,
      created_by TEXT REFERENCES users(id), archived_at TIMESTAMPTZ
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_card_assignees (
      card_id BIGINT NOT NULL REFERENCES mo_cards(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (card_id, user_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_card_labels (
      card_id BIGINT NOT NULL REFERENCES mo_cards(id) ON DELETE CASCADE,
      label_id BIGINT NOT NULL REFERENCES mo_labels(id) ON DELETE CASCADE, PRIMARY KEY (card_id, label_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_card_checklist_items (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      card_id BIGINT NOT NULL REFERENCES mo_cards(id) ON DELETE CASCADE, text TEXT NOT NULL,
      is_done BOOLEAN NOT NULL DEFAULT false, sort_order INTEGER NOT NULL DEFAULT 0
    )`);
  // Operational leave categories only (Casual/Sick/Comp-off/...) — no HR quota
  // data. This module tracks availability + approval, not leave balances; the
  // university's separate HR system owns quotas, credits, and payroll.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_leave_types (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true, notes TEXT
    )`);
  // Existing DBs: drop the HR-style quota column if it predates this change.
  await pool.query(`ALTER TABLE mo_leave_types DROP COLUMN IF EXISTS annual_quota`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_leave_requests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      leave_type_id BIGINT NOT NULL REFERENCES mo_leave_types(id), starts_on DATE NOT NULL, ends_on DATE NOT NULL,
      day_type TEXT NOT NULL DEFAULT 'full' CHECK (day_type IN ('full','half_morning','half_afternoon')),
      reason TEXT NOT NULL DEFAULT '',
      replacement_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      affected_project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL,
      remarks TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      decided_by TEXT REFERENCES users(id), decided_at DATE, decision_note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // Existing DBs: migrate the old boolean into the new three-way day_type,
  // then add the newer optional fields.
  await pool.query(`ALTER TABLE mo_leave_requests ADD COLUMN IF NOT EXISTS day_type TEXT NOT NULL DEFAULT 'full'`);
  await pool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='mo_leave_requests' AND column_name='half_day') THEN
      UPDATE mo_leave_requests SET day_type = 'half_morning' WHERE half_day = true AND day_type = 'full';
      ALTER TABLE mo_leave_requests DROP COLUMN half_day;
    END IF;
  END $$`);
  await pool.query(`ALTER TABLE mo_leave_requests ADD COLUMN IF NOT EXISTS replacement_user_id TEXT REFERENCES users(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE mo_leave_requests ADD COLUMN IF NOT EXISTS affected_project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE mo_leave_requests ADD COLUMN IF NOT EXISTS remarks TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE mo_leave_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`ALTER TABLE mo_leave_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_leave_replacements (
      leave_request_id BIGINT NOT NULL REFERENCES mo_leave_requests(id) ON DELETE CASCADE,
      shoot_id BIGINT NOT NULL REFERENCES mo_shoots(id) ON DELETE CASCADE,
      replacement_user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (leave_request_id, shoot_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_holidays (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      campus_id BIGINT REFERENCES mo_campuses(id), date DATE NOT NULL, name TEXT NOT NULL
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_kra_cycles (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), label TEXT NOT NULL, starts_on DATE, ends_on DATE,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_kras (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kra_cycle_id BIGINT NOT NULL REFERENCES mo_kra_cycles(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
      metric_source TEXT NOT NULL DEFAULT 'manual' CHECK (metric_source IN ('manual','auto')),
      auto_metric_key TEXT, target_text TEXT, weight SMALLINT NOT NULL DEFAULT 0
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_kra_reviews (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kra_id BIGINT NOT NULL REFERENCES mo_kras(id) ON DELETE CASCADE,
      phase TEXT NOT NULL CHECK (phase IN ('self','manager')), score NUMERIC(5,2), achievement_pct NUMERIC(5,2),
      comment TEXT, reviewer_id TEXT REFERENCES users(id), reviewed_at DATE,
      UNIQUE (kra_id, phase)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_performance_snapshots (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, month DATE NOT NULL,
      hours_logged NUMERIC, tasks_count INTEGER, deliverables_completed INTEGER, weighted_output NUMERIC,
      on_time_pct NUMERIC, consistency_pct NUMERIC, projects_touched INTEGER, computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, month)
    )`);

  // ── §11.7 Platform tables ────────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_comments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      entity_type TEXT NOT NULL, entity_id BIGINT NOT NULL, user_id TEXT REFERENCES users(id),
      body TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_notifications (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT, title TEXT, body TEXT,
      entity_type TEXT, entity_id BIGINT, is_read BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_notif_user ON mo_notifications(user_id, is_read, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_notification_preferences (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('in_app','email','push')), enabled BOOLEAN NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, kind, channel)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_automation_rules (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), rule_key TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      trigger TEXT, action TEXT, is_enabled BOOLEAN NOT NULL DEFAULT true, config JSONB NOT NULL DEFAULT '{}'::JSONB,
      updated_by TEXT REFERENCES users(id)
    )`);

  // ── CRUD Engine lifecycle columns ─────────────────────────────────────────
  // Every Admin-configurable table carries the same lifecycle: is_active
  // (enable/disable — VR-11 deactivate-never-delete), archived_at (hidden from
  // future use, history intact), created_by/updated_at (audit filters). Applied
  // uniformly so the generic CRUD engine can treat all config modules the same.
  // Runs after all target tables are created (they already define these
  // columns for fresh DBs) — this is the migration path for pre-existing DBs.
  for (const t of ["mo_project_types", "mo_deliverable_types", "mo_task_categories", "mo_equipment_categories",
                   "mo_leave_types", "mo_skills", "mo_capacity_roles", "mo_vendors", "mo_tags", "mo_duty_flags",
                   "mo_academic_years", "mo_academic_units", "mo_work_types", "mo_campuses", "mo_holidays", "mo_project_templates",
                   "mo_template_deliverables", "mo_automation_rules"]) {
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS created_by TEXT`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
    await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_audit_logs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_id TEXT REFERENCES users(id), actor_role TEXT, action TEXT NOT NULL,
      entity_type TEXT, entity_id BIGINT, before JSONB, after JSONB, ip TEXT, user_agent TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // D4 / §11.1 — ONE role vocabulary in the audit trail: migrate historical rows
  // written with the platform's raw roles, then constrain so a 4th value can
  // never be written. (users.role stays platform-wide — it is shared with the
  // other Nerve departments and is mapped via moRoleOf at the media boundary.)
  await pool.query(`UPDATE mo_audit_logs SET actor_role = CASE actor_role
      WHEN 'sub_admin' THEN 'team_lead' WHEN 'user' THEN 'employee' WHEN 'super_admin' THEN 'admin'
      ELSE actor_role END
    WHERE actor_role IN ('sub_admin','user','super_admin')`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='mo_audit_actor_role_chk') THEN
      ALTER TABLE mo_audit_logs ADD CONSTRAINT mo_audit_actor_role_chk
        CHECK (actor_role IS NULL OR actor_role IN ('admin','team_lead','employee','system'));
    END IF;
  END $$`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_audit_entity ON mo_audit_logs(entity_type, entity_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_audit_actor ON mo_audit_logs(actor_id, occurred_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_saved_views (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT REFERENCES users(id), module TEXT, name TEXT, filters JSONB NOT NULL DEFAULT '{}'::JSONB,
      is_shared BOOLEAN NOT NULL DEFAULT false
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_import_batches (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      file_name TEXT, sheets INTEGER, rows_total INTEGER, rows_imported INTEGER, rows_in_review INTEGER,
      imported_by TEXT REFERENCES users(id), imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_import_issues (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      batch_id BIGINT REFERENCES mo_import_batches(id) ON DELETE CASCADE,
      sheet TEXT, row INTEGER, "column" TEXT, raw_value TEXT, issue TEXT, suggestion TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved'))
    )`);

  // ═══════════ ACCOUNT LIFECYCLE — removal without data loss ════════════════
  // 93 foreign keys point at users(id): reports, deliverable versions, reviews,
  // comments, audit rows, dispatch records. A hard DELETE is therefore rejected
  // by the database, which is why removing a member used to fail with
  // "reassign their work first".
  //
  // Keeping the row and moving the ACCOUNT through a lifecycle solves that
  // properly: every historical reference still resolves, so "Delivered by Manav
  // Trivedi" keeps rendering the real name for ever. Nulling those FKs and
  // snapshotting names would lose exactly that, across 93 relationships.
  //
  //   active   — normal account
  //   inactive — removed from operational use, could be restored
  //   archived — removed by an Admin; cannot log in, history retained
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
  await pool.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check`);
  await pool.query(`ALTER TABLE users ADD CONSTRAINT users_status_check
                    CHECK (status IN ('active','inactive','archived'))`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by TEXT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivation_reason TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_users_status ON users(status) WHERE status <> 'active'`);

  // ═══════════ MEDIA OPERATIONS COORDINATOR (§ operations role) ═════════════
  // A dedicated media-department role that owns the first and last stages of a
  // project: intake → clarification → conversion, then dispatch → archive.
  // Nerve-wide three-role parity is preserved — users.role stays admin/sub_admin/
  // user; the coordinator is a MEDIA role held in mo_user_profiles.mo_role.
  await pool.query(`ALTER TABLE mo_user_profiles DROP CONSTRAINT IF EXISTS mo_user_profiles_mo_role_check`);
  await pool.query(`ALTER TABLE mo_user_profiles ADD CONSTRAINT mo_user_profiles_mo_role_check
                    CHECK (mo_role IN ('admin','team_lead','employee','coordinator'))`);

  // ── Request intake. A coordinator never creates a project directly: every job
  // enters as a request and is CONVERTED once it has the information it needs.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_requests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT,
      institute TEXT NOT NULL DEFAULT '',
      academic_unit_id BIGINT REFERENCES mo_academic_units(id),
      stakeholder TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      event_name TEXT NOT NULL,
      project_type_id BIGINT REFERENCES mo_project_types(id),
      venue TEXT,
      event_date DATE,
      event_time TEXT,
      end_date DATE,
      description TEXT NOT NULL DEFAULT '',
      deliverables_requested JSONB NOT NULL DEFAULT '[]'::jsonb,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
      budget NUMERIC(12,2),
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','needs_clarification','ready','converted','closed','rejected')),
      project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL,
      lead_user_id TEXT REFERENCES users(id),
      received_by TEXT REFERENCES users(id),
      converted_by TEXT REFERENCES users(id),
      converted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_requests_status ON mo_requests(status)`);
  // Intake detail the coordinator actually collects on the phone.
  await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS contact_email TEXT`);
  await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS contact_phone TEXT`);
  await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS requirement TEXT`);
  await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS meeting_required BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS vendor_required BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES mo_teams(id)`);
  // Venue travels with the work: request → project → shoot → calendar → filters.
  await pool.query(`ALTER TABLE mo_projects ADD COLUMN IF NOT EXISTS venue TEXT`);
  // §18 — a project converted from a request before a team is chosen has NO
  // production owner yet. That "Needs assignment" state must be representable,
  // otherwise the coordinator ends up owning production work by default.
  await pool.query(`ALTER TABLE mo_projects ALTER COLUMN owner_id DROP NOT NULL`);

  // ── Coordination logs. Deliberately light: they record that contact happened,
  // they do not become a CRM.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_meetings (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'stakeholder' CHECK (kind IN ('stakeholder','vendor','internal')),
      stakeholder TEXT NOT NULL DEFAULT '',
      vendor_id BIGINT REFERENCES mo_vendors(id),
      project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL,
      request_id BIGINT REFERENCES mo_requests(id) ON DELETE SET NULL,
      purpose TEXT NOT NULL DEFAULT '',
      meet_date DATE NOT NULL,
      meet_time TEXT,
      duration_min INTEGER,
      location TEXT,
      outcome TEXT NOT NULL DEFAULT '',
      next_action TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
      logged_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_meetings_date ON mo_meetings(meet_date)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_vendor_activities (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      vendor_id BIGINT REFERENCES mo_vendors(id) ON DELETE CASCADE,
      project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL,
      kind TEXT NOT NULL DEFAULT 'call' CHECK (kind IN ('quotation','purchase','meeting','call','email')),
      purpose TEXT NOT NULL DEFAULT '',
      amount NUMERIC(12,2),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_reply','closed','cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      activity_date DATE NOT NULL DEFAULT CURRENT_DATE,
      logged_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_followups (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id BIGINT REFERENCES mo_requests(id) ON DELETE CASCADE,
      project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL,
      vendor_id BIGINT REFERENCES mo_vendors(id) ON DELETE SET NULL,
      stakeholder TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      pending_since DATE NOT NULL DEFAULT CURRENT_DATE,
      reminder_date DATE,
      last_contact_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting_reply','resolved','cancelled')),
      notes TEXT NOT NULL DEFAULT '',
      owner_id TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_followups_status ON mo_followups(status)`);

  // ── Dispatch trail. Approval is a CREATIVE verdict (Team Lead); dispatch is an
  // OPERATIONAL one (coordinator). Keeping them on separate columns means an
  // approved deliverable is never silently treated as delivered.
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS dispatch_status TEXT NOT NULL DEFAULT 'none'
                    CHECK (dispatch_status IN ('none','queued','sent','delivered','archived'))`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS dispatch_recipient TEXT`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS dispatch_subject TEXT`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS dispatch_notes TEXT`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS dispatched_by TEXT REFERENCES users(id)`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE mo_deliverables ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ`);
  // Anything already approved enters the queue, so the first coordinator to sign
  // in inherits a correct backlog rather than an empty one.
  await pool.query(`UPDATE mo_deliverables SET dispatch_status='queued', queued_at=NOW()
                     WHERE dispatch_status='none' AND deleted_at IS NULL
                       AND id IN (SELECT deliverable_id FROM mo_deliverable_versions
                                   WHERE review_status='approved')`);

  // ═══════════════════ CASTING LIBRARY (§ casting module) ═══════════════════
  // An internal casting reference library: who is available to appear in a
  // production, with the approved media kept in Drive. NERVE stores metadata,
  // consent and relationships only — never the media itself, so this stays
  // lightweight and does not become a second Media Library.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_tags (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other'
        CHECK (category IN ('profession','production_type','age_group','language','requirement','other')),
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      archived_at TIMESTAMPTZ,
      created_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_casting_tag_name ON mo_casting_tags(lower(name))`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_collections (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      archived_at TIMESTAMPTZ,
      created_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_casting_coll_name ON mo_casting_collections(lower(name))`);

  // The record itself. Only production-relevant attributes: nothing sensitive is
  // collected, and nothing is inferred from someone's appearance.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_records (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cast_id TEXT UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      profession TEXT,
      age_group TEXT CHECK (age_group IN ('child','teen','young_adult','adult','middle_aged','senior')),
      gender TEXT,                       -- optional, only where a production genuinely requires it
      languages JSONB NOT NULL DEFAULT '[]'::jsonb,
      campus_id BIGINT REFERENCES mo_campuses(id),
      location TEXT,
      availability TEXT NOT NULL DEFAULT 'available'
        CHECK (availability IN ('available','limited','unavailable','archived')),
      -- Consent is what decides whether a record may be used, so it is first-class
      -- rather than a note. Only 'confirmed' reaches the employee-facing preview.
      consent_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (consent_status IN ('confirmed','pending','restricted','expired')),
      consent_date DATE,
      consent_scope TEXT,
      review_date DATE,
      drive_url TEXT,
      drive_checked_at TIMESTAMPTZ,
      drive_ok BOOLEAN,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_casting_avail ON mo_casting_records(availability) WHERE archived_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_casting_consent ON mo_casting_records(consent_status)`);

  // Many-to-many: a record carries several tags and can sit in several collections.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_record_tags (
      record_id BIGINT NOT NULL REFERENCES mo_casting_records(id) ON DELETE CASCADE,
      tag_id BIGINT NOT NULL REFERENCES mo_casting_tags(id) ON DELETE CASCADE,
      PRIMARY KEY (record_id, tag_id)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_record_collections (
      record_id BIGINT NOT NULL REFERENCES mo_casting_records(id) ON DELETE CASCADE,
      collection_id BIGINT NOT NULL REFERENCES mo_casting_collections(id) ON DELETE CASCADE,
      PRIMARY KEY (record_id, collection_id)
    )`);

  // A request is how the library becomes operational: anyone can ask for casting
  // they could not find, and the Casting Manager works the queue.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_requests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id TEXT UNIQUE,
      requested_by TEXT REFERENCES users(id),
      project_id BIGINT REFERENCES mo_projects(id) ON DELETE SET NULL,
      need TEXT NOT NULL,
      category TEXT,
      age_group TEXT,
      gender TEXT,
      languages JSONB NOT NULL DEFAULT '[]'::jsonb,
      due_date DATE,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new'
        CHECK (status IN ('new','reviewing','searching','candidate_found','completed','rejected')),
      matched_record_id BIGINT REFERENCES mo_casting_records(id) ON DELETE SET NULL,
      handled_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_casting_req_status ON mo_casting_requests(status)`);

  // §33 — which casting a project actually used.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_project_casting (
      project_id BIGINT NOT NULL REFERENCES mo_projects(id) ON DELETE CASCADE,
      record_id BIGINT NOT NULL REFERENCES mo_casting_records(id) ON DELETE CASCADE,
      linked_by TEXT REFERENCES users(id),
      linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, record_id)
    )`);

  // Casting Manager is a DUTY, not a role (D4): the person keeps their normal
  // employee role everywhere else and simply carries this responsibility. That is
  // also how the permission resolves — see CAPS 'casting.manage'.
  await pool.query(`
    INSERT INTO mo_duty_flags (code, name, description)
    SELECT 'casting_manager','Casting Manager','Maintains the casting library: records, tags, collections, consent and casting requests.'
     WHERE NOT EXISTS (SELECT 1 FROM mo_duty_flags WHERE code='casting_manager')`);

  /* ═══ SMC — Social Media Council ══════════════════════════════════════════
     The institute-level coverage network. Deliberately built ON the existing
     entities rather than beside them, because a parallel event system is the
     one thing that would make SMC coverage invisible to Central Media:

       institute   → mo_academic_units      (reused as-is, 13 rows)
       event       → mo_projects            (+ event_level below)
       assignment  → mo_assignments         (+ SMC lifecycle below)
       assignee    → mo_assignment_users    (reused as-is)
       notify      → mo_notifications       (reused as-is)
       audit       → mo_audit_logs          (reused as-is)
       management  → mo_duty_flags          (a duty, exactly like Casting Manager)

     Only two genuinely new concepts exist: an SMC member's institute mapping,
     and the submission/review history, which needs to survive revisions. */

  /* The SMC network is its own team, which is what makes the role real without
     touching the platform role vocabulary: users.team='smc' means moRoleOf()
     resolves to null, so every Media Crew route already refuses them. Built-in,
     because Team Management must not be able to delete the network out from
     under its members. */
  await pool.query(`
    INSERT INTO teams (id, name, color, is_built_in)
    SELECT 'smc','SMC Network','#7C3AED',true
     WHERE NOT EXISTS (SELECT 1 FROM teams WHERE id='smc')`);

  // Who may run SMC Management. A duty, not a tier (D4) — so an Admin, a Team
  // Lead or the Operations Coordinator can hold it without inventing new roles.
  await pool.query(`
    INSERT INTO mo_duty_flags (code, name, description)
    SELECT 'smc_manager','SMC Manager','Runs the institute-level SMC coverage network: members, institute mapping, assignments, submissions and review.'
     WHERE NOT EXISTS (SELECT 1 FROM mo_duty_flags WHERE code='smc_manager')`);

  /* §23 — event level lives on the EXISTING project, so one event is one row and
     Central Media keeps seeing everything it already saw. Level 2 deliberately
     admits both SMC and Central Media crew (§25) — nothing here makes coverage
     exclusive. Existing rows default to 'central', so nothing already in the
     system silently becomes SMC-eligible. */
  await pool.query(`
    ALTER TABLE mo_projects ADD COLUMN IF NOT EXISTS event_level TEXT NOT NULL DEFAULT 'central'`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE mo_projects ADD CONSTRAINT mo_projects_event_level_check
        CHECK (event_level IN ('central','institute','major_institute','university'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_event_level ON mo_projects(event_level)`);

  /* An SMC member's mapping. The account itself stays an ordinary users row —
     this only records what makes them SMC: which institute they cover, and under
     whom. Deactivating sets is_active=false and never deletes, so history
     survives (§21). */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_smc_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      academic_unit_id BIGINT REFERENCES mo_academic_units(id),
      designation TEXT NOT NULL DEFAULT 'SMC Member',
      phone TEXT,
      joining_date DATE,
      coverage_area TEXT,
      manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_smc_profiles_unit ON mo_smc_profiles(academic_unit_id, is_active)`);

  /* §8 lifecycle on the EXISTING assignment row. mo_assignments already carries
     project, title, priority, dates, times and notes — everything §28 asks for —
     so SMC adds only what it genuinely introduces: the acceptance/coverage
     timestamps, the coverage brief, and the escalation trail. is_smc marks the
     rows the SMC views read, leaving every existing assignment untouched. */
  const SMC_ASG: Array<[string, string]> = [
    ["is_smc", "BOOLEAN NOT NULL DEFAULT false"],
    ["academic_unit_id", "BIGINT REFERENCES mo_academic_units(id)"],
    ["venue", "TEXT"],
    ["coverage_requirements", "TEXT"],
    ["deliverables_required", "TEXT"],
    ["submission_deadline", "TIMESTAMPTZ"],
    ["smc_status", "TEXT"],                       // assigned→accepted→in_progress→submitted→reviewed
    ["accepted_by", "TEXT REFERENCES users(id) ON DELETE SET NULL"],
    ["accepted_at", "TIMESTAMPTZ"],
    ["started_at", "TIMESTAMPTZ"],
    ["cancelled_at", "TIMESTAMPTZ"],
    ["cancel_reason", "TEXT"],
    ["escalated_at", "TIMESTAMPTZ"],
    ["escalated_by", "TEXT REFERENCES users(id) ON DELETE SET NULL"],
    ["escalation_reason", "TEXT"],
    ["escalation_status", "TEXT"],
  ];
  for (const [col, def] of SMC_ASG)
    await pool.query(`ALTER TABLE mo_assignments ADD COLUMN IF NOT EXISTS ${col} ${def}`);
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE mo_assignments ADD CONSTRAINT mo_assignments_smc_status_check
        CHECK (smc_status IS NULL OR smc_status IN
          ('assigned','accepted','in_progress','submitted','reviewed','revision_required','cancelled'));
    EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_assignments_smc ON mo_assignments(is_smc, smc_status, start_date)`);

  /* Reassignment trail (§30). A row per handover, so the original assignee is
     never edited away and the history stays auditable. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_smc_reassignments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      assignment_id BIGINT NOT NULL REFERENCES mo_assignments(id) ON DELETE CASCADE,
      from_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reason TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_smc_reassignments_asg ON mo_smc_reassignments(assignment_id)`);

  /* Submission + review history (§14, §35). One row per attempt rather than a
     mutable submission, so a revision never overwrites what was reviewed before.
     The newest row for an assignment is the current submission. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_smc_submissions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      assignment_id BIGINT NOT NULL REFERENCES mo_assignments(id) ON DELETE CASCADE,
      submitted_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      attempt INT NOT NULL DEFAULT 1,
      drive_url TEXT,
      photos_url TEXT,
      media_library_url TEXT,
      reference_url TEXT,
      note TEXT,
      photo_count INT NOT NULL DEFAULT 0,
      video_count INT NOT NULL DEFAULT 0,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      review_status TEXT NOT NULL DEFAULT 'submitted',
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      review_feedback TEXT,
      CONSTRAINT mo_smc_submissions_review_check
        CHECK (review_status IN ('submitted','reviewed','revision_required'))
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_mo_smc_submissions_asg ON mo_smc_submissions(assignment_id, attempt DESC)`);

  // Starter taxonomy so the library is usable on day one; the Casting Manager and
  // Admin can edit or archive any of it from Settings.
  await pool.query(`
    INSERT INTO mo_casting_tags (name, category, sort_order)
    SELECT x.n, x.c, x.o FROM (VALUES
      ('Doctor','profession',1),('Engineer','profession',2),('Professor','profession',3),
      ('Lawyer','profession',4),('Business Owner','profession',5),('Farmer','profession',6),
      ('Artist','profession',7),('Athlete','profession',8),
      ('Corporate','production_type',10),('Academic','production_type',11),('Lifestyle','production_type',12),
      ('Emotional','production_type',13),('Family','production_type',14),('Event','production_type',15),
      ('Promotional','production_type',16),
      ('Gujarati','language',20),('Hindi','language',21),('English','language',22),
      ('Formal','requirement',30),('Casual','requirement',31),('Traditional','requirement',32),
      ('Professional','requirement',33),('Student-like','requirement',34),('Parent','requirement',35),
      ('Authority Figure','requirement',36)
    ) AS x(n,c,o)
    WHERE NOT EXISTS (SELECT 1 FROM mo_casting_tags t WHERE lower(t.name)=lower(x.n))`);
  await pool.query(`
    INSERT INTO mo_casting_collections (name, description, sort_order)
    SELECT x.n, x.d, x.o FROM (VALUES
      ('Faculty Casting','Teaching staff available for production',1),
      ('Student Casting','Students available for production',2),
      ('Professional Casting','External professionals',3),
      ('Senior Citizen Casting','Senior casting references',4),
      ('Campaign Casting','Reserved for campaign shoots',5)
    ) AS x(n,d,o)
    WHERE NOT EXISTS (SELECT 1 FROM mo_casting_collections c WHERE lower(c.name)=lower(x.n))`);

  // ═════════ EXTERNAL CASTING REGISTRATION (§ external intake layer) ════════
  // A shareable campaign link that university people open WITHOUT a NERVE
  // account. It is an intake layer on the existing casting system, not a
  // separate one: a submission becomes an ordinary CR-xxxxx in the same
  // Requests queue the Casting Manager already works.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_casting_links (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      -- Locked to the university domain by default; only an Admin should widen it.
      allowed_domain TEXT NOT NULL DEFAULT 'paruluniversity.ac.in',
      active_from DATE,
      expires_on DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      require_department BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_casting_links_token ON mo_casting_links(token)`);

  // The same requests table carries external submissions — §16 asks for one
  // review queue, not two. Internal requests simply leave these columns null.
  const REQ_COLS: Array<[string, string]> = [
    ["link_id", "BIGINT REFERENCES mo_casting_links(id) ON DELETE SET NULL"],
    ["source", "TEXT NOT NULL DEFAULT 'internal'"],
    ["applicant_email", "TEXT"],
    ["applicant_name", "TEXT"],
    ["applicant_type", "TEXT"],           // Student / Faculty / Staff / Researcher / Alumni / Other
    ["department", "TEXT"],
    ["designation", "TEXT"],
    ["campus_id", "BIGINT REFERENCES mo_campuses(id)"],
    ["location", "TEXT"],
    ["interests", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ["availability", "TEXT"],
    ["intro", "TEXT"],
    ["photo_url", "TEXT"],
    ["consent_given", "BOOLEAN NOT NULL DEFAULT false"],
    ["consent_at", "TIMESTAMPTZ"],
    ["review_note", "TEXT"],
    ["reviewed_at", "TIMESTAMPTZ"],
    ["archived_at", "TIMESTAMPTZ"],
    ["submitted_ip", "TEXT"],
  ];
  for (const [c, t] of REQ_COLS)
    await pool.query(`ALTER TABLE mo_casting_requests ADD COLUMN IF NOT EXISTS "${c}" ${t}`);
  // The external workflow needs review states the internal one never had.
  await pool.query(`ALTER TABLE mo_casting_requests DROP CONSTRAINT IF EXISTS mo_casting_requests_status_check`);
  await pool.query(`ALTER TABLE mo_casting_requests ADD CONSTRAINT mo_casting_requests_status_check
                    CHECK (status IN ('new','reviewing','searching','candidate_found','completed','rejected',
                                      'under_review','clarification','approved','archived'))`);
  await pool.query(`ALTER TABLE mo_casting_requests DROP CONSTRAINT IF EXISTS mo_casting_requests_source_check`);
  await pool.query(`ALTER TABLE mo_casting_requests ADD CONSTRAINT mo_casting_requests_source_check
                    CHECK (source IN ('internal','external'))`);
  // One submission per account per campaign — §14. Partial so internal requests
  // (which have neither) are unaffected.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_casting_req_once
                    ON mo_casting_requests(link_id, lower(applicant_email))
                    WHERE link_id IS NOT NULL AND applicant_email IS NOT NULL`);

  // Traceability both ways: a record knows the request it came from (§23/§29).
  await pool.query(`ALTER TABLE mo_casting_records ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE mo_casting_records DROP CONSTRAINT IF EXISTS mo_casting_records_source_check`);
  await pool.query(`ALTER TABLE mo_casting_records ADD CONSTRAINT mo_casting_records_source_check
                    CHECK (source IN ('manual','external_registration'))`);
  await pool.query(`ALTER TABLE mo_casting_records ADD COLUMN IF NOT EXISTS source_request_id BIGINT
                    REFERENCES mo_casting_requests(id) ON DELETE SET NULL`);
  await pool.query(`ALTER TABLE mo_casting_records ADD COLUMN IF NOT EXISTS applicant_email TEXT`);

  // ═════════ EXTERNAL MEDIA REQUEST INTAKE (§ external intake door) ═════════
  // The same intake door pattern as external casting, pointed at Request Intake.
  // Critically ONE database (§51): an external submission is an ordinary
  // mo_requests row with source='external'. Manual "+ New Request" is unchanged
  // and writes the same table, so conversion, filtering, reporting and audit
  // never fragment.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_request_links (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      token TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      allowed_domain TEXT NOT NULL DEFAULT 'paruluniversity.ac.in',
      active_from DATE,
      expires_on DATE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_request_links_token ON mo_request_links(token)`);

  const REQ_EXT: Array<[string, string]> = [
    ["source", "TEXT NOT NULL DEFAULT 'manual'"],
    ["link_id", "BIGINT REFERENCES mo_request_links(id) ON DELETE SET NULL"],
    // The VERIFIED Google identity, kept apart from the editable contact fields
    // so the person who actually submitted can never be edited away.
    ["requester_email", "TEXT"],
    ["requester_name", "TEXT"],
    ["requirement_types", "JSONB NOT NULL DEFAULT '[]'::jsonb"],
    ["end_time", "TEXT"],
    ["meeting_date", "DATE"],
    ["meeting_time", "TEXT"],
    ["meeting_notes", "TEXT"],
    ["vendor_details", "TEXT"],
    ["additional_notes", "TEXT"],
    ["review_note", "TEXT"],
    // When Operations first touched it — drives the overdue flag (§48).
    ["first_touched_at", "TIMESTAMPTZ"],
    ["submitted_ip", "TEXT"],
  ];
  for (const [c, t] of REQ_EXT)
    await pool.query(`ALTER TABLE mo_requests ADD COLUMN IF NOT EXISTS "${c}" ${t}`);
  await pool.query(`ALTER TABLE mo_requests DROP CONSTRAINT IF EXISTS mo_requests_source_check`);
  await pool.query(`ALTER TABLE mo_requests ADD CONSTRAINT mo_requests_source_check
                    CHECK (source IN ('manual','external'))`);
  // §24 adds an explicit "under review" step between arrival and readiness.
  await pool.query(`ALTER TABLE mo_requests DROP CONSTRAINT IF EXISTS mo_requests_status_check`);
  await pool.query(`ALTER TABLE mo_requests ADD CONSTRAINT mo_requests_status_check
                    CHECK (status IN ('new','under_review','needs_clarification','ready','converted','closed','rejected'))`);

  await seedMediaOpsLookups();
}

// ── Lookup / reference seed (idempotent, NFR-10 config-driven) ──────────────
async function seedMediaOpsLookups() {
  const { rows } = await pool.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM mo_departments`);
  if (rows[0].n > 0) return; // lookups already seeded

  await pool.query(`INSERT INTO mo_departments (name, slug, is_active) VALUES
    ('Media Crew','media-crew',true), ('Content Team','content-team',false), ('Outreach','outreach',false)`);
  await pool.query(`INSERT INTO mo_campuses (name, code, city, is_active) VALUES
    ('Vadodara — Main Campus','VAD','Vadodara',true), ('Rajkot Campus','RJK','Rajkot',false)`);
  await pool.query(`INSERT INTO mo_academic_years (label, start_date, end_date, is_current) VALUES
    ('2024-25','2024-06-01','2025-05-31',false),
    ('2025-26','2025-06-01','2026-05-31',false),
    ('2026-27','2026-06-01','2027-05-31',true)`);
  // Starter Academic Units — Admin-editable from Settings, not hard-coded anywhere.
  await pool.query(`INSERT INTO mo_academic_units (department_id, name, short_name, slug, sort_order, is_active) VALUES
    (1,'University-wide','University-wide','university-wide',1,true),
    (1,'Faculty of Engineering & Technology','Engineering','faculty-of-engineering-technology',2,true),
    (1,'Faculty of Medicine','Medicine','faculty-of-medicine',3,true),
    (1,'Faculty of Management Studies','Management','faculty-of-management-studies',4,true),
    (1,'Faculty of Pharmacy','Pharmacy','faculty-of-pharmacy',5,true),
    (1,'Faculty of Design','Design','faculty-of-design',6,true),
    (1,'Faculty of Law','Law','faculty-of-law',7,true),
    (1,'Faculty of Applied Sciences','Applied Sciences','faculty-of-applied-sciences',8,true),
    (1,'Faculty of Agriculture','Agriculture','faculty-of-agriculture',9,true),
    (1,'Faculty of Physiotherapy','Physiotherapy','faculty-of-physiotherapy',10,true),
    (1,'Faculty of IT & Computer Science','IT & CS','faculty-of-it-computer-science',11,true),
    (1,'Faculty of Nursing','Nursing','faculty-of-nursing',12,true),
    (1,'Faculty of Arts','Arts','faculty-of-arts',13,true)`);
  await pool.query(`INSERT INTO mo_capacity_roles (name) VALUES
    ('Photographer'),('Videographer'),('Editor'),('Drone Operator'),('Coordinator'),('Sound'),('Motion Designer')`);
  await pool.query(`INSERT INTO mo_duty_flags (code, name, description) VALUES
    ('equipment_custodian','Equipment Custodian','Handles the camera cupboard: damage reports, maintenance, disputes.'),
    ('report_reviewer','Report Reviewer','Receives flagged daily reports for their scope in addition to the Team Lead.'),
    ('project_manager','Project Manager','Per-project duty set on the project, not the user (BR-2).'),
    ('kiosk_operator','Kiosk Operator','May reset a kiosk device and reprint QR labels.')`);
  await pool.query(`INSERT INTO mo_skills (name, category) VALUES
    ('Photography','Capture'),('Videography','Capture'),('Drone Piloting','Capture'),('Editing','Post'),
    ('Colour Grading','Post'),('Motion / Animation','Post'),('Sound Recording','Capture'),('Sound Design','Post'),
    ('Album Design','Post'),('Live Multicam','Capture'),('Scripting','Pre'),('Coordination','Pre')`);
  await pool.query(`INSERT INTO mo_project_types (department_id, name, slug, color, icon, sort_order, is_active) VALUES
    (1,'Annual University Event','annual-event','var(--cat-1)','◆',1,true),
    (1,'Educational Tour','tour','var(--cat-2)','▲',2,true),
    (1,'Deputation','deputation','var(--cat-3)','◇',3,true),
    (1,'Branding Content','branding','var(--cat-4)','●',4,true),
    (1,'Monthly Campaign','campaign','var(--cat-5)','◐',5,true),
    (1,'Social Media','social','var(--cat-6)','◔',6,true),
    (1,'Internal','internal','var(--cat-7)','○',7,true),
    (1,'Other','other','var(--cat-8)','◈',8,true)`);
  await pool.query(`INSERT INTO mo_task_categories (department_id, name, icon, is_active, sort_order) VALUES
    (1,'Shooting','◆',true,1),(1,'Editing','◐',true,2),(1,'Colour Grading','◑',true,3),(1,'Sound','◪',true,4),
    (1,'Animation','◈',true,5),(1,'Coordination','◇',true,6),(1,'Travel','➤',true,7),(1,'Meeting','◎',true,8),
    (1,'Upload / Backup','◪',true,9),(1,'Review','◔',true,10),(1,'Equipment Prep','▣',true,11),(1,'Scripting','◇',true,12)`);
  await pool.query(`INSERT INTO mo_deliverable_types (department_id, name, slug, icon, default_weight, default_unit, review_exempt, is_active, sort_order, default_due_offset_days) VALUES
    (1,'Photos — Raw','photos-raw','◈',1,'photos',false,true,1,2),
    (1,'Photos — Edited','photos-edited','◉',3,'photos',false,true,2,5),
    (1,'Video — Raw','video-raw','▤',1,'clips',true,true,3,2),
    (1,'Video — Edited','video-edited','▶',4,'videos',false,true,4,10),
    (1,'Aftermovie','aftermovie','★',8,'minutes',false,true,5,12),
    (1,'Highlight Reel','highlight-reel','◧',5,'minutes',false,true,6,8),
    (1,'Reel / Short','reel','◔',2,'reels',false,true,7,5),
    (1,'Outreach Content','outreach','◇',2,'posts',false,true,8,9),
    (1,'Continuous Recording','continuous','◺',3,'hours',true,true,9,3),
    (1,'Drone Footage','drone','◆',3,'clips',false,true,10,5),
    (1,'Album Design','album','◈',4,'spreads',false,true,11,14),
    (1,'Story / Post','story','◔',1,'posts',false,true,12,3),
    (1,'Raw Archive','raw-archive','◫',1,'GB',true,true,13,2),
    (1,'Other','other','◇',1,'items',false,true,14,5)`);
  await pool.query(`INSERT INTO mo_equipment_categories (department_id, name, tracking_mode, icon, sort_order) VALUES
    (1,'Camera Body','individual','▣',1),(1,'Lens','individual','◎',2),(1,'Drone','individual','◆',3),
    (1,'Gimbal','individual','◇',4),(1,'Light','individual','◔',5),(1,'Microphone','individual','◪',6),
    (1,'Audio Recorder','individual','▤',7),(1,'Tripod / Support','individual','◇',8),
    (1,'Memory Card','pooled','◭',9),(1,'Battery','pooled','◮',10),(1,'Accessory','pooled','◇',11)`);
  await pool.query(`INSERT INTO mo_leave_types (name, is_active, notes) VALUES
    ('Casual Leave',true,''),('Sick Leave',true,''),('Comp-off',true,'Earned against Sunday / festival shoots'),
    ('Earned Leave',true,''),('Unpaid Leave',true,'')`);
  // §17 automation rules (Admin-tunable, no deploy — NFR-10).
  await pool.query(`INSERT INTO mo_automation_rules (department_id, rule_key, name, trigger, action, is_enabled, config) VALUES
    (1,'AUTO-1','Missing daily report reminder','17:30 daily (working days) — report not submitted','Push + in-app nudge → 20:00 second nudge → next morning TL dashboard gap list',true,'{"first_nudge":"17:30","second_nudge":"20:00","working_days_only":true}'),
    (1,'AUTO-2','Deliverable due / overdue escalation','Due in 3d / 1d / overdue','Owner → +PM on overdue → +TL at 3d → +Admin at 7d',true,'{"warn_days":[3,1],"esc_tl_days":3,"esc_admin_days":7}'),
    (1,'AUTO-3','Equipment overdue engine','Due tomorrow / today / overdue','Holder → +custodian on overdue → +TL/Admin at 3d; blocks new checkouts per BR-7',true,'{"esc_tl_days":3,"block_after_days":7}'),
    (1,'AUTO-4','Approval pending escalation','Any approval pending > 24h','Reminder to approver; 72h escalate one level',true,'{"remind_h":24,"escalate_h":72}'),
    (1,'AUTO-5','Drive link validation','Weekly + on create','HEAD/permission check via Drive API; broken links flagged',true,'{"schedule":"Sun 02:00"}'),
    (1,'AUTO-6','Duplicate project detection','Project create / propose','Fuzzy scan (name + type + year + faculty ± dates) — warn with links',true,'{"similarity_threshold":0.62}'),
    (1,'AUTO-7','Idle project detection','In Production, no task logs / deliverable movement for N days','Idle-project flag to PM + TL',true,'{"idle_days":7}'),
    (1,'AUTO-8','Maintenance due / damage opened','next_due_at reached or damage report filed','Custodian + Admin task; item → Under Maintenance',true,'{"lead_days":7}'),
    (1,'AUTO-9','Low logged-hours check-in','User < 50% of team median for 2 consecutive weeks','Private prompt to TL only',true,'{"threshold_pct":50,"weeks":2,"private":true}'),
    (1,'AUTO-10','Shoot T-24h crew reminder','Shoot starts in 24h','Crew reminder with call time, location, kit list',true,'{"lead_h":24}'),
    (1,'AUTO-11','Month close','1st of month, 02:00','Compute performance_snapshots → department pack → email leadership → KRA auto-metrics',true,'{"run_at":"02:00"}'),
    (1,'AUTO-12','Leave approved with shoot conflicts','Leave approved overlapping an assigned shoot','Replacement suggestion task to TL',true,'{"suggest_by_skill":true}'),
    (1,'AUTO-13','Report flag rules','Report submitted','Flag if hours >14 or <2, completion claim without evidence, 3+ identical descriptions, first report after 3+ missing days, random sample',true,'{"max_hours":14,"min_hours":2,"identical_streak":3,"missing_days":3,"random_sample_pct":10}'),
    (1,'AUTO-14','Warranty / insurance / certification expiry','Expiring within 30 days','Admin + custodian notice; user + Admin for drone licence',true,'{"lead_days":30}')`);

  // FR-3.2 project templates — auto-create the default deliverable set per type.
  // Referenced by slug so it is robust to identity id ordering.
  const tmpl = async (typeSlug: string, name: string, items: [string, string, number, number][]) => {
    const t = await pool.query(
      `INSERT INTO mo_project_templates (project_type_id, name, is_active)
       SELECT id,$2,true FROM mo_project_types WHERE slug=$1 RETURNING id`, [typeSlug, name]);
    const tid = t.rows[0].id;
    for (const [dtSlug, pattern, weight, offset] of items) {
      await pool.query(
        `INSERT INTO mo_template_deliverables (template_id, deliverable_type_id, title_pattern, default_weight, days_offset_due)
         SELECT $1, id, $3, $4, $5 FROM mo_deliverable_types WHERE slug=$2`, [tid, dtSlug, pattern, weight, offset]);
    }
  };
  await tmpl("annual-event", "Annual Event — standard pack", [
    ["photos-edited", "Edited Photos — {project}", 3, 5], ["aftermovie", "Aftermovie — {project}", 8, 12],
    ["highlight-reel", "Highlight Reel — {project}", 5, 8], ["story", "Social Posts — {project}", 1, 3],
    ["raw-archive", "Raw Archive — {project}", 1, 2]]);
  await tmpl("tour", "Educational Tour — standard pack", [
    ["photos-edited", "Edited Photos — {project}", 3, 6], ["highlight-reel", "Highlight Reel — {project}", 5, 10],
    ["raw-archive", "Raw Archive — {project}", 1, 3]]);
  await tmpl("branding", "Branding Content — standard pack", [
    ["video-edited", "Brand Film — {project}", 4, 14], ["reel", "Cutdown Reels — {project}", 2, 16]]);
  await tmpl("campaign", "Monthly Campaign — standard pack", [
    ["reel", "Campaign Reels — {project}", 2, 10], ["story", "Story Set — {project}", 1, 7],
    ["outreach", "Outreach Mailer — {project}", 2, 9]]);
  await tmpl("social", "Social Media — reel pack", [["reel", "Reels — {project}", 2, 5]]);
  await tmpl("deputation", "Deputation — minimal pack", [
    ["photos-edited", "Edited Photos — {project}", 3, 4], ["raw-archive", "Raw Archive — {project}", 1, 2]]);

  // Self-heal FR-3.1 type data (idempotent — runs on every boot):
  // E1: undo the accidental "July 2026" rename of Monthly Campaign.
  await pool.query(`UPDATE mo_project_types SET name='Monthly Campaign' WHERE slug='campaign' AND name='July 2026'`);
  // E2: ensure the four FR-3.1 types exist even on DBs seeded before they were added.
  await pool.query(`
    INSERT INTO mo_project_types (department_id, name, slug, color, icon, sort_order)
    SELECT 1, x.name, x.slug, x.color, x.icon, x.so FROM (VALUES
      ('Deputation','deputation','#f59e0b','✈',6), ('Social Media','social','#ec4899','♪',7),
      ('Internal','internal','#64748b','■',8), ('Other','other','#94a3b8','◇',9)
    ) AS x(name, slug, color, icon, so)
    WHERE NOT EXISTS (SELECT 1 FROM mo_project_types t WHERE t.slug = x.slug)`);

  // eslint-disable-next-line no-console
  console.log("Media Ops lookups + templates seeded (§11).");
}
