// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the Creator Network as a Media Ops module.

   Not a separate department, application or login: one Nerve identity, one
   Team Directory, one module-grant system, one audit trail. What this file
   pins is the seam where the two vocabularies meet, because that seam is where
   the bugs were:

     ROLE   — what somebody IS (mo_creator_profiles.creator_role)
     MODULE — which product areas they may open (allowed_modules)

   Both must answer yes, neither may manufacture the other, and a Media Ops
   Admin reaches the network through their administrative role rather than
   through a creator profile they do not hold.

   Fixtures are `zmi-` and removed afterwards. Skips cleanly with no database.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zmi";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let teamA = 0, teamB = 0;

const A = {
  moAdmin:      { id: `${PX}-moadmin`, role: "admin", team: "media",   cr: null },
  moEmployee:   { id: `${PX}-moemp`,   role: "user",  team: "media",   cr: null },
  creatorAdmin: { id: `${PX}-cadmin`,  role: "user",  team: "creator", cr: "creator_admin" },
  leadA:        { id: `${PX}-leadA`,   role: "user",  team: "creator", cr: "team_lead" },
  leadB:        { id: `${PX}-leadB`,   role: "user",  team: "creator", cr: "team_lead" },
  creator1:     { id: `${PX}-c1`,      role: "user",  team: "creator", cr: "creator" },
  creator2:     { id: `${PX}-c2`,      role: "user",  team: "creator", cr: "creator" },
  suspended:    { id: `${PX}-susp`,    role: "user",  team: "creator", cr: "creator" },
  branding:     { id: `${PX}-brand`,   role: "user",  team: "branding", cr: null },
} as const;
type ActorName = keyof typeof A;

/* The connection comes from server/test-db.ts, which resolves it from
   TEST_DATABASE_URL or .env.test and REFUSES any database whose name does not
   mark it as a test database. This file used to read .env.local itself and
   assign the DEVELOPMENT url over the top of vitest's — seventeen siblings did
   the same — which is how the suite came to run against `nerve`. */
{
  const t = await connectTestDatabase();
  pool = t.pool;
  dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: a.id } : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never, otpVerifyLimiter: noLimit as never,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/media`;
}

async function as(actor: ActorName | "anon", method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await fetch(base + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZMI ${a.id}`, `${a.id}@cint.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role, allowed_modules=NULL`,
        [a.id, a.role === "admin" ? "admin" : "employee"]);
    if (a.cr)
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (user_id)
         DO UPDATE SET creator_role=EXCLUDED.creator_role, status=EXCLUDED.status`,
        [a.id, a.cr, a.id === A.suspended.id ? "suspended" : "active", A.moAdmin.id]);
  }
  const mk = async (n: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} ${n}`, lead])).rows[0].id);
  teamA = await mk("Alpha", A.leadA.id);
  teamB = await mk("Beta", A.leadB.id);
  for (const [t, u] of [[teamA, A.creator1.id], [teamA, A.leadA.id],
                        [teamB, A.creator2.id], [teamB, A.leadB.id]] as const)
    await pool.query(
      `INSERT INTO mo_creator_team_members (team_id, user_id, is_primary, added_by)
       VALUES ($1,$2,true,$3) ON CONFLICT DO NOTHING`, [t, u, A.moAdmin.id]);
}

async function cleanup() {
  const like = `${PX}-%`;
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1 OR added_by LIKE $1`, [like]);
  await pool.query(`UPDATE mo_creator_teams SET lead_user_id=NULL WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1 OR created_by LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [like]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1 OR email LIKE $2`, [like, `${PX}%@cint.invalid`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  /* No bootstrapMediaOpsDatabase() here — see above: it is not idempotent
     under the parallel test runner, and the schema already exists. */
  await cleanup(); await seed(); await boot();
}, 120_000);

afterAll(async () => {
  if (server) server.close();
  if (dbUp) { await cleanup(); await pool.end().catch(() => {}); }
});

/* ── §2, §15, §18, §61 — the Media Ops Admin ─────────────────────────────── */
maybe("a Media Ops Admin runs the Creator Network from Media Ops", () => {
  it("sees the whole network without holding a creator profile", async () => {
    const r = await as("moAdmin", "GET", "/creator/state");
    expect(r.status).toBe(200);
    expect(r.body.can_manage_network).toBe(true);
    expect(r.body.scope).toBe("all");
    // The authority is the Media Ops role. They are NOT a Creator Admin.
    expect(r.body.creator_role).toBeNull();
    expect(await api.creatorStandingOf(A.moAdmin.id)).toBeNull();
  });

  it("sees network money, points and the overview", async () => {
    expect((await as("moAdmin", "GET", "/creator/payouts")).status).toBe(200);
    const ov = await as("moAdmin", "GET", "/creator/overview");
    expect(ov.status).toBe(200);
    expect(ov.body.scope).toBe("all");
    expect(ov.body.money).not.toBeNull();
  });

  it("may manage creators without being enrolled as one", async () => {
    const r = await as("moAdmin", "PATCH", `/creator/creators/${A.creator2.id}`, { notes: "seen by admin" });
    expect(r.status).toBe(200);
  });

  /* §61 — inherited, not a checkbox. An Admin with an explicit grant that
     omits the module still gets in, because their access comes from the role. */
  it("is not locked out by an unticked module", async () => {
    await pool.query(`UPDATE mo_user_profiles SET allowed_modules='[]'::jsonb WHERE user_id=$1`, [A.moAdmin.id]);
    expect((await as("moAdmin", "GET", "/creator/state")).status).toBe(200);
    await pool.query(`UPDATE mo_user_profiles SET allowed_modules=NULL WHERE user_id=$1`, [A.moAdmin.id]);
  });
});

/* ── §5, §30 — creation is one transaction ───────────────────────────────── */
maybe("bringing somebody onto the network", () => {
  it("creates the Nerve user, the profile and the team membership together", async () => {
    const r = await as("moAdmin", "POST", "/crew", {
      full_name: "ZMI Via Directory", email: `${PX}-viadir@cint.invalid`,
      password: "not-a-real-password", role: "creator", creator_team_id: teamA,
    });
    expect(r.status).toBe(201);
    const id = String(r.body.id);
    const u = (await pool.query(
      `SELECT role, team, department FROM users WHERE id=$1`, [id])).rows[0];
    expect(u).toMatchObject({ role: "user", team: "creator", department: "Creator Network" });
    expect((await pool.query(
      `SELECT creator_role, status FROM mo_creator_profiles WHERE user_id=$1`, [id])).rows[0])
      .toMatchObject({ creator_role: "creator", status: "active" });
    expect((await pool.query(
      `SELECT team_id FROM mo_creator_team_members WHERE user_id=$1 AND is_primary`, [id])).rows[0].team_id)
      .toBe(String(teamA));
    // A creator is not crew: no Media Ops profile row was invented for them.
    expect((await pool.query(`SELECT 1 FROM mo_user_profiles WHERE user_id=$1`, [id])).rowCount).toBe(0);
  });

  it("creates a Creator Team Lead with their team", async () => {
    const r = await as("moAdmin", "POST", "/crew", {
      full_name: "ZMI Via Lead", email: `${PX}-vialead@cint.invalid`,
      password: "not-a-real-password", role: "creator_team_lead", creator_team_id: teamB,
    });
    expect(r.status).toBe(201);
    expect((await pool.query(
      `SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [String(r.body.id)])).rows[0].creator_role)
      .toBe("team_lead");
  });

  it("creates a Creator Admin with no team — their scope is the network", async () => {
    const r = await as("moAdmin", "POST", "/crew", {
      full_name: "ZMI Via CAdmin", email: `${PX}-viacadmin@cint.invalid`,
      password: "not-a-real-password", role: "creator_admin",
    });
    expect(r.status).toBe(201);
    expect((await pool.query(
      `SELECT COUNT(*)::int n FROM mo_creator_team_members WHERE user_id=$1`, [String(r.body.id)])).rows[0].n)
      .toBe(0);
  });

  /* §27 — a Team Lead cannot be pointed at a team that is not there. And
     because the whole thing is one transaction, the refusal leaves NOTHING. */
  it("refuses a team that does not exist, and leaves no half-made person", async () => {
    const email = `${PX}-ghost@cint.invalid`;
    const r = await as("moAdmin", "POST", "/crew", {
      full_name: "ZMI Ghost", email, password: "not-a-real-password",
      role: "creator_team_lead", creator_team_id: 99_999_999,
    });
    expect(r.status).toBe(400);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email=$1`, [email])).rows[0].n).toBe(0);
  });

  it("never makes a second Nerve account for the same email", async () => {
    const r = await as("moAdmin", "POST", "/crew", {
      full_name: "ZMI Dup", email: `${PX}-viadir@cint.invalid`,
      password: "not-a-real-password", role: "creator",
    });
    expect(r.status).toBe(409);
    expect((await pool.query(
      `SELECT COUNT(*)::int n FROM users WHERE email=$1`, [`${PX}-viadir@cint.invalid`])).rows[0].n).toBe(1);
  });

  /* Two admins submitting at once. UNIQUE(email) is the real guarantee; the
     transaction is what stops the loser leaving a user with no profile. */
  it("survives two admins creating the same person at once", async () => {
    const email = `${PX}-race@cint.invalid`;
    const mk = () => as("moAdmin", "POST", "/crew", {
      full_name: "ZMI Race", email, password: "not-a-real-password", role: "creator" });
    const [x, y] = await Promise.all([mk(), mk()]);
    expect([x.status, y.status].sort()).toEqual([201, 409]);
    const users = (await pool.query(`SELECT id FROM users WHERE email=$1`, [email])).rows;
    expect(users.length).toBe(1);
    // Exactly one whole person: the account and the profile, both present.
    expect((await pool.query(
      `SELECT COUNT(*)::int n FROM mo_creator_profiles WHERE user_id=$1`, [users[0].id])).rows[0].n).toBe(1);
  });

  it("refuses a second creator profile for the same person", async () => {
    const r = await as("moAdmin", "POST", "/creator/creators", { user_id: A.creator1.id });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("CREATOR_EXISTS");
  });

  /* §6, §69 — an existing Nerve identity is EXTENDED, never duplicated. */
  it("enrols an existing Nerve user without touching their Nerve role", async () => {
    const before = (await pool.query(
      `SELECT role, team FROM users WHERE id=$1`, [A.moEmployee.id])).rows[0];
    const r = await as("moAdmin", "POST", "/creator/creators",
      { user_id: A.moEmployee.id, creator_role: "creator" });
    expect(r.status).toBe(201);
    expect((await pool.query(`SELECT role, team FROM users WHERE id=$1`, [A.moEmployee.id])).rows[0])
      .toEqual(before);           // still a Media Ops employee (§34)
    expect(await api.creatorStandingOf(A.moEmployee.id))
      .toEqual({ creator_role: "creator", status: "active" });
    await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id=$1`, [A.moEmployee.id]);
  });
});

/* ── §32, §33 — role changes ─────────────────────────────────────────────── */
maybe("changing what somebody is", () => {
  it("will not orphan a team by demoting its lead", async () => {
    const r = await as("moAdmin", "PATCH", `/creator/creators/${A.leadA.id}`, { creator_role: "creator" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("LEADS_A_TEAM");
    expect(String(r.body.message)).toContain(`${PX} Alpha`);
    // Unchanged, because the refusal happened before the write.
    expect((await pool.query(
      `SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [A.leadA.id])).rows[0].creator_role)
      .toBe("team_lead");
  });

  it("allows the demotion once the team has another lead", async () => {
    await pool.query(`UPDATE mo_creator_teams SET lead_user_id=$1 WHERE id=$2`, [A.leadB.id, teamA]);
    expect((await as("moAdmin", "PATCH", `/creator/creators/${A.leadA.id}`,
      { creator_role: "creator" })).status).toBe(200);
    await pool.query(`UPDATE mo_creator_teams SET lead_user_id=$1 WHERE id=$2`, [A.leadA.id, teamA]);
    await pool.query(`UPDATE mo_creator_profiles SET creator_role='team_lead' WHERE user_id=$1`, [A.leadA.id]);
  });

  it("a demoted Creator Admin keeps no management rights (§33)", async () => {
    const victim = `${PX}-exadmin`;
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,'ZMI ExAdmin',$2,'user','creator','active','x','') ON CONFLICT (id) DO NOTHING`,
      [victim, `${victim}@cint.invalid`]);
    await pool.query(
      `INSERT INTO mo_creator_profiles (user_id, creator_role, status, created_by)
       VALUES ($1,'creator_admin','active',$2) ON CONFLICT (user_id)
       DO UPDATE SET creator_role='creator_admin', status='active'`, [victim, A.moAdmin.id]);
    expect(await api.creatorStandingOf(victim)).toMatchObject({ creator_role: "creator_admin" });
    await as("moAdmin", "PATCH", `/creator/creators/${victim}`, { creator_role: "creator" });
    // The role column IS the permission; nothing caches it elsewhere.
    expect(await api.creatorStandingOf(victim)).toMatchObject({ creator_role: "creator" });
  });
});

/* ── §10–§14, §60, §70, §71 — role and module are different questions ────── */
maybe("module access is separate from what somebody is", () => {
  const grant = (id: string, mods: unknown) =>
    as("moAdmin", "POST", `/crew/${id}/modules`, { allowed_modules: mods });

  it("a creator reaches the network by default", async () => {
    expect((await as("creator1", "GET", "/creator/state")).status).toBe(200);
  });

  it("turning Creator Management OFF blocks them — API, not just the menu", async () => {
    expect((await grant(A.creator1.id, [])).status).toBe(200);
    const r = await as("creator1", "GET", "/creator/state");
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toMatch(/turned off/i);
    // Every creator surface, not only the shell.
    for (const p of ["/creator/creators", "/creator/payouts", "/creator/overview", "/creator/analytics/me"])
      expect((await as("creator1", "GET", p)).status).toBe(403);
  });

  it("turning it back ON restores access with no restart and no re-login", async () => {
    expect((await grant(A.creator1.id, null)).status).toBe(200);
    expect((await as("creator1", "GET", "/creator/state")).status).toBe(200);
  });

  /* §60 — the module does not manufacture membership. Granting it to somebody
     with no profile lets them SEE the module; it does not make them a creator. */
  it("a module grant alone does not create a creator", async () => {
    await grant(A.moEmployee.id, ["creator"]);
    expect(await api.creatorStandingOf(A.moEmployee.id)).toBeNull();
    const r = await as("moEmployee", "GET", "/creator/state");
    expect(r.status).toBe(200);
    expect(r.body.creator_role).toBeNull();
    expect(r.body.scope).toBe("self");        // sees themselves and nothing more
    await grant(A.moEmployee.id, null);
  });

  it("an ordinary Media Ops employee has no Creator Network by default", async () => {
    await pool.query(`UPDATE mo_user_profiles SET allowed_modules=$2 WHERE user_id=$1`,
      [A.moEmployee.id, JSON.stringify(["home", "my-day", "projects"])]);
    expect((await as("moEmployee", "GET", "/creator/state")).status).toBe(403);
    await pool.query(`UPDATE mo_user_profiles SET allowed_modules=NULL WHERE user_id=$1`, [A.moEmployee.id]);
  });

  /* §25 — status still decides membership. A module grant cannot resurrect a
     suspended creator, which is the direction that would actually be dangerous. */
  it("a module grant cannot let a suspended creator back in", async () => {
    await grant(A.suspended.id, ["creator"]);
    const r = await as("suspended", "GET", "/creator/state");
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toMatch(/not active/i);
    await grant(A.suspended.id, null);
  });
});

/* ── §7, §24, §35 — the one directory ────────────────────────────────────── */
maybe("the Team Directory carries the Creator Network", () => {
  it("serves creators as their own roster, tagged by creator role", async () => {
    const r = await as("moAdmin", "GET", "/state");
    expect(r.status).toBe(200);
    const people = (r.body.creator_people ?? []) as Array<Record<string, unknown>>;
    const mine = people.filter((p) => String(p.id).startsWith(`${PX}-`));
    expect(mine.length).toBeGreaterThan(0);
    const byRole = (x: string) => mine.filter((p) => p.role === x).length;
    expect(byRole("creator_admin")).toBeGreaterThan(0);
    expect(byRole("creator_team_lead")).toBeGreaterThan(0);
    expect(byRole("creator")).toBeGreaterThan(0);
    // The group key is distinct from the Media Ops one — a Creator Team Lead
    // must never land in the crew Team Leads group.
    expect(mine.every((p) => p.role !== "team_lead")).toBe(true);
    const lead = mine.find((p) => p.id === A.leadA.id)!;
    expect(lead.creator_team).toBe(`${PX} Alpha`);
    expect(lead.leads_team).toBe(true);
    expect(lead.is_creator).toBe(true);
  });

  it("a suspended creator is not in the active directory, but is still listed", async () => {
    const r = await as("moAdmin", "GET", "/state");
    const people = (r.body.creator_people ?? []) as Array<Record<string, unknown>>;
    const s = people.find((p) => p.id === A.suspended.id)!;
    expect(s.is_active).toBe(false);
    expect(s.creator_status).toBe("suspended");
  });

  it("does not put creators in the crew roster that pickers iterate", async () => {
    const r = await as("moAdmin", "GET", "/state");
    const crew = (r.body.users ?? []) as Array<Record<string, unknown>>;
    expect(crew.some((c) => String(c.real_id ?? "").startsWith(`${PX}-c`))).toBe(false);
  });
});

/* ── §20, §41, §42, §62 — scope ──────────────────────────────────────────── */
maybe("everyone sees exactly their own scope", () => {
  it("a Team Lead's overview is their team, with no money in it", async () => {
    const r = await as("leadA", "GET", "/creator/overview");
    expect(r.status).toBe(200);
    expect(r.body.scope).toBe("team");
    expect(r.body.money).toBeNull();          // omitted, not zeroed
  });

  it("a creator gets no overview at all", async () => {
    expect((await as("creator1", "GET", "/creator/overview")).status).toBe(403);
  });

  it("a Team Lead cannot see another team's creators", async () => {
    const r = await as("leadA", "GET", "/creator/creators?limit=200");
    const ids = ((r.body.creators ?? []) as Array<{ user_id: string }>).map((c) => c.user_id);
    expect(ids).toContain(A.creator1.id);
    expect(ids).not.toContain(A.creator2.id);
  });

  it("a forged team_id cannot widen a Team Lead's view", async () => {
    const r = await as("leadA", "GET", `/creator/creators?team_id=${teamB}&limit=200`);
    const ids = ((r.body.creators ?? []) as Array<{ user_id: string }>).map((c) => c.user_id);
    expect(ids).not.toContain(A.creator2.id);
  });

  it("a Team Lead cannot manage creators or money", async () => {
    expect((await as("leadA", "PATCH", `/creator/creators/${A.creator1.id}`,
      { creator_role: "creator_admin" })).status).toBe(403);
    const pay = await as("leadA", "GET", "/creator/payouts");
    expect(((pay.body.payouts ?? []) as Array<{ user_id: string }>)
      .every((p) => p.user_id === A.leadA.id)).toBe(true);
  });

  it("a creator cannot manage anything", async () => {
    expect((await as("creator1", "POST", "/creator/creators",
      { full_name: "x", email: `${PX}-no@cint.invalid`, password: "not-a-real-password" })).status).toBe(403);
    expect((await as("creator1", "PATCH", `/creator/creators/${A.creator2.id}`,
      { status: "archived" })).status).toBe(403);
  });

  it("an ordinary Knowledge Hub user reaches none of it", async () => {
    for (const p of ["/creator/state", "/creator/overview", "/creator/creators"])
      expect((await as("branding", "GET", p)).status).toBe(403);
  });
});

/* ── §47 — the trail ─────────────────────────────────────────────────────── */
maybe("every change is on the record", () => {
  it("records creation and role changes in the one audit table", async () => {
    const { rows } = await pool.query(
      `SELECT action FROM mo_audit_logs WHERE actor_id LIKE $1 AND action LIKE 'creator%'`, [`${PX}-%`]);
    const actions = new Set(rows.map((r) => String(r.action)));
    expect(actions.has("creator.created")).toBe(true);
    expect(actions.has("creator.role_changed")).toBe(true);
  });
});
