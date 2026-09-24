// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — what the bootstrap ships, and to whom.

   WHY THIS FILE EXISTS, STATED ACCURATELY. A product audit named one P0: that
   `GET /api/v1/media/state` returns every colleague's daily reports, task logs,
   leave requests, KRAs, KRA review scores and performance snapshots to any
   media-team session, with "no per-role WHERE clause", relying on the client to
   hide them.

   THAT FINDING IS WRONG, and this file is the proof. The handler has scoped
   those seven tables by role since before the audit was written — see the
   "§16 / AC-10 scoping (server-side, not just UI)" block in
   server/mediaops-api.ts, which resolves the caller's role, builds the set of
   people they may see, and filters daily_reports, report_tasks, leave_requests,
   leave_replacements, kras, kra_reviews and performance_snapshots against it.
   The audit read the STATE loop and stopped there; the filter is roughly 270
   lines further down the same handler.

   WHAT THE AUDIT GOT RIGHT is the part that made the mistake possible: of 52
   test files, none asserted what an Employee receives from /state. A protection
   with no test is a protection one refactor away from being gone, and nobody
   reading the loop could tell it was there. This file closes that gap and pins
   the rule at the boundary that enforces it.

   THE RULE IS THE PRODUCT'S OWN, and three places now agree on it:

     CAPS['report.view']   employee 'S' · team_lead 'T' · admin 'A' · coordinator 'S'
     assignableMemberIds() admin → all crew · lead → own team + self · else → self
     the /state scoping block, which is what these tests exercise

   Fixtures are prefixed `zst`.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zst";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let teamId = 0, cycleId = 0, leaveTypeId = 0, shootId = 0;

/* lead leads the team that member belongs to. other is media crew on nobody's
   team. coord is an employee carrying mo_role='coordinator'. smc is on the SMC
   team, which requireMedia() admits and moRoleOf() resolves to employee. */
const A = {
  admin:  { id: `${PX}-admin`,  role: "admin",     team: "media" },
  lead:   { id: `${PX}-lead`,   role: "sub_admin", team: "media" },
  member: { id: `${PX}-member`, role: "user",      team: "media" },
  other:  { id: `${PX}-other`,  role: "user",      team: "media" },
  coord:  { id: `${PX}-coord`,  role: "user",      team: "media" },
  smc:    { id: `${PX}-smc`,    role: "user",      team: "smc" },
} as const;
type ActorName = keyof typeof A;

{ const t = await connectTestDatabase(); pool = t.pool; dbUp = t.dbUp; }
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZST ${a.id}` }
      : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never, otpVerifyLimiter: noLimit as never,
    kioskPinLimiter: noLimit as never,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/media`;
}

/** The whole bootstrap, as that actor receives it. */
async function state(actor: ActorName) {
  const r = await fetch(`${base}/state`, { headers: { "x-actor": actor } });
  const body = await r.json() as Record<string, Array<Record<string, unknown>>>;
  return { status: r.status, body, raw: JSON.stringify(body) };
}

async function cleanup() {
  const like = [`${PX}-%`];
  await pool.query(`DELETE FROM mo_kra_reviews WHERE kra_id IN
                      (SELECT id FROM mo_kras WHERE user_id LIKE $1)`, like);
  await pool.query(`DELETE FROM mo_kras WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_kra_cycles WHERE label LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_report_tasks WHERE daily_report_id IN
                      (SELECT id FROM mo_daily_reports WHERE user_id LIKE $1)`, like);
  await pool.query(`DELETE FROM mo_daily_reports WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_leave_replacements WHERE leave_request_id IN
                      (SELECT id FROM mo_leave_requests WHERE user_id LIKE $1)`, like);
  await pool.query(`DELETE FROM mo_leave_requests WHERE user_id LIKE $1 OR replacement_user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_performance_snapshots WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_saved_views WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_shoots WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_projects WHERE code LIKE $1`, like);
  await pool.query(`DELETE FROM mo_team_members WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM mo_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, like);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, like);
}

/** One person's full set of personal records, so every table can be checked. */
async function plant(id: string) {
  const rep = Number((await pool.query(
    `INSERT INTO mo_daily_reports (user_id, report_date, status, total_minutes, note)
     VALUES ($1, CURRENT_DATE - (abs(hashtext($1)) % 20), 'approved', 300, $2) RETURNING id`,
    [id, `${PX} note for ${id}`])).rows[0].id);
  await pool.query(
    `INSERT INTO mo_report_tasks (daily_report_id, description, minutes)
     VALUES ($1, $2, 300)`, [rep, `${PX} task for ${id}`]);
  const lv = Number((await pool.query(
    `INSERT INTO mo_leave_requests (user_id, leave_type_id, starts_on, ends_on, day_type, reason, status)
     VALUES ($1, $2, CURRENT_DATE + 30, CURRENT_DATE + 31, 'full', $3, 'pending') RETURNING id`,
    [id, leaveTypeId, `${PX} private reason for ${id}`])).rows[0].id);
  const kra = Number((await pool.query(
    `INSERT INTO mo_kras (kra_cycle_id, user_id, title, metric_source, weight)
     VALUES ($1, $2, $3, 'manual', 100) RETURNING id`,
    [cycleId, id, `${PX} objective for ${id}`])).rows[0].id);
  /* Reviewed BY THE LEAD in every case, so a scope built on reviewer_id rather
     than on whose KRA it is would be caught. */
  await pool.query(
    `INSERT INTO mo_kra_reviews (kra_id, phase, score, comment, reviewer_id)
     VALUES ($1, 'manager', 4, $2, $3)`, [kra, `${PX} score note for ${id}`, A.lead.id]);
  await pool.query(
    `INSERT INTO mo_performance_snapshots (user_id, month, hours_logged, tasks_count)
     VALUES ($1, date_trunc('month', CURRENT_DATE)::date, 120, 9)`, [id]);
  return { rep, lv, kra };
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
  await bootstrapMediaOpsDatabase();
  await cleanup();

  for (const a of Object.values(A))
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZST ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  for (const a of Object.values(A))
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZST',$2,$3::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET mo_role=EXCLUDED.mo_role, allowed_modules=EXCLUDED.allowed_modules`,
      [a.id, a.id === A.coord.id ? "coordinator" : "employee",
       JSON.stringify(["home", "my-day", "reports", "leave", "kra", "performance"])]);

  teamId = Number((await pool.query(
    `INSERT INTO mo_teams (department_id, name, lead_user_id, is_active)
     VALUES (1, $1, $2, true) RETURNING id`, [`${PX} Team`, A.lead.id])).rows[0].id);
  await pool.query(
    `INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)`,
    [teamId, A.member.id]);

  leaveTypeId = Number((await pool.query(
    `SELECT id FROM mo_leave_types ORDER BY id LIMIT 1`)).rows[0].id);

  cycleId = Number((await pool.query(
    `INSERT INTO mo_kra_cycles (label, starts_on, ends_on, status)
     VALUES ($1, CURRENT_DATE - 60, CURRENT_DATE + 30, 'active') RETURNING id`,
    [`${PX} Cycle`])).rows[0].id);

  for (const a of [A.lead, A.member, A.other, A.coord, A.smc]) await plant(a.id);

  /* `other` goes on leave and names `member` as the replacement: the one row of
     somebody else's leave a colleague is meant to see. */
  const cover = Number((await pool.query(
    `INSERT INTO mo_leave_requests (user_id, leave_type_id, starts_on, ends_on, day_type, reason, status, replacement_user_id)
     VALUES ($1, $2, CURRENT_DATE + 60, CURRENT_DATE + 61, 'full', $3, 'approved', $4) RETURNING id`,
    [A.other.id, leaveTypeId, `${PX} covered absence`, A.member.id])).rows[0].id);
  /* A replacement covers a SHOOT, so the row needs one. The project and shoot
     below exist only to give it something real to point at. */
  const projId = Number((await pool.query(
    `INSERT INTO mo_projects (project_type_id, code, name, created_by, status)
     VALUES ((SELECT id FROM mo_project_types ORDER BY id LIMIT 1), $1, $2, $3, 'in_production')
     RETURNING id`, [`${PX}-P1`, `${PX} Cover Project`, A.admin.id])).rows[0].id);
  shootId = Number((await pool.query(
    `INSERT INTO mo_shoots (project_id, title, shoot_date, notes, status)
     VALUES ($1, $2, CURRENT_DATE + 60, '', 'planned') RETURNING id`,
    [projId, `${PX} Cover Shoot`])).rows[0].id);
  await pool.query(
    `INSERT INTO mo_leave_replacements (leave_request_id, shoot_id, replacement_user_id)
     VALUES ($1,$2,$3)`, [cover, shootId, A.member.id]);

  await pool.query(
    `INSERT INTO mo_saved_views (user_id, module, name, filters, is_shared)
     VALUES ($1,'projects',$2,'{}'::jsonb,false), ($3,'projects',$4,'{}'::jsonb,true)`,
    [A.other.id, `${PX} private view`, A.other.id, `${PX} shared view`]);

  await boot();
}, 90_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* WHO A ROW IS ABOUT, RESOLVED THE WAY THE CLIENT RESOLVES IT.

   /state rewrites user-reference columns through a {real id → prototype
   integer} map built from the media crew, so `user_id` arrives as 901 for a
   crew member and as the untouched string for anybody off the crew (an SMC
   member). The payload carries the map itself, in `users[].real_id`, which is
   exactly what the browser joins on — so the test resolves ids the same way
   rather than assuming either shape. */
type State = { body: Record<string, Array<Record<string, unknown>>> };
const owners = (s: State, key: string, col = "user_id"): Set<string> => {
  const toReal = new Map<string, string>();
  for (const u of (s.body.users ?? [])) toReal.set(String(u.id), String(u.real_id ?? u.id));
  return new Set((s.body[key] ?? [])
    .map((r) => toReal.get(String(r[col])) ?? String(r[col]))
    .filter((v) => v.startsWith(PX)));
};

maybe("the bootstrap ships one person's records to that person", () => {
  it("gives an employee their own reports and nobody else's", async () => {
    const s = await state("member");
    expect(s.status).toBe(200);
    const users = owners(s, "daily_reports");
    expect(users, "an employee received a colleague's daily report").toEqual(new Set([A.member.id]));
  });

  it("does not put a colleague's leave reason in the payload at all", async () => {
    /* The strongest form of the assertion: not "the client hides it" but "the
       bytes are not there". */
    const s = await state("member");
    expect(s.raw).toContain(`${PX} private reason for ${A.member.id}`);
    for (const who of [A.other.id, A.lead.id, A.coord.id])
      expect(s.raw, `${who}'s leave reason was in an employee's payload`)
        .not.toContain(`${PX} private reason for ${who}`);
  });

  it("scopes task logs by the report that owns them, not by their own table", async () => {
    const s = await state("member");
    const tasks = (s.body.report_tasks ?? [])
      .filter((r) => String(r.description ?? "").startsWith(PX));
    expect(tasks.length).toBe(1);
    expect(String(tasks[0].description)).toBe(`${PX} task for ${A.member.id}`);
  });

  it("scopes a KRA review by whose objective it scores, not by who wrote it", async () => {
    /* Every review in these fixtures was written by the lead. A scope built on
       reviewer_id would hand an employee every score the lead ever gave. */
    const s = await state("member");
    expect(s.raw).toContain(`${PX} score note for ${A.member.id}`);
    for (const who of [A.other.id, A.lead.id])
      expect(s.raw, `a review of ${who}'s objective reached an employee`)
        .not.toContain(`${PX} score note for ${who}`);
  });

  it("gives an employee their own performance snapshot only", async () => {
    const s = await state("member");
    const users = owners(s, "performance_snapshots");
    expect(users).toEqual(new Set([A.member.id]));
  });

  it("scopes leave by whose leave it is, including a request that names a replacement", async () => {
    /* CURRENT BEHAVIOUR, PINNED RATHER THAN CHANGED. The rule is "whose row is
       it", so a request belonging to somebody else does not reach the person
       named as their replacement — not even the dates. Whether a replacement
       should see the absence they are covering is a product question, recorded
       as such; this test exists so the answer is a decision and not a drift. */
    const s = await state("member");
    expect(s.raw, "somebody else's leave row reached a colleague")
      .not.toContain(`${PX} covered absence`);
    /* The replacement LINK row is scoped to the visible leave requests, so it
       does not arrive orphaned either. */
    const reps = (s.body.leave_replacements ?? []);
    expect(reps.some((r) => String(r.shoot_id ?? "") === String(shootId)),
      "a replacement row arrived without the leave request it belongs to").toBe(false);
  });

  it("treats the Operations Coordinator as an employee, as the capability table does", async () => {
    const s = await state("coord");
    const users = owners(s, "daily_reports");
    expect(users).toEqual(new Set([A.coord.id]));
  });

  it("treats an SMC member the same way", async () => {
    const s = await state("smc");
    const users = owners(s, "daily_reports");
    expect(users).toEqual(new Set([A.smc.id]));
    expect(s.raw).not.toContain(`${PX} private reason for ${A.other.id}`);
  });

  it("gives a saved view to its owner or to everybody it was shared with", async () => {
    const s = await state("member");
    const names = (s.body.saved_views ?? []).map((r) => String(r.name ?? ""))
      .filter((n) => n.startsWith(PX));
    expect(names).toContain(`${PX} shared view`);
    expect(names, "a private saved view reached another user").not.toContain(`${PX} private view`);
  });
});

maybe("a Team Lead sees their own team and no further", () => {
  it("receives the reports of the people they lead, and their own", async () => {
    const s = await state("lead");
    const users = owners(s, "daily_reports");
    expect(users).toEqual(new Set([A.lead.id, A.member.id]));
  });

  it("does not receive the records of somebody on no team of theirs", async () => {
    const s = await state("lead");
    for (const key of ["kras", "performance_snapshots"])
      expect(owners(s, key),
        `${key} leaked outside the lead's team`).toEqual(new Set([A.lead.id, A.member.id]));
    expect(s.raw).not.toContain(`${PX} private reason for ${A.other.id}`);
    expect(s.raw).not.toContain(`${PX} score note for ${A.other.id}`);
  });
});

maybe("an Admin's bootstrap is unchanged", () => {
  it("still receives every person's records", async () => {
    const s = await state("admin");
    const users = owners(s, "daily_reports");
    for (const a of [A.lead, A.member, A.other, A.coord, A.smc])
      expect(users, `the admin lost ${a.id}'s report`).toContain(a.id);
    for (const who of [A.other.id, A.smc.id])
      expect(s.raw).toContain(`${PX} private reason for ${who}`);
  });

  it("keeps rows belonging to people outside the media crew", async () => {
    /* Scoping the admin through assignableMemberIds() would have dropped the
       SMC member's records, because that helper lists team='media' only. The
       admin is deliberately not scoped at all. */
    const s = await state("admin");
    expect(owners(s, "performance_snapshots")).toContain(A.smc.id);
  });
});

maybe("scoping the read model did not narrow anything else", () => {
  it("leaves departmental tables identical for an employee and an admin", async () => {
    /* Production history is departmental knowledge. A security fix that also
       emptied the project registry for employees would be a regression wearing
       a fix's clothes. */
    const emp = await state("member"), adm = await state("admin");
    for (const key of ["projects", "deliverables", "project_types", "task_categories",
                       "teams", "duty_flags", "holidays", "equipment_categories"])
      expect(emp.body[key]?.length, `${key} shrank for an employee`)
        .toBe(adm.body[key]?.length);
  });

  it("still returns every table the client bootstraps from", async () => {
    const emp = await state("member"), adm = await state("admin");
    expect(Object.keys(emp.body).sort()).toEqual(Object.keys(adm.body).sort());
  });
});
