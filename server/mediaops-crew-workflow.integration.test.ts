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
/** The calendar day a DATE column holds, independent of the driver's Date object. */
const dayOf = (v: unknown) => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
  : String(v ?? "").slice(0, 10);

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
  await pool.query(`DELETE FROM mo_drive_links WHERE entity_type='deliverable'
                      AND entity_id IN (SELECT id FROM mo_deliverables WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_deliverables WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN ${pj}`);
  await pool.query(`UPDATE mo_requests SET project_id=NULL WHERE event_name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_requests WHERE event_name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_projects WHERE name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_academic_years WHERE label LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_boards WHERE name LIKE '${PX} %'`);
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

  /* Product decision (Oct 2026): assigning is not limited by team. A Team Lead
     assigns anyone, on any project — like an Admin. Running another team's
     project (dates, schedule, routing, status) and reviewing it are still that
     team's lead's. */
  it("7 — Team A's lead may assign a Team B employee, by either path", async () => {
    expect((await as("leadA", "PATCH", `/deliverables/${a.dids[2]}`, { owner_id: ACTORS.empB1.id })).status).toBe(200);
    // dids[1] already has an owner: taking it off them is confirmed (Q10).
    expect((await as("leadA", "POST", `/deliverables/${a.dids[1]}/assignee`,
      { kind: "crew", user_id: ACTORS.empB1.id, confirm_reassign: true })).status).toBe(201);
    expect((await deliv(a.dids[2])).owner_id).toBe(ACTORS.empB1.id);
  });

  it("8 — Team A's lead assigns on Team B's project, but does not run or review it", async () => {
    const d = b.dids[0];
    // Assigning — open to every lead.
    expect((await as("leadA", "PATCH", `/deliverables/${d}`,
      { owner_id: ACTORS.empA1.id, confirm_reassign: true })).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${d}/assignee`,
      { kind: "crew", user_id: ACTORS.empB1.id, confirm_reassign: true })).status).toBe(201);
    expect((await deliv(d)).owner_id).toBe(ACTORS.empB1.id);
    expect((await as("leadA", "POST", `/projects/${b.pid}/work`,
      { work_type_id: workTypeId, title: `${PX} task`, assignees: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("leadA", "POST", `/projects/${b.pid}/tasks`,
      { title: `${PX} task`, assignees: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("leadA", "POST", `/projects/${b.pid}/assignments`, { user_id: ACTORS.empA2.id })).status).toBe(201);
    // Running it — still Team B's lead's.
    expect((await as("leadA", "POST", `/deliverables/${d}/schedule`, { scheduled_date: "2026-10-04" })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/deliverables/${d}/due-date`, { due_date: "2026-10-09" })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/deliverables/${d}`, { title: "renamed" })).status).toBe(403);
    expect((await as("leadA", "POST", `/projects/${b.pid}/status`, { status: "on_hold" })).status).toBe(403);
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

  /* Employees assign too (product decision, Oct 2026) — but only on a project
     they are part of. Someone who is not on it cannot take or hand out its work. */
  it("13 — an employee off the project cannot take its work; one on it can hand work to a colleague", async () => {
    // empA2 is not on this project: claiming an unassigned one, or a colleague's, is refused.
    expect((await as("empA2", "PATCH", `/deliverables/${dids[1]}`, { owner_id: ACTORS.empA2.id })).status).toBe(403);
    expect((await as("empA2", "PATCH", `/deliverables/${dids[0]}`, { owner_id: ACTORS.empA2.id })).status).toBe(403);
    expect((await as("empB1", "POST", `/deliverables/${dids[2]}/assignee`,
      { kind: "crew", user_id: ACTORS.empB1.id })).status).toBe(403);
    expect((await deliv(dids[0])).owner_id).toBe(ACTORS.empA1.id);
    // empA1 is on it (they own a deliverable here) and hands an unassigned one to a colleague.
    expect((await as("empA1", "POST", `/deliverables/${dids[2]}/assignee`,
      { kind: "crew", user_id: ACTORS.empA2.id })).status).toBe(201);
    expect((await deliv(dids[2])).owner_id).toBe(ACTORS.empA2.id);
  });

  it("13b — an employee cannot edit another employee's deliverable", async () => {
    expect((await as("empA2", "PATCH", `/deliverables/${dids[0]}`, { title: "tampered" })).status).toBe(403);
    expect((await as("empB1", "PATCH", `/deliverables/${dids[0]}`, { scheduled_date: "2026-10-04" })).status).toBe(403);
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { priority: "urgent" })).status).toBe(403);
    expect((await as("coord", "PATCH", `/deliverables/${dids[0]}`, { due_date: "2026-10-09" })).status).toBe(403);
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

  /* Product decision (Oct 2026): ANY Team Lead may approve, on any project.
     The Coordinator and employees never do, and nobody approves their own. */
  it("18 — any Team Lead may review; the Coordinator and employees may not", async () => {
    expect((await as("coord", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("empA1", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("empB1", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await deliv(did)).status).toBe("in_review");
    // Team B's lead reviews Team A's work.
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "changes_requested", comment: "x" })).status).toBe(200);
    expect((await deliv(did)).status).toBe("changes_requested");
  });
});

/* ── REVIEW (19–23) ───────────────────────────────────────────────────────── */

maybe("review — Team A's lead decides, and approval queues dispatch", () => {
  let did = 0;
  beforeAll(async () => {
    ({ did } = await ownedBy("empA1"));
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("r1"));
  });

  it("20 — another team's lead approves on every review path; the Coordinator and employees do not", async () => {
    // A deliverable of its own, so the shared one below is left as it is.
    const own = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${own.did}/versions`, drive("x20"));
    for (const who of ["coord", "empA2", "empB1"] as const) {
      expect((await as(who, "POST", `/deliverables/${own.did}/status`, { status: "approved" })).status, who).toBe(403);
      expect((await as(who, "POST", `/deliverables/${own.did}/approval`, { approval_status: "approved" })).status, who).toBe(403);
    }
    expect((await as("leadB", "POST", `/deliverables/${own.did}/status`, { status: "approved" })).status).toBe(200);
    expect((await deliv(own.did)).dispatch_status).toBe("queued");
    // Post-delivery sign-off, by the other team's lead too.
    await as("empA1", "POST", `/deliverables/${own.did}/deliver`, {});
    expect((await as("leadB", "POST", `/deliverables/${own.did}/approval`, { approval_status: "approved" })).status).toBe(200);
    expect((await deliv(own.did)).approval_status).toBe("approved");
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
    await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "changes_requested", note: "redo the cut" });
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
    /* The Admins there both before and after the version goes in: suites
       running alongside add and remove their own Admins, and one added after
       the submit, or gone before the check, was never going to be told. */
    const adminIds = async () => (await pool.query(
      `SELECT id FROM users WHERE team='media' AND role IN ('admin','super_admin')`)).rows.map((r) => String(r.id));
    const before = await adminIds();
    await as("leadA", "POST", `/deliverables/${did}/versions`, drive("own"));
    const after = new Set(await adminIds());
    for (const a of before.filter((id) => after.has(id)).map((id) => ({ id }))) {
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

  /* Adding scope is not assigning it (owner's rule, Q3): an owner_id in the
     request is ignored, nobody is told they have work, and nobody joins the
     crew — the deliverable waits, unassigned, for its lead to allocate. */
  it("adding a deliverable never names an owner — an owner_id sent is ignored", async () => {
    const { pid } = await routed(teamA);
    const r = await as("leadA", "POST", `/projects/${pid}/deliverables`,
      { title: `${PX} new`, deliverable_type_id: dtype, owner_id: ACTORS.empA2.id });
    expect(r.status).toBe(201);
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    expect((await deliv(did)).owner_id).toBeNull();
    expect(await notes(ACTORS.empA2.id, "deliverable", did)).toEqual([]);
    const crew = await pool.query(
      `SELECT 1 FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`,
      [pid, ACTORS.empA2.id]);
    expect(crew.rowCount).toBe(0);
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
  it("a legacy project (no team_id): the Team Lead who owns it is the one told; any lead may approve", async () => {
    const { did } = await ownedBy("empA1");
    const pid = Number((await deliv(did)).project_id);
    await pool.query(`UPDATE mo_projects SET team_id=NULL WHERE id=$1`, [pid]);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("l1"));
    expect((await notes(ACTORS.leadA.id, "deliverable", did)).length).toBe(1);   // the owner-lead hears about it
    expect((await notes(ACTORS.leadB.id, "deliverable", did)).length).toBe(0);   // not every lead is told
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("any Team Lead approves a proposed project; running it stays with its own lead", async () => {
    const { pid } = await routed(teamA);
    await pool.query(`UPDATE mo_projects SET status='proposed' WHERE id=$1`, [pid]);
    expect((await as("empA1", "POST", `/projects/${pid}/status`, { status: "approved" })).status).toBe(403);
    expect((await as("coord", "POST", `/projects/${pid}/status`, { status: "approved" })).status).toBe(403);
    expect((await as("leadB", "POST", `/projects/${pid}/status`, { status: "approved" })).status).toBe(200);
    expect((await project(pid)).status).toBe("approved");
    // Any other status move on Team A's project is not Team B's lead's to make.
    expect((await as("leadB", "POST", `/projects/${pid}/status`, { status: "on_hold" })).status).toBe(403);
    expect((await as("leadA", "POST", `/projects/${pid}/status`, { status: "on_hold" })).status).toBe(200);
  });

  it("a PM who is not the lead manages but does not review", async () => {
    const { pid, did } = await ownedBy("empA1");
    await pool.query(
      `INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
       VALUES ($1,$2,false,$3)`, [pid, ACTORS.empA2.id, ACTORS.admin.id]);
    // promote: the lead stands down first, so the single-PM index (checked row by row) allows it
    await pool.query(`UPDATE mo_project_assignments SET is_project_manager=false WHERE project_id=$1 AND user_id<>$2`,
      [pid, ACTORS.empA2.id]);
    await pool.query(`UPDATE mo_project_assignments SET is_project_manager=true WHERE project_id=$1 AND user_id=$2`,
      [pid, ACTORS.empA2.id]);
    expect((await as("empA2", "POST", `/deliverables/${did}/schedule`, { scheduled_date: "2026-10-04" })).status).toBe(200);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("pm1"));
    expect((await as("empA2", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("shoot crew: any lead crews anyone; the Coordinator and people off the project cannot; added members are told", async () => {
    const { pid } = await routed(teamA);
    const shoot = await one(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, location, status, created_by)
       VALUES ($1,$2,'2026-10-05','Auditorium','planned',$3) RETURNING id`, [pid, `${PX} shoot`, ACTORS.leadA.id]);
    expect((await as("leadB", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empB1.id] })).status).toBe(201);
    expect((await as("coord", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA2.id] })).status).toBe(403);
    // empB1 is on the shoot, not on the project's crew — they do not assign here.
    expect((await as("empB1", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA2.id] })).status).toBe(403);
    expect((await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA1.id] })).status).toBe(201);
    // The newly-added crew member is told, with the shoot's title and date in the body.
    const n = await pool.query(
      `SELECT title, body FROM mo_notifications WHERE user_id=$1 AND entity_type='shoot' AND entity_id=$2`,
      [ACTORS.empA1.id, shoot.id]);
    expect(n.rows.map((r) => r.title)).toContain("You are on a shoot");
    expect(String(n.rows[0]?.body ?? "")).toContain("2026-10-05");
    expect((await as("leadB", "PATCH", `/shoots/${shoot.id}`, { notes: "x" })).status).toBe(403);
    expect((await as("leadA", "PATCH", `/shoots/${shoot.id}`, { notes: "x" })).status).toBe(200);
  });

  it("adding a crew member via /projects/:id/assignments notifies them", async () => {
    const { pid } = await routed(teamA);
    const r = await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA2.id });
    expect(r.status).toBe(201);
    const n = await pool.query(
      `SELECT title FROM mo_notifications WHERE user_id=$1 AND entity_type='project' AND entity_id=$2`,
      [ACTORS.empA2.id, pid]);
    expect(n.rows.map((x) => x.title)).toContain("You are on a project");
  });

  it("any lead re-assigns an assignment's people; an assignee only moves its status; deleting stays with the project's lead", async () => {
    const { pid } = await routed(teamA);
    const t = await as("leadA", "POST", `/projects/${pid}/tasks`, { title: `${PX} t`, assignees: [ACTORS.empA1.id] });
    const id = Number((t.body.assignment as Record<string, unknown>).id);
    const people = async () => (await pool.query(
      `SELECT user_id FROM mo_assignment_users WHERE assignment_id=$1 ORDER BY user_id`, [id])).rows.map((r) => r.user_id);
    expect((await as("leadB", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empB1.id] })).status).toBe(200);
    expect(await people()).toEqual([ACTORS.empB1.id]);
    expect((await as("leadA", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empA2.id] })).status).toBe(200);
    // An assignee who did not set it moves its status; the people on it are not theirs to change.
    expect((await as("empA2", "PATCH", `/assignments/${id}`, { status: "in_progress", assignees: [ACTORS.empB1.id] })).status).toBe(200);
    expect(await people()).toEqual([ACTORS.empA2.id]);
    expect((await as("leadB", "DELETE", `/assignments/${id}`)).status).toBe(403);
  });

  it("a Coordinator still re-routes any project", async () => {
    const { pid } = await routed(teamA);
    expect((await as("coord", "PATCH", `/projects/${pid}`, { team_id: teamB })).status).toBe(200);
    expect((await project(pid)).owner_id).toBe(ACTORS.leadB.id);
  });
});

/* ── ASSIGN WORK makes the deliverable, and its team ─────────────────────────
   One dialog: the work, the deliverable it produces, and the people on it.
   The owner is accountable; everyone assigned works on the deliverable — sees
   it, submits versions of it, hears the review — and nobody on it reviews it. */

maybe("assign work — creates the deliverable and gives it a team", () => {
  const work = (actor: ActorName, pid: number, extra: Record<string, unknown>) =>
    as(actor, "POST", `/projects/${pid}/work`, { work_type_id: workTypeId, title: `${PX} edit the highlights`, ...extra });
  const teamRow = (did: number) => pool.query(
    `SELECT a.id, array_agg(au.user_id ORDER BY au.user_id) AS users FROM mo_assignments a
       JOIN mo_assignment_users au ON au.assignment_id=a.id
      WHERE a.deliverable_id=$1 AND a.status<>'cancelled' GROUP BY a.id`, [did]).then((r) => r.rows);

  it("creates the deliverable, owned by the first person picked, with everyone on its work row and the crew", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA2.id, ACTORS.empA1.id], due_date: "2026-10-20",
      new_deliverable: { deliverable_type_id: dtype, title: "Festival highlights", drive_url: "https://drive.google.com/zcw" } });
    expect(r.status).toBe(201);
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    const d = await deliv(did);
    expect([d.title, d.owner_id, d.status, Number(d.project_id)]).toEqual(["Festival highlights", ACTORS.empA2.id, "not_started", pid]);
    expect(dayOf(d.due_date)).toBe("2026-10-20");   // the work's due date, as none was given for the deliverable
    const rows = await teamRow(did);
    expect(rows).toHaveLength(1);
    expect(rows[0].users).toEqual([ACTORS.empA1.id, ACTORS.empA2.id].sort());
    const crew = await pool.query(
      `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND removed_at IS NULL AND NOT is_project_manager`, [pid]);
    expect(crew.rows.map((x) => x.user_id).sort()).toEqual([ACTORS.empA1.id, ACTORS.empA2.id].sort());
    const link = await one(`SELECT url FROM mo_drive_links WHERE entity_type='deliverable' AND entity_id=$1`, [did]);
    expect(link?.url).toBe("https://drive.google.com/zcw");
  });

  it("tells each person once, pointing at the deliverable, saying who owns it", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id],
      new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    const n1 = await pool.query(`SELECT body FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`, [ACTORS.empA1.id, did]);
    const n2 = await pool.query(`SELECT body FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`, [ACTORS.empA2.id, did]);
    expect(n1.rowCount).toBe(1);
    expect(n2.rowCount).toBe(1);
    expect(n1.rows[0].body).toContain("You own");
    expect(n2.rows[0].body).toContain("You are working on");
    // Untitled, the deliverable is named by its type; a second of that type is numbered.
    const typeName = String((await one(`SELECT name FROM mo_deliverable_types WHERE id=$1`, [dtype])).name);
    expect((await deliv(did)).title).toBe(typeName);
    const r2 = await work("leadA", pid, { assignees: [ACTORS.empA1.id], new_deliverable: { deliverable_type_id: dtype } });
    expect((await deliv(Number((r2.body.deliverable as Record<string, unknown>).id))).title).toBe(`${typeName} (2)`);
  });

  it("an owner named explicitly must be one of the people assigned", async () => {
    const { pid } = await routed(teamA, []);
    const ok = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA2.id,
      new_deliverable: { deliverable_type_id: dtype } });
    expect((await deliv(Number((ok.body.deliverable as Record<string, unknown>).id))).owner_id).toBe(ACTORS.empA2.id);
    expect((await work("leadA", pid, { assignees: [ACTORS.empA1.id], owner_id: ACTORS.empA2.id,
      new_deliverable: { deliverable_type_id: dtype } })).status).toBe(400);
  });

  it("refuses bad input without creating half of anything", async () => {
    const { pid } = await routed(teamA, ["Existing"]);
    const existing = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1`, [pid])).id);
    const before = Number((await one(`SELECT COUNT(*)::int c FROM mo_deliverables WHERE project_id=$1`, [pid])).c);
    expect((await work("leadA", pid, { assignees: [ACTORS.empA1.id], deliverable_id: existing,
      new_deliverable: { deliverable_type_id: dtype } })).status).toBe(400);
    expect((await work("leadA", pid, { assignees: [ACTORS.empA1.id],
      new_deliverable: { deliverable_type_id: 999999 } })).status).toBe(400);
    expect((await work("leadA", pid, { assignees: [ACTORS.empA1.id],
      new_deliverable: { deliverable_type_id: dtype, drive_url: "https://example.com/x" } })).status).toBe(400);
    // The Coordinator routes and never assigns; empB1 is not on this project.
    expect((await work("coord", pid, { assignees: [ACTORS.empA1.id],
      new_deliverable: { deliverable_type_id: dtype } })).status).toBe(403);
    expect((await work("empB1", pid, { assignees: [ACTORS.empB1.id],
      new_deliverable: { deliverable_type_id: dtype } })).status).toBe(403);
    expect(Number((await one(`SELECT COUNT(*)::int c FROM mo_deliverables WHERE project_id=$1`, [pid])).c)).toBe(before);
  });

  it("takes on a deliverable already on the project — the Coordinator's — instead of making another", async () => {
    const { pid, dids } = await routed(teamA, ["Archive Data"]);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA1.id,
      deliverable_id: dids[0] });
    expect(r.status).toBe(201);
    expect((await deliv(dids[0])).owner_id).toBe(ACTORS.empA1.id);
    expect(Number((await one(`SELECT COUNT(*)::int c FROM mo_deliverables WHERE project_id=$1`, [pid])).c)).toBe(1);
    expect((await teamRow(dids[0]))[0].users).toEqual([ACTORS.empA1.id, ACTORS.empA2.id].sort());
    // A delivered one cannot take new work.
    await pool.query(`UPDATE mo_deliverables SET status='delivered' WHERE id=$1`, [dids[0]]);
    expect((await work("leadA", pid, { assignees: [ACTORS.empA1.id], deliverable_id: dids[0] })).status).toBe(400);
  });

  it("a teammate submits a version; the lead reviews; everyone on it hears the verdict", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id],
      new_deliverable: { deliverable_type_id: dtype, title: "Team reel" } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    expect((await as("empA2", "POST", `/deliverables/${did}/versions`, drive("team1"))).status).toBe(201);
    expect((await notes(ACTORS.leadA.id, "deliverable", did)).map((x) => x.title)).toContain("Version submitted for review");
    // Nobody on it reviews it — the owner, nor the teammate who did not submit.
    expect((await as("empA1", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "changes_requested", comment: "tighter" })).status).toBe(200);
    for (const who of [ACTORS.empA1.id, ACTORS.empA2.id])
      expect((await notes(who, "deliverable", did)).map((x) => x.title)).toContain("Changes requested on Team reel");
    // Either of them resubmits; the owner moves it on the board too.
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("team2"))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    expect((await deliv(did)).dispatch_status).toBe("queued");
  });

  it("a lead who puts themselves on the work cannot review it; the Admins are asked instead", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.leadA.id], owner_id: ACTORS.empA1.id,
      new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("lt1"));
    expect((await notes(ACTORS.leadA.id, "deliverable", did)).map((x) => x.title)).not.toContain("Version submitted for review");
    expect((await notes(ACTORS.admin.id, "deliverable", did)).map((x) => x.title)).toContain("Version submitted for review");
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(403);
    expect((await as("admin", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("someone not on it still cannot submit — and an old drawer row grants nothing", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id], new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    expect((await as("empA2", "POST", `/deliverables/${did}/versions`, drive("no1"))).status).toBe(403);
    // A linked row that does not name the owner — what the old drawer wrote.
    const legacy = await one(
      `INSERT INTO mo_assignments (project_id, deliverable_id, title, assigned_by, status, work_type_id)
       VALUES ($1,$2,'legacy',$3,'not_started',$4) RETURNING id`, [pid, did, ACTORS.leadA.id, workTypeId]);
    await pool.query(`INSERT INTO mo_assignment_users (assignment_id, user_id) VALUES ($1,$2)`, [legacy.id, ACTORS.empA2.id]);
    expect((await as("empA2", "POST", `/deliverables/${did}/versions`, drive("no2"))).status).toBe(403);
    expect((await as("empA2", "POST", `/deliverables/${did}/status`, { status: "in_progress" })).status).toBe(403);
  });

  it("changing the owner keeps the rest of the team on it, and takes the outgoing owner off", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA1.id,
      new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    expect((await as("leadA", "PATCH", `/deliverables/${did}`,
      { owner_id: ACTORS.leadA.id, confirm_reassign: true })).status).toBe(200);
    expect((await teamRow(did))[0].users).toEqual([ACTORS.empA2.id, ACTORS.leadA.id].sort());
    expect((await as("empA2", "POST", `/deliverables/${did}/versions`, drive("keep"))).status).toBe(201);
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("gone"))).status).toBe(403);
    expect((await notes(ACTORS.empA1.id, "deliverable", did)).map((x) => x.title)).toContain("Assignment reassigned");
  });

  it("the drawer lists the owner and who they work with", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA1.id,
      new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    const a = await as("leadA", "GET", `/deliverables/${did}/assignees`);
    expect((a.body.crew as Record<string, unknown>).user_id).toBe(ACTORS.empA1.id);
    expect((a.body.team as Array<Record<string, unknown>>).map((t) => t.user_id)).toEqual([ACTORS.empA2.id]);
  });

  it("an employee creates their own project for themselves, then assigns work on it to anyone", async () => {
    // Creating: the project is theirs alone — naming someone else is refused.
    const named = await as("empA1", "POST", "/projects", {
      name: `${PX} my reel ${Math.random().toString(36).slice(2, 7)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10",
      deliverables: [{ title: "x", deliverable_type_id: dtype, owner_id: ACTORS.empA2.id }] });
    expect(named.status).toBe(403);
    const mine = await as("empA1", "POST", "/projects", {
      name: `${PX} my reel ${Math.random().toString(36).slice(2, 7)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10" });
    const pid = Number((mine.body.project as Record<string, unknown>).id);
    // Assigning on it: anyone in the crew, another team included.
    const ok = await work("empA1", pid, { assignees: [ACTORS.empA1.id, ACTORS.empB1.id], owner_id: ACTORS.empB1.id,
      new_deliverable: { deliverable_type_id: dtype } });
    expect(ok.status).toBe(201);
    const did = Number((ok.body.deliverable as Record<string, unknown>).id);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empB1.id);
    expect((await teamRow(did))[0].users).toEqual([ACTORS.empA1.id, ACTORS.empB1.id].sort());
    // Someone not on the project still cannot.
    expect((await work("empA2", pid, { assignees: [ACTORS.empA2.id], new_deliverable: { deliverable_type_id: dtype } })).status).toBe(403);
  });

  it("plain work with no deliverable still works, and names no owner", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id] });
    expect(r.status).toBe(201);
    expect(r.body.deliverable).toBe(null);
    expect((r.body.assignment as Record<string, unknown>).deliverable_id).toBe(null);
  });
});

/* ── NOTIFICATIONS: what the bell gets, who is told, and only once ──────────
   A notice is only useful if tapping it opens something (numeric ids), if it
   reaches the people who have to act, and if nobody is told twice. */

maybe("notifications — payload, recipients, no duplicates", () => {
  const work = (actor: ActorName, pid: number, extra: Record<string, unknown>) =>
    as(actor, "POST", `/projects/${pid}/work`, { work_type_id: workTypeId, title: `${PX} notice work`, ...extra });
  /** A Team A deliverable made by Assign work: empA1 owns it, empA2 is on its team. */
  async function teamed() {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA1.id,
      new_deliverable: { deliverable_type_id: dtype } });
    return { pid, did: Number((r.body.deliverable as Record<string, unknown>).id) };
  }
  const titles = async (actor: ActorName, entityType: string, id: number) =>
    (await notes(ACTORS[actor].id, entityType, id)).map((n) => String(n.title));
  const admins = async () => (await pool.query(
    `SELECT id FROM users WHERE team='media' AND role IN ('admin','super_admin')`)).rows.map((r) => String(r.id));
  /* The Admins there both before and after an act: suites running alongside
     add and remove their own Admins, and one added after it (or gone before
     the check) was never going to show the notice. */
  const adminsAround = async (act: () => Promise<void>) => {
    const before = await admins();
    await act();
    const after = new Set(await admins());
    return before.filter((a) => after.has(a));
  };

  it("the bell gets numeric ids, the project's name and the true unread count", async () => {
    const { pid, did } = await teamed();
    const g = await as("empA2", "GET", "/notifications");
    expect(g.status).toBe(200);
    const row = (g.body.notifications as Array<Record<string, unknown>>).find((n) => n.entity_id === did);
    expect(row, "the Assign work notice, with a numeric entity_id").toBeTruthy();
    expect(typeof row!.id).toBe("number");
    expect(row!.project_name).toBe(String((await project(pid)).name));
    expect(row!.project_id, "so an unloaded deliverable can still open its project").toBe(Number(pid));
    const unread = Number((await one(
      `SELECT COUNT(*)::int c FROM mo_notifications WHERE user_id=$1 AND NOT is_read`, [ACTORS.empA2.id])).c);
    expect(g.body.unread).toBe(unread);
    const s = await as("empA2", "GET", "/state");
    expect(s.body.notifications_unread).toBe(unread);
    const sr = (s.body.notifications as Array<Record<string, unknown>>).find((n) => n.entity_id === did);
    expect(typeof sr?.id).toBe("number");
  });

  it("shoot work from Assign work tells its crew and puts them on the project crew", async () => {
    const st = await one(`SELECT id FROM mo_work_types WHERE is_active AND archived_at IS NULL AND form_template='shoot' ORDER BY id LIMIT 1`);
    const { pid } = await routed(teamA, []);
    const r = await as("leadA", "POST", `/projects/${pid}/work`, { work_type_id: st.id, title: `${PX} convocation shoot`,
      shoot_date: "2026-10-06", crew: [ACTORS.empA1.id, ACTORS.empB1.id] });
    expect(r.status).toBe(201);
    const sid = Number((r.body.shoot as Record<string, unknown>).id);
    for (const who of ["empA1", "empB1"] as const) {
      expect(await titles(who, "shoot", sid), who).toEqual(["You are on a shoot"]);
      expect((await one(`SELECT 1 AS ok FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`,
        [pid, ACTORS[who].id]))?.ok, `${who} on the crew`).toBe(1);
    }
  });

  it("crew and shoot-crew assigns tell only the people newly added", async () => {
    const { pid } = await routed(teamA, []);
    for (let i = 0; i < 2; i++)
      expect((await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA2.id })).status).toBe(201);
    expect(await titles("empA2", "project", pid)).toEqual(["You are on a project"]);
    const shoot = await one(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, location, status, created_by)
       VALUES ($1,$2,'2026-10-07','Lawn','planned',$3) RETURNING id`, [pid, `${PX} lawn shoot`, ACTORS.leadA.id]);
    await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA1.id] });
    const again = await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA1.id, ACTORS.empA2.id] });
    expect(again.body.added).toBe(1);
    expect(await titles("empA1", "shoot", Number(shoot.id))).toEqual(["You are on a shoot"]);
    expect(await titles("empA2", "shoot", Number(shoot.id))).toEqual(["You are on a shoot"]);
  });

  it("an owner named while creating the project is told, as Assign work tells them", async () => {
    const r = await as("leadA", "POST", "/projects", {
      name: `${PX} owners named ${Math.random().toString(36).slice(2, 7)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA,
      deliverables: [{ title: "Edited Photos", deliverable_type_id: dtype, owner_id: ACTORS.empA1.id }] });
    expect(r.status).toBe(201);
    const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1`,
      [Number((r.body.project as Record<string, unknown>).id)])).id);
    expect(await titles("empA1", "deliverable", did)).toEqual(["New assignment"]);
  });

  it("a version the project's own lead submits goes to the Admins, never back to that lead", async () => {
    const { did } = await teamed();
    const told = await adminsAround(async () => {
      expect((await as("leadA", "POST", `/deliverables/${did}/versions`, drive("lead-push"))).status).toBe(201);
    });
    expect(await titles("leadA", "deliverable", did)).toEqual([]);
    for (const a of told)
      expect((await notes(a, "deliverable", did)).map((n) => n.title), a).toContain("Version submitted for review");
  });

  it("marking it delivered asks the project's lead to sign off — the Admins when the lead delivered it", async () => {
    const { did } = await teamed();
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("d1"));
    await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    expect((await as("empA2", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(200);
    expect(await titles("leadA", "deliverable", did)).toContain("Deliverable delivered — needs review");
    expect(await titles("empA1", "deliverable", did)).not.toContain("Deliverable delivered — needs review");

    const second = await teamed();
    await as("empA1", "POST", `/deliverables/${second.did}/versions`, drive("d2"));
    await as("leadB", "POST", `/deliverables/${second.did}/review`, { outcome: "approved" });
    const told = await adminsAround(async () => {
      expect((await as("leadA", "POST", `/deliverables/${second.did}/deliver`, {})).status).toBe(200);
    });
    expect(await titles("leadA", "deliverable", second.did)).not.toContain("Deliverable delivered — needs review");
    for (const a of told)
      expect((await notes(a, "deliverable", second.did)).map((n) => n.title), a).toContain("Deliverable delivered — needs review");
  });

  it("a sign-off reaches the whole team, and a send-back must say what to change and carries it", async () => {
    const { did } = await teamed();
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("s1"));
    await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    await as("empA1", "POST", `/deliverables/${did}/deliver`, {});
    const bare = await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "changes_requested", note: "  " });
    expect([bare.status, bare.body.message]).toEqual([400, "Say what needs to change."]);
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`,
      { approval_status: "changes_requested", note: "Tighten the opening" })).status).toBe(200);
    for (const who of ["empA1", "empA2"] as const)
      expect(await titles(who, "deliverable", did), who).toContain("Changes requested");
    const body = (await one(`SELECT body FROM mo_notifications WHERE user_id=$1 AND entity_id=$2 AND title='Changes requested'
                              ORDER BY id DESC LIMIT 1`, [ACTORS.empA2.id, did])).body;
    expect(String(body)).toContain("Tighten the opening");
    // The version it was approved on is sent back, with the note, so My Day shows it.
    const v = await one(`SELECT review_status, review_comment FROM mo_deliverable_versions WHERE deliverable_id=$1
                          ORDER BY version_no DESC LIMIT 1`, [did]);
    expect([v.review_status, v.review_comment]).toEqual(["changes_requested", "Tighten the opening"]);
    expect((await deliv(did)).status).toBe("changes_requested");

    // Approving after delivery tells the whole team too.
    await as("empA2", "POST", `/deliverables/${did}/versions`, drive("s2"));
    await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    await as("empA2", "POST", `/deliverables/${did}/deliver`, {});
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
    for (const who of ["empA1", "empA2"] as const)
      expect(await titles(who, "deliverable", did), who).toContain("Deliverable approved");
  });

  it("dispatch tells everyone on the deliverable", async () => {
    const { did } = await teamed();
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("x"));
    await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "Dean's office" })).status).toBe(200);
    for (const who of ["empA1", "empA2"] as const)
      expect(await titles(who, "deliverable", did), who).toContain("Your deliverable was dispatched");
  });

  /* Q10: a reassignment always tells the old owner who has it now — handed to
     a teammate, it also says they are still on the team, never that the work
     is no longer theirs. */
  it("handing ownership to a teammate tells the old owner who has it, and that they remain on its team", async () => {
    const { pid, did } = await teamed();
    const r = await work("leadA", pid, { assignees: [ACTORS.empA2.id, ACTORS.empA1.id], owner_id: ACTORS.empA2.id,
      deliverable_id: did, confirm_reassign: true });
    expect(r.status).toBe(201);
    expect((await deliv(did)).owner_id).toBe(ACTORS.empA2.id);
    const told = (await pool.query(`SELECT body FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable'
                                       AND entity_id=$2 AND title='Assignment reassigned'`, [ACTORS.empA1.id, did])).rows;
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain(ACTORS.empA2.full_name);
    expect(told[0].body).toContain("You remain on its team.");
    expect(told[0].body).not.toContain("no longer assigned to you");
  });

  it("the review reminder waits for its threshold instead of following the submission notice", async () => {
    const rule = await one(`SELECT is_enabled FROM mo_automation_rules WHERE rule_key='AUTO-4'`);
    if (rule && !rule.is_enabled) return;
    const { runMediaOpsAutomations } = await import("./mediaops-api.js");
    const { did } = await teamed();
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("r1"));
    await runMediaOpsAutomations();
    expect(await titles("leadA", "deliverable", did)).toEqual(["Version submitted for review"]);
    await pool.query(`UPDATE mo_deliverable_versions SET submitted_at = NOW() - INTERVAL '25 hours' WHERE deliverable_id=$1`, [did]);
    await runMediaOpsAutomations();
    expect(await titles("leadA", "deliverable", did)).toContain("Awaiting your review");
  });

  it("someone on a deliverable's team who is off the crew still reads its comment thread", async () => {
    const { pid, did } = await teamed();
    await pool.query(`UPDATE mo_project_assignments SET removed_at=NOW() WHERE project_id=$1 AND user_id=$2`,
      [pid, ACTORS.empA2.id]);
    await pool.query(`INSERT INTO mo_comments (entity_type, entity_id, user_id, body) VALUES ('deliverable',$1,$2,$3)`,
      [did, ACTORS.leadA.id, `${PX} trim the intro`]);
    const s = await as("empA2", "GET", "/state");
    const bodies = (s.body.comments as Array<Record<string, unknown>>).map((c) => c.body);
    expect(bodies).toContain(`${PX} trim the intro`);
  });
});

/* ── The status machine: one road into review, and closed work stays closed ── */

maybe("status moves — a version is the only way into review, and closed work is not reviewed", () => {
  const versionOf = (did: number) => one(
    `SELECT review_status, review_comment FROM mo_deliverable_versions WHERE deliverable_id=$1 ORDER BY version_no DESC LIMIT 1`, [did]);

  it("/status cannot put work in review; submitting a version does", async () => {
    const { did } = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${did}/status`, { status: "in_progress" });
    for (const who of ["empA1", "leadA"] as const) {
      const r = await as(who, "POST", `/deliverables/${did}/status`, { status: "in_review" });
      expect(r.status, who).toBe(400);
      expect(r.body.message).toBe("Submit a version to send it for review.");
    }
    expect((await deliv(did)).status).toBe("in_progress");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("ir1"))).status).toBe(201);
    expect((await deliv(did)).status).toBe("in_review");
  });

  it("/status answers who may before whether the move is valid", async () => {
    const { did } = await ownedBy("empA1");
    // not_started → in_review / approved are invalid moves; these callers have no say at all.
    expect((await as("empB1", "POST", `/deliverables/${did}/status`, { status: "in_review" })).status).toBe(403);
    expect((await as("coord", "POST", `/deliverables/${did}/status`, { status: "approved" })).status).toBe(403);
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "approved" })).status).toBe(403);
    expect((await deliv(did)).status).toBe("not_started");
  });

  it("a send-back through /status carries its comment to the version and the team", async () => {
    const { did } = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("cr1"));
    const r = await as("leadB", "POST", `/deliverables/${did}/status`, { status: "changes_requested", comment: "Fix the colour grade" });
    expect(r.status).toBe(200);
    expect(await versionOf(did)).toEqual({ review_status: "changes_requested", review_comment: "Fix the colour grade" });
    const n = await one(`SELECT body FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2
                          AND title LIKE 'Changes requested%'`, [ACTORS.empA1.id, did]);
    expect(String(n?.body)).toContain("Fix the colour grade");
  });

  it("cancelled, not-required and delivered work is not reviewed, and leaves the reviews count", async () => {
    const { did } = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("cl1"));
    const reviews = async () => Number(((await as("admin", "GET", `/crew/${ACTORS.empA1.id}/impact`)).body
      .active as Record<string, unknown>).reviews);
    const before = await reviews();
    // The project's lead cancels it while the version is still pending.
    expect((await as("leadA", "POST", `/deliverables/${did}/status`, { status: "cancelled" })).status).toBe(200);
    expect(await reviews()).toBe(before - 1);
    for (const closed of ["cancelled", "not_required", "delivered"]) {
      await pool.query(`UPDATE mo_deliverables SET status=$1, dispatch_status='none' WHERE id=$2`, [closed, did]);
      for (const outcome of ["approved", "changes_requested"]) {
        expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome, comment: "x" })).status, `${closed} /review ${outcome}`).toBe(400);
        expect((await as("leadB", "POST", `/deliverables/${did}/status`, { status: outcome, comment: "x" })).status, `${closed} /status ${outcome}`).toBe(400);
      }
      const after = await deliv(did);
      expect([after.status, after.dispatch_status], closed).toEqual([closed, "none"]);
    }
    expect((await versionOf(did)).review_status).toBe("pending");
  });

  it("a post-delivery send-back needs a note; the whole team hears the sign-off", async () => {
    const { pid } = await routed(teamA, []);
    const w = await as("leadA", "POST", `/projects/${pid}/work`, { work_type_id: workTypeId, title: `${PX} cut`,
      assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA1.id, new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((w.body.deliverable as Record<string, unknown>).id);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("so1"));
    await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    await as("empA1", "POST", `/deliverables/${did}/deliver`, {});
    for (const to of ["changes_requested", "rejected"]) {
      const r = await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: to, note: "  " });
      expect([r.status, r.body.message], to).toEqual([400, "Say what needs to change."]);
    }
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
    for (const who of ["empA1", "empA2"] as const)
      expect((await notes(ACTORS[who].id, "deliverable", did)).map((n) => n.title), who).toContain("Deliverable approved");
  });
});

/* ── Boards: a linked card moves its deliverable only as /status would ───── */

maybe("PATCH /cards/:id — Team Leads and Admins only, and a synced move obeys the review rules", () => {
  let board = 0, approvedCol = 0, restartCol = 0, plainCol = 0;
  const card = async (did: number) => Number((await one(
    `INSERT INTO mo_cards (board_id, column_id, title, linked_entity_type, linked_entity_id, created_by)
     VALUES ($1,$2,$3,'deliverable',$4,$5) RETURNING id`, [board, plainCol, `${PX} card`, did, ACTORS.leadA.id])).id);
  const columnOf = async (cid: number) => Number((await one(`SELECT column_id FROM mo_cards WHERE id=$1`, [cid])).column_id);

  beforeAll(async () => {
    board = Number((await one(`INSERT INTO mo_boards (name, is_management, sync_status, created_by)
                               VALUES ($1, true, true, $2) RETURNING id`, [`${PX} War Room`, ACTORS.leadA.id])).id);
    const col = async (name: string, maps: string | null, i: number) => Number((await one(
      `INSERT INTO mo_board_columns (board_id, name, sort_order, maps_to_status) VALUES ($1,$2,$3,$4) RETURNING id`,
      [board, name, i, maps])).id);
    plainCol = await col("Inbox", null, 0);
    restartCol = await col("To arrange", "not_started", 1);
    approvedCol = await col("Confirmed", "approved", 2);
  });

  it("an employee or the Coordinator cannot move a card", async () => {
    const { did } = await ownedBy("empA1");
    const cid = await card(did);
    for (const who of ["empA1", "coord"] as const)
      expect((await as(who, "PATCH", `/cards/${cid}`, { column_id: approvedCol })).status, who).toBe(403);
    expect(await columnOf(cid)).toBe(plainCol);
    expect((await deliv(did)).status).toBe("not_started");
  });

  it("dragging to an approved column is the review: refused for the team, and without a version", async () => {
    const bare = await ownedBy("empA1");
    const bareCard = await card(bare.did);
    expect((await as("leadB", "PATCH", `/cards/${bareCard}`, { column_id: approvedCol })).status).toBe(400);
    expect([await columnOf(bareCard), (await deliv(bare.did)).status]).toEqual([plainCol, "not_started"]);

    const own = await ownedBy("leadB");
    await as("leadB", "POST", `/deliverables/${own.did}/versions`, drive("cd1"));
    const ownCard = await card(own.did);
    expect((await as("leadB", "PATCH", `/cards/${ownCard}`, { column_id: approvedCol })).status).toBe(403);
    expect([await columnOf(ownCard), (await deliv(own.did)).status]).toEqual([plainCol, "in_review"]);

    const r = await as("leadA", "PATCH", `/cards/${ownCard}`, { column_id: approvedCol });
    expect([r.status, r.body.synced]).toEqual([200, "approved"]);
    const d = await deliv(own.did);
    expect([await columnOf(ownCard), d.status, d.dispatch_status]).toEqual([approvedCol, "approved", "queued"]);
  });

  it("an invalid move is refused and the card stays; an unmapped column just moves the card", async () => {
    const { did } = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("cd2"));
    const cid = await card(did);
    expect((await as("leadA", "PATCH", `/cards/${cid}`, { column_id: restartCol })).status).toBe(400);
    expect([await columnOf(cid), (await deliv(did)).status]).toEqual([plainCol, "in_review"]);
    const r = await as("leadA", "PATCH", `/cards/${cid}`, { column_id: plainCol, title: `${PX} renamed` });
    expect([r.status, r.body.synced]).toEqual([200, null]);
  });
});

/* ── Projects: create, edit, re-route, crew, activity ─────────────────────── */

maybe("projects — creating, editing and re-routing follow the rules", () => {
  const fresh = (actor: ActorName, extra: Record<string, unknown> = {}) => as(actor, "POST", "/projects", {
    name: `${PX} rules ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
    start_date: "2026-10-01", end_date: "2026-10-10", ...extra });
  const pidOf = (r: { body: Record<string, unknown> }) => Number((r.body.project as Record<string, unknown>).id);
  const pmOf = (pid: number) => pool.query(
    `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager AND removed_at IS NULL`,
    [pid]).then((r) => r.rows.map((x) => x.user_id));

  it("a Coordinator must say which team the project is for", async () => {
    const r = await fresh("coord");
    expect([r.status, r.body.message]).toEqual([400, "Choose the team this project is for."]);
    expect((await fresh("coord", { team_id: teamA })).status).toBe(201);
  });

  it("the academic year picked is the one stored, and duplicates are per year", async () => {
    const past = Number((await one(
      `INSERT INTO mo_academic_years (label, start_date, end_date, is_current)
       VALUES ('${PX} 2019-20','2019-06-01','2020-05-31',false) RETURNING id`)).id);
    const name = `${PX} same name ${Math.random().toString(36).slice(2, 8)}`;
    const r = await fresh("coord", { name, team_id: teamA, academic_year_id: past });
    expect(r.status).toBe(201);
    expect(Number((await project(pidOf(r))).academic_year_id)).toBe(past);
    // The same project in the current year is not a duplicate of last year's.
    const now = await fresh("coord", { name, team_id: teamA });
    expect(now.status).toBe(201);
    expect(Number((await project(pidOf(now))).academic_year_id)).not.toBe(past);
    expect((await fresh("coord", { name, team_id: teamA, academic_year_id: past })).status).toBe(409);
    expect((await fresh("coord", { team_id: teamA, academic_year_id: 99999999 })).status).toBe(400);
  });

  it("a priority outside urgent, high, normal and low is a 400 everywhere, never a 500", async () => {
    const msg = "Priority must be urgent, high, normal or low.";
    const bad = { priority: "medium" };
    expect([(await fresh("coord", { team_id: teamA, ...bad })).body.message]).toEqual([msg]);
    expect((await fresh("coord", { team_id: teamA,
      deliverables: [{ title: "Edited Photos", deliverable_type_id: dtype, ...bad }] })).status).toBe(400);
    const { pid, dids } = await routed(teamA);
    const patch = await as("leadA", "PATCH", `/projects/${pid}`, bad);
    expect([patch.status, patch.body.message]).toEqual([400, msg]);
    expect((await as("leadA", "PATCH", `/projects/${pid}`, { priority: null })).status).toBe(400);
    expect((await as("leadA", "PATCH", `/deliverables/${dids[0]}`, bad)).status).toBe(400);
    expect((await as("leadA", "POST", `/projects/${pid}/work`, { work_type_id: workTypeId,
      title: `${PX} work`, assignees: [ACTORS.empA1.id], ...bad })).status).toBe(400);
    expect((await as("leadA", "PATCH", `/projects/${pid}`, { priority: "urgent" })).status).toBe(200);
    expect((await project(pid)).priority).toBe("urgent");
  });

  it("re-routing: the Coordinator or an Admin moves it, the new lead takes over and is told", async () => {
    const { pid } = await routed(teamA);
    expect((await as("leadA", "PATCH", `/projects/${pid}`, { team_id: teamB })).status).toBe(403);
    expect((await as("coord", "PATCH", `/projects/${pid}`, { team_id: teamB })).status).toBe(200);
    const p = await project(pid);
    expect([Number(p.team_id), p.owner_id]).toEqual([teamB, ACTORS.leadB.id]);
    expect(await pmOf(pid)).toEqual([ACTORS.leadB.id]);
    expect((await notes(ACTORS.leadB.id, "project", pid)).map((n) => n.title)).toContain("You are leading a project");
    expect((await as("admin", "PATCH", `/projects/${pid}`, { team_id: teamA })).status).toBe(200);
    expect(await pmOf(pid)).toEqual([ACTORS.leadA.id]);
    // Moving it is not un-routing it.
    expect((await as("coord", "PATCH", `/projects/${pid}`, { team_id: null })).status).toBe(400);
    expect(Number((await project(pid)).team_id)).toBe(teamA);
  });

  it("an employee's own project: every deliverable on it is theirs", async () => {
    const r = await fresh("empA1", { deliverables: [
      { title: "Edited Photos", deliverable_type_id: dtype }, { title: "Edited Photos (2)", deliverable_type_id: dtype }] });
    expect(r.status).toBe(201);
    const owners = (await pool.query(`SELECT owner_id FROM mo_deliverables WHERE project_id=$1`, [pidOf(r)])).rows;
    expect(owners.map((o) => o.owner_id)).toEqual([ACTORS.empA1.id, ACTORS.empA1.id]);
  });

  it("deliverable types reach the client in the order the Admin set", async () => {
    const r = await as("admin", "GET", "/state");
    const types = (r.body.deliverable_types as Array<{ id: number | string; sort_order: number }>)
      .map((t) => [Number(t.sort_order ?? 0), Number(t.id)]);
    const sorted = [...types].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    expect(types).toEqual(sorted);
  });
});

maybe("project crew — adding people, and who may name a PM", () => {
  const pmOf = (pid: number) => pool.query(
    `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager AND removed_at IS NULL`,
    [pid]).then((r) => r.rows.map((x) => x.user_id));
  const onCrew = (pid: number, uid: string) => one(
    `SELECT 1 AS ok FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`, [pid, uid]);

  it("another team's lead and a crew employee add people, but cannot make anyone the PM", async () => {
    const { pid } = await routed(teamA);
    // A project with no PM is the case where a forged flag would have stuck.
    await pool.query(`UPDATE mo_project_assignments SET is_project_manager=false WHERE project_id=$1`, [pid]);
    expect((await as("leadB", "POST", `/projects/${pid}/assignments`,
      { user_id: ACTORS.leadB.id, is_project_manager: true })).status).toBe(403);
    const add = await as("leadB", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA1.id });
    expect([add.status, add.body.added]).toEqual([201, true]);
    expect((await as("empA1", "POST", `/projects/${pid}/assignments`,
      { user_id: ACTORS.empA2.id, is_project_manager: true })).status).toBe(403);
    expect(await pmOf(pid)).toEqual([]);
    expect(await onCrew(pid, ACTORS.empA2.id)).toBeUndefined();
    // The project's own lead may name one.
    const ok = await as("leadA", "POST", `/projects/${pid}/assignments`,
      { user_id: ACTORS.empA2.id, is_project_manager: true });
    expect(ok.status).toBe(201);
    expect(await pmOf(pid)).toEqual([ACTORS.empA2.id]);
    expect((await notes(ACTORS.empA2.id, "project", pid)).map((n) => n.title)).toEqual(["You are the PM on a project"]);
  });

  it("a second PM is refused out loud: nobody added, nobody told", async () => {
    const { pid } = await routed(teamA);
    const r = await as("leadA", "POST", `/projects/${pid}/assignments`,
      { user_id: ACTORS.empA1.id, is_project_manager: true });
    expect(r.status).toBe(409);
    expect(await pmOf(pid)).toEqual([ACTORS.leadA.id]);
    expect(await onCrew(pid, ACTORS.empA1.id)).toBeUndefined();
    expect(await notes(ACTORS.empA1.id, "project", pid)).toEqual([]);
  });
});

maybe("project activity — only this project's history, with who did it", () => {
  it("each kind of record is matched against its own ids", async () => {
    const { pid, dids } = await routed(teamA);
    const other = await routed(teamB);
    // An event on ANOTHER project's shoot/assignment whose id happens to equal this project's deliverable id.
    for (const t of ["shoot", "assignment"])
      await pool.query(
        `INSERT INTO mo_audit_logs (actor_id, action, entity_type, entity_id, after)
         VALUES ($1,$2,$3,$4,$5)`, [ACTORS.admin.id, `${t}.probe`, t, dids[0], JSON.stringify({ project: other.pid })]);
    await pool.query(
      `INSERT INTO mo_audit_logs (actor_id, action, entity_type, entity_id) VALUES ($1,'deliverable.probe','deliverable',$2)`,
      [ACTORS.leadA.id, dids[0]]);
    const r = await as("leadA", "GET", `/projects/${pid}/activity`);
    expect(r.status).toBe(200);
    const rows = r.body.activity as Array<{ action: string; actor: string | null }>;
    const actions = rows.map((x) => x.action);
    expect(actions).toContain("deliverable.probe");
    expect(actions).toContain("project.created");
    expect(actions).not.toContain("shoot.probe");
    expect(actions).not.toContain("assignment.probe");
    expect(rows.find((x) => x.action === "project.created")?.actor).toBe(ACTORS.coord.full_name);
    expect(rows.find((x) => x.action === "deliverable.probe")?.actor).toBe(ACTORS.leadA.full_name);
  });
});

maybe("assign work on an existing deliverable, delivering, dispatch and archive", () => {
  const work = (actor: ActorName, pid: number, extra: Record<string, unknown>) =>
    as(actor, "POST", `/projects/${pid}/work`, { work_type_id: workTypeId, title: `${PX} cut the reel`, ...extra });
  const onCrew = (pid: number, uid: string) => one(
    `SELECT 1 AS ok FROM mo_project_assignments WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`, [pid, uid]);
  const teamOf = (did: number) => pool.query(
    `SELECT DISTINCT au.user_id FROM mo_assignments a JOIN mo_assignment_users au ON au.assignment_id=a.id
      WHERE a.deliverable_id=$1 AND a.status<>'cancelled' ORDER BY au.user_id`, [did]).then((r) => r.rows.map((x) => x.user_id));

  it("an existing deliverable takes the work's due date, and the answer is the deliverable as stored", async () => {
    const { pid, dids } = await routed(teamA, ["Archive Data"]);
    await pool.query(`UPDATE mo_deliverables SET due_date=NULL WHERE id=$1`, [dids[0]]);
    // Another team's lead may assign here; an empty date is filled by their work's date.
    const r = await work("leadB", pid, { assignees: [ACTORS.empB1.id], deliverable_id: dids[0], due_date: "2026-10-22" });
    expect(r.status).toBe(201);
    const body = r.body.deliverable as Record<string, unknown>;
    expect(body.owner_id).toBe(ACTORS.empB1.id);
    expect(body.due_date).not.toBeNull();
    expect(dayOf((await deliv(dids[0])).due_date)).toBe("2026-10-22");
    // …but a date already set moves only for someone who runs the project.
    expect((await work("leadB", pid, { assignees: [ACTORS.empB1.id], deliverable_id: dids[0],
      due_date: "2026-10-25" })).status).toBe(201);
    expect(dayOf((await deliv(dids[0])).due_date)).toBe("2026-10-22");
    expect((await work("leadA", pid, { assignees: [ACTORS.empB1.id], deliverable_id: dids[0],
      due_date: "2026-10-28" })).status).toBe(201);
    expect(dayOf((await deliv(dids[0])).due_date)).toBe("2026-10-28");
  });

  it("changing a work row's people keeps the owner on it, brings newcomers in once and tells who left", async () => {
    const { pid } = await routed(teamA, []);
    const r = await work("leadA", pid, { assignees: [ACTORS.empA1.id, ACTORS.empA2.id], owner_id: ACTORS.empA1.id,
      new_deliverable: { deliverable_type_id: dtype } });
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    const aid = Number((r.body.assignment as Record<string, unknown>).id);
    // Leaving the owner out would dissolve the team: refused, nothing changes.
    const bad = await as("leadA", "PATCH", `/assignments/${aid}`, { assignees: [ACTORS.empA2.id] });
    expect([bad.status, String(bad.body.message)]).toEqual([400, expect.stringContaining("owner must stay")]);
    expect(await teamOf(did)).toEqual([ACTORS.empA1.id, ACTORS.empA2.id].sort());

    expect((await as("leadA", "PATCH", `/assignments/${aid}`,
      { assignees: [ACTORS.empA1.id, ACTORS.empB1.id, ACTORS.empB1.id] })).status).toBe(200);
    expect(await teamOf(did)).toEqual([ACTORS.empA1.id, ACTORS.empB1.id].sort());
    expect(await onCrew(pid, ACTORS.empB1.id)).toBeTruthy();
    expect((await notes(ACTORS.empB1.id, "deliverable", did)).map((n) => n.title)).toEqual(["New assignment"]);
    expect((await notes(ACTORS.empA2.id, "deliverable", did)).map((n) => n.title)).toContain("Assignment reassigned");
    // The owner, who stayed, hears nothing new.
    expect((await notes(ACTORS.empA1.id, "deliverable", did)).map((n) => n.title))
      .not.toContain("Assignment reassigned");
  });

  it("delivering while a version awaits review says so", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("p10"))).status).toBe(201);
    const r = await as("empA1", "POST", `/deliverables/${did}/deliver`, {});
    expect([r.status, String(r.body.message)]).toEqual([400, expect.stringContaining("awaiting review")]);
  });

  it("a delivered review-exempt deliverable is dispatched and archived without a version", async () => {
    if (!exemptType) return;
    const { did } = await ownedBy("empA1");
    await pool.query(`UPDATE mo_deliverables SET deliverable_type_id=$1, status='in_progress' WHERE id=$2`, [exemptType, did]);
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(200);
    // Not dispatched yet: archiving says what is missing.
    const early = await as("coord", "POST", `/deliverables/${did}/archive`, {});
    expect([early.status, String(early.body.message)]).toEqual([400, expect.stringContaining("not been dispatched")]);
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "Library" })).status).toBe(200);
    expect((await as("coord", "POST", `/deliverables/${did}/archive`, {})).status).toBe(200);
    const again = await as("coord", "POST", `/deliverables/${did}/archive`, {});
    expect([again.status, again.body.message]).toEqual([400, "This deliverable is already archived."]);
    expect((await deliv(did)).dispatch_status).toBe("archived");
  });

  it("a review-exempt deliverable sent back after delivery is not dispatched", async () => {
    if (!exemptType) return;
    const { did } = await ownedBy("empA1");
    await pool.query(`UPDATE mo_deliverables SET deliverable_type_id=$1, status='in_progress' WHERE id=$2`, [exemptType, did]);
    await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" });
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`,
      { approval_status: "changes_requested", note: "Missing the second camera" })).status).toBe(200);
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "Library" })).status).toBe(400);
    expect((await deliv(did)).dispatch_status).toBe("none");
  });
});
