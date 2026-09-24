// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Inventory Scope AUTHORIZATION (Phase 13B).

   Phase 13A created the scope object and was explicit that it enforced
   nothing. This file is the proof that it now does.

   The property under test is not "the list looks right". It is that an asset
   belonging to a scope the caller has no authority over is UNREACHABLE — by
   its id, by its asset tag, by its QR token, by a booking id, by a
   transaction, by a filter, or through the Projects surface. Every one of
   those is a separate way to name an asset, and each is tried below.

   The answer to all of them is 404, never 403, and always with the SAME
   message the endpoint gives for an id that does not exist. A 403 would
   confirm the asset is real, which is exactly what the probe wanted to learn.

   THE OTHER HALF, which matters as much: this phase must not have taken
   anything away. The unscoped estate — every asset that predates scope — is
   still reachable by everyone who could reach it before, and the Media Ops
   admin still sees all of it. Those assertions are here too, because a
   security change that quietly breaks the product is not a success.

   Every fixture is prefixed `zia` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zia";
let dbUp = false;
/* PHASE 17F — a checkout needs a due date the SERVER will accept: in the
   future and inside the 30-day policy window. Captured from the database, not
   written as a literal, because a literal stops being in the future. */
let DUE = "";
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0;
let scopeA = 0, scopeB = 0;
let assetA = 0, assetB = 0, assetU = 0;      // in A, in B, and unscoped
let tagA = "", tagB = "", tagU = "";
let qrB = "";

/* custA and custB are equipment custodians — the existing duty, unchanged —
   each authorised over ONE scope. `plain` holds the Equipment module and no
   scope at all, which is every user in the database today. `outsider` is not
   media crew. `admin` is the Media Ops master admin. */
const A = {
  admin:    { id: `${PX}-admin`, role: "admin", team: "media" },
  custA:    { id: `${PX}-custa`, role: "user",  team: "media" },
  custB:    { id: `${PX}-custb`, role: "user",  team: "media" },
  plain:    { id: `${PX}-plain`, role: "user",  team: "media" },
  outsider: { id: `${PX}-out`,   role: "user",  team: "branding" },
} as const;
type ActorName = keyof typeof A;

{
  const t = await connectTestDatabase();
  pool = t.pool;
  dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

/* The day the SERVER is having. Every date rule in this module compares against
   (NOW() AT TIME ZONE 'Asia/Kolkata')::date, and between 18:30 and 24:00 UTC
   that is not the UTC day — the off-by-one the equipment suite documents. */
const IST_OFFSET_MS = 5.5 * 3_600_000;
const istDay = (n = 0) =>
  new Date(Date.now() + n * 86_400_000 + IST_OFFSET_MS).toISOString().slice(0, 10);

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZIA ${a.id}` }
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

/** The asset ids a list endpoint returned. Every equipment list calls them
    `items`; the id may be the item's own or the row's foreign key to it. */
const idsOf = (b: Record<string, never>, key = "items") =>
  ((b?.[key] ?? []) as unknown as {
      id?: number; asset_id?: number; equipment_item_id?: number; asset?: { id: number } }[])
    .map((r) => Number(r.equipment_item_id ?? r.asset_id ?? r.asset?.id ?? r.id));

async function grantScope(userId: string, scopeId: number) {
  await pool.query(
    `INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, scopeId, A.admin.id]);
}

async function cleanup() {
  const ids = (await pool.query(
    `SELECT id FROM mo_equipment_items
      WHERE asset_tag LIKE $1
         OR category_id IN (SELECT id FROM mo_equipment_categories WHERE name LIKE $2)`,
    [`EQ-${PX.toUpperCase()}-%`, `${PX} %`])).rows.map((r) => Number(r.id));
  if (ids.length) {
    await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_maintenance_records WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(`DELETE FROM mo_equipment_bookings WHERE shoot_id IN
                      (SELECT id FROM mo_shoots WHERE title LIKE $1)`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_shoots WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_projects WHERE code LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_equipment_categories WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_inventory_scopes WHERE code LIKE $1 OR created_by LIKE $2`,
    [`${PX}-%`, `${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
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
      [a.id, `ZIA ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);

  for (const a of [A.admin, A.custA, A.custB, A.plain])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZIA','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules`,
      [a.id, JSON.stringify(["home", "my-day", "equipment"])]);

  /* The custodian duty is the EXISTING domain capability and is granted to
     both custodians equally. It is deliberately not what separates them —
     scope is. If the duty alone decided access, both would reach everything. */
  const duty = (await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0];
  if (duty)
    for (const a of [A.custA, A.custB])
      await pool.query(
        `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at)
         VALUES ($1,$2,CURRENT_DATE) ON CONFLICT DO NOTHING`, [a.id, duty.id]);

  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',9999) RETURNING id`, [`${PX} Camera`])).rows[0].id);

  scopeA = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [`ZIA Scope A`, `${PX}-a`, A.admin.id])).rows[0].id);
  scopeB = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
    [`ZIA Scope B`, `${PX}-b`, A.admin.id])).rows[0].id);

  await grantScope(A.custA.id, scopeA);
  await grantScope(A.custB.id, scopeB);

  const mk = async (n: string, scope: number | null) => {
    const tag = `EQ-${PX.toUpperCase()}-${n}`;
    const id = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, status)
       VALUES ($1,$2,'ZIA',$3,$4,'available') RETURNING id`,
      [categoryId, tag, `Model ${n}`, scope])).rows[0].id);
    return { id, tag };
  };
  ({ id: assetA, tag: tagA } = await mk("001", scopeA));
  ({ id: assetB, tag: tagB } = await mk("002", scopeB));
  ({ id: assetU, tag: tagU } = await mk("003", null));
  qrB = `${PX}-qr-b-token`;

  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* Three assets, RESET per test rather than rebuilt: one in scope A, one in
   scope B, one that predates scope.

   The rows themselves are created once, in beforeAll. An earlier version
   dropped and recreated them on every test, which churned mo_equipment_items
   thirty-five times per run — and bootstrapAssetFoundation() backfills
   mo_asset_identifiers with an INSERT … SELECT over that table, so a sibling
   suite bootstrapping while this one deleted could fail its foreign key: the
   SELECT reads a row under its snapshot, the DELETE commits, and the FK check
   then finds nothing to point at. The race is not this suite's to fix, but
   making it likelier was, so the churn is gone and only the per-test STATE is
   reset. Isolation is identical; the row ids simply survive. */
beforeEach(async () => {
  if (!dbUp) return;
  const mine = [assetA, assetB, assetU];
  await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id = ANY($1::bigint[])`, [mine]);
  await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [mine]);
  await pool.query(`DELETE FROM mo_maintenance_records WHERE equipment_item_id = ANY($1::bigint[])`, [mine]);
  await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [mine]);
  /* Back to the starting position: the scope each asset belongs to, its status
     and the one field the edit tests overwrite. */
  await pool.query(`UPDATE mo_equipment_items SET scope_id=$2, status='available', model='Model 001',
                      retired_at=NULL, retired_reason=NULL WHERE id=$1`, [assetA, scopeA]);
  await pool.query(`UPDATE mo_equipment_items SET scope_id=$2, status='available', model='Model 002',
                      retired_at=NULL, retired_reason=NULL WHERE id=$1`, [assetB, scopeB]);
  await pool.query(`UPDATE mo_equipment_items SET scope_id=NULL, status='available', model='Model 003',
                      retired_at=NULL, retired_reason=NULL WHERE id=$1`, [assetU]);

  await pool.query(`UPDATE mo_inventory_scopes SET is_active=true, archived_at=NULL WHERE id = ANY($1::bigint[])`,
    [[scopeA, scopeB]]);
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await grantScope(A.custA.id, scopeA);
  await grantScope(A.custB.id, scopeB);

  /* is_primary is FALSE, deliberately. Bootstrap mints a primary QR token for
     any asset that lacks one, so a test fixture that claims to be the primary
     is racing it for uq_mo_asset_ident_primary (asset_id, kind) — and
     ON CONFLICT (value) does not cover that constraint, so the loser throws
     rather than skipping. Nothing here needs primary: resolve matches on
     VALUE, which is what a scanned label carries. */
  await pool.query(
    `INSERT INTO mo_asset_identifiers (asset_id, kind, value, is_primary, created_by)
     VALUES ($1,'qr',$2,false,$3) ON CONFLICT DO NOTHING`, [assetB, qrB, A.admin.id]);
});

/* ─────────────────────────────────────────────────────────────────────────
   1 & 6 — reading across a scope boundary, and the caller who has none.
   ───────────────────────────────────────────────────────────────────────── */
maybe("a scoped custodian reads only their own scope", () => {
  it("lists their own assets and the unscoped estate, and not the other scope", async () => {
    const r = await as("custA", "GET", "/equipment?q=ZIA&limit=200");
    expect(r.status).toBe(200);
    const ids = idsOf(r.body);
    expect(ids).toContain(assetA);
    expect(ids).toContain(assetU);          // the legacy estate is not taken away
    expect(ids).not.toContain(assetB);
  });

  it("gives the mirror answer to the other custodian", async () => {
    const ids = idsOf((await as("custB", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(ids).toContain(assetB);
    expect(ids).toContain(assetU);
    expect(ids).not.toContain(assetA);
  });

  it("counts only what it may see, so the header cannot be used to probe", async () => {
    /* The summary is computed by the database over the same filters. If the
       scope clause did not reach it, the total would betray the existence of
       an asset the list itself refused to show. */
    const r = await as("custA", "GET", "/equipment?q=ZIA&limit=200&summary=1");
    const shown = idsOf(r.body).length;
    expect(Number((r.body.summary as unknown as { total: number }).total)).toBe(shown);
    expect(Number(r.body.total)).toBe(shown);
  });

  it("fails closed for a crew member with no scope at all", async () => {
    /* Every user in the database is in this state today: module access, no
       scope. They keep the unscoped estate and get no scoped asset. */
    const ids = idsOf((await as("plain", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(ids).toContain(assetU);
    expect(ids).not.toContain(assetA);
    expect(ids).not.toContain(assetB);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   3 — every other way of naming an asset.
   ───────────────────────────────────────────────────────────────────────── */
maybe("a scope cannot be stepped around", () => {
  it("by asset id", async () => {
    const r = await as("custA", "GET", `/equipment/${assetB}`);
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Asset not found.");
  });

  it("by asset tag", async () => {
    expect((await as("custA", "GET", `/equipment/${tagB}`)).status).toBe(404);
  });

  it("by an id that does not exist — the SAME answer, which is the point", async () => {
    const real = await as("custA", "GET", `/equipment/${assetB}`);
    const fake = await as("custA", "GET", `/equipment/2147483000`);
    expect(real.status).toBe(fake.status);
    expect(String(real.body.message)).toBe(String(fake.body.message));
  });

  it("by QR token, through resolve", async () => {
    const mine = await as("custB", "GET", `/equipment/resolve/${qrB}`);
    expect(mine.status).toBe(200);                       // it really does resolve
    const theirs = await as("custA", "GET", `/equipment/resolve/${qrB}`);
    expect(theirs.status).toBe(404);
    expect(String(theirs.body.message)).toBe("No asset carries that identifier.");
  });

  it("by QR token whose identifier is retired — no 410 tell", async () => {
    /* A 410 would say "that label exists but was replaced", which confirms the
       asset. The scope check runs first precisely so it cannot. */
    await pool.query(`UPDATE mo_asset_identifiers SET retired_at=NOW(), is_active=false WHERE value=$1`, [qrB]);
    // beforeEach deletes and re-creates it, so the mutation cannot leak forward.
    const theirs = await as("custA", "GET", `/equipment/resolve/${qrB}`);
    expect(theirs.status).toBe(404);
    const owner = await as("custB", "GET", `/equipment/resolve/${qrB}`);
    expect(owner.status).toBe(410);                      // the owner still learns the truth
  });

  it("by the QR image endpoint", async () => {
    expect((await as("custA", "GET", `/equipment/${assetB}/qr`)).status).toBe(404);
  });

  it("by a query filter", async () => {
    /* A filter narrows; it cannot widen. Asking for exactly the other scope's
       asset returns nothing rather than everything. */
    const r = await as("custA", "GET", `/equipment?q=${encodeURIComponent(tagB)}`);
    expect(r.status).toBe(200);
    expect(idsOf(r.body)).toEqual([]);
  });

  it("by a transaction row", async () => {
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, occurred_at, recorded_by)
       VALUES ($1,'check_out',$2,NOW(),$2)`, [assetB, A.custB.id]);
    const ids = idsOf((await as("custA", "GET", "/equipment/transactions?limit=200")).body);
    expect(ids).not.toContain(assetB);
    const own = idsOf((await as("custB", "GET", "/equipment/transactions?limit=200")).body);
    expect(own).toContain(assetB);
  });

  it("by a booking row, and by the booking's own id", async () => {
    const bk = Number((await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, starts_at, ends_at, status, created_by)
       VALUES ($1,$2,CURRENT_DATE,CURRENT_DATE,'reserved',$2) RETURNING id`,
      [assetB, A.custB.id])).rows[0].id);

    const ids = idsOf((await as("custA", "GET", "/equipment/bookings?limit=200")).body);
    expect(ids).not.toContain(assetB);

    const cancel = await as("custA", "POST", `/equipment/bookings/${bk}/cancel`);
    expect(cancel.status).toBe(404);
    expect(String(cancel.body.message)).toBe("Booking not found.");
    expect((await pool.query(
      `SELECT status FROM mo_equipment_bookings WHERE id=$1`, [bk])).rows[0].status).toBe("reserved");
  });

  it("by availability", async () => {
    /* Checked first, on an untouched asset: availability lists what is free to
       book, so a checked-out fixture would empty it for everyone and the
       negative assertion would pass for the wrong reason. */
    /* from/to are required: the endpoint answers "is this free in THIS window",
       and canBook() refuses a request without one. */
    /* q=ZIA, like every other list assertion in this file. Availability is the
       widest list in the system — every asset free in the window, across every
       suite running beside this one — and at limit=200 the page filled up and
       this suite's own asset fell off the end of it, failing the POSITIVE
       control while the security assertion it guards was never in doubt. A
       bigger limit would only move the cliff. TEST_STABILITY entry 17. */
    const path = `/equipment/availability?q=ZIA&limit=200&from=${istDay(1)}&to=${istDay(2)}`;
    const owner = idsOf((await as("custB", "GET", path)).body);
    const theirs = idsOf((await as("custA", "GET", path)).body);
    expect(owner, "owner should see their own available asset").toContain(assetB);
    expect(theirs, "other scope must not see it").not.toContain(assetB);
  });

  it("by custody and maintenance", async () => {
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, occurred_at, recorded_by)
       VALUES ($1,'check_out',$2,NOW(),$2)`, [assetB, A.custB.id]);
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [assetB]);
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, reported_by, started_at)
       VALUES ($1,'repair','ZIA damage',$2,CURRENT_DATE)`, [assetB, A.custB.id]);

    for (const path of ["/equipment/custody?limit=200",
                        "/equipment/maintenance?limit=200"]) {
      const theirs = idsOf((await as("custA", "GET", path)).body);
      const owner  = idsOf((await as("custB", "GET", path)).body);
      // The positive control matters: without it an empty list — a wrong key,
      // a filter that excluded everything — would pass as if it were security.
      expect(owner, `owner should see the asset on ${path}`).toContain(assetB);
      expect(theirs, `other scope must not see the asset on ${path}`).not.toContain(assetB);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   2 — writing across a scope boundary.
   ───────────────────────────────────────────────────────────────────────── */
maybe("a scoped custodian cannot mutate another scope", () => {
  const unchanged = async (id: number) =>
    (await pool.query(`SELECT status, model, retired_at FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];

  it("cannot check out", async () => {
    const before = await unchanged(assetB);
    const r = await as("custA", "POST", `/equipment/${assetB}/checkout`, { user_id: A.custA.id, expected_return_at: DUE });
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Item not found.");
    expect(await unchanged(assetB)).toEqual(before);
  });

  it("cannot check in", async () => {
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [assetB]);
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, occurred_at, recorded_by)
       VALUES ($1,'check_out',$2,NOW(),$2)`, [assetB, A.custB.id]);
    expect((await as("custA", "POST", `/equipment/${assetB}/checkin`, {})).status).toBe(404);
    expect((await unchanged(assetB)).status).toBe("checked_out");
  });

  it("cannot report damage", async () => {
    expect((await as("custA", "POST", `/equipment/${assetB}/damage`,
      { description: "ZIA forced" })).status).toBe(404);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records WHERE equipment_item_id=$1`, [assetB])).rows[0].c)).toBe(0);
  });

  it("cannot edit, restatus or retire", async () => {
    expect((await as("custA", "PATCH", `/equipment/${assetB}`, { model: "ZIA hijack" })).status).toBe(404);
    expect((await as("custA", "POST", `/equipment/${assetB}/status`, { status: "maintenance" })).status).toBe(404);
    expect((await as("custA", "POST", `/equipment/${assetB}/retire`, { reason: "ZIA" })).status).toBe(404);
    const row = await unchanged(assetB);
    expect(row.model).toBe("Model 002");
    expect(row.status).toBe("available");
    expect(row.retired_at).toBeNull();
  });

  it("cannot attach an identifier — which would make the asset resolvable", async () => {
    expect((await as("custA", "POST", `/equipment/${assetB}/identifiers`,
      { kind: "barcode", value: `${PX}-stolen-barcode` })).status).toBe(404);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_asset_identifiers WHERE value=$1`, [`${PX}-stolen-barcode`])).rows[0].c)).toBe(0);
  });

  it("cannot book", async () => {
    const r = await as("custA", "POST", "/equipment/bookings", {
      equipment_item_id: assetB, starts_at: "2030-01-01", ends_at: "2030-01-02" });
    expect(r.status).toBe(404);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings WHERE equipment_item_id=$1`, [assetB])).rows[0].c)).toBe(0);
  });

  it("cannot move an asset into its own scope", async () => {
    /* scope_id is not in ASSET_EDITABLE, so the field is dropped rather than
       written. If it were ever added there, this test fails — which is the
       point, because self-service rescoping would defeat the whole model. */
    await as("custA", "PATCH", `/equipment/${assetU}`, { scope_id: scopeA });
    expect((await pool.query(
      `SELECT scope_id FROM mo_equipment_items WHERE id=$1`, [assetU])).rows[0].scope_id).toBeNull();
  });

  it("cannot book another scope's asset through the Projects surface", async () => {
    const pid = Number((await pool.query(
      `INSERT INTO mo_projects (project_type_id, code, name, created_by)
       VALUES ((SELECT id FROM mo_project_types ORDER BY id LIMIT 1), $1, $2, $3) RETURNING id`,
      [`${PX}-proj`, `ZIA Project`, A.admin.id])).rows[0].id);
    const wt = (await pool.query(
      `SELECT id FROM mo_work_types WHERE form_template='shoot' LIMIT 1`)).rows[0];
    if (wt) {
      await as("custA", "POST", `/projects/${pid}/work`, {
        work_type_id: wt.id, title: `${PX} Shoot`, shoot_date: "2030-02-01", equipment: [assetB] });
      expect(Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_equipment_bookings WHERE equipment_item_id=$1`, [assetB])).rows[0].c)).toBe(0);
    }
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   4 & 5 — the admin keeps everything; the stranger gets nothing.
   ───────────────────────────────────────────────────────────────────────── */
maybe("the ends of the range are unchanged", () => {
  it("the Media Ops admin still sees the whole estate", async () => {
    const ids = idsOf((await as("admin", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(ids).toContain(assetA);
    expect(ids).toContain(assetB);
    expect(ids).toContain(assetU);
  });

  it("the admin still reaches every asset individually, and may act on it", async () => {
    expect((await as("admin", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("admin", "GET", `/equipment/${assetB}`)).status).toBe(200);
    expect((await as("admin", "PATCH", `/equipment/${assetB}`, { model: "ZIA admin edit" })).status).toBe(200);
  });

  it("the admin's authority comes from the existing role, not a scope row", async () => {
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.admin.id])).rows[0].c)).toBe(0);
  });

  it("an unauthenticated caller is still refused outright", async () => {
    expect((await as("anon", "GET", "/equipment")).status).toBe(403);
    expect((await as("anon", "GET", `/equipment/${assetU}`)).status).toBe(403);
  });

  it("someone who is not media crew is still refused outright", async () => {
    expect((await as("outsider", "GET", "/equipment")).status).toBe(403);
  });

  it("scope does not replace the module gate", async () => {
    /* Granting a scope to someone without the Equipment module must not let
       them in: the layers are ANDed, not ORed. */
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZIA','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules`,
      [A.plain.id, JSON.stringify(["home", "my-day"])]);
    await grantScope(A.plain.id, scopeA);
    expect((await as("plain", "GET", "/equipment")).status).toBe(403);
    // restore for the other tests
    await pool.query(
      `UPDATE mo_user_profiles SET allowed_modules=$2::jsonb WHERE user_id=$1`,
      [A.plain.id, JSON.stringify(["home", "my-day", "equipment"])]);
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.plain.id]);
  });

  it("scope does not replace the custodian duty", async () => {
    /* custA is scoped to A and holds the duty. A user scoped to A WITHOUT the
       duty may look, but must not act — the domain capability is a separate
       axis and scope does not confer it. */
    await grantScope(A.plain.id, scopeA);
    expect((await as("plain", "GET", `/equipment/${assetA}`)).status).toBe(200);
    const r = await as("plain", "PATCH", `/equipment/${assetA}`, { model: "ZIA no duty" });
    expect(r.status).toBe(403);
    expect((await pool.query(
      `SELECT model FROM mo_equipment_items WHERE id=$1`, [assetA])).rows[0].model).toBe("Model 001");
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.plain.id]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   7 — revocation, and the lifecycle of the scope itself.
   ───────────────────────────────────────────────────────────────────────── */
maybe("authority ends the moment it is withdrawn", () => {
  it("removing the assignment removes access on the very next request", async () => {
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(200);
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1 AND scope_id=$2`,
      [A.custA.id, scopeA]);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(404);
    expect(idsOf((await as("custA", "GET", "/equipment?q=ZIA&limit=200")).body)).not.toContain(assetA);
  });

  it("deactivating the scope withdraws it too", async () => {
    await pool.query(`UPDATE mo_inventory_scopes SET is_active=false WHERE id=$1`, [scopeA]);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(404);
    await pool.query(`UPDATE mo_inventory_scopes SET is_active=true WHERE id=$1`, [scopeA]);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(200);
  });

  it("archiving the scope withdraws it too", async () => {
    await pool.query(`UPDATE mo_inventory_scopes SET archived_at=NOW() WHERE id=$1`, [scopeA]);
    expect((await as("custA", "GET", `/equipment/${assetA}`)).status).toBe(404);
    await pool.query(`UPDATE mo_inventory_scopes SET archived_at=NULL WHERE id=$1`, [scopeA]);
  });

  it("holding two scopes reaches both", async () => {
    await grantScope(A.custA.id, scopeB);
    const ids = idsOf((await as("custA", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(ids).toContain(assetA);
    expect(ids).toContain(assetB);
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1 AND scope_id=$2`,
      [A.custA.id, scopeB]);
  });

  it("scoping an asset is what brings it under control", async () => {
    /* assetU is reachable by everyone while it is unscoped. Give it a scope
       and it leaves the estate for everyone but that scope's custodian —
       which is the migration path, one asset at a time. */
    expect((await as("custB", "GET", `/equipment/${assetU}`)).status).toBe(200);
    await pool.query(`UPDATE mo_equipment_items SET scope_id=$1 WHERE id=$2`, [scopeA, assetU]);
    expect((await as("custB", "GET", `/equipment/${assetU}`)).status).toBe(404);
    expect((await as("custA", "GET", `/equipment/${assetU}`)).status).toBe(200);
    expect((await as("admin", "GET", `/equipment/${assetU}`)).status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE ADMIN SURFACE THAT GRANTS ALL OF THIS.

   Everything above proves scope is enforced. This proves it can be ADMINISTERED
   from the person's side — module access, inventories and the custodian duty,
   read and written together — without a new role, a new table or a second
   notion of what any of the three means.

   `plain` is the subject throughout: media crew, the Equipment module, no
   inventory and no duty, which is every user in the database today. Its state
   is reset before each test, because these tests move it.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("one person's equipment access, administered from Users & Roles", () => {
  const EA = `/crew/${A.plain.id}/equipment-access`;
  const get = (actor: ActorName | "anon") => as(actor, "GET", EA);
  const patch = (actor: ActorName | "anon", body: unknown) => as(actor, "PATCH", EA, body);

  /** The subject's live inventories, straight from the table. */
  const liveScopes = async () => (await pool.query(
    `SELECT scope_id FROM mo_user_inventory_scopes
      WHERE user_id=$1 AND removed_at IS NULL ORDER BY scope_id`, [A.plain.id]))
    .rows.map((r) => Number(r.scope_id));
  const dutyId = async () => Number((await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0].id);
  const hasDuty = async () => (await pool.query(
    `SELECT 1 FROM mo_user_duties WHERE user_id=$1 AND duty_flag_id=$2`,
    [A.plain.id, await dutyId()])).rows.length > 0;

  beforeEach(async () => {
    if (!dbUp) return;
    /* Hard reset, including the history rows the soft-removal tests create, so
       one test's revocation cannot be mistaken for another's. */
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.plain.id]);
    await pool.query(`DELETE FROM mo_user_duties WHERE user_id=$1`, [A.plain.id]);
    await pool.query(
      `UPDATE mo_user_profiles SET allowed_modules=$2::jsonb WHERE user_id=$1`,
      [A.plain.id, JSON.stringify(["home", "my-day", "equipment"])]);
    await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [A.plain.id]);
    await pool.query(`DELETE FROM mo_audit_logs WHERE entity_uid=$1`, [A.plain.id]);
  });

  afterAll(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.plain.id]);
    await pool.query(`DELETE FROM mo_user_duties WHERE user_id=$1`, [A.plain.id]);
    await pool.query(
      `UPDATE mo_user_profiles SET allowed_modules=$2::jsonb WHERE user_id=$1`,
      [A.plain.id, JSON.stringify(["home", "my-day", "equipment"])]);
  });

  /* ── Reading ──────────────────────────────────────────────────────────── */

  it("reads the three layers in one request, with the inventories from the database", async () => {
    const r = await get("admin");
    expect(r.status).toBe(200);
    expect(r.body.user as unknown as { id: string }).toMatchObject({ id: A.plain.id });
    expect((r.body.module as unknown as { enabled: boolean }).enabled).toBe(true);
    /* Every live inventory, each flagged — so a third one appears the day it is
       created with no change to any client. */
    const inv = r.body.inventories as unknown as { id: number; code: string; assigned: boolean }[];
    expect(inv.map((i) => i.id)).toEqual(expect.arrayContaining([scopeA, scopeB]));
    expect(inv.every((i) => i.assigned === false)).toBe(true);
    /* The duty is looked up by code, never by a hard-coded id. */
    expect((r.body.custodian as unknown as { code: string }).code).toBe("equipment_custodian");
  });

  it("is refused to everyone but an Admin, for reading as well as writing", async () => {
    for (const who of ["custA", "plain", "outsider", "anon"] as (ActorName | "anon")[]) {
      expect((await get(who)).status, `${who} read it`).toBe(403);
      expect((await patch(who, { equipment_custodian: true })).status, `${who} wrote it`).toBe(403);
    }
    /* And the forged write really changed nothing. */
    expect(await hasDuty()).toBe(false);
  });

  /* ── Assigning ────────────────────────────────────────────────────────── */

  it("assigns one inventory", async () => {
    const r = await patch("admin", { inventory_scope_ids: [scopeA] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await liveScopes()).toEqual([scopeA]);
  });

  it("assigns the other one", async () => {
    expect((await patch("admin", { inventory_scope_ids: [scopeB] })).status).toBe(200);
    expect(await liveScopes()).toEqual([scopeB]);
  });

  it("assigns both at once", async () => {
    expect((await patch("admin", { inventory_scope_ids: [scopeA, scopeB] })).status).toBe(200);
    expect(await liveScopes()).toEqual([scopeA, scopeB].sort((a, b) => a - b));
  });

  it("removes one and keeps the other", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA, scopeB] });
    expect((await patch("admin", { inventory_scope_ids: [scopeB] })).status).toBe(200);
    expect(await liveScopes()).toEqual([scopeB]);
  });

  it("grants and then revokes the custodian duty", async () => {
    expect((await patch("admin", { equipment_custodian: true })).status).toBe(200);
    expect(await hasDuty()).toBe(true);
    expect((await patch("admin", { equipment_custodian: false })).status).toBe(200);
    expect(await hasDuty()).toBe(false);
  });

  it("creates no new role anywhere — the duty and the assignment are the existing ones", async () => {
    await patch("admin", { inventory_scope_ids: [scopeB], equipment_custodian: true });
    /* The assignment's role column has one legal value and this must still be it. */
    const rows = (await pool.query(
      `SELECT role FROM mo_user_inventory_scopes WHERE user_id=$1 AND removed_at IS NULL`,
      [A.plain.id])).rows;
    expect(rows.map((r) => r.role)).toEqual(["custodian"]);
    /* No duty flag was invented to carry this. */
    const duties = (await pool.query(
      `SELECT f.code FROM mo_user_duties d JOIN mo_duty_flags f ON f.id=d.duty_flag_id
        WHERE d.user_id=$1`, [A.plain.id])).rows.map((r) => r.code);
    expect(duties).toEqual(["equipment_custodian"]);
    expect((await pool.query(
      `SELECT 1 FROM mo_duty_flags WHERE code IN
        ('pid_custodian','media_custodian','equipment_manager','inventory_manager')`)).rows)
      .toEqual([]);
    /* And the platform role is untouched. */
    expect((await pool.query(`SELECT role FROM users WHERE id=$1`, [A.plain.id])).rows[0].role)
      .toBe("user");
  });

  /* ── The three layers stay three layers ───────────────────────────────── */

  it("keeps module access separate from inventory scope", async () => {
    /* An inventory without the module reaches nothing: the gate is the module. */
    await patch("admin", { inventory_scope_ids: [scopeA], module_enabled: false });
    expect(await liveScopes(), "the assignment was not recorded").toEqual([scopeA]);
    /* `q=ZIA&limit=200` like every other read in this file, and for the reason
       TEST_STABILITY entry 21 gives: an unfiltered catalog read is a page of the
       WHOLE estate, and the sibling suites fill fifty rows of it between one run
       and the next. The first version of these four tests asked for `limit=50`
       and failed on a busy run because this suite's own asset was on page two —
       which the assertion could only read as a scope failure. */
    const shut = await as("plain", "GET", "/equipment?q=ZIA&limit=200");
    expect(shut.status, "the module gate let them in anyway").toBe(403);
    /* And the module without an inventory reaches only the unscoped estate. */
    await patch("admin", { module_enabled: true, inventory_scope_ids: [] });
    const open = await as("plain", "GET", "/equipment?q=ZIA&limit=200");
    expect(open.status).toBe(200);
    expect(idsOf(open.body)).toContain(assetU);
    expect(idsOf(open.body)).not.toContain(assetA);
  });

  it("does not make an inventory holder a custodian", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA] });
    expect(await hasDuty(), "the assignment granted the duty by itself").toBe(false);
    /* Scope without the duty is a scoped VIEWER: they can read the asset and
       cannot act on it. That is the existing rule and it still holds. */
    expect((await as("plain", "GET", `/equipment/${assetA}`)).status).toBe(200);
    expect((await as("plain", "PATCH", `/equipment/${assetA}`, { model: "nope" })).status).toBe(403);
  });

  it("does not make a custodian reach every inventory", async () => {
    await patch("admin", { equipment_custodian: true, inventory_scope_ids: [] });
    /* The duty alone is not jurisdiction: with no inventory they see only the
       estate that belongs to nobody. */
    const seen = idsOf((await as("plain", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(seen).toContain(assetU);
    expect(seen).not.toContain(assetA);
    expect(seen).not.toContain(assetB);
  });

  /* ── What the assignment actually buys, end to end ────────────────────── */

  it("gives one inventory and not the other", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA] });
    const seen = idsOf((await as("plain", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(seen).toContain(assetA);
    expect(seen, "scope A leaked scope B").not.toContain(assetB);
    /* And the other way round, on the same subject. */
    await patch("admin", { inventory_scope_ids: [scopeB] });
    const seen2 = idsOf((await as("plain", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(seen2).toContain(assetB);
    expect(seen2, "scope B leaked scope A").not.toContain(assetA);
  });

  it("gives both when both are assigned", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA, scopeB] });
    const seen = idsOf((await as("plain", "GET", "/equipment?q=ZIA&limit=200")).body);
    expect(seen).toContain(assetA);
    expect(seen).toContain(assetB);
  });

  it("keeps the cross-scope refusal a 404, not a 403", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA] });
    const r = await as("plain", "GET", `/equipment/${assetB}`);
    expect(r.status, "the convention changed").toBe(404);
    expect(String(r.body.message)).toBe("Asset not found.");
  });

  /* ── Refusals ─────────────────────────────────────────────────────────── */

  it("refuses to grant an inventory to the Admin doing the granting", async () => {
    /* The existing separation: an Admin who needs an inventory has another
       Admin grant it. This panel must not become the way around it. */
    const r = await as("admin", "PATCH", `/crew/${A.admin.id}/equipment-access`,
      { inventory_scope_ids: [scopeA] });
    expect(r.status).toBe(403);
    expect((await pool.query(
      `SELECT 1 FROM mo_user_inventory_scopes WHERE user_id=$1 AND removed_at IS NULL`,
      [A.admin.id])).rows).toEqual([]);
  });

  it("refuses an archived inventory, and an inventory that does not exist", async () => {
    const dead = Number((await pool.query(
      `INSERT INTO mo_inventory_scopes (name, code, created_by, archived_at)
       VALUES ($1,$2,$3,NOW()) RETURNING id`,
      ["ZIA Archived", `${PX}-dead`, A.admin.id])).rows[0].id);
    expect((await patch("admin", { inventory_scope_ids: [dead] })).status).toBe(409);
    expect((await patch("admin", { inventory_scope_ids: [999999] })).status).toBe(404);
    expect(await liveScopes(), "a refused request still wrote something").toEqual([]);
  });

  it("refuses to grant access to an account that is not active", async () => {
    await pool.query(`UPDATE users SET status='archived' WHERE id=$1`, [A.plain.id]);
    expect((await patch("admin", { inventory_scope_ids: [scopeA] })).status).toBe(409);
    /* Revoking from a removed account is offboarding and stays allowed. */
    await pool.query(`UPDATE users SET status='active' WHERE id=$1`, [A.plain.id]);
    await patch("admin", { inventory_scope_ids: [scopeA] });
    await pool.query(`UPDATE users SET status='archived' WHERE id=$1`, [A.plain.id]);
    expect((await patch("admin", { inventory_scope_ids: [] })).status).toBe(200);
    expect(await liveScopes()).toEqual([]);
  });

  it("refuses a request that asks for nothing", async () => {
    expect((await patch("admin", {})).status).toBe(400);
  });

  it("does not exist for a member who does not exist", async () => {
    expect((await as("admin", "GET", "/crew/zia-nobody/equipment-access")).status).toBe(404);
  });

  /* ── All three, or none (§7) ──────────────────────────────────────────── */

  it("commits the three layers together", async () => {
    const r = await patch("admin",
      { module_enabled: true, inventory_scope_ids: [scopeB], equipment_custodian: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await liveScopes()).toEqual([scopeB]);
    expect(await hasDuty()).toBe(true);
    const mods = (await pool.query(
      `SELECT allowed_modules m FROM mo_user_profiles WHERE user_id=$1`, [A.plain.id])).rows[0].m;
    expect(mods).toContain("equipment");
    /* The reply is the state that committed, so the screen renders the server. */
    expect((r.body.custodian as unknown as { granted: boolean }).granted).toBe(true);
  });

  it("writes nothing at all when any part of the request is refused", async () => {
    /* One good inventory and one that cannot be assigned. The refusal has to
       take the WHOLE request with it — a half-applied access change is an
       employee configured by accident. */
    const r = await patch("admin",
      { module_enabled: false, inventory_scope_ids: [scopeA, 999999], equipment_custodian: true });
    expect(r.status).toBe(404);
    expect(await liveScopes(), "a scope survived a refused request").toEqual([]);
    expect(await hasDuty(), "the duty survived a refused request").toBe(false);
    const mods = (await pool.query(
      `SELECT allowed_modules m FROM mo_user_profiles WHERE user_id=$1`, [A.plain.id])).rows[0].m;
    expect(mods, "the module list survived a refused request").toContain("equipment");
  });

  /* ── History (§8) ─────────────────────────────────────────────────────── */

  it("removes an assignment softly, keeping who did it and when", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA] });
    await patch("admin", { inventory_scope_ids: [] });
    const rows = (await pool.query(
      `SELECT scope_id, granted_by, removed_by, removed_at FROM mo_user_inventory_scopes
        WHERE user_id=$1`, [A.plain.id])).rows;
    expect(rows.length, "the record was deleted rather than closed").toBe(1);
    expect(Number(rows[0].scope_id)).toBe(scopeA);
    expect(rows[0].granted_by).toBe(A.admin.id);
    expect(rows[0].removed_by).toBe(A.admin.id);
    expect(rows[0].removed_at).toBeTruthy();
    /* And the panel can show it. */
    const r = await get("admin");
    expect((r.body.history as unknown as unknown[]).length).toBe(1);
  });

  it("re-granting after a revocation is a new record, not a resurrection", async () => {
    await patch("admin", { inventory_scope_ids: [scopeA] });
    await patch("admin", { inventory_scope_ids: [] });
    await patch("admin", { inventory_scope_ids: [scopeA] });
    const rows = (await pool.query(
      `SELECT id, removed_at FROM mo_user_inventory_scopes WHERE user_id=$1 ORDER BY id`,
      [A.plain.id])).rows;
    expect(rows.length, "the history was overwritten").toBe(2);
    expect(rows[0].removed_at).toBeTruthy();
    expect(rows[1].removed_at).toBeNull();
    /* The partial unique index still allows exactly one live assignment. */
    expect(await liveScopes()).toEqual([scopeA]);
  });

  /* ── Audit (§15) ──────────────────────────────────────────────────────── */

  it("writes one coherent access-change event, naming the person it was about", async () => {
    await patch("admin",
      { module_enabled: true, inventory_scope_ids: [scopeA], equipment_custodian: true });
    const rows = (await pool.query(
      `SELECT action, actor_id, entity_type, entity_uid, before, after FROM mo_audit_logs
        WHERE entity_uid=$1 ORDER BY id DESC`, [A.plain.id])).rows;
    expect(rows.length, "one change should be one event").toBe(1);
    const e = rows[0];
    expect(e.action).toBe("crew.equipment_access_changed");
    expect(e.actor_id).toBe(A.admin.id);
    /* The affected person is queryable, not buried in JSON. */
    expect(e.entity_uid).toBe(A.plain.id);
    expect(e.before).toMatchObject({ equipment_custodian: false, inventories: [] });
    expect(e.after).toMatchObject({ equipment_custodian: true, module_enabled: true });
    expect((e.after as { inventories: string[] }).inventories.length).toBe(1);
  });

  it("writes no event for a refused change", async () => {
    await patch("plain", { equipment_custodian: true });
    await patch("admin", { inventory_scope_ids: [999999] });
    expect((await pool.query(
      `SELECT 1 FROM mo_audit_logs WHERE entity_uid=$1 AND action='crew.equipment_access_changed'`,
      [A.plain.id])).rows).toEqual([]);
  });
});
