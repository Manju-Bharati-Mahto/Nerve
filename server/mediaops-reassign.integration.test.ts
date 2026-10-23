// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — reassigning a deliverable is asked, then told to both people.

     · taking a deliverable off the person who owns it needs
       confirm_reassign:true, on every path that can do it — the drawer
       (POST /deliverables/:id/assignee), the owner select (PATCH
       /deliverables/:id), Schedule (POST /deliverables/:id/schedule) and
       Assign work on an existing deliverable (POST /projects/:id/work).
       Without it: 409 reassign_confirm naming the current owner, and nothing
       changes;
     · confirmed, the old and the new owner each get one notice naming the
       other, the trail records deliverable.reassigned {from, to, via}, and the
       versions the old owner submitted stay theirs;
     · a first assignment, or the same owner again, is never asked about;
     · someone who may not be assigned is refused (403), never asked about;
     · removing an account with reassign_to, and taking someone off a project
       with a reassignment, are confirmations in themselves.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zry-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zry";
const { pool, dbUp } = await connectTestDatabase();
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZRY Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZRY Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZRY Lead A" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZRY Anika" },
  empA2: { id: `${PX}-empA2`, role: "user", team: "media", full_name: "ZRY Bela" },
  gone: { id: `${PX}-gone`, role: "user", team: "media", full_name: "ZRY Leaving" },
  outsider: { id: `${PX}-outsider`, role: "user", team: "branding", full_name: "ZRY Outsider" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, projectTypeId = 0, dtype = 0, workTypeId = 0;
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
const ownerOf = async (did: number) => (await one(`SELECT owner_id FROM mo_deliverables WHERE id=$1`, [did])).owner_id;
const notes = (who: ActorName, did: number) => pool.query(
  `SELECT title, body FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2 ORDER BY id`,
  [ACTORS[who].id, did]).then((r) => r.rows as Array<{ title: string; body: string }>);
/** Start each owner change from a clean inbox, so "one notice" means one. */
const clearNotes = () => pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE '${PX}-%'`);
const reassignedTrail = (did: number) => pool.query(
  `SELECT after FROM mo_audit_logs WHERE action='deliverable.reassigned' AND entity_type='deliverable'
     AND entity_id=$1 ORDER BY id`, [did]).then((r) => r.rows.map((x) => x.after as Record<string, unknown>));

/** A project routed to Team A by the Coordinator — Lead A owns it and is its PM. */
async function routed() {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Annual Cultural Festival ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "high", description: "Student Affairs",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA, deliverables: [],
  });
  return Number((r.body.project as Record<string, unknown>).id);
}

/** Assign work with a new deliverable that `owner` owns. */
async function owned(pid: number, owner: ActorName) {
  const w = await as("leadA", "POST", `/projects/${pid}/work`, {
    work_type_id: workTypeId, title: `${PX} edit ${Math.random().toString(36).slice(2, 6)}`,
    assignees: [ACTORS[owner].id], owner_id: ACTORS[owner].id,
    new_deliverable: { deliverable_type_id: dtype, title: "Aftermovie" } });
  expect(w.status, JSON.stringify(w.body)).toBe(201);
  return Number((w.body.deliverable as Record<string, unknown>).id);
}

/** A deliverable nobody owns yet, as the Coordinator leaves one at creation. */
async function unowned(pid: number) {
  return Number((await one(
    `INSERT INTO mo_deliverables (project_id, deliverable_type_id, title, status, priority)
     VALUES ($1,$2,'Instagram Reel','not_started','normal') RETURNING id`, [pid, dtype])).id);
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, a.full_name, `${a.id}@reassign.invalid`, a.role, a.team]);
    if (a.team !== "media") continue;
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
       ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
      [a.id, name === "admin" ? "admin" : name === "coord" ? "coordinator"
        : name.startsWith("lead") ? "team_lead" : "employee"]);
  }
  teamA = Number((await pool.query(
    `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
    [`${PX} Event Team`, ACTORS.leadA.id])).rows[0].id);
  for (const u of [ACTORS.empA1.id, ACTORS.empA2.id, ACTORS.gone.id])
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

maybe("reassigning a deliverable — asked first, then both people told", () => {
  it("the drawer: unconfirmed is a 409 naming the owner, and nothing changes", async () => {
    const pid = await routed();
    const did = await owned(pid, "empA1");
    await clearNotes();
    const r = await as("leadA", "POST", `/deliverables/${did}/assignee`, { kind: "crew", user_id: ACTORS.empA2.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("reassign_confirm");
    expect(r.body.current_owner).toEqual({ id: ACTORS.empA1.id, full_name: "ZRY Anika" });
    expect(String(r.body.message)).toContain("ZRY Anika");
    expect(await ownerOf(did)).toBe(ACTORS.empA1.id);
    expect(await notes("empA1", did)).toEqual([]);
    expect(await notes("empA2", did)).toEqual([]);
    expect(await reassignedTrail(did)).toEqual([]);
  });

  it("the drawer, confirmed: B owns it, each is told once naming the other, the trail says from/to/via", async () => {
    const pid = await routed();
    const did = await owned(pid, "empA1");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`,
      { drive_url: "https://drive.google.com/file/d/zry-v1" })).status).toBeLessThan(300);
    await clearNotes();
    const r = await as("leadA", "POST", `/deliverables/${did}/assignee`,
      { kind: "crew", user_id: ACTORS.empA2.id, confirm_reassign: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await ownerOf(did)).toBe(ACTORS.empA2.id);
    const toA = await notes("empA1", did), toB = await notes("empA2", did);
    expect(toA).toHaveLength(1);
    expect(toA[0].body).toContain("ZRY Bela");
    expect(toB).toHaveLength(1);
    expect(toB[0].body).toContain("ZRY Anika");
    expect(await reassignedTrail(did)).toEqual([{ from: ACTORS.empA1.id, to: ACTORS.empA2.id, via: "assignee" }]);
    const v = await one(`SELECT submitted_by FROM mo_deliverable_versions WHERE deliverable_id=$1`, [did]);
    expect(v.submitted_by).toBe(ACTORS.empA1.id);
  });

  it("a first assignment, and the same owner again, are never asked about", async () => {
    const pid = await routed();
    const did = await unowned(pid);
    await clearNotes();
    const r = await as("leadA", "POST", `/deliverables/${did}/assignee`, { kind: "crew", user_id: ACTORS.empA1.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await ownerOf(did)).toBe(ACTORS.empA1.id);
    expect((await notes("empA1", did)).map((n) => n.title)).toEqual(["New assignment"]);
    expect(await reassignedTrail(did)).toEqual([]);
    const again = await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.empA1.id });
    expect(again.status).toBe(200);
    const did2 = await unowned(pid);
    expect((await as("leadA", "PATCH", `/deliverables/${did2}`, { owner_id: ACTORS.empA2.id })).status).toBe(200);
    expect(await ownerOf(did2)).toBe(ACTORS.empA2.id);
  });

  it("the owner select (PATCH) and Schedule ask the same way", async () => {
    const pid = await routed();
    const did = await owned(pid, "empA1");
    const p1 = await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.empA2.id });
    expect([p1.status, p1.body.code]).toEqual([409, "reassign_confirm"]);
    expect(await ownerOf(did)).toBe(ACTORS.empA1.id);
    await clearNotes();
    const p2 = await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.empA2.id, confirm_reassign: true });
    expect(p2.status, JSON.stringify(p2.body)).toBe(200);
    expect(await ownerOf(did)).toBe(ACTORS.empA2.id);
    expect((await notes("empA1", did)).map((n) => n.body)).toEqual([expect.stringContaining("ZRY Bela")]);
    expect((await notes("empA2", did)).map((n) => n.body)).toEqual([expect.stringContaining("ZRY Anika")]);

    const s1 = await as("leadA", "POST", `/deliverables/${did}/schedule`,
      { scheduled_date: "2026-10-05", owner_id: ACTORS.empA1.id });
    expect([s1.status, (s1.body.current_owner as Record<string, unknown>)?.id]).toEqual([409, ACTORS.empA2.id]);
    expect((await one(`SELECT scheduled_date FROM mo_deliverables WHERE id=$1`, [did])).scheduled_date).toBeNull();
    const s2 = await as("leadA", "POST", `/deliverables/${did}/schedule`,
      { scheduled_date: "2026-10-05", owner_id: ACTORS.empA1.id, confirm_reassign: true });
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    expect(await ownerOf(did)).toBe(ACTORS.empA1.id);
    expect((await reassignedTrail(did)).map((a) => a.via)).toEqual(["edit", "schedule"]);
  });

  it("Assign work naming a new owner of an existing deliverable is asked about; confirmed, both are told once", async () => {
    const pid = await routed();
    const did = await owned(pid, "empA1");
    const rows = async () => Number((await one(`SELECT count(*) n FROM mo_assignments WHERE deliverable_id=$1`, [did])).n);
    const before = await rows();
    const body = { work_type_id: workTypeId, title: `${PX} grade`, deliverable_id: did,
      assignees: [ACTORS.empA2.id], owner_id: ACTORS.empA2.id };
    const r1 = await as("leadA", "POST", `/projects/${pid}/work`, body);
    expect([r1.status, r1.body.code]).toEqual([409, "reassign_confirm"]);
    expect(await rows()).toBe(before);
    expect(await ownerOf(did)).toBe(ACTORS.empA1.id);
    await clearNotes();
    const r2 = await as("leadA", "POST", `/projects/${pid}/work`, { ...body, confirm_reassign: true });
    expect(r2.status, JSON.stringify(r2.body)).toBe(201);
    expect(await ownerOf(did)).toBe(ACTORS.empA2.id);
    const toA = await notes("empA1", did), toB = await notes("empA2", did);
    expect(toA.map((n) => n.body)).toEqual([expect.stringContaining("ZRY Bela")]);
    expect(toB.map((n) => n.body)).toEqual([expect.stringContaining("(was ZRY Anika)")]);
    expect((await reassignedTrail(did)).map((a) => a.via)).toEqual(["assign_work"]);
    // More work for the same owner is not a reassignment.
    const r3 = await as("leadA", "POST", `/projects/${pid}/work`, { ...body, title: `${PX} grade 2` });
    expect(r3.status, JSON.stringify(r3.body)).toBe(201);
  });

  it("someone who may not be assigned is refused, not asked about", async () => {
    const pid = await routed();
    const did = await owned(pid, "empA1");
    const r = await as("leadA", "POST", `/deliverables/${did}/assignee`, { kind: "crew", user_id: ACTORS.outsider.id });
    expect(r.status).toBe(403);
    const p = await as("leadA", "PATCH", `/deliverables/${did}`, { owner_id: ACTORS.outsider.id, confirm_reassign: true });
    expect(p.status).toBe(403);
    expect(await ownerOf(did)).toBe(ACTORS.empA1.id);
  });

  it("removing an account with reassign_to counts as confirmed, tells both and is on the trail", async () => {
    const pid = await routed();
    const did = await owned(pid, "gone");
    await clearNotes();
    const r = await as("admin", "DELETE", `/crew/${ACTORS.gone.id}`, { reassign_to: ACTORS.empA2.id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await ownerOf(did)).toBe(ACTORS.empA2.id);
    expect((await notes("empA2", did)).map((n) => n.body)).toEqual([expect.stringContaining("ZRY Leaving")]);
    expect(await reassignedTrail(did)).toEqual([{ from: ACTORS.gone.id, to: ACTORS.empA2.id, via: "account_removal" }]);
  });
});
