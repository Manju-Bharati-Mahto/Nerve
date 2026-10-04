// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the Media Crew production workflow, end to end.

     Coordinator → Project → Team → Team Lead → Deliverable.owner_id → Employee
       → My Day → Submit version → Team Lead review → Approved → Dispatch queue

   mediaops-project-hierarchy.integration.test.ts defends the FRONT of this
   chain (who may create, how a team resolves to its lead). This file defends
   the rest of it, and above all the one property the UI cannot enforce:

     A TEAM LEAD'S AUTHORITY IS THEIR TEAM'S PROJECTS — not every project in
     the department. Being a Team Lead somewhere is not standing on a project
     routed to somebody else's team.

   Plus the review rules that make "approved" mean something: only the
   project's lead (or an Admin) reviews, nobody approves their own deliverable,
   and there is exactly one road to the dispatch queue.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zcw-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const PX = "zcw";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZCW Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZCW Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZCW Lead A" },
  leadB: { id: `${PX}-leadB`, role: "sub_admin", team: "media", full_name: "ZCW Lead B" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZCW Emp A1" },
  empA2: { id: `${PX}-empA2`, role: "user", team: "media", full_name: "ZCW Emp A2" },
  empB1: { id: `${PX}-empB1`, role: "user", team: "media", full_name: "ZCW Emp B1" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, teamB = 0, projectTypeId = 0, dtype = 0, exemptType = 0, workTypeId = 0;

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
const project = (id: number) => one(`SELECT * FROM mo_projects WHERE id=$1`, [id]);
const notes = (uid: string, entityType: string, entityId: number) => pool.query(
  `SELECT kind, title FROM mo_notifications WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3`,
  [uid, entityType, entityId]).then((r) => r.rows);
const drive = (n: string | number) => ({ drive_url: `https://drive.google.com/${PX}-${n}` });

/** A project routed to `team` by the Coordinator, with these deliverables. */
async function routed(team: number, titles: string[] = ["Edited Photos"]) {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Annual Cultural Festival ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "high", description: "Student Affairs",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: team,
    deliverables: titles.map((title) => ({ title, deliverable_type_id: dtype })),
  });
  const pid = Number((r.body.project as Record<string, unknown>).id);
  const dids = (await pool.query(`SELECT id FROM mo_deliverables WHERE project_id=$1 ORDER BY id`, [pid]))
    .rows.map((x) => Number(x.id));
  return { r, pid, dids };
}

/** A deliverable on a Team A project, already owned by `owner`. */
async function ownedBy(owner: ActorName, team = teamA) {
  const { pid, dids } = await routed(team);
  await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS[owner].id, dids[0]]);
  return { pid, did: dids[0] };
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, a.full_name, `${a.id}@crew-workflow.invalid`, a.role]);
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
  for (const [t, u] of [[teamA, ACTORS.empA1.id], [teamA, ACTORS.empA2.id], [teamB, ACTORS.empB1.id]] as const)
    await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                      ON CONFLICT DO NOTHING`, [t, u]);
  projectTypeId = Number((await one(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).id);
  dtype = Number((await one(
    `SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL AND NOT review_exempt ORDER BY id LIMIT 1`)).id);
  const ex = await one(`SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL AND review_exempt ORDER BY id LIMIT 1`);
  exemptType = ex ? Number(ex.id) : 0;
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
  await pool.query(`DELETE FROM mo_comments WHERE body LIKE '${PX} %'`);
  await pool.query(`DELETE FROM mo_deliverables WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN ${pj}`);
  await pool.query(`UPDATE mo_requests SET project_id=NULL WHERE event_name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_requests WHERE event_name LIKE '${PX}%'`);
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

/* ── PROJECT CREATION (1–5) ───────────────────────────────────────────────── */

maybe("project creation — the Coordinator routes to ONE team", () => {
  let pid = 0, dids: number[] = [];
  beforeAll(async () => {
    ({ pid, dids } = await routed(teamA, ["Edited Photos", "Aftermovie", "Instagram Reel", "Archive Data"]));
  });

  it("1 — a Coordinator creates a project for Team A", async () => {
    expect(Number((await project(pid)).team_id)).toBe(teamA);
  });

  it("2 — with all four deliverables", async () => {
    expect(dids).toHaveLength(4);
  });

  it("3 — every deliverable starts unassigned", async () => {
    const owners = (await pool.query(`SELECT owner_id FROM mo_deliverables WHERE project_id=$1`, [pid])).rows;
    expect(owners.every((r) => r.owner_id === null)).toBe(true);
  });

  it("4 — Team A's lead owns it, is its PM, and is told", async () => {
    expect((await project(pid)).owner_id).toBe(ACTORS.leadA.id);
    const pm = await pool.query(
      `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager AND removed_at IS NULL`, [pid]);
    expect(pm.rows.map((r) => r.user_id)).toEqual([ACTORS.leadA.id]);
    expect((await notes(ACTORS.leadA.id, "project", pid)).map((n) => n.title)).toContain("You are leading a new project");
  });

  it("5 — Team B's lead cannot operate on Team A's project", async () => {
    expect((await as("leadB", "PATCH", `/projects/${pid}`, { description: "hijacked" })).status).toBe(403);
    expect((await as("leadB", "POST", `/projects/${pid}/status`, { status: "in_production" })).status).toBe(403);
    expect((await as("leadB", "POST", `/projects/${pid}/deliverables`,
      { title: `${PX} extra`, deliverable_type_id: dtype })).status).toBe(403);
    const victim = await routed(teamA);
    expect((await as("leadB", "DELETE", `/projects/${victim.pid}`)).status).toBe(403);
    // …while Team A's own lead still runs it.
    expect((await as("leadA", "POST", `/projects/${pid}/status`, { status: "in_production" })).status).toBe(200);
  });
});

/* ── An EMPLOYEE's project is their own ────────────────────────────────────── */

maybe("employee project creation — assigned to themselves, never to a team", () => {
  const mine = (extra: Record<string, unknown> = {}) => as("empA1", "POST", "/projects", {
    name: `${PX} my own project ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
    start_date: "2026-10-01", end_date: "2026-10-10", ...extra });

  it("an employee creates a project, and it is theirs: owner and PM, no team", async () => {
    const r = await mine({ deliverables: [{ title: "Edited Photos", deliverable_type_id: dtype }] });
    expect(r.status).toBe(201);
    const p = r.body.project as Record<string, unknown>;
    expect(p.owner_id).toBe(ACTORS.empA1.id);
    expect(p.team_id).toBe(null);
    const pm = await pool.query(
      `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager AND removed_at IS NULL`, [p.id]);
    expect(pm.rows.map((x) => x.user_id)).toEqual([ACTORS.empA1.id]);
  });

  it("an employee cannot route their project to a team — their own or another", async () => {
    expect((await mine({ team_id: teamA })).status).toBe(403);
    expect((await mine({ team_id: teamB })).status).toBe(403);
  });

  it("an employee names nobody but themselves", async () => {
    expect((await mine({ deliverables: [{ title: "x", deliverable_type_id: dtype, owner_id: ACTORS.empA2.id }] })).status).toBe(403);
    expect((await mine({ assignees: [ACTORS.empA2.id] })).status).toBe(403);
    const ok = await mine({ deliverables: [{ title: "Mine", deliverable_type_id: dtype, owner_id: ACTORS.empA1.id }] });
    expect(ok.status).toBe(201);
  });

  it("a colleague cannot run an employee's project", async () => {
    const r = await mine();
    const pid = Number((r.body.project as Record<string, unknown>).id);
    expect((await as("empA2", "PATCH", `/projects/${pid}`, { description: "mine now" })).status).toBe(403);
    expect((await as("empA2", "POST", `/projects/${pid}/deliverables`,
      { title: `${PX} x`, deliverable_type_id: dtype })).status).toBe(403);
    expect((await as("leadB", "PATCH", `/projects/${pid}`, { description: "x" })).status).toBe(403);
  });
});

/* ── TEAM LEAD (6–9) ──────────────────────────────────────────────────────── */

maybe("team lead — allocates inside their own team, on their own team's projects", () => {
  let a = { pid: 0, dids: [] as number[] }, b = { pid: 0, dids: [] as number[] };
  beforeAll(async () => {
    a = await routed(teamA, ["Edited Photos", "Aftermovie", "Instagram Reel", "Archive Data"]);
    b = await routed(teamB, ["Teaser"]);
  });

  it("6 — Team A's lead assigns a Team A employee (owner_id is the assignment)", async () => {
    expect((await as("leadA", "PATCH", `/deliverables/${a.dids[0]}`, { owner_id: ACTORS.empA1.id })).status).toBe(200);
    expect((await deliv(a.dids[0])).owner_id).toBe(ACTORS.empA1.id);
  });

  it("6b — the drawer's assign path writes the same owner_id, and no duplicate crew row", async () => {
    const r = await as("leadA", "POST", `/deliverables/${a.dids[1]}/assignee`, { kind: "crew", user_id: ACTORS.empA2.id });
    expect(r.status).toBe(201);
    expect((await deliv(a.dids[1])).owner_id).toBe(ACTORS.empA2.id);
    const rows = await pool.query(
      `SELECT 1 FROM mo_assignments WHERE deliverable_id=$1 AND NOT is_smc AND status<>'cancelled'`, [a.dids[1]]);
    expect(rows.rowCount).toBe(0);
    expect((await notes(ACTORS.empA2.id, "deliverable", a.dids[1])).map((n) => n.title)).toContain("New assignment");
  });

  it("6c — reading the assignee back reports the owner", async () => {
    await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA1.id, a.dids[3]]);
    const r = await as("leadA", "GET", `/deliverables/${a.dids[3]}/assignees`);
    expect((r.body.crew as Record<string, unknown> | null)?.user_id ?? null).toBe(ACTORS.empA1.id);
  });

  it("7 — Team A's lead cannot assign a Team B employee, by either path", async () => {
    expect((await as("leadA", "PATCH", `/deliverables/${a.dids[2]}`, { owner_id: ACTORS.empB1.id })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${a.dids[2]}/assignee`,
      { kind: "crew", user_id: ACTORS.empB1.id })).status).toBe(403);
  });

  it("8 — Team A's lead cannot operate on Team B's project", async () => {
    const d = b.dids[0];
    expect((await as("leadA", "PATCH", `/deliverables/${d}`, { owner_id: ACTORS.empA1.id })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${d}/assignee`, { kind: "crew", user_id: ACTORS.empA1.id })).status).toBe(403);
    expect((await deliv(d)).owner_id).toBe(null);
    expect((await as("leadA", "POST", `/deliverables/${d}/schedule`, { scheduled_date: "2026-10-04" })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/deliverables/${d}/due-date`, { due_date: "2026-10-09" })).status).toBe(403);
    expect((await as("leadA", "POST", `/projects/${b.pid}/work`,
      { work_type_id: workTypeId, title: `${PX} task`, assignees: [ACTORS.empA1.id] })).status).toBe(403);
    expect((await as("leadA", "POST", `/projects/${b.pid}/tasks`,
      { title: `${PX} task`, assignees: [ACTORS.empA1.id] })).status).toBe(403);
    expect((await as("leadA", "POST", `/projects/${b.pid}/assignments`, { user_id: ACTORS.empA1.id })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/projects/${b.pid}`, { team_id: teamA })).status).toBe(403);
    expect(Number((await project(b.pid)).team_id)).toBe(teamB);
    // A lead does not re-route even their own project — that is the Coordinator's call.
    expect((await as("leadA", "PATCH", `/projects/${a.pid}`, { team_id: teamB })).status).toBe(403);
  });

  it("9 — Team A's lead cannot create a project for Team B", async () => {
    const r = await as("leadA", "POST", "/projects", {
      name: `${PX} wrong team ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamB });
    expect(r.status).toBe(403);
  });

  it("9b — a lead who names no team gets their own", async () => {
    const r = await as("leadA", "POST", "/projects", {
      name: `${PX} own team ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10" });
    expect(r.status).toBe(201);
    const p = r.body.project as Record<string, unknown>;
    expect(Number(p.team_id)).toBe(teamA);
    expect(p.owner_id).toBe(ACTORS.leadA.id);
  });
});

/* ── EMPLOYEE (10–14) ─────────────────────────────────────────────────────── */

maybe("employee — sees and executes their own work, and nothing more", () => {
  let pid = 0, dids: number[] = [];
  beforeAll(async () => {
    ({ pid, dids } = await routed(teamA, ["Edited Photos", "Aftermovie", "Archive Data"]));
    await as("leadA", "PATCH", `/deliverables/${dids[0]}`, { owner_id: ACTORS.empA1.id });
  });

  it("10 — the assigned employee can open the project and is on its crew", async () => {
    expect((await as("empA1", "GET", `/projects/${pid}`)).status).toBe(200);
    const crew = await pool.query(
      `SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`,
      [pid, ACTORS.empA1.id]);
    expect(crew.rowCount).toBe(1);
  });

  it("10b — an owner from before crew-on-assignment still receives the project's thread", async () => {
    const legacy = await routed(teamA);
    await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA2.id, legacy.dids[0]]);
    await pool.query(`INSERT INTO mo_comments (entity_type, entity_id, user_id, body) VALUES ('project',$1,$2,$3)`,
      [legacy.pid, ACTORS.leadA.id, `${PX} feedback for the owner`]);
    const raw = async (a: ActorName) => JSON.stringify(await (await fetch(`${base}/state`, { headers: { "x-actor": a } })).json());
    expect(await raw("empA2")).toContain(`${PX} feedback for the owner`);
    expect(await raw("empB1")).not.toContain(`${PX} feedback for the owner`);
  });

  it("11/12 — owner_id names exactly one employee as the executor", async () => {
    const owned = await pool.query(`SELECT owner_id FROM mo_deliverables WHERE project_id=$1 AND owner_id IS NOT NULL`, [pid]);
    expect(owned.rows.map((r) => r.owner_id)).toEqual([ACTORS.empA1.id]);
  });

  it("13 — an employee cannot take or hand out deliverables", async () => {
    // claiming an unassigned one
    expect((await as("empA2", "PATCH", `/deliverables/${dids[1]}`, { owner_id: ACTORS.empA2.id })).status).toBe(403);
    // taking a colleague's
    expect((await as("empA2", "PATCH", `/deliverables/${dids[0]}`, { owner_id: ACTORS.empA2.id })).status).toBe(403);
    expect((await deliv(dids[0])).owner_id).toBe(ACTORS.empA1.id);
    // handing one to a colleague
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { owner_id: ACTORS.empA2.id })).status).toBe(403);
    expect((await as("empA1", "POST", `/deliverables/${dids[2]}/assignee`,
      { kind: "crew", user_id: ACTORS.empA1.id })).status).toBe(403);
  });

  it("13b — an employee cannot edit another employee's deliverable", async () => {
    expect((await as("empA2", "PATCH", `/deliverables/${dids[0]}`, { title: "tampered" })).status).toBe(403);
    expect((await as("empB1", "PATCH", `/deliverables/${dids[0]}`, { scheduled_date: "2026-10-04" })).status).toBe(403);
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { priority: "urgent" })).status).toBe(403);
    expect((await as("coord", "PATCH", `/deliverables/${dids[0]}`, { due_date: "2026-10-09" })).status).toBe(403);
    expect((await as("coord", "PATCH", `/deliverables/${dids[0]}`, { mail_status: "sent" })).status).toBe(200);
    const d = await deliv(dids[0]);
    expect([d.title, d.scheduled_date, d.priority]).toEqual(["Edited Photos", null, "normal"]);
  });

  it("13c — the owner may update their own execution fields", async () => {
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { quantity_delivered: 120 })).status).toBe(200);
    expect(Number((await deliv(dids[0])).quantity_delivered)).toBe(120);
  });

  it("13d — an employee moves their own work into progress, and only their own", async () => {
    expect((await as("empA1", "POST", `/deliverables/${dids[0]}/status`, { status: "in_progress" })).status).toBe(200);
    expect((await as("empA2", "POST", `/deliverables/${dids[0]}/status`, { status: "not_required" })).status).toBe(403);
  });

  it("14 — an employee cannot change approval_status", async () => {
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { approval_status: "approved" })).status).toBe(400);
    expect((await as("leadA", "PATCH", `/deliverables/${dids[0]}`, { approval_status: "approved" })).status).toBe(400);
    expect((await deliv(dids[0])).approval_status ?? "pending").toBe("pending");
  });
});

/* ── SUBMISSION (15–18) ───────────────────────────────────────────────────── */

maybe("submission — the owner submits, the project's lead hears about it", () => {
  let did = 0;
  beforeAll(async () => { ({ did } = await ownedBy("empA1")); });

  it("15 — the assigned employee submits a version", async () => {
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive(1))).status).toBe(201);
    expect((await deliv(did)).status).toBe("in_review");
  });

  it("16 — an employee who does not own it cannot", async () => {
    expect((await as("empA2", "POST", `/deliverables/${did}/versions`, drive(2))).status).toBe(403);
    expect((await as("empB1", "POST", `/deliverables/${did}/versions`, drive(3))).status).toBe(403);
    expect((await as("coord", "POST", `/deliverables/${did}/versions`, drive(4))).status).toBe(403);
    expect((await as("leadB", "POST", `/deliverables/${did}/versions`, drive(5))).status).toBe(403);
    const n = await one(`SELECT COUNT(*)::int c FROM mo_deliverable_versions WHERE deliverable_id=$1`, [did]);
    expect(n.c).toBe(1);
  });

  it("17 — the submission reaches Team A's lead, and nobody else's", async () => {
    expect((await notes(ACTORS.leadA.id, "deliverable", did)).map((x) => x.title)).toEqual(["Version submitted for review"]);
    expect((await notes(ACTORS.leadB.id, "deliverable", did)).length).toBe(0);
  });

  it("18 — Team B's lead cannot review Team A's work", async () => {
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "changes_requested", comment: "x" })).status).toBe(403);
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("coord", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("empA1", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await deliv(did)).status).toBe("in_review");
  });
});

/* ── REVIEW (19–23) ───────────────────────────────────────────────────────── */

maybe("review — Team A's lead decides, and approval queues dispatch", () => {
  let did = 0;
  beforeAll(async () => {
    ({ did } = await ownedBy("empA1"));
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("r1"));
  });

  it("20 — Team B's lead is refused on every review path", async () => {
    expect((await as("leadB", "POST", `/deliverables/${did}/status`, { status: "approved" })).status).toBe(403);
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(403);
    const d = await deliv(did);
    expect([d.status, d.approval_status ?? "pending", d.dispatch_status]).toEqual(["in_review", "pending", "none"]);
  });

  it("22 — changes requested sends it back, and the owner resubmits", async () => {
    expect((await as("leadA", "POST", `/deliverables/${did}/review`,
      { outcome: "changes_requested", comment: "tighten the edit" })).status).toBe(200);
    expect((await deliv(did)).status).toBe("changes_requested");
    expect((await notes(ACTORS.empA1.id, "deliverable", did)).map((n) => n.title))
      .toContain("Changes requested on Edited Photos");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("r2"))).status).toBe(201);
    expect((await deliv(did)).status).toBe("in_review");
  });

  it("19/23 — Team A's lead approves, and it lands in the dispatch queue", async () => {
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    const d = await deliv(did);
    expect(d.status).toBe("approved");
    expect(d.dispatch_status).toBe("queued");
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "Student Affairs" })).status).toBe(200);
  });

  it("21 — a deliverable's owner cannot approve it, even when someone else submitted the version", async () => {
    const own = await ownedBy("leadA");
    expect((await as("leadA", "POST", `/deliverables/${own.did}/versions`, drive("o1"))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(403);
    // A version pushed by someone else used to make the owner eligible.
    expect((await as("admin", "POST", `/deliverables/${own.did}/versions`, drive("o2"))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${own.did}/status`, { status: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${own.did}/approval`, { approval_status: "approved" })).status).toBe(403);
    expect((await deliv(own.did)).status).toBe("in_review");
    // Someone who is not the owner (an Admin) is who signs it off.
    expect((await as("admin", "POST", `/deliverables/${own.did}/versions`, drive("o3"))).status).toBe(201);
    await pool.query(`UPDATE mo_deliverable_versions SET submitted_by=$1 WHERE deliverable_id=$2`, [ACTORS.leadA.id, own.did]);
    expect((await as("admin", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("21b — an Admin who owns a deliverable cannot approve it either", async () => {
    const own = await ownedBy("admin");
    await as("admin", "POST", `/deliverables/${own.did}/versions`, drive("a1"));
    await as("leadA", "POST", `/deliverables/${own.did}/versions`, drive("a2"));
    expect((await as("admin", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(403); // submitted v2
    expect((await deliv(own.did)).status).toBe("in_review");
  });
});

/* ── APPROVAL BYPASS (24–26) ──────────────────────────────────────────────── */

maybe("approval bypass — there is one road to approved", () => {
  it("24 — an employee cannot approve through PATCH", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("empA1", "PATCH", `/deliverables/${did}`, { approval_status: "approved" })).status).toBe(400);
    expect((await deliv(did)).approval_status ?? "pending").not.toBe("approved");
  });

  it("25 — an employee cannot skip review by marking their work delivered", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(400);
    await as("empA1", "POST", `/deliverables/${did}/status`, { status: "in_progress" });
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(400);
    expect((await as("empA1", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(400);
    expect((await as("empA2", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(403);
    expect((await deliv(did)).status).toBe("in_progress");
  });

  it("25b — a review-exempt type is still delivered directly by its owner", async () => {
    if (!exemptType) return;
    const { did } = await ownedBy("empA1");
    await pool.query(`UPDATE mo_deliverables SET deliverable_type_id=$1, status='in_progress' WHERE id=$2`, [exemptType, did]);
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(200);
  });

  it("26 — the board's 'approved' is the same review: it needs a version, and it queues dispatch", async () => {
    const bare = await ownedBy("empA1");
    await pool.query(`UPDATE mo_deliverables SET status='in_review' WHERE id=$1`, [bare.did]);
    expect((await as("leadA", "POST", `/deliverables/${bare.did}/status`, { status: "approved" })).status).toBe(400);

    const real = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${real.did}/versions`, drive("b1"));
    expect((await as("leadA", "POST", `/deliverables/${real.did}/status`, { status: "approved" })).status).toBe(200);
    expect((await deliv(real.did)).dispatch_status).toBe("queued");
    const v = await one(`SELECT review_status, reviewed_by FROM mo_deliverable_versions WHERE deliverable_id=$1`, [real.did]);
    expect(v).toEqual({ review_status: "approved", reviewed_by: ACTORS.leadA.id });
    // …and the board's "send back" pulls it out of the queue again, version and all.
    expect((await as("leadA", "POST", `/deliverables/${real.did}/status`, { status: "changes_requested" })).status).toBe(200);
    const back = await deliv(real.did);
    expect([back.status, back.dispatch_status]).toEqual(["changes_requested", "none"]);
  });

  it("26b — post-delivery approval cannot stand in for review on undelivered work", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(400);
    expect((await deliv(did)).approval_status ?? "pending").toBe("pending");
  });
});

/* ── Phase 2 review findings (self-naming, team re-leading, bypass holes) ─── */

maybe("Phase 2 — the self-naming, bypass and routing holes stay closed", () => {
  it("the Coordinator cannot name themselves (or any employee) as deliverable owner at creation", async () => {
    const r = await as("coord", "POST", "/projects", {
      name: `${PX} self ${Math.random().toString(36).slice(2, 7)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA,
      deliverables: [{ title: "self", deliverable_type_id: dtype, owner_id: ACTORS.coord.id }] });
    expect(r.status).toBe(403);
    const r2 = await as("coord", "POST", "/projects", {
      name: `${PX} emp ${Math.random().toString(36).slice(2, 7)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA,
      deliverables: [{ title: "emp", deliverable_type_id: dtype, owner_id: ACTORS.empA1.id }] });
    expect(r2.status).toBe(403);
  });

  it("POST /requests/:id/lead refuses the Coordinator naming themselves or an employee", async () => {
    const r1 = await pool.query(
      `INSERT INTO mo_requests (event_name, priority, status) VALUES ($1,'high','ready') RETURNING id`,
      [`${PX} r1 ${Math.random().toString(36).slice(2, 7)}`]);
    expect((await as("coord", "POST", `/requests/${r1.rows[0].id}/lead`, { lead_user_id: ACTORS.coord.id })).status).toBe(400);
    expect((await as("coord", "POST", `/requests/${r1.rows[0].id}/lead`, { lead_user_id: ACTORS.empA1.id })).status).toBe(400);
    expect((await as("coord", "POST", `/requests/${r1.rows[0].id}/lead`, { lead_user_id: ACTORS.leadA.id })).status).toBe(200);
  });

  it("convert's lead_user_id fallback must name a Team Lead, never the Coordinator", async () => {
    const r = await pool.query(
      `INSERT INTO mo_requests (event_name, priority, status) VALUES ($1,'high','ready') RETURNING id`,
      [`${PX} r2 ${Math.random().toString(36).slice(2, 7)}`]);
    const bad = await as("coord", "POST", `/requests/${r.rows[0].id}/convert`, {
      project_type_id: projectTypeId, lead_user_id: ACTORS.coord.id,
      start_date: "2026-10-01", end_date: "2026-10-10" });
    expect(bad.status).toBe(400);
    const ok = await as("coord", "POST", `/requests/${r.rows[0].id}/convert`, {
      project_type_id: projectTypeId, lead_user_id: ACTORS.leadA.id,
      start_date: "2026-10-01", end_date: "2026-10-10" });
    expect(ok.status).toBe(201);
    expect((await project(Number(ok.body.project_id))).owner_id).toBe(ACTORS.leadA.id);
  });

  it("changing a team's lead moves owner_id and the PM row to the new lead, and strips old-lead manage rights", async () => {
    const { pid } = await routed(teamA);
    const flip = await as("admin", "PATCH", `/teams/${teamA}`,
      { lead_user_id: ACTORS.leadB.id, allow_multi_lead: true });
    expect(flip.status).toBe(200);
    const p = await project(pid);
    expect(p.owner_id).toBe(ACTORS.leadB.id);
    const pm = await pool.query(
      `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager AND removed_at IS NULL`, [pid]);
    expect(pm.rows.map((r) => r.user_id)).toEqual([ACTORS.leadB.id]);
    expect((await as("leadA", "PATCH", `/projects/${pid}`, { description: "stale" })).status).toBe(403);
    expect((await as("leadB", "PATCH", `/projects/${pid}`, { description: "fresh" })).status).toBe(200);
    // restore
    await as("admin", "PATCH", `/teams/${teamA}`, { lead_user_id: ACTORS.leadA.id, allow_multi_lead: true });
  });

  it("/deliver cannot undo a reviewer's send-back, and refuses cancelled scope", async () => {
    const { did } = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("x1"));
    await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    await as("empA1", "POST", `/deliverables/${did}/deliver`, {});
    await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "changes_requested", note: "revise" });
    const back = await as("empA1", "POST", `/deliverables/${did}/deliver`, {});
    expect(back.status).toBe(400);
    expect((await deliv(did)).status).toBe("changes_requested");
    const second = await ownedBy("empA1");
    await pool.query(`UPDATE mo_deliverables SET status='cancelled' WHERE id=$1`, [second.did]);
    expect((await as("empA1", "POST", `/deliverables/${second.did}/deliver`, {})).status).toBe(400);
  });

  it("/versions is refused on cancelled, not_required, approved and delivered deliverables", async () => {
    const { did } = await ownedBy("empA1");
    for (const bad of ["cancelled", "not_required", "approved", "delivered"]) {
      await pool.query(`UPDATE mo_deliverables SET status=$1 WHERE id=$2`, [bad, did]);
      const r = await as("empA1", "POST", `/deliverables/${did}/versions`, drive(bad));
      expect(r.status, `/versions on ${bad}`).toBe(400);
    }
  });

  it("/dispatch is refused after a send-back and when already dispatched", async () => {
    const { did } = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("v"));
    await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    await as("empA1", "POST", `/deliverables/${did}/deliver`, {});
    await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "changes_requested" });
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "x" })).status).toBe(400);
    // Already-dispatched items cannot be re-dispatched over the top.
    await pool.query(`UPDATE mo_deliverables SET status='approved', approval_status='pending', dispatch_status='delivered'
                      WHERE id=$1`, [did]);
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "x" })).status).toBe(400);
  });

  it("a lead-owned/submitted version notifies the Admins, not the lead's own queue", async () => {
    const { pid } = await routed(teamA);
    const own = await pool.query(
      `UPDATE mo_deliverables SET owner_id=$1 WHERE project_id=$2 RETURNING id`,
      [ACTORS.leadA.id, pid]);
    const did = Number(own.rows[0].id);
    await as("leadA", "POST", `/deliverables/${did}/versions`, drive("own"));
    const admins = await pool.query(`SELECT id FROM users WHERE team='media' AND role IN ('admin','super_admin')`);
    for (const a of admins.rows) {
      const n = await pool.query(
        `SELECT COUNT(*)::int c FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`,
        [a.id, did]);
      expect(Number(n.rows[0].c), `admin ${a.id} not told`).toBeGreaterThanOrEqual(1);
    }
    const leadNotes = await pool.query(
      `SELECT COUNT(*)::int c FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`,
      [ACTORS.leadA.id, did]);
    expect(Number(leadNotes.rows[0].c)).toBe(0);
  });

  it("adding a deliverable with an owner notifies them, and they join the project crew", async () => {
    const { pid } = await routed(teamA);
    const r = await as("leadA", "POST", `/projects/${pid}/deliverables`,
      { title: `${PX} new`, deliverable_type_id: dtype, owner_id: ACTORS.empA2.id });
    expect(r.status).toBe(201);
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    const n = await pool.query(
      `SELECT title FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`,
      [ACTORS.empA2.id, did]);
    expect(n.rows.map((x) => x.title)).toContain("New assignment");
    const crew = await pool.query(
      `SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`,
      [pid, ACTORS.empA2.id]);
    expect(crew.rowCount).toBe(1);
  });
});

/* ── Phase 17 — no information leak through transition-first errors ────── */

maybe("Phase 17 — authorization runs before the state machine", () => {
  it("POST /projects/:id/status answers 403 before BR-1 for unauthorized callers", async () => {
    const { pid } = await routed(teamA);
    // Admin moves it into in_production
    expect((await as("admin", "POST", `/projects/${pid}/status`, { status: "in_production" })).status).toBe(200);
    // Unauthorized callers get 403 even on a no-op (in_production → in_production is not valid),
    // so the project's current state is not leaked through the BR-1 message.
    for (const who of ["leadB", "coord", "empA1", "empA2", "empB1"] as const) {
      const r = await as(who, "POST", `/projects/${pid}/status`, { status: "in_production" });
      expect(r.status, `${who} should be 403, got ${r.status}: ${JSON.stringify(r.body)}`).toBe(403);
      expect(String(r.body.message)).not.toContain("in_production");
    }
  });
});

/* ── PROJECT CONVERSION (27) ──────────────────────────────────────────────── */

maybe("conversion — a request becomes a project on the team it was routed to", () => {
  const request = async (team: number | null) => one(
    `INSERT INTO mo_requests (event_name, priority, status, team_id, event_date, project_type_id)
     VALUES ($1,'high','ready',$2,'2026-10-12',$3) RETURNING id`,
    [`${PX} converted ${Math.random().toString(36).slice(2, 8)}`, team, projectTypeId]);

  it("27 — the converted project keeps team_id (the payload the Convert dialog sends)", async () => {
    const req = await request(null);
    const r = await as("coord", "POST", `/requests/${req.id}/convert`,
      { project_type_id: projectTypeId, team_id: teamA, start_date: "2026-10-12", end_date: "2026-10-12" });
    expect(r.status).toBe(201);
    const p = await project(Number(r.body.project_id));
    expect(Number(p.team_id)).toBe(teamA);
    expect(p.owner_id).toBe(ACTORS.leadA.id);
    // …so the lead's authority follows from the team, not from a backfill.
    const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1 LIMIT 1`, [p.id]))?.id ?? 0);
    if (did) expect((await as("leadB", "POST", `/deliverables/${did}/schedule`, { scheduled_date: null })).status).toBe(403);
  });

  it("27b — a team chosen on the request carries over when the dialog names none", async () => {
    const req = await request(teamB);
    const r = await as("coord", "POST", `/requests/${req.id}/convert`, {});
    expect(r.status).toBe(201);
    const p = await project(Number(r.body.project_id));
    expect(Number(p.team_id)).toBe(teamB);
    expect(p.owner_id).toBe(ACTORS.leadB.id);
  });
});

/* ── EDGES the rule has to hold across ────────────────────────────────────── */

maybe("legacy projects, PMs, shoots and ad-hoc assignments", () => {
  it("a legacy project (no team_id) is led by the Team Lead who owns it", async () => {
    const { did } = await ownedBy("empA1");
    const pid = Number((await deliv(did)).project_id);
    await pool.query(`UPDATE mo_projects SET team_id=NULL WHERE id=$1`, [pid]);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("l1"));
    expect((await notes(ACTORS.leadA.id, "deliverable", did)).length).toBe(1);   // the owner-lead hears about it
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("a PM who is not the lead manages but does not review", async () => {
    const { pid, did } = await ownedBy("empA1");
    await pool.query(
      `INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
       VALUES ($1,$2,false,$3)`, [pid, ACTORS.empA2.id, ACTORS.admin.id]);
    // promote: the lead stands down so the single-PM index allows it
    await pool.query(`UPDATE mo_project_assignments SET is_project_manager=(user_id=$2) WHERE project_id=$1`,
      [pid, ACTORS.empA2.id]);
    expect((await as("empA2", "POST", `/deliverables/${did}/schedule`, { scheduled_date: "2026-10-04" })).status).toBe(200);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("pm1"));
    expect((await as("empA2", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("shoot crew follows the same scope", async () => {
    const { pid } = await routed(teamA);
    const shoot = await one(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, location, status, created_by)
       VALUES ($1,$2,'2026-10-05','Auditorium','planned',$3) RETURNING id`, [pid, `${PX} shoot`, ACTORS.leadA.id]);
    expect((await as("leadB", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empB1.id] })).status).toBe(403);
    expect((await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empB1.id] })).status).toBe(403);
    expect((await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("leadB", "PATCH", `/shoots/${shoot.id}`, { notes: "x" })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/shoots/${shoot.id}`, { notes: "x" })).status).toBe(200);
  });

  it("an assignment's members cannot be replaced from outside its project's team", async () => {
    const { pid } = await routed(teamA);
    const t = await as("leadA", "POST", `/projects/${pid}/tasks`, { title: `${PX} t`, assignees: [ACTORS.empA1.id] });
    const id = Number((t.body.assignment as Record<string, unknown>).id);
    expect((await as("leadB", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empB1.id] })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empB1.id] })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empA2.id] })).status).toBe(200);
    expect((await as("empA2", "PATCH", `/assignments/${id}`, { status: "in_progress" })).status).toBe(200);
    expect((await as("leadB", "DELETE", `/assignments/${id}`)).status).toBe(403);
  });

  it("a Coordinator still re-routes any project", async () => {
    const { pid } = await routed(teamA);
    expect((await as("coord", "PATCH", `/projects/${pid}`, { team_id: teamB })).status).toBe(200);
    expect((await project(pid)).owner_id).toBe(ACTORS.leadB.id);
  });
});
