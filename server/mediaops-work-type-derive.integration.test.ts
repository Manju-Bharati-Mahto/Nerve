// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Assign work has no work-type choice: the deliverable is it.

     Derived        POST /projects/:id/work with new_deliverable or
                    deliverable_id stores the deliverable TYPE's work type
                    (mo_deliverable_types.work_type_id), whatever the client
                    sent; an unset (or retired) one is General Task.
     Shoot          a shoot produces no deliverable — sent with one, refused.
     No deliverable the kind is required and must be an active work type.
     Mapping        seeded once by slug/name, shipped in /state, and editable
                    in Settings → Deliverable types by an Admin only.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zwd-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const PX = "zwd";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZWD Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZWD Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZWD Lead A" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZWD Emp A1" },
  empOut: { id: `${PX}-empOut`, role: "user", team: "media", full_name: "ZWD Emp Outside" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, projectTypeId = 0;
/* Work types by name, and this suite's own deliverable types. */
const WT: Record<string, number> = {};
let shootType = 0, retiredType = 0;
let editType = 0, rawVideoType = 0, unmappedType = 0, retiredMapType = 0;

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
const storedType = (r: { body: Record<string, unknown> }) =>
  Number((r.body.assignment as Record<string, unknown>).work_type_id);

/** A project routed to Team A by the Coordinator, with one deliverable of `type`. */
async function project(type: number) {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Science Fair ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "normal", description: "Student Affairs",
    start_date: "2026-11-01", end_date: "2026-11-05", team_id: teamA,
    deliverables: [{ title: "Coverage", deliverable_type_id: type }],
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const pid = Number((r.body.project as Record<string, unknown>).id);
  const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1 ORDER BY id LIMIT 1`, [pid])).id);
  return { pid, did };
}

const work = (pid: number, extra: Record<string, unknown>, actor: ActorName = "leadA") =>
  as(actor, "POST", `/projects/${pid}/work`, { title: `${PX} work`, assignees: [ACTORS.empA1.id], ...extra });

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, a.full_name, `${a.id}@work-type-derive.invalid`, a.role]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
       ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
      [a.id, name === "admin" ? "admin" : name === "coord" ? "coordinator" : name === "leadA" ? "team_lead" : "employee"]);
  }
  teamA = Number((await one(
    `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
    [`${PX} Event Team`, ACTORS.leadA.id])).id);
  await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true) ON CONFLICT DO NOTHING`,
    [teamA, ACTORS.empA1.id]);
  projectTypeId = Number((await one(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).id);
  for (const r of (await pool.query(`SELECT id, name FROM mo_work_types WHERE is_active AND archived_at IS NULL`)).rows)
    WT[String(r.name).toLowerCase()] = Number(r.id);
  shootType = Number((await one(
    `SELECT id FROM mo_work_types WHERE is_active AND archived_at IS NULL AND form_template='shoot' ORDER BY id LIMIT 1`)).id);
  retiredType = Number((await one(
    `INSERT INTO mo_work_types (name, slug, form_template, is_active) VALUES ($1,$2,'standard_task',false) RETURNING id`,
    [`${PX} Retired Work`, `${PX}-retired`])).id);
  const dt = async (name: string, wt: number | null) => Number((await one(
    `INSERT INTO mo_deliverable_types (department_id, name, slug, default_unit, work_type_id)
     VALUES (1,$1,$2,'items',$3) RETURNING id`,
    [`${PX} ${name}`, `${PX}-${name.toLowerCase().replace(/\W+/g, "-")}`, wt])).id);
  editType = await dt("Edit Type", WT["editing"]);
  rawVideoType = await dt("Raw Video Type", WT["videography"]);
  unmappedType = await dt("Unmapped Type", null);
  retiredMapType = await dt("Retired Map Type", retiredType);
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
  await pool.query(`DELETE FROM mo_deliverable_types WHERE name LIKE '${PX} %'`);
  await pool.query(`DELETE FROM mo_work_types WHERE name LIKE '${PX} %'`);
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

maybe("the catalogue says what each deliverable type counts as", () => {
  it("is seeded by slug: raw photos are Photography, raw video Videography, edits Editing, the rest General Task", async () => {
    const rows = (await pool.query(
      `SELECT dt.slug, lower(wt.name) AS wt FROM mo_deliverable_types dt LEFT JOIN mo_work_types wt ON wt.id=dt.work_type_id
        WHERE dt.slug IN ('photos-raw','video-raw','continuous','drone','photos-edited','video-edited','aftermovie',
                          'highlight-reel','reel','album','story','outreach','raw-archive','other')`)).rows;
    const by = Object.fromEntries(rows.map((r) => [r.slug, r.wt]));
    expect(by).toMatchObject({
      "photos-raw": "photography", "video-raw": "videography", continuous: "videography", drone: "videography",
      "photos-edited": "editing", "video-edited": "editing", aftermovie: "editing", "highlight-reel": "editing",
      reel: "editing", album: "editing", story: "editing",
      outreach: "general task", "raw-archive": "general task", other: "general task",
    });
    // Meeting and Script Writing are their own kinds of work.
    expect(WT["meeting"]).toBeGreaterThan(0);
    expect(WT["script writing"]).toBeGreaterThan(0);
  });

  it("ships the mapping in /state", async () => {
    const s = await as("empA1", "GET", "/state");
    const row = (s.body.deliverable_types as Array<Record<string, unknown>>).find((t) => Number(t.id) === editType);
    expect(Number(row?.work_type_id)).toBe(WT["editing"]);
  });
});

maybe("Assign work with a deliverable is logged as the deliverable's type", () => {
  it("a new deliverable: no work type sent, its type's is stored", async () => {
    const { pid } = await project(editType);
    const r = await work(pid, { new_deliverable: { deliverable_type_id: rawVideoType } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(storedType(r)).toBe(WT["videography"]);
    expect((r.body.work_type as Record<string, unknown>).name).toBe("Videography");
    const row = await one(`SELECT work_type_id FROM mo_assignments WHERE id=$1`,
      [(r.body.assignment as Record<string, unknown>).id]);
    expect(Number(row.work_type_id)).toBe(WT["videography"]);
  });

  it("an existing deliverable: its type's work type is stored", async () => {
    const { pid, did } = await project(editType);
    const r = await work(pid, { deliverable_id: did });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(storedType(r)).toBe(WT["editing"]);
  });

  it("a work type the client sends alongside is not used — the deliverable decides", async () => {
    const { pid, did } = await project(editType);
    const a = await work(pid, { work_type_id: WT["meeting"], new_deliverable: { deliverable_type_id: editType } });
    expect(a.status).toBe(201);
    expect(storedType(a)).toBe(WT["editing"]);
    const b = await work(pid, { work_type_id: WT["meeting"], deliverable_id: did });
    expect(b.status).toBe(201);
    expect(storedType(b)).toBe(WT["editing"]);
  });

  it("a shoot sent with a deliverable is refused, and nothing is made", async () => {
    const { pid, did } = await project(editType);
    const before = Number((await one(`SELECT COUNT(*)::int n FROM mo_deliverables WHERE project_id=$1`, [pid])).n);
    for (const extra of [{ new_deliverable: { deliverable_type_id: editType } }, { deliverable_id: did }]) {
      const r = await work(pid, { work_type_id: shootType, shoot_date: "2026-11-02", ...extra });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("A shoot is scheduled on its own — choose No deliverable.");
    }
    expect(Number((await one(`SELECT COUNT(*)::int n FROM mo_deliverables WHERE project_id=$1`, [pid])).n)).toBe(before);
    expect((await one(`SELECT COUNT(*)::int n FROM mo_assignments WHERE project_id=$1`, [pid])).n).toBe(0);
  });

  it("a type that counts as nothing — or as a retired work type — is General Task", async () => {
    const { pid } = await project(editType);
    const a = await work(pid, { new_deliverable: { deliverable_type_id: unmappedType } });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(storedType(a)).toBe(WT["general task"]);
    const b = await work(pid, { new_deliverable: { deliverable_type_id: retiredMapType } });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(storedType(b)).toBe(WT["general task"]);
  });

  it("who may assign is unchanged: someone outside the project is refused", async () => {
    const { pid } = await project(editType);
    const r = await work(pid, { new_deliverable: { deliverable_type_id: editType } }, "empOut");
    expect(r.status).toBe(403);
  });
});

maybe("Assign work with no deliverable names its kind", () => {
  it("without one it is refused in plain words", async () => {
    const { pid } = await project(editType);
    const r = await work(pid, {});
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("Choose the kind of work.");
  });

  it("a Meeting or Script Writing is stored as itself", async () => {
    const { pid } = await project(editType);
    for (const name of ["meeting", "script writing"]) {
      const r = await work(pid, { work_type_id: WT[name] });
      expect(r.status, name).toBe(201);
      expect(storedType(r), name).toBe(WT[name]);
      expect(r.body.deliverable).toBeNull();
    }
  });

  it("a disabled work type is refused", async () => {
    const { pid } = await project(editType);
    const r = await work(pid, { work_type_id: retiredType });
    expect(r.status).toBe(400);
  });

  it("a shoot kind still schedules a shoot", async () => {
    const { pid } = await project(editType);
    const r = await as("leadA", "POST", `/projects/${pid}/work`,
      { work_type_id: shootType, title: `${PX} shoot`, shoot_date: "2026-11-02", crew: [ACTORS.empA1.id] });
    expect(r.status).toBe(201);
    expect(r.body.kind).toBe("shoot");
  });
});

maybe("Settings → Deliverable types → Counts as", () => {
  const patch = (actor: ActorName, id: number, body: Record<string, unknown>) =>
    as(actor, "PATCH", `/crud/deliverable_types/${id}`, body);

  it("offers active standard work types only", async () => {
    const m = await as("admin", "GET", "/crud/meta");
    const mod = (m.body.modules as Array<Record<string, unknown>>).find((x) => x.key === "deliverable_types")!;
    const f = (mod.fields as Array<Record<string, unknown>>).find((x) => x.name === "work_type_id")!;
    expect(f.label).toBe("Counts as");
    const ids = (f.options2 as Array<{ v: number }>).map((o) => o.v);
    expect(ids).toContain(WT["editing"]);
    expect(ids).toContain(WT["meeting"]);
    expect(ids).not.toContain(shootType);
    expect(ids).not.toContain(retiredType);
  });

  it("an Admin changes it, and Assign work follows", async () => {
    const r = await patch("admin", unmappedType, { work_type_id: WT["photography"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Number((r.body.row as Record<string, unknown>).work_type_id)).toBe(WT["photography"]);
    const { pid } = await project(editType);
    const w = await work(pid, { new_deliverable: { deliverable_type_id: unmappedType } });
    expect(storedType(w)).toBe(WT["photography"]);
    await patch("admin", unmappedType, { work_type_id: "" });
    expect((await one(`SELECT work_type_id FROM mo_deliverable_types WHERE id=$1`, [unmappedType])).work_type_id).toBeNull();
  });

  it("refuses a shoot or a disabled work type", async () => {
    for (const v of [shootType, retiredType]) {
      const r = await patch("admin", editType, { work_type_id: v });
      expect(r.status).toBe(400);
      expect(r.body.message).toBe("Counts as must be an active work type that is not a shoot.");
    }
    expect(Number((await one(`SELECT work_type_id FROM mo_deliverable_types WHERE id=$1`, [editType])).work_type_id))
      .toBe(WT["editing"]);
  });

  it("a Team Lead may edit the type but not what it counts as", async () => {
    const r = await patch("leadA", editType, { work_type_id: WT["meeting"] });
    expect(r.status).toBe(403);
    expect(Number((await one(`SELECT work_type_id FROM mo_deliverable_types WHERE id=$1`, [editType])).work_type_id))
      .toBe(WT["editing"]);
    // Saving the form as it stands — the mapping unchanged — is fine.
    const ok = await patch("leadA", editType, { name: `${PX} Edit Type`, default_unit: "cuts", work_type_id: WT["editing"] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const made = await as("leadA", "POST", "/crud/deliverable_types", { name: `${PX} Lead Made`, default_unit: "items", work_type_id: WT["editing"] });
    expect(made.status).toBe(403);
    const plain = await as("leadA", "POST", "/crud/deliverable_types", { name: `${PX} Lead Plain`, default_unit: "items" });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    const byAdmin = await as("admin", "POST", "/crud/deliverable_types", { name: `${PX} Admin Made`, default_unit: "items", work_type_id: WT["editing"] });
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(201);
    expect(Number((byAdmin.body.row as Record<string, unknown>).work_type_id)).toBe(WT["editing"]);
  });
});
