// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Custodian assignment (Phase 15).

   A custodian is not a role and not a table. It is the intersection of two
   things that already existed before this phase:

       equipment_custodian duty   → may act on equipment at all
       active scope assignment    → on which inventory

   The point of most of this file is that NEITHER HALF IS SUFFICIENT. A duty
   without an assignment reaches only the ungoverned estate; an assignment
   without the duty can look but not touch. Both are asserted, because a
   layered model that quietly collapses into "one check passed" is the failure
   this design exists to prevent.

   The other half is memory. Phase 13B could record an assignment and forget
   it; revocation was a hard delete. Accountability needs the opposite — a loan
   outlives a custodian's tenure — so revocation is now soft and the history is
   asserted to survive.

   Every fixture is prefixed `zcu` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zcu";
let dbUp = false;
/* PHASE 17F — a checkout needs a due date the SERVER will accept: in the
   future and inside the 30-day policy window. Captured from the database, not
   written as a literal, because a literal stops being in the future. */
let DUE = "";
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0, dutyId = 0;
let scopeA = 0, scopeB = 0;
let assetA = 0, assetB = 0, assetU = 0;

const A = {
  admin:    { id: `${PX}-admin`, role: "admin",     team: "media" },
  admin2:   { id: `${PX}-adm2`,  role: "admin",     team: "media" },
  lead:     { id: `${PX}-lead`,  role: "sub_admin", team: "media" },
  custA:    { id: `${PX}-custa`, role: "user",      team: "media" },
  custB:    { id: `${PX}-custb`, role: "user",      team: "media" },
  noDuty:   { id: `${PX}-nodut`, role: "user",      team: "media" },
  outsider: { id: `${PX}-out`,   role: "user",      team: "branding" },
} as const;
type ActorName = keyof typeof A;

{
  const t = await connectTestDatabase();
  pool = t.pool; dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZCU ${a.id}` }
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
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, never> };
}

const cust = (scope: number) => `/equipment/scopes/${scope}/custodians`;
const grantDuty = (userId: string) => pool.query(
  `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at) VALUES ($1,$2,CURRENT_DATE)
   ON CONFLICT DO NOTHING`, [userId, dutyId]);
const revokeDuty = (userId: string) => pool.query(
  `DELETE FROM mo_user_duties WHERE user_id=$1 AND duty_flag_id=$2`, [userId, dutyId]);
const rowsFor = async (scope: number) => (await pool.query(
  `SELECT * FROM mo_user_inventory_scopes WHERE scope_id=$1 ORDER BY id`, [scope])).rows;

async function cleanup() {
  const ids = (await pool.query(
    `SELECT id FROM mo_equipment_items WHERE asset_tag LIKE $1
       OR category_id IN (SELECT id FROM mo_equipment_categories WHERE name LIKE $2)`,
    [`EQ-${PX.toUpperCase()}-%`, `${PX} %`])).rows.map((r) => Number(r.id));
  if (ids.length) {
    await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(`DELETE FROM mo_equipment_categories WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_inventory_scopes WHERE code LIKE $1 OR created_by LIKE $2`,
    [`${PX}-%`, `${PX}-%`]);
  await pool.query(`DELETE FROM mo_campuses WHERE code LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1 OR entity_uid LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
  await bootstrapMediaOpsDatabase();
  DUE = (await pool.query(
    `SELECT to_char(CURRENT_DATE + 7, 'YYYY-MM-DD') AS d`)).rows[0].d as string;
  await cleanup();

  for (const a of Object.values(A))
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCU ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);

  for (const a of [A.admin, A.admin2, A.lead, A.custA, A.custB, A.noDuty])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZCU','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules`,
      [a.id, JSON.stringify(["home", "my-day", "equipment"])]);

  dutyId = Number((await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0].id);

  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',9999) RETURNING id`, [`${PX} Camera`])).rows[0].id);
  scopeA = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [`ZCU Scope A`, `${PX}-a`, A.admin.id])).rows[0].id);
  scopeB = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [`ZCU Scope B`, `${PX}-b`, A.admin.id])).rows[0].id);

  const mk = async (n: string, scope: number | null) => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, status)
     VALUES ($1,$2,'ZCU',$3,$4,'available') RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-${n}`, `Model ${n}`, scope])).rows[0].id);
  assetA = await mk("001", scopeA);
  assetB = await mk("002", scopeB);
  assetU = await mk("003", null);

  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

beforeEach(async () => {
  if (!dbUp) return;
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1 OR entity_uid LIKE $1`, [`${PX}-%`]);
  await pool.query(`UPDATE mo_inventory_scopes SET is_active=true, archived_at=NULL
                     WHERE id = ANY($1::bigint[])`, [[scopeA, scopeB]]);
  await pool.query(`UPDATE mo_equipment_items SET model='Model 001', status='available' WHERE id=$1`, [assetA]);
  await pool.query(`UPDATE mo_equipment_items SET model='Model 002', status='available' WHERE id=$1`, [assetB]);
  await grantDuty(A.custA.id); await grantDuty(A.custB.id);
  await revokeDuty(A.noDuty.id);
});

/* ─────────────────────────────────────────────────────────────────────────
   The migration.
   ───────────────────────────────────────────────────────────────────────── */
maybe("the assignment ledger", () => {
  it("carries the soft-revocation columns", async () => {
    const by = Object.fromEntries((await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name='mo_user_inventory_scopes'`)).rows.map((c) => [c.column_name, c.is_nullable]));
    for (const c of ["id", "user_id", "scope_id", "role", "granted_by", "granted_at", "removed_by", "removed_at"])
      expect(by[c], `missing column ${c}`).toBeDefined();
    expect(by.removed_at).toBe("YES");
    expect(by.role).toBe("NO");
  });

  it("keys on a surrogate id, not on the pair — that is what allows history", async () => {
    const pk = (await pool.query(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid='mo_user_inventory_scopes'::regclass AND i.indisprimary`)).rows.map((r) => r.attname);
    expect(pk).toEqual(["id"]);
  });

  it("allows one live assignment per pair, and any number of dead ones", async () => {
    const idx = (await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname='idx_mo_uis_active'`)).rows[0]?.indexdef ?? "";
    expect(idx).toMatch(/UNIQUE/);
    expect(idx).toMatch(/removed_at IS NULL/);
  });

  it("admits only the one role this phase defined", async () => {
    // A column that accepts anything is how an undesigned role taxonomy gets in.
    await expect(pool.query(
      `INSERT INTO mo_user_inventory_scopes (user_id, scope_id, role) VALUES ($1,$2,'inventory_manager')`,
      [A.custA.id, scopeA])).rejects.toThrow();
  });

  it("assigns no asset to a scope the migration could have invented", async () => {
    /* PHASE 15 ASSIGNS NO LEGACY ASSET TO ANY SCOPE.

       MEASURED BY ACTOR ON THE SCOPE, AND BY CATEGORY ON THE ASSET. Filtering
       the scope side alone was not enough: `created_by IS NULL` rules out a
       scope a test could have made, but says nothing about the ASSET attached
       to it, and from Phase 17C onwards sibling suites routinely attach their
       own fixtures to the two seeded inventories. Every suite in this
       repository names its fixture category '<zxx> Something', so an asset
       outside that shape is one the registry seeded — which is exactly the
       population a migration backfill would have moved, and one no sibling can
       write into. TEST_STABILITY entries 14 and 15; the same discriminator
       guards the equivalent tests in the scope and foundation suites. */
    const fabricated = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items i
         JOIN mo_inventory_scopes s ON s.id = i.scope_id
         JOIN mo_equipment_categories c ON c.id = i.category_id
        WHERE s.created_by IS NULL AND c.name !~ '^z[a-z][a-z] '`)).rows[0].c);
    expect(fabricated, "an asset was assigned to a migration-seeded scope").toBe(0);
    /* CHANGED BY PHASE 17A. This used to require ZERO migration-seeded scopes.
       Decision P-1 was taken on 2026-09-22, so the migration now seeds the two
       APPROVED inventories — and only those two. The claim that matters is
       unchanged and asserted above: seeding the NAME of an inventory assigns
       no asset to it. */
    expect((await pool.query(
      `SELECT code FROM mo_inventory_scopes WHERE created_by IS NULL ORDER BY code`))
      .rows.map((r) => r.code)).toEqual(["media_crew", "pid"]);
    /* This suite's OWN assets are the control: scope_id is set here, by hand,
       and nothing about the migration did it. */
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items
        WHERE asset_tag LIKE $1 AND scope_id IS NULL`, [`EQ-${PX.toUpperCase()}-%`])).rows[0].c)).toBe(1);
  });

  it("adds a text entity reference to the audit trail", async () => {
    const col = (await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_name='mo_audit_logs' AND column_name='entity_uid'`)).rows[0];
    expect(col?.data_type).toBe("text");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Appointing and revoking.
   ───────────────────────────────────────────────────────────────────────── */
maybe("appointment", () => {
  it("appoints a custodian", async () => {
    const r = await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect(r.status).toBe(201);
    const a = r.body.assignment as unknown as Record<string, unknown>;
    expect(a.user_id).toBe(A.custA.id);
    expect(a.role).toBe("custodian");
    expect(r.body.has_duty).toBe(true);
    expect(r.body.warning).toBeNull();
  });

  it("warns, rather than refuses, when the appointee lacks the duty", async () => {
    const r = await as("admin", "POST", cust(scopeA), { user_id: A.noDuty.id });
    expect(r.status).toBe(201);
    expect(r.body.has_duty).toBe(false);
    expect(String(r.body.warning)).toMatch(/not hold the Equipment Custodian duty/i);
  });

  it("lists the live custodians and reports the count", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin", "POST", cust(scopeA), { user_id: A.custB.id });
    const r = await as("admin", "GET", cust(scopeA));
    expect(r.status).toBe(200);
    expect((r.body.active as unknown as unknown[]).length).toBe(2);
    expect(r.body.active_count).toBe(2);
    expect(r.body.no_custodian).toBe(false);
    expect(r.body.history).toEqual([]);
  });

  it("refuses a duplicate live assignment", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    const dup = await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect(dup.status).toBe(409);
    expect((await rowsFor(scopeA)).length).toBe(1);
  });

  it("refuses self-appointment", async () => {
    const r = await as("admin", "POST", cust(scopeA), { user_id: A.admin.id });
    expect(r.status).toBe(403);
    expect((await rowsFor(scopeA)).length).toBe(0);
  });

  it("refuses an unknown user, an unknown scope and an inactive account", async () => {
    expect((await as("admin", "POST", cust(scopeA), { user_id: `${PX}-ghost` })).status).toBe(404);
    expect((await as("admin", "POST", cust(2147483000), { user_id: A.custA.id })).status).toBe(404);
    await pool.query(`UPDATE users SET status='inactive' WHERE id=$1`, [A.custB.id]);
    expect((await as("admin", "POST", cust(scopeA), { user_id: A.custB.id })).status).toBe(409);
    await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [A.custB.id]);
  });

  it("refuses an archived scope, because the assignment could not take effect", async () => {
    await pool.query(`UPDATE mo_inventory_scopes SET archived_at=NOW() WHERE id=$1`, [scopeA]);
    const r = await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect(r.status).toBe(409);
    await pool.query(`UPDATE mo_inventory_scopes SET archived_at=NULL WHERE id=$1`, [scopeA]);
  });

  it("validates its input", async () => {
    expect((await as("admin", "POST", cust(scopeA), {})).status).toBe(400);
    expect((await as("admin", "POST", cust(scopeA), { user_id: "   " })).status).toBe(400);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §16 — the record must survive revocation.
   ───────────────────────────────────────────────────────────────────────── */
maybe("revocation remembers", () => {
  it("revokes softly and keeps the row queryable", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    const r = await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    expect(r.status).toBe(200);

    const rows = await rowsFor(scopeA);
    expect(rows.length).toBe(1);                       // not deleted
    expect(rows[0].removed_at).not.toBeNull();
    expect(rows[0].removed_by).toBe(A.admin.id);
    expect(rows[0].granted_by).toBe(A.admin.id);
  });

  it("answers who was assigned, when they were removed and by whom", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin2", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    const h = (await as("admin", "GET", cust(scopeA))).body.history as unknown as Record<string, unknown>[];
    expect(h.length).toBe(1);
    expect(h[0].user_id).toBe(A.custA.id);
    expect(h[0].removed_by).toBe(A.admin2.id);
    expect(h[0].removed_by_name).toBe(`ZCU ${A.admin2.id}`);
    expect(h[0].granted_at).toBeTruthy();
    expect(h[0].removed_at).toBeTruthy();
  });

  it("re-appointing writes a NEW record and leaves the old one intact", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    const again = await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect(again.status).toBe(201);

    const rows = await rowsFor(scopeA);
    expect(rows.length).toBe(2);                       // history + live
    expect(rows.filter((r) => r.removed_at == null).length).toBe(1);
    expect(rows.filter((r) => r.removed_at != null).length).toBe(1);
    // The revival-by-clearing-removed_at shortcut would have left one row.
    expect(new Set(rows.map((r) => Number(r.id))).size).toBe(2);
  });

  it("404s a revoke with no live assignment, and does not rewrite the old one", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    const first = (await rowsFor(scopeA))[0];
    const second = await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    expect(second.status).toBe(404);
    const after = (await rowsFor(scopeA))[0];
    expect(String(after.removed_at)).toBe(String(first.removed_at));
    expect(after.removed_by).toBe(first.removed_by);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §9 — the last custodian.
   ───────────────────────────────────────────────────────────────────────── */
maybe("the last custodian may leave", () => {
  it("removing a non-last custodian leaves the scope covered", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin", "POST", cust(scopeA), { user_id: A.custB.id });
    const r = await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    expect(r.body.remaining_active).toBe(1);
    expect(r.body.no_custodian).toBe(false);
  });

  it("removing the last one is ALLOWED and reported", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    const r = await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    expect(r.status).toBe(200);
    expect(r.body.remaining_active).toBe(0);
    expect(r.body.no_custodian).toBe(true);
  });

  it("appoints nobody automatically to fill the gap", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_user_inventory_scopes
        WHERE scope_id=$1 AND removed_at IS NULL`, [scopeA])).rows[0].c)).toBe(0);
  });

  it("a custodian-less scope is a valid, derived state — not a stored one", async () => {
    const r = await as("admin", "GET", cust(scopeA));
    expect(r.status).toBe(200);
    expect(r.body.no_custodian).toBe(true);
    expect(r.body.active_count).toBe(0);
    // Derived from the absence of rows; no status column was invented for it.
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='mo_inventory_scopes'`)
    ).rows.map((c) => String(c.column_name));
    expect(cols).not.toContain("custodian_status");
    expect(cols).not.toContain("has_custodian");
  });

  it("the scope itself keeps working with no custodian", async () => {
    expect((await as("admin", "GET", `/crud/inventory_scopes/${scopeA}`)).status).toBe(200);
    expect((await as("admin", "GET", `/equipment/${assetA}`)).status).toBe(200);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §13 — who may administer, and what each half of custodianship buys.
   ───────────────────────────────────────────────────────────────────────── */
maybe("authorization", () => {
  it("only an Admin may appoint, revoke or view", async () => {
    for (const who of ["custA", "lead", "noDuty"] as const) {
      expect((await as(who, "GET", cust(scopeA))).status, who).toBe(403);
      expect((await as(who, "POST", cust(scopeA), { user_id: A.custB.id })).status, who).toBe(403);
      expect((await as(who, "DELETE", `${cust(scopeA)}/${A.custA.id}`)).status, who).toBe(403);
    }
    expect((await as("outsider", "GET", cust(scopeA))).status).toBe(403);
    expect((await as("anon", "GET", cust(scopeA))).status).toBe(403);
    expect((await rowsFor(scopeA)).length).toBe(0);
  });

  it("a custodian cannot appoint themselves to a scope", async () => {
    // The duty is a capability, not a licence to extend your own jurisdiction.
    expect((await as("custA", "POST", cust(scopeB), { user_id: A.custA.id })).status).toBe(403);
    expect((await rowsFor(scopeB)).length).toBe(0);
  });

  it("duty AND assignment together grant authority over that scope", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("custA", "PATCH", `/equipment/${assetA}`, { model: "ZCU edited" })).status).toBe(200);
  });

  it("assignment WITHOUT the duty is a viewer, not a custodian", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.noDuty.id });
    expect((await as("noDuty", "GET", `/equipment/${assetA}`)).status).toBe(200);   // may look
    const w = await as("noDuty", "PATCH", `/equipment/${assetA}`, { model: "ZCU nope" });
    expect(w.status).toBe(403);                                                      // may not act
    expect((await pool.query(`SELECT model FROM mo_equipment_items WHERE id=$1`, [assetA]))
      .rows[0].model).toBe("Model 001");
  });

  it("the duty WITHOUT an assignment reaches only the ungoverned estate", async () => {
    // custA holds the duty and has no assignment in this test.
    expect((await as("custA", "GET", `/equipment/${assetU}`)).status).toBe(200);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(404);
    expect((await as("custA", "PATCH", `/equipment/${assetA}`, { model: "ZCU nope" })).status).toBe(404);
  });

  it("revoking the assignment denies on the very next request", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(200);
    await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(404);
  });

  it("revoking the DUTY denies action even while the assignment stands", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect((await as("custA", "PATCH", `/equipment/${assetA}`, { model: "ZCU one" })).status).toBe(200);
    await revokeDuty(A.custA.id);
    const w = await as("custA", "PATCH", `/equipment/${assetA}`, { model: "ZCU two" });
    expect(w.status).toBe(403);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(200);  // still in jurisdiction
    expect((await pool.query(`SELECT model FROM mo_equipment_items WHERE id=$1`, [assetA]))
      .rows[0].model).toBe("ZCU one");
  });

  it("a custodian of A cannot reach B", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect((await as("custA", "GET", `/equipment/${assetB}`)).status).toBe(404);
    expect((await as("custA", "PATCH", `/equipment/${assetB}`, { model: "ZCU cross" })).status).toBe(404);
  });

  it("the Admin keeps everything, and holds no assignment", async () => {
    expect((await as("admin", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("admin", "GET", `/equipment/${assetB}`)).status).toBe(200);
    expect((await as("admin", "GET", `/equipment/${assetU}`)).status).toBe(200);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.admin.id])).rows[0].c)).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §6 — scope governance is Admin-only; the other config modules are not.
   ───────────────────────────────────────────────────────────────────────── */
maybe("scope governance is admin-only", () => {
  it("an Admin may still create and edit a scope", async () => {
    const r = await as("admin", "POST", "/crud/inventory_scopes", { name: "ZCU Made", code: `${PX}-made` });
    expect(r.status).toBe(201);
    const id = Number((r.body.row as unknown as { id: number }).id);
    expect((await as("admin", "PATCH", `/crud/inventory_scopes/${id}`, { name: "ZCU Renamed" })).status).toBe(200);
    expect((await as("admin", "POST", `/crud/inventory_scopes/${id}/state`, { action: "disable" })).status).toBe(200);
  });

  it("a Team Lead may NOT — deactivating a scope withdraws access", async () => {
    expect((await as("lead", "POST", "/crud/inventory_scopes",
      { name: "ZCU Lead", code: `${PX}-lead` })).status).toBe(403);
    expect((await as("lead", "PATCH", `/crud/inventory_scopes/${scopeA}`, { name: "ZCU Hijack" })).status).toBe(403);
    expect((await as("lead", "POST", `/crud/inventory_scopes/${scopeA}/state`,
      { action: "disable" })).status).toBe(403);
    expect((await pool.query(`SELECT name, is_active FROM mo_inventory_scopes WHERE id=$1`, [scopeA]))
      .rows[0]).toEqual({ name: "ZCU Scope A", is_active: true });
  });

  it("REGRESSION — every other config module keeps its old permissions", async () => {
    /* The override is per module. A Team Lead could always create a campus,
       and still can; if this fails, the change leaked. */
    const r = await as("lead", "POST", "/crud/campuses", { name: "ZCU Campus", code: `${PX}-camp` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = Number((r.body.row as unknown as { id: number }).id);
    expect((await as("lead", "PATCH", `/crud/campuses/${id}`, { name: "ZCU Campus 2" })).status).toBe(200);
    expect((await as("lead", "POST", `/crud/campuses/${id}/state`, { action: "disable" })).status).toBe(200);
    // Archive and delete were Admin-only before this phase and remain so.
    expect((await as("lead", "POST", `/crud/campuses/${id}/state`, { action: "archive" })).status).toBe(403);
  });

  it("tells the client which modules it may not write", async () => {
    const meta = await as("lead", "GET", "/crud/meta");
    const mods = meta.body.modules as unknown as { key: string; manage: string | null;
                                                   can: { create: boolean } }[];
    const scope = mods.find((m) => m.key === "inventory_scopes")!;
    const campus = mods.find((m) => m.key === "campuses")!;
    expect(scope.manage).toBe("admin");
    expect(scope.can.create).toBe(false);
    expect(campus.manage).toBeNull();
    expect(campus.can.create).toBe(true);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §8 / §14 — the trail.
   ───────────────────────────────────────────────────────────────────────── */
maybe("audit", () => {
  const trail = async (action: string) => (await pool.query(
    `SELECT actor_id, entity_type, entity_id, entity_uid, before, after
       FROM mo_audit_logs WHERE action=$1 AND actor_id LIKE $2 ORDER BY occurred_at DESC`,
    [action, `${PX}-%`])).rows;

  it("records an appointment against the scope and the person", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    const [a] = await trail("inventory_scope.custodian_assigned");
    expect(a).toBeDefined();
    expect(a.actor_id).toBe(A.admin.id);
    expect(Number(a.entity_id)).toBe(scopeA);
    expect(a.entity_uid).toBe(A.custA.id);
    expect(a.entity_type).toBe("inventory_scopes");
  });

  it("records a revocation the same way", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await as("admin", "DELETE", `${cust(scopeA)}/${A.custA.id}`);
    const [a] = await trail("inventory_scope.custodian_removed");
    expect(Number(a.entity_id)).toBe(scopeA);
    expect(a.entity_uid).toBe(A.custA.id);
  });

  it("shows custodian changes in the scope's existing Audit History", async () => {
    /* entity_type is the CRUD module key, so GET /crud/inventory_scopes/:id
       picks these up with no new query and no new screen. */
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    const v = await as("admin", "GET", `/crud/inventory_scopes/${scopeA}`);
    const actions = (v.body.audit as unknown as { action: string }[]).map((x) => x.action);
    expect(actions).toContain("inventory_scope.custodian_assigned");
  });

  it("FIXES THE GAP — a duty grant names the affected user", async () => {
    await as("admin", "POST", `/crew/${A.custB.id}/duties`, { duty_flag_id: dutyId, grant: true });
    const [a] = await trail("user.duty_granted");
    expect(a).toBeDefined();
    expect(a.entity_uid).toBe(A.custB.id);      // was unqueryable before Phase 15
    expect(a.entity_type).toBe("user");         // vocabulary unchanged
  });

  it("FIXES THE GAP — a duty revoke names the affected user", async () => {
    await as("admin", "POST", `/crew/${A.custB.id}/duties`, { duty_flag_id: dutyId, grant: false });
    const [a] = await trail("user.duty_revoked");
    expect(a.entity_uid).toBe(A.custB.id);
    expect(a.entity_type).toBe("user");
  });

  it("makes 'every duty change for this person' a query", async () => {
    await as("admin", "POST", `/crew/${A.custB.id}/duties`, { duty_flag_id: dutyId, grant: true });
    await as("admin", "POST", `/crew/${A.custB.id}/duties`, { duty_flag_id: dutyId, grant: false });
    const n = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs
        WHERE entity_type='user' AND entity_uid=$1 AND action LIKE 'user.duty_%'`,
      [A.custB.id])).rows[0].c);
    expect(n).toBe(2);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §20 — two admins at once.
   ───────────────────────────────────────────────────────────────────────── */
maybe("concurrency", () => {
  it("two admins appointing the same person produce ONE live assignment", async () => {
    const [x, y] = await Promise.all([
      as("admin",  "POST", cust(scopeA), { user_id: A.custA.id }),
      as("admin2", "POST", cust(scopeA), { user_id: A.custA.id }),
    ]);
    const codes = [x.status, y.status].sort();
    expect(codes, `statuses: ${codes.join(",")}`).toEqual([201, 409]);
    expect((await rowsFor(scopeA)).filter((r) => r.removed_at == null).length).toBe(1);
  });

  it("two admins revoking the same person produce one revocation", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    const [x, y] = await Promise.all([
      as("admin",  "DELETE", `${cust(scopeA)}/${A.custA.id}`),
      as("admin2", "DELETE", `${cust(scopeA)}/${A.custA.id}`),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 404]);
    const rows = await rowsFor(scopeA);
    expect(rows.length).toBe(1);
    expect(rows[0].removed_at).not.toBeNull();
  });

  it("revoke and re-appoint racing never leaves two live assignments", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    await Promise.all([
      as("admin",  "DELETE", `${cust(scopeA)}/${A.custA.id}`),
      as("admin2", "POST",   cust(scopeA), { user_id: A.custA.id }),
    ]);
    expect((await rowsFor(scopeA)).filter((r) => r.removed_at == null).length).toBeLessThanOrEqual(1);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   §11/§12 — the legacy estate is untouched.
   ───────────────────────────────────────────────────────────────────────── */
maybe("legacy assets keep working", () => {
  it("an ungoverned asset is reachable by everyone who could reach it before", async () => {
    for (const who of ["admin", "custA", "custB", "noDuty", "lead"] as const)
      expect((await as(who, "GET", `/equipment/${assetU}`)).status, who).toBe(200);
  });

  it("appointing custodians elsewhere does not govern it", async () => {
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect((await as("custB", "GET", `/equipment/${assetU}`)).status).toBe(200);
    expect((await pool.query(`SELECT scope_id FROM mo_equipment_items WHERE id=$1`, [assetU]))
      .rows[0].scope_id).toBeNull();
  });

  /* ── Phase 16: the legacy estate must still be WRITABLE ──────────────────
     Found by mutation testing. Making scopeAllows() deny a NULL scope broke
     nothing in the suite, because every legacy assertion here was a READ — and
     reads take the NULL branch of inventoryScopeSql() in SQL, not scopeAllows().
     assetScopeOk(), which every single-asset WRITE goes through, was therefore
     unprotected on exactly the path that matters most today: all 32 production
     assets are unscoped, so if scopeAllows() ever stopped allowing NULL, every
     custodian would silently lose the ability to act on the entire estate and
     no test would say so. */
  it("a duty holder with NO assignment can still act on an ungoverned asset", async () => {
    // This is every custodian in production today: duty, no scope, legacy estate.
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_user_inventory_scopes WHERE user_id=$1 AND removed_at IS NULL`,
      [A.custA.id])).rows[0].c), "custA should hold no assignment here").toBe(0);

    const r = await as("custA", "PATCH", `/equipment/${assetU}`, { model: "ZCU legacy edit" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await pool.query(`SELECT model FROM mo_equipment_items WHERE id=$1`, [assetU]))
      .rows[0].model).toBe("ZCU legacy edit");
    await pool.query(`UPDATE mo_equipment_items SET model='Model 003' WHERE id=$1`, [assetU]);
  });

  it("a scoped custodian can also act on an ungoverned asset", async () => {
    // Holding a scope must not COST you the legacy estate.
    await as("admin", "POST", cust(scopeA), { user_id: A.custA.id });
    expect((await as("custA", "POST", `/equipment/${assetU}/status`,
      { status: "maintenance" })).status).toBe(200);
    await pool.query(`UPDATE mo_equipment_items SET status='available' WHERE id=$1`, [assetU]);
  });

  it("an ungoverned asset can still be checked out and booked", async () => {
    const co = await as("custA", "POST", `/equipment/${assetU}/checkout`, { user_id: A.custA.id, expected_return_at: DUE });
    expect(co.status, JSON.stringify(co.body)).toBe(201);
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id=$1`, [assetU]);
    await pool.query(`UPDATE mo_equipment_items SET status='available' WHERE id=$1`, [assetU]);

    const bk = await as("custA", "POST", "/equipment/bookings",
      { equipment_item_id: assetU, starts_at: "2031-01-01", ends_at: "2031-01-02" });
    expect(bk.status, JSON.stringify(bk.body)).toBe(201);
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id=$1`, [assetU]);
  });

  it("still ships no scope data in the boot payload", async () => {
    const r = await as("admin", "GET", "/state");
    expect(r.status).toBe(200);
    const keys = Object.keys(r.body);
    expect(keys).not.toContain("inventory_scopes");
    expect(keys).not.toContain("user_inventory_scopes");
    expect(keys).not.toContain("custodians");
  });
});
