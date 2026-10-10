// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the outreach Users tab's API (Account Tabs & State-wise
   Analytics requirements §1–2, PRD §4.4–4.6 and 6.2), against a real
   PostgreSQL.

   Pins who may list, configure, change, disable and remove outreach people,
   and what each of those actually does to the account:
     - Disable must stop a sign-in. Nerve's shared status check does not (its
       user lookup carries no status), so the password is set aside and put
       back on Enable — the property tested is the hash, which is what
       sign-in compares.
     - Remove must release the email, so the same address can be used again.

   Fixtures are "oar…" rows, removed afterwards. Skips cleanly when no test
   database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = `oar${Date.now().toString(36)}`;
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

const A = {
  super:     { id: `${PX}-super`, role: "super_admin", team: null },
  manager:   { id: `${PX}-mgr`, role: "outreach_manager", team: "outreach" },
  publisher: { id: `${PX}-pub`, role: "outreach_publisher", team: "outreach" },
  editor:    { id: `${PX}-ed`, role: "outreach_editor", team: "outreach" },
  videoAdmin: { id: `${PX}-adm`, role: "admin", team: "outreach" },
  branding:  { id: `${PX}-brand`, role: "admin", team: "branding" },
} as const;
type Actor = keyof typeof A;

{
  const t = await connectTestDatabase();
  pool = t.pool;
  dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

async function call(actor: Actor, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> };
}

const hashOf = async (id: string) =>
  (await pool.query<{ password_hash: string; status: string; email: string }>(
    `SELECT password_hash, status, email FROM users WHERE id = $1`, [id])).rows[0];

maybe("the outreach Users tab API", () => {
  beforeAll(async () => {
    const db = await import("./outreach-db.js");
    await db.bootstrapOutreach();
    // connect-pg-simple's table; the API clears sessions on disable and remove.
    await pool.query(`CREATE TABLE IF NOT EXISTS session (sid varchar PRIMARY KEY, sess json NOT NULL, expire timestamp(6) NOT NULL)`);
    for (const a of Object.values(A)) {
      await pool.query(
        `INSERT INTO users (id, full_name, email, role, team, password_hash) VALUES ($1, $1, $2, $3, $4, 'real-hash')`,
        [a.id, `${a.id}@example.test`, a.role, a.team]);
    }
    await pool.query(
      `INSERT INTO session (sid, sess, expire) VALUES ($1, $2::json, NOW() + interval '1 day')`,
      [`${PX}-sid`, JSON.stringify({ userId: A.editor.id })]);

    const express = (await import("express")).default;
    const { registerOutreachAccessApi } = await import("./outreach-access-routes.js");
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const a = A[req.headers["x-actor"] as Actor];
      res.locals.currentUser = a ? { ...a, full_name: a.id, email: `${a.id}@example.test` } : null;
      next();
    });
    registerOutreachAccessApi(app, {
      asyncHandler: fn => (req, res, next) => { fn(req, res, next).catch(next); },
      sendError: (res, status, message) => { res.status(status).json({ message }); },
      getSingleParam: v => (Array.isArray(v) ? v[0] : v),
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server?.close();
    const ids = Object.values(A).map(a => a.id);
    await pool.query(`DELETE FROM session WHERE sid = $1`, [`${PX}-sid`]);
    await pool.query(`DELETE FROM outreach_user_audit WHERE target_user_id = ANY($1::text[])`, [ids]);
    await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [ids]);
  });

  it("lists the team to the admins and to whoever holds the Users tab, and nobody else", async () => {
    const listed = await call("manager", "GET", "/api/outreach/access/users");
    expect(listed.status).toBe(200);
    const ids = (listed.body.users as Array<{ id: string }>).map(u => u.id);
    expect(ids).toEqual(expect.arrayContaining([A.manager.id, A.editor.id, A.publisher.id]));
    expect(ids).not.toContain(A.branding.id);
    // A publisher's role gives no Users tab; another department gets nothing.
    expect((await call("publisher", "GET", "/api/outreach/access/users")).status).toBe(403);
    expect((await call("branding", "GET", "/api/outreach/access/users")).status).toBe(403);
  });

  it("saves a person's tabs and states, cleaned and canonicalised, and refuses non-admins", async () => {
    const saved = await call("manager", "PUT", `/api/outreach/access/users/${A.editor.id}`,
      { tabs: { pages: "edit", analytics: "edit", nope: "view" }, allStates: false, states: ["gujarat", "Tamilnadu"] });
    expect(saved.status).toBe(200);
    expect(saved.body.access).toMatchObject({
      configured: true,
      tabs: { pages: "edit", analytics: "view" },
      scope: { kind: "states", states: ["Gujarat", "Tamil Nadu"] },
    });
    expect((await call("manager", "PUT", `/api/outreach/access/users/${A.editor.id}`,
      { tabs: {}, states: ["Atlantis"] })).status).toBe(400);
    // The video workflow's Admin no longer configures anyone.
    expect((await call("videoAdmin", "PUT", `/api/outreach/access/users/${A.editor.id}`,
      { tabs: {}, allStates: true })).status).toBe(403);
    // The video workflow Admin is the super admin's to limit.
    expect((await call("manager", "PUT", `/api/outreach/access/users/${A.videoAdmin.id}`,
      { tabs: {}, allStates: true })).status).toBe(403);
    expect((await call("super", "PUT", `/api/outreach/access/users/${A.videoAdmin.id}`,
      { tabs: { queue: "edit" }, allStates: true })).status).toBe(200);
    // Managers always have everything; there is nothing to save for them.
    expect((await call("super", "PUT", `/api/outreach/access/users/${A.manager.id}`,
      { tabs: {}, allStates: true })).status).toBe(400);
  });

  it("changes a role within the ceilings", async () => {
    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.publisher.id}`, { role: "admin" })).status).toBe(400);
    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.videoAdmin.id}`, { role: "outreach_editor" })).status).toBe(403);
    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.manager.id}`, { role: "outreach_editor" })).status).toBe(400);
    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.super.id}`, { active: false })).status).toBe(404);
    expect((await call("publisher", "PATCH", `/api/outreach/access/users/${A.editor.id}`, { role: "outreach_manager" })).status).toBe(403);

    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.publisher.id}`, { role: "outreach_editor" })).status).toBe(200);
    expect((await pool.query(`SELECT role FROM users WHERE id = $1`, [A.publisher.id])).rows[0].role).toBe("outreach_editor");
    await call("manager", "PATCH", `/api/outreach/access/users/${A.publisher.id}`, { role: "outreach_publisher" });
  });

  it("locks a disabled person out of sign-in and gives them back their own password on Enable", async () => {
    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.editor.id}`, { active: false })).status).toBe(200);
    let row = await hashOf(A.editor.id);
    expect(row.status).toBe("inactive");
    expect(row.password_hash).toMatch(/^disabled:/);
    expect((await pool.query(`SELECT 1 FROM session WHERE sid = $1`, [`${PX}-sid`])).rowCount).toBe(0);

    // Twice is harmless: the real password is not overwritten by the placeholder.
    await call("manager", "PATCH", `/api/outreach/access/users/${A.editor.id}`, { active: false });
    expect((await call("manager", "PATCH", `/api/outreach/access/users/${A.editor.id}`, { active: true })).status).toBe(200);
    row = await hashOf(A.editor.id);
    expect(row).toMatchObject({ status: "active", password_hash: "real-hash" });

    // A password reset while disabled wins over the one set aside.
    await call("manager", "PATCH", `/api/outreach/access/users/${A.editor.id}`, { active: false });
    await pool.query(`UPDATE users SET password_hash = 'reset-hash' WHERE id = $1`, [A.editor.id]);
    await call("manager", "PATCH", `/api/outreach/access/users/${A.editor.id}`, { active: true });
    expect((await hashOf(A.editor.id)).password_hash).toBe("reset-hash");
  });

  it("removes a person for good and releases their email", async () => {
    expect((await call("manager", "DELETE", `/api/outreach/access/users/${A.manager.id}`)).status).toBe(400);
    expect((await call("manager", "DELETE", `/api/outreach/access/users/${A.videoAdmin.id}`)).status).toBe(403);

    const removed = await call("manager", "DELETE", `/api/outreach/access/users/${A.editor.id}`);
    expect(removed).toMatchObject({ status: 200, body: { removed: true, email: `${A.editor.id}@example.test` } });
    const row = await hashOf(A.editor.id);
    expect(row.status).toBe("archived");
    expect(row.email).toMatch(/@removed\.invalid$/);
    expect(row.password_hash).not.toBe("reset-hash");
    for (const table of ["outreach_user_access", "outreach_user_tabs", "outreach_user_states", "outreach_disabled_logins"]) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [A.editor.id])).rowCount, table).toBe(0);
    }
    // The address is free again, and the audit keeps the real one.
    expect((await pool.query(`SELECT 1 FROM users WHERE lower(email) = lower($1)`, [`${A.editor.id}@example.test`])).rowCount).toBe(0);
    const audit = await pool.query(`SELECT target_email FROM outreach_user_audit WHERE target_user_id = $1 AND action = 'user.removed'`, [A.editor.id]);
    expect(audit.rows[0]?.target_email).toBe(`${A.editor.id}@example.test`);
    // Gone from the list, and a second removal is "not found".
    const ids = ((await call("manager", "GET", "/api/outreach/access/users")).body.users as Array<{ id: string }>).map(u => u.id);
    expect(ids).not.toContain(A.editor.id);
    expect((await call("manager", "DELETE", `/api/outreach/access/users/${A.editor.id}`)).status).toBe(404);
  });
});
