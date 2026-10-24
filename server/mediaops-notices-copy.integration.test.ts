// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — what a notice says, and what the bell is told about it.

     · counts are pluralised: "1 deliverable to allocate", "2 deliverables";
       an older row's "4 deliverable(s)" is read as "4 deliverables" — the
       stored row is left as it is;
     · a version-submitted notice names its project;
     · the feed says where that version stands now (version_review_status),
       so a reviewed one need not ask for a review again;
     · the feed says whether "Deliverable added" came from an Admin or the
       Coordinator (from_admin_or_coord), read from the audit trail;
     · the Coordinator's own activity names the project a deliverable is in.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zq5c-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zq5c";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZQ5C Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZQ5C Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZQ5C Lead A" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZQ5C Emp A1" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, projectTypeId = 0, dtype = 0;

{ const t = await connectTestDatabase(); pool = t.pool; dbUp = t.dbUp; }
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
type Notice = { id: number; title: string; body: string; entity_id: number;
  version_review_status?: string | null; from_admin_or_coord?: boolean | null };
const feed = async (actor: ActorName) => {
  const r = await as(actor, "GET", "/notifications");
  expect(r.status).toBe(200);
  return r.body.notifications as Notice[];
};

/** A project for Team A started by the Coordinator, with this many deliverables. */
async function project(n: number) {
  const name = `${PX} Festival ${Math.random().toString(36).slice(2, 8)}`;
  const r = await as("coord", "POST", "/projects", {
    name, project_type_id: projectTypeId, priority: "high", description: "Registrar",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA,
    deliverables: Array.from({ length: n }, () => ({ deliverable_type_id: dtype })),
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { pid: Number((r.body.project as Record<string, unknown>).id), name };
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, a.full_name, `${a.id}@notices-copy.invalid`, a.role]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
       ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
      [a.id, name === "admin" ? "admin" : name === "coord" ? "coordinator"
        : name.startsWith("lead") ? "team_lead" : "employee"]);
  }
  teamA = Number((await pool.query(
    `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
    [`${PX} Event Team`, ACTORS.leadA.id])).rows[0].id);
  await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                    ON CONFLICT DO NOTHING`, [teamA, ACTORS.empA1.id]);
  projectTypeId = Number((await one(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).id);
  dtype = Number((await one(
    `SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL AND NOT review_exempt ORDER BY id LIMIT 1`)).id);
}

async function cleanup() {
  const pj = `(SELECT id FROM mo_projects WHERE name LIKE '${PX}%')`;
  await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id IN (SELECT id FROM mo_assignments WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_assignments WHERE project_id IN ${pj}`);
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

maybe("notices — counts in words", () => {
  it("the lead of a routed project hears '1 deliverable' / '2 deliverables' to allocate", async () => {
    const a = await project(1), b = await project(2);
    const mine = await feed("leadA");
    const bodyOf = (pid: number) => mine.find((n) => n.entity_id === pid && n.title === "You are leading a new project")?.body;
    expect(bodyOf(a.pid)).toBe(`${a.name} was assigned to ${PX} Event Team. 1 deliverable to allocate.`);
    expect(bodyOf(b.pid)).toBe(`${b.name} was assigned to ${PX} Event Team. 2 deliverables to allocate.`);
  });

  it("an older row's '(s)' is read in words; the stored row is unchanged", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
       VALUES ($1,'assignment','You are leading a new project',$2,'project',NULL) RETURNING id`,
      [ACTORS.leadA.id, "Fest was assigned to Event Team. 4 deliverable(s) to allocate. 1 project(s) moved."])).rows[0].id);
    const n = (await feed("leadA")).find((x) => x.id === id);
    expect(n?.body).toBe("Fest was assigned to Event Team. 4 deliverables to allocate. 1 project moved.");
    expect((await one(`SELECT body FROM mo_notifications WHERE id=$1`, [id])).body).toContain("deliverable(s)");
  });
});

maybe("notices — a submission names its project and says where its version stands", () => {
  it("names the project, and reads 'pending' until reviewed, then the verdict", async () => {
    const { pid, name } = await project(1);
    const did = Number((await one(`SELECT id, title FROM mo_deliverables WHERE project_id=$1`, [pid])).id);
    const title = String((await one(`SELECT title FROM mo_deliverables WHERE id=$1`, [did])).title);
    await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA1.id, did]);
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`,
      { drive_url: `https://drive.google.com/${PX}-v1` })).status).toBe(201);
    const submitted = async () => (await feed("leadA"))
      .find((n) => n.entity_id === did && n.title === "Version submitted for review");
    const n1 = await submitted();
    expect(n1?.body).toBe(`ZQ5C Emp A1 submitted v1 of “${title}” on ${name}.`);
    expect(n1?.version_review_status).toBe("pending");
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    expect((await submitted())?.version_review_status).toBe("approved");
  });
});

maybe("notices — who added a deliverable", () => {
  it("the Coordinator's 'Deliverable added' is marked as from Admin or Coordinator; a crew member's is not", async () => {
    const { pid } = await project(1);
    const r = await as("coord", "POST", `/projects/${pid}/deliverables`, { deliverable_type_id: dtype });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const did = Number((r.body.deliverable as Record<string, unknown>).id);
    const added = (await feed("leadA")).find((n) => n.entity_id === did && n.title === "Deliverable added");
    expect(added?.from_admin_or_coord).toBe(true);
    // The same notice, for a deliverable an employee added (audit says who).
    const other = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1 AND id<>$2 LIMIT 1`, [pid, did])).id);
    await pool.query(`INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id)
                      VALUES ($1,'employee','deliverable.created','deliverable',$2)`, [ACTORS.empA1.id, other]);
    await pool.query(`INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
                      VALUES ($1,'assignment','Deliverable added','x','deliverable',$2)`, [ACTORS.leadA.id, other]);
    const byCrew = (await feed("leadA")).find((n) => n.entity_id === other && n.title === "Deliverable added");
    expect(byCrew?.from_admin_or_coord).toBe(false);
    // Any other notice carries no answer.
    expect((await feed("leadA")).find((n) => n.title === "You are leading a new project")?.from_admin_or_coord).toBeNull();
  });
});

maybe("the Coordinator's activity — which project", () => {
  it("a row about a deliverable names its project", async () => {
    const { pid, name } = await project(1);
    const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1`, [pid])).id);
    const r = await as("coord", "POST", `/projects/${pid}/deliverables`, { deliverable_type_id: dtype });
    expect(r.status).toBe(201);
    const act = (await as("coord", "GET", "/my-activity")).body.audit as Array<Record<string, unknown>>;
    const row = act.find((a) => a.action === "deliverable.created" && Number(a.entity_id) !== did
      && Number(a.entity_id) === Number((r.body.deliverable as Record<string, unknown>).id));
    expect(row?.project_name).toBe(name);
    expect(act.find((a) => a.entity_type === "project" && Number(a.entity_id) === pid)?.project_name ?? null).toBeNull();
  });
});
