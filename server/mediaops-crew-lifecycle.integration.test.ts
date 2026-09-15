// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the employee lifecycle: add → remove → re-add → reactivate.

   The bug this file exists to prevent recurring: removal archives the users row
   (status='archived') and deliberately keeps the id, because that id is what
   every report, assignment, equipment movement, leave request, KRA and audit
   entry points at. But POST /crew's duplicate check asked only

       SELECT 1 FROM users WHERE email=$1

   with no regard for status, so re-adding a removed colleague hit a flat
   "A user with that email already exists." with nowhere to go. The tempting
   repairs are both wrong: a second row strands the history on an id nobody
   references, and a partial unique index gives getUserByEmail() — which login
   uses, and which takes rows[0] — two rows to choose between.

   So the assertions below are about IDENTITY, not just status codes: one row
   per email, the same id across the whole cycle, and every historical count
   unchanged at the end of it.

   The real route handlers are mounted on a throwaway express app, so what is
   tested is the code that ships, not a restatement of it. Fixtures are
   synthetic (emails at @lifecycle.invalid) and removed afterwards.

   Skips cleanly when no database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DOMAIN = "lifecycle.invalid";
let dbUp = false;
let pool: import("pg").Pool;
let server: Server;
let base = "";

/** The signed-in Admin every request in this file acts as. */
const ADMIN = { id: "zlc-admin", role: "admin", team: "media" };

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

/* The same plumbing server/index.ts hands the API, plus a stand-in for the auth
   middleware: identity is established by the session there, and pinned here. */
async function boot() {
  const express = (await import("express")).default;
  const { registerMediaOpsApi } = await import("./mediaops-api.js");
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.currentUser = ADMIN; next(); });
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

async function call(method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) as Record<string, unknown> };
}

const addMember = (email: string, extra: Record<string, unknown> = {}) =>
  call("POST", "/crew", { email, password: "LifecyclePw!1", full_name: "ZZ Lifecycle", role: "employee", ...extra });

/** Every table that must still point at this person after a remove/reactivate. */
async function history(userId: string) {
  const q = async (sql: string) => Number((await pool.query(sql, [userId])).rows[0].c);
  return {
    reports:      await q(`SELECT count(*)::int c FROM mo_daily_reports WHERE user_id=$1`),
    tasks:        await q(`SELECT count(*)::int c FROM mo_report_tasks t
                             JOIN mo_daily_reports r ON r.id=t.daily_report_id WHERE r.user_id=$1`),
    assignments:  await q(`SELECT count(*)::int c FROM mo_project_assignments WHERE user_id=$1`),
    equipment:    await q(`SELECT count(*)::int c FROM mo_equipment_transactions WHERE holder_id=$1`),
    leave:        await q(`SELECT count(*)::int c FROM mo_leave_requests WHERE user_id=$1`),
    kra:          await q(`SELECT count(*)::int c FROM mo_kras WHERE user_id=$1`),
    performance:  await q(`SELECT count(*)::int c FROM mo_performance_snapshots WHERE user_id=$1`),
  };
}

/** Give a member one row in each history table, so preservation is observable. */
async function seedHistory(userId: string) {
  await pool.query(`INSERT INTO mo_daily_reports (user_id, report_date, status, total_minutes)
                    VALUES ($1, CURRENT_DATE - 5, 'approved', 300)
                    ON CONFLICT (user_id, report_date) DO NOTHING`, [userId]);
  await pool.query(`INSERT INTO mo_report_tasks (daily_report_id, description, minutes)
                    SELECT id, 'lifecycle probe', 300 FROM mo_daily_reports WHERE user_id=$1 LIMIT 1`, [userId]);
  await pool.query(`INSERT INTO mo_project_assignments (project_id, user_id, assigned_by)
                    SELECT id, $1, $1 FROM mo_projects WHERE deleted_at IS NULL ORDER BY id LIMIT 1`, [userId]);
  await pool.query(`INSERT INTO mo_equipment_transactions (equipment_item_id, holder_id, action, occurred_at)
                    SELECT id, $1, 'check_out', NOW() - interval '20 days'
                      FROM mo_equipment_items WHERE deleted_at IS NULL ORDER BY id LIMIT 1`, [userId]);
  await pool.query(`INSERT INTO mo_leave_requests (user_id, leave_type_id, starts_on, ends_on, status)
                    SELECT $1, id, CURRENT_DATE - 40, CURRENT_DATE - 39, 'approved'
                      FROM mo_leave_types ORDER BY id LIMIT 1`, [userId]);
  await pool.query(`INSERT INTO mo_kras (kra_cycle_id, user_id, title)
                    SELECT id, $1, 'lifecycle probe' FROM mo_kra_cycles ORDER BY id LIMIT 1`, [userId]);
  await pool.query(`INSERT INTO mo_performance_snapshots (user_id, month)
                    VALUES ($1, date_trunc('month', CURRENT_DATE - 90)::date)`, [userId]);
}

async function cleanup() {
  const ids = (await pool.query(
    `SELECT id FROM users WHERE email LIKE $1 OR id = $2`, [`%@${DOMAIN}`, ADMIN.id])).rows.map((r) => String(r.id));
  for (const id of ids) {
    for (const sql of [
      `DELETE FROM mo_report_tasks WHERE daily_report_id IN (SELECT id FROM mo_daily_reports WHERE user_id=$1)`,
      `DELETE FROM mo_daily_reports WHERE user_id=$1`,
      `DELETE FROM mo_project_assignments WHERE user_id=$1`,
      `DELETE FROM mo_equipment_transactions WHERE holder_id=$1`,
      `DELETE FROM mo_leave_requests WHERE user_id=$1`,
      `DELETE FROM mo_kras WHERE user_id=$1`,
      `DELETE FROM mo_performance_snapshots WHERE user_id=$1`,
      `DELETE FROM mo_team_members WHERE user_id=$1`,
      `DELETE FROM mo_audit_logs WHERE actor_id=$1`,
      `UPDATE users SET deactivated_by=NULL WHERE deactivated_by=$1`,
      `DELETE FROM mo_user_profiles WHERE user_id=$1`,
      `DELETE FROM users WHERE id=$1`,
    ]) await pool.query(sql, [id]);
  }
}

beforeAll(async () => {
  if (!dbUp) return;
  await cleanup();
  await pool.query(
    `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
     VALUES ($1,'ZZ Lifecycle Admin',$2,'admin','media','active','x','')`,
    [ADMIN.id, `admin@${DOMAIN}`]);
  await boot();
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

maybe("adding a member", () => {
  it("creates a brand-new identity", async () => {
    const r = await addMember(`fresh@${DOMAIN}`);
    expect(r.status).toBe(201);
    expect(r.body.id).toBeTruthy();
  });

  it("refuses a second ACTIVE account on the same email, and says which case it is", async () => {
    const r = await addMember(`fresh@${DOMAIN}`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ACTIVE_DUPLICATE");
    expect(r.body.message).toBe("A user with that email already exists.");
  });

  it("normalises case and surrounding whitespace before deciding", async () => {
    /* UNIQUE(email) is case-SENSITIVE, so a check on the raw column would let
       'Fresh@…' through and create a second identity that login then picks
       between arbitrarily. The check matches on LOWER(email), as login does. */
    for (const variant of [`FRESH@${DOMAIN.toUpperCase()}`, `  fresh@${DOMAIN}  `, `FrEsH@${DOMAIN}`]) {
      const r = await addMember(variant);
      expect(r.status, `variant ${variant} was allowed through`).toBe(409);
      expect(r.body.code).toBe("ACTIVE_DUPLICATE");
    }
    const rows = await pool.query(`SELECT count(*)::int c FROM users WHERE LOWER(email)=$1`, [`fresh@${DOMAIN}`]);
    expect(rows.rows[0].c).toBe(1);
  });

  it("lets the database settle a race rather than creating two identities", async () => {
    // The check is a read before a write, so concurrent Admins can both pass it.
    const email = `race@${DOMAIN}`;
    const all = await Promise.all([1, 2, 3, 4].map(() => addMember(email)));
    expect(all.filter((r) => r.status === 201)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409)).toHaveLength(3);
    for (const r of all.filter((x) => x.status === 409)) expect(r.body.code).toBe("ACTIVE_DUPLICATE");
    const rows = await pool.query(`SELECT count(*)::int c FROM users WHERE LOWER(email)=$1`, [email]);
    expect(rows.rows[0].c).toBe(1);
  });
});

maybe("re-adding someone who was removed", () => {
  const email = `returner@${DOMAIN}`;
  let id = "";
  let before: Awaited<ReturnType<typeof history>>;

  beforeAll(async () => {
    if (!dbUp) return;
    id = String((await addMember(email, { designation: "Camera Op", allowed_modules: ["home", "my-day"] })).body.id);
    await seedHistory(id);
    before = await history(id);
    await call("DELETE", `/crew/${id}`, { reason: "lifecycle test" });
  });

  it("archives the row instead of deleting it, keeping the id", async () => {
    const row = (await pool.query(`SELECT id, status FROM users WHERE LOWER(email)=$1`, [email])).rows[0];
    expect(row.id).toBe(id);
    expect(row.status).toBe("archived");
  });

  it("offers reactivation instead of a dead-end duplicate error", async () => {
    const r = await addMember(email, { role: "team_lead" });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("REMOVED_USER_EXISTS");
    const u = r.body.user as Record<string, unknown>;
    expect(u.id).toBe(id);                 // enough for the Admin to recognise them
    expect(u.same_team).toBe(true);
    expect(u.status).toBe("archived");
  });

  it("returns nothing beyond what the Admin needs to decide", async () => {
    const u = (await addMember(email)).body.user as Record<string, unknown>;
    expect(Object.keys(u).sort()).toEqual(
      ["deactivated_at", "email", "full_name", "id", "same_team", "status"]);
  });

  it("reactivates the SAME identity, applying the role and modules just chosen", async () => {
    const r = await call("POST", `/crew/${id}/restore`, {
      password: "LifecyclePw!1", role: "team_lead", designation: "Senior Camera Op",
      allowed_modules: ["home", "my-day", "equipment"],
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(id);

    const row = (await pool.query(
      `SELECT u.id, u.status, u.role, p.designation, p.mo_role, p.allowed_modules
         FROM users u JOIN mo_user_profiles p ON p.user_id=u.id WHERE u.id=$1`, [id])).rows[0];
    expect(row.status).toBe("active");
    expect(row.role).toBe("sub_admin");           // team_lead maps to the platform role
    expect(row.mo_role).toBe("team_lead");
    expect(row.designation).toBe("Senior Camera Op");
    expect(row.allowed_modules).toEqual(["home", "my-day", "equipment"]);
  });

  it("leaves every historical record attached, and creates no second row", async () => {
    expect(await history(id)).toEqual(before);
    const rows = await pool.query(`SELECT count(*)::int c FROM users WHERE LOWER(email)=$1`, [email]);
    expect(rows.rows[0].c).toBe(1);
  });

  it("restores a password that can actually be verified", async () => {
    /* Removal replaces the hash with 'removed:<uuid>', which no password can
       produce. Without setting a new one here the reactivated account would be
       active and still unable to sign in. */
    const { verifyPassword } = await import("./password.js");
    const hash = (await pool.query(`SELECT password_hash FROM users WHERE id=$1`, [id])).rows[0].password_hash;
    expect(String(hash).startsWith("removed:")).toBe(false);
    expect(await verifyPassword("LifecyclePw!1", hash)).toBe(true);
  });

  it("refuses a duplicate again once they are active", async () => {
    const r = await addMember(email);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("ACTIVE_DUPLICATE");
  });
});

maybe("reactivation grants nothing the Admin did not ask for", () => {
  const email = `bare@${DOMAIN}`;
  let id = "";

  beforeAll(async () => {
    if (!dbUp) return;
    id = String((await addMember(email, { allowed_modules: ["home", "projects"] })).body.id);
    await call("DELETE", `/crew/${id}`, {});
  });

  it("keeps the prior module grant when none is supplied", async () => {
    // An absent field leaves the previous value alone; it must not fall back to
    // a role default and quietly widen access.
    const r = await call("POST", `/crew/${id}/restore`, {});
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT allowed_modules FROM mo_user_profiles WHERE user_id=$1`, [id])).rows[0];
    expect(row.allowed_modules).toEqual(["home", "projects"]);
  });

  it("still reports that a password is needed when none was given", async () => {
    await call("DELETE", `/crew/${id}`, {});
    const r = await call("POST", `/crew/${id}/restore`, {});
    expect(r.body.needs_password_reset).toBe(true);
    expect(r.body.password_set).toBe(false);
  });

  it("rejects a password that is too short rather than setting it", async () => {
    await call("DELETE", `/crew/${id}`, {});
    const r = await call("POST", `/crew/${id}/restore`, { password: "abc" });
    expect(r.status).toBe(400);
  });
});

maybe("a removed account belonging to another team", () => {
  const email = `outsider@${DOMAIN}`;

  beforeAll(async () => {
    if (!dbUp) return;
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ('zlc-outsider','ZZ Outsider',$1,'user',NULL,'archived','x','')`, [email]);
  });

  it("is reported as removed but NOT offered for reactivation here", async () => {
    /* Reactivating them into the media crew would move an identity between
       departments behind the Admin's back; adding a second row would split
       their history. The UI shows the explanation and offers no button. */
    const r = await addMember(email);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("REMOVED_USER_EXISTS");
    expect((r.body.user as Record<string, unknown>).same_team).toBe(false);
  });

  it("is refused by the restore endpoint, which is crew-only", async () => {
    const r = await call("POST", "/crew/zlc-outsider/restore", {});
    expect(r.status).toBe(404);
  });
});
