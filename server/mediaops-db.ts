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
import { seedCreatorAutomationRules } from "./creator-automations.js";

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

  /* ── Which TEAM a project belongs to ──────────────────────────────────────
     The hierarchy is Coordinator/Admin → Team → Team Lead → Employee: work is
     routed to a team, and the team's lead decides who executes each
     deliverable. owner_id already carries the LEAD (the project page labels it
     "Team lead") and mo_deliverables.owner_id already carries the individual,
     so the only link the schema was missing is the team itself.

     Nullable on purpose. Every existing project keeps its owner, its crew and
     its history untouched; a NULL here simply means the team was never recorded,
     which is exactly true of anything created before this column. */
  await pool.query(`ALTER TABLE mo_projects ADD COLUMN IF NOT EXISTS team_id BIGINT REFERENCES mo_teams(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_team ON mo_projects(team_id)`);
  /* Converted projects already know their team — the coordinator picked one on
     the request. Copying it across is recovering a fact we hold, not inventing
     one, and the guard makes it idempotent and non-destructive. */
  await pool.query(`
    UPDATE mo_projects p SET team_id = r.team_id
      FROM mo_requests r
     WHERE r.project_id = p.id AND p.team_id IS NULL AND r.team_id IS NOT NULL`)
    .catch((e) => {
      // mo_requests is created further down, so it is absent on the very first
      // bootstrap of an empty database — where there is nothing to backfill
      // anyway. Anything else is a real error and must not be swallowed.
      if ((e as { code?: string }).code !== "42P01") throw e;
    });

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
  /* Runs ONCE, not on every boot. As an unguarded step it kept deleting every
     deliverable-linked assignment on restart — including ones a human had
     deliberately made, since /projects/:id/work already accepts a deliverable_id
     and the deliverable panel now assigns crew and SMC members against one. The
     legacy auto-generation this was written to clean up no longer exists, so the
     cleanup only ever needed to happen a single time. */
  const folded = (await pool.query(
    `SELECT 1 FROM app_settings WHERE key='mo_deliverable_assignments_folded'`)).rows[0];
  if (!folded) {
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
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('mo_deliverable_assignments_folded','1')
       ON CONFLICT (key) DO NOTHING`);
  }

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

  /* Group-level module defaults. The only thing the module system lacked: role
     defaults were DERIVED from the nav each time (defaultModulesFor), so an
     administrator could not change what a group starts with. One row per group,
     holding the same module keys the sidebar and the per-member dialog use.

     Semantics, chosen so nothing existing shifts underfoot:
       mo_user_profiles.allowed_modules IS NULL  → inherit this group default
       allowed_modules IS an array               → explicit member override, wins
     A group with no row here behaves exactly as before (unrestricted), so this
     table only takes effect once someone deliberately configures a group. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_module_defaults (
      role TEXT PRIMARY KEY,
      modules JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

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
    // The applicant hosts their own photo and gives us the link — NERVE stores the
    // URL, never a copy of the image. The column the intake layer always reserved.
    ["photo_url", "TEXT"],
    ["mobile_phone", "TEXT"],             // normalised on the way in, never free text
    ["enrolment_number", "TEXT"],         // optional: staff, alumni and externals have none
    ["instagram_url", "TEXT"],
    ["consent_given", "BOOLEAN NOT NULL DEFAULT false"],
    ["consent_at", "TIMESTAMPTZ"],
    // WHICH wording was agreed to. The id alone would rot the moment the text is
    // reworded, so the row keeps a snapshot of the text too: an old submission
    // stays readable without every retired version having to be kept forever.
    ["consent_version", "TEXT"],
    ["consent_text", "TEXT"],
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

  /* ═══════════ AI REQUEST METERING (§ AI operating layer) ═══════════════════
     Operational accountability and cost tracking for the AI layer — NOT
     conversation storage.

     Deliberately its own table rather than rows in mo_audit_logs. That table is
     the business-event trail: it keys on entity_id BIGINT and carries before/
     after jsonb, which suits "who changed this deliverable" and suits metering
     badly. Here the questions are numeric and aggregate — tokens summed per
     month, requests counted per user per day, failures grouped by category —
     and answering them over jsonb would be both awkward and slow. The retention
     story differs too: a business audit trail is kept indefinitely, telemetry is
     not.

     What this table must never hold is equally deliberate: no prompt, no model
     response, no tool arguments, no tool results, no API key, no headers. It
     records THAT a request happened and what it cost, never what was said. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_ai_requests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,          -- the orchestrator's trace id
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      feature TEXT NOT NULL DEFAULT 'ask',      -- which AI surface was used
      -- The calendar day in Nerve's timezone, written by the application rather
      -- than derived from occurred_at: a UTC-derived date rolls over at 05:30
      -- IST and would reset a daily limit in the middle of the working morning.
      local_date DATE NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider TEXT,
      model TEXT,
      status TEXT NOT NULL CHECK (status IN ('ok','failed')),
      -- One of a closed set of safe categories; never an exception message,
      -- which could carry SQL, a path, or a provider payload.
      failure_category TEXT,
      stop_reason TEXT,
      duration_ms INTEGER,
      -- Tool NAMES only. Arguments and results are deliberately absent.
      tools JSONB NOT NULL DEFAULT '[]'::jsonb,
      tool_rounds SMALLINT,
      -- NULL means the provider reported no usage block, which is normal for
      -- some OpenAI-compatible endpoints. Never guessed.
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      total_tokens INTEGER,
      -- Only ever set when a real pricing configuration exists. No default
      -- price is assumed for any provider.
      estimated_cost NUMERIC(12,6),
      -- Length only. The question itself is NOT stored — see the note in
      -- recordAiRequest() for why a hash was rejected as well.
      question_chars INTEGER
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_ai_req_user_day ON mo_ai_requests(user_id, local_date)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_ai_req_when ON mo_ai_requests(occurred_at DESC)`);

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

  /* ── Public-portal email verification ───────────────────────────────────
     The employee password OTP lives in password_otps, whose user_id is NOT
     NULL and references users(id). An external applicant must never get a
     users row (§8), so their codes cannot go there. Same policy (otp.ts),
     different subject: these are keyed by email + the specific public link,
     which is what binds a verified session to one campaign and stops a code
     earned on one link from opening another.

     Codes are stored hashed; the raw value never touches the database. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_portal_otps (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('casting','request')),
      link_token TEXT NOT NULL,
      email TEXT NOT NULL,
      otp_hash TEXT NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      used BOOLEAN NOT NULL DEFAULT false,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_mo_portal_otps_lookup
       ON mo_portal_otps(kind, link_token, lower(email), used)`);

  /* A verified applicant holds one of these instead of a NERVE session. It
     carries no privileges beyond the single link it names. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_portal_sessions (
      token TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('casting','request')),
      link_token TEXT NOT NULL,
      email TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_mo_portal_sessions_scope
       ON mo_portal_sessions(kind, link_token, lower(email))`);

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

  await bootstrapCreatorNetwork();
  await seedMediaOpsLookups();
}

/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — Phase 0 foundation

   Parul's creator network is an incentive-based content workforce, not Media
   Crew staff. It is built the way SMC was: the creator is an ordinary NERVE
   user (one identity, one login, one session) carrying a profile row that says
   what they are inside this vertical. Nothing here is a second product.

   What is REUSED, not rebuilt:
     identity + login → users / getSessionUser      module access → mo_module_defaults
     audit            → mo_audit_logs                notifications → mo_notifications
     soft delete      → users.status + archived_at   timestamps    → created_at/updated_at

   Only three things are genuinely new: which creators exist, which creator team
   they belong to, and what they are inside the network. Everything Phases 1–8
   add (tasks, submissions, points, payouts, competitions) references
   mo_creator_profiles.user_id — a TEXT user id, exactly as mo_smc_submissions
   already references users.

   NAMING: Outreach owns `outreach_creators`, which are EXTERNAL influencer
   accounts it tracks. Unrelated. Everything here is mo_creator_* and touches no
   Outreach table.
   ═══════════════════════════════════════════════════════════════════════════ */
/** Exported so the tests can prove it is idempotent by running it twice. */
export async function bootstrapCreatorNetwork() {
  /* The vertical is a built-in team, like SMC. This is what makes the whole
     thing safe by default: moRoleOf() returns null for any team outside
     media/smc, so a creator is refused by every pre-existing Media Ops route
     with no new denial code — the same mechanism that already contains SMC. */
  await pool.query(`
    INSERT INTO teams (id, name, color, is_built_in)
    SELECT 'creator','Creator Network','#0891B2',true
     WHERE NOT EXISTS (SELECT 1 FROM teams WHERE id='creator')`);

  /* What a person IS inside the network. Keyed by user_id like every other
     profile table (mo_user_profiles, mo_smc_profiles) so there is exactly one
     identity per human and no second id to keep in step.

     creator_role is deliberately NOT a Nerve role and not mo_role: nothing in
     moRoleOf() or effectiveModules() reads this column, so a Creator Admin can
     never become a Nerve Admin by holding it, and a Media Ops Team Lead never
     becomes a Creator Team Lead by holding theirs.

     status is the network's own lifecycle, separate from users.status: a
     creator can be suspended from the network while their Nerve account stays
     active, and archiving keeps every point, submission and payout attached. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_profiles (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      creator_role TEXT NOT NULL DEFAULT 'creator'
        CHECK (creator_role IN ('creator_admin','team_lead','creator')),
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','inactive','suspended','archived')),
      display_name TEXT,
      creator_type TEXT,
      joined_on DATE NOT NULL DEFAULT CURRENT_DATE,
      exited_on DATE,
      notes TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_creator_role ON mo_creator_profiles(creator_role, status)`);

  /* Creator teams are their own structure, NOT mo_teams. mo_teams drives Media
     Crew project routing, assignableMemberIds() and workload; putting creators
     in it would surface them in Media Ops pickers and hand Media Team Leads
     scope over creators. Separate tables keep the two hierarchies from
     inheriting each other. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_teams (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lead_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      color TEXT, icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT true,
      archived_at TIMESTAMPTZ,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_creator_teams_name ON mo_creator_teams(lower(name))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_creator_teams_lead ON mo_creator_teams(lead_user_id) WHERE archived_at IS NULL`);

  // One primary team per creator, mirroring mo_team_members' own rule.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_team_members (
      team_id BIGINT NOT NULL REFERENCES mo_creator_teams(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_primary BOOLEAN NOT NULL DEFAULT true,
      added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (team_id, user_id)
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_creator_primary_team
                    ON mo_creator_team_members(user_id) WHERE is_primary`);

  /* AUDIT VOCABULARY — a Creator Network member is none of the Media Ops tiers, so every action
     they took was writing actor_role='user' — which this CHECK rejected, and
     audit() swallows its own errors, so their trail was silently EMPTY.
     'creator' is admitted rather than mapping them onto 'employee', because a
     creator is deliberately not one. Widening a CHECK touches no existing row. */
  /* One statement, so a second process booting at the same moment cannot land
     between the drop and the add — and it re-checks whether the widening is
     already in place, so a rerun is a no-op rather than a churn. */
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conname='mo_audit_actor_role_chk'
                      AND pg_get_constraintdef(oid) LIKE '%creator%') THEN
      ALTER TABLE mo_audit_logs DROP CONSTRAINT IF EXISTS mo_audit_actor_role_chk;
      ALTER TABLE mo_audit_logs ADD CONSTRAINT mo_audit_actor_role_chk
        CHECK (actor_role IS NULL OR actor_role IN ('admin','team_lead','employee','system','creator'));
    END IF;
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

  /* ── Phase 2: events → opportunities → interest → assignment/task ────────
     WHY THESE ARE NEW TABLES, not the Media Ops ones they resemble:

       mo_projects  feeds the production pipeline, the dashboard and the office
                    TV board. A creator event put there would appear on all
                    three — a visible regression, not a tidy reuse.
       mo_assignments.project_id is NOT NULL against mo_projects, so creator
                    work could only live there by dropping a constraint on a
                    live Media Ops table.

     So the boundary is explicit, as Phase 0 made it for identity.

     ASSIGNMENT AND TASK ARE ONE ROW. In this phase they are strictly 1:1 — the
     same creator, the same opportunity, one shared lifecycle — so a separate
     task table would repeat every column and add no fact. Selection and
     assignment, which ARE different events, stay separate: the interest keeps
     the decision, the assignment is its operational consequence. If a later
     phase needs several tasks per assignment, a child table can be added
     without disturbing any of this. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      academic_unit_id BIGINT REFERENCES mo_academic_units(id),
      venue TEXT,
      event_date DATE,
      start_time TEXT, end_time TEXT,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','open','closed','completed','cancelled','archived')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_events_status ON mo_creator_events(status, event_date)`);

  /* What the event needs, and how many of them. Kept apart from the event
     because a future phase attaches points, payout rules and submission rules
     HERE, not to the event. creator_type is free text from the admin — the
     network invents roles faster than a CHECK constraint could follow. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_opportunities (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      event_id BIGINT NOT NULL REFERENCES mo_creator_events(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      creator_type TEXT,
      description TEXT NOT NULL DEFAULT '',
      required_count INTEGER NOT NULL DEFAULT 1 CHECK (required_count > 0),
      starts_at_time TEXT, ends_at_time TEXT,
      venue TEXT,
      -- The event happens on one day; the work is often due on another (§17).
      task_deadline DATE,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','open','closed','cancelled')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_opps_event ON mo_creator_opportunities(event_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_opps_open ON mo_creator_opportunities(status) WHERE status='open'`);

  /* Interest is a claim, not a promise of work. It keeps its own decision
     history — who asked, when, what was decided and by whom — so "who was
     considered and passed over" survives even after the assignment exists. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_interests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      opportunity_id BIGINT NOT NULL REFERENCES mo_creator_opportunities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'interested'
        CHECK (status IN ('interested','withdrawn','selected','not_selected')),
      note TEXT NOT NULL DEFAULT '',
      decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  /* One LIVE interest per creator per opportunity, enforced by the database
     rather than by the form. A withdrawn interest does not block re-applying,
     and the withdrawn row is kept. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_interest_live
                    ON mo_creator_interests(opportunity_id, user_id) WHERE status <> 'withdrawn'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_interest_user ON mo_creator_interests(user_id, status)`);

  /* The assignment IS the task — see the note above. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_assignments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      opportunity_id BIGINT NOT NULL REFERENCES mo_creator_opportunities(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      -- Resolved from the creator's own membership at assignment time, never
      -- taken from the request, and kept so history survives a team move.
      team_id BIGINT REFERENCES mo_creator_teams(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      deadline DATE,
      scheduled_date DATE,
      status TEXT NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('assigned','accepted','in_progress','completed','declined','cancelled')),
      decline_reason TEXT,
      assigned_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      accepted_at TIMESTAMPTZ, started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ, declined_at TIMESTAMPTZ, cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // One LIVE assignment per creator per opportunity; declined and cancelled
  // rows stay as history and do not block a reassignment.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_assign_live
                    ON mo_creator_assignments(opportunity_id, user_id)
                    WHERE status NOT IN ('declined','cancelled')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_assign_user ON mo_creator_assignments(user_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_assign_team ON mo_creator_assignments(team_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_assign_deadline ON mo_creator_assignments(deadline)
                    WHERE status NOT IN ('completed','declined','cancelled')`);

  /* ── Phase 3: content submission and review ─────────────────────────────
     Modelled on mo_deliverable_versions, which is already how Nerve does a
     versioned submission with a review verdict on it. Same shape, same words
     (version_no, submitted_by, reviewed_by, review_comment), so there is one
     convention in the codebase rather than two.

     COMPLETION IS NOT APPROVAL. The assignment stays 'completed' — that is the
     creator saying the work is done and ready to look at. The verdict lives
     here, on the submission, and is management's separate act.

     Versions are immutable. A verdict writes reviewer, timestamp and comment
     onto the row that was reviewed; it never edits the content, and a
     resubmission is always a NEW row. V1 stays readable forever. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_submissions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      assignment_id BIGINT NOT NULL REFERENCES mo_creator_assignments(id) ON DELETE CASCADE,
      version_no SMALLINT NOT NULL CHECK (version_no > 0),
      content_url TEXT NOT NULL,
      submission_type TEXT,
      note TEXT NOT NULL DEFAULT '',
      /* Four states, not six. 'submitted' IS under review — a separate
         UNDER_REVIEW would be a status nothing ever sets, and there is no
         draft step in this workflow. Both terminal states are kept distinct
         because "fix it" and "we are not taking this" are different answers. */
      status TEXT NOT NULL DEFAULT 'submitted'
        CHECK (status IN ('submitted','changes_requested','approved','rejected')),
      submitted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      review_comment TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      /* The version invariant, held by the database. Two simultaneous
         submissions cannot both become V2: one wins and the other is told to
         retry, rather than both being written. */
      UNIQUE (assignment_id, version_no)
    )`);
  /* One version awaiting a verdict at a time — a creator cannot stack V2 on
     top of an unreviewed V1, and a duplicate request from a retried network
     call cannot open a second review. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_sub_pending
                    ON mo_creator_submissions(assignment_id) WHERE status='submitted'`);
  /* Approval is final for the whole assignment: at most one approved version. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_sub_approved
                    ON mo_creator_submissions(assignment_id) WHERE status='approved'`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_sub_status ON mo_creator_submissions(status, submitted_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_sub_reviewer ON mo_creator_submissions(reviewed_by, reviewed_at DESC)`);

  /* ── Phase 4: point rules, ledger, cycles ───────────────────────────────
     THE LEDGER IS THE SOURCE OF TRUTH. There is deliberately no
     creator.total_points column: a balance is SUM(points) over the ledger,
     filtered by cycle. Nothing increments a stored total, so no total can
     drift away from the rows that explain it.

     Points are accounting data. Every row says who, how many, why, from what
     source, who created it, when, and in which cycle — and no row is ever
     edited or deleted. A mistake is corrected by a compensating row, never by
     changing history. */

  /* What a thing is worth. Configurable, so nothing hard-codes a number into
     the approval path — and the amount is COPIED onto the ledger row at award
     time, so changing a rule tomorrow cannot rewrite what was earned today. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_point_rules (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      points INTEGER NOT NULL,
      /* Only the two sources Phase 4 actually has. A rule is either what an
         approved submission earns, or the basis for a manual entry. */
      source_type TEXT NOT NULL DEFAULT 'approved_submission'
        CHECK (source_type IN ('approved_submission','manual')),
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_rule_name ON mo_creator_point_rules(lower(name))`);

  /* The scoring period. Named after mo_kra_cycles, which is how Nerve already
     spells a cycle (label / starts_on / ends_on / status). Explicit business
     objects — the current calendar month is never assumed. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_cycles (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      label TEXT NOT NULL,
      starts_on DATE NOT NULL,
      ends_on DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','active','closed','archived')),
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT mo_creator_cycle_dates CHECK (ends_on >= starts_on)
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_cycle_label ON mo_creator_cycles(lower(label))`);
  /* At most one active cycle, held by the database rather than by a check the
     next writer might skip. A unique index over a constant column value is
     what makes "only one row may be active" an invariant. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_cycle_one_active
                    ON mo_creator_cycles((status)) WHERE status='active'`);

  /* The ledger. Append-only by construction: no endpoint updates a row, and
     corrections are compensating rows carrying reversal_of_id. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_point_ledger (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      /* NULL means "earned, but no cycle was active when it happened". The
         points are recorded rather than lost or guessed into a month; an Admin
         assigns them to a cycle explicitly. */
      cycle_id BIGINT REFERENCES mo_creator_cycles(id) ON DELETE RESTRICT,
      rule_id BIGINT REFERENCES mo_creator_point_rules(id) ON DELETE RESTRICT,
      /* The amount as it was awarded. Copied, never looked up again — this is
         what makes a later rule change unable to rewrite history. */
      points INTEGER NOT NULL,
      source_type TEXT NOT NULL
        CHECK (source_type IN ('approved_submission','manual','reversal')),
      source_id BIGINT,
      reason TEXT NOT NULL DEFAULT '',
      reversal_of_id BIGINT REFERENCES mo_creator_point_ledger(id) ON DELETE RESTRICT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  /* IDEMPOTENCY. One approved submission earns its rule exactly once, however
     many times the request arrives — a double click, a retry, a browser
     refresh, two reviewers racing. The database decides, not an
     if-not-exists-then-insert the next thread can interleave with. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_ledger_source
                    ON mo_creator_point_ledger(source_type, source_id, rule_id)
                    WHERE source_id IS NOT NULL AND source_type='approved_submission'`);
  // A transaction can be reversed once, and never twice.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_ledger_reversal
                    ON mo_creator_point_ledger(reversal_of_id) WHERE reversal_of_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_ledger_cycle ON mo_creator_point_ledger(cycle_id, user_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_ledger_user ON mo_creator_point_ledger(user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_ledger_pending ON mo_creator_point_ledger(created_at) WHERE cycle_id IS NULL`);

  /* Which rule an opportunity earns. Additive and nullable: existing
     opportunities keep working, and an admin says "this Reel role pays the
     Approved Reel rule" rather than the code guessing from a free-text type. */
  await pool.query(`ALTER TABLE mo_creator_opportunities
                    ADD COLUMN IF NOT EXISTS point_rule_id BIGINT REFERENCES mo_creator_point_rules(id)`);

  /* ═══════════════════════════════════════════════════════════════════════
     CREATOR NETWORK — Phase 5: payouts, the financial ledger, payment

     TWO LEDGERS, TWO JOBS.

       mo_creator_point_ledger      performance. Points, ranking, cycles.
       mo_creator_financial_ledger  money. Amounts payable, paid, corrected.

     A payout READS points and never writes them. Nothing in this block
     references mo_creator_point_ledger except as a source to sum, which is
     what keeps a financial correction from ever becoming a change to what
     somebody earned.

     Money is NUMERIC end to end. node-postgres returns NUMERIC as a string, so
     an amount is never a JavaScript float on either leg of the journey, and
     every arithmetic operation on money happens in Postgres.
     ═══════════════════════════════════════════════════════════════════════ */

  /* The rate. ₹ per point, with an effective window, because a rate that
     changes in October must not restate September.

     NUMERIC(12,4) rather than the (12,2) Nerve uses for amounts: a rate is not
     an amount, and ₹7.50 and ₹0.0125 per point are both legitimate. The
     precedent for a finer NUMERIC is mo_ai_requests.estimated_cost. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_payout_rules (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      rate NUMERIC(12,4) NOT NULL CHECK (rate > 0),
      currency TEXT NOT NULL DEFAULT 'INR',
      is_active BOOLEAN NOT NULL DEFAULT true,
      effective_from DATE NOT NULL,
      effective_to DATE,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT mo_creator_payout_rule_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_payrule_name
                    ON mo_creator_payout_rules(lower(name))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_payrule_window
                    ON mo_creator_payout_rules(effective_from, effective_to) WHERE is_active`);

  /* The payout: one statement for one creator in one cycle.

     Everything that decided the amount is COPIED here at calculation time —
     the point total, the rate, the rule it came from and the gross it produced.
     A later rate change, a later point correction and a later cycle edit all
     leave this row saying exactly what was calculated and when. Nothing
     recomputes it for display.

     There is deliberately no net_amount column. Net is gross plus whatever the
     financial ledger holds against this payout, derived on read, for the same
     reason Phase 4 has no stored point total: a second number is a number that
     can disagree. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_payouts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      cycle_id BIGINT NOT NULL REFERENCES mo_creator_cycles(id) ON DELETE RESTRICT,
      -- The snapshot.
      points_basis INTEGER NOT NULL,
      payout_rule_id BIGINT REFERENCES mo_creator_payout_rules(id) ON DELETE RESTRICT,
      rate NUMERIC(12,4) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      gross_amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'calculated'
        CHECK (status IN ('calculated','approved','paid','rejected','voided')),
      calculated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      calculated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      paid_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      paid_at TIMESTAMPTZ,
      payment_reference TEXT,
      decision_reason TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  /* IDEMPOTENCY. One live payout per creator per cycle, whatever arrives and
     however often. Ten simultaneous generate requests produce one row because
     the index says so, not because a read-then-write got lucky.

     Rejected and voided statements are excluded: those are closed outcomes, and
     a cycle whose payout was rejected must be able to be calculated again. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_payout_one
                    ON mo_creator_payouts(user_id, cycle_id)
                    WHERE status NOT IN ('rejected','voided')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_payout_cycle ON mo_creator_payouts(cycle_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_payout_user ON mo_creator_payouts(user_id, calculated_at DESC)`);

  /* THE FINANCIAL LEDGER — the source of truth for money.

     Entries are amounts OWED. A payout recognises the liability (+), an
     adjustment moves it either way, a reversal cancels one entry exactly, and
     a payment settles it (−). So the sum over a payout is what is still
     outstanding, and zero means settled — no status field has to be trusted
     for that, and "approved but unpaid" is a number rather than an opinion.

     Append-only. No endpoint updates or deletes a row here. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_financial_ledger (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      payout_id BIGINT REFERENCES mo_creator_payouts(id) ON DELETE RESTRICT,
      cycle_id BIGINT REFERENCES mo_creator_cycles(id) ON DELETE RESTRICT,
      entry_type TEXT NOT NULL
        CHECK (entry_type IN ('payout','adjustment','reversal','payment')),
      amount NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      description TEXT NOT NULL,
      /* A safe payment reference only — a UTR, a voucher number, a bank
         reference. Never a credential: no password, no UPI PIN, no API key. */
      reference TEXT,
      reversal_of_id BIGINT REFERENCES mo_creator_financial_ledger(id) ON DELETE RESTRICT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  /* One liability entry per payout, and one payment per payout. Approving
     twice cannot recognise the money twice; paying twice cannot send it twice.
     Both are held by the database rather than by a status check. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_fin_one_payout
                    ON mo_creator_financial_ledger(payout_id)
                    WHERE entry_type='payout' AND payout_id IS NOT NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_fin_one_payment
                    ON mo_creator_financial_ledger(payout_id)
                    WHERE entry_type='payment' AND payout_id IS NOT NULL`);
  // An entry is reversed once and never twice.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_fin_reversal
                    ON mo_creator_financial_ledger(reversal_of_id) WHERE reversal_of_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_fin_user ON mo_creator_financial_ledger(user_id, created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_fin_payout ON mo_creator_financial_ledger(payout_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_fin_cycle ON mo_creator_financial_ledger(cycle_id, entry_type)`);

  /* ═══════════════════════════════════════════════════════════════════════
     CREATOR NETWORK — Phase 6: recognition and competition

     PHASE 6 DOES NOT OWN PERFORMANCE ACCOUNTING.

     It consumes it. The point ledger stays the source of truth for points and
     rank; the financial ledger stays the source of truth for money. Nothing in
     this block stores a point total, a rank, an achievement score or a
     competition score inside either of them, and nothing in Phase 6 writes to
     either at all.

     Four concepts, deliberately four tables, because they are not the same
     thing: an achievement is not a rank, Creator of the Cycle is not "rank #1
     renamed", and a War Zone score is not a Creator point.
     ═══════════════════════════════════════════════════════════════════════ */

  /* What can be earned. A DEFINITION, not an award.

     Criteria are STRUCTURED DATA — a closed set of types plus a number — never
     an expression, never a string that becomes code or SQL. Adding a criterion
     means adding a branch to the evaluator, which is the point: an admin
     configures what is already possible and cannot invent execution. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_achievements (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      code TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '★',
      /* LIFETIME, CYCLE and COMPETITION are not interchangeable: "100 approved
         contents" is earned once ever, "Top 3" is earned per cycle, and a
         competition badge belongs to one competition. */
      scope TEXT NOT NULL DEFAULT 'lifetime'
        CHECK (scope IN ('lifetime','cycle','competition')),
      criteria_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (criteria_type IN ('point_threshold','approved_content_count','cycle_rank',
                                 'creator_of_cycle','competition_result','manual')),
      criteria_value INTEGER,
      is_active BOOLEAN NOT NULL DEFAULT true,
      is_seeded BOOLEAN NOT NULL DEFAULT false,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_ach_code ON mo_creator_achievements(code)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_ach_name ON mo_creator_achievements(lower(name))`);

  /* What was earned. Recognition is history: an award survives the creator
     leaving the team, going inactive, being suspended or being archived.
     A mistake is REVOKED — recorded, with a reason and an actor — never
     deleted. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_achievement_awards (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      achievement_id BIGINT NOT NULL REFERENCES mo_creator_achievements(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      cycle_id BIGINT REFERENCES mo_creator_cycles(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL DEFAULT 'manual'
        CHECK (source_type IN ('auto','manual')),
      source_id BIGINT,
      note TEXT NOT NULL DEFAULT '',
      awarded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      revoke_reason TEXT
    )`);
  /* IDEMPOTENCY, across all three scopes at once. A lifetime achievement has
     no cycle and no source, so both COALESCE to 0 and the key is (creator,
     achievement) — Postgres treats NULLs as distinct, which would otherwise
     let a lifetime badge be awarded twice. A cycle achievement keys on the
     cycle, a competition one on the competition.

     Live awards only: a revoked award stays in history and does not stop the
     same badge being earned properly later. */
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_ach_award_once
                    ON mo_creator_achievement_awards
                       (user_id, achievement_id, COALESCE(cycle_id, 0), COALESCE(source_id, 0))
                    WHERE revoked_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_ach_award_user
                    ON mo_creator_achievement_awards(user_id, awarded_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_ach_award_cycle
                    ON mo_creator_achievement_awards(cycle_id)`);

  /* CREATOR OF THE CYCLE — a recognition record in its own right.

     Not "rank #1 with a nicer name". Today the rule is the top of the closed
     cycle, and the row records the rank and the points that justified it so a
     later point correction cannot rewrite why somebody was recognised. Keeping
     it separate is what lets the rule change later without rewriting history.

     UNIQUE (cycle_id, user_id), not (cycle_id): a tie means the cycle has two
     winners and both are named, which is the honest answer and needs no
     invented tie-breaker. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_cycle_awards (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      cycle_id BIGINT NOT NULL REFERENCES mo_creator_cycles(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      rank_at_award INTEGER NOT NULL,
      points_at_award INTEGER NOT NULL,
      criteria TEXT NOT NULL DEFAULT '',
      awarded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_cycle_award_once
                    ON mo_creator_cycle_awards(cycle_id, user_id)`);

  /* ── WAR ZONE ───────────────────────────────────────────────────────────
     A competition is not the leaderboard and not the point ledger. It has its
     own window, its own participants and its own score, and winning one does
     not change what anybody has earned in the network. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_competitions (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      rules TEXT NOT NULL DEFAULT '',
      /* Recognition only. A prize here is words — money belongs to Phase 5's
         financial architecture and is never created by winning a competition. */
      recognition TEXT NOT NULL DEFAULT '',
      starts_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','open','active','completed','cancelled')),
      scope TEXT NOT NULL DEFAULT 'network' CHECK (scope IN ('network','team')),
      team_id BIGINT REFERENCES mo_creator_teams(id) ON DELETE RESTRICT,
      completed_at TIMESTAMPTZ,
      decision_reason TEXT,
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT mo_creator_comp_window CHECK (ends_at > starts_at),
      CONSTRAINT mo_creator_comp_scope CHECK (scope <> 'team' OR team_id IS NOT NULL)
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_comp_name ON mo_creator_competitions(lower(name))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_comp_status ON mo_creator_competitions(status, starts_at DESC)`);

  /* One row per creator per competition — registering twice is the same
     registration, held by the index rather than by a check. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_competition_participants (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      competition_id BIGINT NOT NULL REFERENCES mo_creator_competitions(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'registered'
        CHECK (status IN ('registered','withdrawn','disqualified')),
      note TEXT NOT NULL DEFAULT '',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_comp_part_once
                    ON mo_creator_competition_participants(competition_id, user_id)`);

  /* THE COMPETITION SCORE, AND IT IS NOT A CREATOR POINT.

     Entries sum to a participant's score, the same shape as the point ledger
     and for the same reason: no stored total to drift, and a correction is a
     compensating entry rather than an edit. Writing any of this into
     mo_creator_point_ledger would make a judged contest change somebody's
     permanent performance record and, through Phase 5, their pay. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_competition_scores (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      competition_id BIGINT NOT NULL REFERENCES mo_creator_competitions(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      score INTEGER NOT NULL,
      reason TEXT NOT NULL,
      recorded_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_cr_comp_score
                    ON mo_creator_competition_scores(competition_id, user_id)`);

  /* The result, snapshotted at finalisation: the place and the score exactly
     as they stood. A score corrected afterwards does not silently rewrite who
     won, and the competition stays explainable forever. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_creator_competition_results (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      competition_id BIGINT NOT NULL REFERENCES mo_creator_competitions(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      place INTEGER NOT NULL,
      score INTEGER NOT NULL,
      result_type TEXT NOT NULL
        CHECK (result_type IN ('winner','runner_up','finalist','participant')),
      finalized_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      finalized_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  // One result per creator per competition: finalising twice changes nothing.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mo_cr_comp_result_once
                    ON mo_creator_competition_results(competition_id, user_id)`);

  /* Starter achievements, so the framework is usable on day one rather than an
     empty screen. Every one is editable and retirable by a Creator Admin, and
     seeded only when absent so later edits are never overwritten on boot.
     Thresholds here are starting points, not business policy. */
  await pool.query(`
    INSERT INTO mo_creator_achievements (code, name, description, icon, scope, criteria_type, criteria_value, is_seeded)
    SELECT * FROM (VALUES
      ('first_content','First Approved Content','Your first piece of content passed review.','🌱',
       'lifetime','approved_content_count',1,true),
      ('ten_contents','10 Approved Contents','Ten pieces of approved content.','🎬',
       'lifetime','approved_content_count',10,true),
      ('hundred_points','100 Points','A hundred points earned across the network.','💯',
       'lifetime','point_threshold',100,true),
      ('top_three_cycle','Top 3 in Cycle','Finished a cycle in the top three.','🥉',
       'cycle','cycle_rank',3,true),
      ('creator_of_cycle','Creator of the Cycle','Recognised as Creator of the Cycle.','👑',
       'cycle','creator_of_cycle',NULL,true),
      ('war_zone_winner','War Zone Winner','Won a War Zone competition.','⚔️',
       'competition','competition_result',1,true)
    ) AS seed(code, name, description, icon, scope, criteria_type, criteria_value, is_seeded)
     WHERE NOT EXISTS (SELECT 1 FROM mo_creator_achievements a WHERE a.code = seed.code)`);

  /* Phase 8 — the Creator Network's automation rules, in the table Media Ops
     already uses and on the same five-minute tick. Seeded only when absent,
     so an operator's toggle is never overwritten on the next boot. */
  await seedCreatorAutomationRules();

  /* SECURITY — this row is not optional.

     effectiveModules() returns null when a group has no defaults row, and
     requireModule() reads null as "unrestricted". Without this, a creator would
     pass EVERY module gate in Media Ops. Seeding the group closed (no modules
     beyond the network itself) is what makes the vertical deny-by-default at
     the module layer as well as the role layer.

     Written only when absent, so an administrator's later edits are never
     overwritten on the next boot. */
  await pool.query(`
    INSERT INTO mo_module_defaults (role, modules)
    SELECT 'creator', '["creator"]'::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM mo_module_defaults WHERE role='creator')`);
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
