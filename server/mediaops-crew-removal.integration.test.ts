// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — who deletes, who takes people off, and what they carry.

     · only an Admin deletes a project; a lead cancels or archives it;
     · whoever runs a project (Admin, its lead, its owner/PM) chooses its crew,
       edits its shoots and takes people off them — deleting a shoot stays
       with the project's lead or an Admin;
     · the project's owner and PM are never taken off this way;
     · taking someone off never strands work: every live deliverable they own
       or are on the team of blocks it (409) until it is handed on, they come
       off its team, or it is closed. Delivered work and their versions are
       never touched;
     · removing an account hands its deliverables on the same way every other
       owner change does, and the new owner is told who it came from.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zcr-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zcr";
const { pool, dbUp } = await connectTestDatabase();
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZCR Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZCR Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZCR Lead A" },
  leadB: { id: `${PX}-leadB`, role: "sub_admin", team: "media", full_name: "ZCR Lead B" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZCR Emp A1" },
  empA2: { id: `${PX}-empA2`, role: "user", team: "media", full_name: "ZCR Emp A2" },
  empA3: { id: `${PX}-empA3`, role: "user", team: "media", full_name: "ZCR Emp A3" },
  gone: { id: `${PX}-gone`, role: "user", team: "media", full_name: "ZCR Leaving" },
  outsider: { id: `${PX}-outsider`, role: "user", team: "branding", full_name: "ZCR Outsider" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, teamB = 0, projectTypeId = 0, dtype = 0, workTypeId = 0;
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const { registerMediaOpsApi } = await import("./mediaops-api.js");
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.currentUser = ACTORS[(req.headers["x-actor"] as ActorName) || "admin"];
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  registerMediaOpsApi(app as never, {
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

async function as(actor: ActorName, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "x-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

const one = (sql: string, params: unknown[] = []) => pool.query(sql, params).then((r) => r.rows[0]);
const deliv = (id: number) => one(`SELECT * FROM mo_deliverables WHERE id=$1`, [id]);
const onCrew = async (pid: number, who: ActorName) => !!(await one(
  `SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`, [pid, ACTORS[who].id]));
const noteBodies = (who: ActorName, entityType: string, entityId: number) => pool.query(
  `SELECT title, body FROM mo_notifications WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY id`,
  [ACTORS[who].id, entityType, entityId]).then((r) => r.rows as Array<{ title: string; body: string }>);
const teamOf = (did: number) => pool.query(
  `SELECT au.user_id FROM mo_assignments a JOIN mo_assignment_users au ON au.assignment_id=a.id
    WHERE a.deliverable_id=$1 AND a.status <> 'cancelled' ORDER BY au.user_id`, [did])
  .then((r) => r.rows.map((x) => String(x.user_id)));
const remove = (actor: ActorName, pid: number, who: ActorName, resolutions?: unknown[]) =>
  as(actor, "DELETE", `/projects/${pid}/assignments/${ACTORS[who].id}`, resolutions ? { resolutions } : undefined);

/** A project routed to Team A by the Coordinator — Lead A owns it and is its PM. */
async function routed(team = teamA) {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Annual Cultural Festival ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "high", description: "Student Affairs",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: team, deliverables: [],
  });
  return Number((r.body.project as Record<string, unknown>).id);
}

/** Assign work with a new deliverable: `owner` owns it, everyone in `team` works on it. */
async function work(pid: number, owner: ActorName, team: ActorName[] = [owner]) {
  const w = await as("leadA", "POST", `/projects/${pid}/work`, {
    work_type_id: workTypeId, title: `${PX} cut ${Math.random().toString(36).slice(2, 6)}`,
    assignees: team.map((t) => ACTORS[t].id), owner_id: ACTORS[owner].id,
    new_deliverable: { deliverable_type_id: dtype } });
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  return Number((w.body.deliverable as Record<string, unknown>).id);
}

/** Make `who` the project's PM in place of its lead (the single-PM index allows one). */
async function makePM(pid: number, who: ActorName) {
  await pool.query(
    `INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
     VALUES ($1,$2,false,$3) ON CONFLICT (project_id, user_id) WHERE removed_at IS NULL DO NOTHING`,
    [pid, ACTORS[who].id, ACTORS.admin.id]);
  await pool.query(`UPDATE mo_project_assignments SET is_project_manager=(user_id=$2)
                     WHERE project_id=$1 AND removed_at IS NULL`, [pid, ACTORS[who].id]);
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, a.full_name, `${a.id}@crew-removal.invalid`, a.role, a.team]);
    if (a.team !== "media") continue;
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
       ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
      [a.id, name === "admin" ? "admin" : name === "coord" ? "coordinator"
        : name.startsWith("lead") ? "team_lead" : "employee"]);
  }
  const mkTeam = async (name: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
    [`${PX} ${name}`, lead])).rows[0].id);
  teamA = await mkTeam("Event Team", ACTORS.leadA.id);
  teamB = await mkTeam("Video Team", ACTORS.leadB.id);
  for (const u of [ACTORS.empA1.id, ACTORS.empA2.id, ACTORS.empA3.id, ACTORS.gone.id])
    await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                      ON CONFLICT DO NOTHING`, [teamA, u]);
  projectTypeId = Number((await one(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).id);
  dtype = Number((await one(
    `SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL AND NOT review_exempt ORDER BY id LIMIT 1`)).id);
  workTypeId = Number((await one(
    `SELECT id FROM mo_work_types WHERE is_active AND archived_at IS NULL AND form_template='standard_task' ORDER BY id LIMIT 1`)).id);
}

async function cleanup() {
  const pj = `(SELECT id FROM mo_projects WHERE name LIKE '${PX}%')`;
  await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id IN (SELECT id FROM mo_assignments WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_assignments WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_shoot_crew WHERE shoot_id IN (SELECT id FROM mo_shoots WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_shoots WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_deliverable_versions WHERE deliverable_id IN (SELECT id FROM mo_deliverables WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_drive_links WHERE entity_type='deliverable'
                      AND entity_id IN (SELECT id FROM mo_deliverables WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_deliverables WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_projects WHERE name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_team_members WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_teams WHERE name LIKE '${PX} %'`);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM users WHERE id LIKE '${PX}-%'`);
}

beforeAll(async () => {
  if (!dbUp) return;
  await cleanup();
  await seed();
  await boot();
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── Q1: who deletes, who runs the crew and the shoots ────────────────────── */

maybe("deleting a project is an Admin's; running its crew and shoots is whoever runs it", () => {
  it("the project's own lead may not delete it; an Admin may", async () => {
    const pid = await routed();
    const r = await as("leadA", "DELETE", `/projects/${pid}`);
    expect([r.status, r.body.message]).toEqual([403, "Only an Admin may delete a project."]);
    expect((await one(`SELECT deleted_at FROM mo_projects WHERE id=$1`, [pid])).deleted_at).toBeNull();
    expect((await as("admin", "DELETE", `/projects/${pid}`)).status).toBe(200);
    expect((await one(`SELECT deleted_at FROM mo_projects WHERE id=$1`, [pid])).deleted_at).not.toBeNull();
  });

  it("a PM takes a crew member off; the owner and the PM themselves cannot be taken off", async () => {
    const pid = await routed();
    await makePM(pid, "empA2");
    expect((await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA1.id })).status).toBe(201);
    expect((await remove("empA2", pid, "empA1")).status).toBe(200);
    expect(await onCrew(pid, "empA1")).toBe(false);
    expect((await noteBodies("empA1", "project", pid)).map((n) => n.title)).toContain("Taken off a project");
    const owner = await remove("empA2", pid, "leadA");
    expect(owner.status).toBe(400);
    expect(String(owner.body.message)).toContain("owns this project");
    const pm = await remove("admin", pid, "empA2");
    expect(pm.status).toBe(400);
    expect(String(pm.body.message)).toContain("PM");
    expect(await onCrew(pid, "empA2")).toBe(true);
  });

  it("the Coordinator, another team's lead and a plain crew member cannot take anyone off", async () => {
    const pid = await routed();
    for (const who of ["empA1", "empA3"] as const)
      await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS[who].id });
    for (const actor of ["coord", "leadB", "empA3"] as const)
      expect((await remove(actor, pid, "empA1")).status, actor).toBe(403);
    expect(await onCrew(pid, "empA1")).toBe(true);
  });

  it("a PM edits a shoot and takes people off it on their own project only; deleting it stays with the lead", async () => {
    const pid = await routed(), other = await routed();
    await makePM(pid, "empA2");
    const shoot = async (p: number) => Number((await one(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, location, status, created_by)
       VALUES ($1,$2,'2026-12-05','Auditorium','planned',$3) RETURNING id`, [p, `${PX} shoot`, ACTORS.leadA.id])).id);
    const s1 = await shoot(pid), s2 = await shoot(other);
    expect((await as("empA2", "PATCH", `/shoots/${s1}`, { location: "Main ground" })).status).toBe(200);
    expect((await as("empA2", "PATCH", `/shoots/${s2}`, { location: "Main ground" })).status).toBe(403);
    expect((await as("empA1", "PATCH", `/shoots/${s1}`, { location: "Hall" })).status).toBe(403);
    expect((await as("leadA", "POST", `/shoots/${s1}/crew`, { crew: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("empA2", "DELETE", `/shoots/${s1}/crew/${ACTORS.empA1.id}`)).status).toBe(200);
    expect(await one(`SELECT 1 FROM mo_shoot_crew WHERE shoot_id=$1 AND user_id=$2`, [s1, ACTORS.empA1.id])).toBeUndefined();
    expect((await as("empA2", "DELETE", `/shoots/${s1}`)).status).toBe(403);
    expect((await as("leadA", "DELETE", `/shoots/${s1}`)).status).toBe(200);
  });
});

/* ── Q2: removal is blocked by live work until it is resolved ─────────────── */

maybe("taking someone off a project never strands their work", () => {
  it("the owner of an in-progress deliverable: 409 naming it, and nothing changes", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1");
    await as("empA1", "POST", `/deliverables/${did}/status`, { status: "in_progress" });
    const r = await remove("leadA", pid, "empA1");
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("active_deliverables");
    expect(r.body.deliverables).toEqual([
      { id: did, title: (await deliv(did)).title, status: "in_progress", role: "owner" }]);
    expect(String(r.body.message)).not.toMatch(/\b(AUTO|BR|VR|FR)-\d/);
    expect(await onCrew(pid, "empA1")).toBe(true);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA1.id);
    const impact = await as("leadA", "GET", `/projects/${pid}/assignments/${ACTORS.empA1.id}/impact`);
    expect((impact.body.blocking as Array<{ id: number }>).map((b) => b.id)).toEqual([did]);
    expect((await as("empA3", "GET", `/projects/${pid}/assignments/${ACTORS.empA1.id}/impact`)).status).toBe(403);
  });

  it("handed on: the new owner has it, both are told naming the other, and the old versions stay theirs", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`,
      { drive_url: `https://drive.google.com/${PX}-v1` })).status).toBe(201);
    const r = await remove("leadA", pid, "empA1", [{ deliverable_id: did, reassign_to: ACTORS.empA2.id }]);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA2.id);
    expect(await teamOf(did)).toEqual([ACTORS.empA2.id]);
    expect(await onCrew(pid, "empA1")).toBe(false);
    expect(await onCrew(pid, "empA2")).toBe(true);
    const v = await one(`SELECT submitted_by FROM mo_deliverable_versions WHERE deliverable_id=$1`, [did]);
    expect(v.submitted_by).toBe(ACTORS.empA1.id);
    const incoming = await noteBodies("empA2", "deliverable", did);
    expect(incoming.map((n) => n.body).join(" ")).toContain("(was ZCR Emp A1)");
    const outgoing = await noteBodies("empA1", "deliverable", did);
    expect(outgoing.map((n) => n.body).join(" ")).toContain("to ZCR Emp A2");
    const a = await one(`SELECT after FROM mo_audit_logs WHERE actor_id=$1 AND action='project.assignment_removed'
                          AND entity_id=$2 ORDER BY id DESC LIMIT 1`, [ACTORS.leadA.id, pid]);
    expect(a.after.resolutions).toEqual([{ deliverable_id: did, reassign_to: ACTORS.empA2.id }]);
  });

  it("closed as not required: 200, and the deliverable is not required", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1");
    expect((await remove("leadA", pid, "empA1", [{ deliverable_id: did, status: "not_required" }])).status).toBe(200);
    expect((await deliv(did)).status).toBe("not_required");
    expect(await onCrew(pid, "empA1")).toBe(false);
  });

  it("only delivered work: removed at once, and the delivered deliverable and its team are untouched", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1", ["empA1", "empA3"]);
    await pool.query(`UPDATE mo_deliverables SET status='delivered', delivered_by=$2 WHERE id=$1`, [did, ACTORS.empA1.id]);
    const before = await teamOf(did);
    const impact = await as("leadA", "GET", `/projects/${pid}/assignments/${ACTORS.empA1.id}/impact`);
    expect(impact.body.blocking).toEqual([]);
    expect((impact.body.history as Record<string, number>).delivered).toBe(1);
    expect((await remove("leadA", pid, "empA1")).status).toBe(200);
    const d = await deliv(did);
    expect([d.status, d.owner_id, d.delivered_by]).toEqual(["delivered", ACTORS.empA1.id, ACTORS.empA1.id]);
    expect(await teamOf(did)).toEqual(before);
  });

  it("a team member on an open deliverable is blocked; taken off its team, the owner carries on", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1", ["empA1", "empA3"]);
    const r = await remove("leadA", pid, "empA3");
    expect(r.status).toBe(409);
    expect((r.body.deliverables as Array<{ role: string }>)[0].role).toBe("team");
    expect((await remove("leadA", pid, "empA3", [{ deliverable_id: did, remove_from_team: true }])).status).toBe(200);
    expect(await teamOf(did)).toEqual([ACTORS.empA1.id]);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA1.id);
  });

  it("an owner cannot just be dropped, and nobody outside the assignable crew can take the work", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1");
    expect((await remove("leadA", pid, "empA1", [{ deliverable_id: did, remove_from_team: true }])).status).toBe(400);
    expect((await remove("leadA", pid, "empA1", [{ deliverable_id: did, reassign_to: ACTORS.outsider.id }])).status).toBe(403);
    expect((await remove("leadA", pid, "empA1", [{ deliverable_id: did, reassign_to: ACTORS.empA1.id }])).status).toBe(400);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA1.id);
    expect(await onCrew(pid, "empA1")).toBe(true);
  });

  it("someone on the work only through a deliverable is not silently 'removed'; someone not on it is told so", async () => {
    const pid = await routed();
    const did = await work(pid, "empA1");
    await pool.query(`UPDATE mo_project_assignments SET removed_at=NOW() WHERE project_id=$1 AND user_id=$2`,
      [pid, ACTORS.empA1.id]);
    const r = await remove("leadA", pid, "empA1");
    expect(r.status).toBe(409);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA1.id);
    const none = await remove("leadA", pid, "empA3");
    expect([none.status, none.body.message]).toEqual([404, "ZCR Emp A3 is not on this project."]);
  });
});

maybe("removing an account hands its deliverables on like any other owner change", () => {
  it("reassign_to: the new owner takes their place on the team and is told who it came from", async () => {
    const pid = await routed();
    const did = await work(pid, "gone", ["gone", "empA3"]);
    const r = await as("admin", "DELETE", `/crew/${ACTORS.gone.id}`, { reassign_to: ACTORS.empA2.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA2.id);
    expect(await teamOf(did)).toEqual([ACTORS.empA2.id, ACTORS.empA3.id].sort());
    expect(await onCrew(pid, "empA2")).toBe(true);
    const told = await noteBodies("empA2", "deliverable", did);
    expect(told.map((n) => n.body).join(" ")).toContain("(was ZCR Leaving)");
  });
});
