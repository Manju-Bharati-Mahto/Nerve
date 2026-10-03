// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Equipment → Permissions (the popup on the Equipment page).

   One screen now administers every equipment grant: the inventories, who holds
   which, the custodian duty, and Equipment / Kiosk module access. It invents no
   authority of its own — it writes the rows the existing gates read — so most
   of this file proves the EFFECT, not the write: after a save, can the person
   actually reach and edit the asset the screen says they can?

   The other half is that a save is one decision. Many people are planned
   before anything is written, and one refusal leaves every one of them as
   they were.

   Every fixture is prefixed `zep` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zep";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0, dutyId = 0;
let scopeA = 0, scopeB = 0;
let assetA = 0, assetB = 0;

const A = {
  admin:    { id: `${PX}-admin`, role: "admin",     team: "media" },
  admin2:   { id: `${PX}-adm2`,  role: "admin",     team: "media" },
  lead:     { id: `${PX}-lead`,  role: "sub_admin", team: "media" },
  cust:     { id: `${PX}-cust`,  role: "user",      team: "media" },
  plain:    { id: `${PX}-plain`, role: "user",      team: "media" },
  other:    { id: `${PX}-other`, role: "user",      team: "media" },
  gone:     { id: `${PX}-gone`,  role: "user",      team: "media" },
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
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZEP ${a.id}` }
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

type Body = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
async function as(actor: ActorName, method: string, path: string, body?: unknown) {
  const r = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json", "x-actor": actor },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Body };
}
const save = (changes: unknown[], actor: ActorName = "admin") =>
  as(actor, "PATCH", "/equipment/permissions", { changes });

const liveScopes = async (uid: string) => (await pool.query(
  `SELECT scope_id FROM mo_user_inventory_scopes WHERE user_id=$1 AND removed_at IS NULL ORDER BY scope_id`,
  [uid])).rows.map((r) => Number(r.scope_id));
const holdsDuty = async (uid: string) => (await pool.query(
  `SELECT 1 FROM mo_user_duties WHERE user_id=$1 AND duty_flag_id=$2`, [uid, dutyId])).rows.length > 0;
const modulesOf = async (uid: string) => (await pool.query(
  `SELECT allowed_modules FROM mo_user_profiles WHERE user_id=$1`, [uid])).rows[0]?.allowed_modules ?? null;

async function cleanup() {
  await pool.query(`DELETE FROM mo_equipment_items WHERE asset_tag LIKE $1`, [`EQ-${PX.toUpperCase()}-%`]);
  await pool.query(`DELETE FROM mo_equipment_categories WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_inventory_scopes WHERE code LIKE $1 OR created_by LIKE $2`,
    [`${PX}%`, `${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

/** Every person back to: Equipment only, no inventory, no duty — except the custodian. */
async function reset() {
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`UPDATE users SET status='active' WHERE id LIKE $1`, [`${PX}-%`]);
  await pool.query(`UPDATE users SET status='inactive' WHERE id=$1`, [A.gone.id]);
  await pool.query(`UPDATE mo_inventory_scopes SET archived_at=NULL, is_active=true WHERE id = ANY($1::bigint[])`,
    [[scopeA, scopeB]]);
  for (const a of [A.cust, A.plain, A.other, A.gone])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZEP','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules, mo_role='employee'`,
      [a.id, JSON.stringify(["home", "my-day", "equipment"])]);
  await pool.query(
    `INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3)`,
    [A.cust.id, scopeA, A.admin2.id]);
  await pool.query(
    `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at) VALUES ($1,$2,CURRENT_DATE)`,
    [A.cust.id, dutyId]);
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
      [a.id, `ZEP ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);

  dutyId = Number((await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0].id);
  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',9999) RETURNING id`, [`${PX} Camera`])).rows[0].id);
  scopeA = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [`ZEP Scope A`, `${PX}-a`, A.admin.id])).rows[0].id);
  scopeB = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [`ZEP Scope B`, `${PX}-b`, A.admin.id])).rows[0].id);
  const mk = async (n: string, scope: number) => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, status)
     VALUES ($1,$2,'ZEP',$3,$4,'available') RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-${n}`, n, scope])).rows[0].id);
  assetA = await mk("A", scopeA);
  assetB = await mk("B", scopeB);
  await boot();
});

afterAll(async () => {
  if (!dbUp) return;
  await new Promise((r) => server.close(r));
  await cleanup();
  await pool.end();
});

maybe("Equipment → Permissions: reading the picture", () => {
  beforeEach(reset);

  it("is an Admin's screen — a custodian, a Team Lead and an employee are refused", async () => {
    expect((await as("admin", "GET", "/equipment/permissions")).status).toBe(200);
    for (const who of ["cust", "lead", "plain"] as const)
      expect((await as(who, "GET", "/equipment/permissions")).status, who).toBe(403);
    expect((await save([{ user_id: A.plain.id, module_enabled: true }], "cust")).status).toBe(403);
  });

  it("is not swallowed by GET /equipment/:id", async () => {
    const r = await as("admin", "GET", "/equipment/permissions");
    expect(Array.isArray(r.body.inventories)).toBe(true);
    expect(Array.isArray(r.body.people)).toBe(true);
  });

  it("reports a custodian as the duty AND the assignment, and a holder without the duty as a viewer", async () => {
    await pool.query(`INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3)`,
      [A.plain.id, scopeA, A.admin.id]);
    const r = await as("admin", "GET", "/equipment/permissions");
    const inv = r.body.inventories.find((i: Body) => i.id === scopeA);
    const h = (uid: string) => inv.holders.find((x: Body) => x.user_id === uid);
    expect(h(A.cust.id).custodian).toBe(true);
    expect(h(A.plain.id).custodian).toBe(false);
    const p = r.body.people.find((x: Body) => x.id === A.cust.id);
    expect(p).toMatchObject({ equipment: true, kiosk: false, custodian: true, inventory_ids: [scopeA] });
    expect(r.body.people.find((x: Body) => x.id === A.admin.id).is_admin).toBe(true);
  });

  it("lists only the Media crew, and a removed member only while they still hold something", async () => {
    let ids = (await as("admin", "GET", "/equipment/permissions")).body.people.map((p: Body) => p.id);
    expect(ids).not.toContain(A.outsider.id);
    expect(ids).not.toContain(A.gone.id);
    await pool.query(`INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3)`,
      [A.gone.id, scopeB, A.admin.id]);
    ids = (await as("admin", "GET", "/equipment/permissions")).body.people.map((p: Body) => p.id);
    expect(ids).toContain(A.gone.id);
  });
});

maybe("Equipment → Permissions: saving", () => {
  beforeEach(reset);

  it("appointing a custodian of one inventory lets them edit its assets — and only its assets", async () => {
    /* Before: Equipment, but no inventory and no duty. */
    expect((await as("plain", "PATCH", `/equipment/${assetA}`, { notes: "zep" })).status).toBe(403);

    const r = await save([{ user_id: A.plain.id, module_enabled: true,
                            grant_inventory_ids: [scopeA], equipment_custodian: true }]);
    expect(r.status).toBe(200);
    expect(r.body.applied).toBe(1);

    expect((await as("plain", "PATCH", `/equipment/${assetA}`, { notes: "zep" })).status).toBe(200);
    expect((await as("plain", "GET", `/equipment/${assetB}`)).status).toBe(404);
    expect((await as("plain", "PATCH", `/equipment/${assetB}`, { notes: "zep" })).status).toBe(404);
  });

  it("an inventory without the duty can be seen but not edited", async () => {
    await save([{ user_id: A.plain.id, grant_inventory_ids: [scopeA] }]);
    expect((await as("plain", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("plain", "PATCH", `/equipment/${assetA}`, { notes: "zep" })).status).toBe(403);
  });

  it("revoking takes effect on the very next request and keeps the history", async () => {
    expect((await as("cust", "GET", `/equipment/${assetA}`)).status).toBe(200);
    const r = await save([{ user_id: A.cust.id, revoke_inventory_ids: [scopeA] }]);
    expect(r.status).toBe(200);
    expect((await as("cust", "GET", `/equipment/${assetA}`)).status).toBe(404);
    const rows = (await pool.query(
      `SELECT removed_at, removed_by FROM mo_user_inventory_scopes WHERE user_id=$1 AND scope_id=$2`,
      [A.cust.id, scopeA])).rows;
    expect(rows.length).toBe(1);
    expect(rows[0].removed_at).toBeTruthy();
    expect(rows[0].removed_by).toBe(A.admin.id);
  });

  it("removing the duty stops custodial acts while the inventory stays visible", async () => {
    await save([{ user_id: A.cust.id, equipment_custodian: false }]);
    expect(await holdsDuty(A.cust.id)).toBe(false);
    expect((await as("cust", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("cust", "PATCH", `/equipment/${assetA}`, { notes: "zep" })).status).toBe(403);
  });

  it("inventories travel as a delta, so a grant another Admin just made survives", async () => {
    /* `other` holds B, granted elsewhere after this Admin's popup loaded. */
    await pool.query(`INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3)`,
      [A.other.id, scopeB, A.admin2.id]);
    await save([{ user_id: A.other.id, grant_inventory_ids: [scopeA] }]);
    expect(await liveScopes(A.other.id)).toEqual([scopeA, scopeB].sort((x, y) => x - y));
  });

  it("is one transaction — one refusal leaves every person in the save untouched, and names who", async () => {
    const r = await save([
      { user_id: A.plain.id, grant_inventory_ids: [scopeA], equipment_custodian: true },
      { user_id: A.gone.id, grant_inventory_ids: [scopeB] },
    ]);
    expect(r.status).toBe(409);
    expect(r.body.message).toContain(`ZEP ${A.gone.id}`);
    expect(await liveScopes(A.plain.id)).toEqual([]);
    expect(await holdsDuty(A.plain.id)).toBe(false);
  });

  it("keeps the existing refusals: no self-grant, no grant to an inactive account, no archived inventory", async () => {
    expect((await save([{ user_id: A.admin.id, grant_inventory_ids: [scopeA] }])).status).toBe(403);
    expect((await save([{ user_id: A.gone.id, equipment_custodian: true }])).status).toBe(409);
    await pool.query(`UPDATE mo_inventory_scopes SET archived_at=NOW() WHERE id=$1`, [scopeB]);
    expect((await save([{ user_id: A.plain.id, grant_inventory_ids: [scopeB] }])).status).toBe(409);
    expect((await save([{ user_id: A.plain.id, grant_inventory_ids: [987654321] }])).status).toBe(404);
  });

  it("still lets an inactive account be offboarded", async () => {
    await pool.query(`INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3)`,
      [A.gone.id, scopeB, A.admin.id]);
    const r = await save([{ user_id: A.gone.id, revoke_inventory_ids: [scopeB] }]);
    expect(r.status).toBe(200);
    expect(await liveScopes(A.gone.id)).toEqual([]);
  });

  it("refuses people who are not on the Media crew, duplicates, and an empty save", async () => {
    expect((await save([{ user_id: A.outsider.id, module_enabled: true }])).status).toBe(404);
    expect((await save([{ user_id: A.plain.id, module_enabled: true },
                        { user_id: A.plain.id, kiosk_enabled: true }])).status).toBe(400);
    expect((await save([])).status).toBe(400);
  });

  it("grants and withdraws Kiosk access through the module list the shell reads", async () => {
    await save([{ user_id: A.plain.id, kiosk_enabled: true }]);
    expect(await modulesOf(A.plain.id)).toEqual(expect.arrayContaining(["equipment", "kiosk"]));
    await save([{ user_id: A.plain.id, kiosk_enabled: false, module_enabled: false }]);
    const mods = await modulesOf(A.plain.id) as string[];
    expect(mods).not.toContain("kiosk");
    expect(mods).not.toContain("equipment");
    expect(mods).toContain("home");
    /* And the gate agrees: no Equipment module, no equipment. */
    expect((await as("plain", "GET", "/equipment")).status).toBe(403);
  });

  it("writes one access-change event per person changed, none for a no-op, and shows it as history", async () => {
    await save([
      { user_id: A.plain.id, grant_inventory_ids: [scopeA], equipment_custodian: true },
      { user_id: A.other.id, module_enabled: true },      // already on — nothing changes
    ]);
    const rows = (await pool.query(
      `SELECT entity_uid, before, after FROM mo_audit_logs
        WHERE action='crew.equipment_access_changed' AND actor_id=$1`, [A.admin.id])).rows;
    expect(rows.map((r) => r.entity_uid)).toEqual([A.plain.id]);
    expect(rows[0].before).toMatchObject({ equipment_custodian: false, inventories: [] });
    expect(rows[0].after).toMatchObject({ equipment_custodian: true, inventories: [`${PX}-a`] });

    const h = (await as("admin", "GET", "/equipment/permissions")).body.history as Body[];
    expect(h.some((e) => e.action === "crew.equipment_access_changed" && e.entity_uid === A.plain.id)).toBe(true);
  });
});

maybe("Equipment → Permissions: the inventories themselves", () => {
  beforeEach(reset);
  beforeEach(async () => {
    await pool.query(`DELETE FROM mo_inventory_scopes WHERE code LIKE $1 AND id <> ALL($2::bigint[])`,
      [`${PX}%`, [scopeA, scopeB]]);
    await pool.query(`UPDATE mo_inventory_scopes SET code_prefix=NULL, name=$2 WHERE id=$1`, [scopeA, "ZEP Scope A"]);
    await pool.query(`UPDATE mo_equipment_items SET internal_code=NULL WHERE id=$1`, [assetA]);
  });

  it("creates an inventory, deriving its code from the name, and only for an Admin", async () => {
    expect((await as("cust", "POST", "/equipment/inventories", { name: "zep Nope" })).status).toBe(403);
    const r = await as("admin", "POST", "/equipment/inventories",
      { name: "zep 24 Frames", code_prefix: "zf", lends_to_students: true });
    expect(r.status).toBe(201);
    expect(r.body.inventory).toMatchObject({ code: "zep_24_frames", code_prefix: "ZF", lends_to_students: true });
    /* It appears in the picture straight away, ready to take a custodian. */
    const inv = (await as("admin", "GET", "/equipment/permissions")).body.inventories
      .find((i: Body) => i.id === r.body.inventory.id);
    expect(inv).toMatchObject({ state: "active", assets: 0, holders: [] });
    expect((await save([{ user_id: A.plain.id, grant_inventory_ids: [r.body.inventory.id] }])).status).toBe(200);
  });

  it("refuses a duplicate name, a malformed prefix and a prefix another inventory uses", async () => {
    expect((await as("admin", "POST", "/equipment/inventories", { name: "zep scope a" })).status).toBe(409);
    expect((await as("admin", "POST", "/equipment/inventories", { name: "zep X", code_prefix: "1A" })).status).toBe(400);
    await as("admin", "PATCH", `/equipment/inventories/${scopeA}`, { code_prefix: "ZQ" });
    const r = await as("admin", "POST", "/equipment/inventories", { name: "zep Y", code_prefix: "ZQ" });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("ZQ");
  });

  it("renames and opens an inventory to students, auditing before and after", async () => {
    const r = await as("admin", "PATCH", `/equipment/inventories/${scopeA}`,
      { name: "ZEP Scope A2", lends_to_students: true });
    expect(r.status).toBe(200);
    expect(r.body.inventory).toMatchObject({ name: "ZEP Scope A2", lends_to_students: true });
    const a = (await pool.query(
      `SELECT action, before, after FROM mo_audit_logs
        WHERE entity_type='inventory_scopes' AND entity_id=$1 AND actor_id=$2`, [scopeA, A.admin.id])).rows;
    expect(a[0]).toMatchObject({ action: "inventory_scope.updated",
      before: { name: "ZEP Scope A" }, after: { name: "ZEP Scope A2" } });
  });

  it("will not change a prefix once an asset code has been issued under it", async () => {
    expect((await as("admin", "PATCH", `/equipment/inventories/${scopeA}`, { code_prefix: "ZA" })).status).toBe(200);
    await pool.query(`UPDATE mo_equipment_items SET internal_code='ZA-0001' WHERE id=$1`, [assetA]);
    const r = await as("admin", "PATCH", `/equipment/inventories/${scopeA}`, { code_prefix: "ZB" });
    expect(r.status).toBe(409);
    expect(r.body.message).toContain("ZA-0001");
    /* Saving the SAME prefix is not a change and is not refused. */
    expect((await as("admin", "PATCH", `/equipment/inventories/${scopeA}`, { code_prefix: "za" })).status).toBe(200);
  });

  it("archiving withdraws the custodian's access to its assets, and restoring gives it back", async () => {
    expect((await as("cust", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("admin", "PATCH", `/equipment/inventories/${scopeA}`, { archived: true })).status).toBe(200);
    expect((await as("cust", "GET", `/equipment/${assetA}`)).status).toBe(404);
    expect((await as("admin", "PATCH", `/equipment/inventories/${scopeA}`, { archived: false })).status).toBe(200);
    expect((await as("cust", "GET", `/equipment/${assetA}`)).status).toBe(200);
    const actions = (await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='inventory_scopes' AND entity_id=$1
          AND actor_id=$2 ORDER BY id`, [scopeA, A.admin.id])).rows.map((r) => r.action);
    expect(actions).toEqual(["inventory_scope.archived", "inventory_scope.restored"]);
  });
});
