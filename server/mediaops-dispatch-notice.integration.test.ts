// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — "Ready to dispatch": who in Operations is told, and when.

   Approval queues a deliverable for dispatch; a review-exempt type is ready
   once it is delivered. Either way the Coordinator responsible for the
   project hears it once, as it joins the queue:

     · the Coordinator who converted the request into the project, else
     · the Coordinator who created the project, else
     · every active Coordinator (a project an Admin or a lead started).

   Submitting a version tells nobody in Operations — that is the reviewer's.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zdq-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const PX = "zdq";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZDQ Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZDQ Coordinator" },
  coord2: { id: `${PX}-coord2`, role: "user", team: "media", full_name: "ZDQ Second Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZDQ Lead A" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZDQ Emp A1" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, projectTypeId = 0, dtype = 0, exemptType = 0;

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
/** The "Ready to dispatch" notices `who` holds for this deliverable. */
const dispatchNotices = (who: ActorName, did: number) => pool.query(
  `SELECT title, is_read FROM mo_notifications WHERE user_id=$1 AND kind='dispatch'
      AND entity_type='deliverable' AND entity_id=$2`, [ACTORS[who].id, did]).then((r) => r.rows);
/** Every notice `who` holds about this deliverable, whatever its kind. */
const anyNotices = (who: ActorName, did: number) => pool.query(
  `SELECT kind FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2`,
  [ACTORS[who].id, did]).then((r) => r.rows);
const drive = (n: string | number) => ({ drive_url: `https://drive.google.com/${PX}-${n}` });

/** A project for Team A started by `creator`, with one deliverable owned by Emp A1. */
async function deliverableBy(creator: ActorName, type = dtype, title = "Edited Photos") {
  const r = await as(creator, "POST", "/projects", {
    name: `${PX} Convocation ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "high", description: "Registrar",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA,
    deliverables: [{ title, deliverable_type_id: type }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const pid = Number((r.body.project as Record<string, unknown>).id);
  const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1`, [pid])).id);
  await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA1.id, did]);
  return { pid, did };
}

/** Emp A1 submits a version and Lead A approves it. */
async function submitAndApprove(did: number, n: string | number) {
  expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive(n))).status).toBe(201);
  expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, a.full_name, `${a.id}@dispatch-notice.invalid`, a.role]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
       ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
      [a.id, name === "admin" ? "admin" : name.startsWith("coord") ? "coordinator"
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
  const ex = await one(`SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL AND review_exempt ORDER BY id LIMIT 1`);
  exemptType = ex ? Number(ex.id) : 0;
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

maybe("Ready to dispatch — reviewed work", () => {
  let did = 0;
  beforeAll(async () => { ({ did } = await deliverableBy("coord")); });

  it("a submitted version tells the Coordinator nothing", async () => {
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive(1))).status).toBe(201);
    expect(await anyNotices("coord", did)).toEqual([]);
  });

  it("the approval queues it, and the Coordinator who created the project is told once", async () => {
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    expect((await deliv(did)).dispatch_status).toBe("queued");
    expect((await dispatchNotices("coord", did)).map((n) => n.title)).toEqual(["Ready to dispatch: Edited Photos"]);
    expect(await dispatchNotices("coord2", did)).toEqual([]);
  });

  it("a re-approval after a send-back does not pile up a second unread notice", async () => {
    expect((await as("leadA", "POST", `/deliverables/${did}/review`,
      { outcome: "changes_requested", comment: "tighten the edit" })).status).toBe(200);
    expect((await deliv(did)).dispatch_status).toBe("none");
    await submitAndApprove(did, 2);
    expect((await deliv(did)).dispatch_status).toBe("queued");
    expect(await dispatchNotices("coord", did)).toHaveLength(1);
  });

  it("once read, the next time it is ready brings one new notice", async () => {
    await pool.query(`UPDATE mo_notifications SET is_read=true WHERE user_id=$1 AND kind='dispatch'`, [ACTORS.coord.id]);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`,
      { outcome: "changes_requested", comment: "one more pass" })).status).toBe(200);
    await submitAndApprove(did, 3);
    const n = await dispatchNotices("coord", did);
    expect(n.filter((x) => !x.is_read)).toHaveLength(1);
    expect(n).toHaveLength(2);
  });

  it("the board's 'approved' is the same approval, and tells the Coordinator the same way", async () => {
    const { did: d2 } = await deliverableBy("coord", dtype, "Highlights");
    expect((await as("empA1", "POST", `/deliverables/${d2}/versions`, drive("b1"))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${d2}/status`, { status: "approved" })).status).toBe(200);
    expect((await dispatchNotices("coord", d2)).map((n) => n.title)).toEqual(["Ready to dispatch: Highlights"]);
  });
});

maybe("Ready to dispatch — who is responsible", () => {
  it("a converted project: the Coordinator who converted the request, not its creator", async () => {
    const { pid, did } = await deliverableBy("coord");
    await pool.query(
      `INSERT INTO mo_requests (event_name, status, project_id, converted_by, converted_at)
       VALUES ($1,'converted',$2,$3,NOW())`, [`${PX} Convocation request`, pid, ACTORS.coord2.id]);
    await submitAndApprove(did, "c1");
    expect(await dispatchNotices("coord2", did)).toHaveLength(1);
    expect(await dispatchNotices("coord", did)).toEqual([]);
  });

  it("a project an Admin started: every Coordinator", async () => {
    const { did } = await deliverableBy("admin");
    await submitAndApprove(did, "a1");
    expect(await dispatchNotices("coord", did)).toHaveLength(1);
    expect(await dispatchNotices("coord2", did)).toHaveLength(1);
  });

  it("a creator who is no longer a Coordinator hands it to every Coordinator", async () => {
    const { pid, did } = await deliverableBy("coord");
    await pool.query(`UPDATE mo_projects SET created_by=$1 WHERE id=$2`, [ACTORS.leadA.id, pid]);
    await submitAndApprove(did, "l1");
    expect(await dispatchNotices("coord", did)).toHaveLength(1);
    expect(await dispatchNotices("coord2", did)).toHaveLength(1);
    expect(await dispatchNotices("leadA", did)).toEqual([]);
  });
});

maybe("Ready to dispatch — review-exempt work, once delivered", () => {
  it("/deliver queues it and tells the Coordinator; the Coordinator can dispatch it", async () => {
    if (!exemptType) return;
    const { did } = await deliverableBy("coord", exemptType, "Raw Footage");
    await pool.query(`UPDATE mo_deliverables SET status='in_progress' WHERE id=$1`, [did]);
    expect((await as("empA1", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(200);
    const d = await deliv(did);
    expect(d.status).toBe("delivered");
    expect(d.dispatch_status).toBe("queued");
    expect(d.queued_at).not.toBeNull();
    expect((await dispatchNotices("coord", did)).map((n) => n.title)).toEqual(["Ready to dispatch: Raw Footage"]);
    expect(await dispatchNotices("coord2", did)).toEqual([]);
    // Dispatch does not wait for the sign-off.
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "Registrar" })).status).toBe(200);
  });

  it("the board's 'delivered' does the same", async () => {
    if (!exemptType) return;
    const { did } = await deliverableBy("coord", exemptType, "Stage Recording");
    await pool.query(`UPDATE mo_deliverables SET status='in_progress' WHERE id=$1`, [did]);
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(200);
    expect((await deliv(did)).dispatch_status).toBe("queued");
    expect(await dispatchNotices("coord", did)).toHaveLength(1);
  });

  it("delivering reviewed work does not tell the Coordinator a second time", async () => {
    const { did } = await deliverableBy("coord", dtype, "Album");
    await submitAndApprove(did, "d1");
    expect((await as("empA1", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(200);
    expect(await dispatchNotices("coord", did)).toHaveLength(1);
  });
});
