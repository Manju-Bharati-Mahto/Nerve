// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network, Phase 0 foundation.

   The Creator Network is a vertical inside Media Ops, built the way SMC was: an
   ordinary NERVE user carrying a profile row that says what they are here. The
   whole point of Phase 0 is that the two hierarchies cannot inherit each other,
   so that is what this file spends most of its time proving — in BOTH
   directions, at the API, with the acting user chosen per request.

   The failure this guards hardest against is quiet: moduleGroupOf() returns
   null for a team it does not recognise, effectiveModules() turns that into
   null, and requireModule() reads null as UNRESTRICTED. Without the 'creator'
   group and its seeded defaults row, a student creator would pass every module
   gate in Media Ops. There is a test for exactly that below.

   Fixtures are synthetic (ids prefixed `zcn-`) and removed afterwards.
   Skips cleanly when no database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl, withGlobalLock, GLOBAL_LOCK } from "./test-db.js";

const PX = "zcn";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let db: typeof import("./mediaops-db.js");
let server: Server;
let base = "";
let teamA = 0, teamB = 0;

/* One actor per thing we need to distinguish. `team` is the NERVE team, which
   is what moRoleOf() reads; `creatorRole` is the network role, which it cannot
   see. Keeping both on the fixture is what makes the separation testable. */
const A = {
  nerveAdmin:   { id: `${PX}-nadmin`,  role: "admin",     team: "media",   creatorRole: null },
  mediaLead:    { id: `${PX}-mlead`,   role: "sub_admin", team: "media",   creatorRole: null },
  mediaEmp:     { id: `${PX}-memp`,    role: "user",      team: "media",   creatorRole: null },
  creatorAdmin: { id: `${PX}-cadmin`,  role: "user",      team: "media",   creatorRole: "creator_admin" },
  creatorLeadA: { id: `${PX}-cleadA`,  role: "user",      team: "creator", creatorRole: "team_lead" },
  creatorLeadB: { id: `${PX}-cleadB`,  role: "user",      team: "creator", creatorRole: "team_lead" },
  creator1:     { id: `${PX}-c1`,      role: "user",      team: "creator", creatorRole: "creator" },
  creator2:     { id: `${PX}-c2`,      role: "user",      team: "creator", creatorRole: "creator" },
  suspended:    { id: `${PX}-csusp`,   role: "user",      team: "creator", creatorRole: "creator" },
  archived:     { id: `${PX}-carch`,   role: "user",      team: "creator", creatorRole: "creator" },
  smcMember:    { id: `${PX}-smc`,     role: "user",      team: "smc",     creatorRole: null },
} as const;
type ActorName = keyof typeof A;

/* The test database url, resolved and safety-checked by server/test-db.ts.
   This function used to open .env.local and return the DEVELOPMENT url, which
   the block below then assigned over the one vitest had already set — so the
   whole suite ran against `nerve`. It now resolves from TEST_DATABASE_URL or
   .env.test, and throws rather than handing back a non-test database. */
const realDatabaseUrl = async (): Promise<string> => resolveTestDatabaseUrl();

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
    res.locals.currentUser = a ? { id: a.id, role: a.role, team: a.team } : undefined;
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

async function as(actor: ActorName, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json", "x-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}
const user = (n: ActorName) => ({ id: A[n].id, role: A[n].role, team: A[n].team });

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCN ${a.id}`, `${a.id}@creator.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
        [a.id, a.role === "admin" ? "admin" : a.role === "sub_admin" ? "team_lead" : "employee"]);
    if (a.creatorRole) {
      const status = a.id === A.suspended.id ? "suspended"
        : a.id === A.archived.id ? "archived" : "active";
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET creator_role=EXCLUDED.creator_role, status=EXCLUDED.status`,
        [a.id, a.creatorRole, status]);
    }
  }
  await pool.query(
    `INSERT INTO mo_smc_profiles (user_id, designation, is_active) VALUES ($1,'probe',true)
     ON CONFLICT (user_id) DO UPDATE SET is_active=true`, [A.smcMember.id]);

  const mk = async (name: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} ${name}`, lead])).rows[0].id);
  teamA = await mk("Reels Team", A.creatorLeadA.id);
  teamB = await mk("Vlog Team", A.creatorLeadB.id);
  for (const [t, u] of [[teamA, A.creator1.id], [teamB, A.creator2.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);
}

async function cleanup() {
  /* Phase 6 recognition first: an achievement award is RESTRICT-protected on
     purpose — recognition outlives a suspension or an archive — so a fixture
     has to take its own down before its people and its cycles. */
  await pool.query(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_smc_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  db = await import("./mediaops-db.js");
  await db.bootstrapCreatorNetwork();          // tables must exist before fixtures
  api = await import("./mediaops-api.js");
  await cleanup();
  await seed();
  await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── 1/11: the domain exists and relates correctly ───────────────────────── */

maybe("the creator domain", () => {
  it("TEST 1 — resolves each creator role from the profile, not from Nerve", async () => {
    expect(await api.creatorRoleOf(user("creatorAdmin"))).toBe("creator_admin");
    expect(await api.creatorRoleOf(user("creatorLeadA"))).toBe("team_lead");
    expect(await api.creatorRoleOf(user("creator1"))).toBe("creator");
  });

  it("TEST 11 — a creator belongs to a creator team, and teams have leads", async () => {
    const r = await pool.query(
      `SELECT t.id, t.name, t.lead_user_id FROM mo_creator_teams t
         JOIN mo_creator_team_members m ON m.team_id = t.id
        WHERE m.user_id=$1 AND m.is_primary`, [A.creator1.id]);
    expect(Number(r.rows[0].id)).toBe(teamA);
    expect(r.rows[0].lead_user_id).toBe(A.creatorLeadA.id);
  });

  it("allows only one primary creator team per person", async () => {
    await expect(pool.query(
      `INSERT INTO mo_creator_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)`,
      [teamB, A.creator1.id])).rejects.toThrow();
  });

  it("TEST 10 — a suspended or archived creator holds no role at all", async () => {
    // The record survives; every right attached to it stops.
    expect(await api.creatorRoleOf(user("suspended"))).toBeNull();
    expect(await api.creatorRoleOf(user("archived"))).toBeNull();
    const rows = await pool.query(
      `SELECT status FROM mo_creator_profiles WHERE user_id = ANY($1::text[])`,
      [[A.suspended.id, A.archived.id]]);
    expect(rows.rows.map((r) => r.status).sort()).toEqual(["archived", "suspended"]);
  });
});

/* ── 2/3/4: the two hierarchies do not inherit each other ────────────────── */

maybe("TEST 2/3/4 — Creator roles and Nerve roles are separate vocabularies", () => {
  it("a Creator Admin is NOT a Nerve Admin", async () => {
    expect(await api.isCreatorAdmin(user("creatorAdmin"))).toBe(true);
    expect(api.isMoAdmin(user("creatorAdmin"))).toBe(false);   // still an ordinary Media Ops user
    expect(api.moRoleOf(user("creatorAdmin"))).toBe("employee");
  });

  it("a Nerve Admin is NOT a Creator Admin", async () => {
    expect(api.isMoAdmin(user("nerveAdmin"))).toBe(true);
    expect(await api.isCreatorAdmin(user("nerveAdmin"))).toBe(false);   // holds no profile
    expect(await api.creatorRoleOf(user("nerveAdmin"))).toBeNull();
  });

  it("a Media Ops Team Lead is NOT a Creator Team Lead", async () => {
    expect(api.moRoleOf(user("mediaLead"))).toBe("team_lead");
    expect(await api.creatorRoleOf(user("mediaLead"))).toBeNull();
  });

  it("a Creator Team Lead is NOT a Media Ops Team Lead", async () => {
    expect(await api.isCreatorTeamLead(user("creatorLeadA"))).toBe(true);
    expect(api.moRoleOf(user("creatorLeadA"))).toBeNull();   // team='creator'
  });

  it("a creator is NOT a Media Ops employee", async () => {
    expect(api.moRoleOf(user("creator1"))).toBeNull();
  });
});

/* ── 5/6/7: module access, and the hole it closes ────────────────────────── */

maybe("TEST 5/6 — module access to the network", () => {
  it("a creator resolves to the 'creator' module group, never to unrestricted", async () => {
    /* THE security test. moduleGroupOf() returning null would make
       effectiveModules() answer null, which requireModule() reads as
       unrestricted — a creator would pass every gate in Media Ops. */
    const eff = await api.effectiveModules(user("creator1"));
    expect(eff, "a creator resolved to UNRESTRICTED module access").not.toBeNull();
    expect(eff).toEqual([api.CREATOR_MODULE]);
  });

  it("that group grants the network and nothing else", async () => {
    const eff = await api.effectiveModules(user("creator1"));
    for (const other of ["home", "projects", "equipment", "reports", "library", "team", "admin/users"])
      expect(eff, `creator group leaked '${other}'`).not.toContain(other);
  });

  it("TEST 6 — a Media Ops employee without the grant is refused", async () => {
    const r = await as("mediaEmp", "GET", "/creator/context");
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain("Creator Network");
  });

  it("an SMC member is refused — a different vertical is not this one", async () => {
    expect((await as("smcMember", "GET", "/creator/context")).status).toBe(403);
  });

  it("TEST 7 — a Creator Admin is admitted", async () => {
    expect((await as("creatorAdmin", "GET", "/creator/context")).status).toBe(200);
  });

  it("a Nerve Admin is admitted, as they are to every module", async () => {
    const r = await as("nerveAdmin", "GET", "/creator/context");
    expect(r.status).toBe(200);
    // Admitted, but NOT a Creator Admin — the two answers stay distinct.
    expect(r.body.creator_role).toBeNull();
    expect(r.body.is_nerve_admin).toBe(true);
    expect(r.body.can_manage_network).toBe(true);
  });

  it("a creator reaches the network without touching any Media Ops route", async () => {
    const r = await as("creator1", "GET", "/creator/context");
    expect(r.status).toBe(200);
    expect(r.body.creator_role).toBe("creator");
  });
});

/* ── 8/9: scope is decided by the server ─────────────────────────────────── */

maybe("TEST 8/9 — scope", () => {
  it("a Creator Admin sees the whole network", async () => {
    expect((await as("creatorAdmin", "GET", "/creator/context")).body.scope).toBe("all");
  });

  it("a Creator Team Lead is scoped to the teams they actually lead", async () => {
    const r = await as("creatorLeadA", "GET", "/creator/context");
    expect(r.body.scope).toBe("team");
    expect(r.body.team_ids).toEqual([teamA]);
    expect(r.body.team_ids).not.toContain(teamB);
  });

  it("a creator is scoped to themselves", async () => {
    const r = await as("creator1", "GET", "/creator/context");
    expect(r.body.scope).toBe("self");
    expect(r.body.team_ids).toEqual([]);
  });

  it("TEST 9 — /creator/me returns the CALLER's profile and takes no id", async () => {
    const mine = await as("creator1", "GET", "/creator/me");
    expect((mine.body.profile as Record<string, unknown>).user_id).toBe(A.creator1.id);
    // There is deliberately no id-taking variant; a query string changes nothing.
    const forged = await as("creator1", "GET", `/creator/me?user_id=${A.creator2.id}`);
    expect((forged.body.profile as Record<string, unknown>).user_id).toBe(A.creator1.id);
  });

  it("counts narrow with scope rather than changing shape", async () => {
    const admin = await as("creatorAdmin", "GET", "/creator/status");
    const lead = await as("creatorLeadA", "GET", "/creator/status");
    const solo = await as("creator1", "GET", "/creator/status");
    expect(admin.body.scope).toBe("all");
    expect(lead.body.scope).toBe("team");
    expect(solo.body).toEqual({ scope: "self", creators: 1, teams: 0 });
    expect(Number(admin.body.creators)).toBeGreaterThanOrEqual(Number(lead.body.creators));
  });
});

/* ── Security: forgery and escalation ────────────────────────────────────── */

maybe("the client is never trusted", () => {
  it("cannot forge a creator role onto a user who has none", async () => {
    const r = await as("mediaEmp", "GET",
      "/creator/context?creator_role=creator_admin&scope=all&can_manage_network=true");
    expect(r.status).toBe(403);
  });

  it("cannot forge identity through a user_id parameter", async () => {
    const r = await as("creator1", "GET", `/creator/me?user_id=${A.creator2.id}&id=${A.creator2.id}`);
    expect((r.body.profile as Record<string, unknown>).user_id).toBe(A.creator1.id);
  });

  it("cannot forge team scope", async () => {
    const r = await as("creatorLeadA", "GET", `/creator/context?team_ids=${teamA},${teamB}`);
    expect(r.body.team_ids).toEqual([teamA]);
  });

  it("a creator cannot escalate to Team Lead by claiming it", async () => {
    // creator_role is read from the row, never from the caller.
    const r = await as("creator1", "GET", "/creator/context?creator_role=team_lead");
    expect(r.body.creator_role).toBe("creator");
    expect(r.body.scope).toBe("self");
  });

  it("a Creator Team Lead cannot escalate to Creator Admin", async () => {
    const r = await as("creatorLeadA", "GET", "/creator/context?can_manage_network=true");
    expect(r.body.can_manage_network).toBe(false);
  });

  it("a Creator Admin cannot escalate to Nerve Admin", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/context");
    expect(r.body.is_nerve_admin).toBe(false);
    // And the Nerve-side predicate is unmoved by the creator profile.
    expect(api.isMoAdmin(user("creatorAdmin"))).toBe(false);
  });

  it("a suspended creator is refused the network outright", async () => {
    expect((await as("suspended", "GET", "/creator/context")).status).toBe(403);
  });

  it("an archived creator is refused, and keeps their record", async () => {
    expect((await as("archived", "GET", "/creator/context")).status).toBe(403);
    const still = await pool.query(`SELECT 1 FROM mo_creator_profiles WHERE user_id=$1`, [A.archived.id]);
    expect(still.rows).toHaveLength(1);
  });
});

/* ── Navigation registration ─────────────────────────────────────────────── */

describe("the sidebar entry, read from the shipped page", () => {
  /* Asserted against public/media-ops/index.html itself rather than a copy of
     it, so a change to the sidebar shows up here. The module key is not typed
     twice anywhere: the client derives it from the route, and the server names
     it CREATOR_MODULE — these must agree. */
  const HTML = readFileSync("public/media-ops/index.html", "utf8");

  it("registers one Creator Network entry at #/media/creator", () => {
    const m = HTML.match(/\{r:'#\/media\/creator',[^}]*\}/);
    expect(m, "Creator Network is missing from NAV").toBeTruthy();
    expect(m![0]).toContain("l:'Creator Network'");
  });

  /* The only test in this block that needs the server module: `api` is imported
     in beforeAll, which returns early without a database, so this ran against
     `undefined` rather than skipping. Gated on the same dbUp this file already
     uses for its describes. */
  (dbUp ? it : it.skip)("derives the module key the server enforces", async () => {
    // modKeyOf() strips '#/media/', so the route IS the key.
    expect("#/media/creator".replace("#/media/", "")).toBe(api.CREATOR_MODULE);
  });

  it("is opt-in, so no role silently acquires the network", () => {
    // defaultModulesFor() skips optIn modules; only an explicit grant or the
    // seeded creator group hands this out.
    expect(HTML.match(/\{r:'#\/media\/creator',[^}]*\}/)![0]).toContain("optIn:true");
  });

  it("has a route, so the module gate can resolve it", () => {
    expect(HTML).toContain("[/^#\\/media\\/creator$/,");
  });
});

/* ── 12–17: nothing else moved ───────────────────────────────────────────── */

maybe("TEST 12/13/14 — the rest of Nerve is unchanged", () => {
  it("a creator is refused by Media Ops routes, through the gate that already existed", async () => {
    // requireMedia() asks moRoleOf(), which never sees creator_role.
    for (const path of ["/state", "/projects", "/dashboard", "/members/assignable"])
      expect((await as("creator1", "GET", path)).status, `creator reached ${path}`).toBe(403);
  });

  it("a Creator Admin who is Media Ops staff keeps exactly their Media Ops rights", async () => {
    // They are an employee there and a Creator Admin here; neither leaks.
    expect(api.moRoleOf(user("creatorAdmin"))).toBe("employee");
    expect((await as("creatorAdmin", "GET", "/state")).status).toBe(200);
  });

  it("Media Ops roles resolve exactly as before", async () => {
    expect(api.moRoleOf(user("nerveAdmin"))).toBe("admin");
    expect(api.moRoleOf(user("mediaLead"))).toBe("team_lead");
    expect(api.moRoleOf(user("mediaEmp"))).toBe("employee");
  });

  it("SMC still resolves to the employee tier and its own module group", async () => {
    expect(api.moRoleOf(user("smcMember"))).toBe("employee");

    /* This assertion needs the smc_member defaults row to EXIST. The bootstrap
       seeds only the 'creator' row; the others are created by an administrator
       through Settings, so they were present on the developer's database and
       absent on a freshly created one — and this test was quietly reading that
       ambient state. effectiveModules() returns null for a group with no row,
       and requireModule() reads null as "unrestricted", so the assertion below
       was comparing against null rather than against a module list.

       The row is created here as a fixture and removed afterwards, which makes
       the test say what it means on any database. (That a fresh install has no
       defaults row for smc_member/employee/team_lead is a real finding in its
       own right — see the stabilisation note — but it is a production seeding
       decision, not something to change from inside a test.) */
    await withGlobalLock(pool, GLOBAL_LOCK.moduleDefaults, async () => {
      const had = (await pool.query(
        `SELECT modules FROM mo_module_defaults WHERE role='smc_member'`)).rows[0];
      if (!had)
        await pool.query(
          `INSERT INTO mo_module_defaults (role, modules) VALUES ('smc_member','["home","my-day","smc"]'::jsonb)`);
      try {
        const eff = await api.effectiveModules(user("smcMember"));
        expect(eff, "an SMC member must have an explicit module list, not 'unrestricted'").not.toBeNull();
        expect(eff).not.toContain(api.CREATOR_MODULE);
      } finally {
        if (!had) await pool.query(`DELETE FROM mo_module_defaults WHERE role='smc_member'`);
      }
    });
  });

  it("TEST 16 — existing Media Ops routes still answer for staff", async () => {
    for (const path of ["/state", "/lookups", "/dashboard"])
      expect((await as("nerveAdmin", "GET", path)).status, path).toBe(200);
  });

  it("TEST 17 — the creator bootstrap is idempotent", async () => {
    const before = await pool.query(
      `SELECT (SELECT count(*)::int FROM teams WHERE id='creator') t,
              (SELECT count(*)::int FROM mo_module_defaults WHERE role='creator') d`);
    await db.bootstrapCreatorNetwork();
    await db.bootstrapCreatorNetwork();
    const after = await pool.query(
      `SELECT (SELECT count(*)::int FROM teams WHERE id='creator') t,
              (SELECT count(*)::int FROM mo_module_defaults WHERE role='creator') d`);
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0].t).toBe(1);
    expect(after.rows[0].d).toBe(1);
  });

  it("does not overwrite a defaults row an administrator has edited", async () => {
    /* One module-defaults row per role, shared by the whole database. Restore
       in a finally so a failure here cannot hand the next suite a creator
       default of ["creator","home"]. */
    /* mo_module_defaults is shared across every suite: the module-defaults
       file snapshots the whole table to prove a second bootstrap changes no
       row, and caught this toggle mid-flight. Held under the lock so the two
       cannot overlap. */
    await withGlobalLock(pool, GLOBAL_LOCK.moduleDefaults, async () => {
    await pool.query(`UPDATE mo_module_defaults SET modules='["creator","home"]'::jsonb WHERE role='creator'`);
    try {
      await db.bootstrapCreatorNetwork();
      const r = await pool.query(`SELECT modules FROM mo_module_defaults WHERE role='creator'`);
      expect(r.rows[0].modules).toEqual(["creator", "home"]);
    } finally {
      await pool.query(`UPDATE mo_module_defaults SET modules='["creator"]'::jsonb WHERE role='creator'`);
    }
    });
  });

  it("touches no Outreach table — outreach_creators are a different thing entirely", async () => {
    const r = await pool.query(
      `SELECT to_regclass('public.outreach_creators') IS NOT NULL AS exists`);
    expect(r.rows[0].exists).toBe(true);   // still there, still Outreach's
  });
});
