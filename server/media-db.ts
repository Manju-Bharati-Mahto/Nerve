/**
 * PU MediaOps — Media Crew department data layer (PRD: PU_MediaOps_PRD v1.0).
 *
 * Phase-1 scope: daily reporting with multi-task cards (M3), production
 * tracker with the four workbook categories + deliverable checklists + social
 * posting flags (M4), and the masters that drive every dropdown (M10).
 * Media files never live here — deliverables store Google Drive LINKS only.
 *
 * Tables are namespaced media_* alongside the branding_/outreach_ families.
 */
import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

function newId(prefix: string) {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

// ── Types ──────────────────────────────────────────────────────────────────

export const MEDIA_PROJECT_CATEGORIES = [
  "academic_cultural",
  "educational_tour",
  "branding_content",
  "monthly",
] as const;
export type MediaProjectCategory = (typeof MEDIA_PROJECT_CATEGORIES)[number];

export const MEDIA_PROJECT_STATUSES = ["upcoming", "running", "completed", "archived"] as const;
export type MediaProjectStatus = (typeof MEDIA_PROJECT_STATUSES)[number];

export const MEDIA_DELIVERABLE_STATUSES = ["pending", "in_progress", "done"] as const;
export type MediaDeliverableStatus = (typeof MEDIA_DELIVERABLE_STATUSES)[number];

export const MEDIA_REPORT_STATUSES = ["draft", "submitted", "approved", "sent_back"] as const;
export type MediaReportStatus = (typeof MEDIA_REPORT_STATUSES)[number];

export interface MediaMaster {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}

export interface MediaDeliverable {
  id: string;
  project_id: string;
  type_id: string;
  status: MediaDeliverableStatus;
  drive_link: string;
  quantity: number | null;
  assigned_user_ids: string[];
  completed_at: string | null;
}

export interface MediaSocialPost {
  id: string;
  project_id: string;
  platform: string;
  is_posted: boolean;
  post_link: string;
  posted_by: string | null;
  posted_at: string | null;
}

export interface MediaProject {
  id: string;
  category: MediaProjectCategory;
  name: string;
  month: string;
  faculty_or_department: string;
  event_type: string;
  organization: string;
  city: string;
  occasion: string;
  shoot_type: string;
  creative_concept: string;
  hooks: string;
  output: string;
  date_label: string;
  start_date: string | null;
  end_date: string | null;
  status: MediaProjectStatus;
  remarks: string;
  academic_year: string;
  created_by: string | null;
  member_ids: string[];
  deliverables: MediaDeliverable[];
  social_posts: MediaSocialPost[];
  created_at: string;
  updated_at: string;
}

export interface MediaReportTask {
  id: string;
  report_id: string;
  project_id: string | null;
  task_category_id: string;
  description: string;
  start_time: string; // "HH:MM"
  end_time: string;   // "HH:MM"
  hours: number;
  progress_before: number | null;
  progress_after: number | null;
  deliverable_type_id: string | null;
  quantity: number | null;
  evidence_link: string;
  sort_order: number;
}

export interface MediaDailyReport {
  id: string;
  user_id: string;
  report_date: string; // YYYY-MM-DD
  summary: string;
  blockers: string;
  tomorrow_priority: string;
  status: MediaReportStatus;
  submitted_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approver_comment: string;
  total_hours: number;
  tasks: MediaReportTask[];
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

// Appendix B seed values. Editable by Admin afterwards; seeding is idempotent
// (insert-only when the master table is empty).
const SEED_TASK_CATEGORIES = [
  "Shoot", "Video Edit", "Photo Edit", "Design", "Scripting / Writing",
  "Voice-over", "Planning", "Coordination", "Travel", "Meeting", "Other",
];
const SEED_DELIVERABLE_TYPES = [
  "Photos", "Videos", "Aftermovie", "Highlight Reel", "Reels", "Outreach Content",
  "Continuous Recording", "Selected Raw Data", "Drone Footage", "Poster",
  "Thumbnail", "Final Output",
];

// Default deliverable checklist per category (Appendix B) — auto-attached as
// Pending rows on project creation so trackers start complete (FR-PR-01).
const DEFAULT_DELIVERABLES: Record<MediaProjectCategory, string[]> = {
  academic_cultural: ["Photos", "Aftermovie", "Continuous Recording", "Selected Raw Data", "Outreach Content"],
  educational_tour: ["Photos", "Aftermovie", "Continuous Recording", "Selected Raw Data", "Outreach Content"],
  branding_content: ["Final Output", "Thumbnail"],
  monthly: ["Photos", "Videos"],
};

export async function bootstrapMediaDatabase() {
  // The built-in teams seed only runs on an empty teams table, so existing
  // deployments need this explicit idempotent upsert for the new department.
  await pool.query(`
    INSERT INTO teams (id, name, color, is_built_in)
    VALUES ('media', 'Media Crew', 'green', true)
    ON CONFLICT (id) DO NOTHING
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_task_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_deliverable_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      is_active BOOLEAN NOT NULL DEFAULT true,
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_projects (
      id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('academic_cultural', 'educational_tour', 'branding_content', 'monthly')),
      name TEXT NOT NULL,
      month TEXT NOT NULL DEFAULT '',
      faculty_or_department TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT '',
      organization TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      occasion TEXT NOT NULL DEFAULT '',
      shoot_type TEXT NOT NULL DEFAULT '',
      creative_concept TEXT NOT NULL DEFAULT '',
      hooks TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      date_label TEXT NOT NULL DEFAULT '',
      start_date DATE,
      end_date DATE,
      status TEXT NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'running', 'completed', 'archived')),
      remarks TEXT NOT NULL DEFAULT '',
      academic_year TEXT NOT NULL DEFAULT '2026-27',
      created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      member_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_projects_cat_idx ON media_projects (category, status)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_deliverables (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
      type_id TEXT NOT NULL REFERENCES media_deliverable_types(id),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
      drive_link TEXT NOT NULL DEFAULT '',
      quantity INTEGER,
      assigned_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      completed_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_social_posts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES media_projects(id) ON DELETE CASCADE,
      platform TEXT NOT NULL DEFAULT '',
      is_posted BOOLEAN NOT NULL DEFAULT false,
      post_link TEXT NOT NULL DEFAULT '',
      posted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      posted_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_daily_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_date DATE NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      blockers TEXT NOT NULL DEFAULT '',
      tomorrow_priority TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'sent_back')),
      submitted_at TIMESTAMPTZ,
      approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      approved_at TIMESTAMPTZ,
      approver_comment TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, report_date)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS media_report_tasks (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES media_daily_reports(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES media_projects(id) ON DELETE SET NULL,
      task_category_id TEXT NOT NULL REFERENCES media_task_categories(id),
      description TEXT NOT NULL DEFAULT '',
      start_time TEXT NOT NULL DEFAULT '',
      end_time TEXT NOT NULL DEFAULT '',
      hours NUMERIC(5,1) NOT NULL DEFAULT 0,
      progress_before INTEGER,
      progress_after INTEGER,
      deliverable_type_id TEXT REFERENCES media_deliverable_types(id),
      quantity INTEGER,
      evidence_link TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS media_report_tasks_report_idx ON media_report_tasks (report_id)`);

  await seedMaster("media_task_categories", "mtc", SEED_TASK_CATEGORIES);
  await seedMaster("media_deliverable_types", "mdt", SEED_DELIVERABLE_TYPES);
}

async function seedMaster(table: string, prefix: string, names: string[]) {
  const { rows } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`);
  if (rows[0].count > 0) return;
  for (let i = 0; i < names.length; i++) {
    await pool.query(
      `INSERT INTO ${table} (id, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING`,
      [newId(prefix), names[i], i],
    );
  }
}

// ── Masters ────────────────────────────────────────────────────────────────

export async function listMediaMasters(): Promise<{ task_categories: MediaMaster[]; deliverable_types: MediaMaster[] }> {
  const [tc, dt] = await Promise.all([
    pool.query<MediaMaster>(`SELECT * FROM media_task_categories ORDER BY sort_order, name`),
    pool.query<MediaMaster>(`SELECT * FROM media_deliverable_types ORDER BY sort_order, name`),
  ]);
  return { task_categories: tc.rows, deliverable_types: dt.rows };
}

const MASTER_TABLES = {
  task_category: "media_task_categories",
  deliverable_type: "media_deliverable_types",
} as const;
export type MediaMasterKind = keyof typeof MASTER_TABLES;

export async function createMediaMaster(kind: MediaMasterKind, name: string): Promise<MediaMaster> {
  const table = MASTER_TABLES[kind];
  const { rows } = await pool.query<MediaMaster>(
    `INSERT INTO ${table} (id, name, sort_order)
     VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM ${table}), 0))
     RETURNING *`,
    [newId(kind === "task_category" ? "mtc" : "mdt"), name.trim()],
  );
  return rows[0];
}

export async function updateMediaMaster(
  kind: MediaMasterKind, id: string, patch: { name?: string; is_active?: boolean },
): Promise<MediaMaster | null> {
  const table = MASTER_TABLES[kind];
  const { rows } = await pool.query<MediaMaster>(
    `UPDATE ${table} SET
       name = COALESCE($2, name),
       is_active = COALESCE($3, is_active)
     WHERE id = $1 RETURNING *`,
    [id, patch.name?.trim() ?? null, patch.is_active ?? null],
  );
  return rows[0] ?? null;
}

// ── Projects ───────────────────────────────────────────────────────────────

export interface MediaProjectInput {
  category: MediaProjectCategory;
  name: string;
  month?: string;
  faculty_or_department?: string;
  event_type?: string;
  organization?: string;
  city?: string;
  occasion?: string;
  shoot_type?: string;
  creative_concept?: string;
  hooks?: string;
  output?: string;
  date_label?: string;
  start_date?: string | null;
  end_date?: string | null;
  status?: MediaProjectStatus;
  remarks?: string;
  member_ids?: string[];
}

function mapProjectRow(row: Record<string, unknown>): Omit<MediaProject, "deliverables" | "social_posts"> {
  const dateStr = (v: unknown) =>
    v == null ? null : typeof v === "string" ? v : new Date(v as string).toISOString().slice(0, 10);
  return {
    ...(row as unknown as MediaProject),
    start_date: dateStr(row.start_date),
    end_date: dateStr(row.end_date),
    member_ids: Array.isArray(row.member_ids) ? (row.member_ids as string[]) : [],
  };
}

async function attachChildren(projects: Omit<MediaProject, "deliverables" | "social_posts">[]): Promise<MediaProject[]> {
  if (projects.length === 0) return [];
  const ids = projects.map(p => p.id);
  const [dels, socials] = await Promise.all([
    pool.query<MediaDeliverable>(`SELECT * FROM media_deliverables WHERE project_id = ANY($1) ORDER BY id`, [ids]),
    pool.query<MediaSocialPost>(`SELECT * FROM media_social_posts WHERE project_id = ANY($1) ORDER BY id`, [ids]),
  ]);
  const delByProject = new Map<string, MediaDeliverable[]>();
  for (const d of dels.rows) {
    const arr = delByProject.get(d.project_id) ?? [];
    arr.push({ ...d, assigned_user_ids: Array.isArray(d.assigned_user_ids) ? d.assigned_user_ids : [] });
    delByProject.set(d.project_id, arr);
  }
  const socialByProject = new Map<string, MediaSocialPost[]>();
  for (const s of socials.rows) {
    const arr = socialByProject.get(s.project_id) ?? [];
    arr.push(s);
    socialByProject.set(s.project_id, arr);
  }
  return projects.map(p => ({
    ...p,
    deliverables: delByProject.get(p.id) ?? [],
    social_posts: socialByProject.get(p.id) ?? [],
  }));
}

export async function listMediaProjects(category?: MediaProjectCategory): Promise<MediaProject[]> {
  const { rows } = category
    ? await pool.query(`SELECT * FROM media_projects WHERE category = $1 ORDER BY created_at DESC`, [category])
    : await pool.query(`SELECT * FROM media_projects ORDER BY created_at DESC`);
  return attachChildren(rows.map(mapProjectRow));
}

export async function getMediaProject(id: string): Promise<MediaProject | null> {
  const { rows } = await pool.query(`SELECT * FROM media_projects WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const [p] = await attachChildren([mapProjectRow(rows[0])]);
  return p;
}

export async function createMediaProject(input: MediaProjectInput, createdBy: string): Promise<MediaProject> {
  const id = newId("mp");
  await pool.query(
    `INSERT INTO media_projects
       (id, category, name, month, faculty_or_department, event_type, organization, city, occasion,
        shoot_type, creative_concept, hooks, output, date_label, start_date, end_date, status, remarks,
        created_by, member_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb)`,
    [
      id, input.category, input.name.trim(), input.month ?? "", input.faculty_or_department ?? "",
      input.event_type ?? "", input.organization ?? "", input.city ?? "", input.occasion ?? "",
      input.shoot_type ?? "", input.creative_concept ?? "", input.hooks ?? "", input.output ?? "",
      input.date_label ?? "", input.start_date || null, input.end_date || null,
      input.status ?? "upcoming", input.remarks ?? "", createdBy, JSON.stringify(input.member_ids ?? []),
    ],
  );
  // FR-PR-01: the category's default deliverable checklist auto-attaches as
  // Pending rows so trackers start complete.
  const { rows: types } = await pool.query<MediaMaster>(
    `SELECT * FROM media_deliverable_types WHERE name = ANY($1)`,
    [DEFAULT_DELIVERABLES[input.category]],
  );
  for (const t of types) {
    await pool.query(
      `INSERT INTO media_deliverables (id, project_id, type_id) VALUES ($1, $2, $3)`,
      [newId("md"), id, t.id],
    );
  }
  return (await getMediaProject(id))!;
}

export async function updateMediaProject(id: string, patch: Partial<MediaProjectInput>): Promise<MediaProject | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const scalarKeys = [
    "name", "month", "faculty_or_department", "event_type", "organization", "city", "occasion",
    "shoot_type", "creative_concept", "hooks", "output", "date_label", "status", "remarks",
  ] as const;
  for (const k of scalarKeys) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${i++}`); values.push(patch[k]); }
  }
  for (const k of ["start_date", "end_date"] as const) {
    if (patch[k] !== undefined) { fields.push(`${k} = $${i++}`); values.push(patch[k] || null); }
  }
  if (patch.member_ids !== undefined) { fields.push(`member_ids = $${i++}::jsonb`); values.push(JSON.stringify(patch.member_ids)); }
  if (fields.length === 0) return getMediaProject(id);
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rowCount } = await pool.query(
    `UPDATE media_projects SET ${fields.join(", ")} WHERE id = $${i}`,
    values,
  );
  if (rowCount === 0) return null;
  return getMediaProject(id);
}

export async function deleteMediaProject(id: string): Promise<void> {
  await pool.query(`DELETE FROM media_projects WHERE id = $1`, [id]);
}

// ── Deliverables & social posts ────────────────────────────────────────────

export async function addMediaDeliverable(projectId: string, typeId: string): Promise<MediaDeliverable | null> {
  const { rows } = await pool.query<MediaDeliverable>(
    `INSERT INTO media_deliverables (id, project_id, type_id) VALUES ($1, $2, $3) RETURNING *`,
    [newId("md"), projectId, typeId],
  );
  return rows[0] ?? null;
}

export async function getMediaDeliverable(id: string): Promise<MediaDeliverable | null> {
  const { rows } = await pool.query<MediaDeliverable>(`SELECT * FROM media_deliverables WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  return { ...rows[0], assigned_user_ids: Array.isArray(rows[0].assigned_user_ids) ? rows[0].assigned_user_ids : [] };
}

export async function updateMediaDeliverable(
  id: string,
  patch: { status?: MediaDeliverableStatus; drive_link?: string; quantity?: number | null; assigned_user_ids?: string[] },
): Promise<MediaDeliverable | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.status !== undefined) {
    fields.push(`status = $${i++}`); values.push(patch.status);
    // Marking Done stamps the completion date (FR-PR-04); leaving Done clears it.
    fields.push(patch.status === "done" ? `completed_at = COALESCE(completed_at, NOW())` : `completed_at = NULL`);
  }
  if (patch.drive_link !== undefined) { fields.push(`drive_link = $${i++}`); values.push(patch.drive_link.trim()); }
  if (patch.quantity !== undefined) { fields.push(`quantity = $${i++}`); values.push(patch.quantity); }
  if (patch.assigned_user_ids !== undefined) { fields.push(`assigned_user_ids = $${i++}::jsonb`); values.push(JSON.stringify(patch.assigned_user_ids)); }
  if (fields.length === 0) return getMediaDeliverable(id);
  values.push(id);
  const { rows } = await pool.query<MediaDeliverable>(
    `UPDATE media_deliverables SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  if (!rows[0]) return null;
  return { ...rows[0], assigned_user_ids: Array.isArray(rows[0].assigned_user_ids) ? rows[0].assigned_user_ids : [] };
}

export async function deleteMediaDeliverable(id: string): Promise<void> {
  await pool.query(`DELETE FROM media_deliverables WHERE id = $1`, [id]);
}

export async function addMediaSocialPost(projectId: string, platform: string): Promise<MediaSocialPost> {
  const { rows } = await pool.query<MediaSocialPost>(
    `INSERT INTO media_social_posts (id, project_id, platform) VALUES ($1, $2, $3) RETURNING *`,
    [newId("msp"), projectId, platform.trim()],
  );
  return rows[0];
}

export async function updateMediaSocialPost(
  id: string,
  patch: { is_posted?: boolean; post_link?: string; platform?: string },
  actorId: string,
): Promise<MediaSocialPost | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (patch.is_posted !== undefined) {
    fields.push(`is_posted = $${i++}`); values.push(patch.is_posted);
    if (patch.is_posted) {
      fields.push(`posted_by = $${i++}`); values.push(actorId);
      fields.push(`posted_at = COALESCE(posted_at, NOW())`);
    } else {
      fields.push(`posted_by = NULL`, `posted_at = NULL`);
    }
  }
  if (patch.post_link !== undefined) { fields.push(`post_link = $${i++}`); values.push(patch.post_link.trim()); }
  if (patch.platform !== undefined) { fields.push(`platform = $${i++}`); values.push(patch.platform.trim()); }
  if (fields.length === 0) {
    const { rows } = await pool.query<MediaSocialPost>(`SELECT * FROM media_social_posts WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  values.push(id);
  const { rows } = await pool.query<MediaSocialPost>(
    `UPDATE media_social_posts SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function deleteMediaSocialPost(id: string): Promise<void> {
  await pool.query(`DELETE FROM media_social_posts WHERE id = $1`, [id]);
}

// ── Daily reports ──────────────────────────────────────────────────────────

export interface MediaTaskInput {
  project_id?: string | null;
  task_category_id: string;
  description: string;
  start_time: string;
  end_time: string;
  progress_before?: number | null;
  progress_after?: number | null;
  deliverable_type_id?: string | null;
  quantity?: number | null;
  evidence_link?: string;
}

/** "HH:MM" pair → decimal hours to 0.1h; 0 when unparseable or end <= start. */
export function taskHours(start: string, end: string): number {
  const m = (s: string) => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!match) return null;
    return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  };
  const a = m(start), b = m(end);
  if (a == null || b == null || b <= a) return 0;
  return Math.round(((b - a) / 60) * 10) / 10;
}

async function attachTasks(reports: Omit<MediaDailyReport, "tasks" | "total_hours">[]): Promise<MediaDailyReport[]> {
  if (reports.length === 0) return [];
  const ids = reports.map(r => r.id);
  const { rows } = await pool.query<MediaReportTask>(
    `SELECT * FROM media_report_tasks WHERE report_id = ANY($1) ORDER BY sort_order, id`,
    [ids],
  );
  const byReport = new Map<string, MediaReportTask[]>();
  for (const t of rows) {
    const arr = byReport.get(t.report_id) ?? [];
    arr.push({ ...t, hours: Number(t.hours) });
    byReport.set(t.report_id, arr);
  }
  return reports.map(r => {
    const tasks = byReport.get(r.id) ?? [];
    return {
      ...r,
      report_date: typeof r.report_date === "string" ? r.report_date : new Date(r.report_date as unknown as string).toISOString().slice(0, 10),
      tasks,
      total_hours: Math.round(tasks.reduce((s, t) => s + t.hours, 0) * 10) / 10,
    };
  });
}

export async function getMediaReport(userId: string, reportDate: string): Promise<MediaDailyReport | null> {
  const { rows } = await pool.query(
    `SELECT * FROM media_daily_reports WHERE user_id = $1 AND report_date = $2`,
    [userId, reportDate],
  );
  if (!rows[0]) return null;
  const [r] = await attachTasks(rows as Omit<MediaDailyReport, "tasks" | "total_hours">[]);
  return r;
}

export async function getMediaReportById(id: string): Promise<MediaDailyReport | null> {
  const { rows } = await pool.query(`SELECT * FROM media_daily_reports WHERE id = $1`, [id]);
  if (!rows[0]) return null;
  const [r] = await attachTasks(rows as Omit<MediaDailyReport, "tasks" | "total_hours">[]);
  return r;
}

export async function listMediaReportsByDate(reportDate: string): Promise<MediaDailyReport[]> {
  const { rows } = await pool.query(
    `SELECT * FROM media_daily_reports WHERE report_date = $1 ORDER BY created_at`,
    [reportDate],
  );
  return attachTasks(rows as Omit<MediaDailyReport, "tasks" | "total_hours">[]);
}

/**
 * Upserts the caller's report for a date (FR-DR-01: exactly one per user per
 * day) and replaces its task cards wholesale — the client always sends the
 * full card list, which keeps ordering and deletion trivial.
 * Only draft/sent_back (or still-unapproved submitted) reports may be edited.
 */
export async function upsertMediaReport(
  userId: string,
  reportDate: string,
  input: { summary?: string; blockers?: string; tomorrow_priority?: string; tasks: MediaTaskInput[] },
): Promise<MediaDailyReport> {
  const existing = await getMediaReport(userId, reportDate);
  if (existing && existing.status === "approved") {
    throw new Error("This report is approved and locked.");
  }
  let reportId = existing?.id;
  if (!reportId) {
    reportId = newId("mdr");
    await pool.query(
      `INSERT INTO media_daily_reports (id, user_id, report_date, summary, blockers, tomorrow_priority)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [reportId, userId, reportDate, input.summary ?? "", input.blockers ?? "", input.tomorrow_priority ?? ""],
    );
  } else {
    await pool.query(
      `UPDATE media_daily_reports SET
         summary = $2, blockers = $3, tomorrow_priority = $4,
         status = CASE WHEN status = 'sent_back' THEN 'draft' ELSE status END,
         updated_at = NOW()
       WHERE id = $1`,
      [reportId, input.summary ?? "", input.blockers ?? "", input.tomorrow_priority ?? ""],
    );
  }
  await pool.query(`DELETE FROM media_report_tasks WHERE report_id = $1`, [reportId]);
  for (let idx = 0; idx < input.tasks.length; idx++) {
    const t = input.tasks[idx];
    await pool.query(
      `INSERT INTO media_report_tasks
         (id, report_id, project_id, task_category_id, description, start_time, end_time, hours,
          progress_before, progress_after, deliverable_type_id, quantity, evidence_link, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        newId("mrt"), reportId, t.project_id || null, t.task_category_id, t.description.trim(),
        t.start_time, t.end_time, taskHours(t.start_time, t.end_time),
        t.progress_before ?? null, t.progress_after ?? null,
        t.deliverable_type_id || null, t.quantity ?? null, (t.evidence_link ?? "").trim(), idx,
      ],
    );
  }
  return (await getMediaReport(userId, reportDate))!;
}

export async function submitMediaReport(userId: string, reportDate: string): Promise<MediaDailyReport | null> {
  const { rowCount } = await pool.query(
    `UPDATE media_daily_reports SET status = 'submitted', submitted_at = NOW(), updated_at = NOW()
     WHERE user_id = $1 AND report_date = $2 AND status IN ('draft', 'sent_back', 'submitted')`,
    [userId, reportDate],
  );
  if (rowCount === 0) return null;
  return getMediaReport(userId, reportDate);
}

export async function reviewMediaReport(
  reportId: string,
  approverId: string,
  action: "approve" | "send_back",
  comment: string,
): Promise<MediaDailyReport | null> {
  const { rowCount } = await pool.query(
    action === "approve"
      ? `UPDATE media_daily_reports SET status = 'approved', approved_by = $2, approved_at = NOW(),
           approver_comment = $3, updated_at = NOW() WHERE id = $1 AND status = 'submitted'`
      : `UPDATE media_daily_reports SET status = 'sent_back', approved_by = $2, approved_at = NULL,
           approver_comment = $3, updated_at = NOW() WHERE id = $1 AND status = 'submitted'`,
    [reportId, approverId, comment],
  );
  if (rowCount === 0) return null;
  return getMediaReportById(reportId);
}
