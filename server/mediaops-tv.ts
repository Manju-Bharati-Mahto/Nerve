/* ═══════════════════════════════════════════════════════════════════════════
   NERVE MEDIA OPS — TV OPERATIONS BOARD (data layer)

   One focused read for the office display at /api/media-tv/. It exists because
   the TV must NOT hydrate from /api/v1/media/state: that ships ~60 tables,
   including casting records and contact details, to a screen a corridor can see.

   Everything below is an AGGREGATE or a scheduled-event row that is already
   public inside the office (a title, a venue, a time, a team name). No emails,
   no phone numbers, no individual leave reasons, no per-person report contents.

   Nerve stays the source of truth: nothing here writes, caches business data,
   or re-implements a rule that lives elsewhere. Dates go through nerveToday()
   for the same reason the rest of the codebase does — toISOString() returns
   yesterday for the whole Asia/Kolkata morning.
   ═══════════════════════════════════════════════════════════════════════════ */

import { pool } from "./db.js";
import { NERVE_TIME_ZONE, nerveToday, dateOnly } from "./mediaops-queries.js";

/* ── Access ────────────────────────────────────────────────────────────────
   The module key is the one the client derives from the sidebar route
   '#/media/tv' — declared here so the endpoint and the tests can never drift
   from a string typed twice.

   This is NOT a permission system. It is the existing module decision, named:
   the caller resolves identity and modules with the helpers that already exist
   (moRoleOf / effectiveModules) and passes the answers in. `null` means the
   installation has configured no module restrictions at all, which the client's
   moduleAllowed() reads as "allowed" for every module — this reads it the same
   way, so the board can never disagree with the sidebar that links to it. */
export const TV_MODULE_KEY = "tv";

export function tvBoardAllowed(isAdmin: boolean, effective: readonly string[] | null): boolean {
  return isAdmin || effective === null || effective.includes(TV_MODULE_KEY);
}

/* ── Shapes the display renders ─────────────────────────────────────────── */

export interface TvEvent {
  id: string;
  kind: "shoot" | "coverage";
  title: string;
  project: string | null;
  location: string | null;
  team: string | null;
  crew: number;
  start: string | null;          // "HH:MM", or null when the record has no time
  end: string | null;
  status: "live" | "upcoming" | "completed" | "scheduled";
  cover_url: string | null;
}

export interface TvBoard {
  generated_at: string;
  today: string;
  /* The office's timezone, so a display that was set up in the wrong one still
     prints a clock that agrees with the event times beside it. */
  time_zone: string;
  campus: string | null;
  kpis: {
    events_today: number;
    live_now: number;
    crew_on_duty: number;
    crew_total: number;
    equipment_available: number;
    equipment_total: number;
    reports_in: number;
    reports_expected: number;
    upcoming_7d: number;
  };
  schedule: TvEvent[];
  schedule_total: number;
  live: TvEvent[];
  crew: {
    total: number;
    in_field: number;
    on_campus: number;
    on_leave: number;
    half_day: number;
    teams: Array<{ name: string; color: string | null; in_field: number; members: number }>;
  };
  week: Array<{
    date: string; weekday: string; day: number;
    events: number; is_today: boolean; holiday: string | null; top: string[];
  }>;
  equipment: Array<{ category: string; available: number; total: number }>;
  output: {
    photos: number; videos: number; submissions: number;
    versions: number; delivered: number;
    coverage_due: number; coverage_in: number; pct: number;
  };
  reporting: { submitted: number; expected: number; pending_review: number };
  attention: Array<{ label: string; count: number; tone: "bad" | "warn" | "info" }>;
  upcoming: Array<{ date: string; title: string }>;
}

/* ── Time handling ──────────────────────────────────────────────────────────
   call_time / start_time are TEXT columns (the app writes "HH:MM"). Parsing is
   deliberately tolerant and FAILS SAFE: anything unrecognised yields null, and
   a null time can never make an event read as LIVE. A board that under-reports
   "live" is a nuisance; one that invents a live shoot is a lie. */
function minutesOf(v: unknown): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})/.exec(String(v ?? ""));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function hhmm(v: unknown): string | null {
  const t = minutesOf(v);
  if (t == null) return null;
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}

/** Minutes since local midnight, in the application's timezone. */
export function nerveMinutesNow(timeZone: string = NERVE_TIME_ZONE, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

/**
 * Where an event sits relative to now.
 *
 * The record's OWN status wins when it is terminal — 'done' (or an SMC status of
 * submitted/reviewed) is a person stating the work finished, and a person
 * outranks the clock. Only then does the clock decide, and only from times it
 * could actually parse: an unreadable or missing start yields 'scheduled', never
 * 'live'. Exported because this is the one rule on the board that a bad guess
 * would turn into a visible lie.
 */
export function classifyEvent(
  recordStatus: string, startText: unknown, endText: unknown, nowMin: number,
): TvEvent["status"] {
  if (recordStatus === "done" || recordStatus === "reviewed" || recordStatus === "submitted") return "completed";
  const start = minutesOf(startText), end = minutesOf(endText);
  if (start == null) return "scheduled";
  if (end != null && nowMin > end) return "completed";
  if (nowMin >= start && (end == null || nowMin <= end)) return "live";
  return nowMin < start ? "upcoming" : "completed";
}

const num = (v: unknown) => Number(v ?? 0) || 0;

function push<T>(m: Map<string, T[]>, key: string, value: T) {
  const list = m.get(key);
  if (list) list.push(value); else m.set(key, [value]);
}

/* ── The board ──────────────────────────────────────────────────────────── */

export async function buildTvBoard(today: string = nerveToday()): Promise<TvBoard> {
  const nowMin = nerveMinutesNow();

  const [
    campus, crewTotal, onLeave, inField, teams, teamMembers,
    shoots, shootTeams, coverage,
    equipment, weekQ, weekTitles,
    reportsIn, reportsPending, smcOut, versions, delivered,
    overdueDeliv, overdueEquip, pendingLeave, flagged, escalated,
    upcoming,
  ] = await Promise.all([
    pool.query(`SELECT name, city FROM mo_campuses WHERE is_active ORDER BY id LIMIT 1`),

    pool.query(`SELECT COUNT(*)::int c FROM users WHERE team='media' AND status='active'`),

    // Approved leave covering today. day_type separates a full absence from a half day.
    pool.query(
      `SELECT l.user_id, l.day_type
         FROM mo_leave_requests l JOIN users u ON u.id = l.user_id
        WHERE l.status='approved' AND $1::date BETWEEN l.starts_on AND l.ends_on
          AND u.team='media' AND u.status='active'`, [today]),

    pool.query(
      `SELECT DISTINCT sc.user_id
         FROM mo_shoot_crew sc JOIN mo_shoots s ON s.id = sc.shoot_id
        WHERE s.shoot_date=$1 AND s.status<>'cancelled' AND s.deleted_at IS NULL`, [today]),

    pool.query(
      `SELECT t.id, t.name, t.color FROM mo_teams t
        WHERE t.is_active AND t.archived_at IS NULL
        ORDER BY t.sort_order, t.name`),

    pool.query(
      `SELECT tm.team_id, tm.user_id FROM mo_team_members tm
         JOIN users u ON u.id = tm.user_id
        WHERE tm.is_primary AND u.team='media' AND u.status='active'`),

    pool.query(
      `SELECT s.id, s.title, s.call_time, s.end_time, s.location, s.status,
              p.name AS project_name, p.cover_image_url,
              (SELECT COUNT(*)::int FROM mo_shoot_crew c WHERE c.shoot_id = s.id) AS crew
         FROM mo_shoots s JOIN mo_projects p ON p.id = s.project_id
        WHERE s.shoot_date=$1 AND s.status<>'cancelled'
          AND s.deleted_at IS NULL AND p.deleted_at IS NULL
        ORDER BY s.call_time NULLS LAST, s.id`, [today]),

    // Which team(s) are actually on each of today's shoots — real team names,
    // never a hard-coded "Video Team".
    pool.query(
      `SELECT DISTINCT sc.shoot_id, t.name
         FROM mo_shoot_crew sc
         JOIN mo_shoots s  ON s.id = sc.shoot_id
         JOIN mo_team_members tm ON tm.user_id = sc.user_id AND tm.is_primary
         JOIN mo_teams t   ON t.id = tm.team_id
        WHERE s.shoot_date=$1 AND s.status<>'cancelled' AND s.deleted_at IS NULL`, [today]),

    pool.query(
      `SELECT a.id, a.title, a.start_time, a.end_time, a.venue, a.smc_status,
              p.name AS project_name, p.cover_image_url, au.name AS institute
         FROM mo_assignments a
         LEFT JOIN mo_projects p        ON p.id = a.project_id
         LEFT JOIN mo_academic_units au ON au.id = COALESCE(a.academic_unit_id, p.academic_unit_id)
        WHERE a.is_smc AND a.start_date=$1
          AND COALESCE(a.smc_status,'assigned') <> 'cancelled'
        ORDER BY a.start_time NULLS LAST, a.id`, [today]),

    pool.query(
      `SELECT c.name,
              COUNT(*) FILTER (WHERE e.status='available')::int available,
              COUNT(*)::int total
         FROM mo_equipment_categories c
         JOIN mo_equipment_items e ON e.category_id = c.id
          AND e.deleted_at IS NULL AND e.status <> 'retired'
        WHERE c.archived_at IS NULL
        GROUP BY c.id, c.name, c.sort_order
        ORDER BY c.sort_order, c.name`),

    pool.query(
      `SELECT d::date AS day,
         (SELECT COUNT(*)::int FROM mo_shoots s
           WHERE s.shoot_date = d::date AND s.status<>'cancelled' AND s.deleted_at IS NULL)
         + (SELECT COUNT(*)::int FROM mo_assignments a
             WHERE a.is_smc AND a.start_date = d::date
               AND COALESCE(a.smc_status,'assigned') <> 'cancelled') AS events,
         (SELECT h.name FROM mo_holidays h WHERE h.date = d::date LIMIT 1) AS holiday
       FROM generate_series($1::date, $1::date + 6, interval '1 day') d`, [today]),

    pool.query(
      `SELECT s.shoot_date AS day, s.title
         FROM mo_shoots s
        WHERE s.shoot_date BETWEEN $1::date AND $1::date + 6
          AND s.status<>'cancelled' AND s.deleted_at IS NULL
        ORDER BY s.shoot_date, s.call_time NULLS LAST, s.id`, [today]),

    pool.query(
      `SELECT COUNT(*)::int c FROM mo_daily_reports r
         JOIN users u ON u.id = r.user_id
        WHERE r.report_date=$1 AND u.team='media' AND u.status='active'
          AND r.status IN ('submitted','flagged','approved','auto_approved')`, [today]),

    pool.query(`SELECT COUNT(*)::int c FROM mo_daily_reports WHERE status IN ('submitted','flagged')`),

    pool.query(
      `SELECT COALESCE(SUM(photo_count),0)::int photos,
              COALESCE(SUM(video_count),0)::int videos,
              COUNT(*)::int submissions
         FROM mo_smc_submissions
        WHERE submitted_at >= $1::date AND submitted_at < $1::date + 1`, [today]),

    pool.query(
      `SELECT COUNT(*)::int c FROM mo_deliverable_versions
        WHERE submitted_at >= $1::date AND submitted_at < $1::date + 1`, [today]),

    pool.query(
      `SELECT COUNT(*)::int c FROM mo_deliverables
        WHERE completed_at = $1::date AND status='delivered' AND deleted_at IS NULL`, [today]),

    pool.query(
      `SELECT COUNT(*)::int c FROM mo_deliverables
        WHERE due_date < $1::date AND deleted_at IS NULL
          AND status NOT IN ('delivered','not_required','cancelled')`, [today]),

    // Latest movement per item; still out and past its return date.
    pool.query(
      `SELECT COUNT(*)::int c FROM (
         SELECT DISTINCT ON (equipment_item_id) action, expected_return_at
           FROM mo_equipment_transactions
          ORDER BY equipment_item_id, occurred_at DESC) t
        WHERE t.action='check_out' AND t.expected_return_at < $1::date`, [today]),

    pool.query(`SELECT COUNT(*)::int c FROM mo_leave_requests WHERE status='pending'`),
    pool.query(`SELECT COUNT(*)::int c FROM mo_daily_reports WHERE status='flagged'`),
    pool.query(`SELECT COUNT(*)::int c FROM mo_assignments WHERE is_smc AND escalation_status='open'`),

    pool.query(
      `SELECT s.shoot_date AS day, s.title
         FROM mo_shoots s
        WHERE s.shoot_date > $1::date AND s.status<>'cancelled' AND s.deleted_at IS NULL
        ORDER BY s.shoot_date, s.call_time NULLS LAST, s.id
        LIMIT 6`, [today]),
  ]);

  /* ── Crew ── */
  const leaveFull = new Set<string>(), leaveHalf = new Set<string>();
  for (const r of onLeave.rows)
    (String(r.day_type) === "full" ? leaveFull : leaveHalf).add(String(r.user_id));
  const field = new Set<string>(inField.rows.map((r) => String(r.user_id)));
  const total = num(crewTotal.rows[0]?.c);
  // On duty = active crew who are not on a full day of approved leave. A half
  // day still counts as on duty, because they are working part of it.
  const onDuty = total - leaveFull.size;

  const memberOf = new Map<string, string[]>();
  for (const r of teamMembers.rows) push(memberOf, String(r.team_id), String(r.user_id));

  /* ── Today's events: shoots and SMC coverage, one timeline ── */
  const teamsByShoot = new Map<string, string[]>();
  for (const r of shootTeams.rows) push(teamsByShoot, String(r.shoot_id), String(r.name));

  const events: TvEvent[] = [
    ...shoots.rows.map((r): TvEvent => {
      const names = teamsByShoot.get(String(r.id)) ?? [];
      return {
        id: `shoot-${r.id}`, kind: "shoot",
        title: String(r.title), project: r.project_name ? String(r.project_name) : null,
        location: r.location ? String(r.location) : null,
        team: names.length ? (names.length > 2 ? `${names[0]} +${names.length - 1}` : names.join(" · ")) : null,
        crew: num(r.crew),
        start: hhmm(r.call_time), end: hhmm(r.end_time),
        status: classifyEvent(String(r.status), r.call_time, r.end_time, nowMin),
        cover_url: r.cover_image_url ? String(r.cover_image_url) : null,
      };
    }),
    ...coverage.rows.map((r): TvEvent => ({
      id: `coverage-${r.id}`, kind: "coverage",
      title: String(r.title), project: r.project_name ? String(r.project_name) : null,
      location: r.venue ? String(r.venue) : null,
      team: r.institute ? String(r.institute) : "SMC Network",
      crew: 1,
      start: hhmm(r.start_time), end: hhmm(r.end_time),
      status: classifyEvent(String(r.smc_status ?? "assigned"), r.start_time, r.end_time, nowMin),
      cover_url: r.cover_image_url ? String(r.cover_image_url) : null,
    })),
  ].sort((a, b) => (minutesOf(a.start) ?? 1e4) - (minutesOf(b.start) ?? 1e4));

  const live = events.filter((e) => e.status === "live");

  /* ── Week ── */
  const titlesByDay = new Map<string, string[]>();
  for (const r of weekTitles.rows) push(titlesByDay, dateOnly(r.day) ?? "", String(r.title));
  const week = weekRows(weekQ.rows, today, titlesByDay);

  /* ── Output ── */
  const coverageDue = coverage.rows.length;
  const coverageIn = coverage.rows.filter((r) =>
    ["submitted", "reviewed"].includes(String(r.smc_status ?? ""))).length;

  const equipRows = equipment.rows.map((r) => ({
    category: String(r.name), available: num(r.available), total: num(r.total),
  }));

  const attention = ([
    { label: "Deliverables overdue", count: num(overdueDeliv.rows[0]?.c), tone: "bad" },
    { label: "Equipment past return", count: num(overdueEquip.rows[0]?.c), tone: "bad" },
    { label: "Reports flagged", count: num(flagged.rows[0]?.c), tone: "warn" },
    { label: "Leave awaiting decision", count: num(pendingLeave.rows[0]?.c), tone: "info" },
    { label: "Coverage escalated", count: num(escalated.rows[0]?.c), tone: "warn" },
  ] as TvBoard["attention"]).filter((a) => a.count > 0);

  return {
    generated_at: new Date().toISOString(),
    today,
    time_zone: NERVE_TIME_ZONE,
    campus: campus.rows[0] ? String(campus.rows[0].name) : null,
    kpis: {
      events_today: events.length,
      live_now: live.length,
      crew_on_duty: onDuty,
      crew_total: total,
      equipment_available: equipRows.reduce((a, e) => a + e.available, 0),
      equipment_total: equipRows.reduce((a, e) => a + e.total, 0),
      reports_in: num(reportsIn.rows[0]?.c),
      reports_expected: onDuty,
      upcoming_7d: week.reduce((a, d) => a + (d.is_today ? 0 : d.events), 0),
    },
    schedule: events.slice(0, 6),
    schedule_total: events.length,
    live: live.slice(0, 4),
    crew: {
      total,
      in_field: field.size,
      on_campus: Math.max(0, onDuty - field.size),
      on_leave: leaveFull.size,
      half_day: leaveHalf.size,
      teams: teams.rows.map((t) => {
        const ids = memberOf.get(String(t.id)) ?? [];
        return {
          name: String(t.name), color: t.color ? String(t.color) : null,
          in_field: ids.filter((id) => field.has(id)).length, members: ids.length,
        };
      }).filter((t) => t.members > 0),
    },
    week,
    equipment: equipRows,
    output: {
      photos: num(smcOut.rows[0]?.photos), videos: num(smcOut.rows[0]?.videos),
      submissions: num(smcOut.rows[0]?.submissions),
      versions: num(versions.rows[0]?.c), delivered: num(delivered.rows[0]?.c),
      coverage_due: coverageDue, coverage_in: coverageIn,
      pct: coverageDue ? Math.round((coverageIn / coverageDue) * 100) : 0,
    },
    reporting: {
      submitted: num(reportsIn.rows[0]?.c), expected: onDuty,
      pending_review: num(reportsPending.rows[0]?.c),
    },
    attention,
    upcoming: upcoming.rows.map((r) => ({ date: dateOnly(r.day) ?? "", title: String(r.title) })),
  };
}

/* Kept separate so the date formatting stays readable. Weekday/day labels are
   derived from the calendar date the DB returned, not from the viewer's clock. */
function weekRows(
  rows: Array<Record<string, unknown>>, today: string, titles: Map<string, string[]>,
): TvBoard["week"] {
  const WD = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return rows.map((r) => {
    const date = dateOnly(r.day) ?? "";
    const [y, m, d] = date.split("-").map(Number);
    const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
    return {
      date, weekday: WD[dt.getUTCDay()] ?? "", day: d || 0,
      events: num(r.events), is_today: date === today,
      holiday: r.holiday ? String(r.holiday) : null,
      top: (titles.get(date) ?? []).slice(0, 2),
    };
  });
}
