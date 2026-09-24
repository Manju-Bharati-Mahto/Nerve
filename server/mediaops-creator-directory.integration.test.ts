// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 1: directory, teams, hierarchy.

   Phase 0 proved the two hierarchies cannot inherit each other. Phase 1 adds
   the first records anyone can actually change, so what this file spends its
   time on is the other half of the problem: WHO may see WHOM, and who may
   change what.

   Every read goes through creatorScopeSql() and every write through
   requireCreatorManage(), so the tests push on those two seams from every
   angle a client could — forged ids, forged roles, forged team ids, a Team
   Lead reaching sideways, a creator reaching at all, and anybody at all trying
   to promote themselves.

   The real route handlers are mounted on a throwaway express app with the
   acting user chosen per request. Fixtures are synthetic (`zcd-`) and removed
   afterwards. Skips cleanly when no database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zcd";
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
  creator1:     { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  creator2:     { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  loose:        { id: `${PX}-loose`,  role: "user",  team: "creator", cr: "creator" },
  suspended:    { id: `${PX}-susp`,   role: "user",  team: "creator", cr: "creator" },
  archived:     { id: `${PX}-arch`,   role: "user",  team: "creator", cr: "creator" },
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
    // No header at all stands in for an anonymous caller.
    res.locals.currentUser = a ? { id: a.id, role: a.role, team: a.team } : { id: "", role: "user", team: null };
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
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
/* Only this file's fixtures. Sibling integration files seed creators of their
   own and run alongside this one, so an unfiltered list would be asserting
   about their churn rather than about scope. `.not.toContain` checks below are
   unaffected either way. */
const ids = (b: Record<string, unknown>) =>
  (b.creators as Array<{ user_id: string }>)
    .map((c) => c.user_id).filter((id) => id.startsWith(`${PX}-`)).sort();

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCD ${a.id}`, `${a.id}@cdir.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
        [a.id, a.role === "admin" ? "admin" : "employee"]);
    if (a.cr) {
      const st = a.id === A.suspended.id ? "suspended" : a.id === A.archived.id ? "archived" : "active";
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (user_id)
         DO UPDATE SET creator_role=EXCLUDED.creator_role, status=EXCLUDED.status`,
        [a.id, a.cr, st, A.nerveAdmin.id]);
    }
  }
  const mk = async (n: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} ${n}`, lead])).rows[0].id);
  teamA = await mk("Reels Team", A.leadA.id);
  teamB = await mk("Vlog Team", A.leadB.id);
  for (const [t, u] of [[teamA, A.creator1.id], [teamA, A.leadA.id],
                        [teamB, A.creator2.id], [teamB, A.leadB.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary, added_by)
                      VALUES ($1,$2,true,$3) ON CONFLICT DO NOTHING`, [t, u, A.nerveAdmin.id]);
}

async function cleanup() {
  /* Phase 6 recognition first: an achievement award is RESTRICT-protected on
     purpose — recognition outlives a suspension or an archive — so a fixture
     has to take its own down before its people and its cycles. */
  await pool.query(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1 OR user_id IN
                      (SELECT id FROM users WHERE email LIKE '%@cdir.invalid')`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1 OR user_id IN
                      (SELECT id FROM users WHERE email LIKE '%@cdir.invalid')`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1 OR email LIKE '%@cdir.invalid'`, [`${PX}-%`]);
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

/* ── The scoped shell payload ────────────────────────────────────────────── */

maybe("GET /creator/state", () => {
  it("gives a creator their own profile, their team and their lead — and no counts", async () => {
    const r = await as("creator1", "GET", "/creator/state");
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("self");
    expect((r.body.profile as Record<string, unknown>).user_id).toBe(A.creator1.id);
    expect((r.body.profile as Record<string, unknown>).team).toEqual({ id: teamA, name: `${PX} Reels Team` });
    expect(r.body.counts).toBeNull();            // headcount is not theirs to know
    expect((r.body.teams as unknown[])).toHaveLength(1);
  });

  it("gives a Team Lead their teams and counts narrowed to them", async () => {
    const r = await as("leadA", "GET", "/creator/state");
    expect(r.body.scope).toBe("team");
    expect((r.body.teams as Array<{ id: number }>).map((t) => t.id)).toEqual([teamA]);
    expect(r.body.can_manage_network).toBe(false);
  });

  it("gives a Creator Admin the whole network", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/state");
    expect(r.body.scope).toBe("all");
    expect(r.body.can_manage_network).toBe(true);
    expect(Number((r.body.counts as Record<string, number>).active)).toBeGreaterThan(0);
  });

  it("is not the Media Ops state — it carries no projects, deliverables or crew", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/state");
    for (const k of ["projects", "deliverables", "users", "shoots", "equipment_items", "daily_reports"])
      expect(Object.keys(r.body), `state leaked ${k}`).not.toContain(k);
  });

  it("TEST 1 — an anonymous caller is denied", async () => {
    expect((await as("anon", "GET", "/creator/state")).status).toBe(403);
  });

  it("TEST 2 — a Media employee without the module is denied", async () => {
    expect((await as("mediaEmp", "GET", "/creator/state")).status).toBe(403);
  });
});

/* ── Directory scope ─────────────────────────────────────────────────────── */

maybe("GET /creator/creators — who sees whom", () => {
  it("a Creator Admin sees the whole directory", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/creators?limit=200");
    expect(r.body.scope).toBe("all");
    expect(ids(r.body)).toEqual(expect.arrayContaining([A.creator1.id, A.creator2.id, A.suspended.id, A.archived.id]));
  });

  it("TEST 10/11 — a Nerve Admin sees it too, without being a creator_admin", async () => {
    const r = await as("nerveAdmin", "GET", "/creator/creators?limit=200");
    expect(r.status).toBe(200);
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });

  it("TEST 5 — a Team Lead sees their own team and not another's", async () => {
    const r = await as("leadA", "GET", "/creator/creators?limit=200");
    expect(r.body.scope).toBe("team");
    const got = ids(r.body);
    expect(got).toContain(A.creator1.id);
    expect(got).toContain(A.leadA.id);
    expect(got).not.toContain(A.creator2.id);   // team B
    expect(got).not.toContain(A.loose.id);      // no team
  });

  it("TEST 4 — a creator sees only themselves", async () => {
    const r = await as("creator1", "GET", "/creator/creators?limit=200");
    expect(ids(r.body)).toEqual([A.creator1.id]);
  });

  it("hides contact details from anyone but a network manager", async () => {
    const admin = await as("creatorAdmin", "GET", `/creator/creators?q=${PX}-c1`);
    const lead = await as("leadA", "GET", `/creator/creators?q=${PX}-c1`);
    expect((admin.body.creators as Array<{ email: string | null }>)[0].email).toBeTruthy();
    expect((lead.body.creators as Array<{ email: string | null }>)[0].email).toBeNull();
  });
});

/* ── Server-side filtering and paging ────────────────────────────────────── */

maybe("filtering happens in SQL, not the browser", () => {
  it("filters by status", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/creators?status=suspended&limit=200");
    expect(ids(r.body)).toEqual([A.suspended.id]);
  });

  it("filters by role and by team", async () => {
    const byRole = await as("creatorAdmin", "GET", "/creator/creators?role=team_lead&limit=200");
    expect(ids(byRole.body)).toEqual([A.leadA.id, A.leadB.id].sort());
    const byTeam = await as("creatorAdmin", "GET", `/creator/creators?team_id=${teamB}&limit=200`);
    expect(ids(byTeam.body)).toEqual([A.creator2.id, A.leadB.id].sort());
  });

  it("searches name and email", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/creators?q=${PX}-loose`);
    expect(ids(r.body)).toEqual([A.loose.id]);
  });

  it("paginates, and reports the full total", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/creators?limit=2&offset=0");
    expect((r.body.creators as unknown[]).length).toBeLessThanOrEqual(2);
    expect(Number(r.body.total)).toBeGreaterThan(2);
  });

  it("TEST 16 — a forged team_id narrows, it can never widen scope", async () => {
    // leadA asking for team B's id gets nothing: the scope clause is applied
    // first and this only adds to it.
    const r = await as("leadA", "GET", `/creator/creators?team_id=${teamB}&limit=200`);
    expect(r.body.creators).toEqual([]);
  });
});

/* ── Reading one creator ─────────────────────────────────────────────────── */

maybe("GET /creator/creators/:id", () => {
  it("TEST 4 — a creator can read their own record", async () => {
    const r = await as("creator1", "GET", `/creator/creators/${A.creator1.id}`);
    expect(r.status).toBe(200);
    expect((r.body.creator as Record<string, unknown>).email).toBeTruthy();   // own record, in full
  });

  it("TEST 15 — another creator's id reads as not found, not as forbidden", async () => {
    // Indistinguishable from a non-existent id: no probing who is on the network.
    expect((await as("creator1", "GET", `/creator/creators/${A.creator2.id}`)).status).toBe(404);
    expect((await as("creator1", "GET", "/creator/creators/no-such-person")).status).toBe(404);
  });

  it("TEST 18 — a Team Lead cannot read across to another team", async () => {
    expect((await as("leadA", "GET", `/creator/creators/${A.creator2.id}`)).status).toBe(404);
    expect((await as("leadA", "GET", `/creator/creators/${A.creator1.id}`)).status).toBe(200);
  });
});

/* ── Writes: who may change what ─────────────────────────────────────────── */

maybe("TEST 3/6/7/8 — management is not delegated below Creator Admin", () => {
  it("a creator cannot enrol anybody", async () => {
    const r = await as("creator1", "POST", "/creator/creators",
      { email: `${PX}-x@cdir.invalid`, full_name: "X", password: "Password1" });
    expect(r.status).toBe(403);
  });

  it("a creator cannot modify another creator", async () => {
    expect((await as("creator1", "PATCH", `/creator/creators/${A.creator2.id}`, { status: "archived" })).status).toBe(403);
  });

  it("TEST 7 — a creator cannot change their own role", async () => {
    const r = await as("creator1", "PATCH", `/creator/creators/${A.creator1.id}`, { creator_role: "creator_admin" });
    expect(r.status).toBe(403);
    const after = await pool.query(`SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [A.creator1.id]);
    expect(after.rows[0].creator_role).toBe("creator");
  });

  it("TEST 6 — a Team Lead cannot promote themselves", async () => {
    const r = await as("leadA", "PATCH", `/creator/creators/${A.leadA.id}`, { creator_role: "creator_admin" });
    expect(r.status).toBe(403);
    const after = await pool.query(`SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [A.leadA.id]);
    expect(after.rows[0].creator_role).toBe("team_lead");
  });

  it("a Team Lead cannot create or rename a team", async () => {
    expect((await as("leadA", "POST", "/creator/teams", { name: `${PX} Sneaky` })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/creator/teams/${teamA}`, { name: `${PX} Renamed` })).status).toBe(403);
  });

  it("not even a Creator Admin changes their OWN standing", async () => {
    // Nobody grades their own paper — the guard is on the row, not the role.
    const r = await as("creatorAdmin", "PATCH", `/creator/creators/${A.creatorAdmin.id}`, { creator_role: "creator" });
    expect(r.status).toBe(403);
  });

  it("TEST 9 — a Creator Admin can manage someone else", async () => {
    const r = await as("creatorAdmin", "PATCH", `/creator/creators/${A.loose.id}`, { creator_type: "Vlogger" });
    expect(r.status).toBe(200);
    const after = await pool.query(`SELECT creator_type FROM mo_creator_profiles WHERE user_id=$1`, [A.loose.id]);
    expect(after.rows[0].creator_type).toBe("Vlogger");
  });

  it("TEST 12/17 — a Creator Admin cannot touch Nerve roles, forged or otherwise", async () => {
    const before = (await pool.query(`SELECT role, team FROM users WHERE id=$1`, [A.loose.id])).rows[0];
    await as("creatorAdmin", "PATCH", `/creator/creators/${A.loose.id}`,
      { role: "admin", team: "media", mo_role: "admin", is_admin: true, creator_type: "Vlogger" });
    const after = (await pool.query(`SELECT role, team FROM users WHERE id=$1`, [A.loose.id])).rows[0];
    expect(after).toEqual(before);      // the endpoint writes no users column at all
  });
});

/* ── Status lifecycle ────────────────────────────────────────────────────── */

maybe("TEST 13/14 — status is the gate, and membership is not a way round it", () => {
  it("a suspended creator is refused the network", async () => {
    expect((await as("suspended", "GET", "/creator/state")).status).toBe(403);
  });

  it("a suspended creator cannot be added to a team", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/teams/${teamA}/members`, { user_id: A.suspended.id });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("not active");
  });

  it("archiving records the exit date and keeps the record", async () => {
    const r = await as("creatorAdmin", "PATCH", `/creator/creators/${A.loose.id}`, { status: "archived" });
    expect(r.status).toBe(200);
    const row = (await pool.query(
      `SELECT status, exited_on FROM mo_creator_profiles WHERE user_id=$1`, [A.loose.id])).rows[0];
    expect(row.status).toBe("archived");
    expect(row.exited_on).not.toBeNull();
  });

  it("an archived creator is not treated as active, and cannot get back in", async () => {
    expect(await api.creatorRoleOf({ id: A.loose.id, role: "user", team: "creator" })).toBeNull();
    expect((await as("archived", "GET", "/creator/state")).status).toBe(403);
  });

  it("restoring clears the exit date and the role works again", async () => {
    await as("creatorAdmin", "PATCH", `/creator/creators/${A.loose.id}`, { status: "active" });
    const row = (await pool.query(
      `SELECT status, exited_on FROM mo_creator_profiles WHERE user_id=$1`, [A.loose.id])).rows[0];
    expect(row.status).toBe("active");
    expect(row.exited_on).toBeNull();
    expect(await api.creatorRoleOf({ id: A.loose.id, role: "user", team: "creator" })).toBe("creator");
  });
});

/* ── Teams and the hierarchy ─────────────────────────────────────────────── */

maybe("creator teams", () => {
  let fresh = 0;

  it("a Creator Admin creates one, and names are unique", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/teams",
      { name: `${PX} Campus Creators`, description: "Campus content" });
    expect(r.status).toBe(201);
    fresh = Number(r.body.id);
    const dupe = await as("creatorAdmin", "POST", "/creator/teams", { name: `${PX} campus creators` });
    expect(dupe.status).toBe(409);
  });

  it("a Team Lead must already be on the network — never inferred from Nerve", async () => {
    const r = await as("creatorAdmin", "PATCH", `/creator/teams/${fresh}`, { lead_user_id: A.mediaEmp.id });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("enrol them first");
  });

  it("appointing an ordinary creator as lead promotes them, and says so in the trail", async () => {
    const r = await as("creatorAdmin", "PATCH", `/creator/teams/${fresh}`, { lead_user_id: A.creator1.id });
    expect(r.status).toBe(200);
    const role = (await pool.query(
      `SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [A.creator1.id])).rows[0].creator_role;
    expect(role).toBe("team_lead");
    const a = await pool.query(
      `SELECT action FROM mo_audit_logs WHERE actor_id=$1 AND action='creator.role_changed'`, [A.creatorAdmin.id]);
    expect(a.rows.length).toBeGreaterThan(0);
  });

  it("their scope follows immediately — no re-login", async () => {
    const r = await as("creator1", "GET", "/creator/state");
    expect(r.body.scope).toBe("team");
    expect((r.body.teams as Array<{ id: number }>).map((t) => t.id)).toEqual([fresh]);
  });

  it("moving a creator between teams keeps exactly one primary team", async () => {
    await as("creatorAdmin", "POST", `/creator/teams/${teamB}/members`, { user_id: A.creator2.id });
    await as("creatorAdmin", "POST", `/creator/teams/${teamA}/members`, { user_id: A.creator2.id });
    const rows = await pool.query(
      `SELECT team_id FROM mo_creator_team_members WHERE user_id=$1 AND is_primary`, [A.creator2.id]);
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0].team_id)).toBe(teamA);
  });

  it("removing a member reports honestly when they were never on it", async () => {
    expect((await as("creatorAdmin", "DELETE", `/creator/teams/${teamB}/members/${A.creator2.id}`)).status).toBe(404);
    expect((await as("creatorAdmin", "DELETE", `/creator/teams/${teamA}/members/${A.creator2.id}`)).status).toBe(200);
  });

  it("deactivating a team does not delete it or its membership", async () => {
    await as("creatorAdmin", "PATCH", `/creator/teams/${fresh}`, { is_active: false });
    const t = (await pool.query(`SELECT is_active, archived_at FROM mo_creator_teams WHERE id=$1`, [fresh])).rows[0];
    expect(t.is_active).toBe(false);
    expect(t.archived_at).toBeNull();
  });

  it("a creator sees only the team they are on", async () => {
    // Put them somewhere definite first: earlier tests in this file move
    // creator2 around, and this is about visibility, not about where they are.
    await as("creatorAdmin", "POST", `/creator/teams/${teamB}/members`, { user_id: A.creator2.id });
    const r = await as("creator2", "GET", "/creator/teams");
    expect((r.body.teams as Array<{ id: number }>).map((t) => t.id)).toEqual([teamB]);
  });

  it("TEST 18 — a Team Lead cannot open another team", async () => {
    expect((await as("leadB", "GET", `/creator/teams/${teamA}`)).status).toBe(404);
    expect((await as("leadB", "GET", `/creator/teams/${teamB}`)).status).toBe(200);
  });
});

/* ── Enrolment keeps one identity per person ─────────────────────────────── */

maybe("enrolling creators", () => {
  const email = `${PX}-new@cdir.invalid`;

  it("creates the Nerve account and the profile together", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/creators",
      { email, full_name: "ZCD New Creator", password: "Password1", creator_type: "Reels" });
    expect(r.status).toBe(201);
    const row = (await pool.query(
      `SELECT u.team, u.role, c.creator_role, c.status FROM users u
         JOIN mo_creator_profiles c ON c.user_id = u.id WHERE LOWER(u.email)=$1`, [email])).rows[0];
    expect(row).toEqual({ team: "creator", role: "user", creator_role: "creator", status: "active" });
  });

  it("refuses a second identity for the same email, and says which case it is", async () => {
    const dupe = await as("creatorAdmin", "POST", "/creator/creators",
      { email: email.toUpperCase(), full_name: "Dup", password: "Password1" });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe("CREATOR_EXISTS");
    const n = await pool.query(`SELECT COUNT(*)::int c FROM users WHERE LOWER(email)=$1`, [email]);
    expect(n.rows[0].c).toBe(1);
  });

  it("points at the existing account when the person is in Nerve but not on the network", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/creators",
      { email: `${A.mediaEmp.id}@cdir.invalid`, full_name: "ZCD Duplicate", password: "Password1" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("USER_EXISTS");
    expect((r.body.user as Record<string, unknown>).id).toBe(A.mediaEmp.id);
  });

  it("enrols an existing Nerve user without touching their Nerve role or team", async () => {
    const before = (await pool.query(`SELECT role, team FROM users WHERE id=$1`, [A.mediaEmp.id])).rows[0];
    const r = await as("creatorAdmin", "POST", "/creator/creators",
      { user_id: A.mediaEmp.id, creator_role: "creator_admin" });
    expect(r.status).toBe(201);
    const after = (await pool.query(`SELECT role, team FROM users WHERE id=$1`, [A.mediaEmp.id])).rows[0];
    expect(after).toEqual(before);
    // They are now a Creator Admin, and still exactly what they were in Nerve.
    expect(await api.creatorRoleOf({ id: A.mediaEmp.id, role: "user", team: "media" })).toBe("creator_admin");
    expect(api.moRoleOf({ id: A.mediaEmp.id, role: "user", team: "media" })).toBe("employee");
  });
});

/* ── Audit ───────────────────────────────────────────────────────────────── */

maybe("every change lands in the existing audit trail", () => {
  it("records the lifecycle events Phase 1 promises", async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT action FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
    const seen = rows.map((r) => r.action);
    for (const a of ["creator.created", "creator.role_changed", "creator.archived", "creator.restored",
                     "creator_team.created", "creator_team.lead_changed", "creator_team.status_changed",
                     "creator.team_moved"])
      expect(seen, `missing audit action ${a}`).toContain(a);
  });

  it("writes no password or token into the trail", async () => {
    const { rows } = await pool.query(
      `SELECT before::text b, after::text a FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
    for (const r of rows)
      for (const bad of ["password", "Password1", "token", "password_hash"])
        expect(`${r.b} ${r.a}`.toLowerCase(), `audit leaked ${bad}`).not.toContain(bad.toLowerCase());
  });
});

/* ── Media Ops is untouched ──────────────────────────────────────────────── */

maybe("regression — the rest of Nerve", () => {
  it("creators still cannot reach Media Ops routes", async () => {
    for (const p of ["/state", "/projects", "/dashboard"])
      expect((await as("creator1", "GET", p)).status, p).toBe(403);
  });

  it("Media Ops routes still answer for staff", async () => {
    for (const p of ["/state", "/lookups", "/dashboard"])
      expect((await as("nerveAdmin", "GET", p)).status, p).toBe(200);
  });

  it("no creator endpoint writes to a Media Ops table", async () => {
    /* These counts used to be taken over the WHOLE table. That measures every
       sibling suite as well as this one: a file that legitimately creates six
       Media Ops teams and then cleans them up made this assertion fail, and the
       failure said "a creator endpoint wrote to mo_teams" — which was never
       true. The question being asked is whether creating a CREATOR team leaves
       a trace in the Media Ops tables, so the counts are restricted to rows
       this suite could plausibly have caused. */
    const snap = async () => (await pool.query(
      `SELECT (SELECT count(*)::int FROM mo_projects WHERE name LIKE $1) p,
              (SELECT count(*)::int FROM mo_teams    WHERE name LIKE $1) t,
              (SELECT count(*)::int FROM mo_team_members
                WHERE team_id IN (SELECT id FROM mo_teams WHERE name LIKE $1)) m`,
      [`${PX}%`])).rows[0];
    const before = await snap();
    await as("creatorAdmin", "POST", "/creator/teams", { name: `${PX} Throwaway` });
    expect(await snap()).toEqual(before);
  });
});
