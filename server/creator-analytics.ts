/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — Phase 7: the analytics layer

   ANALYTICS IS DERIVED DATA. IT IS NOT A SOURCE OF TRUTH.

   Every figure this module produces is computed, on request, from the systems
   that own it:

     performance   mo_creator_point_ledger          (Phase 4)
     ranking       the Phase 4 rank engine
     work          mo_creator_assignments           (Phase 2)
     content       mo_creator_submissions           (Phase 3)
     money         mo_creator_financial_ledger, mo_creator_payouts (Phase 5)
     recognition   the Phase 6 achievement, cycle and competition tables

   THIS FILE CONTAINS NOTHING BUT SELECT. No INSERT, no UPDATE, no DELETE —
   asserted by a test that reads this source. There is no snapshot table and no
   materialised view: §34 says caches come after profiling shows they are
   needed, and direct SQL is well inside budget at this network's size.

   Two disciplines run through it:

     ONE QUERY PER SECTION. A dashboard for a thousand creators is a handful of
     grouped aggregates, never a query per creator.

     EVERY NUMBER HAS A STATED FORMULA. The metric dictionary in
     docs/CREATOR_NETWORK.md defines each one, its source and its time window;
     the comments here say the same thing beside the SQL.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { Pool } from "pg";

export const NERVE_TZ = "Asia/Kolkata";

/* ── Scope ────────────────────────────────────────────────────────────────
   Resolved by the caller from the session (Phase 1's creatorScopeOf) and
   passed in. This module never decides who may see what; it only narrows the
   SQL to what it was told. */
export type AnalyticsScope =
  | { level: "all" }
  | { level: "team"; teamIds: number[]; userId: string }
  | { level: "self"; userId: string };

/** Money is Creator Admin territory — Phase 5 gave Team Leads none of it. */
export const seesMoney = (s: AnalyticsScope) => s.level === "all";

/* ── Time ─────────────────────────────────────────────────────────────────
   Every window is a range of IST CALENDAR DAYS, inclusive at both ends, and
   resolved on the server. The browser's clock decides nothing: a timestamp is
   compared as (ts AT TIME ZONE 'Asia/Kolkata')::date, the same conversion the
   rest of Nerve already uses for day boundaries. */
export type Range = { from: string; to: string; label: string; days: number; cycleId: number | null };

const DAY = 86_400_000;
const istToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: NERVE_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(now);
const shift = (day: string, byDays: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + byDays * DAY).toISOString().slice(0, 10);
const spanDays = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
const isDay = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ""));
/** A DATE column arrives as a JS Date — render the calendar day that was
    stored, exactly as mediaops-queries' dateOnly does. Slicing String(date)
    yields "Mon Sep 01", which is not a date at all. */
const dayOf = (v: unknown): string => {
  if (v instanceof Date)
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v ?? "").slice(0, 10);
};

/** The window a request asked for. Unknown values fall back to 30 days. */
export async function resolveRange(
  pool: Pool, q: Record<string, string | undefined>, now = new Date(),
): Promise<Range | { error: string }> {
  const today = istToday(now);
  const preset = String(q.range ?? "30d");

  if (preset === "custom") {
    const from = String(q.from ?? ""), to = String(q.to ?? "");
    if (!isDay(from) || !isDay(to)) return { error: "A custom range needs from and to as YYYY-MM-DD." };
    if (from > to) return { error: "The start of the range must be on or before its end." };
    // A bound on the span, because an unbounded scan is a denial of service
    // dressed as a date picker.
    if (spanDays(from, to) > 730) return { error: "A custom range can cover at most two years." };
    return { from, to, label: `${from} to ${to}`, days: spanDays(from, to), cycleId: null };
  }

  if (preset === "cycle" || preset === "previous_cycle") {
    /* A cycle is a business object, not a date maths trick: its own
       starts_on/ends_on are the window, so "this cycle" on the dashboard is
       exactly the cycle Phase 4 scored. */
    const rows = (await pool.query(
      `SELECT id, label, starts_on, ends_on, status FROM mo_creator_cycles
        WHERE status IN ('active','closed') ORDER BY starts_on DESC, id DESC LIMIT 2`)).rows;
    const pick = preset === "cycle" ? rows[0] : rows[1];
    if (!pick) return { error: preset === "cycle" ? "No cycle has run yet." : "There is no previous cycle." };
    const from = dayOf(pick.starts_on), to = dayOf(pick.ends_on);
    return { from, to, label: String(pick.label), days: spanDays(from, to), cycleId: Number(pick.id) };
  }

  const days = preset === "today" ? 1 : preset === "7d" ? 7 : preset === "90d" ? 90 : 30;
  const from = shift(today, -(days - 1));
  return {
    from, to: today, days, cycleId: null,
    label: days === 1 ? "Today" : `Last ${days} days`,
  };
}

/** The comparable window immediately before this one, for trends. */
export function previousRange(r: Range): Range {
  const to = shift(r.from, -1);
  const from = shift(to, -(r.days - 1));
  return { from, to, days: r.days, label: `Previous ${r.days} days`, cycleId: null };
}

/* ── Trend ────────────────────────────────────────────────────────────────
   Two numbers and an honest verdict. There is no growth score and no grade:
   a trend says what changed, by how much, and refuses to say more than the
   data supports.

     no_baseline    nothing in the previous window to compare against
     insufficient   too few events either side for a direction to mean anything
     increasing     more than +5%
     decreasing     more than −5%
     stable         within ±5%

   The 5% deadband and the floor of 3 events are stated here and in the metric
   dictionary; they exist so ordinary noise is not reported as a movement. */
export const TREND_DEADBAND_PCT = 5;
export const TREND_MIN_EVENTS = 3;
export type Trend = {
  current: number; previous: number; change: number;
  change_pct: number | null;
  direction: "increasing" | "decreasing" | "stable" | "no_baseline" | "insufficient";
};
export function trend(current: number, previous: number, minEvents = TREND_MIN_EVENTS): Trend {
  const change = Math.round((current - previous) * 100) / 100;
  // Nothing to compare against. Not 0% growth — unknown, and said so.
  if (previous === 0) return { current, previous, change, change_pct: null, direction: "no_baseline" };
  if (current + previous < minEvents)
    return { current, previous, change, change_pct: null, direction: "insufficient" };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
  return { current, previous, change, change_pct: pct,
    direction: pct > TREND_DEADBAND_PCT ? "increasing"
             : pct < -TREND_DEADBAND_PCT ? "decreasing" : "stable" };
}

/** A rate, as a percentage, or null when the denominator is empty — a rate
    over nothing is not 0%, it is unknown, and the difference matters. */
export const rate = (num: number, den: number): number | null =>
  den > 0 ? Math.round((num / den) * 1000) / 10 : null;

/* ── Scope SQL ────────────────────────────────────────────────────────────
   One place builds the creator filter, so no query can quietly forget it.
   `col` is the column holding the creator's user id in that query. */
function scopeClause(scope: AnalyticsScope, col: string, params: unknown[]): string {
  if (scope.level === "all") return "";
  if (scope.level === "self") { params.push(scope.userId); return ` AND ${col} = $${params.length}`; }
  /* A Team Lead's analytics are their team's, resolved from current
     membership — "my team" means the people on it now. An assignment also
     carries the team it was stamped with, which is the historical record and
     is deliberately not what scopes a person-shaped query. */
  params.push(scope.teamIds, scope.userId);
  return ` AND (${col} IN (SELECT user_id FROM mo_creator_team_members
                            WHERE team_id = ANY($${params.length - 1}::bigint[]))
            OR ${col} = $${params.length})`;
}

/** The IST day-range predicate for a timestamp column. */
const inRange = (col: string, a: number, b: number) =>
  `(${col} AT TIME ZONE '${NERVE_TZ}')::date BETWEEN $${a} AND $${b}`;

/* ═══════════════════════════════════════════════════════════════════════════
   THE METRICS
   ═══════════════════════════════════════════════════════════════════════════ */

export type Production = {
  operationally_active: number;
  assignments: number; completed: number; submissions: number;
  reviewed: number; approved: number; changes_requested: number; rejected: number;
  approval_rate: number | null; revision_rate: number | null; rejection_rate: number | null;
  points: number;
};

/* Production in a window, for whatever the scope allows.

   ONE query. Each figure counts a different thing and is timed by a different
   column, which is exactly why they are spelled out rather than inferred:

     assignments        created in the window        created_at
     completed          marked complete in it        completed_at
     submissions        versions sent in it          submitted_at
     reviewed           verdicts given in it         reviewed_at
     approved / changes_requested / rejected — those verdicts, by outcome
     points             ledger movements in it       created_at

   OPERATIONALLY ACTIVE = completed an assignment OR submitted content in the
   window. It measures production, and it is never called simply "active":
   being on the network is a different number with a different name. */
export async function production(pool: Pool, scope: AnalyticsScope, r: Range): Promise<Production> {
  const p: unknown[] = [r.from, r.to];
  const aScope = scopeClause(scope, "a.user_id", p);
  const sScope = scopeClause(scope, "sa.user_id", p);
  const lScope = scopeClause(scope, "l.user_id", p);
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM mo_creator_assignments a
         WHERE ${inRange("a.created_at", 1, 2)}${aScope})                          AS assignments,
       (SELECT COUNT(*)::int FROM mo_creator_assignments a
         WHERE a.completed_at IS NOT NULL AND ${inRange("a.completed_at", 1, 2)}${aScope}) AS completed,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE ${inRange("s.submitted_at", 1, 2)}${sScope})                        AS submissions,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.reviewed_at IS NOT NULL AND ${inRange("s.reviewed_at", 1, 2)}${sScope}) AS reviewed,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.status='approved' AND s.reviewed_at IS NOT NULL
           AND ${inRange("s.reviewed_at", 1, 2)}${sScope})                          AS approved,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.status='changes_requested' AND s.reviewed_at IS NOT NULL
           AND ${inRange("s.reviewed_at", 1, 2)}${sScope})                          AS changes_requested,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.status='rejected' AND s.reviewed_at IS NOT NULL
           AND ${inRange("s.reviewed_at", 1, 2)}${sScope})                          AS rejected,
       (SELECT COALESCE(SUM(l.points),0)::int FROM mo_creator_point_ledger l
         WHERE ${inRange("l.created_at", 1, 2)}${lScope})                           AS points,
       (SELECT COUNT(*)::int FROM (
           SELECT a.user_id FROM mo_creator_assignments a
            WHERE a.completed_at IS NOT NULL AND ${inRange("a.completed_at", 1, 2)}${aScope}
           UNION
           SELECT sa.user_id FROM mo_creator_submissions s
             JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
            WHERE ${inRange("s.submitted_at", 1, 2)}${sScope}
         ) act)                                                                     AS operationally_active`,
    p);
  const x = rows[0];
  const n = (k: string) => Number(x[k]);
  return {
    operationally_active: n("operationally_active"),
    assignments: n("assignments"), completed: n("completed"), submissions: n("submissions"),
    reviewed: n("reviewed"), approved: n("approved"),
    changes_requested: n("changes_requested"), rejected: n("rejected"),
    approval_rate: rate(n("approved"), n("reviewed")),
    revision_rate: rate(n("changes_requested"), n("reviewed")),
    rejection_rate: rate(n("rejected"), n("reviewed")),
    points: n("points"),
  };
}

/* ── The funnel ───────────────────────────────────────────────────────────

   §16 is right that the distinction is critical, so it is stated plainly:
   THIS FUNNEL COUNTS UNIQUE ASSIGNMENTS, as a cohort created in the window,
   followed to wherever they have reached by now. One assignment appears in
   every stage it has passed, never twice in the same stage, and a resubmission
   does not inflate it.

   Review DECISIONS are counted separately in `production`, where the unit is
   a submission version. The two are different questions and are never added
   together. */
export type Funnel = {
  assigned: number; accepted: number; completed: number; submitted: number;
  approved: number; changes_requested: number; rejected: number; declined: number;
  completion_rate: number | null; submission_rate: number | null; approval_rate: number | null;
  first_pass_rate: number | null; avg_versions_to_approval: number | null;
};
export async function funnel(pool: Pool, scope: AnalyticsScope, r: Range): Promise<Funnel> {
  const p: unknown[] = [r.from, r.to];
  const aScope = scopeClause(scope, "a.user_id", p);
  const { rows } = await pool.query(
    `WITH cohort AS (
       SELECT a.id, a.status, a.completed_at, a.accepted_at
         FROM mo_creator_assignments a
        WHERE ${inRange("a.created_at", 1, 2)}${aScope}),
     work AS (
       SELECT c.id, c.status, c.completed_at, c.accepted_at,
              COUNT(s.id)                                              AS versions,
              COUNT(*) FILTER (WHERE s.id IS NOT NULL)  > 0            AS submitted,
              BOOL_OR(s.status='approved')                             AS approved,
              BOOL_OR(s.status='changes_requested')                    AS changed,
              BOOL_OR(s.status='rejected')                             AS rejected,
              /* FIRST-PASS APPROVAL: version 1 was approved. Because a version
                 is immutable and changes_requested is its own row, "V1 is
                 approved" is the same statement as "no revision was ever
                 asked for", and it is read from the history rather than from
                 the latest row. */
              BOOL_OR(s.version_no = 1 AND s.status='approved')        AS first_pass,
              MIN(s.version_no) FILTER (WHERE s.status='approved')     AS approved_version
         FROM cohort c
         LEFT JOIN mo_creator_submissions s ON s.assignment_id = c.id
        GROUP BY c.id, c.status, c.completed_at, c.accepted_at)
     SELECT COUNT(*)::int                                              AS assigned,
            COUNT(*) FILTER (WHERE accepted_at IS NOT NULL)::int       AS accepted,
            COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int      AS completed,
            COUNT(*) FILTER (WHERE submitted)::int                     AS submitted,
            COUNT(*) FILTER (WHERE approved)::int                      AS approved,
            COUNT(*) FILTER (WHERE changed)::int                       AS changes_requested,
            COUNT(*) FILTER (WHERE rejected)::int                      AS rejected,
            COUNT(*) FILTER (WHERE status='declined')::int             AS declined,
            COUNT(*) FILTER (WHERE first_pass)::int                    AS first_pass,
            AVG(approved_version) FILTER (WHERE approved)              AS avg_versions
       FROM work`, p);
  const x = rows[0];
  const n = (k: string) => Number(x[k]);
  return {
    assigned: n("assigned"), accepted: n("accepted"), completed: n("completed"),
    submitted: n("submitted"), approved: n("approved"),
    changes_requested: n("changes_requested"), rejected: n("rejected"), declined: n("declined"),
    completion_rate: rate(n("completed"), n("assigned")),
    submission_rate: rate(n("submitted"), n("completed")),
    approval_rate: rate(n("approved"), n("submitted")),
    // Of the assignments that reached approval, how many needed no revision.
    first_pass_rate: rate(n("first_pass"), n("approved")),
    avg_versions_to_approval: x.avg_versions == null
      ? null : Math.round(Number(x.avg_versions) * 100) / 100,
  };
}

/* ── Review performance ───────────────────────────────────────────────────
   Durations from the timestamps that already exist, in hours. The MEDIAN is
   reported beside the average because operational data is skewed — one
   submission reviewed after a fortnight should not be allowed to describe the
   week. */
export type Timings = {
  reviewed: number;
  avg_review_hours: number | null; median_review_hours: number | null;
  avg_completion_to_submission_hours: number | null;
  avg_resubmission_hours: number | null;
  awaiting_review: number; oldest_waiting_hours: number | null;
};
export async function timings(pool: Pool, scope: AnalyticsScope, r: Range): Promise<Timings> {
  const p: unknown[] = [r.from, r.to];
  const sScope = scopeClause(scope, "sa.user_id", p);
  const { rows } = await pool.query(
    `WITH decided AS (
       SELECT EXTRACT(EPOCH FROM (s.reviewed_at - s.submitted_at))/3600 AS review_hours
         FROM mo_creator_submissions s
         JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
        WHERE s.reviewed_at IS NOT NULL AND ${inRange("s.reviewed_at", 1, 2)}${sScope}),
     first_send AS (
       /* Completion → submission, measured on the FIRST version only: the gap
          that matters is between finishing the work and handing it in. */
       SELECT EXTRACT(EPOCH FROM (s.submitted_at - sa.completed_at))/3600 AS hours
         FROM mo_creator_submissions s
         JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
        WHERE s.version_no = 1 AND sa.completed_at IS NOT NULL
          AND s.submitted_at >= sa.completed_at
          AND ${inRange("s.submitted_at", 1, 2)}${sScope}),
     redo AS (
       /* Changes requested → the next version arriving. */
       SELECT EXTRACT(EPOCH FROM (nxt.submitted_at - prev.reviewed_at))/3600 AS hours
         FROM mo_creator_submissions prev
         JOIN mo_creator_submissions nxt
           ON nxt.assignment_id = prev.assignment_id AND nxt.version_no = prev.version_no + 1
         JOIN mo_creator_assignments sa ON sa.id = prev.assignment_id
        WHERE prev.status='changes_requested' AND prev.reviewed_at IS NOT NULL
          AND ${inRange("nxt.submitted_at", 1, 2)}${sScope}),
     waiting AS (
       SELECT EXTRACT(EPOCH FROM (NOW() - s.submitted_at))/3600 AS hours
         FROM mo_creator_submissions s
         JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
        WHERE s.status='submitted'${sScope})
     SELECT (SELECT COUNT(*)::int FROM decided)                                   AS reviewed,
            (SELECT AVG(review_hours) FROM decided)                               AS avg_review,
            (SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY review_hours) FROM decided) AS med_review,
            (SELECT AVG(hours) FROM first_send)                                   AS avg_first_send,
            (SELECT AVG(hours) FROM redo)                                         AS avg_redo,
            (SELECT COUNT(*)::int FROM waiting)                                   AS awaiting,
            (SELECT MAX(hours) FROM waiting)                                      AS oldest_waiting`, p);
  const x = rows[0];
  const h = (v: unknown) => (v == null ? null : Math.round(Number(v) * 10) / 10);
  return {
    reviewed: Number(x.reviewed),
    avg_review_hours: h(x.avg_review), median_review_hours: h(x.med_review),
    avg_completion_to_submission_hours: h(x.avg_first_send),
    avg_resubmission_hours: h(x.avg_redo),
    awaiting_review: Number(x.awaiting), oldest_waiting_hours: h(x.oldest_waiting),
  };
}

/* ── Per-creator table ────────────────────────────────────────────────────
   One grouped query for the whole network. No loop, no query per creator —
   a thousand creators cost the same round trip as ten. */
export type CreatorRow = {
  user_id: string; creator_name: string; team: string | null; status: string;
  assignments: number; completed: number; submissions: number; reviewed: number;
  approved: number; changes_requested: number; approval_rate: number | null;
  points: number; achievements: number; active_weeks: number; consistency: number | null;
};
export async function creatorTable(
  pool: Pool, scope: AnalyticsScope, r: Range, limit = 100, offset = 0,
): Promise<{ rows: CreatorRow[]; total: number }> {
  const p: unknown[] = [r.from, r.to];
  const cScope = scopeClause(scope, "c.user_id", p);
  const base = `
    FROM mo_creator_profiles c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN mo_creator_team_members mm ON mm.user_id = c.user_id AND mm.is_primary
    LEFT JOIN mo_creator_teams tm ON tm.id = mm.team_id
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int                                                     AS assignments,
             COUNT(*) FILTER (WHERE a.completed_at IS NOT NULL
               AND ${inRange("a.completed_at", 1, 2)})::int                    AS completed
        FROM mo_creator_assignments a
       WHERE a.user_id = c.user_id AND (${inRange("a.created_at", 1, 2)}
          OR (a.completed_at IS NOT NULL AND ${inRange("a.completed_at", 1, 2)}))
    ) asg ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*) FILTER (WHERE ${inRange("s.submitted_at", 1, 2)})::int    AS submissions,
             COUNT(*) FILTER (WHERE s.reviewed_at IS NOT NULL
               AND ${inRange("s.reviewed_at", 1, 2)})::int                      AS reviewed,
             COUNT(*) FILTER (WHERE s.status='approved' AND s.reviewed_at IS NOT NULL
               AND ${inRange("s.reviewed_at", 1, 2)})::int                      AS approved,
             COUNT(*) FILTER (WHERE s.status='changes_requested' AND s.reviewed_at IS NOT NULL
               AND ${inRange("s.reviewed_at", 1, 2)})::int                      AS changes_requested,
             /* CONSISTENCY is production spread over time, and nothing more:
                distinct IST weeks in which this creator submitted or completed
                something. It is not quality — a creator can be consistent and
                still be asked for revisions, and the two are reported apart. */
             COUNT(DISTINCT DATE_TRUNC('week', (s.submitted_at AT TIME ZONE '${NERVE_TZ}')))
               FILTER (WHERE ${inRange("s.submitted_at", 1, 2)})::int           AS active_weeks
        FROM mo_creator_submissions s
        JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
       WHERE sa.user_id = c.user_id
    ) sub ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(l.points),0)::int AS points FROM mo_creator_point_ledger l
       WHERE l.user_id = c.user_id AND ${inRange("l.created_at", 1, 2)}
    ) pts ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS achievements FROM mo_creator_achievement_awards w
       WHERE w.user_id = c.user_id AND w.revoked_at IS NULL
         AND ${inRange("w.awarded_at", 1, 2)}
    ) ach ON true
    WHERE true${cScope}`;
  const cp: unknown[] = [];
  const countScope = scopeClause(scope, "c.user_id", cp);
  const total = Number((await pool.query(
    `SELECT COUNT(*)::int n FROM mo_creator_profiles c WHERE true${countScope}`, cp)).rows[0].n);
  const weeks = Math.max(1, Math.ceil(r.days / 7));
  const { rows } = await pool.query(
    `SELECT c.user_id, c.status,
            COALESCE(NULLIF(c.display_name,''), u.full_name) AS creator_name,
            tm.name AS team,
            COALESCE(asg.assignments,0) AS assignments, COALESCE(asg.completed,0) AS completed,
            COALESCE(sub.submissions,0) AS submissions, COALESCE(sub.reviewed,0) AS reviewed,
            COALESCE(sub.approved,0) AS approved,
            COALESCE(sub.changes_requested,0) AS changes_requested,
            COALESCE(sub.active_weeks,0) AS active_weeks,
            COALESCE(pts.points,0) AS points, COALESCE(ach.achievements,0) AS achievements
     ${base}
     ORDER BY COALESCE(pts.points,0) DESC, COALESCE(sub.approved,0) DESC, creator_name
     LIMIT $${p.length + 1} OFFSET $${p.length + 2}`, [...p, limit, offset]);
  return {
    total,
    rows: rows.map((x) => ({
      user_id: x.user_id, creator_name: x.creator_name, team: x.team ?? null, status: x.status,
      assignments: Number(x.assignments), completed: Number(x.completed),
      submissions: Number(x.submissions), reviewed: Number(x.reviewed),
      approved: Number(x.approved), changes_requested: Number(x.changes_requested),
      approval_rate: rate(Number(x.approved), Number(x.reviewed)),
      points: Number(x.points), achievements: Number(x.achievements),
      active_weeks: Number(x.active_weeks),
      consistency: rate(Number(x.active_weeks), weeks),
    })),
  };
}

/* ── Teams ────────────────────────────────────────────────────────────────
   Aggregated from the members' own records. There is no team.total_points and
   never will be: a team's figures are its people's, summed on read. */
export type TeamRow = {
  team_id: number; team: string; members: number; operationally_active: number;
  assignments: number; completed: number; submissions: number; approved: number;
  approval_rate: number | null; points: number;
};
export async function teamTable(pool: Pool, scope: AnalyticsScope, r: Range): Promise<TeamRow[]> {
  const p: unknown[] = [r.from, r.to];
  let teamFilter = "";
  if (scope.level === "team") { p.push(scope.teamIds); teamFilter = ` AND t.id = ANY($${p.length}::bigint[])`; }
  else if (scope.level === "self") return [];
  const { rows } = await pool.query(
    `SELECT t.id AS team_id, t.name AS team,
            COUNT(DISTINCT m.user_id)::int AS members,
            COUNT(DISTINCT CASE WHEN (a.completed_at IS NOT NULL
                                        AND ${inRange("a.completed_at", 1, 2)})
                                    OR (s.submitted_at IS NOT NULL
                                        AND ${inRange("s.submitted_at", 1, 2)})
                                THEN a.user_id END)::int                       AS operationally_active,
            COUNT(DISTINCT s.id) FILTER (WHERE ${inRange("s.submitted_at", 1, 2)})::int AS submissions,
            COUNT(DISTINCT a.id) FILTER (WHERE ${inRange("a.created_at", 1, 2)})::int AS assignments,
            COUNT(DISTINCT a.id) FILTER (WHERE a.completed_at IS NOT NULL
              AND ${inRange("a.completed_at", 1, 2)})::int                     AS completed,
            COUNT(DISTINCT s.id) FILTER (WHERE s.status='approved' AND s.reviewed_at IS NOT NULL
              AND ${inRange("s.reviewed_at", 1, 2)})::int                      AS approved,
            COUNT(DISTINCT s.id) FILTER (WHERE s.reviewed_at IS NOT NULL
              AND ${inRange("s.reviewed_at", 1, 2)})::int                      AS reviewed,
            COALESCE((SELECT SUM(l.points)::int FROM mo_creator_point_ledger l
                       WHERE l.user_id IN (SELECT user_id FROM mo_creator_team_members
                                            WHERE team_id = t.id)
                         AND ${inRange("l.created_at", 1, 2)}), 0)             AS points
       FROM mo_creator_teams t
       LEFT JOIN mo_creator_team_members m ON m.team_id = t.id
       LEFT JOIN mo_creator_assignments a ON a.user_id = m.user_id
       LEFT JOIN mo_creator_submissions s ON s.assignment_id = a.id
      WHERE t.is_active AND t.archived_at IS NULL${teamFilter}
      GROUP BY t.id, t.name
      ORDER BY points DESC, t.name`, p);
  return rows.map((x) => ({
    team_id: Number(x.team_id), team: x.team, members: Number(x.members),
    // Operationally active: completed or submitted, the same definition as everywhere.
    operationally_active: Number(x.operationally_active),
    assignments: Number(x.assignments), completed: Number(x.completed),
    submissions: Number(x.submissions), approved: Number(x.approved),
    approval_rate: rate(Number(x.approved), Number(x.reviewed)),
    points: Number(x.points),
  }));
}

/* ── Opportunity and event conversion ─────────────────────────────────────
   Which work actually turns into content. Interest → selection → assignment →
   completion → approval, per opportunity, in one grouped query. */
export async function conversion(pool: Pool, scope: AnalyticsScope, r: Range, limit = 25) {
  const p: unknown[] = [r.from, r.to];
  if (scope.level === "self") return { opportunities: [], events: [] };
  const teamFilter = scope.level === "team"
    ? (p.push(scope.teamIds), ` AND a.team_id = ANY($${p.length}::bigint[])`) : "";
  const opportunities = (await pool.query(
    `SELECT o.id, o.title, e.title AS event, e.event_date, o.required_count,
            (SELECT COUNT(*)::int FROM mo_creator_interests i
              WHERE i.opportunity_id=o.id AND i.status='interested')            AS interested,
            (SELECT COUNT(*)::int FROM mo_creator_interests i
              WHERE i.opportunity_id=o.id AND i.status='selected')              AS selected,
            COUNT(DISTINCT a.id)::int                                            AS assigned,
            COUNT(DISTINCT a.id) FILTER (WHERE a.completed_at IS NOT NULL)::int  AS completed,
            COUNT(DISTINCT s.assignment_id)::int                                 AS submitted,
            COUNT(DISTINCT s.assignment_id) FILTER (WHERE s.status='approved')::int AS approved
       FROM mo_creator_opportunities o
       JOIN mo_creator_events e ON e.id = o.event_id
       LEFT JOIN mo_creator_assignments a ON a.opportunity_id = o.id${teamFilter}
       LEFT JOIN mo_creator_submissions s ON s.assignment_id = a.id
      WHERE (e.event_date BETWEEN $1 AND $2
         OR (o.created_at AT TIME ZONE '${NERVE_TZ}')::date BETWEEN $1 AND $2)
      GROUP BY o.id, o.title, e.title, e.event_date, o.required_count
      ORDER BY assigned DESC, o.id DESC LIMIT ${Math.max(1, Math.min(100, limit))}`, p)).rows;
  const events = (await pool.query(
    `SELECT e.id, e.title, e.event_date, e.status,
            COUNT(DISTINCT o.id)::int                                            AS opportunities,
            COUNT(DISTINCT a.user_id)::int                                        AS creators,
            COUNT(DISTINCT a.id)::int                                             AS assignments,
            COUNT(DISTINCT a.id) FILTER (WHERE a.completed_at IS NOT NULL)::int   AS completed,
            COUNT(DISTINCT s.assignment_id) FILTER (WHERE s.status='approved')::int AS approved
       FROM mo_creator_events e
       LEFT JOIN mo_creator_opportunities o ON o.event_id = e.id
       LEFT JOIN mo_creator_assignments a ON a.opportunity_id = o.id${teamFilter}
       LEFT JOIN mo_creator_submissions s ON s.assignment_id = a.id
      WHERE e.event_date BETWEEN $1 AND $2
      GROUP BY e.id, e.title, e.event_date, e.status
      ORDER BY e.event_date DESC LIMIT ${Math.max(1, Math.min(100, limit))}`, p)).rows;
  const conv = (a: number, b: number) => rate(a, b);
  return {
    opportunities: opportunities.map((o) => ({
      id: Number(o.id), title: o.title, event: o.event,
      event_date: o.event_date ? dayOf(o.event_date) : null,
      required: Number(o.required_count), interested: Number(o.interested),
      selected: Number(o.selected), assigned: Number(o.assigned),
      completed: Number(o.completed), submitted: Number(o.submitted), approved: Number(o.approved),
      interest_to_selection: conv(Number(o.selected), Number(o.interested)),
      assignment_to_completion: conv(Number(o.completed), Number(o.assigned)),
      completion_to_approval: conv(Number(o.approved), Number(o.completed)),
    })),
    events: events.map((e) => ({
      id: Number(e.id), title: e.title, status: e.status,
      event_date: e.event_date ? dayOf(e.event_date) : null,
      opportunities: Number(e.opportunities), creators: Number(e.creators),
      assignments: Number(e.assignments), completed: Number(e.completed), approved: Number(e.approved),
    })),
  };
}

/* ── Money ────────────────────────────────────────────────────────────────
   Read from Phase 5 and nothing else. Amounts stay STRINGS the whole way, as
   they do in Phase 5: a rupee that passes through a JavaScript number is a
   rupee that can lose its paise.

   "Calculated" and "paid" are never mixed. Cost per approved content is
   offered both ways, each labelled, because they answer different questions:
   what the work is worth, and what has actually left the bank. */
export async function money(pool: Pool, scope: AnalyticsScope, r: Range, approved: number) {
  if (!seesMoney(scope)) return null;
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM mo_creator_payouts p
         WHERE ${inRange("p.calculated_at", 1, 2)})                              AS payouts,
       (SELECT COALESCE(SUM(p.gross_amount),0)::numeric(12,2) FROM mo_creator_payouts p
         WHERE ${inRange("p.calculated_at", 1, 2)})                              AS gross,
       (SELECT COALESCE(SUM(-f.amount),0)::numeric(12,2) FROM mo_creator_financial_ledger f
         WHERE f.entry_type='payment' AND ${inRange("f.created_at", 1, 2)})      AS paid,
       (SELECT COALESCE(SUM(f.amount),0)::numeric(12,2) FROM mo_creator_financial_ledger f
         WHERE f.entry_type IN ('adjustment','reversal')
           AND ${inRange("f.created_at", 1, 2)})                                 AS adjustments,
       /* Outstanding is a BALANCE, not a windowed figure: what is owed right
          now across the whole ledger, because a debt does not stop existing
          when a date filter moves. */
       (SELECT COALESCE(SUM(f.amount),0)::numeric(12,2)
          FROM mo_creator_financial_ledger f)                                    AS outstanding`,
    [r.from, r.to]);
  const x = rows[0];
  const per = (amount: string) =>
    approved > 0 ? (Math.round((Number(amount) / approved) * 100) / 100).toFixed(2) : null;
  return {
    payouts: Number(x.payouts),
    gross: String(x.gross), paid: String(x.paid),
    adjustments: String(x.adjustments), outstanding: String(x.outstanding),
    currency: "INR",
    // Both, labelled. Window: the same range as the approved count they divide.
    cost_per_approved_gross: per(String(x.gross)),
    cost_per_approved_paid: per(String(x.paid)),
  };
}

/* ── Recognition ──────────────────────────────────────────────────────────
   Phase 6, read only. A competition score is reported as a competition score
   and never added to points. */
export async function recognition(pool: Pool, scope: AnalyticsScope, r: Range) {
  const p: unknown[] = [r.from, r.to];
  const wScope = scopeClause(scope, "w.user_id", p);
  const rScope = scopeClause(scope, "res.user_id", p);
  const cScope = scopeClause(scope, "ca.user_id", p);
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM mo_creator_achievement_awards w
         WHERE w.revoked_at IS NULL AND ${inRange("w.awarded_at", 1, 2)}${wScope}) AS achievements,
       (SELECT COUNT(DISTINCT w.user_id)::int FROM mo_creator_achievement_awards w
         WHERE w.revoked_at IS NULL AND ${inRange("w.awarded_at", 1, 2)}${wScope}) AS creators_recognised,
       (SELECT COUNT(*)::int FROM mo_creator_cycle_awards ca
         WHERE ${inRange("ca.awarded_at", 1, 2)}${cScope})                         AS cycle_awards,
       (SELECT COUNT(*)::int FROM mo_creator_competition_results res
         WHERE ${inRange("res.finalized_at", 1, 2)}${rScope})                      AS results,
       (SELECT COUNT(*)::int FROM mo_creator_competition_results res
         WHERE res.place = 1 AND ${inRange("res.finalized_at", 1, 2)}${rScope})    AS wins`, p);
  const x = rows[0];
  const comps = scope.level === "self" ? [] : (await pool.query(
    `SELECT k.id, k.name, k.status,
            COUNT(*) FILTER (WHERE pa.status='registered')::int AS participants,
            COUNT(*) FILTER (WHERE pa.status='withdrawn')::int  AS withdrawn,
            (SELECT COUNT(*)::int FROM mo_creator_competition_results rr
              WHERE rr.competition_id = k.id)                    AS results
       FROM mo_creator_competitions k
       LEFT JOIN mo_creator_competition_participants pa ON pa.competition_id = k.id
      WHERE (k.starts_at AT TIME ZONE '${NERVE_TZ}')::date <= $2
        AND (k.ends_at   AT TIME ZONE '${NERVE_TZ}')::date >= $1
        AND k.status <> 'draft'
      GROUP BY k.id, k.name, k.status
      ORDER BY k.starts_at DESC LIMIT 25`, [r.from, r.to])).rows;
  const tp: unknown[] = [r.from, r.to];
  const topScope = scopeClause(scope, "w.user_id", tp);
  const topRows = (await pool.query(
    `SELECT a.name, a.icon, COUNT(*)::int AS times
       FROM mo_creator_achievement_awards w
       JOIN mo_creator_achievements a ON a.id = w.achievement_id
      WHERE w.revoked_at IS NULL AND ${inRange("w.awarded_at", 1, 2)}${topScope}
      GROUP BY a.name, a.icon ORDER BY times DESC, a.name LIMIT 5`, tp)).rows;
  return {
    achievements: Number(x.achievements),
    creators_recognised: Number(x.creators_recognised),
    cycle_awards: Number(x.cycle_awards),
    competition_results: Number(x.results), competition_wins: Number(x.wins),
    most_earned: topRows.map((t) => ({ name: t.name, icon: t.icon, times: Number(t.times) })),
    competitions: comps.map((k) => ({
      id: Number(k.id), name: k.name, status: k.status,
      participants: Number(k.participants), withdrawn: Number(k.withdrawn),
      results: Number(k.results),
      // Participation rate needs a denominator that means something; the
      // eligible population is a Phase 6 question, so only counts are given.
    })),
  };
}

/* ── Rank ─────────────────────────────────────────────────────────────────
   THE PHASE 4 RANK ENGINE REMAINS THE SOURCE OF TRUTH FOR RANKING. This is
   its formula — RANK() OVER (ORDER BY total DESC) over the cycle's ledger
   totals — and not a second one: a reconciliation test asserts that the rank
   reported here equals the rank the Phase 4 leaderboard reports for the same
   creator in the same cycle, so the two cannot drift apart unnoticed. */
export async function rankFor(
  pool: Pool, userId: string, cycleId: number | null,
): Promise<{ place: number | null; of: number; points: number }> {
  if (!cycleId) return { place: null, of: 0, points: 0 };
  const { rows } = await pool.query(
    `WITH totals AS (
       SELECT user_id, SUM(points)::int total FROM mo_creator_point_ledger
        WHERE cycle_id=$1 GROUP BY user_id),
     ranked AS (SELECT user_id, total, RANK() OVER (ORDER BY total DESC) place FROM totals)
     SELECT (SELECT place FROM ranked WHERE user_id=$2)  AS place,
            (SELECT total FROM ranked WHERE user_id=$2)  AS points,
            (SELECT COUNT(*)::int FROM totals)           AS of`, [cycleId, userId]);
  const x = rows[0];
  return {
    place: x?.place == null ? null : Number(x.place),
    of: Number(x?.of ?? 0),
    points: Number(x?.points ?? 0),
  };
}

/** The two most recent cycles, for rank and point movement between them. */
export async function recentCycles(pool: Pool, limit = 2) {
  return (await pool.query(
    `SELECT id, label, starts_on, ends_on, status FROM mo_creator_cycles
      WHERE status IN ('active','closed') ORDER BY starts_on DESC, id DESC LIMIT $1`, [limit]))
    .rows.map((c) => ({ id: Number(c.id), label: String(c.label), status: String(c.status) }));
}

/* ── Operational signals ──────────────────────────────────────────────────

   Facts about CONDITIONS, never judgements about people. "14 submissions are
   awaiting review" is an operational state a manager can act on; "this
   creator is weak" is not something this system will ever say.

   Thresholds are documented constants, listed here and in the metric
   dictionary, so "critical" always means the same thing and changing it is a
   commit somebody can read. Computed live — §58: nothing is persisted while
   real-time computation is sufficient. */
export const SIGNAL_THRESHOLDS = {
  review_backlog:        { attention: 15, critical: 50 },
  overdue_work:          { attention: 1,  critical: 10 },
  low_activity:          { attention: 1,  critical: 10, window_days: 30 },
  high_revision_rate:    { attention: 40, critical: 60, min_reviewed: 10 },
  completed_not_sent:    { attention: 1,  critical: 10, grace_days: 3 },
  outstanding_payable:   { attention: 1,  critical: 1 },
  low_participation:     { attention: 3 },
} as const;

export type Signal = {
  type: string; severity: "info" | "attention" | "critical";
  message: string; count: number; scope: string;
};
export async function signals(pool: Pool, scope: AnalyticsScope): Promise<Signal[]> {
  const T = SIGNAL_THRESHOLDS;
  const p: unknown[] = [];
  const sScope = scopeClause(scope, "sa.user_id", p);
  const aScope = scopeClause(scope, "a.user_id", p);
  const cScope = scopeClause(scope, "c.user_id", p);
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.status='submitted'${sScope})                                     AS backlog,
       (SELECT COUNT(*)::int FROM mo_creator_assignments a
         WHERE a.deadline IS NOT NULL
           AND a.deadline < (NOW() AT TIME ZONE '${NERVE_TZ}')::date
           AND a.status NOT IN ('completed','declined','cancelled')${aScope})     AS overdue,
       (SELECT COUNT(*)::int FROM mo_creator_assignments a
         WHERE a.completed_at IS NOT NULL
           AND a.completed_at < NOW() - INTERVAL '${T.completed_not_sent.grace_days} days'
           AND NOT EXISTS (SELECT 1 FROM mo_creator_submissions s WHERE s.assignment_id = a.id)
           AND a.status = 'completed'${aScope})                                   AS completed_not_sent,
       /* LOW ACTIVITY counts only creators who could reasonably have produced:
          an ACTIVE profile that was actually given work in the window. A new
          joiner, a suspended creator and somebody nobody assigned anything to
          are not evidence of a problem, and §44 says so. */
       (SELECT COUNT(*)::int FROM mo_creator_profiles c
         WHERE c.status='active'
           AND EXISTS (SELECT 1 FROM mo_creator_assignments a2
                        WHERE a2.user_id = c.user_id
                          AND a2.created_at >= NOW() - INTERVAL '${T.low_activity.window_days} days')
           AND NOT EXISTS (SELECT 1 FROM mo_creator_assignments a3
                            WHERE a3.user_id = c.user_id AND a3.completed_at IS NOT NULL
                              AND a3.completed_at >= NOW() - INTERVAL '${T.low_activity.window_days} days')
           AND NOT EXISTS (SELECT 1 FROM mo_creator_submissions s3
                             JOIN mo_creator_assignments a4 ON a4.id = s3.assignment_id
                            WHERE a4.user_id = c.user_id
                              AND s3.submitted_at >= NOW() - INTERVAL '${T.low_activity.window_days} days')
           ${cScope})                                                             AS low_activity,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.reviewed_at IS NOT NULL
           AND s.reviewed_at >= NOW() - INTERVAL '30 days'${sScope})              AS reviewed_30,
       (SELECT COUNT(*)::int FROM mo_creator_submissions s
          JOIN mo_creator_assignments sa ON sa.id = s.assignment_id
         WHERE s.status='changes_requested' AND s.reviewed_at IS NOT NULL
           AND s.reviewed_at >= NOW() - INTERVAL '30 days'${sScope})              AS changed_30,
       (SELECT COUNT(*)::int FROM mo_creator_competitions k
         WHERE k.status IN ('open','active')
           AND (SELECT COUNT(*) FROM mo_creator_competition_participants pa
                 WHERE pa.competition_id = k.id AND pa.status='registered')
               < ${T.low_participation.attention})                                AS thin_competitions`,
    p);
  const x = rows[0];
  const out: Signal[] = [];
  const level = (n: number, t: { attention: number; critical: number }) =>
    n >= t.critical ? "critical" as const : n >= t.attention ? "attention" as const : null;
  const add = (type: string, count: number, sev: Signal["severity"] | null, message: string) => {
    if (sev) out.push({ type, severity: sev, message, count, scope: scope.level });
  };

  const backlog = Number(x.backlog);
  add("review_backlog", backlog, level(backlog, T.review_backlog),
    `${backlog} submission${backlog === 1 ? " is" : "s are"} awaiting review.`);

  const overdue = Number(x.overdue);
  add("overdue_work", overdue, level(overdue, T.overdue_work),
    `${overdue} assignment${overdue === 1 ? " is" : "s are"} past deadline and not finished.`);

  const stuck = Number(x.completed_not_sent);
  add("completed_not_sent", stuck, level(stuck, T.completed_not_sent),
    `${stuck} assignment${stuck === 1 ? " was" : "s were"} completed more than ` +
    `${T.completed_not_sent.grace_days} days ago with nothing submitted.`);

  const quiet = Number(x.low_activity);
  add("low_activity", quiet, level(quiet, T.low_activity),
    `${quiet} creator${quiet === 1 ? " was" : "s were"} assigned work in the last ` +
    `${T.low_activity.window_days} days with no completion or submission since.`);

  const reviewed30 = Number(x.reviewed_30), changed30 = Number(x.changed_30);
  if (reviewed30 >= T.high_revision_rate.min_reviewed) {
    const pct = Math.round((changed30 / reviewed30) * 1000) / 10;
    add("high_revision_rate", pct,
      pct >= T.high_revision_rate.critical ? "critical" : pct >= T.high_revision_rate.attention ? "attention" : null,
      `${pct}% of the last 30 days' reviews asked for changes (${changed30} of ${reviewed30}).`);
  }

  const thin = Number(x.thin_competitions);
  add("low_participation", thin, thin >= 1 ? "info" : null,
    `${thin} open competition${thin === 1 ? " has" : "s have"} fewer than ` +
    `${T.low_participation.attention} entries.`);

  if (seesMoney(scope)) {
    const owed = String((await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) t FROM mo_creator_financial_ledger`)).rows[0].t);
    if (Number(owed) > 0)
      out.push({ type: "outstanding_payable", severity: "attention", count: Number(owed),
        message: `₹${owed} remains payable across the network.`, scope: scope.level });
  }
  const order = { critical: 0, attention: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/* ── Data quality ─────────────────────────────────────────────────────────
   Source records that cannot all be true at once. These are SURFACED, with
   the record named, and never silently repaired: analytics does not get to
   edit the systems it reads. */
export async function dataQuality(pool: Pool, scope: AnalyticsScope) {
  if (scope.level === "self") return [];
  const out: Array<{ type: string; count: number; message: string; sample: string[] }> = [];
  const checks: Array<[string, string, string]> = [
    ["approved_without_review_time",
     `SELECT s.id::text FROM mo_creator_submissions s
       WHERE s.status='approved' AND s.reviewed_at IS NULL LIMIT 5`,
     "approved submission(s) carry no review timestamp"],
    ["completed_without_timestamp",
     `SELECT a.id::text FROM mo_creator_assignments a
       WHERE a.status='completed' AND a.completed_at IS NULL LIMIT 5`,
     "completed assignment(s) carry no completion timestamp"],
    ["paid_without_ledger_entry",
     `SELECT p.id::text FROM mo_creator_payouts p
       WHERE p.status='paid' AND NOT EXISTS (
         SELECT 1 FROM mo_creator_financial_ledger f
          WHERE f.payout_id = p.id AND f.entry_type='payment') LIMIT 5`,
     "paid payout(s) have no payment entry in the financial ledger"],
    ["result_without_participant",
     `SELECT r.id::text FROM mo_creator_competition_results r
       WHERE NOT EXISTS (SELECT 1 FROM mo_creator_competition_participants pa
          WHERE pa.competition_id = r.competition_id AND pa.user_id = r.user_id) LIMIT 5`,
     "competition result(s) have no matching participant record"],
  ];
  for (const [type, sql, label] of checks) {
    const ids = (await pool.query(sql)).rows.map((x) => String(Object.values(x)[0]));
    if (ids.length) out.push({ type, count: ids.length, message: `${ids.length} ${label}.`, sample: ids });
  }
  return out;
}

/* ── CSV ──────────────────────────────────────────────────────────────────
   RFC 4180 quoting, and a leading apostrophe on anything a spreadsheet would
   treat as a formula — an export is data, not something that should execute
   when somebody opens it. */
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): string {
  const cell = (v: string | number | null) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n") + "\r\n";
}
