// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — a Creator Network member reaches the Creator Network.

   THE BUG THIS PINS. Creating a creator was never the problem: the creation
   endpoint wrote the users row and the profile correctly from the first day.
   What was missing was one fact on the session. A creator is an ordinary Nerve
   user (role 'user') whose Nerve team is 'creator', and /api/auth/me sent only
   role and team — so the client had nothing to distinguish a Creator Admin
   from somebody with no network membership at all, and every creator fell
   through to the Knowledge Hub, whose own guard then refused them.

   So this file walks the whole path, end to end, in the order it happens:

     CREATE (through the real endpoint, as a real Creator Admin)
       → the records that creation must produce
       → the standing the session carries        (creatorStandingOf)
       → the application that standing resolves  (getRoleDashboard)

   The last step imports the client's own resolver rather than restating what
   it should return. A test that hard-codes '/media' passes while the product
   is broken; this one fails.

   Fixtures are `zrt-` and removed afterwards. Skips cleanly with no database.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRoleDashboard } from "../src/hooks/useAuth";

const PX = "zrt";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let team = 0;

const A = {
  creatorAdmin: { id: `${PX}-cadmin`, role: "admin", team: "media",   cr: "creator_admin" },
  lead:         { id: `${PX}-lead`,   role: "user",  team: "creator", cr: "team_lead" },
  creator:      { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  suspended:    { id: `${PX}-susp`,   role: "user",  team: "creator", cr: "creator" },
  archived:     { id: `${PX}-arch`,   role: "user",  team: "creator", cr: "creator" },
  branding:     { id: `${PX}-brand`,  role: "user",  team: "branding", cr: null },
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

/** Exactly what /api/auth/me now puts on the session, then exactly what the
    client does with it. No restatement of the expected answer in between. */
async function applicationFor(userId: string) {
  const u = (await pool.query(`SELECT role, team FROM users WHERE id=$1`, [userId])).rows[0];
  const standing = await api.creatorStandingOf(userId);
  return getRoleDashboard(u.role, u.team, standing as never);
}

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZRT ${a.id}`, `${a.id}@crt.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
        [a.id, a.role === "admin" ? "admin" : "employee"]);
    if (a.cr) {
      const st = a.id === A.suspended.id ? "suspended" : a.id === A.archived.id ? "archived" : "active";
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status, created_by)
         VALUES ($1,$2,$3,$4) ON CONFLICT (user_id)
         DO UPDATE SET creator_role=EXCLUDED.creator_role, status=EXCLUDED.status`,
        [a.id, a.cr, st, A.creatorAdmin.id]);
    }
  }
  team = Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} Squad`, A.lead.id])).rows[0].id);
  await pool.query(
    `INSERT INTO mo_creator_team_members (team_id, user_id, is_primary, added_by)
     VALUES ($1,$2,true,$3) ON CONFLICT DO NOTHING`, [team, A.lead.id, A.creatorAdmin.id]);
}

async function cleanup() {
  const like = `${PX}-%`;
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1 OR added_by LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1 OR created_by LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [like]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [like]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1 OR email LIKE $2`, [like, `${PX}%@crt.invalid`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  const db = await import("./mediaops-db.js");
  await db.bootstrapMediaOpsDatabase();
  await cleanup(); await seed(); await boot();
}, 120_000);

afterAll(async () => {
  if (server) server.close();
  if (dbUp) { await cleanup(); await pool.end().catch(() => {}); }
});

maybe("create a creator, then sign them in", () => {
  let madeCreator = "", madeLead = "";

  it("creation writes the user AND the creator profile, in one call", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/creators", {
      full_name: "ZRT New Creator", email: `${PX}-new@crt.invalid`,
      password: "not-a-real-password", creator_role: "creator", team_id: team,
    });
    expect(r.status).toBe(201);
    madeCreator = String(r.body.user_id);

    const u = (await pool.query(
      `SELECT role, team, department, status FROM users WHERE id=$1`, [madeCreator])).rows[0];
    // The Nerve identity: an ordinary user, on the creator team. Not an admin,
    // not on the media team — the network is not Media Ops staff.
    expect(u).toMatchObject({ role: "user", team: "creator", status: "active",
                              department: "Creator Network" });

    const c = (await pool.query(
      `SELECT creator_role, status FROM mo_creator_profiles WHERE user_id=$1`, [madeCreator])).rows[0];
    expect(c).toMatchObject({ creator_role: "creator", status: "active" });

    // And the team they were created into, so scope resolves on first sign-in.
    const m = (await pool.query(
      `SELECT team_id, is_primary FROM mo_creator_team_members WHERE user_id=$1`, [madeCreator])).rows[0];
    expect(m).toMatchObject({ team_id: String(team), is_primary: true });
  });

  it("→ and that creator lands in the Creator Network, not the Knowledge Hub", async () => {
    expect(await applicationFor(madeCreator)).toBe("/media");
  });

  it("a Team Lead created the same way lands there too", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/creators", {
      full_name: "ZRT New Lead", email: `${PX}-newlead@crt.invalid`,
      password: "not-a-real-password", creator_role: "team_lead", team_id: team,
    });
    expect(r.status).toBe(201);
    madeLead = String(r.body.user_id);
    expect((await pool.query(
      `SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [madeLead])).rows[0].creator_role)
      .toBe("team_lead");
    expect(await applicationFor(madeLead)).toBe("/media");
  });

  it("promoting a creator to Team Lead changes the creator role and nothing in Nerve", async () => {
    const before = (await pool.query(`SELECT role, team FROM users WHERE id=$1`, [madeCreator])).rows[0];
    const r = await as("creatorAdmin", "PATCH", `/creator/creators/${madeCreator}`,
      { creator_role: "team_lead" });
    expect(r.status).toBe(200);
    expect((await pool.query(
      `SELECT creator_role FROM mo_creator_profiles WHERE user_id=$1`, [madeCreator])).rows[0].creator_role)
      .toBe("team_lead");
    // §24 — the global Nerve role is not touched by a Creator Network promotion.
    expect((await pool.query(`SELECT role, team FROM users WHERE id=$1`, [madeCreator])).rows[0])
      .toEqual(before);
    expect(await applicationFor(madeCreator)).toBe("/media");
  });
});

maybe("which application each kind of person gets", () => {
  it("a Creator Admin gets the Creator Network", async () => {
    expect(await applicationFor(A.creatorAdmin.id)).toBe("/media");
  });
  it("a Team Lead gets the Creator Network", async () => {
    expect(await applicationFor(A.lead.id)).toBe("/media");
  });
  it("a creator gets the Creator Network", async () => {
    expect(await applicationFor(A.creator.id)).toBe("/media");
  });
  it("an ordinary Nerve user keeps the application they always had", async () => {
    expect(await applicationFor(A.branding.id)).toBe("/branding/user");
  });

  /* §25 — status decides membership. A module grant cannot override it, and
     neither can the team column: both of these people are still team='creator'. */
  it("a suspended creator is not sent into the network", async () => {
    expect(await applicationFor(A.suspended.id)).not.toBe("/media");
  });
  it("an archived creator is not sent into the network", async () => {
    expect(await applicationFor(A.archived.id)).not.toBe("/media");
  });
});

maybe("the standing the session carries is the truth, not a guess", () => {
  it("reports role and status straight from the profile", async () => {
    expect(await api.creatorStandingOf(A.lead.id)).toEqual({ creator_role: "team_lead", status: "active" });
    expect(await api.creatorStandingOf(A.suspended.id)).toEqual({ creator_role: "creator", status: "suspended" });
  });

  it("is null for somebody with no profile, whatever their team says", async () => {
    expect(await api.creatorStandingOf(A.branding.id)).toBeNull();
    // Being on team='creator' is not membership — only the profile is.
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,'ZRT Impostor',$2,'user','creator','active','x','') ON CONFLICT (id) DO NOTHING`,
      [`${PX}-nopro`, `${PX}-nopro@crt.invalid`]);
    expect(await api.creatorStandingOf(`${PX}-nopro`)).toBeNull();
    expect(await applicationFor(`${PX}-nopro`)).not.toBe("/media");
  });

  it("does not leak a password hash or anything else about the account", async () => {
    const s = await api.creatorStandingOf(A.creator.id);
    expect(Object.keys(s ?? {}).sort()).toEqual(["creator_role", "status"]);
  });
});

/* ── The scope guarantees the shell now depends on (§27) ─────────────────── */
maybe("reaching the shell grants nothing inside it", () => {
  it("A — a creator cannot manage the network", async () => {
    const r = await as("creator", "POST", "/creator/creators", {
      full_name: "x", email: `${PX}-evil@crt.invalid`, password: "not-a-real-password" });
    expect(r.status).toBe(403);
  });

  it("D/F — a Team Lead cannot manage creators", async () => {
    const r = await as("lead", "PATCH", `/creator/creators/${A.creator.id}`, { creator_role: "team_lead" });
    expect(r.status).toBe(403);
  });

  it("E — a Team Lead sees no money but their own", async () => {
    const r = await as("lead", "GET", "/creator/payouts");
    expect(r.status).toBe(200);
    const rows = (r.body.payouts ?? []) as Array<{ user_id: string }>;
    expect(rows.every((p) => p.user_id === A.lead.id)).toBe(true);
  });

  it("M — a forged creator_id cannot widen a creator's view of money", async () => {
    const r = await as("creator", "GET", `/creator/payouts?creator_id=${A.lead.id}`);
    expect(r.status).toBe(200);
    expect(((r.body.payouts ?? []) as unknown[]).length).toBe(0);
  });

  it("J/K — a suspended or archived creator is refused at the door", async () => {
    for (const who of ["suspended", "archived"] as const) {
      const r = await as(who, "GET", "/creator/state");
      expect(r.status).toBe(403);
      expect(String(r.body.message)).toMatch(/not active/i);
    }
  });

  it("H — an ordinary Nerve user cannot reach the network at all", async () => {
    const r = await as("branding", "GET", "/creator/state");
    expect(r.status).toBe(403);
  });
});
