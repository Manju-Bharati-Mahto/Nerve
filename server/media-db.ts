/**
 * Nerve Media Ops — data layer (PRD/SRS v1.0, Phase 0 + Phase 1 scope).
 *
 * Implements the §11 schema subset needed for: Projects (FR-3.x), Deliverables
 * + versions + approvals (FR-4.x), log-as-you-go Daily Reporting (D1, FR-2.x),
 * the role-adaptive dashboard (FR-1.x), in-app notifications, audit/activity
 * (FR-13.x subset) and the AUTO-1/4/13 + 48h auto-approve automations (D2).
 *
 * Deliberate Phase-1 adaptations (documented for reviewers):
 *  - Tables are prefixed media_ to coexist with branding_ and outreach_ tables
 *    in the shared Nerve database; the single-department scope keeps OBJ-8's
 *    department dimension implicit until a second department onboards.
 *  - Media Ops consumes Nerve identity (§3.2): no media users table — the
 *    global `users` table is referenced, and the three PRD roles (D4) are a
 *    pure mapping: admin→admin, sub_admin→team_lead, user→employee (team
 *    'media'; super_admin is admin everywhere). No new global role.
 *  - deliverable_versions carry drive_url directly (the structured drive_links
 *    table still exists for project/deliverable file links).
 *  - daily_reports.total_minutes is recomputed app-side on task writes rather
 *    than by trigger — equivalent result, simpler migration surface.
 */
import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

function mid(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

// ── Constants (state machines per FR-3.1 / FR-4.1 / FR-2.1, BR-1) ──────────

export const MEDIA_PROJECT_STATUSES = [
  "proposed", "approved", "planning", "in_production", "in_review",
  "delivered", "completed", "archived", "on_hold", "cancelled",
] as const;
export type MediaProjectStatus = (typeof MEDIA_PROJECT_STATUSES)[number];

/** BR-1: forward transitions along the machine; On Hold / Cancelled reachable
 *  from any active state; Admin-only un-archive is enforced in the API layer. */
const PROJECT_FLOW: Record<string, string[]> = {
  proposed: ["approved", "cancelled"],
  approved: ["planning", "on_hold", "cancelled"],
  planning: ["in_production", "on_hold", "cancelled"],
  in_production: ["in_review", "on_hold", "cancelled"],
  in_review: ["in_production", "delivered", "on_hold", "cancelled"],
  delivered: ["completed", "in_review"],
  completed: ["archived"],
  archived: ["completed"],
  on_hold: ["planning", "in_production", "cancelled"],
  cancelled: [],
};
export function projectTransitionAllowed(from: string, to: string): boolean {
  if (from === to) return false;
  if ((to === "on_hold" || to === "cancelled") && !["completed", "archived", "cancelled"].includes(from)) return true;
  return (PROJECT_FLOW[from] ?? []).includes(to);
}

export const MEDIA_DELIVERABLE_STATUSES = [
  "not_started", "in_progress", "in_review", "changes_requested",
  "approved", "delivered", "not_required", "cancelled",
] as const;
export type MediaDeliverableStatus = (typeof MEDIA_DELIVERABLE_STATUSES)[number];

export const MEDIA_REPORT_STATUSES = [
  "draft", "submitted", "flagged", "approved", "auto_approved", "returned",
] as const;
export type MediaReportStatus = (typeof MEDIA_REPORT_STATUSES)[number];

// ── Row types ──────────────────────────────────────────────────────────────

export interface MediaLookup {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  icon: string | null;
  default_weight: number | null;
  default_unit: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface MediaProject {
  id: string;
  code: string;
  name: string;
  description: string;
  project_type_id: string;
  academic_year_id: string;
  faculty_served: string;
  status: MediaProjectStatus;
  priority: "urgent" | "high" | "normal" | "low";
  owner_id: string;
  created_by: string;
  start_date: string | null;
  end_date: string | null;
  source: string;
  created_at: string;
  // aggregates (list/detail queries)
  progress?: number;
  deliverable_counts?: Record<string, number>;
  logged_minutes?: number;
}

export interface MediaAssignment {
  id: string;
  project_id: string;
  user_id: string;
  capacity_role_id: string | null;
  is_project_manager: boolean;
  assigned_at: string;
}

export interface MediaDeliverable {
  id: string;
  project_id: string;
  deliverable_type_id: string;
  title: string;
  owner_id: string | null;
  due_date: string | null;
  completed_at: string | null;
  quantity_target: number | null;
  quantity_delivered: number | null;
  unit: string | null;
  spec_notes: string;
  weight: number;
  status: MediaDeliverableStatus;
  social_status: "na" | "scheduled" | "posted";
  social_post_url: string | null;
  mail_status: "na" | "pending" | "sent";
  project_code?: string;
  project_name?: string;
  version_count?: number;
  latest_version?: MediaDeliverableVersion | null;
}

export interface MediaDeliverableVersion {
  id: string;
  deliverable_id: string;
  version_no: number;
  drive_url: string;
  note: string;
  submitted_by: string;
  submitted_at: string;
  review_status: "pending" | "approved" | "changes_requested";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
}

export interface MediaDailyReport {
  id: string;
  user_id: string;
  report_date: string;
  status: MediaReportStatus;
  submitted_at: string | null;
  note: string;
  flagged_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  total_minutes: number;
  tasks?: MediaReportTask[];
}

export interface MediaReportTask {
  id: string;
  daily_report_id: string;
  project_id: string;
  task_category_id: string;
  deliverable_id: string | null;
  description: string;
  start_time: string | null;
  end_time: string | null;
  minutes: number;
  quantity: number | null;
  unit: string | null;
  status: "done" | "in_progress" | "blocked";
  blocker_note: string | null;
  evidence_url: string | null;
  sort_order: number;
}

export interface MediaNotification {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: string;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

const LOOKUP_TABLES = ["project_types", "deliverable_types", "task_categories", "capacity_roles"] as const;
export type MediaLookupType = (typeof LOOKUP_TABLES)[number];
export function isMediaLookupType(t: string): t is MediaLookupType {
  return (LOOKUP_TABLES as readonly string[]).includes(t);
}

export async function bootstrapMediaDatabase() {
  // The 'media' team must exist on ALREADY-SEEDED databases too (the global
  // team seeding only runs when the teams table is empty).
  await pool.query(
    `INSERT INTO teams (id, name, color, is_built_in) VALUES ('media', 'Media Crew', 'green', true)
     ON CONFLICT (id) DO NOTHING`,
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_academic_years (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL UNIQUE,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      is_current BOOLEAN NOT NULL DEFAULT false
    )
  `);

  for (const t of LOOKUP_TABLES) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS media_${t} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        color TEXT,
        icon TEXT,
        default_weight SMALLINT,
        default_unit TEXT,
        sort_order INT NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true
      )
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_template_deliverables (
      id TEXT PRIMARY KEY,
      project_type_id TEXT NOT NULL REFERENCES media_project_types(id) ON DELETE CASCADE,
      deliverable_type_id TEXT NOT NULL REFERENCES media_deliverable_types(id) ON DELETE CASCADE,
      title_pattern TEXT NOT NULL DEFAULT '',
      default_weight SMALLINT NOT NULL DEFAULT 1,
      days_offset_due INT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_projects (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      project_type_id TEXT NOT NULL REFERENCES media_project_types(id),
      academic_year_id TEXT NOT NULL REFERENCES media_academic_years(id),
      faculty_served TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('proposed','approved','planning','in_production','in_review','delivered','completed','archived','on_hold','cancelled')),
      priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
      owner_id TEXT NOT NULL REFERENCES users(id),
      created_by TEXT NOT NULL REFERENCES users(id),
      start_date DATE,
      end_date DATE,
      type_meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      source TEXT NOT NULL DEFAULT 'app',
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_projects_status_idx ON media_projects(status)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_project_assignments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      capacity_role_id TEXT REFERENCES media_capacity_roles(id),
      is_project_manager BOOLEAN NOT NULL DEFAULT false,
      assigned_by TEXT REFERENCES users(id),
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      removed_at TIMESTAMPTZ
    )
  `);
  // One active assignment per user per project; at most one PM (BR-2).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS media_assign_unique ON media_project_assignments(project_id, user_id) WHERE removed_at IS NULL`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS media_assign_one_pm ON media_project_assignments(project_id) WHERE is_project_manager AND removed_at IS NULL`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_deliverables (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
      deliverable_type_id TEXT NOT NULL REFERENCES media_deliverable_types(id),
      title TEXT NOT NULL,
      owner_id TEXT REFERENCES users(id),
      due_date DATE,
      completed_at TIMESTAMPTZ,
      quantity_target INT,
      quantity_delivered INT,
      unit TEXT,
      spec_notes TEXT NOT NULL DEFAULT '',
      weight SMALLINT NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','in_review','changes_requested','approved','delivered','not_required','cancelled')),
      social_status TEXT NOT NULL DEFAULT 'na' CHECK (social_status IN ('na','scheduled','posted')),
      social_post_url TEXT,
      social_posted_at TIMESTAMPTZ,
      mail_status TEXT NOT NULL DEFAULT 'na' CHECK (mail_status IN ('na','pending','sent')),
      mail_sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_deliv_project_idx ON media_deliverables(project_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_deliv_due_idx ON media_deliverables(due_date) WHERE status NOT IN ('delivered','not_required','cancelled')`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_deliverable_versions (
      id TEXT PRIMARY KEY,
      deliverable_id TEXT NOT NULL REFERENCES media_deliverables(id) ON DELETE CASCADE,
      version_no SMALLINT NOT NULL,
      drive_url TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      submitted_by TEXT NOT NULL REFERENCES users(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','changes_requested')),
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      review_comment TEXT,
      UNIQUE(deliverable_id, version_no)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_drive_links (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('project','deliverable','deliverable_version','report_task')),
      entity_id TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL,
      added_by TEXT REFERENCES users(id),
      validation_status TEXT NOT NULL DEFAULT 'unchecked',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_links_entity_idx ON media_drive_links(entity_type, entity_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_daily_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','flagged','approved','auto_approved','returned')),
      submitted_at TIMESTAMPTZ,
      note TEXT NOT NULL DEFAULT '',
      flagged_reason TEXT,
      reviewed_by TEXT REFERENCES users(id),
      reviewed_at TIMESTAMPTZ,
      review_comment TEXT,
      total_minutes INT NOT NULL DEFAULT 0,
      UNIQUE(user_id, report_date)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_reports_date_idx ON media_daily_reports(report_date)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_report_tasks (
      id TEXT PRIMARY KEY,
      daily_report_id TEXT NOT NULL REFERENCES media_daily_reports(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES media_projects(id),
      task_category_id TEXT NOT NULL REFERENCES media_task_categories(id),
      deliverable_id TEXT REFERENCES media_deliverables(id) ON DELETE SET NULL,
      description TEXT NOT NULL DEFAULT '',
      start_time TIME,
      end_time TIME,
      minutes INT NOT NULL DEFAULT 0,
      quantity INT,
      unit TEXT,
      status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','in_progress','blocked')),
      blocker_note TEXT,
      evidence_url TEXT,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_tasks_report_idx ON media_report_tasks(daily_report_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_tasks_project_idx ON media_report_tasks(project_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      entity_type TEXT,
      entity_id TEXT,
      is_read BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_notif_user_idx ON media_notifications(user_id, is_read, created_at DESC)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_audit_logs (
      id BIGSERIAL PRIMARY KEY,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      project_id TEXT,
      before JSONB,
      after JSONB,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_audit_entity_idx ON media_audit_logs(entity_type, entity_id, occurred_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_audit_project_idx ON media_audit_logs(project_id, occurred_at DESC)`);

  await seedMediaLookups();
}

async function seedMediaLookups() {
  const { rows } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM media_academic_years`);
  if (rows[0].count === 0) {
    await pool.query(
      `INSERT INTO media_academic_years (id, label, start_date, end_date, is_current) VALUES ($1, '2026-27', '2026-06-01', '2027-05-31', true)`,
      [mid("ay")],
    );
  }

  const seedLookup = async (table: MediaLookupType, items: Array<Partial<MediaLookup> & { name: string }>) => {
    const { rows: c } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM media_${table}`);
    if (c[0].count > 0) return;
    let i = 0;
    for (const item of items) {
      const slug = item.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      await pool.query(
        `INSERT INTO media_${table} (id, name, slug, color, icon, default_weight, default_unit, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [mid(table.slice(0, 2)), item.name, slug, item.color ?? null, item.icon ?? null, item.default_weight ?? null, item.default_unit ?? null, i++],
      );
    }
  };

  // FR-3.1 project types
  await seedLookup("project_types", [
    { name: "Annual Event", color: "#1a472a" }, { name: "Educational Tour", color: "#0e7490" },
    { name: "Deputation", color: "#7c3aed" }, { name: "Branding Content", color: "#be185d" },
    { name: "Monthly Campaign", color: "#b45309" }, { name: "Social Media", color: "#4338ca" },
    { name: "Internal", color: "#374151" }, { name: "Other", color: "#6b7280" },
  ]);
  // FR-4.1 deliverable types (+ Raw Archive per FR-3.2/FR-4.8)
  await seedLookup("deliverable_types", [
    { name: "Photos-Raw", default_weight: 1, default_unit: "photos" },
    { name: "Photos-Edited", default_weight: 2, default_unit: "photos" },
    { name: "Video-Raw", default_weight: 1, default_unit: "videos" },
    { name: "Video-Edited", default_weight: 3, default_unit: "videos" },
    { name: "Aftermovie", default_weight: 5, default_unit: "videos" },
    { name: "Highlight Reel", default_weight: 4, default_unit: "videos" },
    { name: "Reel/Short", default_weight: 2, default_unit: "reels" },
    { name: "Outreach Content", default_weight: 2, default_unit: "posts" },
    { name: "Continuous Recording", default_weight: 1, default_unit: "minutes" },
    { name: "Drone Footage", default_weight: 2, default_unit: "minutes" },
    { name: "Album Design", default_weight: 3, default_unit: "albums" },
    { name: "Story/Post", default_weight: 1, default_unit: "posts" },
    { name: "Raw Archive", default_weight: 1, default_unit: "folders" },
    { name: "Other", default_weight: 1, default_unit: "items" },
  ]);
  // §11.4 task categories
  await seedLookup("task_categories", [
    { name: "Shooting", icon: "camera" }, { name: "Editing", icon: "scissors" },
    { name: "Color", icon: "palette" }, { name: "Sound", icon: "mic" },
    { name: "Animation", icon: "film" }, { name: "Coordination", icon: "users" },
    { name: "Travel", icon: "map" }, { name: "Meeting", icon: "calendar" },
    { name: "Upload/Backup", icon: "upload" }, { name: "Other", icon: "circle" },
  ]);
  // FR-3.4 capacity roles
  await seedLookup("capacity_roles", [
    { name: "Photographer" }, { name: "Videographer" }, { name: "Editor" },
    { name: "Drone Op" }, { name: "Coordinator" },
  ]);

  // FR-3.2: default template for Annual Event → 5 standard deliverables.
  const { rows: tpl } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM media_template_deliverables`);
  if (tpl[0].count === 0) {
    const typeId = async (table: string, slug: string) =>
      (await pool.query<{ id: string }>(`SELECT id FROM media_${table} WHERE slug = $1`, [slug])).rows[0]?.id;
    const annual = await typeId("project_types", "annual-event");
    const entries: Array<[string, number, number]> = [
      ["photos-edited", 2, 3], ["aftermovie", 5, 10], ["highlight-reel", 4, 7],
      ["story-post", 1, 2], ["raw-archive", 1, 5],
    ];
    if (annual) {
      for (const [slug, weight, offset] of entries) {
        const dt = await typeId("deliverable_types", slug);
        if (dt) {
          await pool.query(
            `INSERT INTO media_template_deliverables (id, project_type_id, deliverable_type_id, title_pattern, default_weight, days_offset_due) VALUES ($1,$2,$3,'',$4,$5)`,
            [mid("td"), annual, dt, weight, offset],
          );
        }
      }
    }
  }
}

// ── Audit / activity ───────────────────────────────────────────────────────

export async function mediaAudit(entry: {
  actorId: string | null; actorRole?: string | null; action: string;
  entityType: string; entityId: string; projectId?: string | null;
  before?: unknown; after?: unknown;
}) {
  await pool.query(
    `INSERT INTO media_audit_logs (actor_id, actor_role, action, entity_type, entity_id, project_id, before, after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entry.actorId, entry.actorRole ?? null, entry.action, entry.entityType, entry.entityId,
     entry.projectId ?? null, entry.before ? JSON.stringify(entry.before) : null, entry.after ? JSON.stringify(entry.after) : null],
  );
}

export async function listProjectActivity(projectId: string, limit = 30) {
  const { rows } = await pool.query(
    `SELECT a.action, a.entity_type, a.entity_id, a.occurred_at, u.full_name AS actor_name
       FROM media_audit_logs a LEFT JOIN users u ON u.id = a.actor_id
      WHERE a.project_id = $1 ORDER BY a.occurred_at DESC LIMIT $2`,
    [projectId, limit],
  );
  return rows;
}

export async function listAuditLogs(limit = 200) {
  const { rows } = await pool.query(
    `SELECT a.*, u.full_name AS actor_name FROM media_audit_logs a
      LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.occurred_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

// ── Lookups ────────────────────────────────────────────────────────────────

export async function listMediaLookups(): Promise<Record<string, MediaLookup[]>> {
  const out: Record<string, MediaLookup[]> = {};
  for (const t of LOOKUP_TABLES) {
    const { rows } = await pool.query<MediaLookup>(`SELECT * FROM media_${t} ORDER BY sort_order, name`);
    out[t] = rows;
  }
  const { rows: years } = await pool.query(`SELECT * FROM media_academic_years ORDER BY start_date DESC`);
  out["academic_years"] = years as unknown as MediaLookup[];
  return out;
}

export async function createMediaLookup(type: MediaLookupType, name: string): Promise<MediaLookup> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const { rows } = await pool.query<MediaLookup>(
    `INSERT INTO media_${type} (id, name, slug, sort_order)
     VALUES ($1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM media_${type}), 0))
     RETURNING *`,
    [mid(type.slice(0, 2)), name.trim(), slug],
  );
  return rows[0];
}

export async function updateMediaLookup(type: MediaLookupType, id: string, patch: { name?: string; is_active?: boolean }): Promise<MediaLookup | null> {
  const { rows } = await pool.query<MediaLookup>(
    `UPDATE media_${type} SET name = COALESCE($2, name), is_active = COALESCE($3, is_active) WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.is_active ?? null],
  );
  return rows[0] ?? null;
}

export async function listTemplateDeliverables(projectTypeId?: string) {
  const { rows } = await pool.query(
    `SELECT t.*, dt.name AS deliverable_type_name FROM media_template_deliverables t
      JOIN media_deliverable_types dt ON dt.id = t.deliverable_type_id
      ${projectTypeId ? "WHERE t.project_type_id = $1" : ""} ORDER BY t.id`,
    projectTypeId ? [projectTypeId] : [],
  );
  return rows;
}

export async function setTemplateDeliverables(projectTypeId: string, entries: Array<{ deliverable_type_id: string; default_weight: number; days_offset_due: number | null }>) {
  await pool.query(`DELETE FROM media_template_deliverables WHERE project_type_id = $1`, [projectTypeId]);
  for (const e of entries) {
    await pool.query(
      `INSERT INTO media_template_deliverables (id, project_type_id, deliverable_type_id, default_weight, days_offset_due) VALUES ($1,$2,$3,$4,$5)`,
      [mid("td"), projectTypeId, e.deliverable_type_id, e.default_weight, e.days_offset_due],
    );
  }
}

// ── Projects (FR-3.x) ──────────────────────────────────────────────────────

async function nextProjectCode(academicYearId: string): Promise<string> {
  const { rows } = await pool.query<{ label: string }>(`SELECT label FROM media_academic_years WHERE id = $1`, [academicYearId]);
  const label = rows[0]?.label ?? "0000-00";
  const digits = label.replace(/[^0-9]/g, "");
  const compact = digits.slice(2, 4) + label.slice(-2); // '2026-27' → '2627' (PRD: MC-2627-0142)
  const { rows: c } = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM media_projects WHERE academic_year_id = $1`, [academicYearId],
  );
  return `MC-${compact}-${String(c[0].count + 1).padStart(4, "0")}`;
}

/** Progress per D3: weighted deliverable completion (delivered weight / active weight). */
const PROGRESS_SQL = `
  COALESCE((
    SELECT ROUND(100.0 * NULLIF(SUM(CASE WHEN d.status = 'delivered' THEN d.weight ELSE 0 END), 0)
           / NULLIF(SUM(CASE WHEN d.status NOT IN ('not_required','cancelled') THEN d.weight ELSE 0 END), 0))
      FROM media_deliverables d WHERE d.project_id = p.id
  ), 0)::int
`;

export async function listMediaProjects(filters: {
  status?: string; projectTypeId?: string; academicYearId?: string; q?: string;
  forUserId?: string; // employee scope: owned or assigned
} = {}): Promise<MediaProject[]> {
  const where: string[] = ["1=1"];
  const values: unknown[] = [];
  let i = 1;
  if (filters.status) { where.push(`p.status = $${i++}`); values.push(filters.status); }
  if (filters.projectTypeId) { where.push(`p.project_type_id = $${i++}`); values.push(filters.projectTypeId); }
  if (filters.academicYearId) { where.push(`p.academic_year_id = $${i++}`); values.push(filters.academicYearId); }
  if (filters.q) { where.push(`(p.name ILIKE $${i} OR p.code ILIKE $${i} OR p.faculty_served ILIKE $${i})`); values.push(`%${filters.q}%`); i++; }
  if (filters.forUserId) {
    where.push(`(p.owner_id = $${i} OR EXISTS (SELECT 1 FROM media_project_assignments a WHERE a.project_id = p.id AND a.user_id = $${i} AND a.removed_at IS NULL))`);
    values.push(filters.forUserId); i++;
  }
  const { rows } = await pool.query(
    `SELECT p.*, p.start_date::text AS start_date, p.end_date::text AS end_date, ${PROGRESS_SQL} AS progress,
            (SELECT COALESCE(SUM(t.minutes), 0)::int FROM media_report_tasks t WHERE t.project_id = p.id) AS logged_minutes,
            (SELECT COUNT(*)::int FROM media_deliverables d WHERE d.project_id = p.id AND d.status NOT IN ('not_required','cancelled')) AS deliverable_total,
            (SELECT COUNT(*)::int FROM media_deliverables d WHERE d.project_id = p.id AND d.status = 'delivered') AS deliverable_done
       FROM media_projects p WHERE ${where.join(" AND ")}
      ORDER BY p.created_at DESC LIMIT 300`,
    values,
  );
  return rows as MediaProject[];
}

export async function getMediaProject(id: string) {
  const { rows } = await pool.query(
    `SELECT p.*, p.start_date::text AS start_date, p.end_date::text AS end_date, ${PROGRESS_SQL} AS progress,
            (SELECT COALESCE(SUM(t.minutes), 0)::int FROM media_report_tasks t WHERE t.project_id = p.id) AS logged_minutes
       FROM media_projects p WHERE p.id = $1`,
    [id],
  );
  const project = rows[0] as (MediaProject & Record<string, unknown>) | undefined;
  if (!project) return null;
  const { rows: assignments } = await pool.query(
    `SELECT a.*, u.full_name, cr.name AS capacity_role_name
       FROM media_project_assignments a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN media_capacity_roles cr ON cr.id = a.capacity_role_id
      WHERE a.project_id = $1 AND a.removed_at IS NULL ORDER BY a.assigned_at`,
    [id],
  );
  const deliverables = await listDeliverables({ projectId: id });
  const activity = await listProjectActivity(id);
  const { rows: links } = await pool.query(
    `SELECT l.*, u.full_name AS added_by_name FROM media_drive_links l LEFT JOIN users u ON u.id = l.added_by
      WHERE (l.entity_type = 'project' AND l.entity_id = $1) ORDER BY l.created_at DESC`,
    [id],
  );
  // Per-member logged hours on this project (FR-3.10 zero re-entry roll-up).
  const { rows: hours } = await pool.query(
    `SELECT r.user_id, u.full_name, COALESCE(SUM(t.minutes),0)::int AS minutes
       FROM media_report_tasks t
       JOIN media_daily_reports r ON r.id = t.daily_report_id
       JOIN users u ON u.id = r.user_id
      WHERE t.project_id = $1 GROUP BY r.user_id, u.full_name ORDER BY minutes DESC`,
    [id],
  );
  return { project, assignments, deliverables, activity, links, memberHours: hours };
}

export async function createMediaProject(input: {
  name: string; description?: string; projectTypeId: string; academicYearId: string;
  facultyServed?: string; priority?: string; startDate?: string | null; endDate?: string | null;
  ownerId: string; createdBy: string; initialStatus: "proposed" | "planning";
}): Promise<MediaProject> {
  const code = await nextProjectCode(input.academicYearId);
  const { rows } = await pool.query<MediaProject>(
    `INSERT INTO media_projects (id, code, name, description, project_type_id, academic_year_id, faculty_served, status, priority, owner_id, created_by, start_date, end_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [mid("mp"), code, input.name.trim(), input.description?.trim() ?? "", input.projectTypeId, input.academicYearId,
     input.facultyServed?.trim() ?? "", input.initialStatus, input.priority ?? "normal",
     input.ownerId, input.createdBy, input.startDate || null, input.endDate || null],
  );
  const project = rows[0];

  // FR-3.2: template auto-creates the default deliverable set (owners unset,
  // weights + due-date offsets from the template — AC-5).
  const tpl = await listTemplateDeliverables(input.projectTypeId);
  for (const t of tpl as Array<{ deliverable_type_id: string; deliverable_type_name: string; default_weight: number; days_offset_due: number | null }>) {
    let due: string | null = null;
    if (t.days_offset_due != null && (input.startDate || input.endDate)) {
      const base = new Date(`${input.endDate || input.startDate}T00:00:00Z`);
      base.setUTCDate(base.getUTCDate() + t.days_offset_due);
      due = base.toISOString().slice(0, 10);
    }
    await pool.query(
      `INSERT INTO media_deliverables (id, project_id, deliverable_type_id, title, weight, due_date, unit)
       SELECT $1, $2, $3, dt.name, $4, $5, dt.default_unit FROM media_deliverable_types dt WHERE dt.id = $3`,
      [mid("md"), project.id, t.deliverable_type_id, t.default_weight, due],
    );
  }
  return project;
}

export async function updateMediaProject(id: string, patch: Partial<{
  name: string; description: string; faculty_served: string; priority: string;
  start_date: string | null; end_date: string | null; owner_id: string; project_type_id: string;
}>): Promise<MediaProject | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (fields.length === 0) {
    const { rows } = await pool.query<MediaProject>(`SELECT * FROM media_projects WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await pool.query<MediaProject>(
    `UPDATE media_projects SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values,
  );
  return rows[0] ?? null;
}

export async function setProjectStatus(id: string, status: MediaProjectStatus): Promise<MediaProject | null> {
  const { rows } = await pool.query<MediaProject>(
    `UPDATE media_projects SET status = $2, archived_at = CASE WHEN $2 = 'archived' THEN NOW() ELSE archived_at END, updated_at = NOW()
      WHERE id = $1 RETURNING *`,
    [id, status],
  );
  return rows[0] ?? null;
}

export async function addProjectAssignment(input: {
  projectId: string; userId: string; capacityRoleId?: string | null; isProjectManager?: boolean; assignedBy: string;
}): Promise<MediaAssignment> {
  if (input.isProjectManager) {
    // BR-2: at most one PM — demote any current PM first.
    await pool.query(
      `UPDATE media_project_assignments SET is_project_manager = false WHERE project_id = $1 AND removed_at IS NULL AND is_project_manager`,
      [input.projectId],
    );
  }
  const { rows } = await pool.query<MediaAssignment>(
    `INSERT INTO media_project_assignments (id, project_id, user_id, capacity_role_id, is_project_manager, assigned_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (project_id, user_id) WHERE removed_at IS NULL
     DO UPDATE SET capacity_role_id = EXCLUDED.capacity_role_id, is_project_manager = EXCLUDED.is_project_manager
     RETURNING *`,
    [mid("ma"), input.projectId, input.userId, input.capacityRoleId ?? null, input.isProjectManager ?? false, input.assignedBy],
  );
  return rows[0];
}

export async function removeProjectAssignment(projectId: string, userId: string): Promise<void> {
  await pool.query(
    `UPDATE media_project_assignments SET removed_at = NOW() WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [projectId, userId],
  );
}

export async function isProjectManagerOrOwner(projectId: string, userId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM media_projects p WHERE p.id = $1 AND p.owner_id = $2
     UNION ALL
     SELECT 1 FROM media_project_assignments a WHERE a.project_id = $1 AND a.user_id = $2 AND a.is_project_manager AND a.removed_at IS NULL`,
    [projectId, userId],
  );
  return rows.length > 0;
}

// ── Deliverables (FR-4.x) ──────────────────────────────────────────────────

export async function listDeliverables(filters: {
  projectId?: string; status?: string; ownerId?: string; deliverableTypeId?: string;
} = {}): Promise<MediaDeliverable[]> {
  const where: string[] = ["1=1"];
  const values: unknown[] = [];
  let i = 1;
  if (filters.projectId) { where.push(`d.project_id = $${i++}`); values.push(filters.projectId); }
  if (filters.status) { where.push(`d.status = $${i++}`); values.push(filters.status); }
  if (filters.ownerId) { where.push(`d.owner_id = $${i++}`); values.push(filters.ownerId); }
  if (filters.deliverableTypeId) { where.push(`d.deliverable_type_id = $${i++}`); values.push(filters.deliverableTypeId); }
  const { rows } = await pool.query(
    `SELECT d.*, d.due_date::text AS due_date, p.code AS project_code, p.name AS project_name,
            (SELECT COUNT(*)::int FROM media_deliverable_versions v WHERE v.deliverable_id = d.id) AS version_count
       FROM media_deliverables d JOIN media_projects p ON p.id = d.project_id
      WHERE ${where.join(" AND ")}
      ORDER BY d.due_date NULLS LAST, d.created_at LIMIT 500`,
    values,
  );
  return rows as MediaDeliverable[];
}

export async function getDeliverable(id: string): Promise<(MediaDeliverable & { versions: MediaDeliverableVersion[] }) | null> {
  const { rows } = await pool.query(
    `SELECT d.*, d.due_date::text AS due_date, p.code AS project_code, p.name AS project_name
       FROM media_deliverables d JOIN media_projects p ON p.id = d.project_id WHERE d.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const { rows: versions } = await pool.query<MediaDeliverableVersion>(
    `SELECT v.* FROM media_deliverable_versions v WHERE v.deliverable_id = $1 ORDER BY v.version_no DESC`,
    [id],
  );
  return { ...(rows[0] as MediaDeliverable), versions };
}

export async function createDeliverable(input: {
  projectId: string; deliverableTypeId: string; title: string; ownerId?: string | null;
  dueDate?: string | null; quantityTarget?: number | null; unit?: string | null; specNotes?: string; weight?: number;
}): Promise<MediaDeliverable> {
  const { rows } = await pool.query<MediaDeliverable>(
    `INSERT INTO media_deliverables (id, project_id, deliverable_type_id, title, owner_id, due_date, quantity_target, unit, spec_notes, weight)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, (SELECT default_unit FROM media_deliverable_types WHERE id = $3)),$9,COALESCE($10, (SELECT default_weight FROM media_deliverable_types WHERE id = $3), 1))
     RETURNING *`,
    [mid("md"), input.projectId, input.deliverableTypeId, input.title.trim(), input.ownerId ?? null,
     input.dueDate || null, input.quantityTarget ?? null, input.unit ?? null, input.specNotes ?? "", input.weight ?? null],
  );
  return rows[0];
}

export async function updateDeliverable(id: string, patch: Partial<{
  title: string; owner_id: string | null; due_date: string | null; quantity_target: number | null;
  quantity_delivered: number | null; unit: string | null; spec_notes: string; weight: number;
  status: MediaDeliverableStatus; social_status: string; social_post_url: string | null; mail_status: string;
}>): Promise<MediaDeliverable | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (fields.length === 0) {
    const { rows } = await pool.query<MediaDeliverable>(`SELECT * FROM media_deliverables WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  if (patch.status === "delivered") fields.push(`completed_at = NOW()`);
  if (patch.social_status === "posted") fields.push(`social_posted_at = NOW()`);
  if (patch.mail_status === "sent") fields.push(`mail_sent_at = NOW()`);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await pool.query<MediaDeliverable>(
    `UPDATE media_deliverables SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values,
  );
  return rows[0] ?? null;
}

export async function addDeliverableVersion(input: {
  deliverableId: string; driveUrl: string; note?: string; submittedBy: string;
}): Promise<MediaDeliverableVersion> {
  const { rows: last } = await pool.query<{ max: number | null }>(
    `SELECT MAX(version_no)::int AS max FROM media_deliverable_versions WHERE deliverable_id = $1`,
    [input.deliverableId],
  );
  const versionNo = (last[0].max ?? 0) + 1;
  const { rows } = await pool.query<MediaDeliverableVersion>(
    `INSERT INTO media_deliverable_versions (id, deliverable_id, version_no, drive_url, note, submitted_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [mid("mv"), input.deliverableId, versionNo, input.driveUrl.trim(), input.note ?? "", input.submittedBy],
  );
  await pool.query(`UPDATE media_deliverables SET status = 'in_review', updated_at = NOW() WHERE id = $1`, [input.deliverableId]);
  return rows[0];
}

export async function reviewDeliverableVersion(versionId: string, input: {
  outcome: "approved" | "changes_requested"; reviewedBy: string; comment?: string;
}): Promise<MediaDeliverableVersion | null> {
  const { rows } = await pool.query<MediaDeliverableVersion>(
    `UPDATE media_deliverable_versions SET review_status = $2, reviewed_by = $3, reviewed_at = NOW(), review_comment = $4
      WHERE id = $1 AND review_status = 'pending' RETURNING *`,
    [versionId, input.outcome, input.reviewedBy, input.comment ?? null],
  );
  const version = rows[0];
  if (!version) return null;
  await pool.query(
    `UPDATE media_deliverables SET status = $2, updated_at = NOW() WHERE id = $1`,
    [version.deliverable_id, input.outcome === "approved" ? "approved" : "changes_requested"],
  );
  return version;
}

export async function addDriveLink(input: { entityType: string; entityId: string; label: string; url: string; addedBy: string }) {
  const { rows } = await pool.query(
    `INSERT INTO media_drive_links (id, entity_type, entity_id, label, url, added_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [mid("ml"), input.entityType, input.entityId, input.label.trim(), input.url.trim(), input.addedBy],
  );
  return rows[0];
}

// ── Daily reporting (FR-2.x, D1/D2) ────────────────────────────────────────

async function ensureDraftReport(userId: string, reportDate: string): Promise<MediaDailyReport> {
  const { rows } = await pool.query<MediaDailyReport>(
    `INSERT INTO media_daily_reports (id, user_id, report_date)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, report_date) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING *`,
    [mid("mr"), userId, reportDate],
  );
  return rows[0];
}

export async function getReport(userId: string, reportDate: string): Promise<MediaDailyReport | null> {
  const { rows } = await pool.query<MediaDailyReport>(
    `SELECT r.*, r.report_date::text AS report_date FROM media_daily_reports r WHERE r.user_id = $1 AND r.report_date = $2`,
    [userId, reportDate],
  );
  if (!rows[0]) return null;
  return { ...rows[0], tasks: await listReportTasks(rows[0].id) };
}

export async function getReportById(id: string): Promise<MediaDailyReport | null> {
  const { rows } = await pool.query<MediaDailyReport>(`SELECT r.*, r.report_date::text AS report_date FROM media_daily_reports r WHERE r.id = $1`, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], tasks: await listReportTasks(id) };
}

async function listReportTasks(reportId: string): Promise<MediaReportTask[]> {
  const { rows } = await pool.query<MediaReportTask>(
    `SELECT t.*, p.name AS project_name, p.code AS project_code, c.name AS category_name, d.title AS deliverable_title
       FROM media_report_tasks t
       JOIN media_projects p ON p.id = t.project_id
       JOIN media_task_categories c ON c.id = t.task_category_id
       LEFT JOIN media_deliverables d ON d.id = t.deliverable_id
      WHERE t.daily_report_id = $1 ORDER BY t.sort_order, t.created_at`,
    [reportId],
  );
  return rows;
}

async function recomputeTotal(reportId: string) {
  await pool.query(
    `UPDATE media_daily_reports SET total_minutes = (SELECT COALESCE(SUM(minutes),0) FROM media_report_tasks WHERE daily_report_id = $1) WHERE id = $1`,
    [reportId],
  );
}

function computeMinutes(start?: string | null, end?: string | null, fallback?: number | null): number {
  if (start && end) {
    const [sh, sm] = start.split(":").map(Number);
    const [eh, em] = end.split(":").map(Number);
    return Math.max(0, eh * 60 + em - (sh * 60 + sm));
  }
  return Math.max(0, fallback ?? 0);
}

export async function addReportTask(userId: string, reportDate: string, input: {
  projectId: string; taskCategoryId: string; deliverableId?: string | null; description: string;
  startTime?: string | null; endTime?: string | null; durationMinutes?: number | null;
  quantity?: number | null; unit?: string | null; status?: string; blockerNote?: string | null; evidenceUrl?: string | null;
}): Promise<{ report: MediaDailyReport; task: MediaReportTask } | { error: string }> {
  const report = await ensureDraftReport(userId, reportDate);
  // BR-9: tasks editable only while draft/returned.
  if (!["draft", "returned"].includes(report.status)) return { error: "This report is already submitted. Ask a lead to return it before editing." };
  const minutes = computeMinutes(input.startTime, input.endTime, input.durationMinutes);
  // VR-1: end > start when both given.
  if (input.startTime && input.endTime && minutes <= 0) return { error: "End time must be after start time." };
  if (input.quantity != null && (input.quantity <= 0 || input.quantity > 100_000)) return { error: "Quantity must be between 1 and 100,000." }; // VR-3
  if (input.quantity != null && !input.unit) return { error: "Unit is required when quantity is set." };
  if (input.status === "blocked" && !input.blockerNote?.trim()) return { error: "Blocked tasks need a blocker note." }; // FR-2.8
  const { rows } = await pool.query<MediaReportTask>(
    `INSERT INTO media_report_tasks (id, daily_report_id, project_id, task_category_id, deliverable_id, description, start_time, end_time, minutes, quantity, unit, status, blocker_note, evidence_url, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, COALESCE((SELECT MAX(sort_order)+1 FROM media_report_tasks WHERE daily_report_id = $2), 0))
     RETURNING *`,
    [mid("mt"), report.id, input.projectId, input.taskCategoryId, input.deliverableId ?? null, input.description.trim(),
     input.startTime ?? null, input.endTime ?? null, minutes, input.quantity ?? null, input.unit ?? null,
     input.status ?? "done", input.blockerNote ?? null, input.evidenceUrl ?? null],
  );
  await recomputeTotal(report.id);
  const fresh = await getReportById(report.id);
  return { report: fresh!, task: rows[0] };
}

export async function updateReportTask(taskId: string, userId: string, patch: Partial<{
  description: string; start_time: string | null; end_time: string | null; minutes: number;
  quantity: number | null; unit: string | null; status: string; blocker_note: string | null;
  evidence_url: string | null; project_id: string; task_category_id: string; deliverable_id: string | null;
}>): Promise<MediaDailyReport | { error: string }> {
  const { rows } = await pool.query<{ daily_report_id: string; status: string; user_id: string }>(
    `SELECT t.daily_report_id, r.status, r.user_id FROM media_report_tasks t JOIN media_daily_reports r ON r.id = t.daily_report_id WHERE t.id = $1`,
    [taskId],
  );
  if (!rows[0]) return { error: "Task not found." };
  if (rows[0].user_id !== userId) return { error: "You can only edit your own tasks." };
  if (!["draft", "returned"].includes(rows[0].status)) return { error: "Report already submitted — ask a lead to return it first." };
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (fields.length > 0) {
    values.push(taskId);
    await pool.query(`UPDATE media_report_tasks SET ${fields.join(", ")} WHERE id = $${i}`, values);
    if (patch.start_time !== undefined || patch.end_time !== undefined) {
      await pool.query(
        `UPDATE media_report_tasks SET minutes = GREATEST(0,
           (EXTRACT(HOUR FROM end_time) * 60 + EXTRACT(MINUTE FROM end_time)) -
           (EXTRACT(HOUR FROM start_time) * 60 + EXTRACT(MINUTE FROM start_time)))::int
         WHERE id = $1 AND start_time IS NOT NULL AND end_time IS NOT NULL`,
        [taskId],
      );
    }
  }
  await recomputeTotal(rows[0].daily_report_id);
  return (await getReportById(rows[0].daily_report_id))!;
}

export async function deleteReportTask(taskId: string, userId: string): Promise<MediaDailyReport | { error: string }> {
  const { rows } = await pool.query<{ daily_report_id: string; status: string; user_id: string }>(
    `SELECT t.daily_report_id, r.status, r.user_id FROM media_report_tasks t JOIN media_daily_reports r ON r.id = t.daily_report_id WHERE t.id = $1`,
    [taskId],
  );
  if (!rows[0]) return { error: "Task not found." };
  if (rows[0].user_id !== userId) return { error: "You can only edit your own tasks." };
  if (!["draft", "returned"].includes(rows[0].status)) return { error: "Report already submitted — ask a lead to return it first." };
  await pool.query(`DELETE FROM media_report_tasks WHERE id = $1`, [taskId]);
  await recomputeTotal(rows[0].daily_report_id);
  return (await getReportById(rows[0].daily_report_id))!;
}

/** AUTO-13 flag rules, evaluated at submission (D2). Returns flag reasons. */
async function evaluateFlags(report: MediaDailyReport, sampleRate = 0.10): Promise<string[]> {
  const reasons: string[] = [];
  const tasks = report.tasks ?? [];
  const totalH = report.total_minutes / 60;
  if (totalH > 14) reasons.push(`Total hours unusually high (${totalH.toFixed(1)}h)`);
  if (totalH < 2 && tasks.length > 0) reasons.push(`Total hours unusually low (${totalH.toFixed(1)}h)`);
  for (const t of tasks) {
    if (t.deliverable_id && t.status === "done" && !t.evidence_url) {
      reasons.push("Deliverable-completion claim without an evidence link");
      break;
    }
  }
  const descs = tasks.map(t => t.description.trim().toLowerCase()).filter(Boolean);
  if (descs.length >= 3 && new Set(descs).size === 1) reasons.push("3+ identical task descriptions");
  const { rows: gap } = await pool.query<{ last: string | null }>(
    `SELECT MAX(report_date)::text AS last FROM media_daily_reports
      WHERE user_id = $1 AND report_date < $2 AND status NOT IN ('draft')`,
    [report.user_id, report.report_date],
  );
  if (gap[0].last) {
    const days = Math.round((new Date(report.report_date).getTime() - new Date(gap[0].last).getTime()) / 86400_000);
    if (days > 3) reasons.push(`First report after ${days - 1} missing days`);
  }
  if (reasons.length === 0 && Math.random() < sampleRate) reasons.push("Random quality sample");
  return reasons;
}

export async function submitReport(userId: string, reportDate: string, note?: string): Promise<MediaDailyReport | { error: string }> {
  const report = await getReport(userId, reportDate);
  if (!report) return { error: "Nothing to submit — log at least one task first." };
  if (!["draft", "returned"].includes(report.status)) return { error: "This report was already submitted." }; // AC-2 via unique + state
  if ((report.tasks ?? []).length === 0) return { error: "Log at least one task before submitting." };
  const reasons = await evaluateFlags(report);
  const status = reasons.length > 0 ? "flagged" : "submitted";
  const { rows } = await pool.query<MediaDailyReport>(
    `UPDATE media_daily_reports SET status = $2, submitted_at = NOW(), note = $3, flagged_reason = $4 WHERE id = $1 RETURNING *`,
    [report.id, status, note?.trim() ?? "", reasons.length ? reasons.join("; ") : null],
  );
  return { ...rows[0], tasks: report.tasks };
}

export async function reviewReport(reportId: string, input: {
  action: "approve" | "return" | "flag"; reviewedBy: string; comment?: string;
}): Promise<MediaDailyReport | null> {
  const status = input.action === "approve" ? "approved" : input.action === "return" ? "returned" : "flagged";
  const { rows } = await pool.query<MediaDailyReport>(
    `UPDATE media_daily_reports
        SET status = $2, reviewed_by = $3, reviewed_at = NOW(), review_comment = $4,
            flagged_reason = CASE WHEN $2 = 'flagged' THEN COALESCE($4, flagged_reason) ELSE flagged_reason END
      WHERE id = $1 AND status IN ('submitted','flagged','returned') RETURNING *`,
    [reportId, status, input.reviewedBy, input.comment ?? null],
  );
  if (!rows[0]) return null;
  return { ...rows[0], tasks: await listReportTasks(reportId) };
}

export async function listReportsForDate(reportDate: string): Promise<Array<MediaDailyReport & { user_name: string }>> {
  const { rows } = await pool.query(
    `SELECT r.*, r.report_date::text AS report_date, u.full_name AS user_name FROM media_daily_reports r JOIN users u ON u.id = r.user_id
      WHERE r.report_date = $1 ORDER BY r.submitted_at NULLS LAST`,
    [reportDate],
  );
  return rows as Array<MediaDailyReport & { user_name: string }>;
}

export async function listMyReports(userId: string, limit = 30): Promise<MediaDailyReport[]> {
  const { rows } = await pool.query<MediaDailyReport>(
    `SELECT r.*, r.report_date::text AS report_date FROM media_daily_reports r WHERE r.user_id = $1 ORDER BY r.report_date DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

/** Review queue (J4): flagged + submitted, flagged first, oldest first. */
export async function listReviewQueue(): Promise<Array<MediaDailyReport & { user_name: string }>> {
  const { rows } = await pool.query(
    `SELECT r.*, r.report_date::text AS report_date, u.full_name AS user_name FROM media_daily_reports r JOIN users u ON u.id = r.user_id
      WHERE r.status IN ('flagged','submitted')
      ORDER BY (r.status = 'flagged') DESC, r.submitted_at ASC LIMIT 100`,
  );
  return rows as Array<MediaDailyReport & { user_name: string }>;
}

// ── Team / dashboard helpers ───────────────────────────────────────────────

export async function listMediaTeamUsers(): Promise<Array<{ id: string; full_name: string; role: string; email: string }>> {
  const { rows } = await pool.query(
    `SELECT id, full_name, role, email FROM users WHERE team = 'media' ORDER BY full_name`,
  );
  return rows;
}

export async function getMediaDashboard(scopeUserId: string | null) {
  const today = new Date().toISOString().slice(0, 10);
  const teamUsers = await listMediaTeamUsers();
  const reportsToday = await listReportsForDate(today);
  const submittedIds = new Set(reportsToday.filter(r => !["draft"].includes(r.status)).map(r => r.user_id));
  const pendingReports = teamUsers
    .filter(u => ["admin", "sub_admin", "user"].includes(u.role))
    .filter(u => !submittedIds.has(u.id))
    .map(u => ({ id: u.id, full_name: u.full_name }));

  const { rows: dueSoon } = await pool.query(
    `SELECT d.id, d.title, d.due_date::text AS due_date, d.status, d.owner_id, u.full_name AS owner_name, p.code AS project_code, p.name AS project_name, p.id AS project_id,
            (d.due_date < CURRENT_DATE) AS overdue
       FROM media_deliverables d
       JOIN media_projects p ON p.id = d.project_id
       LEFT JOIN users u ON u.id = d.owner_id
      WHERE d.status NOT IN ('delivered','not_required','cancelled') AND d.due_date IS NOT NULL
        AND d.due_date <= CURRENT_DATE + INTERVAL '14 days'
        ${scopeUserId ? "AND (d.owner_id = $1 OR p.owner_id = $1)" : ""}
      ORDER BY d.due_date ASC LIMIT 30`,
    scopeUserId ? [scopeUserId] : [],
  );

  const runningProjects = await listMediaProjects({
    ...(scopeUserId ? { forUserId: scopeUserId } : {}),
  });
  const running = runningProjects.filter(p => ["planning", "in_production", "in_review", "approved"].includes(p.status)).slice(0, 12);

  const queue = scopeUserId ? [] : await listReviewQueue();

  const { rows: recentActivity } = await pool.query(
    `SELECT a.action, a.entity_type, a.occurred_at, u.full_name AS actor_name, p.name AS project_name
       FROM media_audit_logs a
       LEFT JOIN users u ON u.id = a.actor_id
       LEFT JOIN media_projects p ON p.id = a.project_id
      ORDER BY a.occurred_at DESC LIMIT 20`,
  );

  return {
    today,
    teamSize: teamUsers.length,
    pendingReports,
    submittedTodayCount: submittedIds.size,
    deliverablesDueSoon: dueSoon,
    runningProjects: running,
    reviewQueue: queue.slice(0, 10),
    reviewQueueCount: queue.length,
    recentActivity,
  };
}

// ── Notifications + automations (AUTO-1 / AUTO-4 / BR-4) ──────────────────

export async function notify(userId: string, kind: string, title: string, body = "", entity?: { type: string; id: string }) {
  await pool.query(
    `INSERT INTO media_notifications (id, user_id, kind, title, body, entity_type, entity_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [mid("mn"), userId, kind, title, body, entity?.type ?? null, entity?.id ?? null],
  );
}

export async function listNotifications(userId: string, limit = 30): Promise<MediaNotification[]> {
  const { rows } = await pool.query<MediaNotification>(
    `SELECT * FROM media_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

export async function markNotificationsRead(userId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    await pool.query(`UPDATE media_notifications SET is_read = true WHERE user_id = $1`, [userId]);
    return;
  }
  await pool.query(`UPDATE media_notifications SET is_read = true WHERE user_id = $1 AND id = ANY($2)`, [userId, ids]);
}

async function alreadyNotified(userId: string, kind: string, entityId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM media_notifications WHERE user_id = $1 AND kind = $2 AND entity_id = $3 LIMIT 1`,
    [userId, kind, entityId],
  );
  return rows.length > 0;
}

/** IST wall clock helper (media crew operates in IST). */
function istNow(): { date: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: hour * 60 + parseInt(get("minute"), 10), weekday: wd };
}

/**
 * Runs every server tick (5 min). Covers:
 *  - BR-4 / AC-4: submitted, unflagged reports auto-approve at +48h (audited).
 *  - AUTO-1: 17:30 IST nudge + 20:00 second nudge for missing reports
 *    (working days only — Sundays are skipped).
 *  - AUTO-4 (subset): flagged reports pending > 24h remind media leads/admins.
 */
export async function runMediaAutomations(): Promise<{ autoApproved: number; nudged: number }> {
  // 48h auto-approve (D2).
  const { rows: approved } = await pool.query<{ id: string; user_id: string }>(
    `UPDATE media_daily_reports SET status = 'auto_approved', reviewed_at = NOW()
      WHERE status = 'submitted' AND submitted_at < NOW() - INTERVAL '48 hours'
      RETURNING id, user_id`,
  );
  for (const r of approved) {
    await mediaAudit({ actorId: null, action: "report.auto_approved", entityType: "daily_report", entityId: r.id });
  }

  const { date, minutes, weekday } = istNow();
  let nudged = 0;
  if (weekday !== 0) { // AUTO-1, skip Sundays
    const slots: Array<[string, number]> = [["report_reminder", 17 * 60 + 30], ["report_reminder_2", 20 * 60]];
    for (const [kind, at] of slots) {
      if (minutes < at) continue;
      const team = await listMediaTeamUsers();
      const reports = await listReportsForDate(date);
      const submitted = new Set(reports.filter(r => r.status !== "draft").map(r => r.user_id));
      for (const u of team) {
        if (!["admin", "sub_admin", "user"].includes(u.role)) continue;
        if (submitted.has(u.id)) continue;
        if (await alreadyNotified(u.id, kind, date)) continue;
        await notify(u.id, kind, "Daily report pending", `Your Media Ops report for ${date} hasn't been submitted yet.`, { type: "daily_report", id: date });
        nudged++;
      }
    }
  }

  // AUTO-4 subset: flagged reports older than 24h → remind leads + admins once per report.
  const { rows: staleFlags } = await pool.query<{ id: string; user_name: string }>(
    `SELECT r.id, u.full_name AS user_name FROM media_daily_reports r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'flagged' AND r.submitted_at < NOW() - INTERVAL '24 hours'`,
  );
  if (staleFlags.length > 0) {
    const reviewers = (await listMediaTeamUsers()).filter(u => u.role === "admin" || u.role === "sub_admin");
    for (const f of staleFlags) {
      for (const rv of reviewers) {
        if (await alreadyNotified(rv.id, "flag_pending", f.id)) continue;
        await notify(rv.id, "flag_pending", "Flagged report awaiting review", `${f.user_name}'s report has been flagged for over 24h.`, { type: "daily_report", id: f.id });
      }
    }
  }

  return { autoApproved: approved.length, nudged };
}
