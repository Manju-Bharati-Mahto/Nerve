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
}

export interface SaveRowInput {
  sr_no: number;
  type_of_work: string;
  sub_category: string;
  specific_work: string;
  time_taken: string;
  collaborative_colleagues: string[];
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
  is_final_pushed: boolean;
}

export interface BrandingLeave {
  id: string;
  user_id: string;
  leave_date: string;          // YYYY-MM-DD
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
  if (d instanceof Date) return d.toISOString().split("T")[0];
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
    return { ...existing.rows[0], rows, report_date: normalizeDate(existing.rows[0].report_date) };
  }
  const id = generateId("dr");
  const result = await pool.query<ReportDbRow>(
    `INSERT INTO daily_reports (id, user_id, report_date) VALUES ($1, $2, $3::date) RETURNING *`,
    [id, userId, date]
  );
  return { ...result.rows[0], rows: [], report_date: normalizeDate(result.rows[0].report_date) };
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

export async function saveReportRows(reportId: string, userId: string, rows: SaveRowInput[]): Promise<DailyReportRow[] | null> {
  const report = await pool.query<ReportDbRow>(
    `SELECT * FROM daily_reports WHERE id = $1 AND user_id = $2`,
    [reportId, userId]
  );
  if (!report.rows[0] || report.rows[0].is_locked) return null;

  await pool.query(`DELETE FROM daily_report_rows WHERE report_id = $1`, [reportId]);
  const saved: DailyReportRow[] = [];
  for (const row of rows) {
    const id = generateId("drr");
    const res = await pool.query<ReportRowDb>(
      `INSERT INTO daily_report_rows
         (id, report_id, sr_no, type_of_work, sub_category, specific_work, time_taken, collaborative_colleagues)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [id, reportId, row.sr_no, row.type_of_work, row.sub_category,
       row.specific_work, row.time_taken, row.collaborative_colleagues]
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

export async function listAllDailyReports(filters?: {
  userId?: string;
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

  // When a specific userId is given, filter by that user directly (no team filter needed —
  // access control is already enforced at the route level).
  // When no userId is given (admin fetching all), scope to the branding team.
  if (filters?.userId) {
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

  const toHours = (t: string) => {
    if (t === "30 min") return 0.5;
    const m = t.match(/^(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 0;
  };

  for (const report of reports) {
    for (const row of report.rows) {
      const h = toHours(row.time_taken);
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

export async function getAdminKraScore(userId: string, month: number, year: number): Promise<AdminKraScore | null> {
  const res = await pool.query<AdminKraRow>(
    `SELECT * FROM admin_kra_scores WHERE user_id = $1 AND month = $2 AND year = $3`,
    [userId, month, year]
  );
  return res.rows[0] || null;
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
  return res.rows[0];
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
  return res.rows[0];
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

export async function getKraReport(userId: string, month: number, year: number): Promise<KraReport | null> {
  const userRes = await pool.query<{ full_name: string }>(
    `SELECT full_name FROM users WHERE id = $1`, [userId]
  );
  if (!userRes.rows[0]) return null;
  const params   = await listKraParameters();
  const self     = await getSelfAppraisal(userId, month, year);
  const peers    = await getPeerMarkingsForUser(userId, month, year);
  const admin    = await getAdminKraScore(userId, month, year);
  const peerAvg  = avgScores(peers);
  const composite = compositeScore(self?.scores || null, peerAvg, admin?.scores || null, params);
  return {
    user_id: userId, user_name: userRes.rows[0].full_name, month, year,
    self_appraisal: self, peer_average: peerAvg, peer_count: peers.length,
    admin_score: admin, composite_score: composite,
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

// ── Leave functions ────────────────────────────────────────────────────────

interface LeaveDbRow {
  id: string; user_id: string; leave_date: string; reason: string;
  status: string; transfer_date: string | null; reviewed_by: string | null;
  reviewed_at: string | null; created_at: string;
  user_name?: string; user_email?: string;
}

function mapLeave(row: LeaveDbRow): BrandingLeave {
  return {
    ...row,
    status: row.status as BrandingLeave['status'],
    leave_date: normalizeDate(row.leave_date),
    transfer_date: row.transfer_date ? normalizeDate(row.transfer_date) : null,
  };
}

export async function applyLeave(
  userId: string, leaveDate: string, reason: string, transferDate?: string
): Promise<BrandingLeave> {
  const id = generateId("lv");
  const res = await pool.query<LeaveDbRow>(
    `INSERT INTO branding_leaves (id, user_id, leave_date, reason, transfer_date)
     VALUES ($1, $2, $3::date, $4, $5)
     ON CONFLICT (user_id, leave_date)
     DO UPDATE SET reason = $4, transfer_date = $5, status = 'pending', reviewed_by = NULL, reviewed_at = NULL
     RETURNING *`,
    [id, userId, leaveDate, reason, transferDate ?? null]
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
  leaveId: string, userId: string, transferDate: string | null
): Promise<BrandingLeave | null> {
  const res = await pool.query<LeaveDbRow>(
    `UPDATE branding_leaves SET transfer_date = $3
     WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING *`,
    [leaveId, userId, transferDate]
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
