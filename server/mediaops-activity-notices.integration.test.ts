// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — what the server tells people about a project's work.

     · the project's Activity carries every version submitted and every
       review verdict (with what to change), and the dispatch and archive;
     · New project accepts a deliverable row that gives only its type, named
       after the type ("(2)" for a repeat);
     · project types reach the page in the catalogue's order;
     · a stored notice is read without the rule codes older ones carried —
       the stored row is left as it is;
     · the sign-off after delivery has its own title, not the version's
       "Approved: …".

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zq3-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zq3";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZQ3 Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZQ3 Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZQ3 Lead A" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZQ3 Emp A1" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, projectTypeId = 0, dtype = 0, dtypeName = "", dtype2 = 0, dtype2Name = "";

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
const drive = (n: string | number) => ({ drive_url: `https://drive.google.com/${PX}-${n}` });
type Act = { action: string; entity_type: string; version_no?: number; deliverable_title?: string;
  after?: Record<string, unknown> | null };
const activity = async (pid: number) => {
  const r = await as("leadA", "GET", `/projects/${pid}/activity`);
  expect(r.status).toBe(200);
  return r.body.activity as Act[];
};

/** A project for Team A started by the Coordinator, with deliverables as given. */
async function project(deliverables: unknown[]) {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Festival ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "high", description: "Registrar",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA, deliverables,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return Number((r.body.project as Record<string, unknown>).id);
}
/** One deliverable owned by Emp A1. */
async function owned(title = "Edited Photos") {
  const pid = await project([{ title, deliverable_type_id: dtype }]);
  const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1`, [pid])).id);
  await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.empA1.id, did]);
  return { pid, did };
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, a.full_name, `${a.id}@activity-notices.invalid`, a.role]);
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
  const types = (await pool.query(
    `SELECT id, name FROM mo_deliverable_types WHERE archived_at IS NULL AND NOT review_exempt ORDER BY id LIMIT 2`)).rows;
  [dtype, dtypeName, dtype2, dtype2Name] = [Number(types[0].id), String(types[0].name), Number(types[1].id), String(types[1].name)];
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
  await pool.query(`DELETE FROM mo_project_types WHERE slug LIKE '${PX}-%'`);
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

maybe("project Activity — versions, verdicts, dispatch", () => {
  let pid = 0, did = 0;
  beforeAll(async () => {
    ({ pid, did } = await owned());
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive(1))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`,
      { outcome: "changes_requested", comment: "Brighten the stage shots" })).status).toBe(200);
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive(2))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  });

  it("lists each submission and each verdict, naming the version and its deliverable", async () => {
    const rows = (await activity(pid)).filter((a) => a.entity_type === "deliverable_version").reverse();
    expect(rows.map((a) => [a.action, a.version_no, a.deliverable_title, a.after?.review_status ?? null])).toEqual([
      ["deliverable.version_submitted", 1, "Edited Photos", null],
      ["deliverable.version_reviewed", 1, "Edited Photos", "changes_requested"],
      ["deliverable.version_submitted", 2, "Edited Photos", null],
      ["deliverable.version_reviewed", 2, "Edited Photos", "approved"],
    ]);
    // The send-back says what to change.
    expect(rows[1].after?.review_comment).toBe("Brighten the stage shots");
  });

  it("a review recorded without its comment still shows the version's comment", async () => {
    // How the trail looked before the comment was written into it.
    await pool.query(
      `UPDATE mo_audit_logs SET after = after - 'review_comment'
        WHERE action='deliverable.version_reviewed' AND actor_id=$1
          AND entity_id IN (SELECT id FROM mo_deliverable_versions WHERE deliverable_id=$2)`, [ACTORS.leadA.id, did]);
    const rows = (await activity(pid)).filter((a) => a.action === "deliverable.version_reviewed");
    expect(rows.map((a) => [a.version_no, a.after?.review_comment ?? null])).toEqual([[2, null], [1, "Brighten the stage shots"]]);
    // Nothing else of the version leaks into the row.
    expect(Object.keys(rows[0])).not.toContain("v_review_comment");
  });

  it("another project's versions stay out", async () => {
    const other = await owned("Aftermovie");
    expect((await as("empA1", "POST", `/deliverables/${other.did}/versions`, drive("o"))).status).toBe(201);
    expect((await activity(pid)).some((a) => a.deliverable_title === "Aftermovie")).toBe(false);
  });

  it("lists the dispatch, with its recipient, and the archive", async () => {
    expect((await as("empA1", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(200);
    expect((await as("coord", "POST", `/deliverables/${did}/dispatch`,
      { recipient: "registrar@example.invalid", subject: "Photos" })).status).toBe(200);
    expect((await as("coord", "POST", `/deliverables/${did}/archive`, {})).status).toBe(200);
    const rows = await activity(pid);
    const sent = rows.find((a) => a.action === "deliverable.dispatched");
    expect(sent?.after?.recipient).toBe("registrar@example.invalid");
    expect(rows.some((a) => a.action === "deliverable.archived")).toBe(true);
  });
});

maybe("New project — a deliverable row that gives only its type", () => {
  it("is created, named after its type, numbered when repeated", async () => {
    const pid = await project([
      { deliverable_type_id: dtype }, { deliverable_type_id: dtype2 }, { deliverable_type_id: dtype },
      { title: "  " },                                   // a row nobody filled in is still skipped
    ]);
    const made = (await pool.query(
      `SELECT title, deliverable_type_id::int AS t, owner_id FROM mo_deliverables WHERE project_id=$1 ORDER BY id`, [pid])).rows;
    expect(made).toEqual([
      { title: dtypeName, t: dtype, owner_id: null },
      { title: dtype2Name, t: dtype2, owner_id: null },
      { title: `${dtypeName} (2)`, t: dtype, owner_id: null },
    ]);
  });

  it("an unknown type is still refused", async () => {
    const r = await as("coord", "POST", "/projects", {
      name: `${PX} Bad type`, project_type_id: projectTypeId, priority: "high",
      start_date: "2026-10-01", end_date: "2026-10-10", team_id: teamA,
      deliverables: [{ deliverable_type_id: 987654321 }],
    });
    expect([r.status, r.body.message]).toEqual([400, "Unknown deliverable type."]);
  });
});

maybe("project types — in the catalogue's order", () => {
  it("/state sends them by sort_order, then id", async () => {
    // Created last, ordered first: the order the page gets is the catalogue's, not the insert's.
    await pool.query(
      `INSERT INTO mo_project_types (name, slug, sort_order, is_active) VALUES ($1,$2,-1000,false)`,
      [`${PX} First In Catalogue`, `${PX}-first`]);
    const r = await as("admin", "GET", "/state");
    expect(r.status).toBe(200);
    const types = r.body.project_types as Array<{ id: number; sort_order: number; name: string }>;
    expect(types[0].name).toBe(`${PX} First In Catalogue`);
    const sorted = [...types].sort((a, b) => a.sort_order - b.sort_order || Number(a.id) - Number(b.id));
    expect(types.map((t) => t.id)).toEqual(sorted.map((t) => t.id));
  });
});

maybe("notices — read in plain words", () => {
  it("an older notice is shown without its rule code; the stored row is unchanged", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_notifications (user_id, kind, title, body, entity_type, entity_id)
       VALUES ($1,'reminder',$2,$3,'user',NULL) RETURNING id`,
      [ACTORS.empA1.id, "Daily report not submitted (AUTO-1)",
       "Log your tasks and submit today’s report (AUTO-1). See (BR-4, VR-2) (§3.1)."])).rows[0].id);
    const r = await as("empA1", "GET", "/notifications");
    expect(r.status).toBe(200);
    const n = (r.body.notifications as Array<{ id: number; title: string; body: string }>).find((x) => x.id === id);
    expect([n?.title, n?.body]).toEqual(["Daily report not submitted", "Log your tasks and submit today’s report. See."]);
    // Read-time only: the stored row keeps what it had.
    expect((await one(`SELECT body FROM mo_notifications WHERE id=$1`, [id])).body).toContain("(AUTO-1)");
  });
});

maybe("notices — the sign-off after delivery", () => {
  const titles = async (did: number) => (await pool.query(
    `SELECT title FROM mo_notifications WHERE user_id=$1 AND entity_type='deliverable' AND entity_id=$2 ORDER BY id`,
    [ACTORS.empA1.id, did])).rows.map((r) => String(r.title));

  it("is titled as a sign-off, apart from the version's approval", async () => {
    const { did } = await owned("Stage Photos");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("s1"))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    expect((await as("empA1", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
    const t = await titles(did);
    expect(t).toContain("Approved: Stage Photos");
    expect(t).toContain("Signed off: Stage Photos");
    expect(t).not.toContain("Deliverable approved");
  });

  it("a send-back after delivery says so", async () => {
    const { did } = await owned("Stage Video");
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("s2"))).status).toBe(201);
    expect((await as("leadA", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
    expect((await as("empA1", "POST", `/deliverables/${did}/deliver`, {})).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${did}/approval`,
      { approval_status: "changes_requested", note: "Trim the intro" })).status).toBe(200);
    expect(await titles(did)).toContain("Sent back after delivery: Stage Video");
  });
});
