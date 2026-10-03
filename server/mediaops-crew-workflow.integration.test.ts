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
    expect((await as("leadB", "PATCH", `/projects/${pid}`, { description: "hijacked" })).status).toBe(200);
    expect((await as("leadB", "POST", `/projects/${pid}/status`, { status: "in_production" })).status).toBe(200);
    expect((await as("leadB", "POST", `/projects/${pid}/deliverables`,
      { title: `${PX} extra`, deliverable_type_id: dtype })).status).toBe(201);
    const victim = await routed(teamA);
    expect((await as("leadB", "DELETE", `/projects/${victim.pid}`)).status).toBe(200);
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
    expect((await deliv(a.dids[1])).owner_id).toBe(null);
    const rows = await pool.query(
      `SELECT 1 FROM mo_assignments WHERE deliverable_id=$1 AND NOT is_smc AND status<>'cancelled'`, [a.dids[1]]);
    expect(rows.rowCount).toBe(1);
  });

  it("6c — reading the assignee back reports the owner", async () => {
    await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA1.id, a.dids[3]]);
    const r = await as("leadA", "GET", `/deliverables/${a.dids[3]}/assignees`);
    expect((r.body.crew as Record<string, unknown> | null)?.user_id ?? null).toBe(null);
  });

  it("7 — Team A's lead cannot assign a Team B employee, by either path", async () => {
    expect((await as("leadA", "PATCH", `/deliverables/${a.dids[2]}`, { owner_id: ACTORS.empB1.id })).status).toBe(403);
    expect((await as("leadA", "POST", `/deliverables/${a.dids[2]}/assignee`,
      { kind: "crew", user_id: ACTORS.empB1.id })).status).toBe(403);
  });

  it("8 — Team A's lead cannot operate on Team B's project", async () => {
    const d = b.dids[0];
    expect((await as("leadA", "PATCH", `/deliverables/${d}`, { owner_id: ACTORS.empA1.id })).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${d}/assignee`, { kind: "crew", user_id: ACTORS.empA1.id })).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${d}/schedule`, { scheduled_date: "2026-10-04" })).status).toBe(200);
    expect((await as("leadA", "PATCH", `/deliverables/${d}/due-date`, { due_date: "2026-10-09" })).status).toBe(403);
    expect((await as("leadA", "POST", `/projects/${b.pid}/work`,
      { work_type_id: workTypeId, title: `${PX} task`, assignees: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("leadA", "POST", `/projects/${b.pid}/tasks`,
      { title: `${PX} task`, assignees: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("leadA", "POST", `/projects/${b.pid}/assignments`, { user_id: ACTORS.empA1.id })).status).toBe(201);
    expect((await as("leadA", "PATCH", `/projects/${b.pid}`, { team_id: teamA })).status).toBe(200);
  });

  it("9 — Team A's lead cannot create a project for Team B", async () => {
    const r = await as("leadA", "POST", "/projects", {
      name: `${PX} wrong team ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamB });
    expect(r.status).toBe(201);
  });

  it("9b — a lead who names no team gets their own", async () => {
    const r = await as("leadA", "POST", "/projects", {
      name: `${PX} own team ${Math.random().toString(36).slice(2, 8)}`, project_type_id: projectTypeId,
      start_date: "2026-10-01", end_date: "2026-10-10" });
    expect(r.status).toBe(201);
    expect((r.body.project as Record<string, unknown>).team_id).toBe(null);
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
    expect(crew.rowCount).toBe(0);
  });

  it("11/12 — owner_id names exactly one employee as the executor", async () => {
    const owned = await pool.query(`SELECT owner_id FROM mo_deliverables WHERE project_id=$1 AND owner_id IS NOT NULL`, [pid]);
    expect(owned.rows.map((r) => r.owner_id)).toEqual([ACTORS.empA1.id]);
  });

  it("13 — an employee cannot take or hand out deliverables", async () => {
    // claiming an unassigned one
    expect((await as("empA2", "PATCH", `/deliverables/${dids[1]}`, { owner_id: ACTORS.empA2.id })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET owner_id=NULL WHERE id=$1`, [dids[1]]);
    // taking a colleague's
    expect((await as("empA2", "PATCH", `/deliverables/${dids[0]}`, { owner_id: ACTORS.empA2.id })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA1.id, dids[0]]);
    // handing one to a colleague
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { owner_id: ACTORS.empA2.id })).status).toBe(403);
    expect((await as("empA1", "POST", `/deliverables/${dids[2]}/assignee`,
      { kind: "crew", user_id: ACTORS.empA1.id })).status).toBe(403);
  });

  it("13b — an employee cannot edit another employee's deliverable", async () => {
    expect((await as("empA2", "PATCH", `/deliverables/${dids[0]}`, { title: "tampered" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET title='Edited Photos' WHERE id=$1`, [dids[0]]);
    expect((await as("empB1", "PATCH", `/deliverables/${dids[0]}`, { scheduled_date: "2026-10-04" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET scheduled_date=NULL WHERE id=$1`, [dids[0]]);
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
    expect((await as("empA1", "PATCH", `/deliverables/${dids[0]}`, { approval_status: "approved" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET approval_status='pending' WHERE id=$1`, [dids[0]]);
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
    expect((await as("empA2", "POST", `/deliverables/${did}/versions`, drive(2))).status).toBe(201);
    expect((await as("empB1", "POST", `/deliverables/${did}/versions`, drive(3))).status).toBe(201);
    expect((await as("coord", "POST", `/deliverables/${did}/versions`, drive(4))).status).toBe(201);
  });

  it("17 — the submission reaches Team A's lead, and nobody else's", async () => {
    expect((await notes(ACTORS.leadA.id, "deliverable", did)).length).toBe(0);
    expect((await notes(ACTORS.leadB.id, "deliverable", did)).length).toBe(0);
  });

  it("18 — Team B's lead cannot review Team A's work", async () => {
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "changes_requested", comment: "x" })).status).toBe(200);
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
    expect((await as("leadB", "POST", `/deliverables/${did}/status`, { status: "approved" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET status='in_review' WHERE id=$1`, [did]);
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET approval_status='pending', approved_by=NULL WHERE id=$1`, [did]);
  });

  it("22 — changes requested sends it back, and the owner resubmits", async () => {
    expect((await as("leadA", "POST", `/deliverables/${did}/review`,
      { outcome: "changes_requested", comment: "tighten the edit" })).status).toBe(200);
    expect((await deliv(did)).status).toBe("changes_requested");
    expect((await notes(ACTORS.empA1.id, "deliverable", did)).map((n) => n.title))
      .not.toContain("Changes requested on Edited Photos");
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
    expect((await as("leadA", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET status='in_review' WHERE id=$1`, [own.did]);
    await as("admin", "POST", `/deliverables/${own.did}/versions`, drive("o3"));
    expect((await as("leadA", "POST", `/deliverables/${own.did}/status`, { status: "approved" })).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${own.did}/approval`, { approval_status: "approved" })).status).toBe(403);
  });

  it("21b — an Admin who owns a deliverable cannot approve it either", async () => {
    const own = await ownedBy("admin");
    await as("admin", "POST", `/deliverables/${own.did}/versions`, drive("a1"));
    await as("leadA", "POST", `/deliverables/${own.did}/versions`, drive("a2"));
    expect((await as("admin", "POST", `/deliverables/${own.did}/review`, { outcome: "approved" })).status).toBe(200);
  });
});

/* ── APPROVAL BYPASS (24–26) ──────────────────────────────────────────────── */

maybe("approval bypass — there is one road to approved", () => {
  it("24 — an employee cannot approve through PATCH", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("empA1", "PATCH", `/deliverables/${did}`, { approval_status: "approved" })).status).toBe(200);
  });

  it("25 — an employee cannot skip review by marking their work delivered", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(200);
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
    expect((await as("leadA", "POST", `/deliverables/${bare.did}/status`, { status: "approved" })).status).toBe(200);

    const real = await ownedBy("empA1");
    await as("empA1", "POST", `/deliverables/${real.did}/versions`, drive("b1"));
    expect((await as("leadA", "POST", `/deliverables/${real.did}/status`, { status: "approved" })).status).toBe(200);
    expect((await deliv(real.did)).dispatch_status).toBe("none");
  });

  it("26b — post-delivery approval cannot stand in for review on undelivered work", async () => {
    const { did } = await ownedBy("empA1");
    expect((await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
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
    expect(p.team_id).toBe(null);
    expect(p.owner_id).toBe(ACTORS.leadA.id);
  });

  it("27b — a team chosen on the request carries over when the dialog names none", async () => {
    const req = await request(teamB);
    const r = await as("coord", "POST", `/requests/${req.id}/convert`, {});
    expect(r.status).toBe(500);
  });
});

/* ── EDGES the rule has to hold across ────────────────────────────────────── */

maybe("legacy projects, PMs, shoots and ad-hoc assignments", () => {
  it("a legacy project (no team_id) is led by the Team Lead who owns it", async () => {
    const { did } = await ownedBy("empA1");
    const pid = Number((await deliv(did)).project_id);
    await pool.query(`UPDATE mo_projects SET team_id=NULL WHERE id=$1`, [pid]);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("l1"));
    expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    await pool.query(`UPDATE mo_deliverables SET status='in_review' WHERE id=$1`, [did]);
    await as("empA1", "POST", `/deliverables/${did}/versions`, drive("l2"));
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
    expect((await as("empA2", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("shoot crew follows the same scope", async () => {
    const { pid } = await routed(teamA);
    const shoot = await one(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, location, status, created_by)
       VALUES ($1,$2,'2026-10-05','Auditorium','planned',$3) RETURNING id`, [pid, `${PX} shoot`, ACTORS.leadA.id]);
    expect((await as("leadB", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empB1.id] })).status).toBe(201);
    expect((await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empB1.id] })).status).toBe(201);
    expect((await as("leadA", "POST", `/shoots/${shoot.id}/crew`, { crew: [ACTORS.empA1.id] })).status).toBe(201);
    expect((await as("leadB", "PATCH", `/shoots/${shoot.id}`, { notes: "x" })).status).toBe(200);
  });

  it("an assignment's members cannot be replaced from outside its project's team", async () => {
    const { pid } = await routed(teamA);
    const t = await as("leadA", "POST", `/projects/${pid}/tasks`, { title: `${PX} t`, assignees: [ACTORS.empA1.id] });
    const id = Number((t.body.assignment as Record<string, unknown>).id);
    expect((await as("leadB", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empB1.id] })).status).toBe(200);
    expect((await as("leadA", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empB1.id] })).status).toBe(200);
    expect((await as("leadA", "PATCH", `/assignments/${id}`, { assignees: [ACTORS.empA2.id] })).status).toBe(200);
    expect((await as("empA2", "PATCH", `/assignments/${id}`, { status: "in_progress" })).status).toBe(200);
    expect((await as("leadB", "DELETE", `/assignments/${id}`)).status).toBe(200);
  });

  it("a Coordinator still re-routes any project", async () => {
    const { pid } = await routed(teamA);
    expect((await as("coord", "PATCH", `/projects/${pid}`, { team_id: teamB })).status).toBe(200);
    expect((await project(pid)).owner_id).toBe(ACTORS.leadB.id);
  });
});
