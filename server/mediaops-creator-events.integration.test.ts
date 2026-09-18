// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 2: events → opportunity → interest →
   selection → assignment → task.

   The rule the phase turns on, and the one these tests exist to defend:
   INTEREST IS NOT ASSIGNMENT. A creator raising a hand is a claim; being
   chosen is somebody's decision; the assignment is its consequence. Three
   records, three actors, three timestamps — so months later the network can
   still answer who applied, who was chosen, and who was passed over.

   Two seams carry all the risk and get most of the attention here:

     OWNERSHIP    interest and task transitions are written from the SESSION.
                  There is no creator_id in those payloads to forge, which is
                  stronger than checking one.
     TRANSITIONS  the client names a transition, never a status, and a flow
                  table decides whether it is legal and who may make it. In
                  particular nothing leads out of 'declined'.

   Real handlers, real database. Fixtures are `zce-` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PX = "zce";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let teamA = 0, teamB = 0;

const A = {
  nerveAdmin:   { id: `${PX}-nadmin`, role: "admin", team: "media",   cr: null },
  mediaEmp:     { id: `${PX}-memp`,   role: "user",  team: "media",   cr: null },
  creatorAdmin: { id: `${PX}-cadmin`, role: "user",  team: "media",   cr: "creator_admin" },
  leadA:        { id: `${PX}-leadA`,  role: "user",  team: "creator", cr: "team_lead" },
  leadB:        { id: `${PX}-leadB`,  role: "user",  team: "creator", cr: "team_lead" },
  c1:           { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  c2:           { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  cB:           { id: `${PX}-cB`,     role: "user",  team: "creator", cr: "creator" },
  suspended:    { id: `${PX}-susp`,   role: "user",  team: "creator", cr: "creator" },
  archived:     { id: `${PX}-arch`,   role: "user",  team: "creator", cr: "creator" },
} as const;
type ActorName = keyof typeof A;

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
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a ? { id: a.id, role: a.role, team: a.team } : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
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
async function as(actor: ActorName | "anon", method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await fetch(base + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

/** An event with one open opportunity — the starting point for most tests. */
async function openOpportunity(required = 2, extra: Record<string, unknown> = {}) {
  const ev = await as("creatorAdmin", "POST", "/creator/events",
    { title: `${PX} Navratri ${Math.random().toString(36).slice(2, 7)}`, event_date: "2026-10-20",
      venue: "Campus Ground" });
  const eventId = Number(ev.body.id);
  const op = await as("creatorAdmin", "POST", "/creator/opportunities",
    { event_id: eventId, title: "Reel Creator", creator_type: "Reels", required_count: required,
      task_deadline: "2026-10-22", ...extra });
  const oppId = Number(op.body.id);
  await as("creatorAdmin", "PATCH", `/creator/events/${eventId}`, { status: "open" });
  await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`, { status: "open" });
  return { eventId, oppId };
}

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCE ${a.id}`, `${a.id}@cevt.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
        [a.id, a.role === "admin" ? "admin" : "employee"]);
    if (a.cr) {
      const st = a.id === A.suspended.id ? "suspended" : a.id === A.archived.id ? "archived" : "active";
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET creator_role=EXCLUDED.creator_role, status=EXCLUDED.status`,
        [a.id, a.cr, st]);
    }
  }
  const mk = async (n: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} ${n}`, lead])).rows[0].id);
  teamA = await mk("Reels Team", A.leadA.id);
  teamB = await mk("Vlog Team", A.leadB.id);
  for (const [t, u] of [[teamA, A.c1.id], [teamA, A.c2.id], [teamA, A.leadA.id],
                        [teamB, A.cB.id], [teamB, A.leadB.id],
                        [teamA, A.suspended.id], [teamA, A.archived.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);
}

async function cleanup() {
  await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_events WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  const db = await import("./mediaops-db.js");
  await db.bootstrapCreatorNetwork();
  api = await import("./mediaops-api.js");
  await cleanup(); await seed(); await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── The whole journey, once, end to end ─────────────────────────────────── */

maybe("the full flow: event → interest → selection → assignment → completed task", () => {
  let eventId = 0, oppId = 0, assignId = 0;

  it("an admin creates an event with its requirements in one action", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/events", {
      title: `${PX} Navratri 2026`, description: "Campus festival", venue: "Campus Ground",
      event_date: "2026-10-20", start_time: "18:00", end_time: "22:00",
      opportunities: [
        { title: "Reel Creator", creator_type: "Reels", required_count: 5, task_deadline: "2026-10-22" },
        { title: "Vlogger", creator_type: "Vlogs", required_count: 2 },
      ],
    });
    expect(r.status).toBe(201);
    expect(r.body.opportunities_created).toBe(2);
    eventId = Number(r.body.id);
  });

  it("starts as a draft — nothing is open until somebody opens it", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/events/${eventId}`);
    expect((r.body.event as Record<string, unknown>).status).toBe("draft");
    expect((r.body.opportunities as Array<{ status: string }>).every((o) => o.status === "draft")).toBe(true);
  });

  it("a creator cannot see a draft event at all", async () => {
    expect((await as("c1", "GET", `/creator/events/${eventId}`)).status).toBe(404);
  });

  it("opening it puts it on the creators' noticeboard", async () => {
    await as("creatorAdmin", "PATCH", `/creator/events/${eventId}`, { status: "open" });
    const opps = (await as("creatorAdmin", "GET", `/creator/events/${eventId}`)).body
      .opportunities as Array<{ id: number; title: string }>;
    oppId = opps.find((o) => o.title === "Reel Creator")!.id;
    await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`, { status: "open" });
    const seen = await as("c1", "GET", "/creator/opportunities");
    expect((seen.body.opportunities as Array<{ id: number }>).map((o) => o.id)).toContain(oppId);
  });

  it("a creator registers interest — for themselves, with no id in the payload", async () => {
    const r = await as("c1", "POST", `/creator/opportunities/${oppId}/interest`, { note: "Keen" });
    expect(r.status).toBe(201);
    const row = (await pool.query(
      `SELECT user_id, status FROM mo_creator_interests WHERE opportunity_id=$1`, [oppId])).rows[0];
    expect(row).toEqual({ user_id: A.c1.id, status: "interested" });
  });

  it("the admin sees the hand raised, and the counts", async () => {
    const r = await as("creatorAdmin", "GET", `/creator/interests?opportunity_id=${oppId}`);
    expect((r.body.interests as Array<{ user_id: string }>).map((i) => i.user_id)).toEqual([A.c1.id]);
    const ev = await as("creatorAdmin", "GET", `/creator/events/${eventId}`);
    const o = (ev.body.opportunities as Array<Record<string, number>>).find((x) => x.id === oppId)!;
    expect(o.interested).toBe(1);
    expect(o.assigned).toBe(0);      // interest is NOT assignment
  });

  it("selecting them creates the assignment AND records the decision", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id });
    expect(r.status).toBe(201);
    assignId = Number(r.body.id);
    // Two records, deliberately: the decision, and the work.
    const i = (await pool.query(
      `SELECT status, decided_by, decided_at FROM mo_creator_interests
        WHERE opportunity_id=$1 AND user_id=$2`, [oppId, A.c1.id])).rows[0];
    expect(i.status).toBe("selected");
    expect(i.decided_by).toBe(A.creatorAdmin.id);
    expect(i.decided_at).not.toBeNull();
    const a = (await pool.query(`SELECT status, team_id, assigned_by FROM mo_creator_assignments WHERE id=$1`,
      [assignId])).rows[0];
    expect(a.status).toBe("assigned");
    expect(Number(a.team_id)).toBe(teamA);         // resolved, not sent
    expect(a.assigned_by).toBe(A.creatorAdmin.id);
  });

  it("notifies the creator through the existing notification table", async () => {
    const n = await pool.query(
      `SELECT count(*)::int c FROM mo_notifications
        WHERE user_id=$1 AND entity_type='creator_assignment' AND entity_id=$2`, [A.c1.id, assignId]);
    expect(n.rows[0].c).toBe(1);
  });

  it("the creator sees it in their tasks, and nobody else's", async () => {
    const r = await as("c1", "GET", "/creator/tasks");
    const t = (r.body.tasks as Array<Record<string, unknown>>);
    expect(t).toHaveLength(1);
    expect(t[0].id).toBe(assignId);
    expect(t[0].event_title).toContain("Navratri");
  });

  it("accept → start → complete, each a transition the server allows", async () => {
    for (const to of ["accepted", "in_progress", "completed"]) {
      const r = await as("c1", "PATCH", `/creator/assignments/${assignId}`, { status: to });
      expect(r.status, `could not move to ${to}`).toBe(200);
    }
    const row = (await pool.query(
      `SELECT status, accepted_at, started_at, completed_at FROM mo_creator_assignments WHERE id=$1`,
      [assignId])).rows[0];
    expect(row.status).toBe("completed");
    for (const k of ["accepted_at", "started_at", "completed_at"]) expect(row[k]).not.toBeNull();
  });

  it("the event date and the task deadline stay separate, and neither shifts a day", async () => {
    /* A DATE round-tripping through the driver is where the timezone bug bit
       before. The event is the 20th and the work is due the 22nd — both must
       come back exactly as stored. */
    const r = await as("creatorAdmin", "GET", `/creator/events/${eventId}`);
    expect((r.body.event as Record<string, string>).event_date).toBe("2026-10-20");
    const t = (await as("c1", "GET", "/creator/tasks")).body.tasks as Array<Record<string, string>>;
    expect(t[0].deadline).toBe("2026-10-22");
    expect(t[0].event_date).toBe("2026-10-20");
  });
});

/* ── Interest rules ──────────────────────────────────────────────────────── */

maybe("interest", () => {
  it("TEST 19 — the database prevents a duplicate, not the form", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("c1", "POST", `/creator/opportunities/${oppId}/interest`)).status).toBe(201);
    const dupe = await as("c1", "POST", `/creator/opportunities/${oppId}/interest`);
    expect(dupe.status).toBe(409);
    const n = await pool.query(
      `SELECT count(*)::int c FROM mo_creator_interests WHERE opportunity_id=$1 AND user_id=$2`,
      [oppId, A.c1.id]);
    expect(n.rows[0].c).toBe(1);
  });

  it("withdrawing keeps the row and frees the creator to re-apply", async () => {
    const { oppId } = await openOpportunity();
    await as("c1", "POST", `/creator/opportunities/${oppId}/interest`);
    expect((await as("c1", "DELETE", `/creator/opportunities/${oppId}/interest`)).status).toBe(200);
    const rows = await pool.query(
      `SELECT status FROM mo_creator_interests WHERE opportunity_id=$1 AND user_id=$2`, [oppId, A.c1.id]);
    expect(rows.rows.map((r) => r.status)).toEqual(["withdrawn"]);
    // The partial unique index only covers live rows, so re-applying works.
    expect((await as("c1", "POST", `/creator/opportunities/${oppId}/interest`)).status).toBe(201);
  });

  it("cannot be withdrawn once it has been decided", async () => {
    const { oppId } = await openOpportunity();
    await as("c1", "POST", `/creator/opportunities/${oppId}/interest`);
    await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    const r = await as("c1", "DELETE", `/creator/opportunities/${oppId}/interest`);
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("already been decided");
  });

  it("TEST 22/23 — a closed or cancelled opportunity takes no new interest", async () => {
    const closed = await openOpportunity();
    await as("creatorAdmin", "PATCH", `/creator/opportunities/${closed.oppId}`, { status: "closed" });
    expect((await as("c1", "POST", `/creator/opportunities/${closed.oppId}/interest`)).status).toBe(400);
    const cancelled = await openOpportunity();
    await as("creatorAdmin", "PATCH", `/creator/opportunities/${cancelled.oppId}`, { status: "cancelled" });
    expect((await as("c1", "POST", `/creator/opportunities/${cancelled.oppId}/interest`)).status).toBe(400);
  });

  it("TEST 13/14 — a suspended or archived creator cannot register interest", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("suspended", "POST", `/creator/opportunities/${oppId}/interest`)).status).toBe(403);
    expect((await as("archived", "POST", `/creator/opportunities/${oppId}/interest`)).status).toBe(403);
    const n = await pool.query(`SELECT count(*)::int c FROM mo_creator_interests WHERE opportunity_id=$1`, [oppId]);
    expect(n.rows[0].c).toBe(0);
  });

  it("rejecting records not_selected rather than deleting the hand raised", async () => {
    const { oppId } = await openOpportunity();
    await as("c2", "POST", `/creator/opportunities/${oppId}/interest`);
    const list = await as("creatorAdmin", "GET", `/creator/interests?opportunity_id=${oppId}`);
    const iid = (list.body.interests as Array<{ id: number }>)[0].id;
    expect((await as("creatorAdmin", "POST", `/creator/interests/${iid}/reject`)).status).toBe(200);
    const row = (await pool.query(
      `SELECT status, decided_by FROM mo_creator_interests WHERE id=$1`, [iid])).rows[0];
    expect(row.status).toBe("not_selected");
    expect(row.decided_by).toBe(A.creatorAdmin.id);
  });
});

/* ── Assignment and task rules ───────────────────────────────────────────── */

maybe("assignment and the task lifecycle", () => {
  it("TEST 21 — a suspended creator cannot be assigned", async () => {
    const { oppId } = await openOpportunity();
    const r = await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.suspended.id });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("not an active");
  });

  it("TEST 20 — a creator who does not exist cannot be assigned", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: "no-such-person" })).status).toBe(400);
    // Nor a Media Ops employee who is not on the network.
    expect((await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.mediaEmp.id })).status).toBe(400);
  });

  it("can assign someone who never applied — and invents no interest for them", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c2.id })).status).toBe(201);
    const n = await pool.query(`SELECT count(*)::int c FROM mo_creator_interests WHERE opportunity_id=$1`, [oppId]);
    expect(n.rows[0].c).toBe(0);
  });

  it("refuses a second live assignment for the same creator and opportunity", async () => {
    const { oppId } = await openOpportunity();
    await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    expect((await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id })).status).toBe(409);
  });

  it("declining keeps the record, the reason and the actor", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    const id = Number(a.body.id);
    expect((await as("c1", "PATCH", `/creator/assignments/${id}`,
      { status: "declined", reason: "Exam that week" })).status).toBe(200);
    const row = (await pool.query(
      `SELECT status, decline_reason, declined_at FROM mo_creator_assignments WHERE id=$1`, [id])).rows[0];
    expect(row.status).toBe("declined");
    expect(row.decline_reason).toBe("Exam that week");
    expect(row.declined_at).not.toBeNull();
  });

  it("a declined task can NEVER become completed", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    const id = Number(a.body.id);
    await as("c1", "PATCH", `/creator/assignments/${id}`, { status: "declined" });
    for (const to of ["completed", "accepted", "in_progress"]) {
      const r = await as("c1", "PATCH", `/creator/assignments/${id}`, { status: to });
      expect(r.status, `declined → ${to} was allowed`).toBe(400);
    }
    // A fresh assignment is the way back, and the declined row does not block it.
    expect((await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id })).status).toBe(201);
  });

  it("refuses a status the machine does not allow, and any status it invents", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    const id = Number(a.body.id);
    for (const to of ["completed", "in_progress", "approved", "paid", ""])
      expect((await as("c1", "PATCH", `/creator/assignments/${id}`, { status: to })).status,
        `assigned → ${to}`).toBe(400);
  });

  it("TEST 15 — a creator suspended after assignment cannot act on it", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c2.id });
    const id = Number(a.body.id);
    await pool.query(`UPDATE mo_creator_profiles SET status='suspended' WHERE user_id=$1`, [A.c2.id]);
    expect((await as("c2", "PATCH", `/creator/assignments/${id}`, { status: "accepted" })).status).toBe(403);
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.c2.id]);
  });

  it("only a manager may cancel, and only a creator may accept", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    const id = Number(a.body.id);
    expect((await as("c1", "PATCH", `/creator/assignments/${id}`, { status: "cancelled" })).status).toBe(403);
    expect((await as("creatorAdmin", "PATCH", `/creator/assignments/${id}`, { status: "accepted" })).status).toBe(403);
    expect((await as("creatorAdmin", "PATCH", `/creator/assignments/${id}`, { status: "cancelled" })).status).toBe(200);
  });
});

/* ── Security: forgery, impersonation, scope ─────────────────────────────── */

maybe("the client is never trusted", () => {
  it("TEST 1/2 — anonymous and non-network callers are denied everywhere", async () => {
    for (const path of ["/creator/events", "/creator/opportunities", "/creator/interests", "/creator/tasks"]) {
      expect((await as("anon", "GET", path)).status, path).toBe(403);
      expect((await as("mediaEmp", "GET", path)).status, path).toBe(403);
    }
  });

  it("TEST 3/4 — a creator cannot create an event or an opportunity", async () => {
    expect((await as("c1", "POST", "/creator/events", { title: `${PX} Rogue` })).status).toBe(403);
    expect((await as("c1", "POST", "/creator/opportunities",
      { event_id: 1, title: "Rogue" })).status).toBe(403);
  });

  it("TEST 5 — a creator cannot assign anybody, including themselves", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("c1", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id })).status).toBe(403);
    expect((await as("c1", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c2.id })).status).toBe(403);
  });

  it("TEST 6/16 — interest is written from the session, so there is nothing to forge", async () => {
    const { oppId } = await openOpportunity();
    await as("c1", "POST", `/creator/opportunities/${oppId}/interest`,
      { user_id: A.c2.id, creator_id: A.c2.id, status: "selected" });
    const rows = await pool.query(
      `SELECT user_id, status FROM mo_creator_interests WHERE opportunity_id=$1`, [oppId]);
    expect(rows.rows).toEqual([{ user_id: A.c1.id, status: "interested" }]);
  });

  it("TEST 18 — assigned_by and team_id come from the server, not the payload", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id, assigned_by: A.c2.id, team_id: teamB });
    const row = (await pool.query(
      `SELECT assigned_by, team_id FROM mo_creator_assignments WHERE id=$1`, [Number(a.body.id)])).rows[0];
    expect(row.assigned_by).toBe(A.creatorAdmin.id);
    expect(Number(row.team_id)).toBe(teamA);
  });

  it("TEST 7/24/25 — a creator cannot see or move another creator's task", async () => {
    const { oppId } = await openOpportunity();
    const a = await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.c1.id });
    const id = Number(a.body.id);
    // Not theirs: indistinguishable from a task that does not exist.
    expect((await as("c2", "PATCH", `/creator/assignments/${id}`, { status: "accepted" })).status).toBe(404);
    // And ownership is not a field anyone can write.
    await as("c1", "PATCH", `/creator/assignments/${id}`, { status: "accepted", user_id: A.c2.id });
    const row = (await pool.query(`SELECT user_id FROM mo_creator_assignments WHERE id=$1`, [id])).rows[0];
    expect(row.user_id).toBe(A.c1.id);
  });

  it("TEST 8 — a Team Lead sees their own team's interests and not another's", async () => {
    const { oppId } = await openOpportunity();
    await as("c1", "POST", `/creator/opportunities/${oppId}/interest`);   // team A
    await as("cB", "POST", `/creator/opportunities/${oppId}/interest`);   // team B
    const seen = await as("leadA", "GET", `/creator/interests?opportunity_id=${oppId}`);
    const who = (seen.body.interests as Array<{ user_id: string }>).map((i) => i.user_id);
    expect(who).toContain(A.c1.id);
    expect(who).not.toContain(A.cB.id);
  });

  it("TEST 9 — a Team Lead cannot assign at all in this phase", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("leadA", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id })).status).toBe(403);
  });

  it("TEST 17 — a forged team_id narrows a task list, it never widens it", async () => {
    const { oppId } = await openOpportunity();
    await as("creatorAdmin", "POST", "/creator/assignments", { opportunity_id: oppId, user_id: A.cB.id });
    const r = await as("leadA", "GET", `/creator/tasks?team_id=${teamB}&limit=200`);
    const who = (r.body.tasks as Array<{ user_id: string }>).map((t) => t.user_id);
    expect(who).not.toContain(A.cB.id);
  });

  it("TEST 11/12 — a Nerve Admin may manage, and still is not a creator_admin", async () => {
    const { oppId } = await openOpportunity();
    expect((await as("nerveAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c1.id })).status).toBe(201);
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });
});

/* ── Audit ───────────────────────────────────────────────────────────────── */

maybe("the trail", () => {
  it("records every Phase 2 mutation through mo_audit_logs", async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT action FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
    const seen = rows.map((r) => r.action);
    for (const a of ["creator_event.created", "creator_event.open", "creator_opportunity.created",
                     "creator_opportunity.open", "creator_interest.created", "creator_interest.withdrawn",
                     "creator_interest.not_selected", "creator_assignment.created",
                     "creator_assignment.accepted", "creator_assignment.completed",
                     "creator_assignment.declined", "creator_assignment.cancelled"])
      expect(seen, `missing audit action ${a}`).toContain(a);
  });
});

/* ── Regression ──────────────────────────────────────────────────────────── */

maybe("nothing else moved", () => {
  it("Media Ops still refuses creators and still serves staff", async () => {
    for (const p of ["/state", "/projects"]) expect((await as("c1", "GET", p)).status, p).toBe(403);
    for (const p of ["/state", "/lookups", "/dashboard"])
      expect((await as("nerveAdmin", "GET", p)).status, p).toBe(200);
  });

  it("no creator event reaches the Media Ops project tables", async () => {
    /* The reason these are separate tables: mo_projects feeds the pipeline,
       the dashboard and the office TV board. */
    const n = await pool.query(`SELECT count(*)::int c FROM mo_projects WHERE name LIKE $1`, [`${PX}%`]);
    expect(n.rows[0].c).toBe(0);
    const a = await pool.query(`SELECT count(*)::int c FROM mo_assignments WHERE title LIKE $1`, [`${PX}%`]);
    expect(a.rows[0].c).toBe(0);
  });
});
