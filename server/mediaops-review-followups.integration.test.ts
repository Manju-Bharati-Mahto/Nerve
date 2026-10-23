// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the follow-ups from the crew-workflow review.

   Each block is one place where two parts of the system disagreed about the
   same rule, or where a request a person can make answered wrongly:

     · cards are changed by Team Leads and Admins only — edits, archive and
       the checklist tick alike;
     · a priority outside urgent/high/normal/low is a 400 on every write;
     · marking work delivered is one rule on /deliver and on /status;
     · nobody signs off work they delivered themselves;
     · the review reminder fires once per pending version per reviewer;
     · a project's record and history are read by the people who may open it;
     · naming someone already on the crew as PM makes them PM;
     · what the server refuses with is plain words, without internal codes.

   Real route handlers on a throwaway express app, actor chosen per request.
   Fixtures are synthetic (`zfu-`) and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

const PX = "zfu";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const ACTORS = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media", full_name: "ZFU Admin" },
  coord: { id: `${PX}-coord`, role: "user", team: "media", full_name: "ZFU Coordinator" },
  leadA: { id: `${PX}-leadA`, role: "sub_admin", team: "media", full_name: "ZFU Lead A" },
  leadB: { id: `${PX}-leadB`, role: "sub_admin", team: "media", full_name: "ZFU Lead B" },
  empA1: { id: `${PX}-empA1`, role: "user", team: "media", full_name: "ZFU Emp A1" },
  empA2: { id: `${PX}-empA2`, role: "user", team: "media", full_name: "ZFU Emp A2" },
  empB1: { id: `${PX}-empB1`, role: "user", team: "media", full_name: "ZFU Emp B1" },
  gone: { id: `${PX}-gone`, role: "user", team: "media", full_name: "ZFU Former" },
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
const deliv = (id: number) => one(`SELECT * FROM mo_deliverables WHERE id=$1`, [id]);
const drive = (n: string | number) => ({ drive_url: `https://drive.google.com/${PX}-${n}` });
const titles = (who: ActorName, entityType: string, entityId: number) => pool.query(
  `SELECT title FROM mo_notifications WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3 ORDER BY id`,
  [ACTORS[who].id, entityType, entityId]).then((r) => r.rows.map((x) => String(x.title)));
const CODE = /\b(BR|VR|AUTO|FR)-\d/;

/** A project routed to `team` by the Coordinator, with one deliverable owned by `owner`. */
async function routed(team: number, owner: ActorName | null = "empA1") {
  const r = await as("coord", "POST", "/projects", {
    name: `${PX} Annual Cultural Festival ${Math.random().toString(36).slice(2, 8)}`,
    project_type_id: projectTypeId, priority: "high", description: "Student Affairs",
    start_date: "2026-10-01", end_date: "2026-10-10", team_id: team,
    deliverables: [{ title: "Edited Photos", deliverable_type_id: dtype }],
  });
  const pid = Number((r.body.project as Record<string, unknown>).id);
  const did = Number((await one(`SELECT id FROM mo_deliverables WHERE project_id=$1 ORDER BY id LIMIT 1`, [pid])).id);
  if (owner) await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS[owner].id, did]);
  return { pid, did };
}

/** A Team A deliverable owned by Emp A1, with an approved version. */
async function approved() {
  const { pid, did } = await routed(teamA);
  expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive(did))).status).toBe(201);
  expect((await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" })).status).toBe(200);
  return { pid, did };
}

async function seed() {
  for (const [name, a] of Object.entries(ACTORS)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,'media',$5,'x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, status=EXCLUDED.status`,
      [a.id, a.full_name, `${a.id}@review-followups.invalid`, a.role, name === "gone" ? "inactive" : "active"]);
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
  await pool.query(`DELETE FROM mo_requests WHERE event_name LIKE '${PX}%'`);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE '${PX}-%'`);
  await pool.query(`DELETE FROM mo_projects WHERE name LIKE '${PX}%'`);
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

/* ── Cards ─────────────────────────────────────────────────────────────────── */

maybe("cards — Team Leads and Admins change them, every way a card can change", () => {
  let board = 0, col = 0, cid = 0;
  beforeAll(async () => {
    board = Number((await one(`INSERT INTO mo_boards (name, is_management, created_by)
                               VALUES ($1, true, $2) RETURNING id`, [`${PX} War Room`, ACTORS.leadA.id])).id);
    col = Number((await one(`INSERT INTO mo_board_columns (board_id, name, sort_order) VALUES ($1,'Inbox',0) RETURNING id`,
      [board])).id);
    cid = Number((await one(`INSERT INTO mo_cards (board_id, column_id, title, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [board, col, `${PX} card`, ACTORS.leadA.id])).id);
    await pool.query(`INSERT INTO mo_card_checklist_items (card_id, text, sort_order) VALUES ($1,'Proof',0)`, [cid]);
  });

  it("an employee or the Coordinator cannot edit, archive or tick a card, and is told so plainly", async () => {
    for (const who of ["empA1", "coord"] as const) {
      const edit = await as(who, "PATCH", `/cards/${cid}`, { title: `${PX} renamed` });
      expect([edit.status, edit.body.message], who).toEqual([403, "Only a Team Lead or an Admin may change cards."]);
      expect((await as(who, "PATCH", `/cards/${cid}`, { archived: true })).status, who).toBe(403);
      expect((await as(who, "POST", `/cards/${cid}/checklist/0/toggle`)).status, who).toBe(403);
    }
    const c = await one(`SELECT title, archived_at FROM mo_cards WHERE id=$1`, [cid]);
    expect([c.title, c.archived_at]).toEqual([`${PX} card`, null]);
    expect((await one(`SELECT is_done FROM mo_card_checklist_items WHERE card_id=$1`, [cid])).is_done).toBe(false);
  });

  it("a Team Lead ticks the checklist", async () => {
    const r = await as("leadB", "POST", `/cards/${cid}/checklist/0/toggle`);
    expect([r.status, r.body.is_done]).toEqual([200, true]);
  });

  it("a priority outside urgent, high, normal and low is a 400 on cards and requests, never a 500", async () => {
    const msg = "Priority must be urgent, high, normal or low.";
    for (const priority of ["medium", null, ""]) {
      const r = await as("leadA", "PATCH", `/cards/${cid}`, { priority });
      expect([r.status, r.body.message], String(priority)).toEqual([400, msg]);
    }
    const add = await as("leadA", "POST", `/boards/${board}/cards`, { title: `${PX} new`, column_id: col, priority: "medium" });
    expect([add.status, add.body.message]).toEqual([400, msg]);
    expect((await as("leadA", "PATCH", `/cards/${cid}`, { priority: "high" })).status).toBe(200);
    expect((await one(`SELECT priority FROM mo_cards WHERE id=$1`, [cid])).priority).toBe("high");

    const req = await as("coord", "POST", "/requests", { event_name: `${PX} Alumni Meet` });
    const rid = Number((req.body.request as Record<string, unknown>).id);
    for (const priority of ["medium", null, ""]) {
      const r = await as("coord", "PATCH", `/requests/${rid}`, { priority });
      expect([r.status, r.body.message], String(priority)).toEqual([400, msg]);
    }
    expect((await as("coord", "PATCH", `/requests/${rid}`, { priority: "urgent" })).status).toBe(200);
  });
});

/* ── Delivering and signing off ───────────────────────────────────────────── */

maybe("delivered — one rule for who marks it, and nobody signs off their own hand-over", () => {
  it("a PM who is neither on the work nor the project's lead cannot mark it delivered by either route", async () => {
    const { pid, did } = await approved();
    // Emp B1 owns (runs) the project but is not on the deliverable and does not lead its team.
    await pool.query(`UPDATE mo_projects SET owner_id=$1 WHERE id=$2`, [ACTORS.empB1.id, pid]);
    const msg = "Only the people assigned to this deliverable, the project's Team Lead or an Admin may mark it delivered.";
    const viaStatus = await as("empB1", "POST", `/deliverables/${did}/status`, { status: "delivered" });
    const viaDeliver = await as("empB1", "POST", `/deliverables/${did}/deliver`);
    expect([viaStatus.status, viaStatus.body.message]).toEqual([403, msg]);
    expect([viaDeliver.status, viaDeliver.body.message]).toEqual([403, msg]);
    expect((await deliv(did)).status).toBe("approved");
    // The person doing the work still can, on the board as in the drawer.
    expect((await as("empA1", "POST", `/deliverables/${did}/status`, { status: "delivered" })).status).toBe(200);
  });

  it("the lead who marked it delivered cannot sign it off; another Team Lead can", async () => {
    const { did } = await approved();
    expect((await as("leadA", "POST", `/deliverables/${did}/deliver`)).status).toBe(200);
    const own = await as("leadA", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" });
    expect([own.status, own.body.message]).toEqual([403, "Someone else must sign off work you delivered."]);
    expect((await deliv(did)).approval_status).toBe("pending");
    expect((await as("leadB", "POST", `/deliverables/${did}/approval`, { approval_status: "approved" })).status).toBe(200);
  });
});

/* ── The review reminder ──────────────────────────────────────────────────── */

maybe("review reminder — once per pending version per reviewer", () => {
  it("is not sent again on later passes once it has been read", async () => {
    const rule = await one(`SELECT is_enabled FROM mo_automation_rules WHERE rule_key='AUTO-4'`);
    if (rule && !rule.is_enabled) return;
    const { runMediaOpsAutomations } = await import("./mediaops-api.js");
    const { did } = await routed(teamA);
    expect((await as("empA1", "POST", `/deliverables/${did}/versions`, drive("r1"))).status).toBe(201);
    await pool.query(`UPDATE mo_deliverable_versions SET submitted_at = NOW() - INTERVAL '25 hours' WHERE deliverable_id=$1`, [did]);
    await runMediaOpsAutomations();
    const reminders = async () => (await titles("leadA", "deliverable", did)).filter((t) => t === "Awaiting your review");
    expect(await reminders()).toHaveLength(1);
    await pool.query(`UPDATE mo_notifications SET is_read=true WHERE user_id=$1`, [ACTORS.leadA.id]);
    await runMediaOpsAutomations();
    await runMediaOpsAutomations();
    expect(await reminders()).toHaveLength(1);
  });
});

/* ── Who reads a project ──────────────────────────────────────────────────── */

maybe("project record and activity — read by the people who may open the project", () => {
  it("an employee off the project gets a 403; its people, the Coordinator and any Team Lead read it", async () => {
    const { pid } = await routed(teamA);
    for (const path of [`/projects/${pid}`, `/projects/${pid}/activity`]) {
      const off = await as("empB1", "GET", path);
      expect([off.status, off.body.message], path).toEqual([403, "You can only open projects you are working on."]);
      for (const who of ["empA1", "coord", "leadB", "leadA", "admin"] as const)
        expect((await as(who, "GET", path)).status, `${who} ${path}`).toBe(200);
    }
  });
});

/* ── PM ───────────────────────────────────────────────────────────────────── */

maybe("project crew — naming someone already on the crew as PM", () => {
  it("promotes them and tells them, instead of answering success with nobody made PM", async () => {
    const { pid } = await routed(teamA, null);
    await pool.query(`UPDATE mo_project_assignments SET is_project_manager=false WHERE project_id=$1`, [pid]);
    expect((await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA2.id })).body.added).toBe(true);
    const r = await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA2.id, is_project_manager: true });
    expect([r.status, r.body.added, r.body.promoted]).toEqual([201, false, true]);
    const row = await one(`SELECT is_project_manager FROM mo_project_assignments
                            WHERE project_id=$1 AND user_id=$2 AND removed_at IS NULL`, [pid, ACTORS.empA2.id]);
    expect(row.is_project_manager).toBe(true);
    expect(await titles("empA2", "project", pid)).toContain("You are the PM on a project");
    // Asking again changes nothing and tells nobody twice.
    const again = await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.empA2.id, is_project_manager: true });
    expect([again.status, again.body.added, !!again.body.promoted]).toEqual([201, false, false]);
    expect((await titles("empA2", "project", pid)).filter((t) => t === "You are the PM on a project")).toHaveLength(1);
  });
});

/* ── Refusals in plain words ──────────────────────────────────────────────── */

maybe("refusals — plain words, no internal codes", () => {
  it("the duplicate project, a bad link, a self-review, an archive and an unassignable person", async () => {
    const name = `${PX} Duplicate Fest ${Math.random().toString(36).slice(2, 8)}`;
    const body = { name, project_type_id: projectTypeId, priority: "high", start_date: "2026-10-01",
      end_date: "2026-10-10", team_id: teamA, deliverables: [{ title: "Edited Photos", deliverable_type_id: dtype }] };
    expect((await as("coord", "POST", "/projects", body)).status).toBe(201);
    const dup = await as("coord", "POST", "/projects", body);
    expect(dup.status).toBe(409);
    expect(String(dup.body.message)).toMatch(/^An identical project already exists/);

    const { pid, did } = await routed(teamA);
    const link = await as("empA1", "POST", `/deliverables/${did}/versions`, { drive_url: "https://example.com/x" });
    expect([link.status, link.body.message]).toEqual([400, "The link must be a Google Drive or Google Docs link."]);

    await pool.query(`INSERT INTO mo_team_members (team_id, user_id, is_primary) VALUES ($1,$2,false) ON CONFLICT DO NOTHING`,
      [teamA, ACTORS.leadB.id]);
    await pool.query(`UPDATE mo_deliverables SET owner_id=$1 WHERE id=$2`, [ACTORS.leadB.id, did]);
    expect((await as("leadB", "POST", `/deliverables/${did}/versions`, drive("self"))).status).toBe(201);
    const self = await as("leadB", "POST", `/deliverables/${did}/review`, { outcome: "approved" });
    expect(self.status).toBe(403);
    await pool.query(`DELETE FROM mo_team_members WHERE team_id=$1 AND user_id=$2`, [teamA, ACTORS.leadB.id]);

    const archive = await as("leadA", "POST", `/projects/${pid}/status`, { status: "archived" });
    const crew = await as("leadA", "POST", `/projects/${pid}/assignments`, { user_id: ACTORS.gone.id });
    expect([crew.status, crew.body.message]).toEqual([403, "That person is not an active member of the Media Crew."]);
    for (const r of [dup, link, self, archive, crew])
      expect(String(r.body.message)).not.toMatch(CODE);
  });
});

/* The routes above are samples. Every refusal and notice the API writes is a
   literal in these files, so none of them may carry an internal code. */
describe("refusals — no internal code in any message the server sends", () => {
  it("no sendError, message or notice text names BR-, VR-, AUTO- or FR- rules", () => {
    const offenders: string[] = [];
    for (const file of ["server/mediaops-api.ts", "server/equipment-rules.ts"]) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        // Comments, and a refusal's machine-readable `code` field, are not read by anyone.
        const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/code: "[^"]*"/g, "");
        if (/^\s*\*/.test(line)) return;
        if (/(sendError|message:|notify\(|throw new Error)/.test(code) && /["'`][^"'`]*\b(BR|VR|AUTO|FR)-\d[^"'`]*["'`]/.test(code))
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
