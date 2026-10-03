// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — per-link OTP verification on casting registration links.

   A link either requires applicants to prove an @allowed_domain address with a
   one-time code (the default, and every link made before the switch existed),
   or takes any address as typed. Off means anyone, so only an Admin may turn it
   off. An unproven address must never be able to overwrite someone's earlier
   submission, and the row says it was never verified.

   Real route handlers on a throwaway express app; synthetic `zco-` fixtures,
   removed afterwards. Skips cleanly when no database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zco";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let root = "";

const A = {
  admin: { id: `${PX}-admin`, role: "admin", team: "media" },
  mgr:   { id: `${PX}-mgr`,   role: "user",  team: "media" },   // holds the casting_manager duty
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
  root = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

async function as(actor: ActorName | "anon", method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await fetch(root + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

const mkLink = async (actor: ActorName, extra: Record<string, unknown> = {}) =>
  as(actor, "POST", "/media/casting-links", { name: `${PX} Drive`, ...extra });

const form = (extra: Record<string, unknown> = {}) => ({
  name: "Asha Patel", applicant_type: "Other", mobile_phone: "9876543210",
  photo_url: "https://drive.google.com/file/d/abc/view", consent: true, ...extra,
});

async function cleanup() {
  await pool.query(`DELETE FROM mo_casting_requests WHERE link_id IN
                      (SELECT id FROM mo_casting_links WHERE name LIKE $1)`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_casting_links WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
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
      [a.id, `ZCO ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  await pool.query(
    `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'ZCO','employee')
     ON CONFLICT (user_id) DO NOTHING`, [A.mgr.id]);
  await pool.query(
    `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at)
     SELECT $1, id, CURRENT_DATE FROM mo_duty_flags WHERE code='casting_manager'
     ON CONFLICT DO NOTHING`, [A.mgr.id]);
  await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

maybe("casting link OTP verification switch", () => {
  it("defaults to on, and the public page says verification is required", async () => {
    const c = await mkLink("mgr");
    expect(c.status).toBe(201);
    const link = c.body.link as Record<string, unknown>;
    expect(link.require_otp).toBe(true);
    const pub = await as("anon", "GET", `/public/casting/${link.token}`);
    expect((pub.body.campaign as Record<string, unknown>).require_otp).toBe(true);
    expect(pub.body.auth).toBe("email_otp");
  });

  it("refuses a submission without a verified session while verification is on", async () => {
    const link = (await mkLink("mgr")).body.link as Record<string, unknown>;
    const r = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "someone@gmail.com" }));
    expect(r.status).toBe(401);
  });

  it("lets only an Admin create a link with verification off", async () => {
    const byMgr = await mkLink("mgr", { require_otp: false });
    expect(byMgr.status).toBe(403);
    const byAdmin = await mkLink("admin", { require_otp: false });
    expect(byAdmin.status).toBe(201);
    expect((byAdmin.body.link as Record<string, unknown>).require_otp).toBe(false);
  });

  it("lets only an Admin switch it off on an existing link, but the Casting Manager may switch it back on", async () => {
    const link = (await mkLink("mgr")).body.link as Record<string, unknown>;
    expect((await as("mgr", "PATCH", `/media/casting-links/${link.id}`, { require_otp: false })).status).toBe(403);
    const off = await as("admin", "PATCH", `/media/casting-links/${link.id}`, { require_otp: false });
    expect((off.body.link as Record<string, unknown>).require_otp).toBe(false);
    const on = await as("mgr", "PATCH", `/media/casting-links/${link.id}`, { require_otp: true });
    expect(on.status).toBe(200);
    expect((on.body.link as Record<string, unknown>).require_otp).toBe(true);
  });

  it("takes any email as typed when off, marks the row unverified, and never sends a code", async () => {
    const link = (await mkLink("admin", { require_otp: false })).body.link as Record<string, unknown>;
    const pub = await as("anon", "GET", `/public/casting/${link.token}`);
    expect(pub.body.auth).toBe("none");
    expect((await as("anon", "POST", `/public/casting/${link.token}/otp/send`,
      { email: "a@paruluniversity.ac.in" })).status).toBe(400);

    expect((await as("anon", "POST", `/public/casting/${link.token}/submit`, form())).status).toBe(400);
    expect((await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "not-an-email" }))).status).toBe(400);

    const ok = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "Asha.Outside@Gmail.com" }));
    expect(ok.status).toBe(201);
    const row = (await pool.query(
      `SELECT applicant_email, email_verified FROM mo_casting_requests WHERE request_id=$1`,
      [ok.body.request_id])).rows[0];
    expect(row).toEqual({ applicant_email: "asha.outside@gmail.com", email_verified: false });
  });

  it("refuses a second submission from the same unproven address instead of overwriting the first", async () => {
    const link = (await mkLink("admin", { require_otp: false })).body.link as Record<string, unknown>;
    const first = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "dup@example.com" }));
    expect(first.status).toBe(201);
    const again = await as("anon", "POST", `/public/casting/${link.token}/submit`,
      form({ email: "dup@example.com", name: "Someone Else" }));
    expect(again.status).toBe(409);
    expect(again.body.request_id).toBeUndefined();
    const row = (await pool.query(
      `SELECT applicant_name FROM mo_casting_requests WHERE request_id=$1`, [first.body.request_id])).rows[0];
    expect(row.applicant_name).toBe("Asha Patel");
  });
});
