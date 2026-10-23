// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — each person's own interface preferences.

   The Projects page has six views (List, Table, Kanban, Timeline, Calendar,
   Gallery). Each person orders them by dragging, and the first is where the
   page opens for them. The order is saved on their account — PATCH
   /me/preferences, read back as my_prefs in /state — so it follows them to
   any device, and it is theirs alone.

   Under test:
     · a person with nothing saved gets {} and the page falls back to List;
     · a valid order is saved, merged with anything else stored, and read back;
     · anything that is not a clean ordering of the six — or a key the server
       does not know — is refused with 400 and changes nothing;
     · one person never receives another's preferences.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zup";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let db: typeof import("./mediaops-db.js");
let server: Server;
let base = "";

const A = {
  admin:       { id: `${PX}-admin`, role: "admin", team: "media", mo: "admin" },
  employee:    { id: `${PX}-emp`,   role: "user", team: "media", mo: "employee" },
  coordinator: { id: `${PX}-coord`, role: "user", team: "media", mo: "coordinator" },
} as const;
type ActorName = keyof typeof A;

const VIEWS = ["list", "table", "kanban", "timeline", "calendar", "gallery"];

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
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZUP ${a.id}` }
      : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never,
    otpVerifyLimiter: noLimit as never,
    kioskPinLimiter: noLimit as never,
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

const stored = async (id: string) =>
  (await pool.query(`SELECT prefs FROM mo_user_prefs WHERE user_id=$1`, [id])).rows[0]?.prefs ?? null;
const statePrefs = async (actor: ActorName) => {
  const r = await as(actor, "GET", "/state");
  expect(r.status).toBe(200);
  return r.body.my_prefs;
};

async function cleanup() {
  await pool.query(`DELETE FROM mo_user_prefs WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  db = await import("./mediaops-db.js");
  await db.bootstrapMediaOpsDatabase();
  await cleanup();
  for (const a of Object.values(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZUP ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZUP',$2,NULL) ON CONFLICT (user_id) DO UPDATE
         SET mo_role=EXCLUDED.mo_role, allowed_modules=NULL`,
      [a.id, a.mo]);
  }
  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

maybe("the Projects view order is each person's own", () => {
  it("is empty until someone saves one", async () => {
    expect(await statePrefs("employee")).toEqual({});
  });

  it("saves a valid order and reads it back in /state", async () => {
    const order = ["calendar", "list", "table", "kanban", "timeline", "gallery"];
    const r = await as("employee", "PATCH", "/me/preferences", { projects_view_order: order });
    expect(r.status).toBe(200);
    expect(r.body.prefs).toEqual({ projects_view_order: order });
    expect(await statePrefs("employee")).toEqual({ projects_view_order: order });
  });

  it("merges with whatever else is stored instead of replacing it", async () => {
    await pool.query(`UPDATE mo_user_prefs SET prefs = prefs || '{"other":"kept"}'::jsonb WHERE user_id=$1`,
      [A.employee.id]);
    const order = ["kanban", "calendar", "list", "table", "timeline", "gallery"];
    expect((await as("employee", "PATCH", "/me/preferences", { projects_view_order: order })).status).toBe(200);
    expect(await stored(A.employee.id)).toEqual({ other: "kept", projects_view_order: order });
  });

  it("refuses anything that is not each view exactly once, and changes nothing", async () => {
    const before = await stored(A.employee.id);
    for (const bad of [
      VIEWS.slice(0, 5),                                            // one missing
      ["list", "list", "table", "kanban", "timeline", "calendar"],  // a duplicate
      ["list", "table", "kanban", "timeline", "calendar", "agenda"],// not a view
      "calendar",                                                   // not a list
    ]) {
      const r = await as("employee", "PATCH", "/me/preferences", { projects_view_order: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await stored(A.employee.id)).toEqual(before);
  });

  it("refuses keys it does not know, and an empty request", async () => {
    expect((await as("employee", "PATCH", "/me/preferences", { theme: "dark" })).status).toBe(400);
    expect((await as("employee", "PATCH", "/me/preferences", {
      projects_view_order: VIEWS, theme: "dark" })).status).toBe(400);
    expect((await as("employee", "PATCH", "/me/preferences", {})).status).toBe(400);
  });

  it("never ships one person's preferences to another", async () => {
    expect(await statePrefs("coordinator")).toEqual({});
    const order = ["gallery", "timeline", "list", "table", "kanban", "calendar"];
    expect((await as("coordinator", "PATCH", "/me/preferences", { projects_view_order: order })).status).toBe(200);
    expect(await statePrefs("coordinator")).toEqual({ projects_view_order: order });
    expect((await statePrefs("employee") as Record<string, unknown>).projects_view_order)
      .toEqual(["kanban", "calendar", "list", "table", "timeline", "gallery"]);
  });

  /* /state takes a different, unscoped path for an Admin; the preference must
     ride on both. */
  it("reaches an Admin too, and only their own", async () => {
    expect(await statePrefs("admin")).toEqual({});
    const order = ["timeline", "list", "table", "kanban", "calendar", "gallery"];
    expect((await as("admin", "PATCH", "/me/preferences", { projects_view_order: order })).status).toBe(200);
    expect(await statePrefs("admin")).toEqual({ projects_view_order: order });
  });

  it("is refused to someone who is not signed in", async () => {
    expect((await as("anon", "PATCH", "/me/preferences", { projects_view_order: VIEWS })).status)
      .toBeGreaterThanOrEqual(400);
  });
});
