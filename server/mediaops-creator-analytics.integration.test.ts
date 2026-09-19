// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 7: analytics and intelligence.

   ANALYTICS IS DERIVED DATA. IT IS NOT A SOURCE OF TRUTH.

   Two kinds of assertion carry this file.

     RECONCILIATION. Every headline figure is computed a second time, here, by
     plain SQL against the source table, and the two must agree exactly. Points
     on the dashboard equal SUM over the point ledger equal the leaderboard
     equal the creator's own detail. If analytics ever starts keeping its own
     version of a number, these tests say so.

     NON-MUTATION. A fingerprint of the point ledger, the financial ledger, the
     payouts, the submissions and the assignments is taken before and after
     every dashboard read, export and signal computation, and must be
     identical. Analytics reads; it does not touch.

   Real handlers, real database. Fixtures are `zan-` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PX = "zan";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let CA: typeof import("./creator-analytics.js");
let server: Server;
let base = "";
let teamA = 0, teamB = 0, cycle = 0;

const A = {
  nerveAdmin:   { id: `${PX}-nadmin`, role: "admin", team: "media",   cr: null },
  mediaEmp:     { id: `${PX}-memp`,   role: "user",  team: "media",   cr: null },
  creatorAdmin: { id: `${PX}-cadmin`, role: "user",  team: "media",   cr: "creator_admin" },
  leadA:        { id: `${PX}-leadA`,  role: "user",  team: "creator", cr: "team_lead" },
  leadB:        { id: `${PX}-leadB`,  role: "user",  team: "creator", cr: "team_lead" },
  c1:           { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  c2:           { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  cB:           { id: `${PX}-cB`,     role: "user",  team: "creator", cr: "creator" },
} as const;
type ActorName = keyof typeof A;

async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}
{
  const url = await realDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ||= "integration-test-secret";
    process.env.SUPER_ADMIN_PASSWORD ||= "integration-test-password";
    const { pool: p } = await import("./db.js");
    pool = p;
    try { await pool.query("SELECT 1"); dbUp = true; } catch { dbUp = false; }
  }
}
const maybe = dbUp ? describe : describe.skip;

/* Every query the handlers run, counted — an N+1 is a number, not a feeling. */
let queryCount = 0;
let counting = false;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZAN ${a.id}` }
      : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never,
    otpVerifyLimiter: noLimit as never,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/media`;

  const original = pool.query.bind(pool);
  (pool as unknown as { query: unknown }).query = ((...args: unknown[]) => {
    if (counting) queryCount++;
    return (original as (...a: unknown[]) => unknown)(...args);
  });
}
async function as(actor: ActorName | "anon", method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await fetch(base + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* csv or html */ }
  return { status: r.status, body: parsed, text, type: r.headers.get("content-type") ?? "" };
}
async function countQueries<T>(fn: () => Promise<T>): Promise<{ result: T; queries: number }> {
  queryCount = 0; counting = true;
  const result = await fn();
  counting = false;
  return { result, queries: queryCount };
}

/* ── The five tables analytics must never touch ─────────────────────────── */
async function fingerprint() {
  const one = async (sql: string) =>
    String((await pool.query(sql, [`${PX}-%`])).rows[0].h);
  return {
    points: await one(`SELECT COALESCE(md5(string_agg(id||'|'||user_id||'|'||points,',' ORDER BY id)),'-') h
                         FROM mo_creator_point_ledger WHERE user_id LIKE $1`),
    money: await one(`SELECT COALESCE(md5(string_agg(id||'|'||amount||'|'||entry_type,',' ORDER BY id)),'-') h
                        FROM mo_creator_financial_ledger WHERE user_id LIKE $1`),
    payouts: await one(`SELECT COALESCE(md5(string_agg(id||'|'||gross_amount||'|'||status,',' ORDER BY id)),'-') h
                          FROM mo_creator_payouts WHERE user_id LIKE $1`),
    submissions: await one(`SELECT COALESCE(md5(string_agg(s.id||'|'||s.status||'|'||s.version_no,',' ORDER BY s.id)),'-') h
                              FROM mo_creator_submissions s JOIN mo_creator_assignments a ON a.id=s.assignment_id
                             WHERE a.user_id LIKE $1`),
    assignments: await one(`SELECT COALESCE(md5(string_agg(id||'|'||status||'|'||COALESCE(completed_at::text,'~'),',' ORDER BY id)),'-') h
                              FROM mo_creator_assignments WHERE user_id LIKE $1`),
  };
}

/* ── Fixtures ─────────────────────────────────────────────────────────────
   A small, exactly-known network: the reconciliation tests recount every
   figure from the source, so the numbers have to be knowable by hand too. */
const DAY = 86_400_000;
const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();

/* Phase 2 allows one LIVE assignment per creator per opportunity, so each
   piece of fixture work gets its own opportunity on the shared event. */
async function newOpportunity(label: string) {
  return Number((await pool.query(
    `INSERT INTO mo_creator_opportunities (event_id, title, required_count, status)
     VALUES ($1,$2,5,'open') RETURNING id`, [eventId, `${PX} ${label}`])).rows[0].id);
}
async function makeAssignment(userId: string, teamId: number, opts: {
  created: number; completed?: number; declined?: boolean; deadline?: string;
}) {
  const own = await newOpportunity(`role ${Math.random().toString(36).slice(2, 8)}`);
  const id = Number((await pool.query(
    `INSERT INTO mo_creator_assignments (opportunity_id, user_id, team_id, title, status,
       deadline, created_at, accepted_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [own, userId, teamId, `${PX} task`,
     opts.declined ? "declined" : opts.completed != null ? "completed" : "in_progress",
     opts.deadline ?? null, ago(opts.created), ago(opts.created),
     opts.completed != null ? ago(opts.completed) : null])).rows[0].id);
  return id;
}
async function makeSubmission(assignmentId: number, version: number, opts: {
  submitted: number; status?: "submitted" | "approved" | "changes_requested" | "rejected"; reviewed?: number;
}) {
  return Number((await pool.query(
    `INSERT INTO mo_creator_submissions (assignment_id, version_no, content_url, status,
       submitted_at, reviewed_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [assignmentId, version, `https://drive.google.com/file/d/${PX}-${assignmentId}-${version}/view`,
     opts.status ?? "submitted", ago(opts.submitted),
     opts.reviewed != null ? ago(opts.reviewed) : null])).rows[0].id);
}
let eventId = 0, oppId = 0;

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZAN ${a.id}`, `${a.id}@cana.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
        [a.id, a.role === "admin" ? "admin" : "employee"]);
    if (a.cr)
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status) VALUES ($1,$2,'active')
         ON CONFLICT (user_id) DO UPDATE SET creator_role=EXCLUDED.creator_role, status='active'`,
        [a.id, a.cr]);
  }
  const mk = async (n: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} ${n}`, lead])).rows[0].id);
  teamA = await mk("Alpha", A.leadA.id);
  teamB = await mk("Beta", A.leadB.id);
  for (const [t, u] of [[teamA, A.c1.id], [teamA, A.c2.id], [teamA, A.leadA.id],
                        [teamB, A.cB.id], [teamB, A.leadB.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);

  eventId = Number((await pool.query(
    `INSERT INTO mo_creator_events (title, event_date, status) VALUES ($1, CURRENT_DATE, 'open') RETURNING id`,
    [`${PX} Analytics Event`])).rows[0].id);
  oppId = Number((await pool.query(
    `INSERT INTO mo_creator_opportunities (event_id, title, required_count, status)
     VALUES ($1,$2,5,'open') RETURNING id`, [eventId, "Reel Creator"])).rows[0].id);
  cycle = Number((await pool.query(
    `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
     VALUES ($1, CURRENT_DATE - 20, CURRENT_DATE + 10, 'closed') RETURNING id`,
    [`${PX} Analytics Cycle`])).rows[0].id);

  /* c1 — the busy one. 4 assignments in the window, 3 completed, 4 versions
     across 3 assignments: 2 approved (one first-pass, one after a revision),
     1 still waiting. */
  const a1 = await makeAssignment(A.c1.id, teamA, { created: 20, completed: 18 });
  await makeSubmission(a1, 1, { submitted: 17, status: "approved", reviewed: 16 });
  const a2 = await makeAssignment(A.c1.id, teamA, { created: 15, completed: 13 });
  await makeSubmission(a2, 1, { submitted: 12, status: "changes_requested", reviewed: 11 });
  await makeSubmission(a2, 2, { submitted: 10, status: "approved", reviewed: 9 });
  const a3 = await makeAssignment(A.c1.id, teamA, { created: 8, completed: 6 });
  await makeSubmission(a3, 1, { submitted: 5 });                       // awaiting review
  await makeAssignment(A.c1.id, teamA, { created: 3, deadline: "2020-01-01" });  // overdue

  /* c2 — quieter. 2 assignments, 1 completed, 1 rejected version. */
  const b1 = await makeAssignment(A.c2.id, teamA, { created: 14, completed: 12 });
  await makeSubmission(b1, 1, { submitted: 11, status: "rejected", reviewed: 10 });
  await makeAssignment(A.c2.id, teamA, { created: 9 });

  /* cB — on the other team, so scope tests have something to exclude. */
  const d1 = await makeAssignment(A.cB.id, teamB, { created: 10, completed: 8 });
  await makeSubmission(d1, 1, { submitted: 7, status: "approved", reviewed: 6 });

  for (const [who, pts] of [[A.c1.id, 120], [A.c2.id, 45], [A.cB.id, 30]] as const)
    await pool.query(
      `INSERT INTO mo_creator_point_ledger (user_id, cycle_id, points, source_type, reason, created_by, created_at)
       VALUES ($1,$2,$3,'manual',$4,$5,$6)`,
      [who, cycle, pts, `${PX} seeded`, A.creatorAdmin.id, ago(10)]);

  // Money, so the payout reconciliation has something to reconcile.
  const payoutId = Number((await pool.query(
    `INSERT INTO mo_creator_payouts (user_id, cycle_id, points_basis, rate,
       gross_amount, status, calculated_at, approved_at, paid_at, payment_reference, paid_by)
     VALUES ($1,$2,120,'10.00','1200.00','paid',$3,$3,$3,'UTR-ZAN-1',$4) RETURNING id`,
    [A.c1.id, cycle, ago(5), A.creatorAdmin.id])).rows[0].id);
  await pool.query(
    `INSERT INTO mo_creator_financial_ledger (user_id, payout_id, cycle_id, entry_type, amount, description, created_at)
     VALUES ($1,$2,$3,'payout','1200.00','Payout approved',$4),
            ($1,$2,$3,'payment','-1200.00','Payment recorded',$4)`,
    [A.c1.id, payoutId, cycle, ago(5)]);

  // Recognition, for the recognition analytics.
  const achId = Number((await pool.query(
    `SELECT id FROM mo_creator_achievements WHERE code='first_content'`)).rows[0].id);
  await pool.query(
    `INSERT INTO mo_creator_achievement_awards (achievement_id, user_id, source_type, note, awarded_at)
     VALUES ($1,$2,'auto','First Approved Content',$3) ON CONFLICT DO NOTHING`,
    [achId, A.c1.id, ago(16)]);
}

async function cleanup() {
  const like = [`${PX}-%`];
  await pool.query(`DELETE FROM mo_creator_competition_results WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_competition_scores WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_competition_participants WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_competitions WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_financial_ledger WHERE user_id LIKE $1 OR created_by LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_payouts WHERE user_id LIKE $1 OR calculated_by LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_payout_rules WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_point_ledger WHERE user_id LIKE $1 OR created_by LIKE $1
                      OR cycle_id IN (SELECT id FROM mo_creator_cycles WHERE label LIKE $2)`,
    [`${PX}-%`, `${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
                      (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`, like);
  await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_events WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_cycles WHERE label LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, like);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, like);
}

beforeAll(async () => {
  if (!dbUp) return;
  const db = await import("./mediaops-db.js");
  await db.bootstrapCreatorNetwork();
  api = await import("./mediaops-api.js");
  CA = await import("./creator-analytics.js");
  await cleanup(); await seed(); await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* The window used throughout: 30 days, which contains every fixture above. */
const W = "range=30d";

/* ── §73: reconciliation ─────────────────────────────────────────────────── */

maybe("every figure reconciles with its source", () => {
  it("approved content equals the submission table", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    expect(r.status).toBe(200);
    const dash = (r.body!.production as Record<string, number>).approved;
    const sql = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id
        WHERE s.status='approved' AND s.reviewed_at IS NOT NULL
          AND (s.reviewed_at AT TIME ZONE 'Asia/Kolkata')::date
              BETWEEN (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 29
                  AND (NOW() AT TIME ZONE 'Asia/Kolkata')::date`)).rows[0].c);
    expect(dash).toBe(sql);
    const mine = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id
        WHERE a.user_id LIKE $1 AND s.status='approved'`, [`${PX}-%`])).rows[0].c);
    expect(mine).toBeGreaterThanOrEqual(3);     // the fixture's three approvals
  });

  it("points equal SUM over the point ledger, on every screen that shows them", async () => {
    // B. the creator's own analytics — and the cycle it says it used.
    const me = await as("c1", "GET", "/creator/analytics/me?range=cycle");
    const rank = me.body!.rank as Record<string, number | null>;
    const usedCycle = Number(rank.cycle_id);
    // A. the source, for that same cycle
    const ledger = Number((await pool.query(
      `SELECT COALESCE(SUM(points),0)::int t FROM mo_creator_point_ledger
        WHERE user_id=$1 AND cycle_id=$2`, [A.c1.id, usedCycle])).rows[0].t);
    // C. the Phase 4 leaderboard
    const board = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${usedCycle}`);
    const row = (board.body!.rows as Array<{ user_id: string; points: number }>)
      .find((x) => x.user_id === A.c1.id);
    // D. the creator detail a manager sees
    const detail = await as("creatorAdmin", "GET",
      `/creator/analytics/creators/${A.c1.id}?range=cycle`);

    expect(rank.points).toBe(ledger);
    expect(row?.points ?? 0).toBe(ledger);
    expect((detail.body!.rank as Record<string, number>).points).toBe(ledger);
    // And against this file's own cycle, where the figure is known by hand.
    expect(Number((await pool.query(
      `SELECT COALESCE(SUM(points),0)::int t FROM mo_creator_point_ledger
        WHERE user_id=$1 AND cycle_id=$2`, [A.c1.id, cycle])).rows[0].t)).toBe(120);
    const ours = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cycle}`);
    expect((ours.body!.rows as Array<{ user_id: string; points: number }>)
      .find((x) => x.user_id === A.c1.id)!.points).toBe(120);
  });

  it("rank equals the Phase 4 rank engine — the two cannot drift", async () => {
    const board = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cycle}`);
    const rows = board.body!.rows as Array<{ user_id: string; place: number }>;
    for (const who of [A.c1.id, A.c2.id, A.cB.id]) {
      const engine = rows.find((x) => x.user_id === who)?.place ?? null;
      const analytics = await CA.rankFor(pool, who, cycle);
      expect(analytics.place, who).toBe(engine);
    }
  });

  it("payout figures equal Phase 5's own tables", async () => {
    /* Reconciled against a creator this file OWNS. The network-wide figure is
       a moving target while sibling suites create and settle their own
       payouts, and a reconciliation that races is not a reconciliation. */
    const mine = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const money = mine.body!.payout as Record<string, string | number>;
    const src = (await pool.query(
      `SELECT COALESCE(SUM(gross_amount),0)::numeric(12,2) gross,
              COALESCE(SUM(CASE WHEN status='paid' THEN gross_amount ELSE 0 END),0)::numeric(12,2) paid
         FROM mo_creator_payouts WHERE user_id=$1`, [A.c1.id])).rows[0];
    expect(money.gross).toBe(String(src.gross));
    expect(money.paid).toBe(String(src.paid));
    expect(money.gross).toBe("1200.00");             // the fixture, by hand
    // Amounts stay strings the whole way, as they do in Phase 5.
    expect(typeof money.gross).toBe("string");
    expect(String(money.gross)).toContain(".");

    /* And the network block is well-formed money, without asserting a total
       that another suite is entitled to move underneath it. */
    const net = (await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`))
      .body!.money as Record<string, string>;
    for (const k of ["gross", "paid", "adjustments", "outstanding"])
      expect(String(net[k]), k).toMatch(/^-?\d+\.\d{2}$/);
  });

  it("the creator table's per-creator figures match the network totals", async () => {
    const list = await as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=200`);
    const mine = (list.body!.creators as Array<Record<string, number | string>>)
      .filter((c) => String(c.user_id).startsWith(`${PX}-`));
    const approvedSum = mine.reduce((a, c) => a + Number(c.approved), 0);
    const perCreator = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id
        WHERE a.user_id LIKE $1 AND s.status='approved' AND s.reviewed_at IS NOT NULL
          AND (s.reviewed_at AT TIME ZONE 'Asia/Kolkata')::date
              BETWEEN (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 29
                  AND (NOW() AT TIME ZONE 'Asia/Kolkata')::date`, [`${PX}-%`])).rows[0].c);
    expect(approvedSum).toBe(perCreator);
  });

  it("the funnel counts unique assignments, and says so", async () => {
    /* Read as the Team Lead: their scope is exactly this file's team, so the
       recount below covers the same people the dashboard did. */
    const r = await as("leadA", "GET", `/creator/analytics/content?${W}`);
    const f = r.body!.funnel as Record<string, number | null>;
    const cohort = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_assignments a
        WHERE (a.user_id IN (SELECT user_id FROM mo_creator_team_members WHERE team_id=$1)
               OR a.user_id = $2)
          AND (a.created_at AT TIME ZONE 'Asia/Kolkata')::date
              BETWEEN (NOW() AT TIME ZONE 'Asia/Kolkata')::date - 29
                  AND (NOW() AT TIME ZONE 'Asia/Kolkata')::date`,
      [teamA, A.leadA.id])).rows[0].c);
    expect(f.assigned).toBe(cohort);
    // c1 submitted 4 versions across 3 assignments; the funnel counts the 3.
    const own = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const mf = own.body!.funnel as Record<string, number>;
    const mp = own.body!.production as Record<string, number>;
    expect(mf.submitted).toBe(3);
    expect(mp.submissions).toBe(4);             // versions, a different unit
    expect(mf.approved).toBe(2);
  });

  it("first-pass approval is read from the version history, not the latest row", async () => {
    const own = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const f = own.body!.funnel as Record<string, number | null>;
    // Two assignments reached approval; only one did it on version 1.
    expect(f.approved).toBe(2);
    expect(f.first_pass_rate).toBe(50);
    expect(f.avg_versions_to_approval).toBe(1.5);
  });

  it("approval rate is over reviewed versions, never over assignments", async () => {
    const own = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const p = own.body!.production as Record<string, number | null>;
    // 3 reviewed: approved, changes_requested, approved.
    expect(p.reviewed).toBe(3);
    expect(p.approved).toBe(2);
    expect(p.approval_rate).toBe(66.7);
    expect(p.revision_rate).toBe(33.3);
  });

  it("a rate over nothing is unknown, not zero", async () => {
    const quiet = await as("creatorAdmin", "GET",
      `/creator/analytics/creators/${A.leadB.id}?range=custom&from=2019-01-01&to=2019-01-31`);
    const p = quiet.body!.production as Record<string, number | null>;
    expect(p.reviewed).toBe(0);
    expect(p.approval_rate).toBeNull();
  });
});

/* ── §41: analytics does not write ───────────────────────────────────────── */

maybe("analytics reads and never writes", () => {
  it("every dashboard, export and signal leaves all five source tables untouched", async () => {
    const before = await fingerprint();
    for (const path of [
      `/creator/analytics/summary?${W}`,
      `/creator/analytics/me?${W}`,
      `/creator/analytics/team?${W}`,
      `/creator/analytics/creators?${W}`,
      `/creator/analytics/creators/${A.c1.id}?${W}`,
      `/creator/analytics/content?${W}`,
      `/creator/analytics/export?${W}&dataset=creators`,
      `/creator/analytics/export?${W}&dataset=teams`,
      `/creator/analytics/export?${W}&dataset=opportunities`,
      `/creator/analytics/summary?range=cycle`,
      `/creator/analytics/summary?range=custom&from=2026-01-01&to=2026-12-31`,
    ]) {
      const r = await as("creatorAdmin", "GET", path);
      expect(r.status, path).toBe(200);
    }
    expect(await fingerprint()).toEqual(before);
  });

  it("the analytics service contains no write of any kind", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./creator-analytics.ts", import.meta.url), "utf8");
    for (const verb of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i,
                        /\bTRUNCATE\b/i, /\bALTER\s+TABLE\b/i, /\bCREATE\s+(TABLE|MATERIALIZED)\b/i])
      expect(src, String(verb)).not.toMatch(verb);
  });

  it("no analytics table was added — there is nothing to become a second truth", async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public'
          AND (table_name LIKE '%analytic%' OR table_name LIKE '%_metrics%'
            OR table_name LIKE '%_signals%' OR table_name LIKE '%_rollup%')`);
    expect(rows).toEqual([]);
    const views = await pool.query(`SELECT matviewname FROM pg_matviews WHERE matviewname LIKE 'mo_creator%'`);
    expect(views.rows).toEqual([]);
  });

  it("a dashboard read writes nothing to the audit trail", async () => {
    const before = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`])).rows[0].c);
    await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    await as("c1", "GET", `/creator/analytics/me?${W}`);
    await as("leadA", "GET", `/creator/analytics/team?${W}`);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`])).rows[0].c))
      .toBe(before);
  });

  it("an export is audited, because it leaves the system", async () => {
    await as("creatorAdmin", "GET", `/creator/analytics/export?${W}&dataset=creators`);
    const row = (await pool.query(
      `SELECT after FROM mo_audit_logs WHERE action='creator_analytics.exported' AND actor_id LIKE $1
        ORDER BY id DESC LIMIT 1`, [`${PX}-%`])).rows[0];
    expect(row).toBeTruthy();
    const after = typeof row.after === "string" ? JSON.parse(row.after) : row.after;
    expect(after).toMatchObject({ dataset: "creators", scope: "all" });
  });
});

/* ── §6, §38: time is the server's ───────────────────────────────────────── */

maybe("windows are the server's, in IST", () => {
  it("presets resolve to IST calendar days", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/analytics/summary?range=7d");
    const p = r.body!.period as Record<string, string | number>;
    expect(p.days).toBe(7);
    expect(String(p.from)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(p.to)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const istToday = new Intl.DateTimeFormat("en-CA",
      { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(p.to).toBe(istToday);
  });

  it("a cycle window is the cycle's own dates, not date arithmetic", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/analytics/summary?range=cycle");
    const p = r.body!.period as Record<string, string | number>;
    const c = (await pool.query(
      `SELECT label, starts_on, ends_on FROM mo_creator_cycles
        WHERE status IN ('active','closed') ORDER BY starts_on DESC, id DESC LIMIT 1`)).rows[0];
    const day = (v: unknown) => v instanceof Date
      ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
      : String(v).slice(0, 10);
    expect(p.from).toBe(day(c.starts_on));
    expect(p.to).toBe(day(c.ends_on));
    expect(p.label).toBe(c.label);
  });

  it("a custom range is validated, and bounded", async () => {
    for (const q of ["range=custom", "range=custom&from=nonsense&to=2026-01-01",
                     "range=custom&from=2026-06-01&to=2026-01-01",
                     "range=custom&from=2000-01-01&to=2026-01-01"]) {
      const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${q}`);
      expect(r.status, q).toBe(400);
    }
    expect((await as("creatorAdmin", "GET",
      "/creator/analytics/summary?range=custom&from=2026-01-01&to=2026-01-31")).status).toBe(200);
  });

  it("an unknown preset falls back to 30 days rather than failing", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/analytics/summary?range=banana");
    expect(r.status).toBe(200);
    expect((r.body!.period as Record<string, number>).days).toBe(30);
  });

  it("freshness says live, because it is", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    expect(r.body!.freshness).toMatchObject({ mode: "live" });
    expect(Date.parse(String((r.body!.freshness as Record<string, string>).computed_at)))
      .toBeGreaterThan(Date.now() - 60_000);
  });
});

/* ── §9, §10: trends describe, they do not grade ─────────────────────────── */

maybe("trends are evidence, not grades", () => {
  it("no baseline is said, never shown as 0% or infinity", () => {
    expect(CA.trend(5, 0)).toMatchObject({ direction: "no_baseline", change_pct: null });
    expect(CA.trend(0, 0)).toMatchObject({ direction: "no_baseline", change_pct: null });
    expect(Number.isFinite(CA.trend(5, 0).change)).toBe(true);
  });

  it("too little history is said too", () => {
    expect(CA.trend(1, 1)).toMatchObject({ direction: "insufficient", change_pct: null });
    expect(CA.trend(2, 1).direction).toBe("increasing");
  });

  it("small movements are stable, not a trend", () => {
    expect(CA.trend(102, 100).direction).toBe("stable");
    expect(CA.trend(98, 100).direction).toBe("stable");
    expect(CA.trend(112, 100)).toMatchObject({ direction: "increasing", change_pct: 12 });
    expect(CA.trend(80, 100)).toMatchObject({ direction: "decreasing", change_pct: -20 });
  });

  it("the arithmetic is right", () => {
    expect(CA.trend(12, 8)).toMatchObject({ current: 12, previous: 8, change: 4, change_pct: 50 });
    expect(CA.rate(3, 4)).toBe(75);
    expect(CA.rate(1, 3)).toBe(33.3);
    expect(CA.rate(0, 0)).toBeNull();
  });

  it("a creator's own analytics carry trends and no score of any kind", async () => {
    const r = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const t = r.body!.trends as Record<string, { direction: string }>;
    for (const k of ["completed", "submissions", "approved", "points", "approval_rate", "review_hours"])
      expect(Object.keys(t), k).toContain(k);
    const blob = JSON.stringify(r.body).toLowerCase();
    for (const banned of ["performance_score", "creator_score", "growth_score", "quality_score",
                          "grade", "\"weak\"", "\"poor\"", "\"good\"", "\"bad\""])
      expect(blob, banned).not.toContain(banned);
  });

  it("rank movement is two ranks, not an invented interpretation", async () => {
    const r = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const rank = r.body!.rank as Record<string, unknown>;
    expect(Object.keys(rank)).toEqual(expect.arrayContaining(
      ["place", "previous_place", "cycle", "previous_cycle", "points", "previous_points"]));
    expect(Object.keys(rank)).not.toContain("places_gained");
  });

  it("consistency is spread over time, kept apart from approval", async () => {
    const r = await as("c1", "GET", `/creator/analytics/me?${W}`);
    const c = r.body!.consistency as Record<string, number>;
    expect(c.weeks).toBeGreaterThan(0);
    expect(c.active_weeks).toBeGreaterThan(0);
    expect(c.pct).toBe(CA.rate(c.active_weeks, c.weeks));
    // It is not the approval rate wearing another name.
    expect(Object.keys(r.body!.consistency as object)).not.toContain("quality");
  });
});

/* ── §19–§21: signals describe conditions ────────────────────────────────── */

maybe("signals describe conditions, never people", () => {
  it("the review backlog is counted and reconciles", async () => {
    /* Reconciled WITHIN one response. The backlog is a live network figure and
       sibling suites submit and review their own work continuously, so a count
       taken by a second query a moment later is a different instant — not a
       disagreement. What must hold is that the signal and the review block of
       the SAME request describe the same queue. */
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    const sig = (r.body!.signals as Array<Record<string, unknown>>)
      .find((s) => s.type === "review_backlog");
    const awaiting = Number((r.body!.review as Record<string, number>).awaiting_review);
    if (awaiting >= CA.SIGNAL_THRESHOLDS.review_backlog.attention) {
      expect(sig).toBeTruthy();
      expect(sig!.count).toBe(awaiting);
    } else {
      expect(sig).toBeUndefined();          // below the threshold, no signal
    }
    // And it covers at least this file's own pending submission.
    const mine = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id
        WHERE s.status='submitted' AND a.user_id LIKE $1`, [`${PX}-%`])).rows[0].c);
    expect(awaiting).toBeGreaterThanOrEqual(mine);
  });

  it("overdue work is flagged from the deadline, not a guess", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    const sig = (r.body!.signals as Array<Record<string, unknown>>)
      .find((s) => s.type === "overdue_work");
    expect(sig).toBeTruthy();
    expect(Number(sig!.count)).toBeGreaterThanOrEqual(1);   // the fixture's one
    expect(String(sig!.message)).toContain("past deadline");
  });

  it("severity describes the condition and names nobody", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    for (const s of r.body!.signals as Array<Record<string, string>>) {
      expect(["info", "attention", "critical"]).toContain(s.severity);
      // No signal carries a person's name or id.
      expect(s.message).not.toMatch(new RegExp(`${PX}-`));
      expect(s.type).not.toMatch(/creator_is|weak|poor|bad/);
    }
  });

  it("thresholds are constants anyone can read", () => {
    expect(CA.SIGNAL_THRESHOLDS.review_backlog).toEqual({ attention: 15, critical: 50 });
    expect(CA.SIGNAL_THRESHOLDS.high_revision_rate.min_reviewed).toBe(10);
    expect(CA.SIGNAL_THRESHOLDS.low_activity.window_days).toBe(30);
  });

  it("a creator with no work assigned is not called unproductive", async () => {
    /* leadB has an active profile and no assignments at all. §44: absence of
       work is not evidence of a problem, so they are not in the count. */
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    const sig = (r.body!.signals as Array<Record<string, number>>)
      .find((s) => String(s.type) === "low_activity");
    const eligible = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_profiles c
        WHERE c.status='active'
          AND EXISTS (SELECT 1 FROM mo_creator_assignments a WHERE a.user_id=c.user_id
                        AND a.created_at >= NOW() - INTERVAL '30 days')
          AND NOT EXISTS (SELECT 1 FROM mo_creator_assignments a WHERE a.user_id=c.user_id
                            AND a.completed_at >= NOW() - INTERVAL '30 days')
          AND NOT EXISTS (SELECT 1 FROM mo_creator_submissions s
                            JOIN mo_creator_assignments a ON a.id=s.assignment_id
                           WHERE a.user_id=c.user_id AND s.submitted_at >= NOW() - INTERVAL '30 days')`
    )).rows[0].c);
    if (sig) expect(sig.count).toBe(eligible);
    const named = (await pool.query(
      `SELECT 1 FROM mo_creator_assignments WHERE user_id=$1`, [A.leadB.id])).rows;
    expect(named).toEqual([]);                 // leadB genuinely has no work
  });

  it("data quality is surfaced with the record named, and repaired by nobody", async () => {
    const bad = Number((await pool.query(
      `INSERT INTO mo_creator_assignments (opportunity_id, user_id, team_id, title, status, completed_at)
       VALUES ($1,$2,$3,$4,'completed',NULL) RETURNING id`,
      [oppId, A.c2.id, teamA, `${PX} broken`])).rows[0].id);
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    const q = (r.body!.data_quality as Array<Record<string, unknown>>)
      .find((x) => x.type === "completed_without_timestamp");
    expect(q).toBeTruthy();
    expect((q!.sample as string[]).map(String)).toContain(String(bad));
    // Surfaced, not fixed.
    const still = (await pool.query(
      `SELECT status, completed_at FROM mo_creator_assignments WHERE id=$1`, [bad])).rows[0];
    expect(still.status).toBe("completed");
    expect(still.completed_at).toBeNull();
    await pool.query(`DELETE FROM mo_creator_assignments WHERE id=$1`, [bad]);
  });
});

/* ── §40, §74: security ──────────────────────────────────────────────────── */

maybe("scope holds, on every surface", () => {
  const ALL = [
    "/creator/analytics/summary", "/creator/analytics/me", "/creator/analytics/team",
    "/creator/analytics/creators", "/creator/analytics/content", "/creator/analytics/export",
  ];

  it("TESTS 1, 2 — anonymous and ordinary employees reach nothing", async () => {
    for (const p of ALL) {
      expect((await as("anon", "GET", `${p}?${W}`)).status, p).toBe(403);
      expect((await as("mediaEmp", "GET", `${p}?${W}`)).status, p).toBe(403);
    }
    expect((await as("anon", "GET", `/creator/analytics/creators/${A.c1.id}`)).status).toBe(403);
  });

  it("TEST 3 — a creator sees their own analytics and no management view", async () => {
    expect((await as("c1", "GET", `/creator/analytics/me?${W}`)).status).toBe(200);
    expect((await as("c1", "GET", `/creator/analytics/summary?${W}`)).status).toBe(403);
    expect((await as("c1", "GET", `/creator/analytics/team?${W}`)).status).toBe(403);
    const list = await as("c1", "GET", `/creator/analytics/creators?${W}&limit=200`);
    expect(list.status).toBe(200);
    expect((list.body!.creators as Array<{ user_id: string }>).map((c) => c.user_id)).toEqual([A.c1.id]);
    expect(list.body!.scope).toBe("self");
  });

  it("TESTS 7, 9 — a creator cannot read another creator, however they ask", async () => {
    expect((await as("c1", "GET", `/creator/analytics/creators/${A.c2.id}?${W}`)).status).toBe(404);
    expect((await as("c1", "GET", `/creator/analytics/creators/${A.cB.id}?${W}`)).status).toBe(404);
    // A forged cycle changes nothing about whose data comes back.
    const own = await as("c1", "GET", `/creator/analytics/me?range=cycle`);
    expect((own.body!.creator as Record<string, string>).user_id).toBe(A.c1.id);
  });

  it("TESTS 4, 8 — a Team Lead sees their team and cannot ask for another", async () => {
    const team = await as("leadA", "GET", `/creator/analytics/team?${W}`);
    expect(team.status).toBe(200);
    const names = (team.body!.teams as Array<{ team: string }>).map((t) => t.team);
    expect(names).toContain(`${PX} Alpha`);
    expect(names).not.toContain(`${PX} Beta`);
    // Naming team B narrows to nothing rather than widening to it.
    const forged = await as("leadA", "GET", `/creator/analytics/team?${W}&team_id=${teamB}`);
    expect(forged.status).toBe(200);
    expect((forged.body!.teams as unknown[])).toEqual([]);
    // And a creator on the other team is not readable.
    expect((await as("leadA", "GET", `/creator/analytics/creators/${A.cB.id}?${W}`)).status).toBe(404);
    expect((await as("leadA", "GET", `/creator/analytics/creators/${A.c1.id}?${W}`)).status).toBe(200);
  });

  it("a Team Lead's creator list holds only their team", async () => {
    const list = await as("leadA", "GET", `/creator/analytics/creators?${W}&limit=200`);
    const ids = (list.body!.creators as Array<{ user_id: string }>).map((c) => c.user_id);
    expect(ids).toContain(A.c1.id);
    expect(ids).toContain(A.c2.id);
    expect(ids).not.toContain(A.cB.id);
  });

  it("TESTS 5, 6 — a Creator Admin sees the network; a Nerve Admin follows Phase 0", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    expect(r.body!.scope).toBe("all");
    expect((await as("nerveAdmin", "GET", `/creator/analytics/summary?${W}`)).body!.scope).toBe("all");
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });

  it("a Team Lead sees no money anywhere in analytics", async () => {
    const team = await as("leadA", "GET", `/creator/analytics/team?${W}`);
    expect(team.body!.money).toBeNull();
    const detail = await as("leadA", "GET", `/creator/analytics/creators/${A.c1.id}?${W}`);
    expect(detail.body!.payout).toBeNull();
    expect(JSON.stringify(team.body)).not.toContain("1200.00");
    // A creator still sees their own.
    const own = await as("c1", "GET", `/creator/analytics/me?${W}`);
    expect((own.body!.payout as Record<string, string>).paid).toBe("1200.00");
    // And one creator never sees another's.
    expect(JSON.stringify((await as("c2", "GET", `/creator/analytics/me?${W}`)).body))
      .not.toContain("1200.00");
  });

  it("TESTS 10, 12 — a custom range cannot reach data the scope forbids", async () => {
    const wide = await as("c1", "GET",
      "/creator/analytics/creators?range=custom&from=2025-06-01&to=2026-12-31&limit=200");
    expect((wide.body!.creators as Array<{ user_id: string }>).map((c) => c.user_id)).toEqual([A.c1.id]);
    const lead = await as("leadA", "GET",
      "/creator/analytics/creators?range=custom&from=2025-06-01&to=2026-12-31&limit=200");
    expect((lead.body!.creators as Array<{ user_id: string }>).map((c) => c.user_id))
      .not.toContain(A.cB.id);
  });

  it("TEST 11 — an export carries exactly what the screen would", async () => {
    const admin = await as("creatorAdmin", "GET", `/creator/analytics/export?${W}&dataset=creators`);
    expect(admin.status).toBe(200);
    expect(admin.type).toContain("text/csv");
    expect(admin.text).toContain(`ZAN ${A.cB.id}`);

    const lead = await as("leadA", "GET", `/creator/analytics/export?${W}&dataset=creators`);
    expect(lead.status).toBe(200);
    expect(lead.text).toContain(`ZAN ${A.c1.id}`);
    expect(lead.text).not.toContain(`ZAN ${A.cB.id}`);       // team B is not theirs

    const own = await as("c1", "GET", `/creator/analytics/export?${W}&dataset=creators`);
    expect(own.text).toContain(`ZAN ${A.c1.id}`);
    expect(own.text).not.toContain(`ZAN ${A.c2.id}`);
    // Datasets that are not a creator's business are refused outright.
    expect((await as("c1", "GET", `/creator/analytics/export?${W}&dataset=teams`)).status).toBe(403);
    expect((await as("creatorAdmin", "GET", `/creator/analytics/export?${W}&dataset=nonsense`)).status)
      .toBe(400);
  });

  it("an export is a file, quoted properly, and cannot smuggle a formula", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/export?${W}&dataset=creators`);
    expect(r.type).toContain("charset=utf-8");
    expect(CA.toCsv(["a", "b"], [["=cmd()", 'say "hi", twice']]))
      .toBe(`a,b\r\n'=cmd(),"say ""hi"", twice"\r\n`);
  });

  it("TEST 13 — injection through a filter fails safely", async () => {
    for (const q of [`range=30d&team_id=1;DROP TABLE mo_creator_point_ledger`,
                     `range=30d&dataset=creators'--`,
                     `range=custom&from=2026-01-01' OR '1'='1&to=2026-12-31`]) {
      const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${q}`);
      expect([200, 400]).toContain(r.status);
    }
    expect((await pool.query(`SELECT to_regclass('mo_creator_point_ledger')::text t`)).rows[0].t)
      .toBe("mo_creator_point_ledger");
  });

  it("TEST 20 — nothing secret appears in any analytics response", async () => {
    const blobs: string[] = [];
    for (const p of [`/creator/analytics/summary?${W}`, `/creator/analytics/creators?${W}`,
                     `/creator/analytics/creators/${A.c1.id}?${W}`, `/creator/analytics/content?${W}`,
                     `/creator/analytics/export?${W}&dataset=creators`])
      blobs.push((await as("creatorAdmin", "GET", p)).text.toLowerCase());
    for (const blob of blobs)
      for (const secret of ["password", "password_hash", "api_key", "token", "secret",
                            "@cana.invalid", "session"])
        expect(blob, secret).not.toContain(secret);
  });
});

/* ── §36, §60: shape and cost ────────────────────────────────────────────── */

maybe("the cost of a dashboard does not grow with the network", () => {
  const BULK = `${PX}-bulk`;
  let bulkCycle = 0;

  beforeAll(async () => {
    if (!dbUp) return;
    /* 100 creators, 1,000 assignments, ~2,500 submission versions, built in
       four bulk statements. The point is not the absolute timing — it is that
       the query COUNT does not move when the row count does. */
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       SELECT $1||g, 'ZAN Bulk '||g, $1||g||'@cana.invalid', 'user', 'creator', 'active', 'x', ''
         FROM generate_series(1,100) g ON CONFLICT DO NOTHING`, [BULK]);
    await pool.query(
      `INSERT INTO mo_creator_profiles (user_id, creator_role, status)
       SELECT $1||g, 'creator', 'active' FROM generate_series(1,100) g ON CONFLICT DO NOTHING`, [BULK]);
    await pool.query(
      `INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
       SELECT $2, $1||g, true FROM generate_series(1,100) g ON CONFLICT DO NOTHING`, [BULK, teamA]);
    bulkCycle = Number((await pool.query(
      `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
       VALUES ($1, CURRENT_DATE - 20, CURRENT_DATE + 10, 'closed') RETURNING id`,
      [`${PX} Bulk Cycle`])).rows[0].id);
    await pool.query(
      `INSERT INTO mo_creator_opportunities (event_id, title, required_count, status)
       SELECT $1, $2||' bulk role '||g, 5, 'open' FROM generate_series(1,1000) g`, [eventId, PX]);
    await pool.query(
      `INSERT INTO mo_creator_assignments (opportunity_id, user_id, team_id, title, status,
         created_at, completed_at)
       SELECT o.id, $1||((o.n % 100) + 1), $2, 'ZAN bulk task',
              CASE WHEN o.n % 5 = 0 THEN 'in_progress' ELSE 'completed' END,
              NOW() - ((o.n % 25) || ' days')::interval,
              CASE WHEN o.n % 5 = 0 THEN NULL ELSE NOW() - ((o.n % 25) || ' days')::interval END
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY id) n FROM mo_creator_opportunities
                WHERE title LIKE $3) o`, [BULK, teamA, `${PX} bulk role %`]);
    await pool.query(
      `INSERT INTO mo_creator_submissions (assignment_id, version_no, content_url, status,
         submitted_at, reviewed_at)
       SELECT a.id, v.n, 'https://drive.google.com/file/d/zan-'||a.id||'-'||v.n||'/view',
              /* Earlier versions were sent back; the last one is the verdict.
                 Exactly one approval per assignment, as Phase 3 requires. */
              CASE WHEN v.n < 1 + (a.id % 7) THEN 'changes_requested'
                   WHEN a.id % 9 = 0          THEN 'submitted'
                   ELSE 'approved' END,
              NOW() - ((a.id % 20) || ' days')::interval,
              CASE WHEN v.n = 1 + (a.id % 7) AND a.id % 9 = 0 THEN NULL
                   ELSE NOW() - (GREATEST((a.id % 20) - 1, 0) || ' days')::interval END
         FROM mo_creator_assignments a
         CROSS JOIN generate_series(1, 8) v(n)
        WHERE a.user_id LIKE $1 AND a.completed_at IS NOT NULL
          AND v.n <= 1 + (a.id % 7)`, [`${BULK}%`]);
    await pool.query(
      `INSERT INTO mo_creator_point_ledger (user_id, cycle_id, points, source_type, reason, created_by, created_at)
       SELECT $1||g, $2, (g % 50) + 1, 'manual', 'ZAN bulk', $3, NOW() - INTERVAL '5 days'
         FROM generate_series(1,100) g`, [BULK, bulkCycle, A.creatorAdmin.id]);
  }, 120_000);

  afterAll(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_creator_point_ledger WHERE user_id LIKE $1`, [`${BULK}%`]);
    await pool.query(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
                        (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`, [`${BULK}%`]);
    await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, [`${BULK}%`]);
    await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`, [`${BULK}%`]);
    await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`, [`${BULK}%`]);
    await pool.query(`DELETE FROM mo_creator_cycles WHERE label LIKE $1`, [`${PX} Bulk%`]);
    await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${BULK}%`]);
  }, 120_000);

  it("the fixture really is that big", async () => {
    const n = async (t: string, w: string) =>
      Number((await pool.query(`SELECT COUNT(*)::int c FROM ${t} WHERE ${w}`, [`${BULK}%`])).rows[0].c);
    expect(await n("mo_creator_profiles", "user_id LIKE $1")).toBe(100);
    expect(await n("mo_creator_assignments", "user_id LIKE $1")).toBe(1000);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id
        WHERE a.user_id LIKE $1`, [`${BULK}%`])).rows[0].c)).toBeGreaterThan(2000);
  });

  it("the management summary is a fixed number of queries, whatever the size", async () => {
    const { result, queries } = await countQueries(() =>
      as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`));
    expect(result.status).toBe(200);
    // Ten sections, not one query per creator. Comfortably under twenty.
    expect(queries).toBeLessThan(20);
    expect((result.body!.production as Record<string, number>).assignments).toBeGreaterThan(500);
  });

  it("the creator table costs the same for 100 creators as for one", async () => {
    const one = await countQueries(() =>
      as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=1`));
    const many = await countQueries(() =>
      as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=200`));
    expect(one.queries).toBe(many.queries);
    expect(many.queries).toBeLessThanOrEqual(4);
    expect((many.result.body!.creators as unknown[]).length).toBeGreaterThan(50);
  });

  it("and it pages, rather than returning the network", async () => {
    const page = await as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=10&offset=0`);
    expect((page.body!.creators as unknown[]).length).toBe(10);
    expect(Number(page.body!.total)).toBeGreaterThan(100);
    const next = await as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=10&offset=10`);
    expect((next.body!.creators as Array<{ user_id: string }>)[0].user_id)
      .not.toBe((page.body!.creators as Array<{ user_id: string }>)[0].user_id);
    // A limit beyond the cap is clamped rather than obeyed.
    const huge = await as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=99999`);
    expect((huge.body!.creators as unknown[]).length).toBeLessThanOrEqual(200);
  });

  it("the whole dashboard answers quickly enough to be a dashboard", async () => {
    const t0 = Date.now();
    await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(5000);
  });

  it("and even at this size, nothing was written", async () => {
    const before = await fingerprint();
    await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    await as("creatorAdmin", "GET", `/creator/analytics/creators?${W}&limit=200`);
    await as("creatorAdmin", "GET", `/creator/analytics/export?${W}&dataset=creators`);
    expect(await fingerprint()).toEqual(before);
  });
});

/* ── §65–§69: everything else is where it was ────────────────────────────── */

maybe("Phases 0–6 and the rest of Nerve are untouched", () => {
  it("the leaderboard, recognition and payouts still answer as they did", async () => {
    expect((await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cycle}`)).status).toBe(200);
    expect((await as("c1", "GET", "/creator/points")).status).toBe(200);
    expect((await as("c1", "GET", "/creator/payouts")).status).toBe(200);
    expect((await as("c1", "GET", "/creator/achievements")).status).toBe(200);
    expect((await as("creatorAdmin", "GET", "/creator/competitions")).status).toBe(200);
    expect((await as("leadA", "GET", "/creator/payout-rules")).status).toBe(403);
  });

  it("Phase 7 added no table, no column and no index to the source systems", async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('mo_creator_profiles','mo_creator_teams','mo_creator_point_ledger',
                             'mo_creator_submissions','mo_creator_assignments')
          AND (column_name LIKE '%metric%' OR column_name LIKE '%analytic%'
            OR column_name LIKE '%_score%' OR column_name LIKE '%trend%')`);
    expect(rows).toEqual([]);
  });

  it("Media Ops is not the route to creator analytics", async () => {
    expect((await as("c1", "GET", "/state")).status).toBe(403);
    const state = await as("nerveAdmin", "GET", "/state");
    expect(state.status).toBe(200);
    for (const k of ["creator_analytics", "analytics_summary", "operationally_active"])
      expect(state.text, k).not.toContain(k);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./creator-analytics.ts", import.meta.url), "utf8");
    for (const t of ["mo_projects", "mo_assignments ", "mo_deliverable_versions"])
      expect(src, t).not.toContain(t);
  });

  it("analytics answers the management questions it was built for", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/analytics/summary?${W}`);
    const b = r.body!;
    for (const k of ["roster", "production", "trends", "funnel", "review", "teams",
                     "money", "recognition", "signals", "data_quality", "period", "freshness"])
      expect(Object.keys(b), k).toContain(k);
    const p = b.production as Record<string, number | null>;
    // Operationally active is its own number, distinct from being on the network.
    expect(p.operationally_active).toBeLessThanOrEqual((b.roster as Record<string, number>).on_network);
    expect((b.review as Record<string, number | null>).median_review_hours).not.toBeUndefined();
    expect((b.money as Record<string, string>).cost_per_approved_paid).not.toBeUndefined();
    expect((b.money as Record<string, string>).cost_per_approved_gross).not.toBeUndefined();
  });
});
