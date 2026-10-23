// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — a project's status follows its deliverables, and a project
   is completed only when its work has gone out.
     Closure (Q8)     → completed needs every live deliverable dispatched, or
                      marked delivered AND signed off, and none sent back. The
                      refusal names what is open. An Admin may close it anyway
                      with a reason, which is recorded. Dispatch never waits
                      for sign-off.
     Progress (Q9)    forward only: work started → in production; everything
                      approved → ready to dispatch ('delivered'); everything
                      out or signed off → completed. A send-back (or new work)
                      on a project ready to dispatch returns it to production.
                      On hold, cancelled, archived, proposed and completed are
                      never touched. Each move is audited as the system.
     No proposals (Q7) a project row written without a status is 'planning'.
   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zpg-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const PX = "zpg";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZPG Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZPG Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZPG Lead A" },
  leadB: { id: `${PX}-leadB`, role: "sub_admin", team: "media", full_name: "ZPG Lead B" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZPG Emp A1" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, teamB = 0, projectTypeId = 0, dtype = 0;

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
const status = async (pid: number) => String((await one(`SELECT status FROM mo_projects WHERE id=$1`, [pid])).status);

/** A Team A project the Coordinator routed, with `n` deliverables Emp A1 owns. */
async function project(n: number) {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Convocation ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "normal", description: "",
    start_date: "2026-11-01", end_date: "2026-11-10", team_id: teamA,
    deliverables: Array.from({ length: n }, (_, i) => ({ title: `Cut ${i + 1}`, deliverable_type_id: dtype })),
  });
  expect(r.status).toBe(201);
  const pid = Number((r.body.project as Record<string, unknown>).id);
  await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE project_id=$2`, [ACTORS.empA1.id, pid]);
  const dids = (await pool.query(`SELECT id FROM mo_deliverables WHERE project_id=$1 ORDER BY id`, [pid]))
    .rows.map((x) => Number(x.id));
  return { pid, dids };
}

let vn = 0;
const submit = (did: number) =>
  as("empA1", "POST", `/deliverables/${did}/versions`, { drive_url: `https://drive.google.com/${PX}-${did}-${++vn}` });
/** Submitted by its owner, approved by another team's lead — queued for dispatch. */
async function approve(did: number) {
  expect((await submit(did)).status).toBe(201);
  expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
}
const dispatch = (did: number) =>
  as("coord", "POST", `/deliverables/${did}/dispatch`, { recipient: "Student Affairs" });
const deliver = (did: number) => as("empA1", "POST", `/deliverables/${did}/deliver`, {});
const signOff = (did: number, to: string, note = "") =>
  as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: to, note });
const toCompleted = (actor: ActorName, pid: number, body: Record<string, unknown> = {}) =>
  as(actor, "POST", `/projects/${pid}/status`, { status: "completed", ...body });

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, a.full_name, `${a.id}@project-progress.invalid`, a.role]);
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
  await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                    ON CONFLICT DO NOTHING`, [teamA, ACTORS.empA1.id]);
  projectTypeId = Number((await one(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).id);
  dtype = Number((await one(
    `SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL AND NOT review_exempt ORDER BY id LIMIT 1`)).id);
}

async function cleanup() {
  const pj = `(SELECT id FROM mo_projects WHERE name LIKE '${PX}%')`;
  const dj = `(SELECT id FROM mo_deliverables WHERE project_id IN ${pj})`;
  await pool.query(`DELETE FROM mo_assignment_users WHERE assignment_id IN (SELECT id FROM mo_assignments WHERE project_id IN ${pj})`);
  await pool.query(`DELETE FROM mo_assignments WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_deliverable_versions WHERE deliverable_id IN ${dj}`);
  await pool.query(`DELETE FROM mo_notifications WHERE entity_type='deliverable' AND entity_id IN ${dj}`);
  await pool.query(`DELETE FROM mo_deliverables WHERE project_id IN ${pj}`);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN ${pj}`);
  // The system's own moves name no actor, so they go by the project they are about.
  await pool.query(`DELETE FROM mo_audit_logs WHERE entity_type='project' AND entity_id IN ${pj}`);
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

/* ── Q9 — progress follows the deliverables ───────────────────────────────── */
maybe("project progress — forward only, from the deliverables", () => {
  it("the first version moves a planned project into production, recorded as the system", async () => {
    const { pid, dids } = await project(2);
    expect(await status(pid)).toBe("planning");
    expect((await submit(dids[0])).status).toBe(201);
    expect(await status(pid)).toBe("in_production");
    const row = await one(
      `SELECT actor_id, actor_role, before, after FROM mo_audit_logs
        WHERE action='project.status_auto' AND entity_type='project' AND entity_id=$1`, [pid]);
    expect(row.actor_id).toBeNull();
    expect(row.actor_role).toBe("system");
    expect(row.before).toEqual({ status: "planning" });
    expect(row.after.status).toBe("in_production");
    expect(String(row.after.rule)).not.toMatch(/\b(BR|VR|AUTO|FR)-?\d/);
  });

  it("one approved and one still in progress stays in production", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    await pool.query(`UPDATE mo_deliverables SET status='in_progress' WHERE id=$1`, [dids[1]]);
    expect((await submit(dids[1])).status).toBe(201);
    expect(await status(pid)).toBe("in_production");
  });

  it("a project with work not yet started keeps its status, even beside approved work", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    // Cut 2 is not started; the project is in production, not ready to dispatch.
    expect(await status(pid)).toBe("in_production");
    const fresh = await project(1);
    expect((await as("leadA", "POST", `/projects/${fresh.pid}/deliverables`, { deliverable_type_id: dtype })).status).toBe(201);
    expect(await status(fresh.pid)).toBe("planning");
  });

  it("everything approved is ready to dispatch; one out and one queued stays there", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    await approve(dids[1]);
    expect(await status(pid)).toBe("delivered");
    expect((await dispatch(dids[0])).status).toBe(200);
    expect(await status(pid)).toBe("delivered");
  });

  it("all dispatched but one marked delivered and not yet signed off stays ready to dispatch", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    await approve(dids[1]);
    expect((await dispatch(dids[0])).status).toBe(200);
    expect((await deliver(dids[1])).status).toBe(200);
    expect((await dispatch(dids[1])).status).toBe(200);
    expect(await status(pid)).toBe("delivered");
    // The sign-off is what was missing.
    expect((await signOff(dids[1], "approved")).status).toBe(200);
    expect(await status(pid)).toBe("completed");
  });

  it("all dispatched completes the project, without anyone marking it", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    await approve(dids[1]);
    expect((await dispatch(dids[0])).status).toBe(200);
    expect((await dispatch(dids[1])).status).toBe(200);
    expect(await status(pid)).toBe("completed");
  });

  it("cancelled and not-needed work is left out; a project of only cancelled work is not moved", async () => {
    const { pid, dids } = await project(3);
    expect((await as("leadA", "POST", `/deliverables/${dids[1]}/status`, { status: "cancelled" })).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${dids[2]}/status`, { status: "not_required" })).status).toBe(200);
    expect(await status(pid)).toBe("planning");
    await approve(dids[0]);
    expect((await dispatch(dids[0])).status).toBe(200);
    expect(await status(pid)).toBe("completed");

    const none = await project(2);
    for (const did of none.dids)
      expect((await as("leadA", "POST", `/deliverables/${did}/status`, { status: "cancelled" })).status).toBe(200);
    expect(await status(none.pid)).toBe("planning");
  });

  it("on hold, cancelled, archived and proposed projects are never moved", async () => {
    for (const held of ["on_hold", "cancelled", "archived", "proposed"]) {
      const { pid, dids } = await project(1);
      await pool.query(`UPDATE mo_projects SET status=$1 WHERE id=$2`, [held, pid]);
      expect((await submit(dids[0])).status).toBe(201);
      expect(await status(pid), held).toBe(held);
    }
  });

  it("in review is set by hand: progress never moves a project back to production from it", async () => {
    const { pid, dids } = await project(2);
    await pool.query(`UPDATE mo_projects SET status='in_review' WHERE id=$1`, [pid]);
    expect((await submit(dids[0])).status).toBe(201);
    expect(await status(pid)).toBe("in_review");
    await approve(dids[0]);
    await approve(dids[1]);
    expect(await status(pid)).toBe("delivered");
  });

  it("a send-back at sign-off returns a ready-to-dispatch project to production", async () => {
    const { pid, dids } = await project(1);
    await approve(dids[0]);
    expect((await deliver(dids[0])).status).toBe(200);
    expect(await status(pid)).toBe("delivered");
    expect((await signOff(dids[0], "changes_requested", "Trim the intro")).status).toBe(200);
    expect(await status(pid)).toBe("in_production");
    const back = await one(
      `SELECT before, after FROM mo_audit_logs WHERE action='project.status_auto' AND entity_id=$1
        ORDER BY id DESC LIMIT 1`, [pid]);
    expect(back.before).toEqual({ status: "delivered" });
    expect(back.after.status).toBe("in_production");
  });

  it("new work added to a ready-to-dispatch project returns it to production", async () => {
    const { pid, dids } = await project(1);
    await approve(dids[0]);
    expect(await status(pid)).toBe("delivered");
    expect((await as("leadA", "POST", `/projects/${pid}/deliverables`, { deliverable_type_id: dtype })).status).toBe(201);
    expect(await status(pid)).toBe("in_production");
  });
});

/* ── Q8 — approval, dispatch and sign-off are separate; closing needs all ── */
maybe("closing a project — every deliverable out or signed off", () => {
  it("approved work is dispatched without waiting for a sign-off", async () => {
    const { dids } = await project(1);
    await approve(dids[0]);
    const d = await one(`SELECT approval_status FROM mo_deliverables WHERE id=$1`, [dids[0]]);
    expect(d.approval_status).not.toBe("approved");
    expect((await dispatch(dids[0])).status).toBe(200);
  });

  it("work sent back at sign-off cannot be dispatched", async () => {
    const { dids } = await project(1);
    await approve(dids[0]);
    expect((await deliver(dids[0])).status).toBe(200);
    expect((await signOff(dids[0], "changes_requested", "Colour is off")).status).toBe(200);
    expect((await dispatch(dids[0])).status).toBe(400);
  });

  it("work sent back at sign-off, resubmitted and approved again, is dispatchable and can close", async () => {
    const { pid, dids } = await project(1);
    await approve(dids[0]);
    expect((await deliver(dids[0])).status).toBe(200);
    expect((await signOff(dids[0], "changes_requested", "Colour is off")).status).toBe(200);
    await approve(dids[0]);
    const d = await one(`SELECT status, approval_status, dispatch_status FROM mo_deliverables WHERE id=$1`, [dids[0]]);
    expect(d).toMatchObject({ status: "approved", approval_status: "pending", dispatch_status: "queued" });
    expect((await dispatch(dids[0])).status).toBe(200);
    expect(await status(pid)).toBe("completed");
  });

  it("refuses to complete with a delivered item waiting for sign-off, naming it; then allows it", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    await approve(dids[1]);
    expect((await dispatch(dids[0])).status).toBe(200);
    expect((await deliver(dids[1])).status).toBe(200);
    expect(await status(pid)).toBe("delivered");
    const r = await toCompleted("leadA", pid);
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("Cut 2");
    expect(String(r.body.message)).toContain("sign-off");
    expect(String(r.body.message)).not.toMatch(/\b(BR|VR|AUTO|FR)-?\d/);
    expect(await status(pid)).toBe("delivered");
    expect((await signOff(dids[1], "approved")).status).toBe(200);
    // Signing off completes it on its own; a lead who closes it by hand at that point is allowed too.
    expect(await status(pid)).toBe("completed");
    await pool.query(`UPDATE mo_projects SET status='delivered' WHERE id=$1`, [pid]);
    expect((await toCompleted("leadA", pid)).status).toBe(200);
    expect(await status(pid)).toBe("completed");
  });

  it("all dispatched and none marked delivered may be completed by hand", async () => {
    const { pid, dids } = await project(2);
    for (const did of dids) await approve(did);
    // The deliverables are out; the project is held at ready-to-dispatch as if set by hand.
    await pool.query(`UPDATE mo_deliverables SET dispatch_status='delivered', dispatched_at=NOW() WHERE project_id=$1`, [pid]);
    await pool.query(`UPDATE mo_projects SET status='delivered' WHERE id=$1`, [pid]);
    expect((await toCompleted("leadA", pid)).status).toBe(200);
  });

  it("an Admin closes it anyway only with a reason, which is recorded; a lead cannot", async () => {
    const { pid, dids } = await project(2);
    await approve(dids[0]);
    await approve(dids[1]);
    expect(await status(pid)).toBe("delivered");
    expect((await toCompleted("leadA", pid, { override_reason: "Client cancelled the rest" })).status).toBe(400);
    const bare = await toCompleted("admin", pid);
    expect(bare.status).toBe(400);
    expect(String(bare.body.message)).toContain("reason");
    expect((await toCompleted("admin", pid, { override_reason: "   " })).status).toBe(400);
    expect(await status(pid)).toBe("delivered");
    expect((await toCompleted("admin", pid, { override_reason: "Client cancelled the rest" })).status).toBe(200);
    expect(await status(pid)).toBe("completed");
    const row = await one(
      `SELECT actor_id, after FROM mo_audit_logs WHERE action='project.completed_override' AND entity_id=$1`, [pid]);
    expect(row.actor_id).toBe(ACTORS.admin.id);
    expect(row.after.reason).toBe("Client cancelled the rest");
    expect(row.after.still_open).toHaveLength(2);
  });

  it("an un-archive is not a closure and is not held by open work", async () => {
    const { pid, dids } = await project(1);
    await approve(dids[0]);
    await pool.query(`UPDATE mo_projects SET status='archived' WHERE id=$1`, [pid]);
    expect((await toCompleted("admin", pid)).status).toBe(200);
  });
});

/* ── Q7 — nothing is proposed any more ────────────────────────────────────── */
maybe("no new proposals", () => {
  it("a project row written without a status starts in planning", async () => {
    const r = await one(
      `INSERT INTO mo_projects (name, code, project_type_id, owner_id, created_by)
       VALUES ($1,$2,$3,$4,$4) RETURNING status`,
      [`${PX} default probe`, `ZPG-${Date.now()}`, projectTypeId, ACTORS.admin.id]);
    expect(r.status).toBe("planning");
  });

  it("a project created through the API starts in planning", async () => {
    const { pid } = await project(1);
    expect(await status(pid)).toBe("planning");
  });
});
