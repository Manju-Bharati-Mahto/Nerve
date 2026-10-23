// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — adding a deliverable to an existing project, and who counts as
   a production worker.

     Add deliverable   POST /projects/:id/deliverables — the project's lead,
                       its owner/PM, an Admin, and the Coordinator; created
                       UNASSIGNED (an employee's own project aside), titled by
                       its type, and the lead/owner are told. A finished
                       project takes no new scope.
     Row defaults      priority normal, no due date, no effort when left empty.
     Production work   Admins and the Coordinator are in no assignment list
                       unless an Admin gives them the 'production_worker' duty.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zdl-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const PX = "zdl";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZDL Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZDL Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZDL Lead A" },
  leadB: { id: `${PX}-leadB`, role: "sub_admin", team: "media", full_name: "ZDL Lead B" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZDL Emp A1" },
  empA2: { id: `${PX}-empA2`, role: "user", team: "media", full_name: "ZDL Emp A2" },
  gone:  { id: `${PX}-gone`,  role: "user", team: "media", full_name: "ZDL Gone" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, teamB = 0, projectTypeId = 0, dtype = 0, dtypeName = "", workerFlag = 0;

{
  const url = resolveTestDatabaseUrl();
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
const titles = (uid: string, did: number) => pool.query(
  `SELECT title FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`,
  [uid, did]).then((r) => r.rows.map((x) => String(x.title)));
const didOf = (r: { body: Record<string, unknown> }) => Number((r.body.deliverable as Record<string, unknown>).id);

/** A project the Coordinator routed to `team`, with no deliverables yet. */
async function routed(team: number) {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Alumni Meet ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "normal", description: "",
    start_date: "2026-11-01", end_date: "2026-11-10", team_id: team,
  });
  expect(r.status).toBe(201);
  return Number((r.body.project as Record<string, unknown>).id);
}
const add = (actor: ActorName, pid: number, body: Record<string, unknown> = {}) =>
  as(actor, "POST", `/projects/${pid}/deliverables`, { deliverable_type_id: dtype, ...body });

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media',$5,'x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status=EXCLUDED.status`,
      [a.id, a.full_name, `${a.id}@add-deliverable.invalid`, a.role, name === "gone" ? "inactive" : "active"]);
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
  for (const uid of [ACTORS.empA1.id, ACTORS.empA2.id])
    await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                      ON CONFLICT DO NOTHING`, [teamA, uid]);
  projectTypeId = Number((await one(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).id);
  const t = await one(`SELECT id, name FROM mo_deliverable_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`);
  dtype = Number(t.id); dtypeName = String(t.name);
  workerFlag = Number((await one(`SELECT id FROM mo_duty_flags WHERE code='production_worker'`)).id);
}

async function cleanup() {
  const pj = `(SELECT id FROM mo_projects WHERE name LIKE '${PX}%')`;
  await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id IN (SELECT id FROM mo_assignments WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_assignments WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_drive_links WHERE entity_type='deliverable'
                      AND entity_id IN (SELECT id FROM mo_deliverables WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_deliverables WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_projects WHERE name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_team_members WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_teams WHERE name LIKE '${PX} %'`);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM users WHERE id LIKE '${PX}-%'`);
}

beforeAll(async () => {
  if (!dbUp) return;
  const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
  await bootstrapMediaOpsDatabase();
  await cleanup();
  await seed();
  await boot();
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── Q3/Q4 — Add deliverable ──────────────────────────────────────────────── */

maybe("Add deliverable on an existing project", () => {
  it("the Coordinator adds one: unassigned, titled by its type, normal priority, and the lead is told", async () => {
    const pid = await routed(teamA);
    const r = await add("coord", pid);
    expect(r.status).toBe(201);
    const d = await deliv(didOf(r));
    expect(d.owner_id).toBeNull();
    expect(d.title).toBe(dtypeName);
    // Q4: nothing filled in stores normal / no due date / no effort.
    expect(d.priority).toBe("normal");
    expect(d.due_date).toBeNull();
    expect(d.estimated_hours).toBeNull();
    expect(await titles(ACTORS.leadA.id, Number(d.id))).toEqual(["Deliverable added"]);
    expect(await titles(ACTORS.coord.id, Number(d.id))).toEqual([]);
  });

  it("a second of the same type is numbered; priority, due date and effort are kept", async () => {
    const pid = await routed(teamA);
    expect((await add("leadA", pid)).status).toBe(201);
    const r = await add("leadA", pid, { priority: "urgent", due_date: "2026-11-08", estimated_hours: 2.5 });
    expect(r.status).toBe(201);
    const d = await deliv(didOf(r));
    expect(d.title).toBe(`${dtypeName} (2)`);
    expect(d.priority).toBe("urgent");
    expect(String(d.due_date instanceof Date ? d.due_date.toISOString() : d.due_date)).toMatch(/^2026-11-0[78]/);
    expect(Number(d.estimated_hours)).toBe(2.5);
    expect(d.due_date_source).toBe("manual");
    // The lead added it themselves — nobody to tell.
    expect(await titles(ACTORS.leadA.id, Number(d.id))).toEqual([]);
    expect((await add("leadA", pid, { priority: "someday" })).status).toBe(400);
  });

  it("the project's PM may add; the lead hears about it", async () => {
    const pid = await routed(teamA);
    // A project has one PM: the lead hands the role to an employee.
    await pool.query(`UPDATE mo_project_assignments SET is_project_manager=false WHERE project_id=$1`, [pid]);
    await pool.query(`INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
                      VALUES ($1,$2,true,$3)`, [pid, ACTORS.empA1.id, ACTORS.leadA.id]);
    const r = await add("empA1", pid);
    expect(r.status).toBe(201);
    expect((await deliv(didOf(r))).owner_id).toBeNull();
    expect(await titles(ACTORS.leadA.id, didOf(r))).toEqual(["Deliverable added"]);
  });

  it("another team's lead and a crew employee may not add", async () => {
    const pid = await routed(teamA);
    await pool.query(`INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
                      VALUES ($1,$2,false,$3)`, [pid, ACTORS.empA2.id, ACTORS.leadA.id]);
    expect((await add("leadB", pid)).status).toBe(403);
    expect((await add("empA2", pid)).status).toBe(403);
  });

  it("an owner_id in the request is ignored", async () => {
    const pid = await routed(teamA);
    const r = await add("admin", pid, { owner_id: ACTORS.empA2.id });
    expect(r.status).toBe(201);
    expect((await deliv(didOf(r))).owner_id).toBeNull();
    expect(await titles(ACTORS.empA2.id, didOf(r))).toEqual([]);
  });

  it("a completed, cancelled or archived project takes no new deliverables", async () => {
    const pid = await routed(teamA);
    for (const status of ["completed", "cancelled", "archived"]) {
      await pool.query(`UPDATE mo_projects SET status=$1 WHERE id=$2`, [status, pid]);
      const r = await add("coord", pid);
      expect(r.status, status).toBe(400);
      expect(String(r.body.message)).not.toMatch(/§|AUTO-|BR-|VR-|FR-/);
    }
    await pool.query(`UPDATE mo_projects SET deleted_at=NOW(), status='planning' WHERE id=$1`, [pid]);
    expect((await add("admin", pid)).status).toBe(404);
  });

  it("on an employee's own project the deliverable is theirs, as when they created it", async () => {
    const r = await as("empA2", "POST", "/projects", {
      name: `${PX} My Reel ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
      priority: "normal", start_date: "2026-11-01", end_date: "2026-11-10" });
    expect(r.status).toBe(201);
    const pid = Number((r.body.project as Record<string, unknown>).id);
    const a = await add("empA2", pid);
    expect(a.status).toBe(201);
    expect((await deliv(didOf(a))).owner_id).toBe(ACTORS.empA2.id);
  });
});

/* ── Q5 — production workers ──────────────────────────────────────────────── */

maybe("Admins and the Coordinator do production work only when flagged", () => {
  const grant = (who: ActorName, on: boolean) =>
    as("admin", "POST", `/crew/${ACTORS[who].id}/duties`, { duty_flag_id: workerFlag, grant: on });
  const crewIds = async (actor: ActorName, did: number) =>
    ((await as(actor, "GET", `/deliverables/${did}/assignable`)).body.crew as Array<{ id: string }>).map((c) => c.id);

  it("the duty exists once, however often the schema is bootstrapped", async () => {
    const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
    await bootstrapMediaOpsDatabase();
    const n = await one(`SELECT COUNT(*)::int c FROM mo_duty_flags WHERE code='production_worker'`);
    expect(n.c).toBe(1);
  });

  it("the pickers leave out Admins, the Coordinator and inactive people", async () => {
    const pid = await routed(teamA);
    const did = didOf(await add("leadA", pid));
    const ids = await crewIds("leadA", did);
    expect(ids).toContain(ACTORS.empA1.id);
    expect(ids).not.toContain(ACTORS.admin.id);
    expect(ids).not.toContain(ACTORS.coord.id);
    const mine = ((await as("admin", "GET", "/members/assignable")).body.members as Array<{ id: string }>).map((m) => m.id);
    expect(mine).toContain(ACTORS.leadB.id);
    expect(mine).not.toContain(ACTORS.admin.id);
    expect(mine).not.toContain(ACTORS.gone.id);
  });

  it("a lead cannot give an Admin work until an Admin marks them a production worker", async () => {
    const pid = await routed(teamA);
    const did = didOf(await add("leadA", pid));
    const refused = await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.admin.id });
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe("ZDL Admin is not marked as a production worker.");
    // …nor can the Admin take it themselves.
    expect((await as("admin", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.admin.id })).status).toBe(403);

    expect((await grant("admin", true)).status).toBe(200);
    expect(await crewIds("leadA", did)).toContain(ACTORS.admin.id);
    expect((await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.admin.id })).status).toBe(200);

    // Taking the duty away stops new work; what they already hold stays theirs.
    expect((await grant("admin", false)).status).toBe(200);
    expect((await deliv(did)).owner_id).toBe(ACTORS.admin.id);
    expect(await crewIds("leadA", did)).not.toContain(ACTORS.admin.id);
  });

  it("a flagged Coordinator can be picked", async () => {
    const pid = await routed(teamA);
    const did = didOf(await add("leadA", pid));
    expect((await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.coord.id })).status).toBe(403);
    await grant("coord", true);
    try {
      expect(await crewIds("leadA", did)).toContain(ACTORS.coord.id);
      expect((await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.coord.id })).status).toBe(200);
    } finally { await grant("coord", false); }
  });
});
