/* ═══════════════════════════════════════════════════════════════════════════
   NERVE MEDIA OPS — SHARED DETERMINISTIC QUERIES

   The data-access layer that more than one caller needs. It exists because the
   AI layer must never own business logic and must never hold a database handle:
   an AI tool calls a function here, and so does the automation runner, so both
   are answering from the same definition rather than two copies that drift.

   Nothing here knows about AI. These are ordinary Nerve queries.

   PERMISSION NOTE — scoping is applied here, in SQL, from a scope object the
   CALLER constructs out of the existing permission helpers. This module does not
   decide what anyone may see; it enforces a decision already made.
   ═══════════════════════════════════════════════════════════════════════════ */

import { pool } from "./db.js";

/* ── Dates ────────────────────────────────────────────────────────────────
   Nerve runs on a local calendar day, not a UTC one. The client computes it as
   a local date (index.html: `TODAY`), and Postgres CURRENT_DATE resolves in the
   database's Asia/Kolkata session timezone — both agree.

   `new Date().toISOString().slice(0,10)` does NOT agree: east of Greenwich it
   returns yesterday for the whole early morning. Anything date-shaped in this
   file therefore goes through nerveToday(), and never through toISOString(). */

export const NERVE_TIME_ZONE = "Asia/Kolkata";

/** Today's calendar date in the application's timezone, as YYYY-MM-DD. */
export function nerveToday(timeZone: string = NERVE_TIME_ZONE, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, so no manual assembly is needed.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/** A DATE column arrives as a JS Date; render the calendar day that was stored. */
export function dateOnly(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date)
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
}

/* ── Identity ─────────────────────────────────────────────────────────────── */

export interface NerveUserIdentity {
  id: string;
  full_name: string;
  role: string;
  team: string | null;
  designation: string | null;
}

/**
 * The caller's own identity. Always keyed by an id the SERVER established from
 * the session — there is deliberately no variant that takes an arbitrary id,
 * so no caller can turn this into a people-directory lookup.
 */
export async function getUserIdentity(userId: string): Promise<NerveUserIdentity | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.full_name, u.role, u.team, p.designation
       FROM users u LEFT JOIN mo_user_profiles p ON p.user_id = u.id
      WHERE u.id = $1`, [userId]);
  const r = rows[0];
  return r ? { id: r.id, full_name: r.full_name, role: r.role, team: r.team ?? null,
               designation: r.designation ?? null } : null;
}

/* ── My Day ───────────────────────────────────────────────────────────────
   Mirrors what the My Day page already computes client-side (myAssignments,
   scheduledDeliverables, scheduledShoots, todaysLogTasks), expressed in SQL so
   a server caller can reach the same answer. The page is untouched; this is a
   second reader of the same tables, not a second definition of the day. */

/** Deliverable states that are finished. Matches DELIV_DONE in the client and
    the exclusion list AUTO-2 has always used. */
export const DELIVERABLE_DONE_STATES = ["delivered", "not_required", "cancelled"] as const;

export interface MyDayItem {
  source: "assignment" | "deliverable" | "shoot";
  id: number;
  title: string;
  projectCode: string | null;
  projectName: string | null;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  startTime: string | null;
}

export interface MyDay {
  date: string;
  report: { status: string; taskCount: number; totalMinutes: number };
  items: MyDayItem[];
}

/**
 * One person's scheduled day.
 *
 * Self-scoped by construction: userId is the only way in, and every branch
 * filters on it. There is no parameter that could widen it to someone else.
 */
export async function getMyDay(userId: string, date?: string): Promise<MyDay> {
  const day = date ?? nerveToday();

  const [assignments, deliverables, shoots, report] = await Promise.all([
    // Ad-hoc assignments scheduled across the day. Mirrors inSchedule(): an
    // undated assignment is active, a half-dated one is open-ended on that side.
    pool.query(
      `SELECT a.id, a.title, a.status, a.priority, a.due_date, a.start_time,
              p.code AS project_code, p.name AS project_name
         FROM mo_assignments a
         JOIN mo_assignment_users au ON au.assignment_id = a.id AND au.user_id = $1
         LEFT JOIN mo_projects p ON p.id = a.project_id
        WHERE a.status IS DISTINCT FROM 'cancelled'
          AND a.is_smc IS NOT TRUE
          AND a.deliverable_id IS NULL
          AND ($2::date >= COALESCE(a.start_date, $2::date))
          AND ($2::date <= COALESCE(a.due_date,   $2::date))
        ORDER BY a.start_time NULLS LAST, a.id`, [userId, day]),
    // Deliverables the user owns that a lead scheduled for this day.
    pool.query(
      `SELECT d.id, d.title, d.status, d.priority, d.due_date,
              p.code AS project_code, p.name AS project_name
         FROM mo_deliverables d
         LEFT JOIN mo_projects p ON p.id = d.project_id
        WHERE d.owner_id = $1 AND d.deleted_at IS NULL
          AND d.scheduled_date = $2::date
          AND d.status <> ALL($3::text[])
        ORDER BY d.due_date NULLS LAST, d.id`, [userId, day, DELIVERABLE_DONE_STATES]),
    // Shoots the user is crewed on.
    pool.query(
      `SELECT s.id, s.title, s.status, s.shoot_date, s.call_time,
              p.code AS project_code, p.name AS project_name
         FROM mo_shoots s
         JOIN mo_shoot_crew c ON c.shoot_id = s.id AND c.user_id = $1
         LEFT JOIN mo_projects p ON p.id = s.project_id
        WHERE s.deleted_at IS NULL AND s.status <> 'cancelled'
          AND s.shoot_date = $2::date
        ORDER BY s.call_time NULLS LAST, s.id`, [userId, day]),
    // The day's own report: status and totals only, never the task descriptions.
    pool.query(
      `SELECT r.status, r.total_minutes,
              (SELECT COUNT(*)::int FROM mo_report_tasks t WHERE t.daily_report_id = r.id) AS task_count
         FROM mo_daily_reports r
        WHERE r.user_id = $1 AND r.report_date = $2::date`, [userId, day]),
  ]);

  const items: MyDayItem[] = [
    ...assignments.rows.map((r) => ({
      source: "assignment" as const, id: Number(r.id), title: String(r.title),
      projectCode: r.project_code ?? null, projectName: r.project_name ?? null,
      status: r.status ?? null, priority: r.priority ?? null,
      dueDate: dateOnly(r.due_date), startTime: r.start_time ?? null,
    })),
    ...deliverables.rows.map((r) => ({
      source: "deliverable" as const, id: Number(r.id), title: String(r.title),
      projectCode: r.project_code ?? null, projectName: r.project_name ?? null,
      status: r.status ?? null, priority: r.priority ?? null,
      dueDate: dateOnly(r.due_date), startTime: null,
    })),
    ...shoots.rows.map((r) => ({
      source: "shoot" as const, id: Number(r.id), title: String(r.title),
      projectCode: r.project_code ?? null, projectName: r.project_name ?? null,
      status: r.status ?? null, priority: null,
      dueDate: dateOnly(r.shoot_date), startTime: r.call_time ?? null,
    })),
  ];

  const rep = report.rows[0];
  return {
    date: day,
    report: {
      // "none" rather than null: a day with no report is a state, not missing data.
      status: rep?.status ?? "none",
      taskCount: Number(rep?.task_count ?? 0),
      totalMinutes: Number(rep?.total_minutes ?? 0),
    },
    items,
  };
}

/* ── Overdue deliverables (AUTO-2's definition, shared) ───────────────────
   Extracted VERBATIM from runMediaOpsAutomations(). The predicate below is the
   one AUTO-2 has always used, character for character:

       deleted_at IS NULL
       due_date < CURRENT_DATE                  → due today is NOT overdue
       status NOT IN (delivered/not_required/cancelled)
       owner_id IS NOT NULL                     → AUTO-2 notifies an owner

   The automation now calls this instead of holding its own copy. Anything that
   changes the definition changes it for both callers at once, which is the
   entire point of the extraction. */

export interface OverdueDeliverable {
  id: number;
  title: string;
  status: string;
  priority: string | null;
  dueDate: string | null;
  daysOverdue: number;
  ownerId: string;
  ownerName: string | null;
  projectId: number | null;
  projectCode: string | null;
  projectName: string | null;
  /** The project's PM, used by AUTO-2's 3-day escalation. */
  projectManagerId: string | null;
}

/**
 * Who may see which overdue deliverables.
 *
 * Mirrors visibleProjects() in the client, which is Nerve's existing rule for
 * project-scoped data:
 *   - "all"  → Admin and Team Lead. The client comments this as §16: production
 *              history is departmental knowledge.
 *   - "user" → an Employee (and anyone who resolves to one, including an SMC
 *              member and the Coordinator): work they own, plus work on projects
 *              they own or are assigned to.
 *
 * The caller builds this from the existing permission helpers. Nothing here
 * inspects a role.
 */
export type DeliverableScope =
  | { kind: "all" }
  | { kind: "user"; userId: string };

export async function findOverdueDeliverables(
  scope: DeliverableScope,
  opts: { limit?: number } = {},
): Promise<OverdueDeliverable[]> {
  const vals: unknown[] = [];
  let scopeSql = "";
  if (scope.kind === "user") {
    vals.push(scope.userId);
    // Owned by them, OR on a project they own / are assigned to — the SQL form of
    // visibleProjects(), and the same shape /activity/recent already uses.
    scopeSql = `
      AND (d.owner_id = $1 OR d.project_id IN (
            SELECT p2.id FROM mo_projects p2
             WHERE p2.deleted_at IS NULL
               AND (p2.owner_id = $1
                 OR EXISTS (SELECT 1 FROM mo_project_assignments a2
                             WHERE a2.project_id = p2.id AND a2.user_id = $1
                               AND a2.removed_at IS NULL))))`;
  }
  const limitSql = opts.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";

  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.status, d.priority, d.due_date, d.owner_id, d.project_id,
            (CURRENT_DATE - d.due_date) AS days_over,
            ow.full_name AS owner_name,
            p.code AS project_code, p.name AS project_name,
            (SELECT a.user_id FROM mo_project_assignments a
              WHERE a.project_id = d.project_id AND a.is_project_manager
                AND a.removed_at IS NULL LIMIT 1) AS pm
       FROM mo_deliverables d
       LEFT JOIN mo_projects p ON p.id = d.project_id
       LEFT JOIN users ow      ON ow.id = d.owner_id
      WHERE d.deleted_at IS NULL AND d.due_date < CURRENT_DATE
        AND d.status NOT IN ('delivered','not_required','cancelled')
        AND d.owner_id IS NOT NULL${scopeSql}
      ORDER BY d.due_date ASC, d.id ASC${limitSql}`, vals);

  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title),
    status: String(r.status),
    priority: r.priority ?? null,
    dueDate: dateOnly(r.due_date),
    daysOverdue: Number(r.days_over),
    ownerId: String(r.owner_id),
    ownerName: r.owner_name ?? null,
    projectId: r.project_id == null ? null : Number(r.project_id),
    projectCode: r.project_code ?? null,
    projectName: r.project_name ?? null,
    projectManagerId: r.pm == null ? null : String(r.pm),
  }));
}

/** Total matching the same predicate, so a truncated list can still report scale. */
export async function countOverdueDeliverables(scope: DeliverableScope): Promise<number> {
  const all = await findOverdueDeliverables(scope);
  return all.length;
}

/* ═══════════════════════════════════════════════════════════════════════════
   AI REQUEST METERING

   Lives here, not in server/ai/, for the same reason every other query does:
   the AI layer holds no database handle. The route records; the AI layer never
   knows this exists.
   ═══════════════════════════════════════════════════════════════════════════ */

/** The closed set of safe failure categories. Never an exception message. */
export const AI_FAILURE_CATEGORIES = [
  "not_configured", "unauthorized", "rate_limited", "daily_limit",
  "invalid_request", "provider_timeout", "provider_error",
  "tool_error", "orchestration_timeout",
] as const;
export type AiFailureCategory = (typeof AI_FAILURE_CATEGORIES)[number];

export interface AiRequestRecord {
  requestId: string;
  userId: string;
  feature?: string;
  provider?: string | null;
  model?: string | null;
  status: "ok" | "failed";
  failureCategory?: AiFailureCategory | null;
  stopReason?: string | null;
  durationMs?: number | null;
  /** Tool NAMES only. */
  tools?: string[];
  toolRounds?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  estimatedCost?: number | null;
  questionChars?: number | null;
}

/**
 * Record one AI request.
 *
 * WHAT IS NOT STORED, and why:
 *
 *   The question itself — storing it would turn a metering table into a
 *   conversation archive, and questions to an operational assistant name people
 *   and projects ("is Priya overloaded?"). Length is kept instead, which
 *   answers the operational question (is someone pasting documents?) without
 *   retaining content.
 *
 *   A hash of the question — offered as an option, and rejected. A SHA of short
 *   natural-language text is not anonymous: the space of plausible questions is
 *   small enough to enumerate, so a fingerprint would read as a privacy control
 *   while providing none. Storing nothing is honest; storing a reversible hash
 *   is not.
 *
 *   Tool arguments, tool results, model responses, API keys, headers.
 *
 * Never throws into the request path — a metering failure must not fail a
 * request that already succeeded, exactly as audit() behaves.
 */
export async function recordAiRequest(rec: AiRequestRecord): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO mo_ai_requests (request_id, user_id, feature, local_date, provider, model,
         status, failure_category, stop_reason, duration_ms, tools, tool_rounds,
         prompt_tokens, completion_tokens, total_tokens, estimated_cost, question_chars)
       VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (request_id) DO NOTHING`,
      [rec.requestId, rec.userId, rec.feature ?? "ask", nerveToday(),
       rec.provider ?? null, rec.model ?? null, rec.status,
       rec.failureCategory ?? null, rec.stopReason ?? null, rec.durationMs ?? null,
       JSON.stringify(rec.tools ?? []), rec.toolRounds ?? null,
       rec.promptTokens ?? null, rec.completionTokens ?? null, rec.totalTokens ?? null,
       rec.estimatedCost ?? null, rec.questionChars ?? null]);
  } catch { /* metering must never break a request */ }
}

/**
 * How many requests this user has made today, in Nerve's timezone.
 *
 * Counts every ATTEMPT that reached the provider stage, successful or not — a
 * failed provider call still costs time and may still have been billed, so
 * excluding failures would let a broken key buy unlimited retries.
 */
export async function countAiRequestsToday(userId: string, day?: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS c FROM mo_ai_requests WHERE user_id=$1 AND local_date=$2::date`,
    [userId, day ?? nerveToday()]);
  return Number(rows[0]?.c ?? 0);
}

export interface AiUsageSummary {
  today: { requests: number; failed: number; totalTokens: number | null };
  month: { requests: number; failed: number; totalTokens: number | null; estimatedCost: number | null };
  byUser: Array<{ userId: string; userName: string | null; requests: number; totalTokens: number | null }>;
  byModel: Array<{ provider: string | null; model: string | null; requests: number; totalTokens: number | null }>;
  byFailure: Array<{ category: string; count: number }>;
}

/** Aggregate usage for an administrator. No per-request rows, no questions. */
export async function getAiUsageSummary(): Promise<AiUsageSummary> {
  const day = nerveToday();
  const monthStart = day.slice(0, 8) + "01";
  const num = (v: unknown) => (v == null ? null : Number(v));

  const [today, month, byUser, byModel, byFailure] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              SUM(total_tokens)::bigint AS tokens
         FROM mo_ai_requests WHERE local_date=$1::date`, [day]),
    pool.query(
      `SELECT COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE status='failed')::int AS failed,
              SUM(total_tokens)::bigint AS tokens,
              SUM(estimated_cost) AS cost
         FROM mo_ai_requests WHERE local_date >= $1::date`, [monthStart]),
    pool.query(
      `SELECT r.user_id, u.full_name, COUNT(*)::int AS requests, SUM(r.total_tokens)::bigint AS tokens
         FROM mo_ai_requests r LEFT JOIN users u ON u.id = r.user_id
        WHERE r.local_date >= $1::date
        GROUP BY r.user_id, u.full_name ORDER BY COUNT(*) DESC LIMIT 50`, [monthStart]),
    pool.query(
      `SELECT provider, model, COUNT(*)::int AS requests, SUM(total_tokens)::bigint AS tokens
         FROM mo_ai_requests WHERE local_date >= $1::date
        GROUP BY provider, model ORDER BY COUNT(*) DESC LIMIT 20`, [monthStart]),
    pool.query(
      `SELECT failure_category AS category, COUNT(*)::int AS count
         FROM mo_ai_requests
        WHERE local_date >= $1::date AND failure_category IS NOT NULL
        GROUP BY failure_category ORDER BY COUNT(*) DESC`, [monthStart]),
  ]);

  return {
    today: { requests: today.rows[0].requests, failed: today.rows[0].failed,
             totalTokens: num(today.rows[0].tokens) },
    month: { requests: month.rows[0].requests, failed: month.rows[0].failed,
             totalTokens: num(month.rows[0].tokens), estimatedCost: num(month.rows[0].cost) },
    byUser: byUser.rows.map((r) => ({ userId: String(r.user_id), userName: r.full_name ?? null,
                                      requests: r.requests, totalTokens: num(r.tokens) })),
    byModel: byModel.rows.map((r) => ({ provider: r.provider ?? null, model: r.model ?? null,
                                        requests: r.requests, totalTokens: num(r.tokens) })),
    byFailure: byFailure.rows.map((r) => ({ category: String(r.category), count: r.count })),
  };
}
