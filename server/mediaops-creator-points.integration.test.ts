// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 4: points, ledger, cycles, rank.

   THE POINT LEDGER IS THE SOURCE OF TRUTH. There is no stored total anywhere,
   so nothing below asserts against a counter — it asserts against SUM() over
   rows that each explain themselves, and against the invariants that keep
   those rows honest:

     IDEMPOTENT   one approved submission earns its rule exactly once, however
                  many times the request arrives. A unique index decides, not
                  an if-not-exists the next thread can interleave with.
     IMMUTABLE    a rule change cannot rewrite what was already earned, because
                  the amount is copied onto the row at award time. Corrections
                  are compensating rows; nothing is edited or deleted.
     DERIVED      rank is computed from the ledger on every read. Competition
                  ranking (1, 2, 2, 4), ordered deterministically.

   Real handlers, real database. Fixtures are `zcp-` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PX = "zcp";
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
  leadB:        { id: `${PX}-leadB`,  role: "user",  team: "creator", cr: "team_lead" },
  c1:           { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  c2:           { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  c3:           { id: `${PX}-c3`,     role: "user",  team: "creator", cr: "creator" },
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

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZCP ${a.id}` }
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

const ruleNamed = async (name: string) => Number((await pool.query(
  `SELECT id FROM mo_creator_point_rules WHERE name=$1`, [`${PX} ${name}`])).rows[0].id);

/** Everything from event to a submission awaiting a verdict, for one creator.
    The opportunity names its rule explicitly, which is how a real network is
    configured and what keeps these awards independent of whatever else may be
    active in the database while the suite runs. */
async function submissionReadyFor(who: ActorName, ruleId?: number) {
  const tag = Math.random().toString(36).slice(2, 8);
  const ev = await as("creatorAdmin", "POST", "/creator/events",
    { title: `${PX} Event ${tag}`, event_date: "2026-12-01" });
  const eventId = Number(ev.body.id);
  const op = await as("creatorAdmin", "POST", "/creator/opportunities",
    { event_id: eventId, title: "Reel Creator", required_count: 5 });
  const oppId = Number(op.body.id);
  if (ruleId) await pool.query(
    `UPDATE mo_creator_opportunities SET point_rule_id=$1 WHERE id=$2`, [ruleId, oppId]);
  await as("creatorAdmin", "PATCH", `/creator/events/${eventId}`, { status: "open" });
  await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`, { status: "open" });
  const asg = await as("creatorAdmin", "POST", "/creator/assignments",
    { opportunity_id: oppId, user_id: A[who].id });
  const assignmentId = Number(asg.body.id);
  for (const to of ["accepted", "in_progress", "completed"])
    await as(who, "PATCH", `/creator/assignments/${assignmentId}`, { status: to });
  const sub = await as(who, "POST", `/creator/assignments/${assignmentId}/submissions`,
    { content_url: `https://drive.google.com/file/d/${PX}-${tag}/view` });
  return { oppId, assignmentId, submissionId: Number((sub.body.submission as Record<string, unknown>).id) };
}
const approve = (submissionId: number) =>
  as("creatorAdmin", "POST", `/creator/submissions/${submissionId}/review`, { outcome: "approved" });

const balance = async (userId: string, cycleId?: number) => Number((await pool.query(
  `SELECT COALESCE(SUM(points),0)::int t FROM mo_creator_point_ledger
    WHERE user_id=$1 ${cycleId ? "AND cycle_id=$2" : ""}`,
  cycleId ? [userId, cycleId] : [userId])).rows[0].t);
const ledgerFor = async (submissionId: number) => (await pool.query(
  `SELECT * FROM mo_creator_point_ledger WHERE source_type='approved_submission' AND source_id=$1`,
  [submissionId])).rows;

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCP ${a.id}`, `${a.id}@cpts.invalid`, a.role, a.team]);
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
  teamB = await mk("Vlog Team", A.leadB.id);
  for (const [t, u] of [[teamA, A.c1.id], [teamA, A.c2.id], [teamA, A.c3.id], [teamA, A.leadA.id],
                        [teamB, A.cB.id], [teamB, A.leadB.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);

  /* Two rules that award nothing to anybody here.

     A sibling test file approving its own submissions must not be able to
     write into this file's ledger, and with these it cannot: given more than
     one active rule and no rule named on the opportunity, the award path
     refuses to guess (asserted in "an ambiguous rule awards nothing"). Every
     award in this file comes from an opportunity that names its rule, so the
     ledger under test stays ours alone. */
  for (const n of ["Guard One", "Guard Two"])
    await pool.query(
      `INSERT INTO mo_creator_point_rules (name, description, points)
       VALUES ($1,'isolation fixture',1) ON CONFLICT DO NOTHING`, [`${PX} ${n}`]);
}

async function cleanup() {
  /* Ledger first, and reversals before the rows they point at — every foreign
     key here is RESTRICT, which is the point: history cannot be half-deleted.
     Rows are matched by creator, by actor, and by rule or cycle, so nothing
     this file caused is left behind holding a rule or a cycle alive. */
  const mine = `(l.user_id LIKE $1 OR l.created_by LIKE $1
     OR l.rule_id IN (SELECT id FROM mo_creator_point_rules WHERE name LIKE $2)
     OR l.cycle_id IN (SELECT id FROM mo_creator_cycles WHERE label LIKE $2))`;
  const args = [`${PX}-%`, `${PX} %`];
  await pool.query(
    `DELETE FROM mo_creator_point_ledger l WHERE l.reversal_of_id IS NOT NULL AND ${mine}`, args);
  await pool.query(`DELETE FROM mo_creator_point_ledger l WHERE ${mine}`, args);
  await pool.query(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
                      (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`, [`${PX}-%`]);
  // Opportunities cascade from their event, which releases their point_rule_id.
  await pool.query(`DELETE FROM mo_creator_events WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_cycles WHERE label LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_point_rules WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
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

/* ── The journey the spec asks for, once, end to end ─────────────────────── */

maybe("rule → cycle → approval → ledger → rank", () => {
  let ruleId = 0, cycleId = 0;

  it("an admin writes down what a thing is worth", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/rules",
      { name: `${PX} Approved Reel`, points: 10, description: "A reel that passed review" });
    expect(r.status).toBe(201);
    ruleId = Number(r.body.id);
  });

  it("a cycle starts as a draft, and takes no points yet", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/cycles",
      { label: `${PX} September 2026`, starts_on: "2026-09-01", ends_on: "2026-09-30" });
    expect(r.status).toBe(201);
    cycleId = Number(r.body.id);
    expect((await pool.query(`SELECT status FROM mo_creator_cycles WHERE id=$1`, [cycleId])).rows[0].status)
      .toBe("draft");
  });

  it("activating it makes it the one cycle receiving points", async () => {
    expect((await as("creatorAdmin", "PATCH", `/creator/cycles/${cycleId}`, { status: "active" })).status).toBe(200);
    const second = await as("creatorAdmin", "POST", "/creator/cycles",
      { label: `${PX} October 2026`, starts_on: "2026-10-01", ends_on: "2026-10-31" });
    const clash = await as("creatorAdmin", "PATCH", `/creator/cycles/${Number(second.body.id)}`,
      { status: "active" });
    expect(clash.status).toBe(409);         // the database holds the invariant, not a check
  });

  it("approving a submission writes exactly one ledger row", async () => {
    const { submissionId } = await submissionReadyFor("c1", ruleId);
    const r = await approve(submissionId);
    expect(r.status).toBe(200);
    expect(r.body.points).toMatchObject({ awarded: 10, reason: "awarded", pending: false });

    const rows = await ledgerFor(submissionId);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(A.c1.id);            // resolved from the assignment
    expect(Number(rows[0].points)).toBe(10);
    expect(Number(rows[0].cycle_id)).toBe(cycleId);
    expect(Number(rows[0].rule_id)).toBe(ruleId);
  });

  it("the creator's balance is derived, and their dashboard agrees", async () => {
    expect(await balance(A.c1.id, cycleId)).toBe(10);
    const r = await as("c1", "GET", "/creator/points");
    expect(r.body.points).toBe(10);
    expect(r.body.lifetime).toBe(10);
    expect((r.body.cycle as Record<string, unknown>).id).toBe(cycleId);
    expect(r.body.approved_submissions).toBe(1);
    expect((r.body.recent as unknown[]).length).toBe(1);
  });

  it("the leaderboard places them, and recalculates as others earn", async () => {
    const first = await as("creatorAdmin", "GET", "/creator/leaderboard");
    expect((first.body.rows as Array<{ user_id: string; place: number }>)[0])
      .toMatchObject({ user_id: A.c1.id, place: 1 });

    const other = await submissionReadyFor("c2", ruleId);
    await approve(other.submissionId);
    await as("creatorAdmin", "POST", "/creator/points/adjust",
      { user_id: A.c2.id, points: 15, reason: "Outstanding coverage of the closing ceremony" });

    const after = await as("creatorAdmin", "GET", "/creator/leaderboard");
    const rows = after.body.rows as Array<{ user_id: string; points: number; place: number }>;
    expect(rows[0]).toMatchObject({ user_id: A.c2.id, points: 25, place: 1 });
    expect(rows[1]).toMatchObject({ user_id: A.c1.id, points: 10, place: 2 });
  });

  it("closing the cycle leaves a ranking that is still reproducible", async () => {
    expect((await as("creatorAdmin", "PATCH", `/creator/cycles/${cycleId}`, { status: "closed" })).status).toBe(200);
    const r = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cycleId}`);
    expect((r.body.cycle as Record<string, unknown>).status).toBe("closed");
    expect((r.body.rows as Array<{ user_id: string; points: number }>).map((x) => [x.user_id, x.points]))
      .toEqual([[A.c2.id, 25], [A.c1.id, 10]]);
  });

  it("with nothing active the points wait, rather than being lost or guessed", async () => {
    const { submissionId } = await submissionReadyFor("c3", ruleId);
    const r = await approve(submissionId);
    expect(r.status).toBe(200);                       // review is never blocked by accounting
    expect(r.body.points).toMatchObject({ awarded: 10, pending: true });
    const row = (await ledgerFor(submissionId))[0];
    expect(row.cycle_id).toBeNull();
    expect(Number(row.points)).toBe(10);
    expect(await balance(A.c3.id, cycleId)).toBe(0);  // the closed cycle did not move
  });

  it("an admin places the waiting points into a cycle, deliberately", async () => {
    const nxt = await as("creatorAdmin", "POST", "/creator/cycles",
      { label: `${PX} November 2026`, starts_on: "2026-11-01", ends_on: "2026-11-30" });
    const nid = Number(nxt.body.id);
    await as("creatorAdmin", "PATCH", `/creator/cycles/${nid}`, { status: "active" });
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${nid}/claim-pending`, {});
    expect(r.status).toBe(200);
    expect(Number(r.body.moved)).toBe(1);
    expect(await balance(A.c3.id, nid)).toBe(10);
    expect((await as("creatorAdmin", "GET", "/creator/cycles")).body.pending)
      .toMatchObject({ count: 0, points: 0 });
  });
});

/* ── Idempotency and concurrency ─────────────────────────────────────────── */

maybe("one approval earns once, however it arrives", () => {
  let ruleId = 0;
  beforeAll(async () => { if (dbUp) ruleId = await ruleNamed("Approved Reel"); });

  it("a repeated approval does not award twice", async () => {
    const { submissionId } = await submissionReadyFor("c1", ruleId);
    expect((await approve(submissionId)).status).toBe(200);
    expect((await approve(submissionId)).status).toBe(409);   // already decided
    expect(await ledgerFor(submissionId)).toHaveLength(1);
  });

  it("ten simultaneous approvals produce ONE point transaction", async () => {
    const { submissionId } = await submissionReadyFor("c2", ruleId);
    const all = await Promise.all(Array.from({ length: 10 }, () => approve(submissionId)));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409)).toHaveLength(9);
    expect(await ledgerFor(submissionId)).toHaveLength(1);
  });

  it("ten simultaneous awards of one submission produce ONE row — the index decides", async () => {
    /* Straight at the database, past every guard in the handler. This is the
       invariant the spec asks for: even if the application layer were wrong,
       the same submission cannot be paid for twice. */
    const { submissionId } = await submissionReadyFor("c3", ruleId);
    await approve(submissionId);
    const again = () => pool.query(
      `INSERT INTO mo_creator_point_ledger (user_id, cycle_id, rule_id, points, source_type, source_id)
       VALUES ($1, NULL, $2, 10, 'approved_submission', $3) ON CONFLICT DO NOTHING RETURNING id`,
      [A.c3.id, ruleId, submissionId]);
    const results = await Promise.all(Array.from({ length: 10 }, again));
    expect(results.every((r) => r.rowCount === 0)).toBe(true);
    expect(await ledgerFor(submissionId)).toHaveLength(1);
  });

  it("without ON CONFLICT the same award is rejected outright", async () => {
    const row = (await pool.query(
      `SELECT * FROM mo_creator_point_ledger WHERE user_id=$1 AND source_type='approved_submission' LIMIT 1`,
      [A.c1.id])).rows[0];
    await expect(pool.query(
      `INSERT INTO mo_creator_point_ledger (user_id, rule_id, points, source_type, source_id)
       VALUES ($1,$2,$3,'approved_submission',$4)`,
      [row.user_id, row.rule_id, row.points, row.source_id])).rejects.toThrow();
  });

  it("a submission that is not approved earns nothing", async () => {
    const { submissionId } = await submissionReadyFor("c1", ruleId);
    await as("creatorAdmin", "POST", `/creator/submissions/${submissionId}/review`,
      { outcome: "changes_requested", comment: "Please tighten the opening cut." });
    expect(await ledgerFor(submissionId)).toHaveLength(0);
  });

  it("an ambiguous rule awards nothing rather than guessing", async () => {
    const { submissionId } = await submissionReadyFor("c1");   // no rule named on the opportunity
    const r = await approve(submissionId);
    expect(r.status).toBe(200);
    expect(r.body.points).toMatchObject({ awarded: 0, reason: "rule_ambiguous" });
    expect(await ledgerFor(submissionId)).toHaveLength(0);
  });

  it("a retired rule does not pay", async () => {
    const made = await as("creatorAdmin", "POST", "/creator/rules", { name: `${PX} Retired`, points: 7 });
    const rid = Number(made.body.id);
    await as("creatorAdmin", "PATCH", `/creator/rules/${rid}`, { is_active: false });
    const { submissionId } = await submissionReadyFor("c2", rid);
    const r = await approve(submissionId);
    expect(Number((r.body.points as Record<string, unknown>).awarded)).toBe(0);
    expect(await ledgerFor(submissionId)).toHaveLength(0);
  });
});

/* ── Immutability ────────────────────────────────────────────────────────── */

maybe("history does not change", () => {
  let photoRule = 0, awarded = 0;

  it("changing a rule cannot rewrite what was already earned", async () => {
    const made = await as("creatorAdmin", "POST", "/creator/rules", { name: `${PX} Photo Set`, points: 5 });
    photoRule = Number(made.body.id);
    const { submissionId } = await submissionReadyFor("c1", photoRule);
    await approve(submissionId);
    awarded = Number((await ledgerFor(submissionId))[0].id);
    expect(Number((await ledgerFor(submissionId))[0].points)).toBe(5);

    expect((await as("creatorAdmin", "PATCH", `/creator/rules/${photoRule}`, { points: 15 })).status).toBe(200);
    expect(Number((await ledgerFor(submissionId))[0].points)).toBe(5);   // exactly as it was

    const next = await submissionReadyFor("c2", photoRule);
    await approve(next.submissionId);
    expect(Number((await ledgerFor(next.submissionId))[0].points)).toBe(15);   // new work, new value
  });

  it("a rule that has awarded points cannot be deleted out from under them", async () => {
    await expect(pool.query(`DELETE FROM mo_creator_point_rules WHERE id=$1`, [photoRule]))
      .rejects.toThrow();
  });

  it("there is no endpoint that edits or deletes a ledger row", async () => {
    for (const [m, p] of [["PATCH", `/creator/points/${awarded}`],
                          ["PUT", `/creator/points/${awarded}`],
                          ["DELETE", `/creator/points/${awarded}`],
                          ["PATCH", `/creator/points/ledger/${awarded}`]] as const)
      expect([404, 405], `${m} ${p}`).toContain((await as("creatorAdmin", m, p, { points: 9999 })).status);
    expect(Number((await pool.query(
      `SELECT points FROM mo_creator_point_ledger WHERE id=$1`, [awarded])).rows[0].points)).toBe(5);
  });

  it("a reversal is a new row; the original stays", async () => {
    const before = await balance(A.c1.id);
    const r = await as("creatorAdmin", "POST", `/creator/points/${awarded}/reverse`,
      { reason: "Awarded under the wrong rule" });
    expect(r.status).toBe(201);
    expect(Number((await pool.query(
      `SELECT points FROM mo_creator_point_ledger WHERE id=$1`, [awarded])).rows[0].points)).toBe(5);
    const rev = (await pool.query(
      `SELECT * FROM mo_creator_point_ledger WHERE id=$1`, [Number(r.body.id)])).rows[0];
    expect(Number(rev.points)).toBe(-5);
    expect(rev.source_type).toBe("reversal");
    expect(Number(rev.reversal_of_id)).toBe(awarded);
    expect(await balance(A.c1.id)).toBe(before - 5);
  });

  it("a transaction cannot be reversed twice", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/points/${awarded}/reverse`,
      { reason: "a second attempt" })).status).toBe(409);
  });

  it("and a reversal cannot itself be reversed", async () => {
    const rev = (await pool.query(
      `SELECT id FROM mo_creator_point_ledger WHERE reversal_of_id=$1`, [awarded])).rows[0];
    expect((await as("creatorAdmin", "POST", `/creator/points/${rev.id}/reverse`,
      { reason: "undoing the undo" })).status).toBe(400);
  });

  it("a reversal needs a reason", async () => {
    const { submissionId } = await submissionReadyFor("c3", photoRule);
    await approve(submissionId);
    const id = Number((await ledgerFor(submissionId))[0].id);
    expect((await as("creatorAdmin", "POST", `/creator/points/${id}/reverse`, {})).status).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/points/${id}/reverse`, { reason: "x" })).status).toBe(400);
  });
});

/* ── The rank engine ─────────────────────────────────────────────────────── */

maybe("rank is derived, and ties are decided", () => {
  let cid = 0;

  beforeAll(async () => {
    if (!dbUp) return;
    /* A cycle of its own, never made active, so nothing else running can add
       to it and the numbers below are exactly what was put there. */
    cid = Number((await pool.query(
      `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
       VALUES ($1,'2027-01-01','2027-01-31','draft') RETURNING id`, [`${PX} Rank Cycle`])).rows[0].id);
    for (const [who, pts] of [[A.c1.id, 50], [A.c2.id, 40], [A.c3.id, 40], [A.cB.id, 20]] as const)
      await pool.query(
        `INSERT INTO mo_creator_point_ledger (user_id, cycle_id, points, source_type, reason, created_by)
         VALUES ($1,$2,$3,'manual','rank fixture',$4)`, [who, cid, pts, A.creatorAdmin.id]);
  });

  it("orders by points and shares a place on a tie — 1, 2, 2, 4", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cid}`);
    expect((r.body.rows as Array<{ points: number; place: number }>).map((x) => [x.points, x.place]))
      .toEqual([[50, 1], [40, 2], [40, 2], [20, 4]]);
  });

  it("breaks display ties the same way every time", async () => {
    const read = async () => ((await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cid}`))
      .body.rows as Array<{ user_id: string }>).map((x) => x.user_id);
    const a = await read(), b = await read();
    expect(a).toEqual(b);
    expect(a.indexOf(A.c2.id)).toBeLessThan(a.indexOf(A.c3.id));   // equal points, then name
  });

  it("a negative adjustment moves someone down", async () => {
    expect((await as("creatorAdmin", "POST", "/creator/points/adjust",
      { user_id: A.c1.id, cycle_id: cid, points: -35, reason: "Duplicate award removed" })).status).toBe(201);
    const rows = (await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cid}`))
      .body.rows as Array<{ user_id: string; points: number; place: number }>;
    expect(rows[0].points).toBe(40);
    expect(rows.find((x) => x.user_id === A.c1.id)).toMatchObject({ points: 15, place: 4 });
  });

  it("a balance of zero is still a place on the board", async () => {
    await as("creatorAdmin", "POST", "/creator/points/adjust",
      { user_id: A.c1.id, cycle_id: cid, points: -15, reason: "Second duplicate removed" });
    const rows = (await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cid}`))
      .body.rows as Array<{ user_id: string; points: number }>;
    expect(rows.find((x) => x.user_id === A.c1.id)!.points).toBe(0);
  });

  it("a creator who did nothing is simply not on it", async () => {
    const rows = (await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cid}`))
      .body.rows as Array<{ user_id: string }>;
    expect(rows.map((x) => x.user_id)).not.toContain(A.leadA.id);
  });

  it("an archived creator keeps their points and their place in history", async () => {
    await pool.query(`UPDATE mo_creator_profiles SET status='archived' WHERE user_id=$1`, [A.cB.id]);
    const row = ((await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cid}`))
      .body.rows as Array<{ user_id: string; points: number; creator_status: string }>)
      .find((x) => x.user_id === A.cB.id);
    expect(row).toMatchObject({ points: 20, creator_status: "archived" });
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.cB.id]);
  });

  it("a Team Lead's board is their own team", async () => {
    const ids = ((await as("leadA", "GET", `/creator/leaderboard?cycle_id=${cid}`))
      .body.rows as Array<{ user_id: string }>).map((x) => x.user_id);
    expect(ids).toEqual(expect.arrayContaining([A.c2.id, A.c3.id]));
    expect(ids).not.toContain(A.cB.id);        // team B
  });

  it("with no cycle at all there is still a board, and it is empty", async () => {
    await pool.query(`UPDATE mo_creator_cycles SET status='closed' WHERE status='active'`);
    const r = await as("creatorAdmin", "GET", "/creator/leaderboard");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cycle: null, rows: [] });
  });
});

/* ── Security: the client is never trusted ───────────────────────────────── */

maybe("the client is never trusted", () => {
  it("TESTS 1, 2 — anonymous and non-network callers are refused everywhere", async () => {
    for (const p of ["/creator/points", "/creator/points/ledger", "/creator/leaderboard",
                     "/creator/rules", "/creator/cycles"]) {
      expect((await as("anon", "GET", p)).status, p).toBe(403);
      expect((await as("mediaEmp", "GET", p)).status, p).toBe(403);
    }
    for (const [m, p] of [["POST", "/creator/rules"], ["POST", "/creator/cycles"],
                          ["POST", "/creator/points/adjust"]] as const)
      expect((await as("anon", m, p, { name: "x", points: 1 })).status, p).toBe(403);
  });

  it("TESTS 4, 5, 6 — a creator cannot award, price or schedule anything", async () => {
    expect((await as("c1", "POST", "/creator/points/adjust",
      { user_id: A.c1.id, points: 1000, reason: "free points" })).status).toBe(403);
    expect((await as("c1", "POST", "/creator/rules", { name: `${PX} Rogue`, points: 999 })).status).toBe(403);
    expect((await as("c1", "POST", "/creator/cycles",
      { label: `${PX} Rogue`, starts_on: "2027-01-01", ends_on: "2027-01-31" })).status).toBe(403);
    expect((await as("c1", "POST", "/creator/points/1/reverse", { reason: "not mine to undo" })).status).toBe(403);
  });

  it("TESTS 11, 12, 13 — nor can a Team Lead, who may only look", async () => {
    expect((await as("leadA", "POST", "/creator/points/adjust",
      { user_id: A.c1.id, points: 50, reason: "a boost for my team" })).status).toBe(403);
    expect((await as("leadA", "POST", "/creator/rules", { name: `${PX} Lead`, points: 5 })).status).toBe(403);
    expect((await as("leadA", "PATCH", "/creator/cycles/1", { status: "closed" })).status).toBe(403);
    expect((await as("leadA", "GET", "/creator/leaderboard")).status).toBe(200);
  });

  it("TESTS 3, 14 — a creator's ledger is their own, a lead's is their team's", async () => {
    const own = await as("c1", "GET", "/creator/points/ledger?limit=200");
    const mine = own.body.entries as Array<{ user_id: string }>;
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.user_id === A.c1.id)).toBe(true);
    expect(own.body.scope).toBe("self");
    // A forged creator_id can only ever narrow. It never reaches anyone else.
    expect((await as("c1", "GET", `/creator/points/ledger?creator_id=${A.c2.id}&limit=200`)).body.entries)
      .toEqual([]);
    expect((await as("leadA", "GET", `/creator/points/ledger?creator_id=${A.cB.id}&limit=200`)).body.entries)
      .toEqual([]);
    const lead = await as("leadA", "GET", `/creator/points/ledger?creator_id=${A.c1.id}&limit=200`);
    expect((lead.body.entries as Array<{ user_id: string }>).every((e) => e.user_id === A.c1.id)).toBe(true);
  });

  it("TESTS 8, 9, 29 — a creator cannot choose who earns, how much, or in which cycle", async () => {
    const before = await balance(A.c1.id);
    for (const body of [{ user_id: A.c1.id, points: 500, reason: "for me" },
                        { user_id: A.c2.id, points: 500, cycle_id: 1, reason: "for them" }])
      expect((await as("c1", "POST", "/creator/points/adjust", body)).status).toBe(403);
    expect(await balance(A.c1.id)).toBe(before);
  });

  it("TESTS 10, 28 — an award's creator and amount come from the record, not the caller", async () => {
    const ruleId = await ruleNamed("Approved Reel");
    const { submissionId } = await submissionReadyFor("c3", ruleId);
    await as("creatorAdmin", "POST", `/creator/submissions/${submissionId}/review`,
      { outcome: "approved", user_id: A.c1.id, creator_id: A.c1.id, points: 9999, cycle_id: 1 });
    const row = (await ledgerFor(submissionId))[0];
    expect(row.user_id).toBe(A.c3.id);            // whoever the assignment belongs to
    expect(Number(row.points)).toBe(10);          // whatever the rule says
  });

  it("a manager names the rule a role earns, and cannot name one that is gone", async () => {
    const ruleId = await ruleNamed("Approved Reel");
    const ev = await as("creatorAdmin", "POST", "/creator/events",
      { title: `${PX} Event rule-api`, event_date: "2026-12-02" });
    const made = await as("creatorAdmin", "POST", "/creator/opportunities",
      { event_id: Number(ev.body.id), title: "Reel Creator", required_count: 1, point_rule_id: ruleId });
    expect(made.status).toBe(201);
    const oppId = Number(made.body.id);
    const rule = async () => (await pool.query(
      `SELECT point_rule_id FROM mo_creator_opportunities WHERE id=$1`, [oppId])).rows[0].point_rule_id;
    expect(Number(await rule())).toBe(ruleId);
    // A rule that does not exist, and one that has been retired, are both refused.
    expect((await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`,
      { point_rule_id: 999999999 })).status).toBe(400);
    expect((await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`,
      { point_rule_id: await ruleNamed("Retired") })).status).toBe(400);
    expect(Number(await rule())).toBe(ruleId);        // and neither changed it
    // Clearing it is a legitimate answer: the role then earns nothing.
    expect((await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`,
      { point_rule_id: null })).status).toBe(200);
    expect(await rule()).toBeNull();
    // A creator cannot price their own role.
    expect((await as("c1", "PATCH", `/creator/opportunities/${oppId}`,
      { point_rule_id: ruleId })).status).toBe(403);
  });

  it("TESTS 15, 16 — a Nerve Admin may manage the network and is still not a Creator Admin", async () => {
    expect((await as("creatorAdmin", "POST", "/creator/rules",
      { name: `${PX} Admin Rule`, points: 3 })).status).toBe(201);
    expect((await as("nerveAdmin", "GET", "/creator/rules")).status).toBe(200);
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });

  it("TEST 21 — a closed cycle is not restated", async () => {
    const closed = (await pool.query(
      `SELECT id FROM mo_creator_cycles WHERE status='closed' AND label LIKE $1 LIMIT 1`, [`${PX} %`])).rows[0];
    const r = await as("creatorAdmin", "POST", "/creator/points/adjust",
      { user_id: A.c1.id, cycle_id: Number(closed.id), points: 10, reason: "a late addition" });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("not restated");
    // Nor by moving its boundaries.
    expect((await as("creatorAdmin", "PATCH", `/creator/cycles/${closed.id}`,
      { starts_on: "2020-01-01" })).status).toBe(400);
  });

  it("TESTS 26, 27 — injection is stored as text, and an unknown id is refused", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/points/adjust",
      { user_id: A.c1.id, points: 1, reason: "'); DROP TABLE mo_creator_point_ledger;--" });
    expect(r.status).toBe(201);
    expect((await pool.query(`SELECT to_regclass('mo_creator_point_ledger')::text t`)).rows[0].t)
      .toBe("mo_creator_point_ledger");
    expect((await as("creatorAdmin", "POST", "/creator/points/adjust",
      { user_id: "no-such-creator", points: 5, reason: "nobody by that name" })).status).toBe(400);
    expect((await as("creatorAdmin", "POST", "/creator/points/999999999/reverse",
      { reason: "nothing there" })).status).toBe(404);
  });

  it("a manual entry needs a reason and a whole, non-zero amount", async () => {
    for (const body of [{ user_id: A.c1.id, points: 5 },
                        { user_id: A.c1.id, points: 5, reason: "x" },
                        { user_id: A.c1.id, points: 0, reason: "nothing at all" },
                        { user_id: A.c1.id, points: 1.5, reason: "a fraction of a point" },
                        { user_id: A.c1.id, points: 10_000_000, reason: "an absurd amount" }])
      expect((await as("creatorAdmin", "POST", "/creator/points/adjust", body)).status,
        JSON.stringify(body)).toBe(400);
  });

  it("a cycle cannot end before it starts, or skip its lifecycle", async () => {
    expect((await as("creatorAdmin", "POST", "/creator/cycles",
      { label: `${PX} Backwards`, starts_on: "2027-03-31", ends_on: "2027-03-01" })).status).toBe(400);
    const made = await as("creatorAdmin", "POST", "/creator/cycles",
      { label: `${PX} Flow`, starts_on: "2027-04-01", ends_on: "2027-04-30" });
    const id = Number(made.body.id);
    expect((await as("creatorAdmin", "PATCH", `/creator/cycles/${id}`, { status: "closed" })).status).toBe(400);
    expect((await as("creatorAdmin", "PATCH", `/creator/cycles/${id}`, { status: "archived" })).status).toBe(200);
    expect((await as("creatorAdmin", "PATCH", `/creator/cycles/${id}`, { status: "active" })).status).toBe(400);
  });

  it("a rule needs a name and a whole, non-zero value, and names stay unique", async () => {
    for (const body of [{ name: "z", points: 5 }, { name: `${PX} Bad`, points: 0 },
                        { name: `${PX} Bad`, points: 2.5 }, { name: `${PX} Bad` }])
      expect((await as("creatorAdmin", "POST", "/creator/rules", body)).status).toBe(400);
    expect((await as("creatorAdmin", "POST", "/creator/rules",
      { name: `${PX} Approved Reel`, points: 1 })).status).toBe(409);
  });
});

/* ── The trail, and everything that must not have moved ──────────────────── */

maybe("the trail, and the rest of Nerve", () => {
  it("every Phase 4 action is on the record", async () => {
    const seen = (await pool.query(
      `SELECT DISTINCT action FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]))
      .rows.map((r) => r.action);
    for (const a of ["creator_point_rule.created", "creator_point_rule.updated",
                     "creator_point_rule.deactivated",
                     "creator_cycle.created", "creator_cycle.active", "creator_cycle.closed",
                     "creator_points.awarded", "creator_points.adjusted", "creator_points.reversed",
                     "creator_points.cycle_assigned"])
      expect(seen, `missing audit action ${a}`).toContain(a);
  });

  it("an award says who earned it, under which rule, and for what", async () => {
    const row = (await pool.query(
      `SELECT after, actor_role FROM mo_audit_logs
        WHERE action='creator_points.awarded' AND actor_id LIKE $1
        ORDER BY id DESC LIMIT 1`, [`${PX}-%`])).rows[0];
    expect(row.actor_role).toBeTruthy();      // the creator audit vocabulary holds
    const after = typeof row.after === "string" ? JSON.parse(row.after) : row.after;
    expect(after).toMatchObject({ rule: expect.any(String), points: expect.any(Number) });
    expect(String(after.user_id)).toMatch(new RegExp(`^${PX}-`));
  });

  it("nothing secret is written to the trail or the ledger", async () => {
    const blob = (JSON.stringify((await pool.query(
      `SELECT before, after FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`])).rows)
      + JSON.stringify((await pool.query(
        `SELECT reason FROM mo_creator_point_ledger WHERE user_id LIKE $1`, [`${PX}-%`])).rows)).toLowerCase();
    for (const secret of ["password", "session", "api_key", "token", "secret"])
      expect(blob, secret).not.toContain(secret);
  });

  it("every point a creator holds is explainable row by row", async () => {
    /* A manager must be able to answer "why does this creator have N?" — and
       the answer is the rows themselves, because their sum IS the balance. */
    const rows = (await pool.query(
      `SELECT points, reason FROM mo_creator_point_ledger WHERE user_id=$1`, [A.c1.id])).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.reduce((a, r) => a + Number(r.points), 0)).toBe(await balance(A.c1.id));
    expect(rows.every((r) => String(r.reason).trim().length > 0)).toBe(true);
  });

  it("no stored total exists anywhere to drift out of step", async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('mo_creator_profiles','mo_creator_teams','mo_creator_cycles','users')
          AND (column_name LIKE '%point%' OR column_name LIKE '%rank%' OR column_name LIKE '%score%')`);
    expect(rows).toEqual([]);
  });

  it("the ledger is append-only in the code, not only by convention", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/DELETE\s+FROM\s+mo_creator_point_ledger/i);
    // The one UPDATE is claim-pending, placing a waiting row into a cycle.
    const updates = src.match(/UPDATE mo_creator_point_ledger[^`]*/g) ?? [];
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("SET cycle_id=$1 WHERE cycle_id IS NULL");
  });

  it("Media Ops is exactly where it was", async () => {
    expect((await as("c1", "GET", "/state")).status).toBe(403);
    expect((await as("nerveAdmin", "GET", "/state")).status).toBe(200);
    expect((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_projects WHERE name LIKE $1`, [`${PX}%`])).rows[0].c).toBe(0);
    expect((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_assignment_users WHERE user_id LIKE $1`, [`${PX}-%`])).rows[0].c).toBe(0);
    const src = (await import("node:fs")).readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    const phase4 = src.slice(src.indexOf("CREATOR NETWORK — Phase 4"));
    for (const t of ["mo_projects", "mo_assignments", "mo_deliverable_versions"])
      expect(phase4.slice(0, phase4.indexOf("// ── helpers")),
        `Phase 4 must not touch ${t}`).not.toContain(t);
  });
});
