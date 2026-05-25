import { randomBytes } from "node:crypto";
import { pool } from "./db.js";

function generateId(prefix: string) {
  return `${prefix}-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface WorkCategory {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  sub_categories: WorkSubCategory[];
}

export interface WorkSubCategory {
  id: string;
  category_id: string;
  name: string;
  sort_order: number;
  is_others: boolean;
  created_at: string;
}

export interface DailyReport {
  id: string;
  user_id: string;
  report_date: string;
  is_locked: boolean;
  submitted_at: string | null;
  created_at: string;
  rows: DailyReportRow[];
  user_name?: string;
  user_email?: string;
}

export type StopwatchStatus = 'idle' | 'running' | 'paused' | 'finished';

export interface DailyReportRow {
  id: string;
  report_id: string;
  sr_no: number;
  type_of_work: string;
  sub_category: string;
  specific_work: string;
  time_taken: string;
  collaborative_colleagues: string[];
  created_at: string;
  stopwatch_status: StopwatchStatus;
  elapsed_seconds: number;
  stopwatch_started_at: string | null;
  carried_over_from_row_id: string | null;
  /** Set by the client when the row transitions to paused or finished.
   *  Null while running/idle, and reset to null when a row is carried over
   *  to the next day (it's freshly active for that day). */
  last_paused_at: string | null;
}

export interface SaveRowInput {
  sr_no: number;
  type_of_work: string;
  sub_category: string;
  specific_work: string;
  time_taken: string;
  collaborative_colleagues: string[];
  stopwatch_status?: StopwatchStatus;
  elapsed_seconds?: number;
  stopwatch_started_at?: string | null;
  carried_over_from_row_id?: string | null;
  last_paused_at?: string | null;
}

export interface KraParameter {
  id: string;
  name: string;
  description: string;
  max_score: number;
  sort_order: number;
}

export interface SelfAppraisal {
  id: string;
  user_id: string;
  month: number;
  year: number;
  scores: Record<string, number>;
  submitted_at: string;
}

export interface PeerMarking {
  id: string;
  reviewer_id: string;
  reviewee_id: string;
  month: number;
  year: number;
  scores: Record<string, number>;
  submitted_at: string;
  reviewer_name?: string;
}

export interface AdminKraScore {
  id: string;
  user_id: string;
  month: number;
  year: number;
  scores: Record<string, number>;
  is_final_pushed: boolean;
  pushed_at: string | null;
  pushed_by: string | null;
  updated_at: string;
  manual_penalty_percent: number;   // Admin-applied penalty (% off composite)
  manual_penalty_reason: string;
  total_penalty_override: number | null; // When set, fully replaces auto+manual.
  total_penalty_override_reason: string;
}

export interface KraReport {
  user_id: string;
  user_name: string;
  month: number;
  year: number;
  self_appraisal: SelfAppraisal | null;
  peer_average: Record<string, number>;
  peer_count: number;
  admin_score: AdminKraScore | null;
  composite_score: number | null;
  team_joined_at: string | null;       // when the user joined the branding team
  kra_window_start: string;             // YYYY-MM-DD — first day counted in expected_report_days
  expected_report_days: number;
  submitted_report_days: number;
  missed_report_days: number;
  penalty_percent: number;            // auto-penalty from missed reports
  manual_penalty_percent: number;     // admin-applied additional penalty
  manual_penalty_reason: string;
  total_penalty_override: number | null; // null = none, otherwise replaces auto+manual
  total_penalty_override_reason: string;
  total_penalty_percent: number;      // effective: override if set, else auto+manual (capped at 100)
  composite_score_after_penalty: number | null;
  is_final_pushed: boolean;
}

export type HalfDayPeriod = 'first' | 'second';

export interface BrandingLeave {
  id: string;
  user_id: string;
  leave_date: string;          // YYYY-MM-DD (day portion of start_at)
  start_at: string;            // ISO datetime — start of leave window
  end_at: string;              // ISO datetime — end of leave window
  is_half_day: boolean;
  half_day_period: HalfDayPeriod | null; // 'first' (9-1) | 'second' (2-5) | null
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  transfer_date: string | null; // YYYY-MM-DD — day the user will compensate
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  user_name?: string;
  user_email?: string;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

export async function bootstrapBrandingDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_sub_categories (
      id TEXT PRIMARY KEY,
      category_id TEXT NOT NULL REFERENCES work_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_others BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      report_date DATE NOT NULL,
      is_locked BOOLEAN NOT NULL DEFAULT false,
      submitted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, report_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_report_rows (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE,
      sr_no INTEGER NOT NULL,
      type_of_work TEXT NOT NULL DEFAULT '',
      sub_category TEXT NOT NULL DEFAULT '',
      specific_work TEXT NOT NULL DEFAULT '',
      time_taken TEXT NOT NULL DEFAULT '',
      collaborative_colleagues TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kra_parameters (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      max_score INTEGER NOT NULL DEFAULT 10,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS self_appraisals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      year INTEGER NOT NULL,
      scores JSONB NOT NULL DEFAULT '{}'::JSONB,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, month, year)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS peer_markings (
      id TEXT PRIMARY KEY,
      reviewer_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      reviewee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      year INTEGER NOT NULL,
      scores JSONB NOT NULL DEFAULT '{}'::JSONB,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(reviewer_id, reviewee_id, month, year)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_kra_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      year INTEGER NOT NULL,
      scores JSONB NOT NULL DEFAULT '{}'::JSONB,
      is_final_pushed BOOLEAN NOT NULL DEFAULT false,
      pushed_at TIMESTAMPTZ,
      pushed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, month, year)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS peer_marking_settings (
      id TEXT PRIMARY KEY,
      is_enabled BOOLEAN NOT NULL DEFAULT false,
      toggled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      toggled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      deadline DATE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','on_hold')),
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_project_assignments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES branding_projects(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(project_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_report_row_comments (
      id TEXT PRIMARY KEY,
      row_id TEXT NOT NULL REFERENCES daily_report_rows(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_brrc_row_id ON branding_report_row_comments(row_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_designs (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      image_url TEXT NOT NULL,
      uploader_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploader_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_design_votes (
      id TEXT PRIMARY KEY,
      design_id TEXT NOT NULL REFERENCES branding_designs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote_type TEXT NOT NULL CHECK (vote_type IN ('up','down')),
      voted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(design_id, user_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS branding_leaves (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      leave_date DATE NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      transfer_date DATE,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, leave_date)
    )
  `);

  // ── Migration: stopwatch fields on daily_report_rows ─────────────────────
  await pool.query(`ALTER TABLE daily_report_rows ADD COLUMN IF NOT EXISTS stopwatch_status TEXT NOT NULL DEFAULT 'idle'`);
  await pool.query(`ALTER TABLE daily_report_rows ADD COLUMN IF NOT EXISTS elapsed_seconds INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE daily_report_rows ADD COLUMN IF NOT EXISTS stopwatch_started_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE daily_report_rows ADD COLUMN IF NOT EXISTS carried_over_from_row_id TEXT`);
  // Wall-clock timestamp of the most recent transition into paused/finished.
  // Drives the per-day status caption in the chart popup. Reset to NULL on
  // carry-over so each new day starts fresh; the client supplies it on every
  // pause/finish save.
  await pool.query(`ALTER TABLE daily_report_rows ADD COLUMN IF NOT EXISTS last_paused_at TIMESTAMPTZ`);

  // ── Migration: manual penalty on admin_kra_scores ────────────────────────
  await pool.query(`ALTER TABLE admin_kra_scores ADD COLUMN IF NOT EXISTS manual_penalty_percent NUMERIC(5,2) NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE admin_kra_scores ADD COLUMN IF NOT EXISTS manual_penalty_reason TEXT NOT NULL DEFAULT ''`);

  // ── Migration: full total-penalty override on admin_kra_scores ───────────
  // NULL means "no override; use auto + manual". A number replaces both.
  await pool.query(`ALTER TABLE admin_kra_scores ADD COLUMN IF NOT EXISTS total_penalty_override NUMERIC(5,2)`);
  await pool.query(`ALTER TABLE admin_kra_scores ADD COLUMN IF NOT EXISTS total_penalty_override_reason TEXT NOT NULL DEFAULT ''`);

  // ── Migration: half-day + datetime range on branding_leaves ──────────────
  await pool.query(`ALTER TABLE branding_leaves ADD COLUMN IF NOT EXISTS start_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE branding_leaves ADD COLUMN IF NOT EXISTS end_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE branding_leaves ADD COLUMN IF NOT EXISTS is_half_day BOOLEAN NOT NULL DEFAULT false`);
  await pool.query(`ALTER TABLE branding_leaves ADD COLUMN IF NOT EXISTS half_day_period TEXT`);
  // Backfill start_at / end_at for legacy single-date rows
  await pool.query(`
    UPDATE branding_leaves
       SET start_at = (leave_date::timestamp + INTERVAL '9 hours'),
           end_at   = (leave_date::timestamp + INTERVAL '17 hours')
     WHERE start_at IS NULL
  `);

  await seedBrandingDefaults();
}

async function seedBrandingDefaults() {
  const catCount = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM work_categories`
  );
  if (catCount.rows[0].count === 0) {
    const categories = [
      {
        id: "cat-social-media", name: "Social Media", order: 1,
        subs: ["University Page Daily Post", "Student Achievement Post", "Event Promotion Post",
               "Awards and Ranking Post", "Staff Achievement Post", "Departmental Promotion Post",
               "Annual Tests Post", "Trend Post"],
      },
      {
        id: "cat-brochure-design", name: "Brochure Design", order: 2,
        subs: ["Event Design", "Workshop Brochure", "Institute Event Brochure",
               "University Event Brochure", "Flagship Event Brochure"],
      },
      {
        id: "cat-venue-branding", name: "Venue Branding", order: 3,
        subs: ["Auditorium Branding", "Ground Branding"],
      },
      {
        id: "cat-flyers", name: "Flyers", order: 4,
        subs: ["Course Promotional Flyers", "Advertisement Flyer"],
      },
      { id: "cat-signage-designs",    name: "Signage Designs",                       order: 5, subs: [] },
      { id: "cat-infrastructure",     name: "Infrastructure Design",                 order: 6, subs: [] },
      { id: "cat-university-doc",     name: "University Document Design",            order: 7, subs: [] },
      { id: "cat-branding-marketing", name: "Branding and Marketing Material Design", order: 8, subs: [] },
      { id: "cat-others",             name: "Others",                                 order: 9, subs: [] },
    ];
    for (const cat of categories) {
      await pool.query(
        `INSERT INTO work_categories (id, name, sort_order) VALUES ($1, $2, $3)`,
        [cat.id, cat.name, cat.order]
      );
      let subOrder = 1;
      for (const sub of cat.subs) {
        await pool.query(
          `INSERT INTO work_sub_categories (id, category_id, name, sort_order, is_others) VALUES ($1, $2, $3, $4, false)`,
          [generateId("wsc"), cat.id, sub, subOrder++]
        );
      }
      if (cat.id !== "cat-others") {
        await pool.query(
          `INSERT INTO work_sub_categories (id, category_id, name, sort_order, is_others) VALUES ($1, $2, 'Others', 999, true)`,
          [generateId("wsc"), cat.id]
        );
      }
    }
  }

  const kraCount = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM kra_parameters`
  );
  if (kraCount.rows[0].count === 0) {
    const params = [
      { name: "Quality of Design Work",      description: "Design quality, creativity, and attention to detail" },
      { name: "Productivity & Output Volume", description: "Volume of work completed on time" },
      { name: "Deadline Adherence",           description: "Timely delivery and meeting project deadlines" },
      { name: "Creativity & Innovation",      description: "New ideas, creative solutions, and innovation" },
      { name: "Team Collaboration",           description: "Teamwork, cooperation, and supporting peers" },
      { name: "Communication Skills",         description: "Clear, effective communication with team and stakeholders" },
      { name: "Brand Guidelines Adherence",   description: "Consistent application of brand identity and guidelines" },
      { name: "Technical Proficiency",        description: "Proficiency in design software and tools" },
      { name: "Professionalism & Attitude",   description: "Work ethic, punctuality, and positive attitude" },
      { name: "Initiative & Problem Solving", description: "Proactive approach and ability to solve problems" },
    ];
    for (let i = 0; i < params.length; i++) {
      await pool.query(
        `INSERT INTO kra_parameters (id, name, description, max_score, sort_order) VALUES ($1, $2, $3, 10, $4)`,
        [generateId("krap"), params[i].name, params[i].description, i + 1]
      );
    }
  }

  await pool.query(`
    INSERT INTO peer_marking_settings (id, is_enabled)
    VALUES ('singleton', false)
    ON CONFLICT (id) DO NOTHING
  `);
}

// ── Internal row types ─────────────────────────────────────────────────────

interface CatRow {
  id: string; name: string; sort_order: number; created_at: string;
}
interface SubCatRow {
  id: string; category_id: string; name: string;
  sort_order: number; is_others: boolean; created_at: string;
}
interface ReportDbRow {
  id: string; user_id: string; report_date: string;
  is_locked: boolean; submitted_at: string | null; created_at: string;
  user_name?: string; user_email?: string;
}
interface ReportRowDb {
  id: string; report_id: string; sr_no: number;
  type_of_work: string; sub_category: string; specific_work: string;
  time_taken: string; collaborative_colleagues: string[]; created_at: string;
  stopwatch_status: StopwatchStatus;
  elapsed_seconds: number;
  stopwatch_started_at: string | null;
  carried_over_from_row_id: string | null;
  last_paused_at: string | null;
}
interface KraParamRow {
  id: string; name: string; description: string; max_score: number; sort_order: number;
}
interface SelfAppraisalRow {
  id: string; user_id: string; month: number; year: number;
  scores: Record<string, number>; submitted_at: string;
}
interface PeerMarkingRow {
  id: string; reviewer_id: string; reviewee_id: string;
  month: number; year: number; scores: Record<string, number>;
  submitted_at: string; reviewer_name?: string;
}
interface AdminKraRow {
  id: string; user_id: string; month: number; year: number;
  scores: Record<string, number>; is_final_pushed: boolean;
  pushed_at: string | null; pushed_by: string | null; updated_at: string;
  manual_penalty_percent: string | number; // pg returns NUMERIC as string
  manual_penalty_reason: string;
  total_penalty_override: string | number | null;
  total_penalty_override_reason: string;
}

// ── Category functions ─────────────────────────────────────────────────────

export async function listWorkCategories(): Promise<WorkCategory[]> {
  const cats = await pool.query<CatRow>(
    `SELECT * FROM work_categories ORDER BY sort_order ASC, name ASC`
  );
  const subs = await pool.query<SubCatRow>(
    `SELECT * FROM work_sub_categories ORDER BY is_others ASC, sort_order ASC, name ASC`
  );
  return cats.rows.map(cat => ({
    ...cat,
    sub_categories: subs.rows.filter(s => s.category_id === cat.id),
  }));
}

export async function createWorkCategory(name: string): Promise<WorkCategory> {
  const maxRes = await pool.query<{ max: number }>(
    `SELECT COALESCE(MAX(sort_order), 0) AS max FROM work_categories`
  );
  const id = generateId("cat");
  await pool.query(
    `INSERT INTO work_categories (id, name, sort_order) VALUES ($1, $2, $3)`,
    [id, name, (maxRes.rows[0].max || 0) + 1]
  );
  await pool.query(
    `INSERT INTO work_sub_categories (id, category_id, name, sort_order, is_others) VALUES ($1, $2, 'Others', 999, true)`,
    [generateId("wsc"), id]
  );
  const all = await listWorkCategories();
  return all.find(c => c.id === id)!;
}

export async function updateWorkCategory(id: string, name: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE work_categories SET name = $2 WHERE id = $1`, [id, name]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteWorkCategory(id: string): Promise<{ usageCount: number }> {
  const usage = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM daily_report_rows drr
     JOIN daily_reports dr ON drr.report_id = dr.id
     WHERE drr.type_of_work = (SELECT name FROM work_categories WHERE id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM work_categories WHERE id = $1`, [id]);
  return { usageCount: usage.rows[0].count };
}

export async function createWorkSubCategory(categoryId: string, name: string): Promise<WorkSubCategory> {
  const maxRes = await pool.query<{ max: number }>(
    `SELECT COALESCE(MAX(sort_order), 0) AS max FROM work_sub_categories WHERE category_id = $1 AND NOT is_others`,
    [categoryId]
  );
  const id = generateId("wsc");
  const result = await pool.query<SubCatRow>(
    `INSERT INTO work_sub_categories (id, category_id, name, sort_order, is_others)
     VALUES ($1, $2, $3, $4, false) RETURNING *`,
    [id, categoryId, name, (maxRes.rows[0].max || 0) + 1]
  );
  return result.rows[0];
}

export async function updateWorkSubCategory(id: string, name: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE work_sub_categories SET name = $2 WHERE id = $1 AND NOT is_others`, [id, name]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function deleteWorkSubCategory(id: string): Promise<{ usageCount: number }> {
  const usage = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM daily_report_rows drr
     JOIN daily_reports dr ON drr.report_id = dr.id
     WHERE drr.sub_category = (SELECT name FROM work_sub_categories WHERE id = $1)`,
    [id]
  );
  await pool.query(`DELETE FROM work_sub_categories WHERE id = $1 AND NOT is_others`, [id]);
  return { usageCount: usage.rows[0].count };
}

export async function reorderWorkCategories(orderedIds: string[]): Promise<void> {
  for (let i = 0; i < orderedIds.length; i++) {
    await pool.query(`UPDATE work_categories SET sort_order = $2 WHERE id = $1`, [orderedIds[i], i + 1]);
  }
}

// ── Daily report functions ─────────────────────────────────────────────────

async function fetchReportRows(reportId: string): Promise<DailyReportRow[]> {
  const res = await pool.query<ReportRowDb>(
    `SELECT * FROM daily_report_rows WHERE report_id = $1 ORDER BY sr_no ASC`,
    [reportId]
  );
  return res.rows;
}

function normalizeDate(d: string | Date | unknown): string {
  if (d instanceof Date) {
    // node-postgres returns a DATE column as a JS Date at local-midnight
    // (e.g. 2026-05-21 → Date('2026-05-21T00:00:00+05:30') = 2026-05-20T18:30Z).
    // Calling toISOString() then split('T')[0] would silently drop the date
    // by one day in any non-UTC timezone, which breaks the 9 PM IST cutoff
    // check for the entire calendar day. Use local components so the YYYY-MM-DD
    // we return matches the report_date the user actually picked.
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }
  if (typeof d === "string" && d.includes("T")) return d.split("T")[0];
  return String(d);
}

export async function getOrCreateDailyReport(userId: string, date: string): Promise<DailyReport> {
  const existing = await pool.query<ReportDbRow>(
    `SELECT * FROM daily_reports WHERE user_id = $1 AND report_date = $2::date`,
    [userId, date]
  );
  if (existing.rows[0]) {
    const rows = await fetchReportRows(existing.rows[0].id);
    await carryOverPausedRows(userId, existing.rows[0].id, date, rows);
    const finalRows = await fetchReportRows(existing.rows[0].id);
    return { ...existing.rows[0], rows: finalRows, report_date: normalizeDate(existing.rows[0].report_date) };
  }
  const id = generateId("dr");
  const result = await pool.query<ReportDbRow>(
    `INSERT INTO daily_reports (id, user_id, report_date) VALUES ($1, $2, $3::date) RETURNING *`,
    [id, userId, date]
  );
  await carryOverPausedRows(userId, id, date, []);
  const seeded = await fetchReportRows(id);
  return { ...result.rows[0], rows: seeded, report_date: normalizeDate(result.rows[0].report_date) };
}

// Copy any 'paused' rows from the user's most recent prior report into today's
// draft so the user can continue tracking. Skips duplicates via carried_over_from_row_id.
async function carryOverPausedRows(
  userId: string,
  todayReportId: string,
  todayDate: string,
  existingTodayRows: DailyReportRow[]
): Promise<void> {
  const lockCheck = await pool.query<{ is_locked: boolean }>(
    `SELECT is_locked FROM daily_reports WHERE id = $1`, [todayReportId]
  );
  if (lockCheck.rows[0]?.is_locked) return;

  const prevReport = await pool.query<{ id: string }>(
    `SELECT id FROM daily_reports
      WHERE user_id = $1 AND report_date < $2::date
      ORDER BY report_date DESC LIMIT 1`,
    [userId, todayDate]
  );
  if (!prevReport.rows[0]) return;

  const pausedRows = await pool.query<ReportRowDb>(
    `SELECT * FROM daily_report_rows
      WHERE report_id = $1 AND stopwatch_status = 'paused'
      ORDER BY sr_no ASC`,
    [prevReport.rows[0].id]
  );
  if (pausedRows.rows.length === 0) return;

  const alreadyCarried = new Set(
    existingTodayRows.map(r => r.carried_over_from_row_id).filter(Boolean) as string[]
  );

  let nextSrNo = existingTodayRows.length > 0
    ? Math.max(...existingTodayRows.map(r => r.sr_no)) + 1
    : 1;

  for (const src of pausedRows.rows) {
    if (alreadyCarried.has(src.id)) continue;
    const id = generateId("drr");
    await pool.query(
      `INSERT INTO daily_report_rows
         (id, report_id, sr_no, type_of_work, sub_category, specific_work, time_taken,
          collaborative_colleagues, stopwatch_status, elapsed_seconds, stopwatch_started_at,
          carried_over_from_row_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'paused', $9, NULL, $10)`,
      [id, todayReportId, nextSrNo, src.type_of_work, src.sub_category, src.specific_work,
       src.time_taken, src.collaborative_colleagues, src.elapsed_seconds, src.id]
    );
    nextSrNo += 1;
  }
}

export async function getDailyReport(userId: string, date: string): Promise<DailyReport | null> {
  const res = await pool.query<ReportDbRow>(
    `SELECT * FROM daily_reports WHERE user_id = $1 AND report_date = $2::date`,
    [userId, date]
  );
  if (!res.rows[0]) return null;
  const rows = await fetchReportRows(res.rows[0].id);
  return { ...res.rows[0], rows, report_date: normalizeDate(res.rows[0].report_date) };
}

// Daily edit window closes at 21:00 IST of the report_date. After that the
// report is auto-locked (see autoSubmitOverdueReports) and any further edits
// are rejected.
export const REPORT_EDIT_CUTOFF_HOUR_IST = 21;

// Any stopwatch still running at this hour IST is auto-paused (but the report
// stays editable until REPORT_EDIT_CUTOFF_HOUR_IST). See autoPauseRunningStopwatches.
export const AUTO_PAUSE_HOUR_IST = 17;

function reportEditCutoffUtc(reportDate: string): Date {
  // YYYY-MM-DD interpreted as 21:00 IST → equivalent UTC instant.
  return new Date(`${reportDate}T${String(REPORT_EDIT_CUTOFF_HOUR_IST).padStart(2, '0')}:00:00+05:30`);
}

function isEditingClosed(reportDate: string): boolean {
  return Date.now() >= reportEditCutoffUtc(reportDate).getTime();
}

// Compact "Hh Mm Ss" representation — mirrors src/lib/branding-types.ts
function elapsedToTimeTakenServer(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return '0s';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (sec > 0 && h === 0) parts.push(`${sec}s`);
  return parts.join(' ') || '0s';
}

export async function saveReportRows(reportId: string, userId: string, rows: SaveRowInput[]): Promise<DailyReportRow[] | null> {
  const report = await pool.query<ReportDbRow>(
    `SELECT * FROM daily_reports WHERE id = $1 AND user_id = $2`,
    [reportId, userId]
  );
  if (!report.rows[0] || report.rows[0].is_locked) return null;
  // Reject edits past the 9 PM IST cutoff; the periodic auto-submit job will
  // lock the row, but we also guard the write path so a manual save right at
  // the cutoff can't bypass the rule.
  const reportDate = normalizeDate(report.rows[0].report_date);
  if (isEditingClosed(reportDate)) return null;

  await pool.query(`DELETE FROM daily_report_rows WHERE report_id = $1`, [reportId]);
  const saved: DailyReportRow[] = [];
  for (const row of rows) {
    const id = generateId("drr");
    let status: StopwatchStatus = row.stopwatch_status ?? 'idle';
    const elapsed = row.elapsed_seconds ?? 0;
    let startedAt: string | null = row.stopwatch_started_at ?? null;
    let lastPausedAt: string | null = row.last_paused_at ?? null;
    // Only running rows carry a started_at; everything else is null. Crucially,
    // if a row arrives as "running" without an explicit started_at, do NOT
    // re-stamp NOW() — that silently restarts the clock and inflates elapsed
    // on the next read. Treat it as paused: the user must hit Start/Continue
    // to begin a new tracked interval.
    if (status === 'running') {
      if (!startedAt) {
        status = 'paused';
        // Promote to paused → record the pause moment if the client didn't.
        if (!lastPausedAt) lastPausedAt = new Date().toISOString();
      } else {
        // Genuinely running — clear any stale pause stamp.
        lastPausedAt = null;
      }
    } else {
      startedAt = null;
      // For paused/finished rows, fall back to NOW() when the client omitted
      // the timestamp (e.g. legacy clients). Idle rows get null.
      if ((status === 'paused' || status === 'finished') && !lastPausedAt) {
        lastPausedAt = new Date().toISOString();
      }
      if (status === 'idle') lastPausedAt = null;
    }
    const res = await pool.query<ReportRowDb>(
      `INSERT INTO daily_report_rows
         (id, report_id, sr_no, type_of_work, sub_category, specific_work, time_taken,
          collaborative_colleagues, stopwatch_status, elapsed_seconds, stopwatch_started_at,
          carried_over_from_row_id, last_paused_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [id, reportId, row.sr_no, row.type_of_work, row.sub_category,
       row.specific_work, row.time_taken, row.collaborative_colleagues,
       status, elapsed, startedAt, row.carried_over_from_row_id ?? null, lastPausedAt]
    );
    saved.push(res.rows[0]);
  }
  return saved;
}

export async function submitDailyReport(reportId: string, userId: string): Promise<DailyReport | null> {
  const report = await pool.query<ReportDbRow>(
    `SELECT * FROM daily_reports WHERE id = $1 AND user_id = $2`,
    [reportId, userId]
  );
  if (!report.rows[0] || report.rows[0].is_locked) return null;
  const res = await pool.query<ReportDbRow>(
    `UPDATE daily_reports SET is_locked = true, submitted_at = NOW() WHERE id = $1 RETURNING *`,
    [reportId]
  );
  const rows = await fetchReportRows(reportId);
  return { ...res.rows[0], rows, report_date: normalizeDate(res.rows[0].report_date) };
}

// Hard ceiling on a single uninterrupted "since" snapshot. A timer left
// running unattended for hours/days would otherwise accumulate raw wall-clock
// time and inflate elapsed_seconds wildly (we saw 100h+ rows in prod). 9h is
// the upper bound of a plausible working session — anything beyond that is
// almost certainly the user forgot to pause/finish.
const MAX_STOPWATCH_SINCE_SECONDS = 9 * 3600;

// Snapshot any running stopwatch row into a paused state with its accrued time
// frozen, and derive time_taken from elapsed_seconds where missing. Mirrors
// what the user-side submitReport() does in the browser, so auto-submitted
// reports look identical to manually-submitted ones.
async function finalizeReportRowsForSubmit(reportId: string): Promise<void> {
  const res = await pool.query<ReportRowDb>(
    `SELECT * FROM daily_report_rows WHERE report_id = $1`,
    [reportId]
  );
  for (const row of res.rows) {
    const status: StopwatchStatus = (row.stopwatch_status as StopwatchStatus | undefined) ?? 'idle';
    let elapsed = row.elapsed_seconds ?? 0;
    let newStatus: StopwatchStatus = status;
    if (status === 'running' && row.stopwatch_started_at) {
      const rawSince = Math.max(0, Math.floor((Date.now() - new Date(row.stopwatch_started_at).getTime()) / 1000));
      const since = Math.min(rawSince, MAX_STOPWATCH_SINCE_SECONDS);
      elapsed = elapsed + since;
      newStatus = 'paused';
    }
    const needsTimeTakenRefresh = newStatus === 'paused' || newStatus === 'running' || !row.time_taken;
    const newTimeTaken = needsTimeTakenRefresh ? elapsedToTimeTakenServer(elapsed) : row.time_taken;
    if (newStatus !== status || elapsed !== (row.elapsed_seconds ?? 0) || newTimeTaken !== row.time_taken) {
      await pool.query(
        `UPDATE daily_report_rows
            SET stopwatch_status = $1, elapsed_seconds = $2,
                stopwatch_started_at = NULL, time_taken = $3
          WHERE id = $4`,
        [newStatus, elapsed, newTimeTaken, row.id]
      );
    }
  }
}

// Find every unlocked daily report whose 21:00 IST cutoff has passed and
// auto-submit it. Running stopwatches are snapshotted to paused so the carry-
// over flow on the next day's report still works.
// Returns the number of reports that were just auto-submitted.
export async function autoSubmitOverdueReports(): Promise<number> {
  // Compute cutoff via Asia/Kolkata so the math is correct regardless of the
  // server's local timezone. Report-date wall-clock 21:00 IST → UTC.
  const overdue = await pool.query<{ id: string }>(`
    SELECT id FROM daily_reports
     WHERE is_locked = false
       AND ((report_date::timestamp AT TIME ZONE 'Asia/Kolkata') + INTERVAL '${REPORT_EDIT_CUTOFF_HOUR_IST} hours') <= NOW()
  `);
  let count = 0;
  for (const r of overdue.rows) {
    await finalizeReportRowsForSubmit(r.id);
    const upd = await pool.query(
      `UPDATE daily_reports SET is_locked = true, submitted_at = NOW()
        WHERE id = $1 AND is_locked = false`,
      [r.id]
    );
    if (upd.rowCount && upd.rowCount > 0) count++;
  }
  return count;
}

// At AUTO_PAUSE_HOUR_IST (17:00 IST), any row still running is snapshotted to
// paused so we don't credit time the user forgot to stop. The report is left
// editable — the user can hit Continue and accumulate more time until the 21:00
// IST submit cutoff. Self-idempotent: a paused row has stopwatch_started_at = NULL
// and a row resumed after 17:00 has stopwatch_started_at >= cutoff, so neither
// is re-paused on subsequent passes.
// Returns the number of rows auto-paused on this pass.
export async function autoPauseRunningStopwatches(): Promise<number> {
  const overdue = await pool.query<{
    id: string;
    stopwatch_started_at: string;
    elapsed_seconds: number;
  }>(`
    SELECT drr.id, drr.stopwatch_started_at, drr.elapsed_seconds
      FROM daily_report_rows drr
      JOIN daily_reports dr ON dr.id = drr.report_id
     WHERE drr.stopwatch_status = 'running'
       AND dr.is_locked = false
       AND drr.stopwatch_started_at IS NOT NULL
       AND drr.stopwatch_started_at < ((dr.report_date::timestamp AT TIME ZONE 'Asia/Kolkata') + INTERVAL '${AUTO_PAUSE_HOUR_IST} hours')
       AND NOW() >= ((dr.report_date::timestamp AT TIME ZONE 'Asia/Kolkata') + INTERVAL '${AUTO_PAUSE_HOUR_IST} hours')
  `);
  let count = 0;
  for (const r of overdue.rows) {
    const rawSince = Math.max(0, Math.floor((Date.now() - new Date(r.stopwatch_started_at).getTime()) / 1000));
    const since = Math.min(rawSince, MAX_STOPWATCH_SINCE_SECONDS);
    const newElapsed = (r.elapsed_seconds ?? 0) + since;
    const upd = await pool.query(
      `UPDATE daily_report_rows
          SET stopwatch_status = 'paused',
              elapsed_seconds = $1,
              stopwatch_started_at = NULL,
              last_paused_at = NOW(),
              time_taken = $2
        WHERE id = $3 AND stopwatch_status = 'running'`,
      [newElapsed, elapsedToTimeTakenServer(newElapsed), r.id]
    );
    if (upd.rowCount && upd.rowCount > 0) count++;
  }
  return count;
}

export async function listAllDailyReports(filters?: {
  userId?: string;
  userIds?: string[];
  dateFrom?: string;
  dateTo?: string;
  typeOfWork?: string;
  subCategory?: string;
  collaborator?: string;
  lockedOnly?: boolean;
}): Promise<DailyReport[]> {
  let query = `
    SELECT dr.*, u.full_name AS user_name, u.email AS user_email
    FROM daily_reports dr
    JOIN users u ON dr.user_id = u.id
    WHERE 1=1
  `;
  const params: unknown[] = [];
  let idx = 1;

  // When specific userId(s) are given, filter directly; otherwise scope to branding team.
  if (filters?.userIds && filters.userIds.length > 0) {
    query += ` AND dr.user_id = ANY($${idx++}::uuid[])`;
    params.push(filters.userIds);
  } else if (filters?.userId) {
    query += ` AND dr.user_id = $${idx++}`;
    params.push(filters.userId);
  } else {
    query += ` AND u.team = 'branding'`;
  }
  if (filters?.dateFrom) { query += ` AND dr.report_date >= $${idx++}::date`;   params.push(filters.dateFrom); }
  if (filters?.dateTo)   { query += ` AND dr.report_date <= $${idx++}::date`;   params.push(filters.dateTo); }
  if (filters?.lockedOnly) { query += ` AND dr.is_locked = true`; }
  query += ` ORDER BY dr.report_date DESC, u.full_name ASC`;

  const result = await pool.query<ReportDbRow & { user_name: string; user_email: string }>(query, params);
  const reports: DailyReport[] = [];

  for (const row of result.rows) {
    let rows = await fetchReportRows(row.id);
    if (filters?.typeOfWork)  rows = rows.filter(r => r.type_of_work === filters.typeOfWork);
    if (filters?.subCategory) rows = rows.filter(r => r.sub_category === filters.subCategory);
    if (filters?.collaborator) rows = rows.filter(r => r.collaborative_colleagues.includes(filters.collaborator!));
    if ((filters?.typeOfWork || filters?.subCategory || filters?.collaborator) && rows.length === 0) continue;
    reports.push({ ...row, rows, report_date: normalizeDate(row.report_date) });
  }
  return reports;
}

export async function getUserAnalytics(userId: string, dateFrom: string, dateTo: string) {
  const reports = await listAllDailyReports({ userId, dateFrom, dateTo });
  const typeHours: Record<string, number> = {};
  const subCatHours: Record<string, Record<string, number>> = {};
  const collaboratorMap: Record<string, { hours: number; count: number }> = {};

  const toHours = (t: string, elapsedSeconds?: number) => {
    // Stopwatch path: prefer elapsed_seconds when present (covers running/paused/finished)
    if (typeof elapsedSeconds === "number" && elapsedSeconds > 0) return elapsedSeconds / 3600;
    if (!t) return 0;
    if (t === "30 min") return 0.5;
    // Composite "Xh Ym Zs" (any subset, all optional)
    const composite = t.match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
    if (composite && (composite[1] || composite[2] || composite[3])) {
      const h = composite[1] ? parseInt(composite[1], 10) : 0;
      const m = composite[2] ? parseInt(composite[2], 10) : 0;
      const s = composite[3] ? parseInt(composite[3], 10) : 0;
      return h + m / 60 + s / 3600;
    }
    const m = t.match(/^(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };

  for (const report of reports) {
    for (const row of report.rows) {
      const h = toHours(row.time_taken, row.elapsed_seconds);
      typeHours[row.type_of_work] = (typeHours[row.type_of_work] || 0) + h;
      if (!subCatHours[row.type_of_work]) subCatHours[row.type_of_work] = {};
      subCatHours[row.type_of_work][row.sub_category] =
        (subCatHours[row.type_of_work][row.sub_category] || 0) + h;
      for (const c of row.collaborative_colleagues) {
        if (!collaboratorMap[c]) collaboratorMap[c] = { hours: 0, count: 0 };
        collaboratorMap[c].hours += h;
        collaboratorMap[c].count += 1;
      }
    }
  }

  // Resolve collaborator IDs → names so the frontend can display them directly
  const ids = Object.keys(collaboratorMap);
  const namedMap: Record<string, { hours: number; count: number }> = {};
  if (ids.length > 0) {
    const res = await pool.query<{ id: string; full_name: string }>(
      `SELECT id, full_name FROM users WHERE id = ANY($1)`,
      [ids]
    );
    const nameById: Record<string, string> = {};
    for (const row of res.rows) nameById[row.id] = row.full_name || row.id;
    for (const id of ids) {
      const name = nameById[id] || id;
      namedMap[name] = collaboratorMap[id];
    }
  }

  return { typeHours, subCatHours, collaboratorMap: namedMap, totalReports: reports.length };
}

// ── KRA functions ──────────────────────────────────────────────────────────

export async function listKraParameters(): Promise<KraParameter[]> {
  const res = await pool.query<KraParamRow>(`SELECT * FROM kra_parameters ORDER BY sort_order ASC`);
  return res.rows;
}

export async function getPeerMarkingEnabled(): Promise<boolean> {
  const res = await pool.query<{ is_enabled: boolean }>(
    `SELECT is_enabled FROM peer_marking_settings WHERE id = 'singleton'`
  );
  return res.rows[0]?.is_enabled ?? false;
}

export async function togglePeerMarking(enabled: boolean, adminId: string): Promise<void> {
  await pool.query(
    `INSERT INTO peer_marking_settings (id, is_enabled, toggled_by, toggled_at)
     VALUES ('singleton', $1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET is_enabled = $1, toggled_by = $2, toggled_at = NOW()`,
    [enabled, adminId]
  );
}

export async function getSelfAppraisal(userId: string, month: number, year: number): Promise<SelfAppraisal | null> {
  const res = await pool.query<SelfAppraisalRow>(
    `SELECT * FROM self_appraisals WHERE user_id = $1 AND month = $2 AND year = $3`,
    [userId, month, year]
  );
  return res.rows[0] || null;
}

export async function submitSelfAppraisal(
  userId: string, month: number, year: number, scores: Record<string, number>
): Promise<SelfAppraisal | "already_submitted"> {
  const existing = await getSelfAppraisal(userId, month, year);
  if (existing) return "already_submitted";
  const id = generateId("sa");
  const res = await pool.query<SelfAppraisalRow>(
    `INSERT INTO self_appraisals (id, user_id, month, year, scores)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [id, userId, month, year, JSON.stringify(scores)]
  );
  return res.rows[0];
}

export async function listAllSelfAppraisals(month: number, year: number): Promise<(SelfAppraisal & { user_name: string })[]> {
  const res = await pool.query<SelfAppraisalRow & { user_name: string }>(
    `SELECT sa.*, u.full_name AS user_name
     FROM self_appraisals sa
     JOIN users u ON sa.user_id = u.id
     WHERE sa.month = $1 AND sa.year = $2
     ORDER BY u.full_name ASC`,
    [month, year]
  );
  return res.rows;
}

export async function getCompletedPeerMarkings(reviewerId: string, month: number, year: number): Promise<string[]> {
  const res = await pool.query<{ reviewee_id: string }>(
    `SELECT reviewee_id FROM peer_markings WHERE reviewer_id = $1 AND month = $2 AND year = $3`,
    [reviewerId, month, year]
  );
  return res.rows.map(r => r.reviewee_id);
}

export async function submitPeerMarking(
  reviewerId: string, revieweeId: string, month: number, year: number, scores: Record<string, number>
): Promise<PeerMarking | "already_submitted"> {
  const existing = await pool.query(
    `SELECT id FROM peer_markings WHERE reviewer_id = $1 AND reviewee_id = $2 AND month = $3 AND year = $4`,
    [reviewerId, revieweeId, month, year]
  );
  if (existing.rows[0]) return "already_submitted";
  const id = generateId("pm");
  const res = await pool.query<PeerMarkingRow>(
    `INSERT INTO peer_markings (id, reviewer_id, reviewee_id, month, year, scores)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
    [id, reviewerId, revieweeId, month, year, JSON.stringify(scores)]
  );
  return res.rows[0];
}

export async function getPeerMarkingsForUser(revieweeId: string, month: number, year: number): Promise<PeerMarking[]> {
  const res = await pool.query<PeerMarkingRow & { reviewer_name: string }>(
    `SELECT pm.*, u.full_name AS reviewer_name
     FROM peer_markings pm
     JOIN users u ON pm.reviewer_id = u.id
     WHERE pm.reviewee_id = $1 AND pm.month = $2 AND pm.year = $3`,
    [revieweeId, month, year]
  );
  return res.rows;
}

export async function getAllPeerMarkings(month: number, year: number): Promise<(PeerMarking & { reviewee_name: string })[]> {
  const res = await pool.query<PeerMarkingRow & { reviewer_name: string; reviewee_name: string }>(
    `SELECT pm.*, ur.full_name AS reviewer_name, ue.full_name AS reviewee_name
     FROM peer_markings pm
     JOIN users ur ON pm.reviewer_id = ur.id
     JOIN users ue ON pm.reviewee_id = ue.id
     WHERE pm.month = $1 AND pm.year = $2
     ORDER BY ue.full_name ASC, ur.full_name ASC`,
    [month, year]
  );
  return res.rows;
}

function mapAdminScore(row: AdminKraRow): AdminKraScore {
  return {
    ...row,
    manual_penalty_percent: Number(row.manual_penalty_percent ?? 0),
    manual_penalty_reason: row.manual_penalty_reason ?? '',
    total_penalty_override: row.total_penalty_override === null || row.total_penalty_override === undefined
      ? null
      : Number(row.total_penalty_override),
    total_penalty_override_reason: row.total_penalty_override_reason ?? '',
  };
}

export async function getAdminKraScore(userId: string, month: number, year: number): Promise<AdminKraScore | null> {
  const res = await pool.query<AdminKraRow>(
    `SELECT * FROM admin_kra_scores WHERE user_id = $1 AND month = $2 AND year = $3`,
    [userId, month, year]
  );
  return res.rows[0] ? mapAdminScore(res.rows[0]) : null;
}

export async function setAdminKraScore(
  userId: string, month: number, year: number, scores: Record<string, number>, adminId: string
): Promise<AdminKraScore> {
  const id = generateId("aks");
  const res = await pool.query<AdminKraRow>(
    `INSERT INTO admin_kra_scores (id, user_id, month, year, scores, updated_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
     ON CONFLICT (user_id, month, year) DO UPDATE
       SET scores = EXCLUDED.scores, updated_at = NOW()
     RETURNING *`,
    [id, userId, month, year, JSON.stringify(scores)]
  );
  return mapAdminScore(res.rows[0]);
}

// Set / update the admin-applied manual penalty for a user-month.
// Creates the admin_kra_scores row if it doesn't exist yet (so admins can apply
// a penalty before they finish setting per-parameter scores).
export async function setAdminManualPenalty(
  userId: string, month: number, year: number,
  penaltyPercent: number, reason: string,
): Promise<AdminKraScore> {
  const pct = Math.max(0, Math.min(100, Number(penaltyPercent) || 0));
  const id = generateId("aks");
  const res = await pool.query<AdminKraRow>(
    `INSERT INTO admin_kra_scores
       (id, user_id, month, year, scores, manual_penalty_percent, manual_penalty_reason, updated_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, NOW())
     ON CONFLICT (user_id, month, year) DO UPDATE
       SET manual_penalty_percent = EXCLUDED.manual_penalty_percent,
           manual_penalty_reason  = EXCLUDED.manual_penalty_reason,
           updated_at = NOW()
     RETURNING *`,
    [id, userId, month, year, pct, reason]
  );
  return mapAdminScore(res.rows[0]);
}

// Set / clear the brand-admin's full TOTAL penalty override.
// percent = null clears the override (falls back to auto + manual).
// When set, the override fully replaces both auto and manual penalties.
export async function setAdminTotalPenaltyOverride(
  userId: string, month: number, year: number,
  percent: number | null, reason: string,
): Promise<AdminKraScore> {
  const pct = percent === null
    ? null
    : Math.max(0, Math.min(100, Number(percent) || 0));
  const id = generateId("aks");
  const res = await pool.query<AdminKraRow>(
    `INSERT INTO admin_kra_scores
       (id, user_id, month, year, scores, total_penalty_override, total_penalty_override_reason, updated_at)
     VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, NOW())
     ON CONFLICT (user_id, month, year) DO UPDATE
       SET total_penalty_override        = EXCLUDED.total_penalty_override,
           total_penalty_override_reason = EXCLUDED.total_penalty_override_reason,
           updated_at = NOW()
     RETURNING *`,
    [id, userId, month, year, pct, reason]
  );
  return mapAdminScore(res.rows[0]);
}

export async function finalPushKra(
  userId: string, month: number, year: number, adminId: string
): Promise<AdminKraScore | "not_found" | "already_pushed"> {
  const existing = await getAdminKraScore(userId, month, year);
  if (!existing) return "not_found";
  if (existing.is_final_pushed) return "already_pushed";
  const res = await pool.query<AdminKraRow>(
    `UPDATE admin_kra_scores
     SET is_final_pushed = true, pushed_at = NOW(), pushed_by = $4
     WHERE user_id = $1 AND month = $2 AND year = $3
     RETURNING *`,
    [userId, month, year, adminId]
  );
  return mapAdminScore(res.rows[0]);
}

function avgScores(markings: PeerMarking[]): Record<string, number> {
  if (!markings.length) return {};
  const totals: Record<string, number> = {};
  for (const m of markings) {
    for (const [k, v] of Object.entries(m.scores)) {
      totals[k] = (totals[k] || 0) + v;
    }
  }
  const result: Record<string, number> = {};
  for (const k of Object.keys(totals)) result[k] = Math.round((totals[k] / markings.length) * 10) / 10;
  return result;
}

function compositeScore(
  self: Record<string, number> | null,
  peer: Record<string, number>,
  admin: Record<string, number> | null,
  params: KraParameter[]
): number | null {
  let total = 0, count = 0;
  for (const p of params) {
    const vals = [self?.[p.id], peer[p.id], admin?.[p.id]].filter(v => v !== undefined) as number[];
    if (vals.length) { total += vals.reduce((a, b) => a + b, 0) / vals.length; count++; }
  }
  return count ? Math.round((total / count) * 10) / 10 : null;
}

// Working days (Mon-Sat) from `from` through `to` inclusive. Only Sunday is
// off — Saturday is a working day for the branding team.
function countWorkingDays(from: Date, to: Date): number {
  let count = 0;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const last = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (d <= last) {
    if (d.getDay() !== 0) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

// −1% per missed working day. Half-day approved leaves count as 0.5.
// Expected-day window starts at the later of (1) month start and (2) the user's
// team_joined_at, so new joiners and team-transferred members are not penalised
// for days before they were on the team.
async function computeMissedReportPenalty(
  userId: string, month: number, year: number
): Promise<{ expected: number; submitted: number; missed: number; penaltyPct: number; effectiveStart: string }> {
  const today = new Date();
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month, 0);
  const rangeEnd = today < monthEnd ? today : monthEnd;

  // Clamp the window start to the team-join date when it falls inside this month.
  const joinRes = await pool.query<{ team_joined_at: string | null }>(
    `SELECT team_joined_at FROM users WHERE id = $1`,
    [userId]
  );
  const joinedAtRaw = joinRes.rows[0]?.team_joined_at ?? null;
  const joinedAt = joinedAtRaw ? new Date(joinedAtRaw) : null;
  const effectiveStart = joinedAt && joinedAt > monthStart ? joinedAt : monthStart;

  if (rangeEnd < effectiveStart) {
    return { expected: 0, submitted: 0, missed: 0, penaltyPct: 0, effectiveStart: effectiveStart.toISOString().split('T')[0] };
  }
  const workingDays = countWorkingDays(effectiveStart, rangeEnd);

  const fromStr = effectiveStart.toISOString().split("T")[0];
  const toStr = rangeEnd.toISOString().split("T")[0];
  const leaveRes = await pool.query<{ leave_date: string; is_half_day: boolean }>(
    `SELECT leave_date, is_half_day FROM branding_leaves
      WHERE user_id = $1 AND status = 'approved'
        AND leave_date >= $2::date AND leave_date <= $3::date`,
    [userId, fromStr, toStr]
  );
  let leaveOffset = 0;
  for (const r of leaveRes.rows) {
    const d = new Date(r.leave_date);
    // Sunday is the only off-day — Saturday counts as a working day, so a
    // Saturday leave is real.
    if (d.getDay() === 0) continue;
    leaveOffset += r.is_half_day ? 0.5 : 1;
  }
  const expected = Math.max(0, workingDays - leaveOffset);

  const subRes = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::int AS count FROM daily_reports
      WHERE user_id = $1 AND is_locked = true
        AND report_date >= $2::date AND report_date <= $3::date`,
    [userId, fromStr, toStr]
  );
  const submitted = Number(subRes.rows[0]?.count ?? 0);

  const missedRaw = expected - submitted;
  const missed = missedRaw > 0 ? Math.round(missedRaw * 10) / 10 : 0;
  const penaltyPct = Math.min(100, Math.round(missed * 10) / 10);
  return {
    expected: Math.round(expected * 10) / 10,
    submitted,
    missed,
    penaltyPct,
    effectiveStart: fromStr,
  };
}

export async function getKraReport(userId: string, month: number, year: number): Promise<KraReport | null> {
  const userRes = await pool.query<{ full_name: string; team_joined_at: string | null }>(
    `SELECT full_name, team_joined_at FROM users WHERE id = $1`, [userId]
  );
  if (!userRes.rows[0]) return null;
  const params   = await listKraParameters();
  const self     = await getSelfAppraisal(userId, month, year);
  const peers    = await getPeerMarkingsForUser(userId, month, year);
  const admin    = await getAdminKraScore(userId, month, year);
  const peerAvg  = avgScores(peers);
  const composite = compositeScore(self?.scores || null, peerAvg, admin?.scores || null, params);
  const penalty  = await computeMissedReportPenalty(userId, month, year);
  const manualPct = admin?.manual_penalty_percent ?? 0;
  const override = admin?.total_penalty_override ?? null;
  const totalPct = override !== null
    ? Math.max(0, Math.min(100, Math.round(override * 10) / 10))
    : Math.min(100, Math.round((penalty.penaltyPct + manualPct) * 10) / 10);
  const compositeAfter = composite === null
    ? null
    : Math.max(0, Math.round(composite * (1 - totalPct / 100) * 10) / 10);
  return {
    user_id: userId, user_name: userRes.rows[0].full_name, month, year,
    self_appraisal: self, peer_average: peerAvg, peer_count: peers.length,
    admin_score: admin, composite_score: composite,
    team_joined_at: userRes.rows[0].team_joined_at ?? null,
    kra_window_start: penalty.effectiveStart,
    expected_report_days: penalty.expected,
    submitted_report_days: penalty.submitted,
    missed_report_days: penalty.missed,
    penalty_percent: penalty.penaltyPct,
    manual_penalty_percent: manualPct,
    manual_penalty_reason: admin?.manual_penalty_reason ?? '',
    total_penalty_override: override,
    total_penalty_override_reason: admin?.total_penalty_override_reason ?? '',
    total_penalty_percent: totalPct,
    composite_score_after_penalty: compositeAfter,
    is_final_pushed: admin?.is_final_pushed ?? false,
  };
}

export async function getAdminKraDashboard(month: number, year: number): Promise<KraReport[]> {
  const users = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE team = 'branding' AND role != 'super_admin' ORDER BY full_name ASC`
  );
  const reports: KraReport[] = [];
  for (const u of users.rows) {
    const r = await getKraReport(u.id, month, year);
    if (r) reports.push(r);
  }
  return reports;
}

// ── Design gallery ─────────────────────────────────────────────────────────

export interface BrandingDesign {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  image_url: string;
  uploader_id: string;
  uploader_name: string;
  created_at: string;
  upvotes: number;
  downvotes: number;
  user_vote: "up" | "down" | null;
}

export interface DesignVoter {
  user_id: string;
  user_name: string;
  vote_type: "up" | "down";
  voted_at: string;
}

interface DesignRow {
  id: string; title: string; description: string; category: string;
  tags: string[]; image_url: string;
  uploader_id: string; uploader_name: string; created_at: string;
  upvotes: string; downvotes: string; user_vote: "up" | "down" | null;
}

export async function listBrandingDesigns(filters?: {
  search?: string; category?: string; uploaderId?: string;
  dateFrom?: string; dateTo?: string;
}, currentUserId?: string): Promise<BrandingDesign[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  // current user id always comes first so subqueries can reference it
  params.push(currentUserId ?? null); // $1
  i = 2;

  if (filters?.search) {
    conditions.push(`(LOWER(d.title) LIKE $${i} OR LOWER(d.description) LIKE $${i} OR EXISTS (SELECT 1 FROM unnest(d.tags) t WHERE LOWER(t) LIKE $${i}))`);
    params.push(`%${filters.search.toLowerCase()}%`); i++;
  }
  if (filters?.category) {
    conditions.push(`d.category = $${i}`); params.push(filters.category); i++;
  }
  if (filters?.uploaderId) {
    conditions.push(`d.uploader_id = $${i}`); params.push(filters.uploaderId); i++;
  }
  if (filters?.dateFrom) {
    conditions.push(`d.created_at >= $${i}::date`); params.push(filters.dateFrom); i++;
  }
  if (filters?.dateTo) {
    conditions.push(`d.created_at < ($${i}::date + interval '1 day')`); params.push(filters.dateTo); i++;
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await pool.query<DesignRow>(
    `SELECT d.*,
       (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id = d.id AND vote_type = 'up') AS upvotes,
       (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id = d.id AND vote_type = 'down') AS downvotes,
       (SELECT vote_type FROM branding_design_votes WHERE design_id = d.id AND user_id = $1) AS user_vote
     FROM branding_designs d ${where} ORDER BY d.created_at DESC`,
    params
  );
  return result.rows.map(r => ({
    ...r,
    upvotes: Number(r.upvotes),
    downvotes: Number(r.downvotes),
    user_vote: r.user_vote ?? null,
  }));
}

export async function createBrandingDesign(
  title: string, description: string, category: string,
  tags: string[], imageUrl: string, uploaderId: string, uploaderName: string
): Promise<BrandingDesign> {
  const id = generateId("des");
  const result = await pool.query<DesignRow>(
    `INSERT INTO branding_designs (id, title, description, category, tags, image_url, uploader_id, uploader_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, 0 AS upvotes, 0 AS downvotes, NULL::text AS user_vote`,
    [id, title, description, category, tags, imageUrl, uploaderId, uploaderName]
  );
  const r = result.rows[0];
  return { ...r, upvotes: Number(r.upvotes), downvotes: Number(r.downvotes), user_vote: null };
}

export async function deleteBrandingDesign(id: string): Promise<string | null> {
  const res = await pool.query<{ image_url: string }>(
    `DELETE FROM branding_designs WHERE id = $1 RETURNING image_url`, [id]
  );
  return res.rows[0]?.image_url ?? null;
}

export async function getBrandingDesignById(id: string): Promise<BrandingDesign | null> {
  const res = await pool.query<DesignRow>(
    `SELECT d.*,
       (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id = d.id AND vote_type = 'up') AS upvotes,
       (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id = d.id AND vote_type = 'down') AS downvotes,
       NULL::text AS user_vote
     FROM branding_designs d WHERE d.id = $1`,
    [id]
  );
  if (!res.rows[0]) return null;
  const r = res.rows[0];
  return { ...r, upvotes: Number(r.upvotes), downvotes: Number(r.downvotes), user_vote: null };
}

// vote_type null = remove existing vote; 'up'/'down' = upsert
export async function castDesignVote(
  designId: string, userId: string, voteType: "up" | "down" | null
): Promise<{ upvotes: number; downvotes: number; user_vote: "up" | "down" | null }> {
  if (voteType === null) {
    await pool.query(
      `DELETE FROM branding_design_votes WHERE design_id = $1 AND user_id = $2`,
      [designId, userId]
    );
  } else {
    const id = generateId("vote");
    await pool.query(
      `INSERT INTO branding_design_votes (id, design_id, user_id, vote_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (design_id, user_id) DO UPDATE SET vote_type = EXCLUDED.vote_type, voted_at = NOW()`,
      [id, designId, userId, voteType]
    );
  }
  const counts = await pool.query<{ upvotes: string; downvotes: string }>(
    `SELECT
       (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id = $1 AND vote_type = 'up') AS upvotes,
       (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id = $1 AND vote_type = 'down') AS downvotes`,
    [designId]
  );
  return {
    upvotes: Number(counts.rows[0].upvotes),
    downvotes: Number(counts.rows[0].downvotes),
    user_vote: voteType,
  };
}

export async function getDesignVoters(designId: string): Promise<DesignVoter[]> {
  const res = await pool.query<{ user_id: string; full_name: string; vote_type: string; voted_at: string }>(
    `SELECT v.user_id, u.full_name AS user_name, v.vote_type, v.voted_at
     FROM branding_design_votes v
     JOIN users u ON u.id = v.user_id
     WHERE v.design_id = $1
     ORDER BY v.voted_at DESC`,
    [designId]
  );
  return res.rows.map(r => ({
    user_id: r.user_id,
    user_name: r.full_name,
    vote_type: r.vote_type as "up" | "down",
    voted_at: r.voted_at,
  }));
}

// ── Super admin stats ──────────────────────────────────────────────────────

export interface BrandingPortalStats {
  designs_count: number;
  projects_count: number;
  today_submitted: number;
  today_total: number;
  recent_designs: Pick<BrandingDesign, 'id' | 'title' | 'image_url' | 'uploader_name' | 'created_at' | 'upvotes' | 'downvotes'>[];
}

export async function getBrandingPortalStats(): Promise<BrandingPortalStats> {
  const [designs, projects, reportStatus, recentRaw] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM branding_designs`),
    pool.query<{ count: string }>(`SELECT COUNT(*)::int AS count FROM branding_projects`),
    pool.query<{ total: string; submitted: string }>(
      `SELECT
         COUNT(DISTINCT u.id)::int AS total,
         COUNT(DISTINCT dr.user_id)::int AS submitted
       FROM users u
       LEFT JOIN daily_reports dr
         ON dr.user_id = u.id AND dr.report_date = CURRENT_DATE AND dr.is_locked = true
       WHERE u.team = 'branding' AND u.role IN ('user','sub_admin')`
    ),
    pool.query<{ id: string; title: string; image_url: string; uploader_name: string; created_at: string }>(
      `SELECT d.id, d.title, d.image_url, d.uploader_name, d.created_at
       FROM branding_designs d ORDER BY d.created_at DESC LIMIT 4`
    ),
  ]);

  const recentDesigns = await Promise.all(
    recentRaw.rows.map(async r => {
      const votes = await pool.query<{ upvotes: string; downvotes: string }>(
        `SELECT
           (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id=$1 AND vote_type='up') AS upvotes,
           (SELECT COUNT(*)::int FROM branding_design_votes WHERE design_id=$1 AND vote_type='down') AS downvotes`,
        [r.id]
      );
      return {
        ...r,
        upvotes: Number(votes.rows[0].upvotes),
        downvotes: Number(votes.rows[0].downvotes),
      };
    })
  );

  return {
    designs_count: Number(designs.rows[0].count),
    projects_count: Number(projects.rows[0].count),
    today_submitted: Number(reportStatus.rows[0].submitted),
    today_total: Number(reportStatus.rows[0].total),
    recent_designs: recentDesigns,
  };
}

// ── Team lead: report status ───────────────────────────────────────────────

export interface MemberReportStatus {
  user_id: string;
  user_name: string;
  user_email: string;
  role: string;
  has_submitted: boolean;
}

export async function getTeamReportStatus(date: string, managedBy: string | null): Promise<MemberReportStatus[]> {
  const result = await pool.query<{
    id: string; full_name: string; email: string; role: string;
    is_locked: boolean | null;
  }>(
    `SELECT u.id, u.full_name, u.email, u.role,
            dr.is_locked
     FROM users u
     LEFT JOIN daily_reports dr
       ON dr.user_id = u.id AND dr.report_date = $1::date
     WHERE u.team = 'branding'
       AND u.role IN ('user', 'sub_admin')
       AND ($2::uuid IS NULL OR u.managed_by = $2::uuid OR u.id = $2::uuid)
     ORDER BY u.role DESC, u.full_name ASC`,
    [date, managedBy]
  );
  return result.rows.map(r => ({
    user_id: r.id,
    user_name: r.full_name,
    user_email: r.email,
    role: r.role,
    has_submitted: r.is_locked === true,
  }));
}

// ── Projects ───────────────────────────────────────────────────────────────

export interface BrandingProject {
  id: string;
  name: string;
  description: string;
  deadline: string | null;
  status: "active" | "completed" | "on_hold";
  created_by: string;
  created_at: string;
  assigned_user_ids: string[];
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  deadline: string | null;
  status: string;
  created_by: string;
  created_at: string;
}

export async function listBrandingProjects(): Promise<BrandingProject[]> {
  const projects = await pool.query<ProjectRow>(
    `SELECT * FROM branding_projects ORDER BY created_at DESC`
  );
  const assignments = await pool.query<{ project_id: string; user_id: string }>(
    `SELECT project_id, user_id FROM branding_project_assignments`
  );
  return projects.rows.map(p => ({
    ...p,
    status: p.status as BrandingProject["status"],
    assigned_user_ids: assignments.rows
      .filter(a => a.project_id === p.id)
      .map(a => a.user_id),
  }));
}

export async function createBrandingProject(
  name: string,
  description: string,
  deadline: string | null,
  createdBy: string,
  assignedUserIds: string[]
): Promise<BrandingProject> {
  const id = generateId("proj");
  await pool.query(
    `INSERT INTO branding_projects (id, name, description, deadline, created_by)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, name, description, deadline || null, createdBy]
  );
  for (const userId of assignedUserIds) {
    await pool.query(
      `INSERT INTO branding_project_assignments (id, project_id, user_id, assigned_by)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [generateId("pa"), id, userId, createdBy]
    );
  }
  const all = await listBrandingProjects();
  return all.find(p => p.id === id)!;
}

export async function updateBrandingProject(
  id: string,
  name: string,
  description: string,
  deadline: string | null,
  status: BrandingProject["status"],
  assignedUserIds: string[],
  adminId: string
): Promise<BrandingProject | null> {
  const res = await pool.query<ProjectRow>(
    `UPDATE branding_projects SET name=$2, description=$3, deadline=$4, status=$5
     WHERE id=$1 RETURNING *`,
    [id, name, description, deadline || null, status]
  );
  if (!res.rows[0]) return null;
  // Replace all assignments
  await pool.query(`DELETE FROM branding_project_assignments WHERE project_id = $1`, [id]);
  for (const userId of assignedUserIds) {
    await pool.query(
      `INSERT INTO branding_project_assignments (id, project_id, user_id, assigned_by)
       VALUES ($1, $2, $3, $4)`,
      [generateId("pa"), id, userId, adminId]
    );
  }
  const all = await listBrandingProjects();
  return all.find(p => p.id === id) ?? null;
}

export async function deleteBrandingProject(id: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM branding_projects WHERE id = $1`, [id]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Report row comments ────────────────────────────────────────────────────
// Leads leave per-row feedback on a managed member's daily report. The member
// sees the thread inline on their own dashboard. Authorization is enforced at
// the route layer (lead must manage the row's owner, or be an admin).

export interface ReportRowComment {
  id: string;
  row_id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

interface RowCommentDbRow {
  id: string;
  row_id: string;
  author_id: string;
  body: string;
  created_at: string;
  updated_at: string;
  author_name: string;
}

export async function listRowComments(rowIds: string[]): Promise<ReportRowComment[]> {
  if (rowIds.length === 0) return [];
  const res = await pool.query<RowCommentDbRow>(
    `SELECT c.*, u.full_name AS author_name
       FROM branding_report_row_comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.row_id = ANY($1::text[])
      ORDER BY c.created_at ASC`,
    [rowIds]
  );
  return res.rows;
}

// Returns { ownerUserId, reportDate, isLocked } for a row so the route can
// authorize the operation without re-querying.
export async function getRowOwner(rowId: string): Promise<{
  ownerUserId: string;
  reportDate: string;
  isLocked: boolean;
} | null> {
  const res = await pool.query<{ user_id: string; report_date: string; is_locked: boolean }>(
    `SELECT dr.user_id, dr.report_date, dr.is_locked
       FROM daily_report_rows drr
       JOIN daily_reports dr ON dr.id = drr.report_id
      WHERE drr.id = $1`,
    [rowId]
  );
  if (!res.rows[0]) return null;
  return {
    ownerUserId: res.rows[0].user_id,
    reportDate: normalizeDate(res.rows[0].report_date),
    isLocked: res.rows[0].is_locked,
  };
}

export async function createRowComment(
  rowId: string,
  authorId: string,
  body: string,
): Promise<ReportRowComment> {
  const id = generateId("rrc");
  await pool.query(
    `INSERT INTO branding_report_row_comments (id, row_id, author_id, body)
     VALUES ($1, $2, $3, $4)`,
    [id, rowId, authorId, body]
  );
  const res = await pool.query<RowCommentDbRow>(
    `SELECT c.*, u.full_name AS author_name
       FROM branding_report_row_comments c
       JOIN users u ON u.id = c.author_id
      WHERE c.id = $1`,
    [id]
  );
  return res.rows[0];
}

export async function updateRowComment(
  id: string,
  authorId: string,
  body: string,
): Promise<ReportRowComment | null> {
  const res = await pool.query<RowCommentDbRow>(
    `UPDATE branding_report_row_comments
        SET body = $1, updated_at = NOW()
      WHERE id = $2 AND author_id = $3
      RETURNING id, row_id, author_id, body, created_at, updated_at,
                (SELECT full_name FROM users WHERE id = $3) AS author_name`,
    [body, id, authorId]
  );
  return res.rows[0] ?? null;
}

export async function deleteRowComment(id: string, authorId: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM branding_report_row_comments WHERE id = $1 AND author_id = $2`,
    [id, authorId]
  );
  return (res.rowCount ?? 0) > 0;
}

// ── Leave functions ────────────────────────────────────────────────────────

interface LeaveDbRow {
  id: string; user_id: string; leave_date: string; reason: string;
  status: string; transfer_date: string | null; reviewed_by: string | null;
  reviewed_at: string | null; created_at: string;
  start_at: string | null; end_at: string | null;
  is_half_day: boolean; half_day_period: string | null;
  user_name?: string; user_email?: string;
}

function mapLeave(row: LeaveDbRow): BrandingLeave {
  const leaveDate = normalizeDate(row.leave_date);
  const startAt = row.start_at ?? `${leaveDate}T09:00:00.000Z`;
  const endAt = row.end_at ?? `${leaveDate}T17:00:00.000Z`;
  return {
    id: row.id,
    user_id: row.user_id,
    leave_date: leaveDate,
    start_at: typeof startAt === 'string' ? startAt : new Date(startAt).toISOString(),
    end_at: typeof endAt === 'string' ? endAt : new Date(endAt).toISOString(),
    is_half_day: !!row.is_half_day,
    half_day_period: (row.half_day_period === 'first' || row.half_day_period === 'second')
      ? row.half_day_period
      : null,
    reason: row.reason,
    status: row.status as BrandingLeave['status'],
    transfer_date: row.transfer_date ? normalizeDate(row.transfer_date) : null,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at,
    created_at: row.created_at,
    user_name: row.user_name,
    user_email: row.user_email,
  };
}

// First half: 09:00-13:00 same day. Second half: 14:00-17:00 same day.
function detectHalfDay(startIso: string, endIso: string): { is_half_day: boolean; period: HalfDayPeriod | null } {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return { is_half_day: false, period: null };
  const sameDay = s.getUTCFullYear() === e.getUTCFullYear()
    && s.getUTCMonth() === e.getUTCMonth()
    && s.getUTCDate() === e.getUTCDate();
  if (!sameDay) return { is_half_day: false, period: null };
  const sh = s.getUTCHours(), sm = s.getUTCMinutes();
  const eh = e.getUTCHours(), em = e.getUTCMinutes();
  if (sh === 9 && sm === 0 && eh === 13 && em === 0) return { is_half_day: true, period: 'first' };
  if (sh === 14 && sm === 0 && eh === 17 && em === 0) return { is_half_day: true, period: 'second' };
  return { is_half_day: false, period: null };
}

export async function applyLeave(
  userId: string,
  startAt: string,
  endAt: string,
  reason: string,
  transferDate?: string
): Promise<BrandingLeave> {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid start_at / end_at.");
  }
  if (end <= start) throw new Error("end_at must be after start_at.");

  const leaveDate = start.toISOString().split("T")[0];
  const { is_half_day, period } = detectHalfDay(startAt, endAt);

  const id = generateId("lv");
  const res = await pool.query<LeaveDbRow>(
    `INSERT INTO branding_leaves
       (id, user_id, leave_date, reason, transfer_date, start_at, end_at, is_half_day, half_day_period)
     VALUES ($1, $2, $3::date, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9)
     ON CONFLICT (user_id, leave_date)
     DO UPDATE SET reason = $4, transfer_date = $5, start_at = $6::timestamptz, end_at = $7::timestamptz,
                   is_half_day = $8, half_day_period = $9,
                   status = 'pending', reviewed_by = NULL, reviewed_at = NULL
     RETURNING *`,
    [id, userId, leaveDate, reason, transferDate ?? null, startAt, endAt, is_half_day, period]
  );
  return mapLeave(res.rows[0]);
}

export async function getUserLeaves(userId: string): Promise<BrandingLeave[]> {
  const res = await pool.query<LeaveDbRow>(
    `SELECT * FROM branding_leaves WHERE user_id = $1 ORDER BY leave_date DESC`,
    [userId]
  );
  return res.rows.map(mapLeave);
}

export async function getAllLeaves(status?: string): Promise<BrandingLeave[]> {
  let q = `SELECT l.*, u.full_name AS user_name, u.email AS user_email
           FROM branding_leaves l
           JOIN users u ON l.user_id = u.id`;
  const params: unknown[] = [];
  if (status) { q += ` WHERE l.status = $1`; params.push(status); }
  q += ` ORDER BY l.leave_date DESC`;
  const res = await pool.query<LeaveDbRow>(q, params);
  return res.rows.map(mapLeave);
}

export async function reviewLeave(
  leaveId: string, adminId: string, status: 'approved' | 'rejected'
): Promise<BrandingLeave | null> {
  const res = await pool.query<LeaveDbRow>(
    `UPDATE branding_leaves SET status = $2, reviewed_by = $3, reviewed_at = NOW()
     WHERE id = $1 RETURNING *`,
    [leaveId, status, adminId]
  );
  return res.rows[0] ? mapLeave(res.rows[0]) : null;
}

export async function updateLeaveTransfer(
  leaveId: string, _adminId: string, transferDate: string | null
): Promise<BrandingLeave | null> {
  const res = await pool.query<LeaveDbRow>(
    `UPDATE branding_leaves SET transfer_date = $2
     WHERE id = $1 RETURNING *`,
    [leaveId, transferDate]
  );
  return res.rows[0] ? mapLeave(res.rows[0]) : null;
}

export async function cancelLeave(leaveId: string, userId: string): Promise<boolean> {
  const res = await pool.query(
    `DELETE FROM branding_leaves WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [leaveId, userId]
  );
  return (res.rowCount ?? 0) > 0;
}

export async function getLeaveForDate(userId: string, date: string): Promise<BrandingLeave | null> {
  const res = await pool.query<LeaveDbRow>(
    `SELECT * FROM branding_leaves WHERE user_id = $1 AND leave_date = $2::date`,
    [userId, date]
  );
  return res.rows[0] ? mapLeave(res.rows[0]) : null;
}
