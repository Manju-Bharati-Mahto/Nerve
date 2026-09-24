// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Inventory foundation (Phase 17A).

   Six identifiers that are NOT the same thing, and have been conflated before:

     id             the database key
     internal_code  MC-0045 — what a person says aloud and prints on a label
     qr_uid         the scanned token
     serial_no      the MANUFACTURER's serial
     asset_tag      the category-derived tag this module has always had
     source Sr. No  a spreadsheet row counter — never reaches an asset at all

   Most of this file exists to keep them apart, and to prove that the internal
   code is allocated by the SERVER, per inventory, safely under concurrency —
   because a duplicated code is a duplicated label on a real camera.

   The other half holds the line this series has held since Phase 13B: the
   legacy estate is not disturbed, a filter cannot widen what scope allowed,
   and a draft record is not inventory.

   Fixtures are prefixed `zif`.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zif";
let dbUp = false;
/* PHASE 17F — a checkout needs a due date the SERVER will accept: in the
   future and inside the 30-day policy window. Captured from the database, not
   written as a literal, because a literal stops being in the future. */
let DUE = "";
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0, pooledCatId = 0, dutyId = 0;
let mediaCrew = 0, pid = 0, extraScope = 0;

const A = {
  admin:  { id: `${PX}-admin`, role: "admin", team: "media" },
  custMC: { id: `${PX}-cmc`,   role: "user",  team: "media" },
  custPID:{ id: `${PX}-cpid`,  role: "user",  team: "media" },
  plain:  { id: `${PX}-plain`, role: "user",  team: "media" },
  outsider:{ id: `${PX}-out`,  role: "user",  team: "branding" },
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
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZIF ${a.id}` }
      : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never, otpVerifyLimiter: noLimit as never, kioskPinLimiter: noLimit as never,
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

/** Register an asset through the real endpoint. */
async function mk(actor: ActorName, body: Record<string, unknown>) {
  return as(actor, "POST", "/equipment", { category_id: categoryId, make: "ZIF", ...body });
}
const itemRow = async (id: number) =>
  (await pool.query(`SELECT * FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
/* HOW MANY OF THIS SUITE'S OWN ASSETS MATCH.

   Every count below used to be a bare global one — `WHERE model='Cells'` — which
   is only true while no other suite happens to use the same word. The suite's
   categories are created in beforeAll and nothing else writes to them, so they
   are the narrowest thing that is certainly this file's. TEST_STABILITY §17. */
const countMine = async (clause: string, params: unknown[] = []) => Number((await pool.query(
  `SELECT COUNT(*)::int c FROM mo_equipment_items
    WHERE category_id = ANY($1::bigint[]) AND (${clause})`,
  [[categoryId, pooledCatId], ...params])).rows[0].c);
const grantScope = (uid: string, sid: number) => pool.query(
  `INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3)
   ON CONFLICT DO NOTHING`, [uid, sid, A.admin.id]);

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
      [a.id, `ZIF ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  for (const a of [A.admin, A.custMC, A.custPID, A.plain])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZIF','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules`,
      [a.id, JSON.stringify(["home", "my-day", "equipment"])]);

  dutyId = Number((await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0].id);
  for (const a of [A.custMC, A.custPID])
    await pool.query(`INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at)
                      VALUES ($1,$2,CURRENT_DATE) ON CONFLICT DO NOTHING`, [a.id, dutyId]);

  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',9999) RETURNING id`, [`${PX} Camera`])).rows[0].id);
  pooledCatId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'pooled',9999) RETURNING id`, [`${PX} Consumable`])).rows[0].id);

  /* The two seeded inventories, resolved by CODE — never by a hardcoded id. */
  mediaCrew = Number((await pool.query(
    `SELECT id FROM mo_inventory_scopes WHERE code='media_crew'`)).rows[0].id);
  pid = Number((await pool.query(
    `SELECT id FROM mo_inventory_scopes WHERE code='pid'`)).rows[0].id);
  /* A third inventory, to prove the prefix is data rather than a branch. */
  extraScope = Number((await pool.query(
    `INSERT INTO mo_inventory_scopes (name, code, code_prefix, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [`ZIF Third`, `${PX}-third`, "ZIFX", A.admin.id])).rows[0].id);

  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

beforeEach(async () => {
  if (!dbUp) return;
  const ids = (await pool.query(
    `SELECT id FROM mo_equipment_items WHERE asset_tag LIKE $1`, [`EQ-${PX.toUpperCase()}-%`]))
    .rows.map((r) => Number(r.id));
  if (ids.length) {
    await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`UPDATE mo_inventory_scopes SET is_active=true, archived_at=NULL
                     WHERE id = ANY($1::bigint[])`, [[mediaCrew, pid, extraScope]]);
  await grantScope(A.custMC.id, mediaCrew);
  await grantScope(A.custPID.id, pid);
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("the two inventories exist", () => {
  it("seeds Media Crew and PID with stable codes and prefixes", async () => {
    const rows = (await pool.query(
      `SELECT code, name, code_prefix, is_active FROM mo_inventory_scopes
        WHERE code IN ('media_crew','pid') ORDER BY code`)).rows;
    expect(rows.map((r) => r.code)).toEqual(["media_crew", "pid"]);
    expect(rows.map((r) => r.name)).toEqual(["Media Crew", "PID"]);
    expect(rows.map((r) => r.code_prefix)).toEqual(["MC", "PID"]);
    expect(rows.every((r) => r.is_active)).toBe(true);
  });

  it("does not duplicate them when the bootstrap runs again", async () => {
    /* And does not REBUILD what is already right. A migration that replaces a
       CHECK constraint unconditionally takes an ACCESS EXCLUSIVE lock on
       mo_equipment_items every single time this schema is bootstrapped — fifty
       suites, fifty locks, for nothing. The constraint's oid changes when it is
       dropped and recreated, so comparing oids across a second bootstrap is a
       direct test of "looked before it acted". (Phase 17D.) */
    const oids = async () => (await pool.query(
      `SELECT conname, oid::text FROM pg_constraint
        WHERE conrelid='mo_equipment_items'::regclass AND contype='c' ORDER BY conname`)).rows;
    const before = await oids();
    expect(before.map((r) => r.conname))
      .toEqual(expect.arrayContaining(["mo_equipment_items_verification_check",
                                       "mo_equipment_items_reject_reason_check"]));
    const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
    await bootstrapMediaOpsDatabase();
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_inventory_scopes WHERE code IN ('media_crew','pid')`)).rows[0].c)).toBe(2);
    expect(await oids(), "a bootstrap rebuilt a constraint that was already correct").toEqual(before);
  }, 60_000);

  it("assigns no legacy asset to either of them", async () => {
    /* PHASE 17A MIGRATES NOTHING. The CSV is source data, not a manifest.

       Keyed on the CATEGORY rather than on this suite's asset-tag prefix. The
       prefix version was right about its own fixtures and wrong about everyone
       else's: a sibling suite that attaches its asset to a seeded inventory is
       doing nothing wrong, and counted as a stray anyway. Every suite here
       names its fixture category '<zxx> Something', so an asset outside that
       shape is one the registry seeded — exactly the population a backfill
       would have moved. Same discriminator as the scope suite. */
    const strays = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items i
         JOIN mo_inventory_scopes s ON s.id = i.scope_id
         JOIN mo_equipment_categories c ON c.id = i.category_id
        WHERE s.code IN ('media_crew','pid') AND c.name !~ '^z[a-z][a-z] '`)).rows[0].c);
    expect(strays).toBe(0);
  });

  it("keeps one prefix to one inventory", async () => {
    await expect(pool.query(
      `INSERT INTO mo_inventory_scopes (name, code, code_prefix) VALUES ($1,$2,'MC')`,
      [`${PX} Clash`, `${PX}-clash`])).rejects.toThrow();
  });

  it("refuses a prefix that is not a prefix", async () => {
    for (const bad of ["mc", "M", "TOOLONGPREFIX", "M-C"])
      await expect(pool.query(
        `INSERT INTO mo_inventory_scopes (name, code, code_prefix) VALUES ($1,$2,$3)`,
        [`${PX} Bad`, `${PX}-bad-${bad}`, bad]), bad).rejects.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("GET /equipment/inventories", () => {
  it("shows an Admin every inventory, plus the legacy estate", async () => {
    const r = await as("admin", "GET", "/equipment/inventories");
    expect(r.status).toBe(200);
    const codes = (r.body.inventories as unknown as { code: string }[]).map((x) => x.code);
    expect(codes).toContain("media_crew");
    expect(codes).toContain("pid");
    expect(r.body.scope_level).toBe("all");
    expect((r.body.legacy as unknown as { code: string }).code).toBe("legacy");
  });

  it("shows a custodian only the inventory they hold", async () => {
    const r = await as("custMC", "GET", "/equipment/inventories");
    const codes = (r.body.inventories as unknown as { code: string }[]).map((x) => x.code);
    expect(codes).toEqual(["media_crew"]);
    expect(r.body.scope_level).toBe("scoped");
  });

  it("shows an unassigned crew member none — but still the legacy estate", async () => {
    const r = await as("plain", "GET", "/equipment/inventories");
    expect(r.body.inventories).toEqual([]);
    expect(r.body.scope_level).toBe("none");
    expect((r.body.legacy as unknown as { name: string }).name).toMatch(/Not Assigned/i);
  });

  it("counts only assets the caller may see", async () => {
    await mk("admin", { scope_id: mediaCrew, model: "Counted" });
    const admin = (await as("admin", "GET", "/equipment/inventories")).body
      .inventories as unknown as { code: string; assets: number }[];
    const pidSeen = (await as("custPID", "GET", "/equipment/inventories")).body
      .inventories as unknown as { code: string; assets: number }[];
    expect(admin.find((x) => x.code === "media_crew")!.assets).toBeGreaterThanOrEqual(1);
    // custPID cannot see Media Crew at all, so no count leaks through it.
    expect(pidSeen.map((x) => x.code)).toEqual(["pid"]);
  });

  it("is refused to anonymous and non-media callers", async () => {
    expect((await as("anon", "GET", "/equipment/inventories")).status).toBe(403);
    expect((await as("outsider", "GET", "/equipment/inventories")).status).toBe(403);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("internal asset codes", () => {
  it("mints one per inventory, in sequence, from the inventory's own prefix", async () => {
    /* CONTIGUITY IS MEASURED IN AN INVENTORY NOBODY ELSE WRITES TO. The code
       sequence is per inventory and the seeded ones are shared, so a sibling
       suite registering an asset into Media Crew between these two calls takes
       the number in between — and the assertion failed for a reason that had
       nothing to do with the allocator. zif-third is created by this file and
       written to by nothing else. TEST_STABILITY entry 17. */
    const a = await mk("admin", { scope_id: extraScope, model: "One" });
    const b = await mk("admin", { scope_id: extraScope, model: "Two" });
    const c = await mk("admin", { scope_id: pid, model: "Three" });
    const code = (r: typeof a) => (r.body.item as unknown as { internal_code: string }).internal_code;
    expect(code(a)).toMatch(/^ZIFX-\d{4}$/);
    expect(code(b)).toMatch(/^ZIFX-\d{4}$/);
    expect(Number(code(b).slice(5))).toBe(Number(code(a).slice(5)) + 1);
    /* And a DIFFERENT inventory gets its own prefix and its own counter. */
    expect(code(c)).toMatch(/^PID-\d{4}$/);
  });

  it("takes the prefix from the inventory row, not from a branch in the code", async () => {
    // A third inventory was created with prefix ZIFX and needs no deploy.
    const r = await mk("admin", { scope_id: extraScope, model: "Third" });
    expect((r.body.item as unknown as { internal_code: string }).internal_code).toMatch(/^ZIFX-\d{4}$/);
  });

  it("gives an UNSCOPED asset no code at all", async () => {
    /* The legacy estate has no inventory to derive a prefix from, and a code
       invented without one is a label nobody could place. */
    const r = await mk("admin", { model: "Ungoverned" });
    const item = r.body.item as unknown as { internal_code: string | null; scope_id?: number };
    expect(r.status).toBe(201);
    expect(item.internal_code).toBeNull();
    expect((await itemRow(Number((r.body.item as unknown as { id: number }).id))).scope_id).toBeNull();
  });

  it("never takes a code from the client", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "Forged", internal_code: "MC-9999" });
    expect((r.body.item as unknown as { internal_code: string }).internal_code).not.toBe("MC-9999");
    expect(await countMine(`internal_code = $2`, ["MC-9999"]),
      "a client-supplied code reached the database").toBe(0);
  });

  it("is protected at the database, not merely in the allocator", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "Unique" });
    const code = (r.body.item as unknown as { internal_code: string }).internal_code;
    await expect(pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, internal_code)
       VALUES ($1,$2,'ZIF',$3)`, [categoryId, `EQ-${PX.toUpperCase()}-DUP`, code])).rejects.toThrow();
  });

  it("allocates safely when several registrations race", async () => {
    /* COUNT(*)+1 is not a counter. Six at once must produce six distinct,
       contiguous codes — the advisory lock is what makes that true.

       RACED IN AN INVENTORY NOBODY ELSE WRITES TO. Contiguity is a claim about
       THIS burst, and the seeded inventories are shared: a sibling suite
       registering into PID while these six are in flight takes a number in the
       middle, and the gap it leaves is the allocator working correctly. zif-third
       is created by this file and written to by nothing else. Same correction as
       the sequence test above; TEST_STABILITY entry 17. */
    const out = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      mk("admin", { scope_id: extraScope, model: `Race ${i}` })));
    expect(out.every((r) => r.status === 201)).toBe(true);
    const codes = out.map((r) => (r.body.item as unknown as { internal_code: string }).internal_code);
    expect(new Set(codes).size, `codes: ${codes.join(",")}`).toBe(6);
    const nums = codes.map((c) => Number(c.split("-")[1])).sort((a, b) => a - b);
    expect(nums[5] - nums[0], `codes: ${codes.join(",")}`).toBe(5);   // no gaps, no reuse
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("the identifiers stay separate", () => {
  it("keeps code, tag, QR and serial as four different things", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "Four", serial_no: `${PX}-SN-1` });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const row = await itemRow(id);
    expect(row.internal_code).toMatch(/^MC-/);
    expect(row.asset_tag).toMatch(/^EQ-/);           // category-derived, unchanged
    expect(row.serial_no).toBe(`${PX}-SN-1`);
    expect(row.internal_code).not.toBe(row.asset_tag);
    expect(row.internal_code).not.toBe(row.serial_no);
    const qr = (await pool.query(
      `SELECT value FROM mo_asset_identifiers WHERE asset_id=$1 AND kind='qr' AND is_primary`, [id])).rows[0];
    expect(qr.value).toMatch(/^AT-/);                 // opaque, carries nothing
    expect(qr.value).not.toBe(row.internal_code);
  });

  it("refuses a second asset with the same manufacturer serial", async () => {
    await mk("admin", { scope_id: mediaCrew, model: "First", serial_no: `${PX}-SHARED` });
    const dup = await mk("admin", { scope_id: mediaCrew, model: "Second", serial_no: `${PX}-SHARED` });
    expect(dup.status).toBe(409);
  });

  it("allows any number of assets with NO serial", async () => {
    // Most of this estate has no serial recorded; inventing one to satisfy a
    // constraint is exactly what this series refuses.
    const a = await mk("admin", { scope_id: mediaCrew, model: "NoSerialA" });
    const b = await mk("admin", { scope_id: mediaCrew, model: "NoSerialB" });
    expect([a.status, b.status]).toEqual([201, 201]);
  });

  it("keeps QR tokens unique at the database", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "QR" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const token = (await pool.query(
      `SELECT value FROM mo_asset_identifiers WHERE asset_id=$1 AND kind='qr'`, [id])).rows[0].value;
    await expect(pool.query(
      `INSERT INTO mo_asset_identifiers (asset_id, kind, value) VALUES ($1,'qr',$2)`,
      [id, token])).rejects.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("serialized and pooled", () => {
  it("records a pooled item as ONE row with a quantity", async () => {
    /* Not forty rows pretending to be forty identities. */
    const r = await mk("admin", { category_id: pooledCatId, scope_id: pid,
      model: "Cells", tracking_mode: "pooled", pool_quantity: 48 });
    expect(r.status).toBe(201);
    const row = await itemRow(Number((r.body.item as unknown as { id: number }).id));
    expect(row.tracking_mode).toBe("pooled");
    expect(row.pool_quantity).toBe(48);
    expect(await countMine(`model = $2`, ["Cells"]),
      "a pooled row was split into units").toBe(1);
  });

  it("falls back to the category's mode when the item does not say", async () => {
    const r = await mk("admin", { category_id: pooledCatId, scope_id: pid, model: "Inherits" });
    expect((await itemRow(Number((r.body.item as unknown as { id: number }).id))).tracking_mode).toBeNull();
    // The read model resolves it, so the client sees the effective mode.
    const seen = await as("admin", "GET", `/equipment?q=Inherits`);
    expect((seen.body.items as unknown as { tracking_mode: string }[])[0].tracking_mode).toBe("pooled");
  });

  it("refuses an unknown tracking mode", async () => {
    expect((await mk("admin", { scope_id: mediaCrew, model: "Bad", tracking_mode: "serialised" })).status).toBe(400);
  });

  it("refuses a quantity on a serialized asset, and a nonsense quantity", async () => {
    expect((await mk("admin", { scope_id: mediaCrew, model: "X", tracking_mode: "individual", pool_quantity: 5 })).status).toBe(400);
    expect((await mk("admin", { scope_id: mediaCrew, model: "Y", pool_quantity: 0 })).status).toBe(400);
    expect((await mk("admin", { scope_id: mediaCrew, model: "Z", pool_quantity: -3 })).status).toBe(400);
  });

  it("refuses a non-positive quantity at the database too", async () => {
    await expect(pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, pool_quantity)
       VALUES ($1,$2,'ZIF',0)`, [categoryId, `EQ-${PX.toUpperCase()}-Q0`])).rejects.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("registering into an inventory is authorised, not trusted", () => {
  it("lets a custodian register into their own inventory", async () => {
    const r = await mk("custMC", { scope_id: mediaCrew, model: "Mine" });
    expect(r.status).toBe(201);
    expect((r.body.item as unknown as { internal_code: string }).internal_code).toMatch(/^MC-/);
  });

  it("refuses a custodian registering into somebody else's inventory", async () => {
    const r = await mk("custMC", { scope_id: pid, model: "Theirs" });
    expect(r.status).toBe(404);          // the same answer an invented id gets
    expect(await countMine(`model = $2`, ["Theirs"]),
      "a refused registration still wrote a row").toBe(0);
  });

  it("refuses an inventory that does not exist", async () => {
    expect((await mk("admin", { scope_id: 2147483000, model: "Ghost" })).status).toBe(400);
    expect((await mk("admin", { scope_id: "not-a-number", model: "Ghost2" })).status).toBe(400);
  });

  it("refuses a deactivated inventory", async () => {
    await pool.query(`UPDATE mo_inventory_scopes SET is_active=false WHERE id=$1`, [extraScope]);
    expect((await mk("admin", { scope_id: extraScope, model: "Dead" })).status).toBe(409);
  });

  it("audits the registration through the existing trail", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "Audited" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const rows = (await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='equipment_item' AND entity_id=$1`, [id])).rows;
    expect(rows.length).toBeGreaterThan(0);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("reading by inventory", () => {
  it("filters the registry by inventory code and by id", async () => {
    await mk("admin", { scope_id: mediaCrew, model: "InMC" });
    await mk("admin", { scope_id: pid, model: "InPID" });
    const byCode = await as("admin", "GET", "/equipment?inventory=media_crew&q=In");
    const models = (byCode.body.items as unknown as { model: string }[]).map((x) => x.model);
    expect(models).toContain("InMC");
    expect(models).not.toContain("InPID");
    const byId = await as("admin", "GET", `/equipment?inventory=${pid}&q=In`);
    expect((byId.body.items as unknown as { model: string }[]).map((x) => x.model)).toEqual(["InPID"]);
  });

  it("filters to the legacy estate", async () => {
    await mk("admin", { model: "LegacyOne" });
    await mk("admin", { scope_id: mediaCrew, model: "GovernedOne" });
    const r = await as("admin", "GET", "/equipment?inventory=legacy&q=One");
    const models = (r.body.items as unknown as { model: string }[]).map((x) => x.model);
    expect(models).toContain("LegacyOne");
    expect(models).not.toContain("GovernedOne");
  });

  it("A FILTER CANNOT WIDEN what scope already allowed", async () => {
    await mk("admin", { scope_id: pid, model: "PidOnly" });
    const r = await as("custMC", "GET", `/equipment?inventory=pid&q=PidOnly`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
  });

  it("finds an asset by its internal code, in search and by path", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "Findable" });
    const code = (made.body.item as unknown as { internal_code: string }).internal_code;
    const found = await as("admin", "GET", `/equipment?q=${encodeURIComponent(code)}`);
    expect((found.body.items as unknown as { model: string }[])[0].model).toBe("Findable");
    const detail = await as("admin", "GET", `/equipment/${code}`);
    expect(detail.status).toBe(200);
    expect((detail.body.item as unknown as { model: string }).model).toBe("Findable");
  });

  it("resolves an internal code like any other printed identifier", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "Scannable" });
    const code = (made.body.item as unknown as { internal_code: string }).internal_code;
    const r = await as("admin", "GET", `/equipment/resolve/${code}`);
    expect(r.status).toBe(200);
    expect((r.body.item as unknown as { model: string }).model).toBe("Scannable");
  });

  it("does not let an internal code cross an inventory boundary", async () => {
    const made = await mk("admin", { scope_id: pid, model: "PidSecret" });
    const code = (made.body.item as unknown as { internal_code: string }).internal_code;
    expect((await as("custMC", "GET", `/equipment/${code}`)).status).toBe(404);
    expect((await as("custMC", "GET", `/equipment/resolve/${code}`)).status).toBe(404);
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("a draft record is not inventory", () => {
  const draft = async (model: string) => {
    const r = await mk("admin", { scope_id: mediaCrew, model });
    const id = Number((r.body.item as unknown as { id: number }).id);
    await pool.query(`UPDATE mo_equipment_items SET verification_state='draft' WHERE id=$1`, [id]);
    return id;
  };

  it("hides a draft from the registry", async () => {
    await draft("DraftOne");
    const r = await as("admin", "GET", "/equipment?q=DraftOne");
    expect(r.body.items).toEqual([]);
  });

  it("shows it when the reviewing screen asks for it", async () => {
    await draft("DraftTwo");
    const r = await as("admin", "GET", "/equipment?q=DraftTwo&verification=draft");
    expect((r.body.items as unknown as { model: string }[]).map((x) => x.model)).toEqual(["DraftTwo"]);
  });

  it("does not count a draft as inventory", async () => {
    /* Measured on THIS SUITE'S OWN INVENTORY. The figure the endpoint returns
       is global for an admin — correctly, since it answers "how big is this
       inventory" — so a before/after around a seeded inventory moves whenever a
       sibling suite registers an asset, which Phase 17E made routine. zif-third
       is created by this file and written to by nothing else, so a delta across
       it is this test's own delta. TEST_STABILITY entry 15. */
    const counted = async () => ((await as("admin", "GET", "/equipment/inventories")).body
      .inventories as unknown as { id: number; assets: number }[])
      .find((x) => Number(x.id) === extraScope)!.assets;
    const before = await counted();
    await draft("DraftThree", extraScope);
    expect(await counted(), "a draft was counted as inventory").toBe(before);
    /* And the control: an ACTIVE registration in the same inventory does count,
       so the assertion above is about the draft and not about a broken read. */
    await mk("admin", { scope_id: extraScope, model: "CountsAsReal" });
    expect(await counted()).toBe(before + 1);
  });

  it("rejects a verification state nobody defined", async () => {
    const id = await draft("DraftFour");
    await expect(pool.query(
      `UPDATE mo_equipment_items SET verification_state='approved' WHERE id=$1`, [id])).rejects.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────────────────── */
maybe("nothing from the earlier phases regressed", () => {
  it("still ships no equipment or inventory data in the boot payload", async () => {
    const r = await as("admin", "GET", "/state");
    const keys = Object.keys(r.body);
    for (const k of ["equipment_items", "equipment_transactions", "equipment_bookings",
                     "maintenance_records", "inventory_scopes", "user_inventory_scopes"])
      expect(keys, `${k} is back in /state`).not.toContain(k);
  });

  it("keeps the authorization key out of the read models", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "NoScopeLeak" });
    const list = await as("admin", "GET", "/equipment?q=NoScopeLeak");
    const row = (list.body.items as unknown as Record<string, unknown>[])[0];
    expect(row.scope_id).toBeUndefined();
    expect(row.internal_code).toBeTruthy();     // the human identifier does travel
    expect((r.body.item as unknown as Record<string, unknown>).id).toBeTruthy();
  });

  it("leaves the unscoped estate reachable by everyone who could reach it", async () => {
    const r = await mk("admin", { model: "StillOpen" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    for (const who of ["admin", "custMC", "custPID", "plain"] as const)
      expect((await as(who, "GET", `/equipment/${id}`)).status, who).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17B — backfilling internal codes onto assets that already have an
   inventory but no label.

   The interesting cases are all about restraint: an unscoped asset must NOT
   get a code, an existing code must NOT change, and a pooled row must NOT be
   split into imaginary units. Everything here creates its "legacy" rows by
   direct SQL, the way a pre-17A asset would have looked.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("backfilling internal codes", () => {
  /** An asset as it existed before codes: a scope, and no code. */
  const legacy = async (model: string, scopeId: number | null, extra = "") => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ($1,$2,'ZIF',$3,$4${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-L${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
     model, scopeId])).rows[0].id);
  const codeOf = async (id: number) =>
    (await pool.query(`SELECT internal_code FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].internal_code;

  it("gives a scoped asset with no code one, from its own inventory", async () => {
    const mc = await legacy("LegacyMC", mediaCrew);
    const p = await legacy("LegacyPID", pid);
    const r = await as("admin", "POST", "/equipment/backfill-codes", {});
    expect(r.status).toBe(200);
    expect(await codeOf(mc)).toMatch(/^MC-\d{4}$/);
    expect(await codeOf(p)).toMatch(/^PID-\d{4}$/);
    expect(Number(r.body.coded)).toBeGreaterThanOrEqual(2);
  });

  it("LEAVES AN UNSCOPED ASSET ALONE — code pending, not invented", async () => {
    /* The prefix comes from the inventory. No inventory, no code, and no
       guess from category, vendor, holder or name. */
    const orphan = await legacy("LegacyUnscoped", null);
    const r = await as("admin", "POST", "/equipment/backfill-codes", {});
    expect(await codeOf(orphan)).toBeNull();
    expect(Number(r.body.unscoped_code_pending)).toBeGreaterThanOrEqual(1);
  });

  it("never overwrites a code that already exists", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "AlreadyCoded" });
    const id = Number((made.body.item as unknown as { id: number }).id);
    const before = await codeOf(id);
    await as("admin", "POST", "/equipment/backfill-codes", {});
    expect(await codeOf(id)).toBe(before);
  });

  it("is idempotent — running it again finds nothing to do", async () => {
    /* Run against ONE inventory, and check what is left in that inventory
       rather than reading remaining_eligible. The reported figure is deliberately
       global for an admin — it answers "what is still uncoded anywhere", which is
       the right thing for an operator and the wrong thing for an assertion:
       sibling suites create scoped assets of their own throughout the run, so a
       second call legitimately finds work that has nothing to do with this test.
       TEST_STABILITY entry 14. */
    await legacy("Idem", extraScope);
    const first = await as("admin", "POST", "/equipment/backfill-codes", { scope_id: extraScope });
    expect(Number(first.body.coded)).toBeGreaterThanOrEqual(1);
    const second = await as("admin", "POST", "/equipment/backfill-codes", { scope_id: extraScope });
    expect(Number(second.body.coded)).toBe(0);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items
        WHERE scope_id=$1 AND internal_code IS NULL AND deleted_at IS NULL`,
      [extraScope])).rows[0].c)).toBe(0);
  });

  it("continues the inventory's existing numbering rather than restarting", async () => {
    const made = await mk("admin", { scope_id: extraScope, model: "First" });
    const firstCode = (made.body.item as unknown as { internal_code: string }).internal_code;
    const back = await legacy("Second", extraScope);
    await as("admin", "POST", "/equipment/backfill-codes", { scope_id: extraScope });
    const secondCode = await codeOf(back);
    expect(Number(secondCode.split("-")[1])).toBe(Number(firstCode.split("-")[1]) + 1);
  });

  it("gives a pooled row ONE identity and does not split it into units", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, tracking_mode, pool_quantity)
       VALUES ($1,$2,'ZIF','PooledLegacy',$3,'pooled',48) RETURNING id`,
      [pooledCatId, `EQ-${PX.toUpperCase()}-POOL1`, pid])).rows[0].id);
    await as("admin", "POST", "/equipment/backfill-codes", {});
    const row = (await pool.query(
      `SELECT internal_code, pool_quantity FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
    expect(row.internal_code).toMatch(/^PID-\d{4}$/);
    expect(row.pool_quantity).toBe(48);
    /* 48 units, ONE record, ONE code, and no invented serials. */
    expect(await countMine(`model = $2`, ["PooledLegacy"]),
      "a pooled row was split into units").toBe(1);
    expect((await pool.query(
      `SELECT serial_no FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].serial_no).toBeNull();
  });

  it("leaves the manufacturer serial untouched and distinct from the code", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, serial_no)
       VALUES ($1,$2,'ZIF','WithSerial',$3,$4) RETURNING id`,
      [categoryId, `EQ-${PX.toUpperCase()}-SER1`, mediaCrew, `${PX}-REAL-SERIAL`])).rows[0].id);
    await as("admin", "POST", "/equipment/backfill-codes", {});
    const row = (await pool.query(
      `SELECT internal_code, serial_no FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
    expect(row.serial_no).toBe(`${PX}-REAL-SERIAL`);
    expect(row.internal_code).toMatch(/^MC-/);
    expect(row.internal_code).not.toBe(row.serial_no);
  });

  it("never lets a source sequence number become a manufacturer serial", async () => {
    /* The spreadsheet's "Sr. No" is a row counter. The API has no field that
       could carry it onto an asset, and a caller inventing one is ignored. */
    const r = await mk("admin", { scope_id: mediaCrew, model: "SrNo",
      sr_no: "17", source_sequence: "17", serial: "17" });
    const row = await itemRow(Number((r.body.item as unknown as { id: number }).id));
    expect(row.serial_no).toBeNull();
    expect(row.internal_code).not.toBe("17");
  });

  it("allocates safely when backfill and registration race", async () => {
    for (let i = 0; i < 4; i++) await legacy(`Race${i}`, pid);
    const [bulk, ...created] = await Promise.all([
      as("admin", "POST", "/equipment/backfill-codes", { scope_id: pid }),
      mk("admin", { scope_id: pid, model: "RaceNew1" }),
      mk("admin", { scope_id: pid, model: "RaceNew2" }),
    ]);
    expect(bulk.status).toBe(200);
    expect(created.every((c) => c.status === 201)).toBe(true);
    const codes = (await pool.query(
      `SELECT internal_code FROM mo_equipment_items
        WHERE scope_id=$1 AND internal_code IS NOT NULL`, [pid])).rows.map((r) => r.internal_code);
    expect(new Set(codes).size, `codes: ${codes.join(",")}`).toBe(codes.length);
  });

  it("audits the backfill against the inventory, with every asset and its code", async () => {
    const id = await legacy("Audited", mediaCrew);
    await as("admin", "POST", "/equipment/backfill-codes", { scope_id: mediaCrew });
    const row = (await pool.query(
      `SELECT actor_id, entity_type, entity_id, before, after FROM mo_audit_logs
        WHERE action='equipment.internal_codes_backfilled' AND actor_id=$1
        ORDER BY occurred_at DESC LIMIT 1`, [A.admin.id])).rows[0];
    expect(row).toBeDefined();
    expect(Number(row.entity_id)).toBe(mediaCrew);
    expect(row.entity_type).toBe("inventory_scopes");
    expect(row.before).toEqual({ internal_code: null });          // the old value
    const after = row.after as { source: string; assets: { asset_id: number; internal_code: string }[] };
    expect(after.source).toBe("phase_17b_backfill");
    expect(after.assets.some((a) => Number(a.asset_id) === id)).toBe(true);
  });
});

maybe("who may backfill", () => {
  const legacyIn = async (scopeId: number) => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id)
     VALUES ($1,$2,'ZIF','AuthTest',$3) RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-A${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
     scopeId])).rows[0].id);
  const codeOf = async (id: number) =>
    (await pool.query(`SELECT internal_code FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].internal_code;

  it("refuses a crew member without the custodian capability", async () => {
    const id = await legacyIn(mediaCrew);
    expect((await as("plain", "POST", "/equipment/backfill-codes", {})).status).toBe(403);
    expect(await codeOf(id)).toBeNull();
  });

  it("refuses anonymous and non-media callers", async () => {
    expect((await as("anon", "POST", "/equipment/backfill-codes", {})).status).toBe(403);
    expect((await as("outsider", "POST", "/equipment/backfill-codes", {})).status).toBe(403);
  });

  it("lets a custodian backfill their OWN inventory", async () => {
    const id = await legacyIn(mediaCrew);
    const r = await as("custMC", "POST", "/equipment/backfill-codes", {});
    expect(r.status).toBe(200);
    expect(await codeOf(id)).toMatch(/^MC-/);
  });

  it("does not let a custodian reach another inventory, even in bulk", async () => {
    const mine = await legacyIn(mediaCrew);
    const theirs = await legacyIn(pid);
    await as("custMC", "POST", "/equipment/backfill-codes", {});
    expect(await codeOf(mine)).toMatch(/^MC-/);
    expect(await codeOf(theirs), "a custodian coded another inventory's asset").toBeNull();
  });

  it("answers 404 for an inventory the caller has no authority over", async () => {
    const r = await as("custMC", "POST", "/equipment/backfill-codes", { scope_id: pid });
    expect(r.status).toBe(404);
  });

  it("an unassigned custodian backfills nothing at all", async () => {
    await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id=$1`, [A.custMC.id]);
    const id = await legacyIn(mediaCrew);
    const r = await as("custMC", "POST", "/equipment/backfill-codes", {});
    expect(r.status).toBe(200);
    expect(Number(r.body.coded)).toBe(0);
    expect(await codeOf(id)).toBeNull();
  });
});

maybe("the migration cannot abort on real data", () => {
  it("does not treat a dash as a manufacturer serial", async () => {
    /* Three pooled rows in the development database carry serial_no = '—'.
       Treating that placeholder as an identity made three assets collide on a
       serial none of them has, and the failing CREATE UNIQUE INDEX took the
       rest of the migration down with it. */
    const a = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, serial_no)
       VALUES ($1,$2,'ZIF','—') RETURNING id`, [categoryId, `EQ-${PX.toUpperCase()}-DASH1`])).rows[0].id);
    const b = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, serial_no)
       VALUES ($1,$2,'ZIF','—') RETURNING id`, [categoryId, `EQ-${PX.toUpperCase()}-DASH2`])).rows[0].id);
    expect(a).toBeTruthy(); expect(b).toBeTruthy();
    for (const v of ["N/A", "none", "-"]) {
      await pool.query(`INSERT INTO mo_equipment_items (category_id, asset_tag, make, serial_no)
                        VALUES ($1,$2,'ZIF',$3)`, [categoryId, `EQ-${PX.toUpperCase()}-P${v.replace(/\W/g, "")}1`, v]);
      await pool.query(`INSERT INTO mo_equipment_items (category_id, asset_tag, make, serial_no)
                        VALUES ($1,$2,'ZIF',$3)`, [categoryId, `EQ-${PX.toUpperCase()}-P${v.replace(/\W/g, "")}2`, v]);
    }
  });

  it("still refuses two assets that share a REAL serial", async () => {
    await pool.query(`INSERT INTO mo_equipment_items (category_id, asset_tag, make, serial_no)
                      VALUES ($1,$2,'ZIF',$3)`, [categoryId, `EQ-${PX.toUpperCase()}-RS1`, `${PX}-REALDUP`]);
    await expect(pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, serial_no)
       VALUES ($1,$2,'ZIF',$3)`, [categoryId, `EQ-${PX.toUpperCase()}-RS2`, `${PX}-REALDUP`])).rejects.toThrow();
  });

  it("completed every statement that follows the serial index", async () => {
    /* The failure mode was a half-applied schema: internal_code present,
       tracking_mode and verification_state missing. */
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='mo_equipment_items'
          AND column_name IN ('internal_code','tracking_mode','verification_state')`))
      .rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(["internal_code", "tracking_mode", "verification_state"]);
  });
});

maybe("what the screen is given to print", () => {
  it("carries the inventory NAME, the code and the tracking mode — but never the scope id", async () => {
    const r = await mk("admin", { scope_id: mediaCrew, model: "Printable" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const d = await as("admin", "GET", `/equipment/${id}`);
    const item = d.body.item as unknown as Record<string, unknown>;
    expect(item.inventory_name).toBe("Media Crew");
    expect(item.inventory_code).toBe("media_crew");
    expect(String(item.internal_code)).toMatch(/^MC-/);
    expect(item.tracking_mode).toBe("individual");
    expect(item.verification_state).toBe("active");
    /* The label travels; the authorization key does not. */
    expect(item.scope_id).toBeUndefined();
  });

  it("says nothing rather than something plausible for an ungoverned asset", async () => {
    const r = await mk("admin", { model: "Ungoverned2" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const item = (await as("admin", "GET", `/equipment/${id}`)).body.item as unknown as Record<string, unknown>;
    expect(item.inventory_name).toBeNull();     // the screen prints "Not Assigned"
    expect(item.internal_code).toBeNull();      // the screen prints "Pending"
  });

  it("reports a pooled row's quantity beside its single identity", async () => {
    const r = await mk("admin", { category_id: pooledCatId, scope_id: pid, model: "PoolPrint",
      tracking_mode: "pooled", pool_quantity: 29 });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const item = (await as("admin", "GET", `/equipment/${id}`)).body.item as unknown as Record<string, unknown>;
    expect(item.tracking_mode).toBe("pooled");
    expect(item.pool_quantity).toBe(29);
    expect(String(item.internal_code)).toMatch(/^PID-/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17C — UNSCOPED → GOVERNED.

   The workflow that moves an asset out of the legacy estate. Scope and code
   are set together or not at all, and the tests below spend most of their
   effort on the "not at all" half: every refusal must leave the asset exactly
   as it was, with no scope, no code and no audit claiming otherwise.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("assigning an inventory", () => {
  /** A legacy asset: no inventory, no code — the state all 32 real ones are in. */
  const unscoped = async (model: string) => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model)
     VALUES ($1,$2,'ZIF',$3) RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-U${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
     model])).rows[0].id);
  const row = async (id: number) => (await pool.query(
    `SELECT scope_id, internal_code, verification_state, retired_at FROM mo_equipment_items WHERE id=$1`,
    [id])).rows[0];
  const assign = (actor: ActorName | "anon", id: number, scopeId: unknown, extra = {}) =>
    as(actor, "POST", `/equipment/${id}/assign-inventory`, { scope_id: scopeId, ...extra });
  const auditsFor = async (id: number) => (await pool.query(
    `SELECT actor_id, before, after FROM mo_audit_logs
      WHERE action='equipment.inventory_assigned' AND entity_type='equipment_item' AND entity_id=$1`,
    [id])).rows;

  it("moves an unscoped asset into Media Crew and mints MC-####", async () => {
    const id = await unscoped("ToMC");
    const r = await assign("admin", id, mediaCrew);
    expect(r.status).toBe(200);
    const after = await row(id);
    expect(Number(after.scope_id)).toBe(mediaCrew);
    expect(after.internal_code).toMatch(/^MC-\d{4}$/);
    /* The server's own read comes back, not an echo of the request. */
    const item = r.body.item as unknown as Record<string, unknown>;
    expect(item.inventory_name).toBe("Media Crew");
    expect(item.internal_code).toBe(after.internal_code);
  });

  it("moves one into PID and mints PID-####", async () => {
    const id = await unscoped("ToPID");
    expect((await assign("admin", id, pid)).status).toBe(200);
    expect((await row(id)).internal_code).toMatch(/^PID-\d{4}$/);
  });

  it("LEAVES VERIFICATION ALONE — assignment is not approval", async () => {
    /* And more practically: the registry shows only 'active' rows, so moving a
       live asset to 'pending_verification' here would make a camera that is out
       on loan vanish from the catalogue the moment somebody filed it. */
    const id = await unscoped("StillActive");
    const before = (await row(id)).verification_state;
    await assign("admin", id, mediaCrew);
    expect((await row(id)).verification_state).toBe(before);
    const seen = await as("admin", "GET", "/equipment?q=StillActive");
    expect((seen.body.items as unknown as unknown[]).length).toBe(1);
  });

  it("writes exactly one audit, carrying the old scope, the new one and the code", async () => {
    const id = await unscoped("Audited17c");
    await assign("admin", id, mediaCrew);
    const rows = await auditsFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0].actor_id).toBe(A.admin.id);
    expect(rows[0].before).toEqual({ scope_id: null, internal_code: null });
    const after = rows[0].after as Record<string, unknown>;
    expect(Number(after.scope_id)).toBe(mediaCrew);
    expect(after.inventory_code).toBe("media_crew");
    expect(String(after.internal_code)).toMatch(/^MC-/);
  });

  it("ignores a code or an actor supplied by the caller", async () => {
    const id = await unscoped("Forged17c");
    await assign("admin", id, mediaCrew,
      { internal_code: "MC-9999", actor_id: A.plain.id, verification_state: "draft", created_by: A.plain.id });
    const after = await row(id);
    expect(after.internal_code).not.toBe("MC-9999");
    expect(after.verification_state).toBe("active");        // not the forged 'draft'
    const rows = await auditsFor(id);
    expect(rows[0].actor_id).toBe(A.admin.id);              // the session, not the body
  });

  it("refuses an asset that already belongs to an inventory — this is not transfer", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "AlreadyIn" });
    const id = Number((made.body.item as unknown as { id: number }).id);
    const before = await row(id);
    const r = await assign("admin", id, pid);
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/already belongs|transfer/i);
    expect(await row(id)).toEqual(before);                  // nothing moved
  });

  it("stops on a code without an inventory rather than guessing", async () => {
    const id = await unscoped("Inconsistent");
    await pool.query(`UPDATE mo_equipment_items SET internal_code=$2 WHERE id=$1`,
      [id, `MC-${PX.toUpperCase()}1`]);
    const r = await assign("admin", id, mediaCrew);
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/remediation/i);
    expect((await row(id)).scope_id).toBeNull();
  });

  it("refuses a retired asset", async () => {
    const id = await unscoped("Retired17c");
    await pool.query(`UPDATE mo_equipment_items SET retired_at=NOW() WHERE id=$1`, [id]);
    expect((await assign("admin", id, mediaCrew)).status).toBe(409);
    expect((await row(id)).scope_id).toBeNull();
  });

  it("refuses an inventory that does not exist, and one that is deactivated", async () => {
    const a = await unscoped("NoSuchInv");
    expect((await assign("admin", a, 2147483000)).status).toBe(404);
    expect((await row(a)).scope_id).toBeNull();

    const b = await unscoped("DeadInv");
    await pool.query(`UPDATE mo_inventory_scopes SET is_active=false WHERE id=$1`, [extraScope]);
    expect((await assign("admin", b, extraScope)).status).toBe(409);
    expect((await row(b)).scope_id).toBeNull();
  });

  it("refuses an inventory that cannot issue codes", async () => {
    /* No prefix, no code — and therefore no scope either, because a governed
       asset without a label is exactly the partial state this forbids. */
    const noPrefix = Number((await pool.query(
      `INSERT INTO mo_inventory_scopes (name, code, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [`ZIF NoPrefix`, `${PX}-noprefix`, A.admin.id])).rows[0].id);
    const id = await unscoped("NoPrefixTarget");
    const r = await assign("admin", id, noPrefix);
    expect(r.status).toBe(409);
    const after = await row(id);
    expect(after.scope_id).toBeNull();
    expect(after.internal_code).toBeNull();
    expect(await auditsFor(id)).toEqual([]);                // and nothing claims it happened
  });

  it("requires the custodian capability, not merely module access", async () => {
    const id = await unscoped("NoCap");
    expect((await assign("plain", id, mediaCrew)).status).toBe(403);
    expect((await row(id)).scope_id).toBeNull();
  });

  it("turns away anonymous and non-media callers", async () => {
    const id = await unscoped("NoAuth");
    expect((await assign("anon", id, mediaCrew)).status).toBe(403);
    expect((await assign("outsider", id, mediaCrew)).status).toBe(403);
    expect((await row(id)).scope_id).toBeNull();
  });

  it("lets a custodian file into their OWN inventory", async () => {
    const id = await unscoped("OwnInv");
    expect((await assign("custMC", id, mediaCrew)).status).toBe(200);
    expect((await row(id)).internal_code).toMatch(/^MC-/);
  });

  it("refuses a custodian filing into somebody else's inventory", async () => {
    const id = await unscoped("CrossInv");
    const r = await assign("custMC", id, pid);
    expect(r.status).toBe(404);                             // an invented id answers the same
    expect((await row(id)).scope_id).toBeNull();
  });

  it("is safe when two administrators assign the same asset at once", async () => {
    const id = await unscoped("RaceAssign");
    const [x, y] = await Promise.all([
      assign("admin", id, mediaCrew),
      assign("custMC", id, mediaCrew),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const after = await row(id);
    expect(Number(after.scope_id)).toBe(mediaCrew);
    expect(after.internal_code).toMatch(/^MC-\d{4}$/);
    /* One assignment, one code, one audit — the loser claims nothing. */
    expect((await auditsFor(id)).length).toBe(1);
  });

  it("two assets assigned at once never share a code", async () => {
    const ids = await Promise.all([unscoped("R1"), unscoped("R2"), unscoped("R3"), unscoped("R4")]);
    const out = await Promise.all(ids.map((i) => assign("admin", i, pid)));
    expect(out.every((r) => r.status === 200)).toBe(true);
    const codes = await Promise.all(ids.map(async (i) => (await row(i)).internal_code));
    expect(new Set(codes).size).toBe(4);
  });

  it("leaves no orphan code behind when it refuses", async () => {
    /* Every refusal above is re-checked from one place: nothing in the
       inventory's numbering was consumed by a failure.

       COUNTED WITHIN THIS SUITE'S OWN CATEGORIES. Media Crew is shared, and a
       sibling suite registering — or cleaning up — between the two reads moves
       a global count for reasons that have nothing to do with the refusal being
       tested. That is how this failed: the number went DOWN, which no refusal
       could have caused. TEST_STABILITY entry 17. */
    const coded = () => countMine(`scope_id = $2 AND internal_code IS NOT NULL`, [mediaCrew]);
    const before = await coded();
    const id = await unscoped("Orphan");
    await pool.query(`UPDATE mo_equipment_items SET retired_at=NOW() WHERE id=$1`, [id]);
    await assign("admin", id, mediaCrew);
    expect(await coded(), "a refused assignment consumed a code").toBe(before);
  });

  it("does not move an asset the caller cannot see", async () => {
    const made = await mk("admin", { scope_id: pid, model: "Hidden17c" });
    const id = Number((made.body.item as unknown as { id: number }).id);
    expect((await assign("custMC", id, mediaCrew)).status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17D — verification.

   Two populations, and the whole phase turns on keeping them apart. New and
   imported records travel draft → pending → active/rejected. The 32 assets
   already in the estate are ACTIVE and must stay exactly where they are: no
   transition out of 'active' exists, so introducing verification cannot make
   a working camera disappear from the catalogue.

   Verification answers "has this record been reviewed", never "is this asset
   available". A camera can be pending verification and checked out at once.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("verification", () => {
  const verify = (actor: ActorName | "anon", id: number, action: string, reason?: string) =>
    as(actor, "POST", `/equipment/${id}/verification`, { action, ...(reason ? { reason } : {}) });
  const vstate = async (id: number) => (await pool.query(
    `SELECT verification_state, verification_note FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
  /** An imported record, as the future importer will create it. */
  const draft = async (model: string, scopeId: number | null = mediaCrew) => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, verification_state)
     VALUES ($1,$2,'ZIF',$3,$4,'draft') RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-V${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
     model, scopeId])).rows[0].id);

  it("registers an asset as ACTIVE, exactly as it always has", async () => {
    /* The Add-item screen is untouched by this phase. An asset created through
       it is inventory the moment it exists, and appears in the catalogue. */
    const made = await mk("admin", { scope_id: mediaCrew, model: "RegisteredNormally" });
    expect((made.body.item as unknown as { verification_state: string }).verification_state).toBe("active");
  });

  it("lets a caller STAGE a draft, and never lets one claim it is verified", async () => {
    /* 'draft' makes a record less trusted, which is the only direction a client
       may push. Every other value is a claim only a reviewer may make. */
    const staged = await mk("admin", { scope_id: mediaCrew, model: "Staged", verification_state: "draft" });
    expect(staged.status).toBe(201);
    expect((staged.body.item as unknown as { verification_state: string }).verification_state).toBe("draft");
    for (const bad of ["active", "pending_verification", "rejected", "approved"]) {
      const r = await mk("admin", { scope_id: mediaCrew, model: `Claimed${bad}`, verification_state: bad });
      expect(r.status, bad).toBe(400);
    }
  });

  it("still mints the identity for a staged draft", async () => {
    /* Staging is about trust, not identity: the code is allocated on creation
       as it is for any scoped asset, so a draft is not a second class of row. */
    const staged = await mk("admin", { scope_id: pid, model: "StagedCoded", verification_state: "draft" });
    const item = staged.body.item as unknown as { internal_code: string; asset_tag: string };
    expect(item.internal_code).toMatch(/^PID-\d{4}$/);
    expect(item.asset_tag).toBeTruthy();
  });

  it("walks draft → pending → active", async () => {
    const id = await draft("Walk");
    expect((await verify("admin", id, "submit")).status).toBe(200);
    expect((await vstate(id)).verification_state).toBe("pending_verification");
    expect((await verify("admin", id, "approve")).status).toBe(200);
    expect((await vstate(id)).verification_state).toBe("active");
  });

  it("rejects with a reason, and returns to draft", async () => {
    const id = await draft("Rejectable");
    await verify("admin", id, "submit");
    const r = await verify("admin", id, "reject", "Manufacturer serial does not match the physical asset.");
    expect(r.status).toBe(200);
    const after = await vstate(id);
    expect(after.verification_state).toBe("rejected");
    expect(after.verification_note).toMatch(/does not match/);

    expect((await verify("admin", id, "return_to_draft")).status).toBe(200);
    const back = await vstate(id);
    expect(back.verification_state).toBe("draft");
    /* The stale explanation does not outlive the rejection. */
    expect(back.verification_note).toBeNull();
  });

  it("will not reject without a reason", async () => {
    const id = await draft("NoReason");
    await verify("admin", id, "submit");
    expect((await verify("admin", id, "reject")).status).toBe(400);
    expect((await verify("admin", id, "reject", "   ")).status).toBe(400);
    expect((await vstate(id)).verification_state).toBe("pending_verification");
  });

  it("refuses a rejection with no reason at the database too", async () => {
    const id = await draft("DbReason");
    await expect(pool.query(
      `UPDATE mo_equipment_items SET verification_state='rejected' WHERE id=$1`, [id])).rejects.toThrow();
  });

  it("refuses every transition that is not on the matrix", async () => {
    const id = await draft("Illegal");
    expect((await verify("admin", id, "approve")).status).toBe(409);       // draft → active
    expect((await verify("admin", id, "reject", "x")).status).toBe(409);   // draft → rejected
    expect((await verify("admin", id, "return_to_draft")).status).toBe(409);
    expect((await verify("admin", id, "activate")).status).toBe(400);      // not an action at all
    expect((await vstate(id)).verification_state).toBe("draft");
  });

  it("NEVER moves an asset out of active — the estate cannot be pulled back", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "LiveAsset" });
    const id = Number((made.body.item as unknown as { id: number }).id);
    for (const a of ["submit", "approve", "return_to_draft"]) {
      const r = await verify("admin", id, a);
      expect([400, 409]).toContain(r.status);
    }
    expect((await verify("admin", id, "reject", "nope")).status).toBe(409);
    expect((await vstate(id)).verification_state).toBe("active");
  });

  it("cannot be driven by a generic asset edit", async () => {
    const id = await draft("NoPatch");
    await as("admin", "PATCH", `/equipment/${id}`, { verification_state: "active", verification_note: "x" });
    expect((await vstate(id)).verification_state).toBe("draft");
  });

  it("changes nothing about the asset's identity", async () => {
    const made = await mk("admin", { scope_id: pid, model: "Identity",
      serial_no: `${PX}-VSER`, tracking_mode: "pooled", pool_quantity: 12 });
    const id = Number((made.body.item as unknown as { id: number }).id);
    const before = (await pool.query(
      `SELECT internal_code, serial_no, pool_quantity, scope_id FROM mo_equipment_items WHERE id=$1`,
      [id])).rows[0];
    await pool.query(`UPDATE mo_equipment_items SET verification_state='draft' WHERE id=$1`, [id]);
    await verify("admin", id, "submit");
    await verify("admin", id, "approve");
    const after = (await pool.query(
      `SELECT internal_code, serial_no, pool_quantity, scope_id FROM mo_equipment_items WHERE id=$1`,
      [id])).rows[0];
    expect(after).toEqual(before);        // code, serial, quantity and inventory all untouched
  });

  it("does not derive from operational status, nor drive it", async () => {
    /* Two independent columns. Submitting a record for review does not put it
       in a cupboard, and a record being out on a shoot does not review it. The
       one thing verification DOES decide is whether a record may enter
       circulation at all, which is the next three tests. */
    const id = await draft("PendingButOut");
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [id]);
    await verify("admin", id, "submit");
    const row = (await pool.query(
      `SELECT status, verification_state FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
    expect(row.status).toBe("checked_out");
    expect(row.verification_state).toBe("pending_verification");
  });

  it("will not let an unverified record be checked out or booked", async () => {
    const id = await draft("NotCirculatable");
    const out = await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
    expect(out.status).toBe(409);
    expect(String(out.body.error ?? out.body.message)).toMatch(/not part of the inventory yet/i);
    const book = await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2030-01-01", ends_at: "2030-01-02" });
    expect(book.status).toBe(409);
  });

  it("opens circulation the moment the record is approved", async () => {
    const id = await draft("BecomesReal");
    await verify("admin", id, "submit");
    await verify("admin", id, "approve");
    expect((await as("admin", "POST", `/equipment/${id}/checkout`,
      { user_id: A.admin.id, expected_return_at: DUE })).status).toBe(201);
  });

  it("always lets an issued asset come back, whatever its verification state", async () => {
    /* The gate is on the way IN. Blocking a return would strand equipment in
       somebody's bag because of a paperwork state. */
    const id = await draft("MustReturn");
    await verify("admin", id, "submit");
    await verify("admin", id, "approve");
    await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
    await pool.query(`UPDATE mo_equipment_items SET verification_state='draft' WHERE id=$1`, [id]);
    expect((await as("admin", "POST", `/equipment/${id}/checkin`, {})).status).toBe(201);
  });

  it("audits each move with the states either side", async () => {
    const id = await draft("AuditedV");
    await verify("admin", id, "submit");
    await verify("admin", id, "reject", "Serial mismatch.");
    const rows = (await pool.query(
      `SELECT action, before, after FROM mo_audit_logs
        WHERE entity_type='equipment_item' AND entity_id=$1 AND action LIKE 'equipment.verification_%'
        ORDER BY occurred_at`, [id])).rows;
    expect(rows.map((r) => r.action)).toEqual(
      ["equipment.verification_submitted", "equipment.verification_rejected"]);
    expect(rows[0].before).toEqual({ verification_state: "draft" });
    expect(rows[0].after).toEqual({ verification_state: "pending_verification" });
    expect((rows[1].after as Record<string, unknown>).reason).toBe("Serial mismatch.");
  });

  it("records the submitter and the approver as different actors", async () => {
    /* No self-approval RULE is implemented — that is an open product decision.
       What is guaranteed is that the trail can always tell them apart. */
    const id = await draft("TwoActors");
    await verify("custMC", id, "submit");
    await verify("admin", id, "approve");
    const rows = (await pool.query(
      `SELECT action, actor_id FROM mo_audit_logs
        WHERE entity_type='equipment_item' AND entity_id=$1 AND action LIKE 'equipment.verification_%'
        ORDER BY occurred_at`, [id])).rows;
    expect(rows[0].actor_id).toBe(A.custMC.id);
    expect(rows[1].actor_id).toBe(A.admin.id);
  });

  it("requires the custodian capability, and refuses strangers", async () => {
    const id = await draft("AuthV");
    expect((await verify("plain", id, "submit")).status).toBe(403);
    expect((await verify("anon", id, "submit")).status).toBe(403);
    expect((await verify("outsider", id, "submit")).status).toBe(403);
    expect((await vstate(id)).verification_state).toBe("draft");
  });

  it("does not let a custodian review another inventory's asset", async () => {
    const id = await draft("CrossV", pid);
    expect((await verify("custMC", id, "submit")).status).toBe(404);
    expect((await vstate(id)).verification_state).toBe("draft");
  });

  it("is safe when two reviewers act at once", async () => {
    const id = await draft("RaceV");
    await verify("admin", id, "submit");
    const [x, y] = await Promise.all([
      verify("admin", id, "approve"),
      verify("custMC", id, "reject", "Not the right camera."),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    const after = await vstate(id);
    expect(["active", "rejected"]).toContain(after.verification_state);
    const n = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs WHERE entity_id=$1
         AND action IN ('equipment.verification_approved','equipment.verification_rejected')`,
      [id])).rows[0].c);
    expect(n, "the loser wrote an audit claiming it acted").toBe(1);
  });
});

maybe("the review queue", () => {
  const draftIn = async (model: string, scopeId: number, state = "draft") => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, verification_state)
     VALUES ($1,$2,'ZIF',$3,$4,$5) RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-Q${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
     model, scopeId, state])).rows[0].id);

  it("lists what is waiting, with the inventory and who submitted it", async () => {
    const id = await draftIn("Queued", mediaCrew);
    await as("admin", "POST", `/equipment/${id}/verification`, { action: "submit" });
    const r = await as("admin", "GET", "/equipment/verification-queue");
    expect(r.status).toBe(200);
    const row = (r.body.items as unknown as Record<string, unknown>[]).find((x) => Number(x.id) === id)!;
    expect(row).toBeDefined();
    expect(row.inventory_name).toBe("Media Crew");
    expect(row.submitted_by).toBe(`ZIF ${A.admin.id}`);
    expect(row.verification_state).toBe("pending_verification");
  });

  it("does not show one inventory's queue to another's custodian", async () => {
    const mine = await draftIn("QMine", mediaCrew);
    const theirs = await draftIn("QTheirs", pid);
    for (const i of [mine, theirs])
      await as("admin", "POST", `/equipment/${i}/verification`, { action: "submit" });
    const ids = ((await as("custMC", "GET", "/equipment/verification-queue")).body
      .items as unknown as { id: number }[]).map((x) => Number(x.id));
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
  });

  it("shows drafts and rejections when asked, and pending by default", async () => {
    const d = await draftIn("QDraft", mediaCrew);
    const pendingIds = ((await as("admin", "GET", "/equipment/verification-queue")).body
      .items as unknown as { id: number }[]).map((x) => Number(x.id));
    expect(pendingIds).not.toContain(d);
    const draftIds = ((await as("admin", "GET", "/equipment/verification-queue?state=draft")).body
      .items as unknown as { id: number }[]).map((x) => Number(x.id));
    expect(draftIds).toContain(d);
  });

  it("is paginated and reports a total", async () => {
    for (let i = 0; i < 3; i++) await draftIn(`QPage${i}`, mediaCrew);
    const r = await as("admin", "GET", "/equipment/verification-queue?state=draft&limit=2&offset=0");
    expect((r.body.items as unknown as unknown[]).length).toBeLessThanOrEqual(2);
    expect(Number(r.body.total)).toBeGreaterThanOrEqual(3);
  });

  it("is refused to strangers", async () => {
    expect((await as("anon", "GET", "/equipment/verification-queue")).status).toBe(403);
    expect((await as("outsider", "GET", "/equipment/verification-queue")).status).toBe(403);
  });
});

maybe("the existing estate is untouched by verification", () => {
  it("keeps every already-active asset out of the queue", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "OperationalOne" });
    const id = Number((made.body.item as unknown as { id: number }).id);
    for (const st of ["pending_verification", "draft", "rejected"]) {
      const ids = ((await as("admin", "GET", `/equipment/verification-queue?state=${st}`)).body
        .items as unknown as { id: number }[]).map((x) => Number(x.id));
      expect(ids, `showed an active asset under ${st}`).not.toContain(id);
    }
  });

  it("leaves a checked-out active asset visible and operational", async () => {
    const made = await mk("admin", { scope_id: mediaCrew, model: "StillWorking" });
    const id = Number((made.body.item as unknown as { id: number }).id);
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [id]);
    const seen = await as("admin", "GET", "/equipment?q=StillWorking");
    expect((seen.body.items as unknown as { id: number }[]).map((x) => Number(x.id))).toContain(id);
    expect((await as("admin", "GET", `/equipment/${id}`)).status).toBe(200);
  });

  it("hides a draft from the operational catalogue without deleting it", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model, scope_id, verification_state)
       VALUES ($1,$2,'ZIF','HiddenDraft',$3,'draft') RETURNING id`,
      [categoryId, `EQ-${PX.toUpperCase()}-HD1`, mediaCrew])).rows[0].id);
    expect((await as("admin", "GET", "/equipment?q=HiddenDraft")).body.items).toEqual([]);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].c)).toBe(1);
  });
});
