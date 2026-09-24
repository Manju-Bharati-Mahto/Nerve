// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 6: leaderboard, achievements, Creator
   of the Cycle, War Zone.

   PHASE 6 DOES NOT OWN PERFORMANCE ACCOUNTING. It consumes it.

   So the load-bearing assertion in this file is a negative one: a fingerprint
   of the point ledger, the financial ledger and the payouts is taken before
   and after every recognition operation and must be identical. Winning a War
   Zone must not change what anybody earned, what they rank, or what they are
   paid.

   The rest is about keeping four ideas apart:

     RANK           computed from points, by Phase 4, unchanged here
     ACHIEVEMENT    something earned, awarded once, revoked but never deleted
     CREATOR OF THE CYCLE   a recognition record, not rank #1 renamed
     COMPETITION    its own window, its own participants, its own score

   Real handlers, real database. Fixtures are `zrg-` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase, withGlobalLock, GLOBAL_LOCK } from "./test-db.js";

const PX = "zrg";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let teamA = 0, teamB = 0;

const A = {
  nerveAdmin:   { id: `${PX}-nadmin`, role: "admin", team: "media",   cr: null },
  mediaEmp:     { id: `${PX}-memp`,   role: "user",  team: "media",   cr: null },
  creatorAdmin: { id: `${PX}-cadmin`, role: "user",  team: "media",   cr: "creator_admin" },
  leadA:        { id: `${PX}-leadA`,  role: "user",  team: "creator", cr: "team_lead" },
  c1:           { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  c2:           { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  c3:           { id: `${PX}-c3`,     role: "user",  team: "creator", cr: "creator" },
  cB:           { id: `${PX}-cB`,     role: "user",  team: "creator", cr: "creator" },
} as const;
type ActorName = keyof typeof A;

/* The connection comes from server/test-db.ts, which resolves it from
   TEST_DATABASE_URL or .env.test and REFUSES any database whose name does not
   mark it as a test database. This file used to read .env.local itself and
   assign the DEVELOPMENT url over the top of vitest's — seventeen siblings did
   the same — which is how the suite came to run against `nerve`. */
{
  const t = await connectTestDatabase();
  pool = t.pool;
  dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZRG ${a.id}` }
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
}
async function as(actor: ActorName | "anon", method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await fetch(base + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

/* ── Fixtures ─────────────────────────────────────────────────────────────
   Cycles are created closed: recognition is finalised from a closed cycle,
   and making one active would take a globally exclusive slot other test
   files legitimately compete for. */
async function closedCycle(label: string, from: string, to: string) {
  return Number((await pool.query(
    `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
     VALUES ($1,$2,$3,'closed') RETURNING id`, [`${PX} ${label}`, from, to])).rows[0].id);
}
async function givePoints(userId: string, cycleId: number, points: number) {
  await pool.query(
    `INSERT INTO mo_creator_point_ledger (user_id, cycle_id, points, source_type, reason, created_by)
     VALUES ($1,$2,$3,'manual',$4,$5)`, [userId, cycleId, points, `${PX} seeded`, A.creatorAdmin.id]);
}
const achievement = async (code: string) => Number((await pool.query(
  `SELECT id FROM mo_creator_achievements WHERE code=$1`, [code])).rows[0].id);
const awardsOf = async (userId: string) => (await pool.query(
  `SELECT w.*, a.code FROM mo_creator_achievement_awards w
     JOIN mo_creator_achievements a ON a.id = w.achievement_id
    WHERE w.user_id=$1 ORDER BY w.id`, [userId])).rows;

/* The three systems Phase 6 must not touch, fingerprinted together. */
async function untouchable() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COALESCE(md5(string_agg(id||'|'||user_id||'|'||points||'|'||COALESCE(cycle_id::text,'~'),
          ',' ORDER BY id)), '-') FROM mo_creator_point_ledger WHERE user_id LIKE $1) AS points,
       (SELECT COALESCE(md5(string_agg(id||'|'||user_id||'|'||amount||'|'||entry_type, ',' ORDER BY id)), '-')
          FROM mo_creator_financial_ledger WHERE user_id LIKE $1) AS money,
       (SELECT COALESCE(md5(string_agg(id||'|'||user_id||'|'||gross_amount||'|'||status, ',' ORDER BY id)), '-')
          FROM mo_creator_payouts WHERE user_id LIKE $1) AS payouts`, [`${PX}-%`]);
  return rows[0] as { points: string; money: string; payouts: string };
}

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZRG ${a.id}`, `${a.id}@crec.invalid`, a.role, a.team]);
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
  teamA = await mk("Reels Team", A.leadA.id);
  teamB = await mk("Vlog Team", A.cB.id);
  for (const [t, u] of [[teamA, A.c1.id], [teamA, A.c2.id], [teamA, A.c3.id], [teamA, A.leadA.id],
                        [teamB, A.cB.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);
}

async function cleanup() {
  const like = [`${PX}-%`];
  await pool.query(`DELETE FROM mo_creator_competition_results WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_competition_scores WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_competition_participants WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_competitions WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_achievements WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_point_ledger WHERE user_id LIKE $1 OR created_by LIKE $1
                      OR cycle_id IN (SELECT id FROM mo_creator_cycles WHERE label LIKE $2)`,
    [`${PX}-%`, `${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
                      (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`, like);
  await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_creator_events WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_cycles WHERE label LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_point_rules WHERE name LIKE $1`, [`${PX} %`]);
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
  await cleanup(); await seed(); await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── §58: the required end-to-end ────────────────────────────────────────── */

maybe("cycle → leaderboard → recognition → War Zone → profile", () => {
  let sept = 0, compId = 0;
  let before: Awaited<ReturnType<typeof untouchable>>;

  it("the leaderboard is the Phase 4 rank engine, not a new formula", async () => {
    sept = await closedCycle("September 2026", "2026-09-01", "2026-09-30");
    await givePoints(A.c1.id, sept, 184);
    await givePoints(A.c2.id, sept, 120);
    await givePoints(A.c3.id, sept, 90);
    await givePoints(A.cB.id, sept, 40);
    before = await untouchable();

    const r = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${sept}`);
    expect(r.status).toBe(200);
    const rows = (r.body.rows as Array<{ user_id: string; points: number; place: number }>)
      .filter((x) => x.user_id.startsWith(`${PX}-`));
    expect(rows.map((x) => [x.points, x.place])).toEqual([[184, 1], [120, 2], [90, 3], [40, 4]]);
    expect(r.body.total).toBe(4);
  });

  it("a creator is told the rank they actually hold", async () => {
    const r = await as("c3", "GET", `/creator/leaderboard?cycle_id=${sept}`);
    expect(r.body.me).toEqual({ place: 3, points: 90 });
    // And they see the network board, as Phase 4 decided.
    expect((r.body.rows as unknown[]).length).toBe(4);
  });

  it("recognition is finalised from the closed cycle, and says who and why", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${sept}/finalize-recognition`, {});
    expect(r.status).toBe(200);
    expect(r.body.awarded).toBe(1);
    expect(r.body.shared).toBe(false);
    expect(r.body.winners).toEqual([{ user_id: A.c1.id, creator_name: expect.any(String),
      rank: 1, points: 184 }]);

    const w = (await pool.query(
      `SELECT * FROM mo_creator_cycle_awards WHERE cycle_id=$1`, [sept])).rows;
    expect(w).toHaveLength(1);
    expect(w[0].user_id).toBe(A.c1.id);
    // The justification is preserved, not recomputed later.
    expect(Number(w[0].rank_at_award)).toBe(1);
    expect(Number(w[0].points_at_award)).toBe(184);
    expect(String(w[0].criteria)).toContain("rank engine");
  });

  it("cycle achievements follow: Top 3 for three creators, the crown for one", async () => {
    const top3 = await achievement("top_three_cycle");
    const crown = await achievement("creator_of_cycle");
    const holders = (await pool.query(
      `SELECT user_id, achievement_id FROM mo_creator_achievement_awards
        WHERE cycle_id=$1 AND revoked_at IS NULL`, [sept])).rows;
    expect(holders.filter((h) => Number(h.achievement_id) === top3).map((h) => h.user_id).sort())
      .toEqual([A.c1.id, A.c2.id, A.c3.id].sort());
    expect(holders.filter((h) => Number(h.achievement_id) === crown).map((h) => h.user_id))
      .toEqual([A.c1.id]);
    // Fourth place earns neither.
    expect(holders.some((h) => h.user_id === A.cB.id)).toBe(false);
  });

  it("a War Zone is created, opened and entered", async () => {
    const made = await as("creatorAdmin", "POST", "/creator/competitions", {
      name: `${PX} Reel Battle`, description: "Best 30-second reel",
      rules: "One entry each. Judged on cut, sound and story.",
      recognition: "War Zone Winner badge",
      starts_at: "2026-10-01T09:00:00Z", ends_at: "2099-10-07T18:00:00Z" });
    expect(made.status).toBe(201);
    compId = Number(made.body.id);

    // A draft is nobody's business but the Admin's.
    expect((await as("c1", "GET", `/creator/competitions/${compId}`)).status).toBe(404);
    expect((await as("c1", "POST", `/creator/competitions/${compId}/participants`, {})).status).toBe(400);

    expect((await as("creatorAdmin", "POST", `/creator/competitions/${compId}/open`, {})).status).toBe(200);
    for (const who of ["c1", "c2", "c3"] as const)
      expect((await as(who, "POST", `/creator/competitions/${compId}/participants`, {})).status, who).toBe(201);
    const d = await as("c1", "GET", `/creator/competitions/${compId}`);
    expect((d.body.participants as unknown[]).length).toBe(3);
    expect(d.body.my_status).toBe("registered");
  });

  it("scores are the competition's own, and they are not Creator points", async () => {
    await as("creatorAdmin", "POST", `/creator/competitions/${compId}/start`, {});
    for (const [who, score] of [[A.c1.id, 70], [A.c2.id, 92], [A.c3.id, 55]] as const)
      expect((await as("creatorAdmin", "POST", `/creator/competitions/${compId}/scores`,
        { user_id: who, score, reason: "Judging round one" })).status).toBe(201);
    // A second entry adds to the score rather than replacing it.
    await as("creatorAdmin", "POST", `/creator/competitions/${compId}/scores`,
      { user_id: A.c1.id, score: 25, reason: "Judging round two" });

    const d = await as("creatorAdmin", "GET", `/creator/competitions/${compId}`);
    const parts = d.body.participants as Array<{ user_id: string; score: number }>;
    expect(parts.find((p) => p.user_id === A.c1.id)!.score).toBe(95);
    expect(parts.find((p) => p.user_id === A.c2.id)!.score).toBe(92);

    // The point ledger has not heard about any of it.
    const now = await untouchable();
    expect(now.points).toBe(before.points);
    expect(Number((await pool.query(
      `SELECT COALESCE(SUM(points),0)::int t FROM mo_creator_point_ledger WHERE user_id=$1`,
      [A.c1.id])).rows[0].t)).toBe(184);
  });

  it("completing finalises the results and awards the winner's badge", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/competitions/${compId}/complete`, {});
    expect(r.status).toBe(200);
    expect(r.body.results).toBe(3);
    expect(r.body.shared).toBe(false);
    expect((r.body.winners as Array<{ user_id: string }>)[0].user_id).toBe(A.c1.id);
    expect(Number(r.body.achievements_awarded)).toBe(1);

    const res = await as("c1", "GET", `/creator/competitions/${compId}/results`);
    expect((res.body.results as Array<{ place: number; score: number; result_type: string }>)
      .map((x) => [x.place, x.score, x.result_type]))
      .toEqual([[1, 95, "winner"], [2, 92, "runner_up"], [3, 55, "finalist"]]);
    const badge = await achievement("war_zone_winner");
    expect((await awardsOf(A.c1.id)).some((w) => Number(w.achievement_id) === badge)).toBe(true);
  });

  it("the creator's profile shows every kind of recognition, all derived", async () => {
    const r = await as("c1", "GET", "/creator/recognition");
    expect(r.status).toBe(200);
    const names = (r.body.achievements as Array<{ name: string }>).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["Top 3 in Cycle", "Creator of the Cycle", "War Zone Winner"]));
    expect((r.body.cycle_awards as Array<{ cycle: string; points: number }>)[0])
      .toMatchObject({ points: 184, rank: 1 });
    expect((r.body.competitions as Array<{ place: number; result_type: string }>)[0])
      .toMatchObject({ place: 1, result_type: "winner" });
    // The counts are the lengths of those lists — there is no stored counter.
    expect(r.body.counts).toMatchObject({
      achievements: (r.body.achievements as unknown[]).length,
      cycle_awards: 1, competitions: 1 });
  });

  it("§43, §44 — points, money and payouts are exactly as they were", async () => {
    const now = await untouchable();
    expect(now).toEqual(before);
  });
});

/* ── §20, §31: ties are stated, never resolved in silence ────────────────── */

maybe("a tie has two winners, and the system says so", () => {
  it("Creator of the Cycle is shared when the cycle is tied", async () => {
    const cycle = await closedCycle("Tied 2026", "2026-11-01", "2026-11-30");
    await givePoints(A.c2.id, cycle, 150);
    await givePoints(A.c3.id, cycle, 150);
    await givePoints(A.cB.id, cycle, 80);
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${cycle}/finalize-recognition`, {});
    expect(r.status).toBe(200);
    expect(r.body.awarded).toBe(2);
    expect(r.body.shared).toBe(true);
    expect((r.body.winners as Array<{ user_id: string }>).map((w) => w.user_id).sort())
      .toEqual([A.c2.id, A.c3.id].sort());
    // Both records carry rank 1 — nothing invented a runner-up.
    const w = (await pool.query(
      `SELECT rank_at_award FROM mo_creator_cycle_awards WHERE cycle_id=$1`, [cycle])).rows;
    expect(w.map((x) => Number(x.rank_at_award))).toEqual([1, 1]);
  });

  it("a tied competition has two winners, and the place after them is third", async () => {
    const made = await as("creatorAdmin", "POST", "/creator/competitions", {
      name: `${PX} Tied Battle`, starts_at: "2026-11-01T09:00:00Z", ends_at: "2099-11-07T18:00:00Z" });
    const id = Number(made.body.id);
    await as("creatorAdmin", "POST", `/creator/competitions/${id}/open`, {});
    for (const who of ["c1", "c2", "c3"] as const)
      await as(who, "POST", `/creator/competitions/${id}/participants`, {});
    await as("creatorAdmin", "POST", `/creator/competitions/${id}/start`, {});
    for (const [who, score] of [[A.c1.id, 92], [A.c2.id, 92], [A.c3.id, 41]] as const)
      await as("creatorAdmin", "POST", `/creator/competitions/${id}/scores`,
        { user_id: who, score, reason: "Judging" });

    const r = await as("creatorAdmin", "POST", `/creator/competitions/${id}/complete`, {});
    expect(r.body.shared).toBe(true);
    expect((r.body.winners as unknown[]).length).toBe(2);
    const res = (await as("creatorAdmin", "GET", `/creator/competitions/${id}/results`))
      .body.results as Array<{ place: number; result_type: string }>;
    // Competition ranking, the same as Phase 4: 1, 1, 3 — and no runner-up.
    expect(res.map((x) => [x.place, x.result_type]))
      .toEqual([[1, "winner"], [1, "winner"], [3, "finalist"]]);
    // Both winners get the badge.
    const badge = await achievement("war_zone_winner");
    for (const who of [A.c1.id, A.c2.id])
      expect((await awardsOf(who)).filter((w) => Number(w.achievement_id) === badge).length)
        .toBeGreaterThanOrEqual(1);
  });
});

/* ── §14, §15: evaluation is targeted, and awards once ───────────────────── */

maybe("an achievement is earned once", () => {
  it("approving a submission earns the first-content achievement, automatically", async () => {
    const tag = Math.random().toString(36).slice(2, 8);
    const ev = await as("creatorAdmin", "POST", "/creator/events",
      { title: `${PX} Event ${tag}`, event_date: "2026-12-01" });
    const op = await as("creatorAdmin", "POST", "/creator/opportunities",
      { event_id: Number(ev.body.id), title: "Reel Creator", required_count: 1 });
    const oppId = Number(op.body.id);
    await as("creatorAdmin", "PATCH", `/creator/events/${Number(ev.body.id)}`, { status: "open" });
    await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`, { status: "open" });
    const asg = await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.leadA.id });
    const aid = Number(asg.body.id);
    for (const to of ["accepted", "in_progress", "completed"])
      await as("leadA", "PATCH", `/creator/assignments/${aid}`, { status: to });
    const sub = await as("leadA", "POST", `/creator/assignments/${aid}/submissions`,
      { content_url: `https://drive.google.com/file/d/${PX}-${tag}/view` });
    const sid = Number((sub.body.submission as Record<string, unknown>).id);

    const r = await as("creatorAdmin", "POST", `/creator/submissions/${sid}/review`, { outcome: "approved" });
    expect(r.status).toBe(200);
    expect(Number(r.body.achievements)).toBeGreaterThanOrEqual(1);
    const first = await achievement("first_content");
    expect((await awardsOf(A.leadA.id)).some((w) => Number(w.achievement_id) === first)).toBe(true);
  });

  it("evaluating again awards nothing new", async () => {
    const first = await achievement("first_content");
    const count = async () => Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_achievement_awards
        WHERE user_id=$1 AND achievement_id=$2 AND revoked_at IS NULL`, [A.leadA.id, first])).rows[0].c);
    expect(await count()).toBe(1);
    // Ten at once, straight at the index.
    await Promise.all(Array.from({ length: 10 }, () => pool.query(
      `INSERT INTO mo_creator_achievement_awards (achievement_id, user_id, source_type, note)
       VALUES ($1,$2,'auto','race') ON CONFLICT DO NOTHING`, [first, A.leadA.id])));
    expect(await count()).toBe(1);
  });

  it("a point threshold is earned when the points are there, not before", async () => {
    const hundred = await achievement("hundred_points");
    const held = async (who: string) => (await awardsOf(who)).some(
      (w) => Number(w.achievement_id) === hundred && !w.revoked_at);
    // cB has 40 + 80 = 120 across cycles, so the lifetime threshold is met;
    // the award happens when something triggers an evaluation.
    expect(await held(A.cB.id)).toBe(false);
    const c = await closedCycle("Threshold 2027", "2027-01-01", "2027-01-31");
    await givePoints(A.cB.id, c, 1);
    await as("creatorAdmin", "POST", `/creator/cycles/${c}/finalize-recognition`, {});
    // Finalisation evaluates cycle achievements; lifetime ones come from the
    // creator's own activity, so the threshold is checked on their next read.
    const mine = await as("cB", "GET", "/creator/achievements");
    const row = (mine.body.achievements as Array<{ code: string; progress: { have: number } | null }>)
      .find((a) => a.code === "hundred_points")!;
    expect(row.progress === null || row.progress.have >= 100).toBe(true);
  });

  it("progress is shown for counted criteria and nothing else", async () => {
    const r = await as("c1", "GET", "/creator/achievements");
    const byCode = Object.fromEntries((r.body.achievements as Array<Record<string, unknown>>)
      .map((a) => [a.code, a]));
    // Earned achievements show no progress bar, and rank-shaped ones never do.
    expect((byCode.top_three_cycle as { earned: boolean }).earned).toBe(true);
    expect((byCode.top_three_cycle as { progress: unknown }).progress).toBeNull();
    const ten = byCode.ten_contents as { earned: boolean; progress: { have: number; need: number } | null };
    if (!ten.earned) expect(ten.progress).toMatchObject({ need: 10 });
  });
});

/* ── §11: recognition is history ─────────────────────────────────────────── */

maybe("recognition survives, and is revoked rather than deleted", () => {
  let awardId = 0;
  it("an award can be made by hand, once", async () => {
    const made = await as("creatorAdmin", "POST", "/creator/achievements",
      { name: `${PX} Special Mention`, description: "For something the rules do not cover",
        scope: "lifetime", criteria_type: "manual", icon: "🎖" });
    expect(made.status).toBe(201);
    const aid = Number(made.body.id);
    const w = await as("creatorAdmin", "POST", "/creator/achievement-awards",
      { user_id: A.c3.id, achievement_id: aid, note: "Outstanding help on short notice" });
    expect(w.status).toBe(201);
    awardId = Number(w.body.id);
    expect((await as("creatorAdmin", "POST", "/creator/achievement-awards",
      { user_id: A.c3.id, achievement_id: aid })).status).toBe(409);
  });

  it("an archived creator keeps every award", async () => {
    const before = (await awardsOf(A.c3.id)).length;
    expect(before).toBeGreaterThan(0);
    await pool.query(`UPDATE mo_creator_profiles SET status='archived' WHERE user_id=$1`, [A.c3.id]);
    expect((await awardsOf(A.c3.id)).length).toBe(before);
    const seen = await as("creatorAdmin", "GET", `/creator/achievement-awards?creator_id=${A.c3.id}`);
    expect((seen.body.awards as unknown[]).length).toBe(before);
    // Their Creator of the Cycle award is still there too.
    expect((await as("creatorAdmin", "GET", `/creator/cycle-awards?creator_id=${A.c3.id}`))
      .body.awards).toBeTruthy();
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.c3.id]);
  });

  it("revoking needs a reason, keeps the row, and happens once", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/achievement-awards/${awardId}/revoke`, {}))
      .status).toBe(400);
    const r = await as("creatorAdmin", "POST", `/creator/achievement-awards/${awardId}/revoke`,
      { reason: "Awarded to the wrong creator" });
    expect(r.status).toBe(200);
    const row = (await pool.query(
      `SELECT * FROM mo_creator_achievement_awards WHERE id=$1`, [awardId])).rows[0];
    expect(row).toBeTruthy();                       // still there
    expect(row.revoked_at).toBeTruthy();
    expect(row.revoke_reason).toContain("wrong creator");
    expect((await as("creatorAdmin", "POST", `/creator/achievement-awards/${awardId}/revoke`,
      { reason: "again" })).status).toBe(409);
  });

  it("a revoked award is out of the default list but still in the history", async () => {
    const live = await as("creatorAdmin", "GET", `/creator/achievement-awards?creator_id=${A.c3.id}`);
    expect((live.body.awards as Array<{ id: number }>).some((w) => w.id === awardId)).toBe(false);
    const all = await as("creatorAdmin", "GET",
      `/creator/achievement-awards?creator_id=${A.c3.id}&include_revoked=1`);
    expect((all.body.awards as Array<{ id: number }>).some((w) => w.id === awardId)).toBe(true);
  });

  it("there is no endpoint that deletes recognition", async () => {
    for (const [m, p] of [["DELETE", `/creator/achievement-awards/${awardId}`],
                          ["DELETE", "/creator/cycle-awards/1"],
                          ["DELETE", "/creator/achievements/1"],
                          ["PATCH", `/creator/achievement-awards/${awardId}`]] as const)
      expect([404, 405], `${m} ${p}`).toContain((await as("creatorAdmin", m, p, {})).status);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    for (const t of ["mo_creator_achievement_awards", "mo_creator_cycle_awards",
                     "mo_creator_competition_results"])
      expect(src, t).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+${t}`, "i"));
  });

  it("the bar cannot be moved under people who already cleared it", async () => {
    const top3 = await achievement("top_three_cycle");
    const r = await as("creatorAdmin", "PATCH", `/creator/achievements/${top3}`, { criteria_value: 10 });
    expect(r.status).toBe(409);
    expect(Number((await pool.query(
      `SELECT criteria_value FROM mo_creator_achievements WHERE id=$1`, [top3])).rows[0].criteria_value))
      .toBe(3);
    // Renaming and retiring stay possible.
    expect((await as("creatorAdmin", "PATCH", `/creator/achievements/${top3}`,
      { description: "Finished a cycle in the top three." })).status).toBe(200);
  });

  it("criteria are data, never code", async () => {
    for (const bad of [{ criteria_type: "eval" }, { criteria_type: "SELECT 1" },
                       { criteria_type: "point_threshold" }])
      expect((await as("creatorAdmin", "POST", "/creator/achievements",
        { name: `${PX} Bad ${JSON.stringify(bad)}`, scope: "lifetime", ...bad })).status).toBe(400);
  });
});

/* ── §42: concurrency ────────────────────────────────────────────────────── */

maybe("doing it ten times at once does it once", () => {
  let cycle = 0, compId = 0;
  beforeAll(async () => {
    if (!dbUp) return;
    cycle = await closedCycle("Race 2027", "2027-02-01", "2027-02-28");
    await givePoints(A.c1.id, cycle, 60);
    await givePoints(A.c2.id, cycle, 30);
  });

  it("B — ten simultaneous cycle finalisations produce ONE Creator of the Cycle", async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () =>
      as("creatorAdmin", "POST", `/creator/cycles/${cycle}/finalize-recognition`, {})));
    expect(all.every((r) => r.status === 200)).toBe(true);
    expect(all.reduce((a, r) => a + Number(r.body.awarded), 0)).toBe(1);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_cycle_awards WHERE cycle_id=$1`, [cycle])).rows[0].c)).toBe(1);
  });

  it("A — and one set of cycle achievements, not ten", async () => {
    const n = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_achievement_awards WHERE cycle_id=$1`, [cycle])).rows[0].c);
    // c1: Top 3 + Creator of the Cycle. c2: Top 3.
    expect(n).toBe(3);
    await expect(pool.query(
      `INSERT INTO mo_creator_cycle_awards (cycle_id, user_id, rank_at_award, points_at_award)
       VALUES ($1,$2,1,60)`, [cycle, A.c1.id])).rejects.toThrow();
  });

  it("D — ten simultaneous registrations produce ONE participant", async () => {
    const made = await as("creatorAdmin", "POST", "/creator/competitions", {
      name: `${PX} Race Battle`, starts_at: "2027-02-01T09:00:00Z", ends_at: "2099-02-07T18:00:00Z" });
    compId = Number(made.body.id);
    await as("creatorAdmin", "POST", `/creator/competitions/${compId}/open`, {});
    const all = await Promise.all(Array.from({ length: 10 }, () =>
      as("c1", "POST", `/creator/competitions/${compId}/participants`, {})));
    expect(all.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_competition_participants
        WHERE competition_id=$1 AND user_id=$2`, [compId, A.c1.id])).rows[0].c)).toBe(1);
    await expect(pool.query(
      `INSERT INTO mo_creator_competition_participants (competition_id, user_id)
       VALUES ($1,$2)`, [compId, A.c1.id])).rejects.toThrow();
  });

  it("C — ten simultaneous finalisations produce ONE result set", async () => {
    await as("c2", "POST", `/creator/competitions/${compId}/participants`, {});
    await as("creatorAdmin", "POST", `/creator/competitions/${compId}/start`, {});
    await as("creatorAdmin", "POST", `/creator/competitions/${compId}/scores`,
      { user_id: A.c1.id, score: 10, reason: "Judging" });
    const all = await Promise.all(Array.from({ length: 10 }, () =>
      as("creatorAdmin", "POST", `/creator/competitions/${compId}/complete`, {})));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409)).toHaveLength(9);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_competition_results WHERE competition_id=$1`,
      [compId])).rows[0].c)).toBe(2);
  });

  it("a finalised competition is finished", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${compId}/start`, {})).status).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${compId}/scores`,
      { user_id: A.c1.id, score: 5, reason: "too late" })).status).toBe(400);
    expect((await as("creatorAdmin", "PATCH", `/creator/competitions/${compId}`,
      { name: `${PX} Renamed` })).status).toBe(400);
    expect((await as("c3", "POST", `/creator/competitions/${compId}/participants`, {})).status).toBe(400);
  });
});

/* ── §41: the security matrix ────────────────────────────────────────────── */

maybe("the client is never trusted with recognition", () => {
  let compId = 0, openComp = 0, teamComp = 0, awardId = 0;
  beforeAll(async () => {
    if (!dbUp) return;
    compId = Number((await pool.query(
      `SELECT id FROM mo_creator_competitions WHERE name=$1`, [`${PX} Reel Battle`])).rows[0].id);
    const made = await as("creatorAdmin", "POST", "/creator/competitions", {
      name: `${PX} Open Battle`, starts_at: "2027-03-01T09:00:00Z", ends_at: "2099-03-07T18:00:00Z" });
    openComp = Number(made.body.id);
    await as("creatorAdmin", "POST", `/creator/competitions/${openComp}/open`, {});
    const team = await as("creatorAdmin", "POST", "/creator/competitions", {
      name: `${PX} Team Only Battle`, scope: "team", team_id: teamB,
      starts_at: "2027-03-01T09:00:00Z", ends_at: "2099-03-07T18:00:00Z" });
    teamComp = Number(team.body.id);
    await as("creatorAdmin", "POST", `/creator/competitions/${teamComp}/open`, {});
    awardId = Number((await pool.query(
      `SELECT id FROM mo_creator_achievement_awards WHERE user_id=$1 AND revoked_at IS NULL LIMIT 1`,
      [A.c1.id])).rows[0].id);
  });

  it("TESTS 1, 2 — anonymous and ordinary employees reach none of it", async () => {
    for (const p of ["/creator/leaderboard", "/creator/achievements", "/creator/achievement-awards",
                     "/creator/competitions", "/creator/cycle-awards", "/creator/recognition",
                     `/creator/competitions/${openComp}`]) {
      expect((await as("anon", "GET", p)).status, p).toBe(403);
      expect((await as("mediaEmp", "GET", p)).status, p).toBe(403);
    }
    for (const [m, p] of [["POST", "/creator/achievements"], ["POST", "/creator/competitions"],
                          ["POST", "/creator/achievement-awards"],
                          ["POST", `/creator/competitions/${openComp}/participants`]] as const)
      expect((await as("anon", m, p, { name: "x" })).status, p).toBe(403);
  });

  it("TESTS 3, 4, 5, 6, 7, 8 — a creator manages nothing", async () => {
    for (const [m, p, b] of [
      ["POST", "/creator/achievements", { name: `${PX} Rogue`, scope: "lifetime", criteria_type: "manual" }],
      ["PATCH", "/creator/achievements/1", { name: "mine" }],
      ["POST", "/creator/achievement-awards", { user_id: A.c1.id, achievement_id: 1 }],
      ["POST", `/creator/achievement-awards/${awardId}/revoke`, { reason: "not mine" }],
      ["POST", "/creator/competitions", { name: `${PX} Rogue Comp`,
        starts_at: "2027-01-01T00:00:00Z", ends_at: "2027-01-02T00:00:00Z" }],
      ["POST", `/creator/competitions/${compId}/complete`, {}],
      ["POST", `/creator/competitions/${openComp}/scores`, { user_id: A.c1.id, score: 999, reason: "me" }],
      ["POST", `/creator/competitions/${openComp}/open`, {}],
      ["POST", `/creator/competitions/${openComp}/cancel`, { reason: "no" }],
      ["PATCH", `/creator/competitions/${openComp}/participants/${A.c2.id}`, { status: "disqualified", note: "x" }],
    ] as const)
      expect((await as("c1", m, p, b)).status, `${m} ${p}`).toBe(403);
  });

  it("TESTS 9, 11 — a creator cannot enter anybody but themselves", async () => {
    const r = await as("c1", "POST", `/creator/competitions/${openComp}/participants`,
      { user_id: A.c2.id });
    expect(r.status).toBe(403);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_competition_participants
        WHERE competition_id=$1 AND user_id=$2`, [openComp, A.c2.id])).rows[0].c)).toBe(0);
    // Entering themselves works, and the forged id in the body is ignored.
    expect((await as("c1", "POST", `/creator/competitions/${openComp}/participants`, {})).status).toBe(201);
  });

  it("TESTS 10, 14, 29 — a team competition is invisible outside the team", async () => {
    // cB is in team B; c1 is not.
    expect((await as("c1", "GET", `/creator/competitions/${teamComp}`)).status).toBe(404);
    expect((await as("c1", "POST", `/creator/competitions/${teamComp}/participants`, {})).status).toBe(404);
    const list = await as("c1", "GET", "/creator/competitions?limit=100");
    expect((list.body.competitions as Array<{ id: number }>).some((k) => k.id === teamComp)).toBe(false);
    expect((await as("cB", "GET", `/creator/competitions/${teamComp}`)).status).toBe(200);
    expect((await as("cB", "POST", `/creator/competitions/${teamComp}/participants`, {})).status).toBe(201);
  });

  it("TEST 12 — nobody registers after a competition closes", async () => {
    const past = Number((await pool.query(
      `INSERT INTO mo_creator_competitions (name, starts_at, ends_at, status, created_by)
       VALUES ($1,'2020-01-01T00:00:00Z','2020-01-02T00:00:00Z','open',$2) RETURNING id`,
      [`${PX} Long Over`, A.creatorAdmin.id])).rows[0].id);
    const r = await as("c1", "POST", `/creator/competitions/${past}/participants`, {});
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("already ended");
  });

  it("TEST 13 — a suspended creator does not enter", async () => {
    await pool.query(`UPDATE mo_creator_profiles SET status='suspended' WHERE user_id=$1`, [A.c2.id]);
    // The gate refuses them before the competition is even consulted.
    expect((await as("c2", "POST", `/creator/competitions/${openComp}/participants`, {})).status).toBe(403);
    // And an Admin cannot enter them either.
    const r = await as("creatorAdmin", "POST", `/creator/competitions/${openComp}/participants`,
      { user_id: A.c2.id });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain("not active");
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.c2.id]);
  });

  it("TESTS 15, 16, 17 — a Team Lead manages nothing global", async () => {
    for (const [m, p, b] of [
      ["POST", "/creator/achievements", { name: `${PX} Lead`, scope: "lifetime", criteria_type: "manual" }],
      ["POST", "/creator/achievement-awards", { user_id: A.c1.id, achievement_id: 1 }],
      ["POST", `/creator/achievement-awards/${awardId}/revoke`, { reason: "my team" }],
      ["POST", `/creator/competitions/${compId}/complete`, {}],
      ["POST", "/creator/competitions", { name: `${PX} Lead Comp`,
        starts_at: "2027-01-01T00:00:00Z", ends_at: "2027-01-02T00:00:00Z" }],
      ["POST", `/creator/competitions/${openComp}/scores`, { user_id: A.c1.id, score: 50, reason: "x" }],
      ["POST", "/creator/points/adjust", { user_id: A.c1.id, points: 100, reason: "x" }],
    ] as const)
      expect((await as("leadA", m, p, b)).status, `${m} ${p}`).toBe(403);
    // Reading their own team's recognition is fine.
    expect((await as("leadA", "GET", "/creator/achievement-awards")).body.scope).toBe("team");
  });

  it("TESTS 18, 19 — a Creator Admin acts, a Nerve Admin follows Phase 0", async () => {
    expect((await as("creatorAdmin", "GET", "/creator/achievements")).body.can_manage).toBe(true);
    expect((await as("nerveAdmin", "GET", "/creator/competitions")).body.can_manage).toBe(true);
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });

  it("TESTS 20, 21, 22 — duplicates are impossible at the database", async () => {
    const first = await achievement("first_content");
    await expect(pool.query(
      `INSERT INTO mo_creator_achievement_awards (achievement_id, user_id, source_type)
       VALUES ($1,$2,'manual')`, [first, A.leadA.id])).rejects.toThrow();
    const sept = Number((await pool.query(
      `SELECT id FROM mo_creator_cycles WHERE label=$1`, [`${PX} September 2026`])).rows[0].id);
    await expect(pool.query(
      `INSERT INTO mo_creator_cycle_awards (cycle_id, user_id, rank_at_award, points_at_award)
       VALUES ($1,$2,1,184)`, [sept, A.c1.id])).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO mo_creator_competition_participants (competition_id, user_id)
       VALUES ($1,$2)`, [openComp, A.c1.id])).rejects.toThrow();
  });

  it("TEST 25 — a finalised result cannot be changed", async () => {
    for (const [m, p] of [["PATCH", `/creator/competitions/${compId}/results`],
                          ["POST", `/creator/competitions/${compId}/results`],
                          ["DELETE", `/creator/competitions/${compId}/results`]] as const)
      expect([404, 405], `${m} ${p}`).toContain((await as("creatorAdmin", m, p, { place: 1 })).status);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/UPDATE\s+mo_creator_competition_results/i);
  });

  it("TESTS 26, 27 — archiving a creator erases no recognition", async () => {
    const before = {
      ach: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_creator_achievement_awards WHERE user_id=$1`, [A.c1.id])).rows[0].c),
      cyc: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_creator_cycle_awards WHERE user_id=$1`, [A.c1.id])).rows[0].c),
      comp: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_creator_competition_results WHERE user_id=$1`, [A.c1.id])).rows[0].c),
    };
    expect(before.ach).toBeGreaterThan(0);
    expect(before.cyc).toBeGreaterThan(0);
    expect(before.comp).toBeGreaterThan(0);
    await pool.query(`UPDATE mo_creator_profiles SET status='archived' WHERE user_id=$1`, [A.c1.id]);
    const after = {
      ach: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_creator_achievement_awards WHERE user_id=$1`, [A.c1.id])).rows[0].c),
      cyc: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_creator_cycle_awards WHERE user_id=$1`, [A.c1.id])).rows[0].c),
      comp: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_creator_competition_results WHERE user_id=$1`, [A.c1.id])).rows[0].c),
    };
    expect(after).toEqual(before);
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.c1.id]);
  });

  it("TEST 28 — injection is stored as text", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/competitions/${openComp}/scores`,
      { user_id: A.c1.id, score: 1, reason: "'); DROP TABLE mo_creator_competition_scores;--" });
    expect(r.status).toBe(201);
    expect((await pool.query(`SELECT to_regclass('mo_creator_competition_scores')::text t`)).rows[0].t)
      .toBe("mo_creator_competition_scores");
    const s = await as("creatorAdmin", "GET", "/creator/leaderboard?q=%27%29%20OR%201%3D1--");
    expect(s.status).toBe(200);
    expect((s.body.rows as unknown[]).length).toBe(0);
  });

  it("a score must be a whole non-zero number with a reason", async () => {
    for (const bad of [{ user_id: A.c1.id, score: 0, reason: "nothing" },
                       { user_id: A.c1.id, score: 1.5, reason: "fraction" },
                       { user_id: A.c1.id, score: 10 },
                       { user_id: "nobody", score: 10, reason: "unknown creator" }])
      expect((await as("creatorAdmin", "POST", `/creator/competitions/${openComp}/scores`, bad)).status,
        JSON.stringify(bad)).toBe(400);
  });

  it("a competition cannot end before it starts, or skip its lifecycle", async () => {
    expect((await as("creatorAdmin", "POST", "/creator/competitions",
      { name: `${PX} Backwards`, starts_at: "2027-05-10T00:00:00Z", ends_at: "2027-05-01T00:00:00Z" }))
      .status).toBe(400);
    const made = await as("creatorAdmin", "POST", "/creator/competitions",
      { name: `${PX} Flow`, starts_at: "2027-06-01T00:00:00Z", ends_at: "2099-06-02T00:00:00Z" });
    const id = Number(made.body.id);
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${id}/start`, {})).status).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${id}/complete`, {})).status).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${id}/cancel`, {})).status).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${id}/cancel`,
      { reason: "Not going ahead" })).status).toBe(200);
    expect((await as("creatorAdmin", "POST", `/creator/competitions/${id}/open`, {})).status).toBe(400);
  });

  it("recognition is finalised only from a closed cycle", async () => {
    const draft = Number((await pool.query(
      `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
       VALUES ($1,'2027-04-01','2027-04-30','draft') RETURNING id`, [`${PX} Draft 2027`])).rows[0].id);
    await givePoints(A.c1.id, draft, 10);
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${draft}/finalize-recognition`, {});
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("closed cycle");
    expect((await as("creatorAdmin", "POST", "/creator/cycles/999999999/finalize-recognition", {}))
      .status).toBe(404);
  });
});

/* ── §43, §44, §61: everything Phase 6 must not have touched ─────────────── */

maybe("Phase 6 consumes; it does not account", () => {
  it("TESTS 30, 31, 32 — no Phase 6 code writes to points, money or payouts", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    const p6 = src.slice(src.indexOf("CREATOR NETWORK — Phase 6"), src.indexOf("  // ── helpers ──"));
    for (const t of ["mo_creator_point_ledger", "mo_creator_financial_ledger",
                     "mo_creator_payouts", "mo_creator_payout_rules"])
      for (const verb of ["INSERT INTO", "UPDATE", "DELETE FROM"])
        expect(p6, `Phase 6 must not ${verb} ${t}`).not.toMatch(new RegExp(`${verb}\\s+${t}`, "i"));
    // It reads the point ledger, which is exactly its job.
    expect(p6).toMatch(/FROM mo_creator_point_ledger/);
  });

  it("no counter was added to any creator record", async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('mo_creator_profiles','mo_creator_teams','users')
          AND (column_name LIKE '%point%' OR column_name LIKE '%rank%' OR column_name LIKE '%score%'
            OR column_name LIKE '%achievement%' OR column_name LIKE '%badge%')`);
    expect(rows).toEqual([]);
  });

  it("Media Ops and the earlier phases still answer as they did", async () => {
    expect((await as("c1", "GET", "/state")).status).toBe(403);
    expect((await as("nerveAdmin", "GET", "/state")).status).toBe(200);
    // Phase 4 and 5 endpoints still work for the people they always did.
    expect((await as("c1", "GET", "/creator/points")).status).toBe(200);
    expect((await as("c1", "GET", "/creator/payouts")).status).toBe(200);
    expect((await as("leadA", "GET", "/creator/payouts")).body.scope).toBe("self");
    expect((await as("leadA", "GET", "/creator/payout-rules")).status).toBe(403);
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    const p6 = src.slice(src.indexOf("CREATOR NETWORK — Phase 6"), src.indexOf("  // ── helpers ──"));
    for (const t of ["mo_projects", "mo_assignments", "mo_deliverable_versions"])
      expect(p6, `Phase 6 must not touch ${t}`).not.toContain(t);
  });

  it("the audit trail names every recognition action", async () => {
    const seen = (await pool.query(
      `SELECT DISTINCT action FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]))
      .rows.map((r) => r.action);
    for (const a of ["creator_achievement.created", "creator_achievement.updated",
                     "creator_achievement.awarded", "creator_achievement.revoked",
                     "creator_cycle_award.created",
                     "creator_competition.created", "creator_competition.opened",
                     "creator_competition.started", "creator_competition.completed",
                     "creator_competition.cancelled", "creator_competition.result_finalized",
                     "creator_competition.participant_added", "creator_competition.score_recorded"])
      expect(seen, `missing audit action ${a}`).toContain(a);
  });

  it("a cycle award records the rank and points that justified it", async () => {
    const row = (await pool.query(
      `SELECT after FROM mo_audit_logs WHERE action='creator_cycle_award.created' AND actor_id LIKE $1
        ORDER BY id LIMIT 1`, [`${PX}-%`])).rows[0];
    const after = typeof row.after === "string" ? JSON.parse(row.after) : row.after;
    expect(after).toMatchObject({ rank_at_award: 1, points_at_award: expect.any(Number) });
  });

  it("nothing secret reaches the trail", async () => {
    const blob = JSON.stringify((await pool.query(
      `SELECT before, after FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`])).rows).toLowerCase();
    for (const secret of ["password", "api_key", "token", "secret", "credential"])
      expect(blob, secret).not.toContain(secret);
  });

  it("creators are told about their recognition, and not about everybody else's", async () => {
    const mine = (await pool.query(
      `SELECT kind, title FROM mo_notifications WHERE user_id=$1 AND kind IN
        ('achievement','recognition','competition') ORDER BY id`, [A.c1.id])).rows;
    expect(mine.some((n) => n.kind === "achievement")).toBe(true);
    expect(mine.some((n) => String(n.title).includes("Creator of the Cycle"))).toBe(true);
    expect(mine.some((n) => n.kind === "competition")).toBe(true);
    /* A leaderboard read tells nobody anything.

       Held under the creator-automations lock. The count below is already
       scoped to this suite's own fixtures, but scoping is not enough here:
       runCreatorNetworkAutomations() walks every active creator in the
       database and notifies the ones it finds, so a pass running in another
       file legitimately adds rows to THESE users between the two reads. The
       lock is what makes "nothing happened in between" true. */
    await withGlobalLock(pool, GLOBAL_LOCK.creatorAutomations, async () => {
      /* DIAGNOSED, AND IT WAS NEVER THE CREATOR AUTOMATION PASS.

         This failed roughly one full-suite run in three across three phases as
         "expected 87 to be 86" — a number with no provenance. Printing the ROWS
         instead of the count named the writer on the next failure:

           kind=maintenance  entity_type=maintenance  user_id=zrg-nadmin
           title="Maintenance open — EQ-ZEQ-164"

         The EQUIPMENT suite opened maintenance on its own asset, and 17J's
         maintenanceRecipients() notifies every active media admin the scope
         allows — which for an unscoped asset is deliberately everybody,
         including the admin THIS file creates. Correct product behaviour, and
         entirely outside this test's subject, which is whether reading a
         leaderboard writes anything. That is why the creator automation lock
         never helped: the lock excludes creator passes, and no creator pass
         was ever involved.

         So the count is scoped to this suite's DOMAIN as well as its users.
         The row detail stays: if a third domain ever fans out to these admins,
         the failure will name that one too. docs/TEST_STABILITY.md entry 19. */
      const noteIds = async () => (await pool.query(
        `SELECT id, kind, entity_type, entity_id, user_id, title
           FROM mo_notifications WHERE user_id LIKE $1
            AND entity_type NOT IN ('equipment','maintenance','equipment_item')
          ORDER BY id`, [`${PX}-%`])).rows;
      const before = await noteIds();
      await as("creatorAdmin", "GET", "/creator/leaderboard");
      await as("c1", "GET", "/creator/achievements");
      const after = await noteIds();
      const seenBefore = new Set(before.map((r) => Number(r.id)));
      const added = after.filter((r) => !seenBefore.has(Number(r.id)));
      expect(added, `a read added notifications: ${JSON.stringify(added)}`).toEqual([]);
      /* And nothing was removed either, which the old count could not tell
         apart from nothing being added. */
      expect(after.length).toBe(before.length);
    });
  });

  it("the leaderboard pages and searches without changing anybody's rank", async () => {
    const sept = Number((await pool.query(
      `SELECT id FROM mo_creator_cycles WHERE label=$1`, [`${PX} September 2026`])).rows[0].id);
    const page1 = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${sept}&limit=2`);
    const page2 = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${sept}&limit=2&offset=2`);
    expect((page1.body.rows as Array<{ place: number }>).map((r) => r.place)).toEqual([1, 2]);
    expect((page2.body.rows as Array<{ place: number }>).map((r) => r.place)).toEqual([3, 4]);
    expect(page1.body.total).toBe(4);
    // Searching one creator still shows the place they actually hold.
    const found = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${sept}&q=${PX}-c3`);
    const rows = found.body.rows as Array<{ user_id: string; place: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: A.c3.id, place: 3 });
  });

  it("the board can be narrowed to a team without widening anyone's scope", async () => {
    const sept = Number((await pool.query(
      `SELECT id FROM mo_creator_cycles WHERE label=$1`, [`${PX} September 2026`])).rows[0].id);
    const r = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${sept}&team_id=${teamB}`);
    expect((r.body.rows as Array<{ user_id: string }>).map((x) => x.user_id)).toEqual([A.cB.id]);
    // A Team Lead asking for another team still gets their own.
    const lead = await as("leadA", "GET", `/creator/leaderboard?cycle_id=${sept}&team_id=${teamB}`);
    expect((lead.body.rows as Array<{ user_id: string }>).map((x) => x.user_id)).not.toContain(A.cB.id);
  });
});
