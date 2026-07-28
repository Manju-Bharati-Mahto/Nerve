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
      color TEXT, joined_on DATE, campus_id BIGINT REFERENCES mo_campuses(id)
    )`);

  // ── §11.2 Projects & production ──────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_project_types (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), name TEXT NOT NULL, slug TEXT NOT NULL,
      color TEXT, icon TEXT, sort_order INTEGER NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true,
      default_template_id BIGINT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_projects (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      department_id BIGINT REFERENCES mo_departments(id), campus_id BIGINT REFERENCES mo_campuses(id),
      academic_year_id BIGINT REFERENCES mo_academic_years(id),
      project_type_id BIGINT NOT NULL REFERENCES mo_project_types(id),
      code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      faculty_served TEXT,
      status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN
        ('proposed','approved','planning','in_production','in_review','delivered','completed','archived','on_hold','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
      owner_id TEXT NOT NULL REFERENCES users(id), created_by TEXT NOT NULL REFERENCES users(id),
      start_date DATE, end_date DATE, cover_image_url TEXT, type_meta JSONB NOT NULL DEFAULT '{}'::JSONB,
      source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','excel_import')),
      archived_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_projects_status ON mo_projects(department_id, status)`);
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_shoots (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      project_id BIGINT NOT NULL REFERENCES mo_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, shoot_date DATE NOT NULL, call_time TEXT, end_time TEXT,
      location TEXT, location_url TEXT, notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','confirmed','done','cancelled'))
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_shoots_date ON mo_shoots(shoot_date)`);
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
      deleted_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_project ON mo_deliverables(project_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_owner ON mo_deliverables(owner_id, status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mo_deliv_overdue ON mo_deliverables(due_date)
                    WHERE status NOT IN ('delivered','not_required','cancelled')`);

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
      UNIQUE (user_id, report_date)  -- BR-3: one report per user per calendar day
    )`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_leave_types (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name TEXT NOT NULL,
      annual_quota NUMERIC(4,1) NOT NULL DEFAULT 0, is_active BOOLEAN NOT NULL DEFAULT true, notes TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_leave_requests (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      leave_type_id BIGINT NOT NULL REFERENCES mo_leave_types(id), starts_on DATE NOT NULL, ends_on DATE NOT NULL,
      half_day BOOLEAN NOT NULL DEFAULT false, reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
      decided_by TEXT REFERENCES users(id), decided_at DATE, decision_note TEXT NOT NULL DEFAULT ''
    )`);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mo_audit_logs (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      actor_id TEXT REFERENCES users(id), actor_role TEXT, action TEXT NOT NULL,
      entity_type TEXT, entity_id BIGINT, before JSONB, after JSONB, ip TEXT, user_agent TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
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
  await pool.query(`INSERT INTO mo_deliverable_types (department_id, name, slug, icon, default_weight, default_unit, review_exempt, is_active, sort_order) VALUES
    (1,'Photos — Raw','photos-raw','◈',1,'photos',false,true,1),
    (1,'Photos — Edited','photos-edited','◉',3,'photos',false,true,2),
    (1,'Video — Raw','video-raw','▤',1,'clips',true,true,3),
    (1,'Video — Edited','video-edited','▶',4,'videos',false,true,4),
    (1,'Aftermovie','aftermovie','★',8,'minutes',false,true,5),
    (1,'Highlight Reel','highlight-reel','◧',5,'minutes',false,true,6),
    (1,'Reel / Short','reel','◔',2,'reels',false,true,7),
    (1,'Outreach Content','outreach','◇',2,'posts',false,true,8),
    (1,'Continuous Recording','continuous','◺',3,'hours',true,true,9),
    (1,'Drone Footage','drone','◆',3,'clips',false,true,10),
    (1,'Album Design','album','◈',4,'spreads',false,true,11),
    (1,'Story / Post','story','◔',1,'posts',false,true,12),
    (1,'Raw Archive','raw-archive','◫',1,'GB',true,true,13),
    (1,'Other','other','◇',1,'items',false,true,14)`);
  await pool.query(`INSERT INTO mo_equipment_categories (department_id, name, tracking_mode, icon, sort_order) VALUES
    (1,'Camera Body','individual','▣',1),(1,'Lens','individual','◎',2),(1,'Drone','individual','◆',3),
    (1,'Gimbal','individual','◇',4),(1,'Light','individual','◔',5),(1,'Microphone','individual','◪',6),
    (1,'Audio Recorder','individual','▤',7),(1,'Tripod / Support','individual','◇',8),
    (1,'Memory Card','pooled','◭',9),(1,'Battery','pooled','◮',10),(1,'Accessory','pooled','◇',11)`);
  await pool.query(`INSERT INTO mo_leave_types (name, annual_quota, is_active, notes) VALUES
    ('Casual Leave',12,true,''),('Sick Leave',8,true,''),('Comp-off',0,true,'Earned against Sunday / festival shoots'),
    ('Earned Leave',15,true,''),('Loss of Pay',0,true,'')`);
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

  // eslint-disable-next-line no-console
  console.log("Media Ops lookups + templates seeded (§11).");
}
