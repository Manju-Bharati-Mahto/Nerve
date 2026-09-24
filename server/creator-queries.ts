/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — the query service the AI tools read through

   THE BOUNDARY THIS FILE EXISTS TO DRAW:

     AI  →  tool  →  THIS SERVICE  →  database

   Never AI → SQL. The tools in server/ai/tools/creator-tools.ts contain no
   pool, no query and no table name; they decide what SHAPE a model sees, and
   this file owns how it is fetched. Analytics goes through Phase 7's
   creator-analytics.ts for the same reason — so a figure the assistant quotes
   and a figure the dashboard shows come from one piece of SQL, not two.

   Everything here is READ-ONLY and takes a resolved scope. No function decides
   who may see what: it is told, and it narrows accordingly.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { Pool } from "pg";
import { NERVE_TZ } from "./creator-analytics.js";

/** The caller's reach, resolved by Nerve before anything here runs. */
export type CreatorReach =
  | { level: "self"; userId: string }
  | { level: "team"; teamIds: number[]; userId: string }
  | { level: "all"; userId: string };

const dayOf = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date)
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
  return String(v).slice(0, 10);
};

/* ── Who is asking ────────────────────────────────────────────────────── */
export async function getCreatorIdentity(pool: Pool, userId: string) {
  const r = (await pool.query(
    `SELECT c.user_id, c.creator_role, c.status, c.creator_type, c.joined_on,
            COALESCE(NULLIF(c.display_name,''), u.full_name) AS name,
            t.id AS team_id, t.name AS team, lead.full_name AS team_lead
       FROM mo_creator_profiles c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN mo_creator_team_members m ON m.user_id = c.user_id AND m.is_primary
       LEFT JOIN mo_creator_teams t ON t.id = m.team_id
       LEFT JOIN users lead ON lead.id = t.lead_user_id
      WHERE c.user_id=$1`, [userId])).rows[0];
  if (!r) return null;
  /* Deliberately no email, no phone, no notes. A tool result becomes prompt
     text, and contact details have no business being there. */
  return {
    name: r.name, creatorRole: r.creator_role, status: r.status,
    creatorType: r.creator_type ?? null, joinedOn: dayOf(r.joined_on),
    team: r.team ?? null, teamId: r.team_id ? Number(r.team_id) : null,
    teamLead: r.team_lead ?? null,
  };
}

/* ── A creator's work ─────────────────────────────────────────────────── */
export async function getCreatorWork(pool: Pool, userId: string, limit = 25) {
  const rows = (await pool.query(
    `SELECT a.id, a.title, a.status, a.deadline, a.scheduled_date,
            a.completed_at, e.title AS event, e.event_date, o.title AS role,
            (SELECT COUNT(*)::int FROM mo_creator_submissions s WHERE s.assignment_id = a.id) AS versions,
            (SELECT s.status FROM mo_creator_submissions s WHERE s.assignment_id = a.id
              ORDER BY s.version_no DESC LIMIT 1) AS latest_verdict
       FROM mo_creator_assignments a
       JOIN mo_creator_opportunities o ON o.id = a.opportunity_id
       JOIN mo_creator_events e ON e.id = o.event_id
      WHERE a.user_id=$1 AND a.status NOT IN ('declined','cancelled')
      ORDER BY (a.status='completed'), COALESCE(a.deadline, e.event_date) NULLS LAST, a.id DESC
      LIMIT $2`, [userId, limit])).rows;
  const today = new Intl.DateTimeFormat("en-CA",
    { timeZone: NERVE_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return rows.map((a) => {
    const deadline = dayOf(a.deadline);
    const versions = Number(a.versions);
    return {
      id: Number(a.id), title: a.title, role: a.role, event: a.event,
      eventDate: dayOf(a.event_date), status: a.status, deadline,
      overdue: !!deadline && deadline < today && a.status !== "completed",
      versionsSubmitted: versions,
      latestVerdict: a.latest_verdict ?? null,
      /* The one thing a creator most often wants to know: finished, but never
         handed in. Stated rather than left for the model to infer. */
      awaitingSubmission: a.status === "completed" && versions === 0,
    };
  });
}

/* ── A creator's content ──────────────────────────────────────────────── */
export async function getCreatorContent(pool: Pool, userId: string, limit = 25) {
  const rows = (await pool.query(
    `SELECT s.id, s.version_no, s.status, s.submitted_at, s.reviewed_at,
            a.title AS task, e.title AS event
       FROM mo_creator_submissions s
       JOIN mo_creator_assignments a ON a.id = s.assignment_id
       JOIN mo_creator_opportunities o ON o.id = a.opportunity_id
       JOIN mo_creator_events e ON e.id = o.event_id
      WHERE a.user_id=$1
      ORDER BY s.submitted_at DESC LIMIT $2`, [userId, limit])).rows;
  /* No content_url and no review comment. A link is not needed to answer a
     question about status, and a reviewer's words are theirs to deliver. */
  return rows.map((s) => ({
    id: Number(s.id), task: s.task, event: s.event, version: Number(s.version_no),
    status: s.status, submittedAt: s.submitted_at, reviewedAt: s.reviewed_at,
  }));
}

/* ── A creator's standing ─────────────────────────────────────────────── */
export async function getCreatorStanding(pool: Pool, userId: string) {
  const cycle = (await pool.query(
    `SELECT id, label FROM mo_creator_cycles WHERE status='active'`)).rows[0] ?? null;
  const balance = (await pool.query(
    `SELECT COALESCE(SUM(points),0)::int lifetime,
            COALESCE(SUM(points) FILTER (WHERE cycle_id=$2),0)::int cycle
       FROM mo_creator_point_ledger WHERE user_id=$1`, [userId, cycle?.id ?? null])).rows[0];
  let place: number | null = null, of = 0;
  if (cycle) {
    const r = (await pool.query(
      `WITH totals AS (SELECT user_id, SUM(points)::int t FROM mo_creator_point_ledger
                        WHERE cycle_id=$1 GROUP BY user_id),
            ranked AS (SELECT user_id, RANK() OVER (ORDER BY t DESC) place FROM totals)
       SELECT (SELECT place FROM ranked WHERE user_id=$2) place,
              (SELECT COUNT(*)::int FROM totals) of`, [cycle.id, userId])).rows[0];
    place = r?.place == null ? null : Number(r.place);
    of = Number(r?.of ?? 0);
  }
  const achievements = (await pool.query(
    `SELECT a.name, a.icon, w.awarded_at, c.label AS cycle
       FROM mo_creator_achievement_awards w
       JOIN mo_creator_achievements a ON a.id = w.achievement_id
       LEFT JOIN mo_creator_cycles c ON c.id = w.cycle_id
      WHERE w.user_id=$1 AND w.revoked_at IS NULL
      ORDER BY w.awarded_at DESC LIMIT 20`, [userId])).rows;
  const cycleAwards = (await pool.query(
    `SELECT c.label AS cycle, w.rank_at_award, w.points_at_award
       FROM mo_creator_cycle_awards w JOIN mo_creator_cycles c ON c.id = w.cycle_id
      WHERE w.user_id=$1 ORDER BY c.starts_on DESC LIMIT 10`, [userId])).rows;
  const competitions = (await pool.query(
    `SELECT k.name, k.status, p.status AS my_status,
            r.place, r.score, r.result_type
       FROM mo_creator_competition_participants p
       JOIN mo_creator_competitions k ON k.id = p.competition_id
       LEFT JOIN mo_creator_competition_results r
              ON r.competition_id = k.id AND r.user_id = p.user_id
      WHERE p.user_id=$1 ORDER BY k.starts_at DESC LIMIT 10`, [userId])).rows;
  return {
    cycle: cycle ? { label: cycle.label } : null,
    pointsThisCycle: Number(balance.cycle), pointsLifetime: Number(balance.lifetime),
    rank: place, of,
    achievements: achievements.map((a) => ({
      name: a.name, icon: a.icon, awardedAt: a.awarded_at, cycle: a.cycle ?? null })),
    creatorOfCycle: cycleAwards.map((w) => ({
      cycle: w.cycle, rank: Number(w.rank_at_award), points: Number(w.points_at_award) })),
    competitions: competitions.map((k) => ({
      name: k.name, competitionStatus: k.status, myStatus: k.my_status,
      /* A competition SCORE, labelled as one. It is not a Creator point and is
         never added to the point total above. */
      competitionScore: k.score == null ? null : Number(k.score),
      place: k.place == null ? null : Number(k.place),
      result: k.result_type ?? null,
    })),
  };
}

/* ── A creator's own money ────────────────────────────────────────────── */
export async function getCreatorPayouts(pool: Pool, userId: string, limit = 12) {
  const rows = (await pool.query(
    `SELECT p.id, p.points_basis, p.rate, p.gross_amount, p.currency, p.status,
            p.calculated_at, p.approved_at, p.paid_at, p.payment_reference,
            c.label AS cycle,
            COALESCE((SELECT SUM(f.amount) FROM mo_creator_financial_ledger f
                       WHERE f.payout_id = p.id
                         AND f.entry_type IN ('adjustment','reversal')), 0)::numeric(12,2) AS adjustments,
            COALESCE((SELECT SUM(-f.amount) FROM mo_creator_financial_ledger f
                       WHERE f.payout_id = p.id AND f.entry_type='payment'), 0)::numeric(12,2) AS paid
       FROM mo_creator_payouts p
       JOIN mo_creator_cycles c ON c.id = p.cycle_id
      WHERE p.user_id=$1 ORDER BY p.calculated_at DESC LIMIT $2`, [userId, limit])).rows;
  const owed = (await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric(12,2) t FROM mo_creator_financial_ledger
      WHERE user_id=$1`, [userId])).rows[0];
  // Amounts stay strings, exactly as Phase 5 keeps them.
  return {
    outstanding: String(owed.t), currency: "INR",
    payouts: rows.map((p) => ({
      cycle: p.cycle, pointsBasis: Number(p.points_basis), rate: String(p.rate),
      gross: String(p.gross_amount), adjustments: String(p.adjustments),
      net: String(Number(p.gross_amount) + Number(p.adjustments)),
      paid: String(p.paid), status: p.status, currency: p.currency,
      calculatedAt: p.calculated_at, approvedAt: p.approved_at, paidAt: p.paid_at,
      paymentReference: p.payment_reference ?? null,
    })),
  };
}

/* ── The review queue ─────────────────────────────────────────────────── */
export async function getReviewBacklog(pool: Pool, reach: CreatorReach, limit = 25) {
  const params: unknown[] = [];
  let where = "";
  if (reach.level === "self") { params.push(reach.userId); where = ` AND a.user_id = $${params.length}`; }
  else if (reach.level === "team") {
    params.push(reach.teamIds, reach.userId);
    where = ` AND (a.user_id IN (SELECT user_id FROM mo_creator_team_members
                                  WHERE team_id = ANY($${params.length - 1}::bigint[]))
              OR a.user_id = $${params.length})`;
  }
  params.push(limit);
  const rows = (await pool.query(
    `SELECT s.id, s.version_no, s.submitted_at, a.title AS task,
            COALESCE(NULLIF(cp.display_name,''), u.full_name) AS creator,
            t.name AS team, e.title AS event,
            ROUND(EXTRACT(EPOCH FROM (NOW() - s.submitted_at))/3600)::int AS waiting_hours
       FROM mo_creator_submissions s
       JOIN mo_creator_assignments a ON a.id = s.assignment_id
       JOIN mo_creator_opportunities o ON o.id = a.opportunity_id
       JOIN mo_creator_events e ON e.id = o.event_id
       JOIN users u ON u.id = a.user_id
       LEFT JOIN mo_creator_profiles cp ON cp.user_id = a.user_id
       LEFT JOIN mo_creator_team_members m ON m.user_id = a.user_id AND m.is_primary
       LEFT JOIN mo_creator_teams t ON t.id = m.team_id
      WHERE s.status='submitted'${where}
      ORDER BY s.submitted_at LIMIT $${params.length}`, params)).rows;
  const total = Number((await pool.query(
    `SELECT COUNT(*)::int c FROM mo_creator_submissions s
       JOIN mo_creator_assignments a ON a.id = s.assignment_id
      WHERE s.status='submitted'${where}`, params.slice(0, -1))).rows[0].c);
  return {
    total, shown: rows.length,
    olderThan24h: rows.filter((r) => Number(r.waiting_hours) >= 24).length,
    oldestWaitingHours: rows.length ? Number(rows[0].waiting_hours) : null,
    items: rows.map((r) => ({
      submissionId: Number(r.id), task: r.task, event: r.event, creator: r.creator,
      team: r.team ?? null, version: Number(r.version_no), waitingHours: Number(r.waiting_hours),
    })),
  };
}

/* ── Competitions, for management ─────────────────────────────────────── */
export async function getCompetitionSummary(pool: Pool, limit = 15) {
  const rows = (await pool.query(
    `SELECT k.id, k.name, k.status, k.scope, k.starts_at, k.ends_at,
            t.name AS team,
            COUNT(*) FILTER (WHERE p.status='registered')::int AS participants,
            (SELECT COUNT(*)::int FROM mo_creator_competition_results r
              WHERE r.competition_id = k.id) AS results,
            (SELECT COUNT(*)::int FROM mo_creator_competition_results r
              WHERE r.competition_id = k.id AND r.place = 1) AS winners
       FROM mo_creator_competitions k
       LEFT JOIN mo_creator_competition_participants p ON p.competition_id = k.id
       LEFT JOIN mo_creator_teams t ON t.id = k.team_id
      WHERE k.status <> 'draft'
      GROUP BY k.id, k.name, k.status, k.scope, k.starts_at, k.ends_at, t.name
      ORDER BY k.starts_at DESC LIMIT $1`, [limit])).rows;
  return rows.map((k) => ({
    id: Number(k.id), name: k.name, status: k.status, scope: k.scope,
    team: k.team ?? null, startsAt: k.starts_at, endsAt: k.ends_at,
    participants: Number(k.participants), results: Number(k.results), winners: Number(k.winners),
  }));
}

/* ── Chat: discussion attached to a business object ───────────────────────
   Reuses mo_comments, which is how Nerve already attaches a thread to a
   record. There is no conversation table, no direct messaging and no
   free-floating thread: a discussion belongs to the work it is about, and its
   permissions are the work's permissions. */
export type CreatorThreadKind = "creator_assignment" | "creator_opportunity";

/** Who may read or post on this thread, decided from the record itself. */
export async function canAccessCreatorThread(
  pool: Pool, reach: CreatorReach, kind: CreatorThreadKind, entityId: number,
): Promise<boolean> {
  if (reach.level === "all") return true;
  if (kind === "creator_assignment") {
    const a = (await pool.query(
      `SELECT user_id FROM mo_creator_assignments WHERE id=$1`, [entityId])).rows[0];
    if (!a) return false;
    if (String(a.user_id) === reach.userId) return true;
    if (reach.level === "team")
      return !!(await pool.query(
        `SELECT 1 FROM mo_creator_team_members
          WHERE user_id=$1 AND team_id = ANY($2::bigint[])`, [a.user_id, reach.teamIds])).rows[0];
    return false;
  }
  /* An opportunity's thread is open to anyone who can see the opportunity —
     the people deciding whether to put their hand up for it. */
  const o = (await pool.query(
    `SELECT o.status, e.status AS event_status FROM mo_creator_opportunities o
       JOIN mo_creator_events e ON e.id = o.event_id WHERE o.id=$1`, [entityId])).rows[0];
  if (!o) return false;
  return o.status !== "draft" && o.event_status !== "draft";
}

export async function getCreatorThread(
  pool: Pool, kind: CreatorThreadKind, entityId: number, limit = 100,
) {
  const rows = (await pool.query(
    `SELECT c.id, c.body, c.created_at, c.user_id,
            COALESCE(NULLIF(cp.display_name,''), u.full_name) AS author,
            cp.creator_role
       FROM mo_comments c
       LEFT JOIN users u ON u.id = c.user_id
       LEFT JOIN mo_creator_profiles cp ON cp.user_id = c.user_id
      WHERE c.entity_type=$1 AND c.entity_id=$2
      ORDER BY c.created_at, c.id LIMIT $3`, [kind, entityId, limit])).rows;
  return rows.map((c) => ({
    id: Number(c.id), body: c.body, author: c.author ?? "Someone",
    authorId: c.user_id, creatorRole: c.creator_role ?? null, createdAt: c.created_at,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE AI SURFACE

   Everything above takes a pool, so it can be unit-tested and reused. These
   wrappers bind it, and they are the ONLY functions the AI tool file imports.

   That is the whole point: server/ai/tools/creator-tools.ts must never import
   a database handle, a query builder or a table name (§86). It imports these
   names, and the boundary holds by construction rather than by discipline.
   ═══════════════════════════════════════════════════════════════════════════ */
import * as CA from "./creator-analytics.js";

/* The pool is reached LAZILY, and that is load-bearing.

   server/ai/tools/registry.ts imports the creator tools, which import this
   file. If the handle were a top-level import, merely building the registry
   would open a database connection — and the AI unit tests, which exist
   partly to prove the AI layer needs no database, would all start one. A
   dynamic import keeps the cost where it belongs: on the first call. */
let poolRef: Pool | null = null;
async function db(): Promise<Pool> {
  if (!poolRef) ({ pool: poolRef } = await import("./db.js"));
  return poolRef;
}

/** Translate the AI layer's resolved reach into the analytics scope. */
export function reachToScope(reach: CreatorReach): CA.AnalyticsScope {
  if (reach.level === "all") return { level: "all" };
  if (reach.level === "team") return { level: "team", teamIds: reach.teamIds, userId: reach.userId };
  return { level: "self", userId: reach.userId };
}

/** The window a tool asked for, validated by Phase 7's own resolver. */
export async function resolvePeriod(period: string | undefined) {
  const p = await db();
  const r = await CA.resolveRange(p, { range: period ?? "30d" });
  return "error" in r ? await CA.resolveRange(p, { range: "30d" }) as CA.Range : r;
}

export const aiCreatorIdentity = async (userId: string) => getCreatorIdentity(await db(), userId);
export const aiCreatorWork = async (userId: string) => getCreatorWork(await db(), userId);
export const aiCreatorContent = async (userId: string) => getCreatorContent(await db(), userId);
export const aiCreatorStanding = async (userId: string) => getCreatorStanding(await db(), userId);
export const aiCreatorPayouts = async (userId: string) => getCreatorPayouts(await db(), userId);
export const aiReviewBacklog = async (reach: CreatorReach) => getReviewBacklog(await db(), reach);
export const aiCompetitions = async () => getCompetitionSummary(await db());
export const aiThread = async (kind: CreatorThreadKind, id: number) => getCreatorThread(await db(), kind, id);
export const aiCanAccessThread = async (reach: CreatorReach, kind: CreatorThreadKind, id: number) =>
  canAccessCreatorThread(await db(), reach, kind, id);

/* Analytics, through Phase 7 — never recomputed here. A number the assistant
   quotes and a number the dashboard shows come from the same SQL. */
export async function aiProduction(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  const scope = reachToScope(reach);
  const [now, before] = await Promise.all([
    CA.production(await db(), scope, range),
    CA.production(await db(), scope, CA.previousRange(range)),
  ]);
  return {
    period: { from: range.from, to: range.to, label: range.label },
    current: now,
    trends: {
      approved: CA.trend(now.approved, before.approved),
      completed: CA.trend(now.completed, before.completed),
      submissions: CA.trend(now.submissions, before.submissions),
      points: CA.trend(now.points, before.points),
      approvalRate: CA.trend(now.approval_rate ?? 0, before.approval_rate ?? 0),
    },
  };
}
export async function aiFunnel(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  return { period: { from: range.from, to: range.to, label: range.label },
           funnel: await CA.funnel(await db(), reachToScope(reach), range) };
}
export async function aiTimings(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  return { period: { from: range.from, to: range.to, label: range.label },
           review: await CA.timings(await db(), reachToScope(reach), range) };
}
export async function aiTeams(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  return { period: { from: range.from, to: range.to, label: range.label },
           teams: await CA.teamTable(await db(), reachToScope(reach), range) };
}
export async function aiCreatorTable(reach: CreatorReach, period?: string, limit = 25) {
  const range = await resolvePeriod(period);
  const t = await CA.creatorTable(await db(), reachToScope(reach), range, Math.min(50, limit), 0);
  return { period: { from: range.from, to: range.to, label: range.label },
           total: t.total, shown: t.rows.length, creators: t.rows };
}
export async function aiSignals(reach: CreatorReach) {
  return { signals: await CA.signals(await db(), reachToScope(reach)),
           thresholds: CA.SIGNAL_THRESHOLDS };
}
export async function aiConversion(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  const c = await CA.conversion(await db(), reachToScope(reach), range, 15);
  return { period: { from: range.from, to: range.to, label: range.label }, ...c };
}
export async function aiRecognition(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  return { period: { from: range.from, to: range.to, label: range.label },
           recognition: await CA.recognition(await db(), reachToScope(reach), range) };
}
/** Network money. Creator Admin only — the caller checks before calling. */
export async function aiMoney(reach: CreatorReach, period?: string) {
  const range = await resolvePeriod(period);
  const scope = reachToScope(reach);
  const prod = await CA.production(await db(), scope, range);
  return { period: { from: range.from, to: range.to, label: range.label },
           money: await CA.money(await db(), scope, range, prod.approved) };
}
/** One named creator, for a manager. The caller has already checked reach. */
export async function aiOneCreator(reach: CreatorReach, userId: string, period?: string) {
  const range = await resolvePeriod(period);
  const self: CA.AnalyticsScope = { level: "self", userId };
  const [now, before, fun, identity] = await Promise.all([
    CA.production(await db(), self, range),
    CA.production(await db(), self, CA.previousRange(range)),
    CA.funnel(await db(), self, range),
    getCreatorIdentity(await db(), userId),
  ]);
  return {
    creator: identity,
    period: { from: range.from, to: range.to, label: range.label },
    current: now, funnel: fun,
    trends: {
      approved: CA.trend(now.approved, before.approved),
      completed: CA.trend(now.completed, before.completed),
      points: CA.trend(now.points, before.points),
    },
    // Money is NOT here. A manager reads it through the payout surfaces, which
    // have their own Phase 5 rules; a team lead has no financial visibility.
  };
}
/** Whether a named creator is inside this caller's reach. */
export async function aiCreatorInReach(reach: CreatorReach, userId: string): Promise<boolean> {
  if (reach.level === "all") return true;
  if (reach.level === "self") return userId === reach.userId;
  if (userId === reach.userId) return true;
  return !!(await (await db()).query(
    `SELECT 1 FROM mo_creator_team_members WHERE user_id=$1 AND team_id = ANY($2::bigint[])`,
    [userId, reach.teamIds])).rows[0];
}
/** The creators a notification may be sent to, within reach. */
export async function aiNotifiableCreators(reach: CreatorReach, userIds: string[]) {
  if (!userIds.length) return [];
  const params: unknown[] = [userIds];
  let where = "";
  if (reach.level === "self") { params.push(reach.userId); where = ` AND c.user_id = $${params.length}`; }
  else if (reach.level === "team") {
    params.push(reach.teamIds);
    where = ` AND c.user_id IN (SELECT user_id FROM mo_creator_team_members
                                 WHERE team_id = ANY($${params.length}::bigint[]))`;
  }
  return (await (await db()).query(
    `SELECT c.user_id, COALESCE(NULLIF(c.display_name,''), u.full_name) AS name
       FROM mo_creator_profiles c JOIN users u ON u.id = c.user_id
      WHERE c.user_id = ANY($1::text[]) AND c.status='active'${where}
      ORDER BY name`, params)).rows.map((r) => ({ userId: String(r.user_id), name: String(r.name) }));
}
