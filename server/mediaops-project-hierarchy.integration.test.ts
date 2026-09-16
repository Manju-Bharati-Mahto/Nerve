// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Project → Team → Team Lead → Deliverable → Employee.

   The hierarchy this file defends: a Coordinator allocates work to a TEAM and
   stops there; the team's lead decides which of their people executes each
   deliverable. Before this change POST /projects did the opposite — it refused
   Coordinators outright (`isMoAdmin || isMoTL`), offered whoever the caller
   could already assign, and auto-applied a template pack of deliverables with
   owners attached.

   Two things are asserted throughout, because the UI cannot be trusted to
   enforce either:

     ROUTING   the lead is resolved from the team id server-side, so a forged
               owner_id or lead_user_id cannot put work on someone who does not
               lead that team.
     SCOPE     a Coordinator cannot name an individual at all, and a Team Lead
               cannot name someone outside their own team.

   The real route handlers are mounted on a throwaway express app, with the
   acting user chosen per request — so this exercises the code that ships, at
   the authorisation layer, not just the happy path.

   Fixtures are synthetic (ids prefixed `zph-`) and removed afterwards. No real
   project, deliverable or person is read or written.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PX = "zph";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

/* Who is acting. The express stand-in for the auth middleware reads the actor
   from a header so one app can exercise every role. */
const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media" },
  coord: { id: `${PX}-coord`, role: "user", team: "media" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media" },
  leadB: { id: `${PX}-leadB`, role: "sub_admin", team: "media" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media" },
  empA2: { id: `${PX}-empA2`, role: "user", team: "media" },
  empB1: { id: `${PX}-empB1`, role: "user", team: "media" },
} as const;
type ActorName = keyof typeof ACTORS;

let teamA = 0, teamB = 0, teamNoLead = 0, teamArchived = 0, teamDeadLead = 0;
let projectTypeId = 0, deliverableTypeId = 0;

async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

{
  const url = await realDatabaseUrl();
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

const newProject = (actor: ActorName, extra: Record<string, unknown> = {}) =>
  as(actor, "POST", "/projects", {
    name: `${PX} probe ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, start_date: "2026-10-01", end_date: "2026-10-10", ...extra,
  });

/** The calendar day a DATE column holds, independent of the driver's Date object. */
const dayOf = (v: unknown) => v instanceof Date
  ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`
  : String(v ?? "").slice(0, 10);

const projectRow = (id: number) =>
  pool.query(`SELECT * FROM mo_projects WHERE id=$1`, [id]).then((r) => r.rows[0]);
const deliverablesOf = (id: number) =>
  pool.query(`SELECT * FROM mo_deliverables WHERE project_id=$1 ORDER BY id`, [id]).then((r) => r.rows);

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media','active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status='active'`,
      [a.id, `ZPH ${name}`, `${a.id}@hierarchy.invalid`, a.role]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
       ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
      [a.id, name === "admin" ? "admin" : name === "coord" ? "coordinator"
        : name.startsWith("lead") ? "team_lead" : "employee"]);
  }
  // A lead who is removed, to prove their team stops being offered.
  await pool.query(
    `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
     VALUES ($1,'ZPH dead lead',$2,'sub_admin','media','archived','x','')
     ON CONFLICT (id) DO UPDATE SET status='archived'`, [`${PX}-deadlead`, `${PX}-deadlead@hierarchy.invalid`]);

  const mkTeam = async (name: string, lead: string | null, opts: { archived?: boolean; inactive?: boolean } = {}) =>
    Number((await pool.query(
      `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active, archived_at)
       VALUES (1,$1,$2,$3,$4) RETURNING id`,
      [`${PX} ${name}`, lead, !opts.inactive, opts.archived ? new Date() : null])).rows[0].id);

  teamA = await mkTeam("Team A", ACTORS.leadA.id);
  teamB = await mkTeam("Team B", ACTORS.leadB.id);
  teamNoLead = await mkTeam("No Lead", null);
  teamArchived = await mkTeam("Archived", ACTORS.leadA.id, { archived: true });
  teamDeadLead = await mkTeam("Dead Lead", `${PX}-deadlead`);

  for (const [t, u] of [[teamA, ACTORS.empA1.id], [teamA, ACTORS.empA2.id], [teamB, ACTORS.empB1.id]] as const)
    await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
                      ON CONFLICT DO NOTHING`, [t, u]);

  projectTypeId = Number((await pool.query(`SELECT id FROM mo_project_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).rows[0].id);
  deliverableTypeId = Number((await pool.query(`SELECT id FROM mo_deliverable_types WHERE archived_at IS NULL ORDER BY id LIMIT 1`)).rows[0].id);
}

async function cleanup() {
  await pool.query(`DELETE FROM mo_deliverables WHERE project_id IN (SELECT id FROM mo_projects WHERE name LIKE $1)`, [`${PX}%`]);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN (SELECT id FROM mo_projects WHERE name LIKE $1)`, [`${PX}%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_projects WHERE name LIKE $1`, [`${PX}%`]);
  await pool.query(`DELETE FROM mo_team_members WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

/* Snapshotted before anything is created and re-checked at the end. Identities,
   not counts: other integration files seed and drop their own projects around
   this one, so a total would be measuring a moving target. What §13 actually
   promises is that every row that was already there is still there, still owned
   by the same person and still in the same state. */
let before: Array<{ id: string; owner_id: string | null; status: string }> = [];
let beforeDelivs: Array<{ id: string; owner_id: string | null; status: string }> = [];

/* Real Nerve accounts are 'u-<ts>-<rand>' or the seeded 'mo-uN'. Every
   integration file's fixtures use a short prefix of their own (zph-, ai3t-,
   ztvit-, …), and those files run alongside this one — so scoping to genuine
   accounts is what makes this assertion about REAL data rather than about the
   suite's own churn. */
const REAL = `(created_by LIKE 'u-%' OR created_by LIKE 'mo-%')`;

beforeAll(async () => {
  if (!dbUp) return;
  await cleanup();
  await seed();
  before = (await pool.query(`SELECT id::text, owner_id, status FROM mo_projects WHERE ${REAL}`)).rows;
  beforeDelivs = (await pool.query(
    `SELECT d.id::text, d.owner_id, d.status FROM mo_deliverables d
       JOIN mo_projects p ON p.id = d.project_id WHERE ${REAL.replace(/created_by/g, "p.created_by")}`)).rows;
  await boot();
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── Who may create, and what routing does ────────────────────────────────── */

maybe("creating a project", () => {
  it("TEST 1 — an Admin creates one", async () => {
    const r = await newProject("admin", { team_id: teamA });
    expect(r.status).toBe(201);
  });

  it("TEST 2 — a Coordinator creates one (this used to 403)", async () => {
    const r = await newProject("coord", { team_id: teamA });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("TEST 7 — routing to a team makes that team's LEAD the owner and PM", async () => {
    const r = await newProject("coord", { team_id: teamB });
    const p = await projectRow(Number((r.body.project as Record<string, unknown>).id));
    expect(Number(p.team_id)).toBe(teamB);
    expect(p.owner_id).toBe(ACTORS.leadB.id);          // resolved from the team, not sent
    const pm = await pool.query(
      `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager`, [p.id]);
    expect(pm.rows.map((x) => x.user_id)).toEqual([ACTORS.leadB.id]);
  });

  it("tells the lead they are leading it, through the existing notification table", async () => {
    const r = await newProject("coord", { team_id: teamA });
    const n = await pool.query(
      `SELECT count(*)::int c FROM mo_notifications WHERE user_id=$1 AND entity_type='project' AND entity_id=$2`,
      [ACTORS.leadA.id, Number((r.body.project as Record<string, unknown>).id)]);
    expect(n.rows[0].c).toBe(1);
  });

  it("leaves a Coordinator's unrouted project OWNERLESS rather than on their own desk", async () => {
    // owner_id IS NULL is what the pipeline already reads as "needs assignment".
    const r = await newProject("coord");
    const p = await projectRow(Number((r.body.project as Record<string, unknown>).id));
    expect(p.owner_id).toBeNull();
    expect(p.team_id).toBeNull();
  });

  it("records the routing in the existing audit trail", async () => {
    const r = await newProject("coord", { team_id: teamA });
    const id = Number((r.body.project as Record<string, unknown>).id);
    const a = await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='project' AND entity_id=$1 ORDER BY id`, [id]);
    expect(a.rows.map((x) => x.action)).toEqual(
      expect.arrayContaining(["project.created", "project.team_assigned"]));
  });
});

/* ── Which teams may be routed to ─────────────────────────────────────────── */

maybe("TEST 3/5/6 — the team list is the live team structure", () => {
  it("accepts a team with an active lead", async () => {
    expect((await newProject("coord", { team_id: teamA })).status).toBe(201);
  });

  it("refuses a team with no lead", async () => {
    const r = await newProject("coord", { team_id: teamNoLead });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("no Team Lead");
  });

  it("TEST 5 — refuses a team whose lead has been removed", async () => {
    const r = await newProject("coord", { team_id: teamDeadLead });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("no longer active");
  });

  it("refuses an archived team", async () => {
    const r = await newProject("coord", { team_id: teamArchived });
    expect(r.status).toBe(400);
  });

  it("refuses a team id that does not exist", async () => {
    expect((await newProject("coord", { team_id: 99999999 })).status).toBe(400);
  });

  it("TEST 6 — a team created now is routable immediately, with nothing to configure", async () => {
    const fresh = Number((await pool.query(
      `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active) VALUES (1,$1,$2,true) RETURNING id`,
      [`${PX} Fresh Team`, ACTORS.leadA.id])).rows[0].id);
    const r = await newProject("coord", { team_id: fresh });
    expect(r.status).toBe(201);
    expect(Number((await projectRow(Number((r.body.project as Record<string, unknown>).id))).team_id)).toBe(fresh);
  });
});

/* ── The Coordinator never names a person ─────────────────────────────────── */

maybe("TEST 4/14 — individual assignment is not the Coordinator's to make", () => {
  it("refuses a Coordinator naming crew on the project", async () => {
    const r = await newProject("coord", { team_id: teamA, assignees: [ACTORS.empA1.id] });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain("Team Lead assigns individual crew");
  });

  it("refuses a Coordinator naming an owner on a deliverable", async () => {
    const r = await newProject("coord", {
      team_id: teamA,
      deliverables: [{ title: "Photography", deliverable_type_id: deliverableTypeId, owner_id: ACTORS.empA1.id }],
    });
    expect(r.status).toBe(403);
  });

  it("refuses a Coordinator forging owner_id on the project itself", async () => {
    expect((await newProject("coord", { team_id: teamA, owner_id: ACTORS.empA1.id })).status).toBe(403);
  });

  it("the Coordinator's assignable scope is themselves — never the directory", async () => {
    const r = await as("coord", "GET", "/members/assignable");
    expect((r.body.members as Array<{ id: string }>).map((m) => m.id)).toEqual([ACTORS.coord.id]);
  });

  it("TEST 14 — an employee cannot assign work to another employee", async () => {
    const created = await newProject("admin", { team_id: teamA,
      deliverables: [{ title: "Reel", deliverable_type_id: deliverableTypeId }] });
    const [d] = await deliverablesOf(Number((created.body.project as Record<string, unknown>).id));
    const r = await as("empA1", "PATCH", `/deliverables/${d.id}`, { owner_id: ACTORS.empA2.id });
    expect(r.status).toBe(403);
  });
});

/* ── Deliverables: generic, and unassigned until a lead says otherwise ─────── */

maybe("TEST 8/9/10 — deliverables are the creator's own words", () => {
  it("TEST 9 — a project starts with NO deliverables; no template is assumed", async () => {
    const r = await newProject("coord", { team_id: teamA });
    expect(r.body.deliverables_created).toBe(0);
    expect(await deliverablesOf(Number((r.body.project as Record<string, unknown>).id))).toHaveLength(0);
  });

  it("TEST 8/10 — arbitrary titles, several of them, created unassigned", async () => {
    const titles = ["Event Photography", "Aftermovie", "Drone Footage", "Subtitles"];
    const r = await newProject("coord", {
      team_id: teamA,
      deliverables: titles.map((title, i) => ({
        title, deliverable_type_id: deliverableTypeId,
        priority: i === 0 ? "high" : "normal", estimated_hours: 4 + i, due_date: "2026-10-20",
      })),
    });
    expect(r.status).toBe(201);
    expect(r.body.deliverables_created).toBe(4);
    const rows = await deliverablesOf(Number((r.body.project as Record<string, unknown>).id));
    expect(rows.map((d) => d.title)).toEqual(titles);
    expect(rows.every((d) => d.owner_id === null)).toBe(true);     // the whole point
    expect(rows[0].priority).toBe("high");
    expect(Number(rows[1].estimated_hours)).toBe(5);
  });

  it("skips empty rows and refuses an over-long title", async () => {
    const r = await newProject("coord", { team_id: teamA,
      deliverables: [{ title: "  ", deliverable_type_id: deliverableTypeId },
                     { title: "Real one", deliverable_type_id: deliverableTypeId }] });
    expect(r.body.deliverables_created).toBe(1);
    const bad = await newProject("coord", { team_id: teamA,
      deliverables: [{ title: "x".repeat(161), deliverable_type_id: deliverableTypeId }] });
    expect(bad.status).toBe(400);
  });

  it("refuses a forged deliverable type", async () => {
    const r = await newProject("coord", { team_id: teamA,
      deliverables: [{ title: "Forged", deliverable_type_id: 99999999 }] });
    expect(r.status).toBe(400);
  });

  it("still applies a template when one is explicitly asked for (§25)", async () => {
    const r = await newProject("admin", { team_id: teamA, apply_template: true });
    expect(r.status).toBe(201);
    expect(Number(r.body.deliverables_created)).toBeGreaterThanOrEqual(0);
  });
});

/* ── The Team Lead allocates ──────────────────────────────────────────────── */

maybe("TEST 11/12/13 — allocation belongs to the Team Lead", () => {
  let pid = 0, delivId = 0;

  beforeAll(async () => {
    if (!dbUp) return;
    const r = await newProject("coord", { team_id: teamA,
      deliverables: [{ title: "Photography", deliverable_type_id: deliverableTypeId }] });
    pid = Number((r.body.project as Record<string, unknown>).id);
    delivId = Number((await deliverablesOf(pid))[0].id);
  });

  it("TEST 12 — the lead's assignable people are their own team, and only theirs", async () => {
    const r = await as("leadA", "GET", "/members/assignable");
    const ids = (r.body.members as Array<{ id: string }>).map((m) => m.id).sort();
    expect(ids).toEqual([ACTORS.empA1.id, ACTORS.empA2.id, ACTORS.leadA.id].sort());
    expect(ids).not.toContain(ACTORS.empB1.id);
  });

  it("TEST 11 — the lead assigns the deliverable to one of their people", async () => {
    const r = await as("leadA", "PATCH", `/deliverables/${delivId}`, { owner_id: ACTORS.empA1.id });
    expect(r.status).toBe(200);
    expect((await deliverablesOf(pid))[0].owner_id).toBe(ACTORS.empA1.id);
  });

  it("refuses the lead reaching into another team", async () => {
    const r = await as("leadA", "PATCH", `/deliverables/${delivId}`, { owner_id: ACTORS.empB1.id });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain("your own team");
  });

  it("TEST 13 — the work reaches exactly one employee", async () => {
    const rows = await pool.query(
      `SELECT owner_id FROM mo_deliverables WHERE project_id=$1 AND owner_id IS NOT NULL`, [pid]);
    expect(rows.rows.map((r) => r.owner_id)).toEqual([ACTORS.empA1.id]);
  });

  it("reassignment stays inside the team and is auditable", async () => {
    const r = await as("leadA", "PATCH", `/deliverables/${delivId}`, { owner_id: ACTORS.empA2.id });
    expect(r.status).toBe(200);
    const a = await pool.query(
      `SELECT count(*)::int c FROM mo_audit_logs WHERE action='deliverable.updated' AND entity_id=$1`, [delivId]);
    expect(a.rows[0].c).toBeGreaterThan(0);
  });
});

/* ── Re-routing, and the promise that nothing else moved ──────────────────── */

maybe("re-routing a project to another team", () => {
  it("moves production ownership with it, resolved server-side", async () => {
    const r = await newProject("coord", { team_id: teamA });
    const id = Number((r.body.project as Record<string, unknown>).id);
    const moved = await as("coord", "PATCH", `/projects/${id}`, { team_id: teamB });
    expect(moved.status).toBe(200);
    const p = await projectRow(id);
    expect(Number(p.team_id)).toBe(teamB);
    expect(p.owner_id).toBe(ACTORS.leadB.id);
    const pm = await pool.query(
      `SELECT user_id FROM mo_project_assignments WHERE project_id=$1 AND is_project_manager`, [id]);
    expect(pm.rows.map((x) => x.user_id)).toEqual([ACTORS.leadB.id]);
  });

  it("refuses re-routing to a team that cannot take work", async () => {
    const r = await newProject("coord", { team_id: teamA });
    const id = Number((r.body.project as Record<string, unknown>).id);
    expect((await as("coord", "PATCH", `/projects/${id}`, { team_id: teamNoLead })).status).toBe(400);
  });
});

maybe("TEST 15/16 — everything that was already there is untouched", () => {
  it("TEST 15 — every project that existed still exists, same owner, same status", async () => {
    const now = new Map((await pool.query(`SELECT id::text, owner_id, status FROM mo_projects WHERE ${REAL}`)).rows
      .map((r) => [r.id, r]));
    const gone = before.filter((p) => !now.has(p.id)).map((p) => p.id);
    expect(gone, "projects disappeared").toEqual([]);
    const changed = before.filter((p) => {
      const n = now.get(p.id)!;
      return n.owner_id !== p.owner_id || n.status !== p.status;
    }).map((p) => p.id);
    expect(changed, "existing projects were re-owned or re-stated").toEqual([]);
  });

  it("TEST 16 — every deliverable that existed still exists, still assigned to the same person", async () => {
    /* The change makes NEW deliverables start unassigned. It must not have
       un-assigned a single existing one. */
    const now = new Map((await pool.query(
      `SELECT d.id::text, d.owner_id, d.status FROM mo_deliverables d
         JOIN mo_projects p ON p.id = d.project_id WHERE ${REAL.replace(/created_by/g, "p.created_by")}`)).rows
      .map((r) => [r.id, r]));
    const gone = beforeDelivs.filter((d) => !now.has(d.id)).map((d) => d.id);
    expect(gone, "deliverables disappeared").toEqual([]);
    const changed = beforeDelivs.filter((d) => {
      const n = now.get(d.id)!;
      return n.owner_id !== d.owner_id || n.status !== d.status;
    }).map((d) => d.id);
    expect(changed, "existing deliverables were re-owned or re-stated").toEqual([]);
  });

  it("leaves the template catalogue in place (§25)", async () => {
    const t = await pool.query(`SELECT count(*)::int c FROM mo_project_templates`);
    const i = await pool.query(`SELECT count(*)::int c FROM mo_template_deliverables`);
    expect(t.rows[0].c).toBeGreaterThan(0);
    expect(i.rows[0].c).toBeGreaterThan(0);
  });
});

/* ── The downstream systems still read what they always read ──────────────── */

maybe("TEST 17/18/19 — My Day, reporting and workload still resolve", () => {
  it("an assigned + scheduled deliverable reaches its owner's day", async () => {
    /* My Day is owner_id + scheduled_date. Allocation is what fills owner_id, so
       the chain from Team Lead to an employee's day must still close. */
    const r = await newProject("admin", { team_id: teamA,
      deliverables: [{ title: "Aftermovie", deliverable_type_id: deliverableTypeId }] });
    const pid = Number((r.body.project as Record<string, unknown>).id);
    const d = (await deliverablesOf(pid))[0];
    expect((await as("leadA", "PATCH", `/deliverables/${d.id}`, { owner_id: ACTORS.empA1.id })).status).toBe(200);
    expect((await as("leadA", "POST", `/deliverables/${d.id}/schedule`, { scheduled_date: "2026-10-05" })).status).toBe(200);
    const row = (await deliverablesOf(pid))[0];
    expect(row.owner_id).toBe(ACTORS.empA1.id);
    // A DATE column arrives as a JS Date; compare the calendar day that was stored.
    expect(dayOf(row.scheduled_date)).toBe("2026-10-05");
  });

  it("estimated effort survives to the deliverable, so workload can still sum it", async () => {
    const r = await newProject("admin", { team_id: teamA,
      deliverables: [{ title: "Photography", deliverable_type_id: deliverableTypeId, estimated_hours: 12 },
                     { title: "Aftermovie", deliverable_type_id: deliverableTypeId, estimated_hours: 32 }] });
    const rows = await deliverablesOf(Number((r.body.project as Record<string, unknown>).id));
    expect(rows.reduce((a, d) => a + Number(d.estimated_hours || 0), 0)).toBe(44);
    // Unallocated while nobody owns them — the team's pending allocation.
    expect(rows.every((d) => d.owner_id === null)).toBe(true);
  });
});
