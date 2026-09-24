// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Equipment. The first endpoint coverage this module has had.

   The audit found 983 tests in the repository and not one of them issuing a
   request to any of the six equipment endpoints. That is how five of the six
   came to be callable with the Equipment module revoked, how `holder_id` came
   to be whatever the browser said it was, and how a kiosk PIN pad that checked
   nothing survived to production.

   Real handlers, real database. Every fixture is prefixed `zeq` and removed
   afterwards. Nothing here writes an unscoped UPDATE: sibling suites run
   against the same database at the same time, and a statement without a
   prefix in its WHERE clause is how one test file breaks another.

   AUTO-3's notification fan-out is covered in equipment-rules.test.ts rather
   than here, deliberately. Exercising it end to end means running the global
   automation pass, which would write notification rows against every genuinely
   overdue loan in whatever database the suite is pointed at. The selection
   rule is pure and exhaustively unit-tested; what this file asserts is the
   part with teeth — that BR-7 actually refuses the checkout.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zeq";
let dbUp = false;
/* PHASE 17F — a loan needs an end date, and the date has to be one the SERVER
   will accept: in the future and inside the 30-day policy window. Captured from
   the database in beforeAll rather than written as a literal, because a literal
   is only valid until the calendar passes it — the previous fixture used
   '2026-12-01', which was fine when it was written and is now out of range. */
let DUE = "";
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0;

/* `admin` is a Nerve admin and bypasses module checks like every other module.
   `custodian` holds the equipment_custodian duty — the authority the browser's
   CAPS table always claimed and the server never read. `borrower` is an
   ordinary crew member. `nomodule` is on the crew with Equipment revoked, and
   `outsider` is not media crew at all. */
const A = {
  admin:     { id: `${PX}-admin`,  role: "admin", team: "media" },
  custodian: { id: `${PX}-cust`,   role: "user",  team: "media" },
  borrower:  { id: `${PX}-borr`,   role: "user",  team: "media" },
  borrower2: { id: `${PX}-borr2`,  role: "user",  team: "media" },
  nomodule:  { id: `${PX}-nomod`,  role: "user",  team: "media" },
  outsider:  { id: `${PX}-out`,    role: "user",  team: "branding" },
} as const;
type ActorName = keyof typeof A;

/* The connection comes from server/test-db.ts, which resolves it from
   TEST_DATABASE_URL or .env.test and REFUSES any database whose name does not
   mark it as a test database. This file used to read .env.local itself and
   assign the DEVELOPMENT url over the top of vitest's — seventeen siblings did
   the same — which is how the suite came to run against `nerve`. */
{
  const t = await connectTestDatabase();
  pool = t.pool;
  dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

/* THE DAY THE SERVER IS HAVING, not the day UTC is having.

   Every endpoint that compares a date against "now" does it as
   (NOW() AT TIME ZONE 'Asia/Kolkata')::date. A helper built on
   new Date().toISOString() returns the UTC day, and between 18:30 and 24:00
   UTC those are different days — so for five and a half hours every night
   "due today" meant "due yesterday" and the overdue assertions were off by
   one. Found when the clock crossed midnight IST mid-run.

   Shifting the instant by +05:30 and then taking its UTC calendar day gives
   the IST calendar day, which is the one the server will compare against. */
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
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZEQ ${a.id}` }
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

/** Register an asset through the real endpoint and return its id. */
async function newAsset(model = "Test Body"): Promise<number> {
  const r = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model });
  if (r.status !== 201) throw new Error(`fixture asset failed: ${r.status} ${JSON.stringify(r.body)}`);
  return Number((r.body.item as { id: number }).id);
}
/** The generated asset tag for an id — the catalog's link and search key. */
const tagOf = async (id: number) =>
  String((await pool.query(`SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].asset_tag);
const itemRow = async (id: number) =>
  (await pool.query(`SELECT * FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
const txCount = async (id: number) =>
  Number((await pool.query(
    `SELECT COUNT(*)::int c FROM mo_equipment_transactions WHERE equipment_item_id=$1`, [id])).rows[0].c);

async function cleanup() {
  /* Found by the residue it left: this used to select items by the in-memory
     categoryId, which is 0 on the way IN — so a run that was interrupted left
     items behind, the category delete below then failed on their foreign key,
     beforeAll threw, and all sixty tests SKIPPED. A skip reads as a pass in the
     summary line. The prefix is the only thing that survives a process, so the
     prefix is what cleanup keys on. */
  const ids = (await pool.query(
    `SELECT id FROM mo_equipment_items
      WHERE category_id=$1 OR asset_tag LIKE $2
         OR category_id IN (SELECT id FROM mo_equipment_categories WHERE name LIKE $3)`,
    [categoryId || -1, `EQ-${PX.toUpperCase()}-%`, `${PX} %`])).rows.map((r) => Number(r.id));
  if (ids.length) {
    await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_maintenance_records WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  /* Shoots and their project, from the boot-contract guard. */
  await pool.query(`DELETE FROM mo_equipment_bookings WHERE shoot_id IN
                      (SELECT id FROM mo_shoots WHERE title LIKE $1)`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_shoots WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_projects WHERE code LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_equipment_categories WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_kiosk_sessions WHERE user_id LIKE $1 OR opened_by LIKE $1`, [`${PX}-%`]);
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

  for (const a of Object.values(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZEQ ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  }
  /* Module access, explicitly, so the gate is being tested rather than a
     default: everyone gets Equipment except `nomodule`. */
  for (const a of [A.admin, A.custodian, A.borrower, A.borrower2])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZEQ','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE SET allowed_modules=EXCLUDED.allowed_modules`,
      [a.id, JSON.stringify(["home", "my-day", "equipment"])]);
  await pool.query(
    `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
     VALUES ($1,'ZEQ','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE SET allowed_modules=EXCLUDED.allowed_modules`,
    [A.nomodule.id, JSON.stringify(["home", "my-day"])]);

  const duty = (await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0];
  if (duty) await pool.query(
    `INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at) VALUES ($1,$2,CURRENT_DATE)
     ON CONFLICT DO NOTHING`, [A.custodian.id, duty.id]);

  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',9999) RETURNING id`, [`${PX} Camera`])).rows[0].id);

  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ══════════════════════════════════════════════════════════════════════════
   AUTH — the gate that five of six endpoints did not have.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("every equipment endpoint is gated", () => {
  let item = 0;
  beforeAll(async () => { item = await newAsset("Gate"); });

  const writes = () => [
    ["POST", "/equipment", { category_id: categoryId, make: "X" }],
    ["POST", "/equipment/bookings", { equipment_item_id: item, starts_at: "2026-11-01", ends_at: "2026-11-02" }],
    ["POST", `/equipment/${item}/checkout`, { expected_return_at: DUE }],
    ["POST", `/equipment/${item}/checkin`, {}],
    ["POST", `/equipment/${item}/damage`, { description: "x" }],
    ["PATCH", `/equipment/${item}`, { notes: "x" }],
    ["POST", `/equipment/${item}/retire`, {}],
    ["POST", `/equipment/${item}/status`, { status: "maintenance" }],
  ] as [string, string, unknown][];

  it("refuses an unauthenticated caller everywhere", async () => {
    for (const [m, p, b] of writes())
      expect((await as("anon", m, p, b)).status, `${m} ${p}`).toBe(403);
    expect((await as("anon", "GET", "/equipment")).status).toBe(403);
  });

  it("refuses somebody who is not media crew at all", async () => {
    for (const [m, p, b] of writes())
      expect((await as("outsider", m, p, b)).status, `${m} ${p}`).toBe(403);
  });

  /* THE BUG THIS PINS. Only POST /equipment checked the module. Revoking
     Equipment hid the sidebar entry and left booking, cancelling, checkout,
     check-in and damage completely callable. */
  it("refuses a crew member whose Equipment module was revoked", async () => {
    for (const [m, p, b] of writes()) {
      const r = await as("nomodule", m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
      expect(String(r.body.message), `${m} ${p}`).toMatch(/module/i);
    }
    expect((await as("nomodule", "GET", "/equipment")).status).toBe(403);
  });

  it("lets a crew member with the module read, and a custodian manage", async () => {
    expect((await as("borrower", "GET", "/equipment")).status).toBe(200);
    expect((await as("custodian", "PATCH", `/equipment/${item}`, { notes: "ok" })).status).toBe(200);
  });

  it("refuses an ordinary borrower the custodial actions", async () => {
    for (const [m, p, b] of [
      ["PATCH", `/equipment/${item}`, { notes: "no" }],
      ["POST", `/equipment/${item}/retire`, {}],
      ["POST", `/equipment/${item}/status`, { status: "maintenance" }],
      ["POST", `/equipment/${item}/damage`, { description: "no" }],
      ["POST", "/equipment", { category_id: categoryId, make: "no" }],
    ] as [string, string, unknown][]) {
      const r = await as("borrower", m, p, b);
      expect(r.status, `${m} ${p}`).toBe(403);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   CHECKOUT — including the forged holder.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("checkout", () => {
  it("checks an available item out to the caller", async () => {
    const id = await newAsset("Checkout OK");
    const r = await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    expect(r.status).toBe(201);
    expect((r.body.transaction as { holder_id: string }).holder_id).toBe(A.borrower.id);
    expect((await itemRow(id)).status).toBe("checked_out");
  });

  it("404s on an asset that does not exist", async () => {
    expect((await as("borrower", "POST", "/equipment/99999999/checkout", {})).status).toBe(404);
  });

  /* THE FORGED HOLDER. `toUid(b.holder_id) ?? u.id` meant any crew member
     could put a colleague's name on a camera they had taken themselves. */
  it("REFUSES an ordinary borrower naming somebody else as the holder", async () => {
    const id = await newAsset("Forge");
    const r = await as("borrower", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower2.id, expected_return_at: DUE });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toMatch(/custodian|admin/i);
    expect((await itemRow(id)).status).toBe("available");
    expect(await txCount(id)).toBe(0);
  });

  it("lets a CUSTODIAN hand an item to a named crew member", async () => {
    const id = await newAsset("Custodial handover");
    const r = await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower2.id, expected_return_at: DUE });
    expect(r.status).toBe(201);
    expect((r.body.transaction as { holder_id: string }).holder_id).toBe(A.borrower2.id);
    // and the trail records who actually pressed the button
    expect((r.body.transaction as { recorded_by: string }).recorded_by).toBe(A.custodian.id);
  });

  it("refuses even a custodian naming a holder who is not active media crew", async () => {
    const id = await newAsset("Ghost holder");
    for (const ghost of [`${PX}-does-not-exist`, A.outsider.id]) {
      const r = await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: ghost, expected_return_at: DUE });
      expect(r.status, ghost).toBe(400);
    }
    expect((await itemRow(id)).status).toBe("available");
  });

  it("refuses a second checkout of an item already out", async () => {
    const id = await newAsset("Double");
    expect((await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE })).status).toBe(201);
    const r = await as("borrower2", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/already checked out/i);
    expect(await txCount(id)).toBe(1);
  });

  it("refuses an unserviceable item — BR-7, on the server this time", async () => {
    for (const st of ["maintenance", "lost", "retired"]) {
      const id = await newAsset(`Unserviceable ${st}`);
      await pool.query(`UPDATE mo_equipment_items SET status=$2 WHERE id=$1`, [id, st]);
      const r = await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
      expect(r.status, st).toBe(409);
      expect(String(r.body.message), st).toMatch(/BR-7/);
    }
  });

  it("records the condition AT CHECKOUT, which is what BR-8 later compares", async () => {
    const id = await newAsset("Condition");
    await pool.query(`UPDATE mo_equipment_items SET condition='fair' WHERE id=$1`, [id]);
    const r = await as("borrower", "POST", `/equipment/${id}/checkout`, { condition_noted: "excellent", expected_return_at: DUE });
    // The client asked for 'excellent'; the server records what the item IS.
    expect((r.body.transaction as { condition_noted: string }).condition_noted).toBe("fair");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   BR-7 — the overdue block that lived only in the browser.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("BR-7 blocks a borrower who is sitting on an overdue item", () => {
  it("blocks at the configured threshold and lets them through again after returning it", async () => {
    const stale = await newAsset("Stale");
    expect((await as("borrower2", "POST", `/equipment/${stale}/checkout`, { expected_return_at: DUE })).status).toBe(201);
    // Backdate this loan's due date well past the 7-day block. Scoped to the
    // one fixture row, never a blanket UPDATE.
    await pool.query(
      `UPDATE mo_equipment_transactions SET expected_return_at = CURRENT_DATE - 9
        WHERE equipment_item_id=$1`, [stale]);

    const other = await newAsset("Blocked");
    const blocked = await as("borrower2", "POST", `/equipment/${other}/checkout`, { expected_return_at: DUE });
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.message)).toMatch(/BR-7/);
    expect(String(blocked.body.message)).toMatch(/blocked/i);

    // Somebody else is unaffected — the block is personal, not global.
    expect((await as("borrower", "POST", `/equipment/${other}/checkout`, { expected_return_at: DUE })).status).toBe(201);
    await as("borrower", "POST", `/equipment/${other}/checkin`, {});

    // Return the overdue item, and the borrower is free again.
    expect((await as("borrower2", "POST", `/equipment/${stale}/checkin`, {})).status).toBe(201);
    expect((await as("borrower2", "POST", `/equipment/${other}/checkout`, { expected_return_at: DUE })).status).toBe(201);
  });

  it("does not block a borrower whose loan is merely late, but not late enough", async () => {
    const id = await newAsset("Slightly late");
    expect((await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE })).status).toBe(201);
    await pool.query(
      `UPDATE mo_equipment_transactions SET expected_return_at = CURRENT_DATE - 2
        WHERE equipment_item_id=$1`, [id]);
    const other = await newAsset("Still allowed");
    expect((await as("borrower", "POST", `/equipment/${other}/checkout`, { expected_return_at: DUE })).status).toBe(201);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   CHECK-IN — and BR-8, once.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("check-in", () => {
  it("returns an item and names the person who actually held it", async () => {
    const id = await newAsset("Return");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    const r = await as("custodian", "POST", `/equipment/${id}/checkin`, { condition_noted: "good" });
    expect(r.status).toBe(201);
    /* The old handler wrote `holder_id: u.id`, so a custodian receiving gear
       back made the ledger say the CUSTODIAN had held it. */
    expect((r.body.transaction as { holder_id: string }).holder_id).toBe(A.borrower.id);
    expect((r.body.transaction as { recorded_by: string }).recorded_by).toBe(A.custodian.id);
    expect((await itemRow(id)).status).toBe("available");
  });

  it("refuses to 'return' an item that was never taken", async () => {
    const id = await newAsset("Never out");
    const r = await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    expect(r.status).toBe(409);
    expect(await txCount(id)).toBe(0);
  });

  it("refuses to return an item twice", async () => {
    const id = await newAsset("Twice");
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    expect((await as("borrower", "POST", `/equipment/${id}/checkin`, {})).status).toBe(201);
    expect((await as("borrower", "POST", `/equipment/${id}/checkin`, {})).status).toBe(409);
    expect(await txCount(id)).toBe(2);
  });

  it("refuses a bystander returning somebody else's loan", async () => {
    const id = await newAsset("Not yours");
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    const r = await as("borrower2", "POST", `/equipment/${id}/checkin`, {});
    expect(r.status).toBe(403);
    expect((await itemRow(id)).status).toBe("checked_out");
  });

  /* BR-8, which used to be two rules that disagreed. */
  it("opens a damage report when the condition DROPS", async () => {
    const id = await newAsset("Dropped");
    await pool.query(`UPDATE mo_equipment_items SET condition='excellent' WHERE id=$1`, [id]);
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    const r = await as("borrower", "POST", `/equipment/${id}/checkin`, { condition_noted: "good" });
    expect(r.body.damaged).toBe(true);
    expect((await itemRow(id)).status).toBe("maintenance");
    const rec = await pool.query(
      `SELECT * FROM mo_maintenance_records WHERE equipment_item_id=$1 AND kind='damage_report'`, [id]);
    expect(rec.rows).toHaveLength(1);
  });

  it("does NOT open one for an item returned exactly as it was lent", async () => {
    /* The server's old absolute rule opened a damage report here every time a
       well-used 'fair' item came back unchanged. */
    const id = await newAsset("Unchanged fair");
    await pool.query(`UPDATE mo_equipment_items SET condition='fair' WHERE id=$1`, [id]);
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    const r = await as("borrower", "POST", `/equipment/${id}/checkin`, { condition_noted: "fair" });
    expect(r.body.damaged).toBe(false);
    expect((await itemRow(id)).status).toBe("available");
    expect((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records WHERE equipment_item_id=$1`, [id])).rows[0].c).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   BOOKING — the one thing the module already did well.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("booking", () => {
  it("accepts a valid reservation", async () => {
    const id = await newAsset("Bookable");
    const r = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2026-11-02", ends_at: "2026-11-04" });
    expect(r.status).toBe(201);
  });

  /* AC-7 is a database EXCLUDE constraint, not a handler check — this asserts
     the constraint is doing the work. */
  it("refuses an overlapping reservation of the same item", async () => {
    const id = await newAsset("Contended");
    expect((await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2026-11-10", ends_at: "2026-11-14" })).status).toBe(201);
    const clash = await as("borrower2", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2026-11-12", ends_at: "2026-11-16" });
    expect(clash.status).toBe(409);
    expect(String(clash.body.message)).toMatch(/AC-7/);
  });

  it("allows the same window once the first reservation is cancelled", async () => {
    const id = await newAsset("Freed");
    const first = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2026-12-10", ends_at: "2026-12-12" });
    const bid = (first.body.booking as { id: number }).id;
    expect((await as("borrower", "POST", `/equipment/bookings/${bid}/cancel`, {})).status).toBe(200);
    expect((await as("borrower2", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2026-12-10", ends_at: "2026-12-12" })).status).toBe(201);
  });

  it("enforces VR-8's 30-day cap and rejects a backwards window", async () => {
    const id = await newAsset("Long");
    expect((await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2027-01-01", ends_at: "2027-03-01" })).status).toBe(400);
    expect((await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2027-01-05", ends_at: "2027-01-01" })).status).toBe(400);
  });

  it("refuses to book an item that is never coming back", async () => {
    /* PHASE 17G, D-5 — retired and lost are the end of the line, so a
       reservation for one is a promise nobody can keep. */
    for (const dead of ["retired", "lost"]) {
      const id = await newAsset(`Dead ${dead}`);
      await pool.query(`UPDATE mo_equipment_items SET status=$2 WHERE id=$1`, [id, dead]);
      const r = await as("borrower", "POST", "/equipment/bookings",
        { equipment_item_id: id, starts_at: "2027-02-01", ends_at: "2027-02-02" });
      expect(r.status, dead).toBe(409);
    }
  });

  it("ALLOWS a future reservation on an item that is in for repair", async () => {
    /* RESERVATION IS NOT CUSTODY (D-5). A camera in for repair today can be
       spoken for at the end of the month; refusing that would make the calendar
       less useful than the whiteboard it replaced. Checkout stays blocked until
       the asset is circulatable again — that rule lives in 17F and is unchanged. */
    const id = await newAsset("Repairable");
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    const r = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2027-02-01", ends_at: "2027-02-02" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    /* And the counter still refuses to hand it over. */
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE })).status).toBe(409);
  });

  /* The IDOR: cancel took any id from any caller and answered {ok:true}. */
  it("refuses to cancel somebody else's booking, and 404s an unknown one", async () => {
    const id = await newAsset("Mine");
    const mk = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2027-04-01", ends_at: "2027-04-02" });
    const bid = (mk.body.booking as { id: number }).id;

    const r = await as("borrower2", "POST", `/equipment/bookings/${bid}/cancel`, {});
    expect(r.status).toBe(403);
    expect((await pool.query(
      `SELECT status FROM mo_equipment_bookings WHERE id=$1`, [bid])).rows[0].status).toBe("reserved");

    expect((await as("borrower", "POST", "/equipment/bookings/99999999/cancel", {})).status).toBe(404);
    // A custodian may cancel on somebody's behalf.
    expect((await as("custodian", "POST", `/equipment/bookings/${bid}/cancel`, {})).status).toBe(200);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   IDENTIFIERS AND QR.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("asset identity", () => {
  it("gives a new asset an opaque QR token that is not derived from its tag", async () => {
    const r = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Ident" });
    const token = String(r.body.asset_uid);
    const tag = String(r.body.asset_tag);
    expect(token).toMatch(/^AT-[0-9A-F]{32}$/);
    // The old value was literally 'QR-' + tag.
    expect(token).not.toContain(tag);
    expect(token).not.toBe(`QR-${tag}`);
  });

  it("gives different assets different identifiers", async () => {
    const a = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "U1" });
    const b = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "U2" });
    expect(a.body.asset_uid).not.toBe(b.body.asset_uid);
    expect(a.body.asset_tag).not.toBe(b.body.asset_tag);
  });

  it("resolves a token to exactly one asset", async () => {
    const mk = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Resolve" });
    const token = String(mk.body.asset_uid);
    const r = await as("borrower", "GET", `/equipment/resolve/${token}`);
    expect(r.status).toBe(200);
    expect(Number((r.body.item as { id: number }).id)).toBe(Number((mk.body.item as { id: number }).id));
  });

  it("resolves the human asset tag too, so a worn label still works", async () => {
    const mk = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "ByTag" });
    const r = await as("borrower", "GET", `/equipment/resolve/${String(mk.body.asset_tag)}`);
    expect(r.status).toBe(200);
    expect(Number((r.body.item as { id: number }).id)).toBe(Number((mk.body.item as { id: number }).id));
  });

  it("404s an identifier nobody carries", async () => {
    expect((await as("borrower", "GET", "/equipment/resolve/AT-NOTHING")).status).toBe(404);
  });

  /* The whole point of an identifier: it outlives the asset's state. */
  it("keeps resolving after the holder, status and condition all change", async () => {
    const mk = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Durable" });
    const id = Number((mk.body.item as { id: number }).id);
    const token = String(mk.body.asset_uid);

    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, { condition_noted: "poor" });
    await as("custodian", "PATCH", `/equipment/${id}`, { notes: "moved", model: "Renamed" });

    const r = await as("borrower", "GET", `/equipment/resolve/${token}`);
    expect(r.status).toBe(200);
    expect(Number((r.body.item as { id: number }).id)).toBe(id);
  });

  it("refuses to give one asset an identifier another already carries", async () => {
    const a = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Dup1" });
    const b = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Dup2" });
    const bid = Number((b.body.item as { id: number }).id);
    const r = await as("custodian", "POST", `/equipment/${bid}/identifiers`,
      { kind: "qr", value: String(a.body.asset_uid) });
    expect(r.status).toBe(409);
  });

  it("accepts an RFID identifier today, with no schema change — Phase 3's whole claim", async () => {
    const mk = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Rfid" });
    const id = Number((mk.body.item as { id: number }).id);
    const r = await as("custodian", "POST", `/equipment/${id}/identifiers`,
      { kind: "rfid", value: `${PX}-EPC-0001`, is_primary: true });
    expect(r.status).toBe(201);
    const back = await as("borrower", "GET", `/equipment/resolve/${PX}-EPC-0001`);
    expect(back.status).toBe(200);
    expect(Number((back.body.item as { id: number }).id)).toBe(id);
  });

  it("serves a real QR label, not a decorative grid", async () => {
    const mk = await as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: "Label" });
    const id = Number((mk.body.item as { id: number }).id);
    const r = await as("custodian", "GET", `/equipment/${id}/qr`);
    expect(r.status).toBe(200);
    expect(String(r.body.svg)).toContain("<svg");
    expect(String(r.body.token)).toBe(String(mk.body.asset_uid));
    /* Deterministic: the same asset always prints the same label. */
    const again = await as("custodian", "GET", `/equipment/${id}/qr`);
    expect(String(again.body.svg)).toBe(String(r.body.svg));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   DEPARTMENT-WIDE HISTORY — the two read models that replaced the /state
   arrays. The Transactions and Maintenance tabs hold one page each; if the
   server stops honouring a parameter the browser has no array to fall back on.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("the transaction read model", () => {
  let asset = 0, other = 0;

  beforeAll(async () => {
    /* Two assets with real ledger rows, written through the real endpoints so
       the history under test is the history the product produces. */
    asset = await newAsset("Ledger A");
    other = await newAsset("Ledger B");
    for (let i = 0; i < 3; i++) {
      await as("borrower", "POST", `/equipment/${asset}/checkout`, { expected_return_at: DUE });
      await as("borrower", "POST", `/equipment/${asset}/checkin`, {});
    }
    await as("borrower2", "POST", `/equipment/${other}/checkout`, { expected_return_at: DUE });
  });

  it("pages, newest first, and never returns the whole table", async () => {
    const r = await as("borrower", "GET", "/equipment/transactions?limit=3");
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBeLessThanOrEqual(3);
    expect(Number(r.body.limit)).toBe(3);
    expect(Number(r.body.total)).toBeGreaterThanOrEqual(7);
    const when = (r.body.items as { occurred_at: string }[]).map((x) => x.occurred_at);
    expect([...when].sort().reverse()).toEqual(when);      // newest first

    const p2 = await as("borrower", "GET", "/equipment/transactions?limit=3&offset=3");
    const ids = (x: typeof r) => (x.body.items as { id: number }[]).map((i) => Number(i.id));
    expect(ids(p2).some((i) => ids(r).includes(i)), "pages overlapped").toBe(false);
  });

  it("clamps a nonsense page", async () => {
    expect(Number((await as("borrower", "GET", "/equipment/transactions?limit=99999")).body.limit)).toBe(200);
    const neg = await as("borrower", "GET", "/equipment/transactions?limit=-4&offset=-9");
    expect(Number(neg.body.limit)).toBeGreaterThanOrEqual(1);
    expect(Number(neg.body.offset)).toBe(0);
  });

  it("filters by asset, holder and action", async () => {
    const mine = await as("borrower", "GET", `/equipment/transactions?asset_id=${asset}&limit=200`);
    for (const t of mine.body.items as { equipment_item_id: number }[])
      expect(Number(t.equipment_item_id)).toBe(asset);
    expect(Number(mine.body.total)).toBe(6);              // three loans, two rows each

    const byHolder = await as("borrower", "GET",
      `/equipment/transactions?holder_id=${A.borrower2.id}&limit=200`);
    for (const t of byHolder.body.items as { holder_id: string }[])
      expect(t.holder_id).toBe(A.borrower2.id);

    const outs = await as("borrower", "GET",
      `/equipment/transactions?asset_id=${asset}&action=check_out&limit=200`);
    expect(Number(outs.body.total)).toBe(3);
    for (const t of outs.body.items as { action: string }[]) expect(t.action).toBe("check_out");
  });

  it("filters by a date range on the day the ledger records", async () => {
    const today = istDay();
    const hit = await as("borrower", "GET",
      `/equipment/transactions?asset_id=${asset}&from=${today}&to=${today}&limit=200`);
    expect(Number(hit.body.total)).toBe(6);
    const miss = await as("borrower", "GET",
      `/equipment/transactions?asset_id=${asset}&from=2000-01-01&to=2000-01-02&limit=200`);
    expect(Number(miss.body.total)).toBe(0);
    expect(miss.body.items).toEqual([]);
  });

  it("filters by the department the asset belongs to", async () => {
    const dept = (await pool.query(
      `SELECT department_id FROM mo_equipment_items WHERE id=$1`, [asset])).rows[0].department_id;
    const inDept = await as("borrower", "GET",
      `/equipment/transactions?department_id=${dept ?? 1}&limit=200`);
    expect(inDept.status).toBe(200);
    const nowhere = await as("borrower", "GET", "/equipment/transactions?department_id=999999&limit=200");
    expect(Number(nowhere.body.total)).toBe(0);
  });

  it("carries the columns the ledger table draws, and nothing heavier", async () => {
    const t = (await as("borrower", "GET",
      `/equipment/transactions?asset_id=${asset}&limit=1`)).body.items as Record<string, unknown>[];
    for (const f of ["occurred_at", "action", "holder_id", "holder_name", "condition_noted",
                     "expected_return_at", "recorded_via", "recorded_by_name", "asset_tag", "make", "model"])
      expect(t[0], `the ledger row is missing ${f}`).toHaveProperty(f);
    for (const heavy of ["item", "maintenance", "bookings", "identifiers"])
      expect(t[0], `a ledger row carried ${heavy}`).not.toHaveProperty(heavy);
  });

  it("is refused without the Equipment module", async () => {
    expect((await as("nomodule", "GET", "/equipment/transactions?limit=1")).status).toBe(403);
    expect((await as("outsider", "GET", "/equipment/transactions?limit=1")).status).toBe(403);
    expect((await as("anon", "GET", "/equipment/transactions?limit=1")).status).toBe(403);
  });
});

maybe("the maintenance read model", () => {
  let asset = 0;

  beforeAll(async () => {
    asset = await newAsset("Maintenance A");
    for (const kind of ["damage_report", "repair", "maintenance"])
      await as("custodian", "POST", `/equipment/${asset}/damage`, { kind, description: `${PX} ${kind}` });
    // One of them resolved, so open/resolved can be told apart.
    await pool.query(
      `UPDATE mo_maintenance_records SET resolved_at=CURRENT_DATE, cost=2500
        WHERE equipment_item_id=$1 AND kind='repair'`, [asset]);
  });

  it("pages, newest first, and never returns the whole table", async () => {
    const r = await as("borrower", "GET", "/equipment/maintenance?limit=2");
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBeLessThanOrEqual(2);
    expect(Number(r.body.limit)).toBe(2);
    expect(Number(r.body.total)).toBeGreaterThanOrEqual(3);
  });

  it("filters by asset and by kind", async () => {
    const mine = await as("borrower", "GET", `/equipment/maintenance?asset_id=${asset}&limit=200`);
    expect(Number(mine.body.total)).toBe(3);
    const dmg = await as("borrower", "GET",
      `/equipment/maintenance?asset_id=${asset}&kind=damage_report&limit=200`);
    expect(Number(dmg.body.total)).toBe(1);
    for (const m of dmg.body.items as { kind: string }[]) expect(m.kind).toBe("damage_report");
  });

  /* Status is DERIVED from resolved_at — the shape the table already has. */
  it("tells open from resolved without a status column", async () => {
    const open = await as("borrower", "GET", `/equipment/maintenance?asset_id=${asset}&status=open&limit=200`);
    expect(Number(open.body.total)).toBe(2);
    for (const m of open.body.items as { resolved_at: string | null }[]) expect(m.resolved_at).toBeNull();
    const done = await as("borrower", "GET", `/equipment/maintenance?asset_id=${asset}&status=resolved&limit=200`);
    expect(Number(done.body.total)).toBe(1);
    for (const m of done.body.items as { resolved_at: string | null }[]) expect(m.resolved_at).not.toBeNull();
  });

  it("filters by date range and by department", async () => {
    const today = istDay();
    expect(Number((await as("borrower", "GET",
      `/equipment/maintenance?asset_id=${asset}&from=${today}&to=${today}&limit=200`)).body.total)).toBe(3);
    expect(Number((await as("borrower", "GET",
      `/equipment/maintenance?asset_id=${asset}&from=2000-01-01&to=2000-01-02&limit=200`)).body.total)).toBe(0);
    expect(Number((await as("borrower", "GET",
      "/equipment/maintenance?department_id=999999&limit=200")).body.total)).toBe(0);
  });

  it("returns the tab's own figures only when asked", async () => {
    const plain = await as("borrower", "GET", `/equipment/maintenance?asset_id=${asset}&limit=1`);
    expect(plain.body.summary).toBeUndefined();
    const s = await as("borrower", "GET", `/equipment/maintenance?asset_id=${asset}&limit=1&summary=1`);
    const sum = s.body.summary as Record<string, number>;
    expect(sum.total).toBe(3);
    expect(sum.open).toBe(2);
    expect(sum.resolved).toBe(1);
    expect(sum.cost).toBe(2500);                 // the one resolved record's cost
  });

  it("carries the columns the maintenance table draws", async () => {
    const m = (await as("borrower", "GET",
      `/equipment/maintenance?asset_id=${asset}&limit=1`)).body.items as Record<string, unknown>[];
    for (const f of ["kind", "description", "cost", "vendor_name", "started_at",
                     "resolved_at", "next_due_at", "asset_tag", "make", "model"])
      expect(m[0], `the maintenance row is missing ${f}`).toHaveProperty(f);
  });

  it("is refused without the Equipment module", async () => {
    expect((await as("nomodule", "GET", "/equipment/maintenance?limit=1")).status).toBe(403);
    expect((await as("outsider", "GET", "/equipment/maintenance?limit=1")).status).toBe(403);
    expect((await as("anon", "GET", "/equipment/maintenance?limit=1")).status).toBe(403);
  });
});

/* Step 5: opening ONE asset must not pull the department's history. */
maybe("an asset's own history stays its own", () => {
  it("returns only that asset's transactions and maintenance, bounded", async () => {
    const mine = await newAsset("Own history");
    const noise = await newAsset("Somebody else's");
    await as("borrower", "POST", `/equipment/${mine}/checkout`, { expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${mine}/checkin`, {});
    await as("borrower", "POST", `/equipment/${noise}/checkout`, { expected_return_at: DUE });
    await as("custodian", "POST", `/equipment/${mine}/damage`, { description: `${PX} own` });

    const d = await as("borrower", "GET", `/equipment/${mine}`);
    for (const t of d.body.transactions as { equipment_item_id: number }[])
      expect(Number(t.equipment_item_id)).toBe(mine);
    for (const m of d.body.maintenance as { equipment_item_id: number }[])
      expect(Number(m.equipment_item_id)).toBe(mine);
    expect((d.body.transactions as unknown[]).length).toBeLessThanOrEqual(50);
    expect((d.body.maintenance as unknown[]).length).toBeLessThanOrEqual(50);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   KIOSK.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("the kiosk", () => {
  const PIN = "8317";
  /* Failed attempts accumulate and lock the PIN — that is the point of them.
     Tests asserting an ordinary refusal therefore reset the counter first, so
     they are testing the refusal and not the previous test's lockout. */
  const unlock = (id: string) => pool.query(
    `UPDATE mo_user_profiles SET kiosk_failed_attempts=0, kiosk_locked_until=NULL WHERE user_id=$1`, [id]);

  beforeAll(async () => {
    const r = await as("custodian", "POST", "/equipment/kiosk/pin", { user_id: A.borrower.id, pin: PIN });
    expect(r.status).toBe(200);
  });
  beforeEach(async () => { await unlock(A.borrower.id); });

  it("never stores or returns the PIN itself", async () => {
    const row = (await pool.query(
      `SELECT kiosk_pin_hash FROM mo_user_profiles WHERE user_id=$1`, [A.borrower.id])).rows[0];
    expect(row.kiosk_pin_hash).toBeTruthy();
    expect(String(row.kiosk_pin_hash)).not.toContain(PIN);
  });

  it("rejects a guessable PIN", async () => {
    for (const bad of ["1111", "1234", "123", "abcd"])
      expect((await as("borrower2", "POST", "/equipment/kiosk/pin", { pin: bad })).status, bad).toBe(400);
  });

  it("refuses an incorrect PIN", async () => {
    const r = await as("custodian", "POST", "/equipment/kiosk/session", { user_id: A.borrower.id, pin: "9999" });
    expect(r.status).toBe(401);
    expect(r.body.kiosk_token).toBeUndefined();
  });

  /* The original behaviour, pinned as a regression: ANY four digits opened it. */
  it("does not accept arbitrary four digits", async () => {
    for (const pin of ["0000", "4321", "7777", "5150"]) {
      await unlock(A.borrower.id);
      expect((await as("custodian", "POST", "/equipment/kiosk/session",
        { user_id: A.borrower.id, pin })).status, pin).toBe(401);
    }
  });

  it("says the same thing for an unknown person as for a wrong PIN", async () => {
    const unknown = await as("custodian", "POST", "/equipment/kiosk/session",
      { user_id: `${PX}-nobody`, pin: PIN });
    const wrong = await as("custodian", "POST", "/equipment/kiosk/session",
      { user_id: A.borrower.id, pin: "9998" });
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(wrong.body.message);
  });

  it("locks the PIN after repeated failures, then accepts it again once cleared", async () => {
    await as("custodian", "POST", "/equipment/kiosk/pin", { user_id: A.borrower2.id, pin: "5926" });
    let last = 0;
    for (let i = 0; i < 5; i++)
      last = (await as("custodian", "POST", "/equipment/kiosk/session",
        { user_id: A.borrower2.id, pin: "0001" })).status;
    expect(last).toBe(429);
    // Even the CORRECT pin is refused while locked.
    expect((await as("custodian", "POST", "/equipment/kiosk/session",
      { user_id: A.borrower2.id, pin: "5926" })).status).toBe(429);

    await pool.query(`UPDATE mo_user_profiles SET kiosk_locked_until=NULL WHERE user_id=$1`, [A.borrower2.id]);
    expect((await as("custodian", "POST", "/equipment/kiosk/session",
      { user_id: A.borrower2.id, pin: "5926" })).status).toBe(201);
  });

  it("opens a session on the right PIN and checks out to THAT person", async () => {
    const s = await as("custodian", "POST", "/equipment/kiosk/session", { user_id: A.borrower.id, pin: PIN });
    expect(s.status).toBe(201);
    const token = String(s.body.kiosk_token);

    const id = await newAsset("Kiosk");
    /* The signed-in session is the custodian's; the transaction must name the
       person who entered their own PIN, which is what the old kiosk got
       backwards. */
    const r = await as("custodian", "POST", `/equipment/${id}/checkout`,
      { kiosk_token: token, recorded_via: "kiosk", expected_return_at: DUE });
    expect(r.status).toBe(201);
    expect((r.body.transaction as { holder_id: string }).holder_id).toBe(A.borrower.id);
    expect((r.body.transaction as { recorded_via: string }).recorded_via).toBe("kiosk");
  });

  it("a kiosk token cannot name a different holder than the one that opened it", async () => {
    const s = await as("custodian", "POST", "/equipment/kiosk/session", { user_id: A.borrower.id, pin: PIN });
    const id = await newAsset("Kiosk override");
    const r = await as("custodian", "POST", `/equipment/${id}/checkout`,
      { kiosk_token: String(s.body.kiosk_token), holder_id: A.borrower2.id, expected_return_at: DUE });
    expect(r.status).toBe(201);
    expect((r.body.transaction as { holder_id: string }).holder_id).toBe(A.borrower.id);
  });

  it("refuses an invented or ended session token", async () => {
    const id = await newAsset("Bad token");
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { kiosk_token: "not-a-real-token", expected_return_at: DUE })).status).toBe(401);

    const s = await as("custodian", "POST", "/equipment/kiosk/session", { user_id: A.borrower.id, pin: PIN });
    const token = String(s.body.kiosk_token);
    await as("custodian", "POST", "/equipment/kiosk/session/end", { kiosk_token: token });
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`, { kiosk_token: token, expected_return_at: DUE })).status).toBe(401);
  });

  it("refuses an expired session token", async () => {
    const s = await as("custodian", "POST", "/equipment/kiosk/session", { user_id: A.borrower.id, pin: PIN });
    const token = String(s.body.kiosk_token);
    await pool.query(
      `UPDATE mo_kiosk_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id=$1`, [A.borrower.id]);
    const id = await newAsset("Expired");
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`, { kiosk_token: token, expected_return_at: DUE })).status).toBe(401);
  });

  it("will not let an ordinary borrower set somebody else's PIN", async () => {
    expect((await as("borrower", "POST", "/equipment/kiosk/pin",
      { user_id: A.borrower2.id, pin: "4816" })).status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   LIFECYCLE.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("asset lifecycle", () => {
  it("reads one asset, with its identifiers and history", async () => {
    const id = await newAsset("Detail");
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    const r = await as("borrower", "GET", `/equipment/${id}`);
    expect(r.status).toBe(200);
    expect((r.body.transactions as unknown[]).length).toBe(2);
    expect((r.body.identifiers as { kind: string }[]).map((x) => x.kind)).toContain("qr");
  });

  it("lists assets with pagination and filters", async () => {
    const r = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=3`);
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBeLessThanOrEqual(3);
    expect(Number(r.body.total)).toBeGreaterThan(0);
    const filtered = await as("borrower", "GET", `/equipment?category_id=${categoryId}&status=available&limit=200`);
    for (const it of filtered.body.items as { status: string }[]) expect(it.status).toBe("available");
  });

  /* ── The read model the catalog now depends on ──────────────────────────
     These are the parameters the Equipment registry sends on every keystroke,
     filter and page turn. The UI holds one page; if the server stops honouring
     one of these the browser has no array to fall back on. */

  it("pages: a first page, a second page, and a page size", async () => {
    const all = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=200`);
    const total = Number(all.body.total);
    expect(total).toBeGreaterThan(3);

    const p1 = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=2&offset=0`);
    const p2 = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=2&offset=2`);
    expect((p1.body.items as unknown[]).length).toBe(2);
    expect(Number(p1.body.total)).toBe(total);      // total is the whole match, not the page
    expect(Number(p1.body.limit)).toBe(2);
    expect(Number(p2.body.offset)).toBe(2);
    const ids = (r: typeof p1) => (r.body.items as { id: number }[]).map((x) => Number(x.id));
    expect(ids(p1).some((i) => ids(p2).includes(i)), "pages overlapped").toBe(false);
  });

  it("clamps a nonsense page rather than trusting it", async () => {
    const huge = await as("borrower", "GET", "/equipment?limit=99999");
    expect(Number(huge.body.limit)).toBe(200);              // capped
    const neg = await as("borrower", "GET", "/equipment?limit=-5&offset=-9");
    expect(Number(neg.body.limit)).toBeGreaterThanOrEqual(1);
    expect(Number(neg.body.offset)).toBe(0);
    const junk = await as("borrower", "GET", "/equipment?limit=abc&offset=abc");
    expect(junk.status).toBe(200);
    expect(Number(junk.body.offset)).toBe(0);
  });

  it("searches tag, make, model and serial on the server", async () => {
    const mk = await as("custodian", "POST", "/equipment",
      { category_id: categoryId, make: "ZEQ", model: "Findable Nine", serial_no: "SERIAL-NINE" });
    const tag = String(mk.body.asset_tag);
    for (const q of ["Findable Nine", "SERIAL-NINE", tag]) {
      const r = await as("borrower", "GET", `/equipment?q=${encodeURIComponent(q)}&limit=200`);
      expect((r.body.items as { asset_tag: string }[]).map((x) => x.asset_tag), q).toContain(tag);
    }
    const none = await as("borrower", "GET", "/equipment?q=zzz-no-such-asset-zzz");
    expect(none.status).toBe(200);
    expect(none.body.items).toEqual([]);
    expect(Number(none.body.total)).toBe(0);
  });

  it("filters by status and by category", async () => {
    const id = await newAsset("Filtered");
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    const m = await as("borrower", "GET", `/equipment?category_id=${categoryId}&status=maintenance&limit=200`);
    for (const it of m.body.items as { status: string }[]) expect(it.status).toBe("maintenance");
    expect((m.body.items as { id: number }[]).map((x) => Number(x.id))).toContain(id);

    const other = await as("borrower", "GET", `/equipment?category_id=999999&limit=200`);
    expect(other.body.items).toEqual([]);
  });

  /* The catalog draws a holder avatar per row. It used to get that from the
     transaction array in /state; a paginated list has no such array, so the
     holder rides on the row. */
  it("carries the current holder on the row, and only while the asset is out", async () => {
    const id = await newAsset("Holder on the row");
    const before = (await as("borrower", "GET", `/equipment?q=${await tagOf(id)}&limit=1`))
      .body.items as { holder_id: string | null }[];
    expect(before[0].holder_id).toBeNull();

    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    const after = (await as("borrower", "GET", `/equipment?q=${await tagOf(id)}&limit=1`))
      .body.items as { holder_id: string; holder_name: string; holder_due_at: string }[];
    expect(after[0].holder_id).toBe(A.borrower.id);
    expect(String(after[0].holder_name)).toContain("ZEQ");

    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    const back = (await as("borrower", "GET", `/equipment?q=${await tagOf(id)}&limit=1`))
      .body.items as { holder_id: string | null }[];
    expect(back[0].holder_id, "a returned asset still named a holder").toBeNull();
  });

  /* A list row must stay a list row. */
  it("attaches no history to a list row", async () => {
    const r = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=5`);
    for (const row of r.body.items as Record<string, unknown>[])
      for (const heavy of ["transactions", "bookings", "maintenance", "identifiers"])
        expect(row, `a list row carried ${heavy}`).not.toHaveProperty(heavy);
  });

  it("returns the header figures only when asked, over the same filters", async () => {
    const plain = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=1`);
    expect(plain.body.summary, "summary was sent unasked").toBeUndefined();

    const s = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=1&summary=1`);
    const sum = s.body.summary as Record<string, number>;
    expect(sum).toBeTruthy();
    expect(sum.total).toBe(Number(s.body.total));
    /* LIFECYCLE COUNTS PARTITION; `booked` DOES NOT.

       available / checked_out / maintenance are three values of one persisted
       column, so they cannot overlap and their sum cannot exceed the total
       (retired and lost make up the rest). `booked` is a RESERVATION count —
       an available asset with a booking next week is in both — so summing it
       with the others asserts nothing. It used to be summable only because it
       counted a lifecycle value the server never wrote, and was therefore
       always zero. */
    expect(sum.available + sum.checked_out + sum.maintenance)
      .toBeLessThanOrEqual(sum.total);
    expect(sum.booked).toBeLessThanOrEqual(sum.total);
    expect(typeof sum.book_value).toBe("number");
    expect(typeof sum.overdue).toBe("number");

    // Narrowing the filter narrows the figures with it.
    const narrowed = await as("borrower", "GET",
      `/equipment?category_id=${categoryId}&status=maintenance&limit=1&summary=1`);
    expect((narrowed.body.summary as Record<string, number>).total)
      .toBeLessThanOrEqual(sum.total);
  });

  it("serves the detail by asset tag as well as by id, so the catalog's URL works", async () => {
    const id = await newAsset("By tag");
    const tag = await tagOf(id);
    const byId = await as("borrower", "GET", `/equipment/${id}`);
    const byTag = await as("borrower", "GET", `/equipment/${tag}`);
    expect(byTag.status).toBe(200);
    expect(Number((byTag.body.item as { id: number }).id)).toBe(id);
    expect((byTag.body.item as { asset_tag: string }).asset_tag)
      .toBe((byId.body.item as { asset_tag: string }).asset_tag);
    expect(byTag.body).toHaveProperty("transactions");
    expect(byTag.body).toHaveProperty("identifiers");
    expect((await as("borrower", "GET", "/equipment/EQ-NOPE-999")).status).toBe(404);
  });

  it("refuses the read model to a caller without the module", async () => {
    expect((await as("nomodule", "GET", "/equipment?limit=1&summary=1")).status).toBe(403);
    expect((await as("anon", "GET", "/equipment?limit=1")).status).toBe(403);
    expect((await as("outsider", "GET", "/equipment?limit=1")).status).toBe(403);
  });

  it("updates metadata and records the change", async () => {
    const id = await newAsset("Editable");
    const r = await as("custodian", "PATCH", `/equipment/${id}`,
      { model: "Renamed", notes: "second body" });
    expect(r.status).toBe(200);
    expect((r.body.item as { model: string }).model).toBe("Renamed");
    const trail = await pool.query(
      `SELECT 1 FROM mo_audit_logs WHERE action='equipment.updated' AND entity_id=$1`, [id]);
    expect(trail.rows.length).toBeGreaterThan(0);
  });

  it("REFUSES to edit the condition, and says where condition comes from", async () => {
    /* PHASE 17I, D-6. A generic PATCH could set an asset to 'excellent' with no
       record of who decided that or why — and that judgement is exactly what
       BR-8 compares a return against. Refused out loud rather than dropped in
       silence, because a field that is quietly ignored is a screen that
       believes it saved something. */
    const id = await newAsset("NoCondEdit");
    const before = (await itemRow(id)).condition;
    const r = await as("custodian", "PATCH", `/equipment/${id}`, { condition: "poor" });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/check-in or an inspection/i);
    expect((await itemRow(id)).condition, "a PATCH changed the condition").toBe(before);
    /* And it does not smuggle through beside a legitimate field. */
    expect((await as("custodian", "PATCH", `/equipment/${id}`,
      { model: "Smuggled", condition: "poor" })).status).toBe(400);
    expect((await itemRow(id)).model).not.toBe("Smuggled");
  });

  it("rejects an invalid condition and an unknown category", async () => {
    const id = await newAsset("Validate");
    /* Condition is refused outright now (D-6), whatever its value. */
    expect((await as("custodian", "PATCH", `/equipment/${id}`, { condition: "mint" })).status).toBe(400);
    expect((await as("custodian", "PATCH", `/equipment/${id}`, { category_id: 99999999 })).status).toBe(400);
  });

  it("will not let a PATCH set status — that is a lifecycle move", async () => {
    const id = await newAsset("No status");
    await as("custodian", "PATCH", `/equipment/${id}`, { status: "retired" });
    expect((await itemRow(id)).status).toBe("available");
  });

  it("moves an asset in and out of maintenance, and refuses a nonsense move", async () => {
    const id = await newAsset("Transitions");
    expect((await as("custodian", "POST", `/equipment/${id}/status`, { status: "maintenance" })).status).toBe(200);
    expect((await as("custodian", "POST", `/equipment/${id}/status`, { status: "available" })).status).toBe(200);
    expect((await as("custodian", "POST", `/equipment/${id}/status`, { status: "checked_out" })).status).toBe(409);
  });

  /* RULE 11/12 — history must not disappear because an asset is retired. */
  it("retires an asset and keeps every transaction it ever had", async () => {
    const id = await newAsset("Retire me");
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    const before = await txCount(id);
    expect(before).toBe(2);

    const r = await as("custodian", "POST", `/equipment/${id}/retire`, { reason: "beyond repair" });
    expect(r.status).toBe(200);
    const row = await itemRow(id);
    expect(row.status).toBe("retired");
    expect(row.retired_at).toBeTruthy();
    expect(row.retired_reason).toBe("beyond repair");

    // The row is still there, and so is all of its history.
    expect(await txCount(id)).toBe(before);
    expect((await as("borrower", "GET", `/equipment/${id}`)).status).toBe(200);
  });

  it("refuses to retire an asset that is in somebody's hands", async () => {
    const id = await newAsset("Still out");
    await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    const r = await as("custodian", "POST", `/equipment/${id}/retire`, {});
    expect(r.status).toBe(409);
    expect((await itemRow(id)).status).toBe("checked_out");
  });

  it("treats retirement as final, and keeps a retired asset out of the default list", async () => {
    const id = await newAsset("Final");
    await as("custodian", "POST", `/equipment/${id}/retire`, {});
    expect((await as("custodian", "POST", `/equipment/${id}/status`, { status: "available" })).status).toBe(409);
    expect((await as("custodian", "PATCH", `/equipment/${id}`, { notes: "nope" })).status).toBe(409);
    expect((await as("borrower", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE })).status).toBe(409);

    const list = await as("borrower", "GET", `/equipment?category_id=${categoryId}&limit=200`);
    expect((list.body.items as { id: number }[]).some((x) => Number(x.id) === id)).toBe(false);
    const withRetired = await as("borrower", "GET",
      `/equipment?category_id=${categoryId}&limit=200&include_retired=1`);
    expect((withRetired.body.items as { id: number }[]).some((x) => Number(x.id) === id)).toBe(true);
  });

  it("releases future reservations when an asset is retired", async () => {
    const id = await newAsset("Retire with booking");
    const bk = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2027-06-01", ends_at: "2027-06-03" });
    await as("custodian", "POST", `/equipment/${id}/retire`, {});
    expect((await pool.query(`SELECT status FROM mo_equipment_bookings WHERE id=$1`,
      [(bk.body.booking as { id: number }).id])).rows[0].status).toBe("cancelled");
  });

  /* TWO defects live under this one test, and the second was found by it.

     THE TAG. It used to be COUNT(*) + 1, so two simultaneous registrations
     computed the same number and one died on the unique index.

     THE POOL. The handler then audited the new asset while still holding the
     transaction's client, and audit() writes through the shared pool — so each
     in-flight registration held one connection and asked for a second. With
     MORE CONCURRENT REQUESTS THAN THE POOL HAS CONNECTIONS, every one of them
     held the connection another needed and none could finish. The count below
     is deliberately double the pool the suite runs with (PG_POOL_MAX=6), so it
     is the deadlocking case rather than the borderline one: before the fix this
     hangs until the test times out, and no raised timeout would save it. */
  it("registers concurrent assets in one category without colliding on a tag", async () => {
    const CONCURRENCY = 12;
    const results = await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) =>
      as("custodian", "POST", "/equipment", { category_id: categoryId, make: "ZEQ", model: `Race ${i}` })));
    expect(results.every((r) => r.status === 201),
      `statuses: ${results.map((r) => r.status).join(",")}`).toBe(true);
    const tags = results.map((r) => String(r.body.asset_tag));
    expect(new Set(tags).size, "two registrations produced the same asset tag").toBe(tags.length);
    /* And every one of them is a complete asset: the transaction committed, and
       the audit that follows it outside the transaction ran too. */
    const ids = results.map((r) => Number((r.body.item as { id: number }).id));
    const audited = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs
        WHERE action='equipment.added' AND entity_id = ANY($1::bigint[])`, [ids])).rows[0].c);
    expect(audited, "an asset was created without its audit row").toBe(CONCURRENCY);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The rules the browser is told, so it stops deriving its own.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("the server publishes the policy", () => {
  it("serves the thresholds, and they are the ones the endpoints enforce", async () => {
    const r = await as("borrower", "GET", "/equipment/rules");
    expect(r.status).toBe(200);
    const o = r.body.overdue as { block_after_days: number; esc_tl_days: number };
    expect(o.block_after_days).toBe(7);
    expect(o.esc_tl_days).toBe(3);
    expect(Number(r.body.max_booking_days)).toBe(30);
  });

  it("tells each caller whether they may manage, so the UI need not guess", async () => {
    expect((await as("custodian", "GET", "/equipment/rules")).body.can_manage).toBe(true);
    expect((await as("borrower", "GET", "/equipment/rules")).body.can_manage).toBe(false);
    expect((await as("admin", "GET", "/equipment/rules")).body.can_manage).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   AVAILABILITY AND THE BOOKING READ MODEL (Phase 3).

   The question these answer — "what is free between these two dates?" — used
   to be answered in the browser, by scanning the booking array /state had
   shipped. The answers below come from the database, using the SAME overlap
   expression as the exclusion constraint, so "free" here and "accepted" at the
   INSERT are the same word.
   ══════════════════════════════════════════════════════════════════════════ */

/** Book an asset and return the booking id. Fails loudly: a fixture that did
    not book would make every assertion after it pass for the wrong reason. */
async function book(actor: ActorName, id: number, s: string, e: string): Promise<number> {
  const r = await as(actor, "POST", "/equipment/bookings",
    { equipment_item_id: id, starts_at: s, ends_at: e });
  if (r.status !== 201) throw new Error(`fixture booking failed: ${r.status} ${JSON.stringify(r.body)}`);
  return Number((r.body.booking as { id: number }).id);
}
type Avail = { id: number; available: boolean; blocked_by: string | null;
               bookings: Array<{ id: number; starts_at: string; ends_at: string; status: string }> };
/** Availability for ONE asset, which is how every test below scopes itself. */
async function avail(actor: ActorName, id: number, from: string, to: string, extra = "") {
  const r = await as(actor, "GET", `/equipment/availability?asset_id=${id}&from=${from}&to=${to}${extra}`);
  return { status: r.status, body: r.body,
           row: ((r.body.items ?? []) as Avail[])[0] };
}

maybe("availability asks the database, in the constraint's own terms", () => {
  it("calls a free asset free, and says nothing is holding it", async () => {
    const id = await newAsset("Av Free");
    const a = await avail("borrower", id, "2028-03-01", "2028-03-05");
    expect(a.status).toBe(200);
    expect(a.row.available).toBe(true);
    expect(a.row.blocked_by).toBeNull();
    expect(a.row.bookings).toEqual([]);
  });

  it("calls an overlapping window taken, and hands back what is holding it", async () => {
    const id = await newAsset("Av Taken");
    const bid = await book("borrower", id, "2028-04-10", "2028-04-14");
    const a = await avail("borrower2", id, "2028-04-12", "2028-04-16");
    expect(a.row.available).toBe(false);
    expect(a.row.blocked_by).toBe("booking");
    expect(a.row.bookings.map((b) => Number(b.id))).toEqual([bid]);
    /* The window it reports is the one that was booked — not a day either side
       of it. This is the assertion that fails if a DATE is read in UTC. */
    expect(a.row.bookings[0].starts_at).toBe("2028-04-10");
    expect(a.row.bookings[0].ends_at).toBe("2028-04-14");
  });

  /* THE BOUNDARY. daterange(starts_at, ends_at, '[]') is inclusive at BOTH
     ends, so a window that begins on the day another one ends is a conflict —
     and the first window that is not is the day after. The endpoint has to
     agree with the constraint here or it will call something free that the
     INSERT then refuses. */
  it("treats the last booked day as booked, and the day after as free", async () => {
    const id = await newAsset("Av Adjacent");
    await book("borrower", id, "2028-05-10", "2028-05-12");
    expect((await avail("borrower2", id, "2028-05-12", "2028-05-14")).row.available,
      "the end day is inclusive — the 12th is still taken").toBe(false);
    expect((await avail("borrower2", id, "2028-05-13", "2028-05-14")).row.available,
      "the day after the end is free").toBe(true);
    expect((await avail("borrower2", id, "2028-05-08", "2028-05-09")).row.available,
      "the day before the start is free").toBe(true);
  });

  /* And the constraint agrees, which is the point of asserting both. */
  it("agrees with the INSERT about that boundary", async () => {
    const id = await newAsset("Av Agrees");
    await book("borrower", id, "2028-06-10", "2028-06-12");
    expect((await as("borrower2", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2028-06-12", ends_at: "2028-06-14" })).status).toBe(409);
    expect((await as("borrower2", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2028-06-13", ends_at: "2028-06-14" })).status).toBe(201);
  });

  it("ignores a cancelled booking, exactly as the constraint does", async () => {
    const id = await newAsset("Av Cancelled");
    const bid = await book("borrower", id, "2028-07-10", "2028-07-14");
    expect((await avail("borrower2", id, "2028-07-11", "2028-07-12")).row.available).toBe(false);
    await as("borrower", "POST", `/equipment/bookings/${bid}/cancel`, {});
    const a = await avail("borrower2", id, "2028-07-11", "2028-07-12");
    expect(a.row.available).toBe(true);
    expect(a.row.bookings).toEqual([]);
  });

  it("ignores a completed booking, and one that is simply in the past", async () => {
    const id = await newAsset("Av History");
    const bid = await book("borrower", id, "2028-08-01", "2028-08-03");
    await pool.query(`UPDATE mo_equipment_bookings SET status='completed' WHERE id=$1`, [bid]);
    expect((await avail("borrower2", id, "2028-08-01", "2028-08-03")).row.available,
      "a completed booking is history, not a hold").toBe(true);

    await book("borrower", id, "2020-01-01", "2020-01-05");
    expect((await avail("borrower2", id, "2028-09-01", "2028-09-02")).row.available,
      "a booking from 2020 does not reach 2028").toBe(true);
  });

  it("handles a single-day window at both ends of the comparison", async () => {
    const id = await newAsset("Av Sameday");
    await book("borrower", id, "2028-10-05", "2028-10-05");
    expect((await avail("borrower2", id, "2028-10-05", "2028-10-05")).row.available).toBe(false);
    expect((await avail("borrower2", id, "2028-10-04", "2028-10-04")).row.available).toBe(true);
    expect((await avail("borrower2", id, "2028-10-06", "2028-10-06")).row.available).toBe(true);
  });

  /* A DATE IS A DAY. node-postgres hands a date column back as a JS Date at
     local midnight, and JSON renders it in UTC — so east of Greenwich every
     date used to arrive as the day before. This asserts the day survives the
     round trip through the API, whatever zone the process runs in. */
  it("returns dates as the day they are, not the instant they parse to", async () => {
    const id = await newAsset("Av Timezone");
    await book("borrower", id, "2028-11-02", "2028-11-04");
    const r = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&status=reserved`);
    const row = (r.body.items as Array<{ starts_at: string; ends_at: string }>)[0];
    expect(row.starts_at).toBe("2028-11-02");
    expect(row.ends_at).toBe("2028-11-04");
    expect(String(row.starts_at)).not.toMatch(/T|Z/);
    // And the same day on the asset's own detail page.
    const d = await as("borrower", "GET", `/equipment/${id}`);
    expect((d.body.bookings as Array<{ starts_at: string }>)[0].starts_at).toBe("2028-11-02");
  });

  it("blocks on the asset's own status, and says which", async () => {
    const id = await newAsset("Av Broken");
    await pool.query(`UPDATE mo_equipment_items SET status='retired' WHERE id=$1`, [id]);
    const a = await avail("borrower", id, "2028-12-01", "2028-12-02", "&include_retired=1");
    expect(a.row.available).toBe(false);
    expect(a.row.blocked_by).toBe("status");
  });

  it("reports an item in for repair as reservable, matching the booking endpoint", async () => {
    /* THE GRID AND THE ENDPOINT ANSWER FROM ONE RULE (Phase 17G). They used to
       disagree in both directions: the grid applied BR-7's unserviceable list
       and no verification check at all, so a draft asset was drawn as bookable
       and then refused at the POST. */
    const id = await newAsset("Av Repair");
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    expect((await avail("borrower", id, "2028-12-01", "2028-12-02")).row.available).toBe(true);
    expect((await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2028-12-01", ends_at: "2028-12-02" })).status).toBe(201);
  });

  it("reports an unverified asset as NOT reservable, matching the booking endpoint", async () => {
    const id = await newAsset("Av Draft");
    await pool.query(`UPDATE mo_equipment_items SET verification_state='draft' WHERE id=$1`, [id]);
    const a = await avail("borrower", id, "2028-12-05", "2028-12-06");
    expect(a.row.available, "the grid offered a draft the endpoint refuses").toBe(false);
    expect((await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2028-12-05", ends_at: "2028-12-06" })).status).toBe(409);
  });

  it("reports a pooled asset as NOT reservable, matching the booking endpoint", async () => {
    /* A name that does not CONTAIN a sibling's search term: this file also
       searches q=Av Pooled, and that filter is a substring match, so "Av
       PooledRes" widened it just as "Av Pooled" did. */
    const id = await newAsset("Av PoolBlock");
    await pool.query(
      `UPDATE mo_equipment_items SET tracking_mode='pooled', pool_quantity=48 WHERE id=$1`, [id]);
    expect((await avail("borrower", id, "2028-12-07", "2028-12-08")).row.available).toBe(false);
    const r = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: "2028-12-07", ends_at: "2028-12-08" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/pooled inventory/i);
  });

  it("does not block on checked_out, because a later window is still bookable", async () => {
    const id = await newAsset("Av Out");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    expect((await itemRow(id)).status).toBe("checked_out");
    expect((await avail("borrower2", id, "2029-02-01", "2029-02-02")).row.available).toBe(true);
  });

  it("filters by category, by department and by search", async () => {
    const id = await newAsset("Av Scoped");
    /* A real department: the column is a foreign key. Scoped with q= as well,
       so a sibling asset in the same department cannot widen the assertion. */
    await pool.query(`UPDATE mo_equipment_items SET department_id=3 WHERE id=$1`, [id]);
    const win = "from=2029-03-01&to=2029-03-02";
    const inCat = await as("borrower", "GET", `/equipment/availability?${win}&category_id=${categoryId}&q=Av Scoped`);
    expect((inCat.body.items as Avail[]).map((r) => Number(r.id))).toContain(id);
    const otherCat = await as("borrower", "GET", `/equipment/availability?${win}&category_id=999999`);
    expect(otherCat.body.total).toBe(0);
    const inDept = await as("borrower", "GET", `/equipment/availability?${win}&department_id=3&q=Av Scoped`);
    expect((inDept.body.items as Avail[]).map((r) => Number(r.id))).toEqual([id]);
    const otherDept = await as("borrower", "GET", `/equipment/availability?${win}&department_id=999999`);
    expect(otherDept.body.total).toBe(0);
  });

  it("can exclude pooled assets, which have no per-unit window", async () => {
    const id = await newAsset("Av Pooled");
    await pool.query(`UPDATE mo_equipment_items SET pool_quantity=12 WHERE id=$1`, [id]);
    const win = "from=2029-04-01&to=2029-04-02&q=Av Pooled";
    expect(((await as("borrower", "GET", `/equipment/availability?${win}`)).body.items as Avail[])
      .map((r) => Number(r.id))).toEqual([id]);
    expect((await as("borrower", "GET", `/equipment/availability?${win}&individual_only=1`)).body.total).toBe(0);
  });

  it("refuses a window it would refuse a booking for, with the same message", async () => {
    expect((await as("borrower", "GET", "/equipment/availability")).status).toBe(400);
    expect((await as("borrower", "GET",
      "/equipment/availability?from=2029-05-05&to=2029-05-01")).status).toBe(400);
    const long = await as("borrower", "GET", "/equipment/availability?from=2029-06-01&to=2029-09-01");
    expect(long.status).toBe(400);
    expect(String(long.body.message)).toMatch(/VR-8/);
  });

  it("pages, and says so when nothing matches", async () => {
    /* Scoped to this file's own assets with q=. mediaops-crew-lifecycle and
       mediaops-tv-access insert equipment into the same database at the same
       time, so an unscoped page-1/page-2 comparison can see the offset window
       shift underneath it and report an overlap that is really a sibling's
       INSERT. Every asset this file creates has make='ZEQ'. */
    const win = "from=2029-07-01&to=2029-07-02&q=ZEQ";
    const p1 = await as("borrower", "GET", `/equipment/availability?${win}&limit=2&offset=0`);
    expect((p1.body.items as Avail[]).length).toBeLessThanOrEqual(2);
    expect(p1.body.limit).toBe(2);
    const p2 = await as("borrower", "GET", `/equipment/availability?${win}&limit=2&offset=2`);
    const ids1 = (p1.body.items as Avail[]).map((r) => Number(r.id));
    const ids2 = (p2.body.items as Avail[]).map((r) => Number(r.id));
    expect(ids1.filter((x) => ids2.includes(x)), "pages overlapped").toEqual([]);
    /* Its own q=, not a second one appended to the scoped window above. */
    const none = await as("borrower", "GET",
      "/equipment/availability?from=2029-07-01&to=2029-07-02&q=zzz-no-such-asset");
    expect(none.body.total).toBe(0);
    expect(none.body.items).toEqual([]);
  });

  it("clamps a nonsense page rather than trusting it", async () => {
    const win = "from=2029-08-01&to=2029-08-02";
    expect((await as("borrower", "GET", `/equipment/availability?${win}&limit=99999`)).body.limit).toBe(200);
    expect((await as("borrower", "GET", `/equipment/availability?${win}&limit=-5`)).body.limit).toBe(1);
    expect((await as("borrower", "GET", `/equipment/availability?${win}&limit=abc`)).body.limit).toBe(50);
    expect((await as("borrower", "GET", `${"/equipment/availability?" + win}&offset=abc`)).body.offset).toBe(0);
  });

  it("is gated like every other equipment read", async () => {
    const win = "from=2029-09-01&to=2029-09-02";
    expect((await as("nomodule", "GET", `/equipment/availability?${win}`)).status).toBe(403);
    expect((await as("outsider", "GET", `/equipment/availability?${win}`)).status).toBe(403);
    expect((await as("anon", "GET", `/equipment/availability?${win}`)).status).toBe(403);
  });
});

maybe("the booking read model", () => {
  it("returns a page, a true total, and never the whole table", async () => {
    const id = await newAsset("Bk Paged");
    for (const [s, e] of [["2030-01-01", "2030-01-02"], ["2030-02-01", "2030-02-02"],
                          ["2030-03-01", "2030-03-02"]] as const) await book("borrower", id, s, e);
    const r = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&limit=2`);
    expect(r.status).toBe(200);
    expect((r.body.items as unknown[]).length).toBe(2);
    expect(r.body.total).toBe(3);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(0);
    const p2 = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&limit=2&offset=2`);
    expect((p2.body.items as unknown[]).length).toBe(1);
    /* Ascending by start: this is a schedule before it is a history, and it is
       what the Bookings tab has always shown. */
    const all = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}`);
    expect((all.body.items as Array<{ starts_at: string }>).map((b) => b.starts_at))
      .toEqual(["2030-01-01", "2030-02-01", "2030-03-01"]);
  });

  /* OVERLAP, NOT CONTAINMENT. A booking that began before the window and ends
     inside it is part of that window — a calendar that asked for containment
     would lose every booking that straddles a month boundary. */
  it("asks for the bookings that overlap a range, not the ones inside it", async () => {
    const id = await newAsset("Bk Range");
    await book("borrower", id, "2030-05-28", "2030-06-03");   // straddles the boundary
    await book("borrower", id, "2030-06-10", "2030-06-12");   // wholly inside June
    await book("borrower", id, "2030-07-10", "2030-07-12");   // outside
    const june = await as("borrower", "GET",
      `/equipment/bookings?asset_id=${id}&from=2030-06-01&to=2030-06-30`);
    expect((june.body.items as Array<{ starts_at: string }>).map((b) => b.starts_at))
      .toEqual(["2030-05-28", "2030-06-10"]);
    /* The boundary day itself, both ways. */
    const firstOnly = await as("borrower", "GET",
      `/equipment/bookings?asset_id=${id}&from=2030-06-03&to=2030-06-03`);
    expect((firstOnly.body.items as unknown[]).length).toBe(1);
    const dayAfter = await as("borrower", "GET",
      `/equipment/bookings?asset_id=${id}&from=2030-06-04&to=2030-06-04`);
    expect(dayAfter.body.total).toBe(0);
  });

  it("filters by the status words the schema already has", async () => {
    const id = await newAsset("Bk Status");
    const keep = await book("borrower", id, "2030-08-01", "2030-08-02");
    const gone = await book("borrower", id, "2030-08-10", "2030-08-11");
    await as("borrower", "POST", `/equipment/bookings/${gone}/cancel`, {});

    const live = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&status=reserved,active`);
    expect((live.body.items as Array<{ id: number }>).map((b) => Number(b.id))).toEqual([keep]);
    const cancelled = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&status=cancelled`);
    expect((cancelled.body.items as Array<{ id: number }>).map((b) => Number(b.id))).toEqual([gone]);
    expect((await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&status=all`)).body.total).toBe(2);
    // A word the schema does not have is dropped rather than obeyed.
    expect((await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&status=nonsense`)).body.total).toBe(2);
  });

  it("filters by who booked, by category, by department and by project", async () => {
    const mine = await newAsset("Bk Mine");
    const theirs = await newAsset("Bk Theirs");
    await pool.query(`UPDATE mo_equipment_items SET department_id=3 WHERE id=$1`, [mine]);
    await pool.query(`UPDATE mo_equipment_items SET department_id=2 WHERE id=$1`, [theirs]);
    const b1 = await book("borrower", mine, "2031-01-05", "2031-01-06");
    await book("borrower2", theirs, "2031-01-05", "2031-01-06");

    const win = "from=2031-01-01&to=2031-01-31";
    const byUser = await as("borrower", "GET", `/equipment/bookings?${win}&user_id=${A.borrower.id}`);
    expect((byUser.body.items as Array<{ id: number }>).map((b) => Number(b.id))).toContain(b1);
    expect((byUser.body.items as Array<{ user_id: string }>).every((b) => b.user_id === A.borrower.id)).toBe(true);

    const byDept = await as("borrower", "GET", `/equipment/bookings?${win}&department_id=3`);
    expect((byDept.body.items as Array<{ id: number }>).map((b) => Number(b.id))).toEqual([b1]);
    expect((await as("borrower", "GET", `/equipment/bookings?${win}&category_id=999999`)).body.total).toBe(0);
    expect((await as("borrower", "GET", `/equipment/bookings?${win}&project_id=999999`)).body.total).toBe(0);
    expect((await as("borrower", "GET", `/equipment/bookings?${win}&shoot_id=999999`)).body.total).toBe(0);
  });

  it("carries enough of the asset and the person to draw a row", async () => {
    const id = await newAsset("Bk Row");
    await book("borrower", id, "2031-03-01", "2031-03-02");
    const r = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}`);
    const row = (r.body.items as Array<Record<string, unknown>>)[0];
    expect(row.asset_tag).toBe(await tagOf(id));
    expect(row.make).toBe("ZEQ");
    expect(row.user_name).toBe(`ZEQ ${A.borrower.id}`);
    expect(row.status).toBe("reserved");
    // And no history rides along with a schedule row.
    for (const heavy of ["transactions", "maintenance", "identifiers"])
      expect(row[heavy], `a booking row carried ${heavy}`).toBeUndefined();
  });

  it("counts by status when asked, over the same filters", async () => {
    const id = await newAsset("Bk Summary");
    const a = await book("borrower", id, "2031-05-01", "2031-05-02");
    await book("borrower", id, "2031-05-10", "2031-05-11");
    await as("borrower", "POST", `/equipment/bookings/${a}/cancel`, {});
    const plain = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}`);
    expect(plain.body.summary, "a summary was sent without being asked for").toBeUndefined();
    const r = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&summary=1`);
    const sum = r.body.summary as Record<string, number>;
    expect(sum.total).toBe(2);
    expect(sum.reserved).toBe(1);
    expect(sum.cancelled).toBe(1);
  });

  it("says so when nothing matches, and clamps a nonsense page", async () => {
    const none = await as("borrower", "GET", "/equipment/bookings?asset_id=99999999");
    expect(none.body.total).toBe(0);
    expect(none.body.items).toEqual([]);
    expect((await as("borrower", "GET", "/equipment/bookings?limit=99999")).body.limit).toBe(200);
    expect((await as("borrower", "GET", "/equipment/bookings?limit=abc")).body.limit).toBe(50);
    expect((await as("borrower", "GET", "/equipment/bookings?offset=-4")).body.offset).toBe(0);
  });

  it("is gated like every other equipment read", async () => {
    expect((await as("nomodule", "GET", "/equipment/bookings")).status).toBe(403);
    expect((await as("outsider", "GET", "/equipment/bookings")).status).toBe(403);
    expect((await as("anon", "GET", "/equipment/bookings")).status).toBe(403);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE RACE. Two people read "free" and both book. The database decides.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("concurrent bookings of the same window", () => {
  it("lets exactly one through, and the loser is told why", async () => {
    const id = await newAsset("Bk Race");
    /* Both read availability first — and both are told it is free, which is the
       honest answer at the moment each one asked. That is precisely why the
       verdict cannot live in the reader. */
    const [r1, r2] = await Promise.all([
      avail("borrower", id, "2031-09-10", "2031-09-14"),
      avail("borrower2", id, "2031-09-12", "2031-09-16"),
    ]);
    expect(r1.row.available).toBe(true);
    expect(r2.row.available).toBe(true);

    const results = await Promise.all([
      as("borrower", "POST", "/equipment/bookings",
        { equipment_item_id: id, starts_at: "2031-09-10", ends_at: "2031-09-14" }),
      as("borrower2", "POST", "/equipment/bookings",
        { equipment_item_id: id, starts_at: "2031-09-12", ends_at: "2031-09-16" }),
    ]);
    const ok = results.filter((r) => r.status === 201);
    const clash = results.filter((r) => r.status === 409);
    /* Every assertion carries the full outcome. A race that fails once in
       seven runs is only diagnosable if the failure says what actually came
       back — the first version of this named the statuses on one assertion
       and left the other silent, which cost a day. */
    const outcome = results
      .map((r) => `${r.status}:${String((r.body as { message?: string })?.message ?? "").slice(0, 80)}`)
      .join(" | ");
    expect(ok.length, outcome).toBe(1);
    expect(clash.length, outcome).toBe(1);
    expect(String(clash[0].body.message), outcome).toMatch(/AC-7/);
    /* THE BUG THIS NAMES. The loser used to come back 500 with an HTML body
       about one concurrent pair in seven: two overlapping inserts each wait on
       the other's exclusion-constraint entry, Postgres breaks the cycle with
       40P01, and the handler only caught 23P01. Losing a race is a conflict,
       and it must say so. */
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);

    /* And the ledger holds one booking, not two — the constraint, not the
       handler, is what made that true. */
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings
        WHERE equipment_item_id=$1 AND status IN ('reserved','active')`, [id])).rows[0].c)).toBe(1);
  });

  it("holds under a wider pile-up on one window", async () => {
    const id = await newAsset("Bk Pileup");
    const N = 8;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      as(i % 2 ? "borrower" : "borrower2", "POST", "/equipment/bookings",
        { equipment_item_id: id, starts_at: "2031-11-01", ends_at: `2031-11-0${(i % 5) + 2}` })));
    const outcome = results
      .map((r) => `${r.status}:${String((r.body as { message?: string })?.message ?? "").slice(0, 80)}`)
      .join(" | ");
    expect(results.filter((r) => r.status === 201).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(N - 1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings
        WHERE equipment_item_id=$1 AND status IN ('reserved','active')`, [id])).rows[0].c)).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   CURRENT CUSTODY (Phase 4).

   Who holds what, derived from the ledger — no custody table, no second
   source of truth. The browser used to work this out by sorting
   DB.equipment_transactions per asset; every assertion here is about the
   server reaching the same answer from the rows that actually decide it.
   ══════════════════════════════════════════════════════════════════════════ */

interface CustodyRow {
  asset: { id: string; asset_tag: string; status: string; category_id: number };
  custody: { holder_id: string; holder_name: string; transaction_id: string;
             due_at: string | null; overdue: boolean; overdue_days: number;
             recorded_via: string; checked_out_at: string };
  project: { id: string; name: string } | null;
  department: { id: string; name: string } | null;
}
const custody = async (actor: ActorName | "anon", qs = "") => {
  const r = await as(actor, "GET", `/equipment/custody${qs}`);
  return { status: r.status, body: r.body, items: (r.body?.items ?? []) as CustodyRow[] };
};
/** Custody for ONE asset, which is how most of these scope themselves. */
const custodyOf = async (id: number) => (await custody("borrower", `?asset_id=${id}`)).items[0];
const dayFromNow = (n: number) => istDay(n);

/* The invariant, under load: every outcome of a contended booking is a clean
   201 or a clean 409, and one asset never ends up with two live bookings.

   THIS TEST IS PROBABILISTIC AND SAYS SO. The 40P01 deadlock it is meant to
   provoke appeared in roughly one concurrent pair in seven through a bare
   harness, but does not reproduce reliably under vitest — the module-access
   query each request makes first shifts the alignment. It was verified NOT to
   fail with the fix reverted, so it is not the guard: the guard is the
   source-level check below, which does fail. This test is kept because the
   invariant is worth holding whatever the cause. */
maybe("overlapping bookings never answer with a server error", () => {
  it("answers every concurrent pair with 201 or AC-7, across many pairs", async () => {
    const PAIRS = 14;
    const ids: number[] = [];
    for (let i = 0; i < PAIRS; i++) ids.push(await newAsset(`Bk Pair ${i}`));

    /* ONE PAIR AT A TIME. The two requests inside a pair are simultaneous;
       the pairs are not. Firing all twenty-eight at once makes them queue on
       the six-connection pool, which serialises exactly the interleaving this
       is trying to produce — and the test then passes whether or not the bug
       is present. Sequential pairs reproduce it. */
    const outcomes: Array<Array<{ status: number; body: Record<string, never> }>> = [];
    for (const id of ids) {
      outcomes.push(await Promise.all([
        as("borrower", "POST", "/equipment/bookings",
          { equipment_item_id: id, starts_at: "2032-02-10", ends_at: "2032-02-14" }),
        as("borrower2", "POST", "/equipment/bookings",
          { equipment_item_id: id, starts_at: "2032-02-12", ends_at: "2032-02-16" }),
      ]));
    }

    const flat = outcomes.flat();
    const report = flat.map((r) => r.status).join(",");
    expect(flat.filter((r) => r.status >= 500).length, `statuses: ${report}`).toBe(0);
    expect(flat.every((r) => r.status === 201 || r.status === 409), `statuses: ${report}`).toBe(true);
    for (const r of flat.filter((r) => r.status === 409))
      expect(String(r.body.message), `statuses: ${report}`).toMatch(/AC-7/);
    expect(outcomes.filter((p) => p.some((r) => r.status === 201)).length,
      `statuses: ${report}`).toBe(PAIRS);

    const live = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings
        WHERE equipment_item_id = ANY($1::bigint[]) AND status IN ('reserved','active')`,
      [ids])).rows[0].c);
    expect(live, "a pair produced two live bookings for one asset").toBe(PAIRS);
  });
});

/* THE GUARD, and it is deterministic.

   `POST /equipment/bookings` refuses an overlap through the exclusion
   constraint. That refusal arrives as 23P01 normally, and as 40P01 — deadlock
   detected — when two overlapping inserts wait on each other's index entry and
   Postgres breaks the cycle. Catching only 23P01 turned the second case into a
   500 with an HTML body, which is the failure recorded as unknown in
   docs/TEST_STABILITY.md §G.7 and identified here.

   A runtime test cannot provoke the deadlock on demand, so what is checked is
   the thing that was actually wrong: the handler's catch. Reverting the fix
   fails this test. */
describe("the booking handler treats a lost race as a conflict, not a crash", () => {
  it("maps both exclusion SQLSTATEs to AC-7", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("server/mediaops-api.ts", "utf8");
    /* Anchored on the ROUTE, not on the INSERT: the same statement appears in
       the shoot-creation side-write earlier in the file, and anchoring there
       pointed this guard twenty thousand characters away from the catch. */
    const start = src.indexOf("app.post(`${P}/equipment/bookings`");
    expect(start, "the booking route moved — this guard needs repointing").toBeGreaterThan(0);
    const end = src.indexOf("app.post(`${P}/equipment/bookings/:id/cancel`", start);
    expect(end, "the cancel route moved — this guard needs repointing").toBeGreaterThan(start);
    /* COMMENTS STRIPPED. The first version of this passed with the fix
       reverted, because the comment explaining the fix mentions 40P01 — the
       guard was reading the prose that describes the code instead of the code.
       What is asserted now is the comparison itself. */
    const region = src.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(region, "the booking insert no longer reports AC-7")
      .toContain("AC-7: this item is already booked");
    expect(region, "23P01 is no longer treated as a booking conflict")
      .toContain('=== "23P01"');
    expect(region,
      "40P01 (deadlock) is not treated as a booking conflict — a lost race will 500")
      .toContain('=== "40P01"');
  });
});

maybe("current custody is derived from the ledger", () => {
  it("is empty for an asset nobody has taken", async () => {
    const id = await newAsset("Cu Untouched");
    const r = await custody("borrower", `?asset_id=${id}`);
    expect(r.status).toBe(200);
    expect(r.items).toEqual([]);
    expect(r.body.total).toBe(0);
  });

  it("shows the holder after a checkout, with the asset and the loan", async () => {
    const id = await newAsset("Cu Held");
    const due = dayFromNow(5);
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: due })).status).toBe(201);

    const row = await custodyOf(id);
    expect(Number(row.asset.id)).toBe(id);
    expect(row.asset.asset_tag).toBe(await tagOf(id));
    expect(row.custody.holder_id).toBe(A.borrower.id);
    expect(row.custody.holder_name).toBe(`ZEQ ${A.borrower.id}`);
    expect(row.custody.due_at).toBe(due);
    expect(row.custody.recorded_via).toBe("desktop");
    expect(Number(row.custody.transaction_id)).toBeGreaterThan(0);
  });

  /* THE REGRESSION THE PHASE EXISTS TO PREVENT. Check-in appends a row; it
     does not edit the checkout. If "latest" were wrong, custody would survive
     the return. */
  it("drops the holder after a check-in, with no synchronisation step", async () => {
    const id = await newAsset("Cu Returned");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    expect(await custodyOf(id)).toBeDefined();
    expect((await as("borrower", "POST", `/equipment/${id}/checkin`, {})).status).toBe(201);
    expect(await custodyOf(id), "custody survived the check-in").toBeUndefined();
    expect((await custody("borrower", `?asset_id=${id}`)).body.total).toBe(0);
  });

  it("follows the latest transaction through a long history", async () => {
    const id = await newAsset("Cu History");
    for (let i = 0; i < 3; i++) {
      await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
      await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    }
    expect(await custodyOf(id), "three complete loans left custody behind").toBeUndefined();
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower2.id, expected_return_at: DUE });
    const row = await custodyOf(id);
    expect(row.custody.holder_id, "the last checkout did not win").toBe(A.borrower2.id);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_transactions WHERE equipment_item_id=$1`,
      [id])).rows[0].c)).toBe(7);
  });

  /* The tie-break. Two rows in the same second resolve by primary key, so the
     answer is the same on every run and on every machine. */
  it("breaks a tied timestamp on the transaction id, deterministically", async () => {
    const id = await newAsset("Cu Tied");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    /* Force the collision the clock rarely produces: both rows at one instant.
       The check_in has the higher id, so it is the later one. */
    await pool.query(
      `UPDATE mo_equipment_transactions SET occurred_at = TIMESTAMPTZ '2030-01-01 09:00:00+05:30'
        WHERE equipment_item_id=$1`, [id]);
    const ids = (await pool.query(
      `SELECT id, action FROM mo_equipment_transactions WHERE equipment_item_id=$1 ORDER BY id`,
      [id])).rows;
    expect(ids[1].action).toBe("check_in");
    for (let i = 0; i < 5; i++)
      expect(await custodyOf(id), "a tied timestamp resolved to the earlier row").toBeUndefined();

    // And the other way round: the higher id is a checkout, so custody stands.
    await pool.query(`UPDATE mo_equipment_transactions SET action='check_out' WHERE id=$1`, [ids[1].id]);
    await pool.query(`UPDATE mo_equipment_transactions SET action='check_in' WHERE id=$1`, [ids[0].id]);
    for (let i = 0; i < 5; i++)
      expect((await custodyOf(id)).custody.transaction_id).toBe(String(ids[1].id));
  });

  it("does not take custody from the asset's status alone", async () => {
    const id = await newAsset("Cu StatusOnly");
    /* A status that says checked_out with no ledger behind it is not custody.
       This is the exact inference the phase forbids. */
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [id]);
    expect(await custodyOf(id)).toBeUndefined();
  });

  it("keeps custody when the asset is flipped to maintenance while still held", async () => {
    const id = await newAsset("Cu StillOut");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    const row = await custodyOf(id);
    expect(row, "the ledger still says somebody has it").toBeDefined();
    expect(row.custody.holder_id).toBe(A.borrower.id);
    expect(row.asset.status).toBe("maintenance");
  });

  it("still reports a retired asset somebody is holding, unless asked not to", async () => {
    const id = await newAsset("Cu Retired");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await pool.query(`UPDATE mo_equipment_items SET status='retired' WHERE id=$1`, [id]);
    expect(await custodyOf(id), "a retired asset in someone's hands vanished").toBeDefined();
    expect((await custody("borrower", `?asset_id=${id}&include_retired=0`)).items).toEqual([]);
  });
});

/* A LOAN THAT IS ALREADY LATE — which Phase 17F made impossible to create
   directly. Checkout now requires a due date in the future and inside the
   policy window, so a past due date can only arise the way it does in life:
   the loan was made legitimately and the day came and went. The fixture
   therefore checks out properly and then moves the ledger row's due date
   backwards, which is exactly the state the derivation has to read.

   The alternative — relaxing the endpoint so the test could use it — would have
   been testing a system nobody runs. */
async function loanDue(assetId: number, holder: string, due: string | null) {
  const r = await as("custodian", "POST", `/equipment/${assetId}/checkout`,
    { holder_id: holder, expected_return_at: DUE });
  if (r.status !== 201) throw new Error(`loan fixture failed: ${r.status} ${JSON.stringify(r.body)}`);
  await pool.query(`UPDATE mo_equipment_transactions SET expected_return_at = $2::date WHERE id = $1`,
    [Number((r.body.transaction as { id: number }).id), due]);
  return r;
}

maybe("custody: overdue is derived, on the server's clock", () => {
  it("calls a loan past its due date overdue, and counts the days", async () => {
    const id = await newAsset("Cu Late");
    await loanDue(id, A.borrower.id, dayFromNow(-3));
    const row = await custodyOf(id);
    expect(row.custody.overdue).toBe(true);
    expect(row.custody.overdue_days).toBe(3);
  });

  /* DUE TODAY IS NOT LATE. The first day a loan is late is the day after it
     was due — the rule overdueDays() already encodes. */
  it("does not call a loan due today overdue", async () => {
    const id = await newAsset("Cu DueToday");
    await loanDue(id, A.borrower.id, dayFromNow(0));
    const row = await custodyOf(id);
    expect(row.custody.overdue).toBe(false);
    expect(row.custody.overdue_days).toBe(0);
  });

  it("does not call a loan with no due date overdue", async () => {
    /* A loan with NO due date. Phase 17F requires one, so this shape can only
        come from the years of history that predate the rule — and the
        derivation still has to read it without calling it overdue. */
    const id = await newAsset("Cu NoDue");
    await loanDue(id, A.borrower.id, null);
    const row = await custodyOf(id);
    expect(row.custody.due_at).toBeNull();
    expect(row.custody.overdue).toBe(false);
    expect(row.custody.overdue_days).toBe(0);
  });

  it("filters to overdue, to not-overdue, and to due on or before a day", async () => {
    const late = await newAsset("Cu FLate");
    const soon = await newAsset("Cu FSoon");
    await loanDue(late, A.borrower.id, dayFromNow(-2));
    await as("custodian", "POST", `/equipment/${soon}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(9) });

    const od = await custody("borrower", `?overdue=1&q=Cu F`);
    expect(od.items.map((r) => Number(r.asset.id))).toEqual([late]);
    const notOd = await custody("borrower", `?overdue=0&q=Cu F`);
    expect(notOd.items.map((r) => Number(r.asset.id))).toEqual([soon]);
    /* "Due today or already late" — the dashboard widget's own line. */
    const due = await custody("borrower", `?due_on_or_before=${dayFromNow(0)}&q=Cu F`);
    expect(due.items.map((r) => Number(r.asset.id))).toEqual([late]);
  });

  it("counts overdue and due-today when asked, over the same filters", async () => {
    const id = await newAsset("Cu Sum");
    await loanDue(id, A.borrower.id, dayFromNow(-1));
    const plain = await custody("borrower", `?q=Cu Sum`);
    expect(plain.body.summary, "a summary arrived unasked").toBeUndefined();
    const r = await custody("borrower", `?q=Cu Sum&summary=1`);
    const sum = r.body.summary as unknown as Record<string, number>;
    expect(sum.total).toBe(1);
    expect(sum.overdue).toBe(1);
    expect(sum.due_today).toBe(0);
    expect(sum.holders).toBe(1);
  });
});

maybe("custody: filters, joins and paging", () => {
  it("filters by holder, and never mixes two people's loans", async () => {
    const mine = await newAsset("CuHolderA");
    const theirs = await newAsset("CuHolderB");
    await as("custodian", "POST", `/equipment/${mine}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("custodian", "POST", `/equipment/${theirs}/checkout`, { holder_id: A.borrower2.id, expected_return_at: DUE });
    const r = await custody("borrower", `?holder_id=${A.borrower.id}&q=CuHolder`);
    expect(r.items.map((x) => Number(x.asset.id))).toEqual([mine]);
    expect(r.items.every((x) => x.custody.holder_id === A.borrower.id)).toBe(true);
  });

  it("carries the department from the asset, which is where the schema keeps it", async () => {
    const id = await newAsset("Cu Dept");
    await pool.query(`UPDATE mo_equipment_items SET department_id=3 WHERE id=$1`, [id]);
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    const row = await custodyOf(id);
    expect(Number(row.department!.id)).toBe(3);
    expect(row.department!.name).toBeTruthy();
    expect((await custody("borrower", `?department_id=3&q=Cu Dept`)).items
      .map((x) => Number(x.asset.id))).toEqual([id]);
    expect((await custody("borrower", `?department_id=999999&q=Cu Dept`)).items).toEqual([]);
  });

  it("carries the project through the booking, and null when there is none", async () => {
    const withBk = await newAsset("Cu Proj");
    const without = await newAsset("Cu NoProj");
    /* A PROJECT OF THIS SUITE'S OWN. This used to borrow one —
       `SELECT id FROM mo_projects ORDER BY id LIMIT 1` — which on a clean test
       database is whichever SIBLING SUITE's fixture happens to sort first. The
       booking below then pinned that project with a foreign key, and when the
       owning suite tore down, its `DELETE FROM mo_projects` failed:

         update or delete on table "mo_projects" violates foreign key constraint
         "mo_equipment_bookings_project_id_fkey" on table "mo_equipment_bookings"

       — reported as a file-level failure in the OTHER suite, with every one of
       its tests passing, which is why it took three sightings to catch. The
       crew-lifecycle suite removed the same borrowing from its own fixtures and
       called it "the last cross-suite flake"; this was the other one.

       Owned, so nothing else can be holding it and nothing else can delete it.
       TEST_STABILITY entry 17: a fixture must own what it points at. */
    const proj = Number((await pool.query(
      `INSERT INTO mo_projects (project_type_id, code, name, created_by)
       VALUES ((SELECT id FROM mo_project_types ORDER BY id LIMIT 1), $1, $2, $3) RETURNING id`,
      [`${PX}-P2`, `${PX} custody project`, A.custodian.id])).rows[0].id);
    const mk = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: withBk, starts_at: dayFromNow(0), ends_at: dayFromNow(2), project_id: proj });
    const bid = Number((mk.body.booking as { id: number }).id);
    await as("custodian", "POST", `/equipment/${withBk}/checkout`,
      { holder_id: A.borrower.id, booking_id: bid, expected_return_at: DUE });
    await as("custodian", "POST", `/equipment/${without}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });

    const held = await custodyOf(withBk);
    expect(Number(held.project!.id)).toBe(proj);
    expect(held.project!.name).toBeTruthy();
    expect((await custodyOf(without)).project,
      "a checkout with no booking invented a project").toBeNull();
    expect((await custody("borrower", `?project_id=${proj}&q=Cu Proj`)).items
      .map((x) => Number(x.asset.id))).toEqual([withBk]);
  });

  it("searches the asset and the person holding it", async () => {
    const id = await newAsset("Cu Searchable");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    const tag = await tagOf(id);
    for (const term of [tag, "Cu Searchable", A.borrower.id])
      expect((await custody("borrower", `?q=${encodeURIComponent(term)}`)).items
        .map((x) => Number(x.asset.id)), `q=${term}`).toContain(id);
    expect((await custody("borrower", "?q=zzz-nobody-holds-this")).items).toEqual([]);
  });

  it("pages, with a true total and no overlap", async () => {
    for (let i = 0; i < 3; i++) {
      const id = await newAsset(`Cu Page ${i}`);
      await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    }
    const p1 = await custody("borrower", "?q=Cu Page&limit=2&offset=0");
    expect(p1.items.length).toBe(2);
    expect(p1.body.total).toBe(3);
    expect(p1.body.limit).toBe(2);
    const p2 = await custody("borrower", "?q=Cu Page&limit=2&offset=2");
    expect(p2.items.length).toBe(1);
    const a = p1.items.map((x) => Number(x.asset.id));
    const b = p2.items.map((x) => Number(x.asset.id));
    expect(a.filter((x) => b.includes(x)), "pages overlapped").toEqual([]);
  });

  it("clamps a nonsense page rather than trusting it", async () => {
    expect((await custody("borrower", "?limit=99999")).body.limit).toBe(200);
    expect((await custody("borrower", "?limit=-5")).body.limit).toBe(1);
    expect((await custody("borrower", "?limit=abc")).body.limit).toBe(50);
    expect((await custody("borrower", "?offset=abc")).body.offset).toBe(0);
    expect((await custody("borrower", "?offset=-9")).body.offset).toBe(0);
  });

  /* A DATE IS A DAY. The bug Phase 3 found would render this one day early. */
  it("serialises the due date as a day, not an instant", async () => {
    const id = await newAsset("Cu Dates");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    const row = await custodyOf(id);
    expect(row.custody.due_at).toBe(DUE);
    expect(String(row.custody.due_at)).not.toMatch(/[TZ]/);
    /* checked_out_at is a TIMESTAMPTZ — an instant, and correctly an instant. */
    expect(String(row.custody.checked_out_at)).toMatch(/T/);
    expect(Number.isNaN(Date.parse(String(row.custody.checked_out_at)))).toBe(false);
  });

  it("carries no ledger with it — this is custody, not history", async () => {
    const id = await newAsset("Cu Light");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    const row = await custodyOf(id) as unknown as Record<string, unknown>;
    for (const heavy of ["transactions", "maintenance", "bookings", "identifiers"])
      expect(row[heavy], `a custody row carried ${heavy}`).toBeUndefined();
  });

  it("is gated like every other equipment read", async () => {
    expect((await custody("nomodule")).status).toBe(403);
    expect((await custody("outsider")).status).toBe(403);
    expect((await custody("anon")).status).toBe(403);
    expect((await custody("borrower")).status).toBe(200);
    expect((await custody("custodian")).status).toBe(200);
    expect((await custody("admin")).status).toBe(200);
  });
});

maybe("custody reflects the write endpoints, with nothing in between", () => {
  /* ── PHASE 17F: THE RACE, ASSERTED PROPERLY ─────────────────────────────
     WHAT THIS TEST USED TO SAY. "Whatever the endpoints decide, custody must
     name exactly one holder afterwards." That was satisfied by a broken system:
     both requests returned 201, both wrote a check_out row, and the read model
     hid it by reporting only the latest. A probe reproduced two 201s and two
     ledger rows four times out of four.

     One holder in the READ MODEL is not the invariant. One holder in the
     LEDGER is. A camera cannot be in two people's hands, and a history that
     says it was is not a history anyone can settle a dispute with. */
  it("lets exactly ONE of two simultaneous checkouts through", async () => {
    const id = await newAsset("Cu Race");
    const results = await Promise.all([
      as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE }),
      as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower2.id, expected_return_at: DUE }),
    ]);
    /* Every assertion carries the full outcome: a race that fails once in seven
       runs is only diagnosable if the failure says what actually came back. */
    const outcome = results
      .map((r) => `${r.status}:${String((r.body as { message?: string })?.message ?? "").slice(0, 60)}`).join(" | ");
    expect(results.filter((r) => r.status === 201).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);

    /* THE LEDGER, which is the part that matters. */
    const outs = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_transactions
        WHERE equipment_item_id=$1 AND action='check_out'`, [id])).rows[0].c);
    expect(outs, `two holders were recorded for one camera · ${outcome}`).toBe(1);

    const r = await custody("borrower", `?asset_id=${id}`);
    expect(r.items.length, outcome).toBe(1);
    const held = (await pool.query(
      `SELECT holder_id FROM mo_equipment_transactions WHERE equipment_item_id=$1
        ORDER BY occurred_at DESC, id DESC LIMIT 1`, [id])).rows[0];
    expect(r.items[0].custody.holder_id).toBe(held.holder_id);
  });

  it("holds under a wider pile-up on one asset", async () => {
    const id = await newAsset("Cu Pileup");
    const N = 6;
    const results = await Promise.all(Array.from({ length: N }, (_, i) =>
      as("custodian", "POST", `/equipment/${id}/checkout`,
        { holder_id: i % 2 ? A.borrower.id : A.borrower2.id, expected_return_at: DUE })));
    const outcome = results.map((r) => r.status).join(",");
    expect(results.filter((r) => r.status === 201).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(N - 1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_transactions
        WHERE equipment_item_id=$1 AND action='check_out'`, [id])).rows[0].c), outcome).toBe(1);
  });

  it("lets exactly ONE of two simultaneous check-ins through", async () => {
    const id = await newAsset("Cu InRace");
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE })).status).toBe(201);
    const results = await Promise.all([
      as("custodian", "POST", `/equipment/${id}/checkin`, {}),
      as("custodian", "POST", `/equipment/${id}/checkin`, {}),
    ]);
    const outcome = results
      .map((r) => `${r.status}:${String((r.body as { message?: string })?.message ?? "").slice(0, 60)}`).join(" | ");
    expect(results.filter((r) => r.status === 201).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_transactions
        WHERE equipment_item_id=$1 AND action='check_in'`, [id])).rows[0].c),
      `one loan was returned twice · ${outcome}`).toBe(1);
    /* And custody is clear afterwards, not half-closed. */
    expect((await custody("borrower", `?asset_id=${id}`)).items).toEqual([]);
  });

  it("writes no audit event for the checkout that lost", async () => {
    /* A refusal must leave no trace that looks like a success. */
    const id = await newAsset("Cu RaceAudit");
    await Promise.all([
      as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE }),
      as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower2.id, expected_return_at: DUE }),
    ]);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs
        WHERE entity_type='equipment_item' AND entity_id=$1 AND action='equipment.checked_out'`,
      [id])).rows[0].c), "the loser audited a checkout it did not make").toBe(1);
  });

  it("never shows one asset twice, however many loans it has had", async () => {
    const id = await newAsset("Cu Once");
    for (let i = 0; i < 4; i++) {
      await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
      await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    }
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    const r = await custody("borrower", `?asset_id=${id}`);
    expect(r.items.length).toBe(1);
    expect(r.body.total).toBe(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SERVER-DERIVED EFFECTIVE STATE (Phase 5).

   Five things were called "status" and worked out in five places. These assert
   the one answer, and — just as important — that the five parts stay SEPARATE:
   an asset in maintenance that somebody still holds is both of those things,
   and the API says so rather than picking one.
   ══════════════════════════════════════════════════════════════════════════ */

interface AssetState {
  lifecycle: { status: string; persisted: boolean; unserviceable: boolean };
  custody: { status: string; holder_id: string | null; due_at: string | null;
             checked_out_at: string | null; transaction_id: string | null };
  maintenance: { active: boolean; open_count: number };
  reservation: { status: string; booking_id: string; starts_at: string; ends_at: string } | null;
  derived: { overdue: boolean; overdue_days: number };
  conflicts: string[];
}
/** The state block for one asset, from the detail endpoint. */
async function stateOf(id: number): Promise<AssetState> {
  const r = await as("borrower", "GET", `/equipment/${id}`);
  expect(r.status, `GET /equipment/${id}`).toBe(200);
  return (r.body.item as unknown as { state: AssetState }).state;
}
/** The same asset's state as the REGISTRY sees it — these must not differ. */
async function listStateOf(id: number, model: string): Promise<AssetState> {
  const r = await as("borrower", "GET", `/equipment?q=${encodeURIComponent(model)}&limit=50`);
  const row = (r.body.items as Array<{ id: string; state: AssetState }>)
    .find((x) => Number(x.id) === id);
  expect(row, `asset ${id} missing from the registry page`).toBeTruthy();
  return row!.state;
}
const dayOffset = (n: number) => istDay(n);

maybe("effective state: the registry and the detail agree", () => {
  it("gives the same state for the same asset, from both endpoints", async () => {
    const id = await newAsset("St Agree");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayOffset(3) });
    const a = await stateOf(id), b = await listStateOf(id, "St Agree");
    expect(b).toEqual(a);
  });
});

maybe("effective state: the consistency matrix", () => {
  /* 1 — active, nobody holds it, no booking. The plain case. */
  it("active + not held + no booking", async () => {
    const id = await newAsset("St Plain");
    const s = await stateOf(id);
    expect(s.lifecycle.status).toBe("available");
    expect(s.lifecycle.unserviceable).toBe(false);
    expect(s.custody.status).toBe("not_held");
    expect(s.custody.holder_id).toBeNull();
    expect(s.maintenance.active).toBe(false);
    expect(s.reservation).toBeNull();
    expect(s.derived.overdue).toBe(false);
    expect(s.conflicts).toEqual([]);
  });

  /* 2 — active and held. Lifecycle and custody agree. */
  it("active + held", async () => {
    const id = await newAsset("St Held");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    const s = await stateOf(id);
    expect(s.lifecycle.status).toBe("checked_out");
    expect(s.custody.status).toBe("checked_out");
    expect(s.custody.holder_id).toBe(A.borrower.id);
    expect(s.conflicts).toEqual([]);
  });

  /* 3 — in maintenance, nobody holds it. */
  it("maintenance + not held", async () => {
    const id = await newAsset("St Maint");
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    const s = await stateOf(id);
    expect(s.lifecycle.status).toBe("maintenance");
    expect(s.lifecycle.unserviceable).toBe(true);
    expect(s.custody.status).toBe("not_held");
  });

  /* 4 — THE CONTRADICTION THE DATA PERMITS. Both facts are reported; neither
     is rewritten, and the conflict is named. */
  it("maintenance + held — both, and the contradiction is declared", async () => {
    const id = await newAsset("St Both");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    const s = await stateOf(id);
    expect(s.lifecycle.status).toBe("maintenance");
    expect(s.custody.status).toBe("checked_out");
    expect(s.custody.holder_id).toBe(A.borrower.id);
    expect(s.conflicts).toContain("held_but_lifecycle_maintenance");
    // And the registry says exactly the same thing.
    expect((await listStateOf(id, "St Both")).conflicts).toContain("held_but_lifecycle_maintenance");
  });

  /* 5 — retired, with history. History survives retirement. */
  it("retired + historical transaction", async () => {
    const id = await newAsset("St Retired");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    expect((await as("custodian", "POST", `/equipment/${id}/retire`, { reason: "end of life" })).status).toBe(200);
    const s = await stateOf(id);
    expect(s.lifecycle.status).toBe("retired");
    expect(s.custody.status).toBe("not_held");
    expect(s.reservation, "retiring did not release the reservations").toBeNull();
  });

  it("held + overdue", async () => {
    const id = await newAsset("St Late");
    await loanDue(id, A.borrower.id, dayOffset(-2));
    const s = await stateOf(id);
    expect(s.derived.overdue).toBe(true);
    expect(s.derived.overdue_days).toBe(2);
    expect(s.custody.due_at).toBe(dayOffset(-2));
  });

  /* DUE TODAY IS NOT LATE — the rule overdueDays() encodes, unchanged. */
  it("held + due today", async () => {
    const id = await newAsset("St Today");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayOffset(0) });
    const s = await stateOf(id);
    expect(s.derived.overdue).toBe(false);
    expect(s.derived.overdue_days).toBe(0);
  });

  it("future reservation", async () => {
    const id = await newAsset("St Future");
    const mk = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayOffset(5), ends_at: dayOffset(7) });
    expect(mk.status).toBe(201);
    const s = await stateOf(id);
    expect(s.reservation).not.toBeNull();
    expect(s.reservation!.status).toBe("reserved");
    expect(s.reservation!.starts_at).toBe(dayOffset(5));
    expect(s.lifecycle.status, "a reservation rewrote the lifecycle").toBe("available");
  });

  it("active booking", async () => {
    const id = await newAsset("St Active");
    const mk = await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayOffset(0), ends_at: dayOffset(2) });
    const bid = Number((mk.body.booking as { id: number }).id);
    await pool.query(`UPDATE mo_equipment_bookings SET status='active' WHERE id=$1`, [bid]);
    const s = await stateOf(id);
    expect(s.reservation!.status).toBe("active");
    expect(Number(s.reservation!.booking_id)).toBe(bid);
  });

  it("cancelled, completed and past bookings are not reservations", async () => {
    for (const [model, mutate] of [
      ["St Cancelled", `UPDATE mo_equipment_bookings SET status='cancelled' WHERE id=$1`],
      ["St Completed", `UPDATE mo_equipment_bookings SET status='completed' WHERE id=$1`],
    ] as const) {
      const id = await newAsset(model);
      const mk = await as("borrower", "POST", "/equipment/bookings",
        { equipment_item_id: id, starts_at: dayOffset(4), ends_at: dayOffset(6) });
      await pool.query(mutate, [Number((mk.body.booking as { id: number }).id)]);
      expect((await stateOf(id)).reservation, `${model} still counted as a reservation`).toBeNull();
    }
    /* And one that is simply over: live status, but its last day has passed. */
    const id = await newAsset("St Past");
    await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id,user_id,starts_at,ends_at,status,created_by)
       VALUES ($1,$2,$3,$4,'reserved',$2)`,
      [id, A.borrower.id, dayOffset(-9), dayOffset(-7)]);
    expect((await stateOf(id)).reservation, "a booking that ended last week is not a reservation").toBeNull();
  });

  it("historical and resolved maintenance do not mean maintenance now", async () => {
    const id = await newAsset("St OldRepair");
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id,kind,description,reported_by,started_at,resolved_at)
       VALUES ($1,'repair','fixed long ago',$2,$3,$4)`,
      [id, A.custodian.id, dayOffset(-40), dayOffset(-30)]);
    const s = await stateOf(id);
    expect(s.maintenance.active).toBe(false);
    expect(s.maintenance.open_count).toBe(0);
    expect(s.lifecycle.status).toBe("available");
  });

  it("counts several open maintenance records, and says the lifecycle disagrees", async () => {
    const id = await newAsset("St ManyRepairs");
    for (let i = 0; i < 3; i++)
      await pool.query(
        `INSERT INTO mo_maintenance_records (equipment_item_id,kind,description,reported_by,started_at)
         VALUES ($1,'repair',$2,$3,$4)`, [id, `open ${i}`, A.custodian.id, dayOffset(-i)]);
    const s = await stateOf(id);
    expect(s.maintenance.active).toBe(true);
    expect(s.maintenance.open_count).toBe(3);
    /* The asset's own column still says available — an open record does not
       move it, and the API reports the disagreement instead of rewriting it. */
    expect(s.conflicts).toContain("open_maintenance_but_lifecycle_available");
  });

  it("takes the soonest of several live bookings", async () => {
    const id = await newAsset("St ManyBookings");
    await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayOffset(20), ends_at: dayOffset(22) });
    await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayOffset(8), ends_at: dayOffset(10) });
    const s = await stateOf(id);
    expect(s.reservation!.starts_at, "the later booking won").toBe(dayOffset(8));
  });

  it("follows many transactions to the latest one, and back again", async () => {
    const id = await newAsset("St Churn");
    for (let i = 0; i < 3; i++) {
      await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
      expect((await stateOf(id)).custody.status, `loan ${i}: checkout`).toBe("checked_out");
      await as("borrower", "POST", `/equipment/${id}/checkin`, {});
      expect((await stateOf(id)).custody.status, `loan ${i}: check-in`).toBe("not_held");
    }
  });

  it("resolves a tied timestamp on the transaction id, every time", async () => {
    const id = await newAsset("St Tied");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    await pool.query(
      `UPDATE mo_equipment_transactions SET occurred_at = TIMESTAMPTZ '2030-02-02 09:00:00+05:30'
        WHERE equipment_item_id=$1`, [id]);
    for (let i = 0; i < 5; i++)
      expect((await stateOf(id)).custody.status, `attempt ${i}`).toBe("not_held");
  });

  it("does not take custody from the lifecycle column alone", async () => {
    const id = await newAsset("St Liar");
    await pool.query(`UPDATE mo_equipment_items SET status='checked_out' WHERE id=$1`, [id]);
    const s = await stateOf(id);
    expect(s.custody.status).toBe("not_held");
    expect(s.custody.holder_id).toBeNull();
    expect(s.conflicts).toContain("lifecycle_checked_out_but_not_held");
  });

  it("keeps availability out of it — that is a question about a date range", async () => {
    const id = await newAsset("St NotAvail");
    const s = await stateOf(id) as unknown as Record<string, unknown>;
    expect(s.availability,
      "availability was baked into state; it depends on the range asked about").toBeUndefined();
  });
});

maybe("effective state: the registry header counts what the words mean", () => {
  it("counts a booked asset as booked, which it never used to", async () => {
    const id = await newAsset("St Booked");
    const before = await as("borrower", "GET", `/equipment?q=St Booked&summary=1&limit=1`);
    expect((before.body.summary as Record<string, number>).booked).toBe(0);
    await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayOffset(3), ends_at: dayOffset(4) });
    const after = await as("borrower", "GET", `/equipment?q=St Booked&summary=1&limit=1`);
    /* The old summary counted i.status='booked' — a value nothing writes — so
       this figure was structurally zero however many bookings existed. */
    expect((after.body.summary as Record<string, number>).booked).toBe(1);
    // And the asset is still available as far as its lifecycle is concerned.
    expect((after.body.summary as Record<string, number>).available).toBe(1);
  });

  it("counts overdue on the server's date, the same one custody uses", async () => {
    const id = await newAsset("St SumLate");
    await loanDue(id, A.borrower.id, dayOffset(-1));
    const r = await as("borrower", "GET", `/equipment?q=St SumLate&summary=1&limit=1`);
    expect((r.body.summary as Record<string, number>).overdue).toBe(1);
    const c = await as("borrower", "GET", `/equipment/custody?asset_id=${id}`);
    expect((c.body.items as Array<{ custody: { overdue: boolean } }>)[0].custody.overdue).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SERVER-COMPUTED ANALYTICS (Phase 6).

   eqAnalytics() reduced the arrays /state ships, and two of them are capped —
   transactions at "latest per item plus the most recent 500", bookings at
   "live, or ended within 90 days". Every figure it drew was therefore computed
   over a window nobody chose. The decisive test in here is the truncation
   proof: more history than those caps, and the counts still come out exact.
   ══════════════════════════════════════════════════════════════════════════ */

/** A ledger row written straight to the table — the fixtures below need
    thousands of them, and the endpoint's guards are not what they are testing. */
async function ledgerRow(itemId: number, action: "check_out" | "check_in", at?: string) {
  await pool.query(
    `INSERT INTO mo_equipment_transactions
       (equipment_item_id, holder_id, action, quantity, condition_noted, occurred_at, recorded_via, recorded_by)
     VALUES ($1,$2,$3,1,'good',COALESCE($4::timestamptz, NOW()),'desktop',$2)`,
    [itemId, A.borrower.id, action, at ?? null]);
}

interface Analytics {
  from: string | null; to: string | null;
  by_category: Array<{ category_id: string; category_name: string; items: number; checkouts: number }>;
  by_weekday: Array<{ dow: number; bookings: number }>;
  items: Array<{ id: string; asset_tag: string; checkouts: number;
                 maintenance_cost: number; purchase_cost: number | null; condition: string }>;
  total: number; limit: number; offset: number;
}
/** A category of this suite's own, so the aggregates are not other tests' rows. */
let anCategoryId = 0;
async function anCategory(): Promise<number> {
  if (anCategoryId) return anCategoryId;
  anCategoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (department_id, name, tracking_mode, icon, sort_order)
     VALUES (1,$1,'individual','A',95) RETURNING id`, [`${PX} analytics`])).rows[0].id);
  return anCategoryId;
}
/** An asset in that category, created directly so the fixtures stay cheap. */
async function anAsset(tag: string, over: Record<string, unknown> = {}): Promise<number> {
  const cat = await anCategory();
  return Number((await pool.query(
    `INSERT INTO mo_equipment_items (asset_tag, category_id, department_id, make, model,
                                     status, condition, purchase_cost, pool_quantity)
     VALUES ($1,$2,1,'ZEQ',$3,'available','good',$4,$5) RETURNING id`,
    [`EQ-${PX.toUpperCase()}-${tag}`, cat, tag, over.purchase_cost ?? 1000, over.pool_quantity ?? null]
  )).rows[0].id);
}
const analytics = async (actor: ActorName | "anon", qs = "") => {
  const r = await as(actor, "GET", `/equipment/analytics${qs}`);
  return { status: r.status, body: r.body as unknown as Analytics };
};
/** Analytics scoped to this suite's own category. */
const anScoped = async (extra = "") =>
  (await analytics("borrower", `?category_id=${await anCategory()}${extra}`)).body;

maybe("equipment analytics are computed by the database", () => {
  it("is gated like every other equipment read", async () => {
    expect((await analytics("nomodule")).status).toBe(403);
    expect((await analytics("outsider")).status).toBe(403);
    expect((await analytics("anon")).status).toBe(403);
    for (const who of ["borrower", "custodian", "admin"] as const)
      expect((await analytics(who)).status, who).toBe(200);
  });

  it("answers with zeros for a category that has nothing in it", async () => {
    const empty = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (department_id, name, tracking_mode, icon, sort_order)
       VALUES (1,$1,'individual','A',94) RETURNING id`, [`${PX} empty`])).rows[0].id);
    const a = (await analytics("borrower", `?category_id=${empty}`)).body;
    expect(a.items).toEqual([]);
    expect(a.total).toBe(0);
    expect(a.by_weekday.map((d) => d.bookings)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(a.by_category.find((c) => Number(c.category_id) === empty))
      .toMatchObject({ items: 0, checkouts: 0 });
  });

  it("counts checkouts per category across all of its assets", async () => {
    const one = await anAsset("CAT1"), two = await anAsset("CAT2");
    for (const id of [one, one, one, two]) await ledgerRow(id, "check_out");
    const a = await anScoped();
    const row = a.by_category.find((c) => Number(c.category_id) === anCategoryId)!;
    expect(row.checkouts).toBe(4);
    expect(row.items).toBe(2);
    expect(row.category_name).toBe(`${PX} analytics`);
  });

  it("counts check-ins as nothing — this metric is checkouts", async () => {
    const id = await anAsset("CHKIN");
    await ledgerRow(id, "check_out");
    for (let i = 0; i < 4; i++) await ledgerRow(id, "check_in");
    const a = await anScoped();
    expect(a.items.find((x) => Number(x.id) === id)!.checkouts).toBe(1);
  });

  it("buckets bookings by weekday, with 0 = Sunday as the browser counts them", async () => {
    const id = await anAsset("DOW");
    /* 2026-09-06 is a Sunday. Three bookings on Sundays, one on the Monday. */
    for (const d of ["2026-09-06", "2026-09-13", "2026-09-20", "2026-09-07"])
      await pool.query(
        `INSERT INTO mo_equipment_bookings (equipment_item_id,user_id,starts_at,ends_at,status,created_by)
         VALUES ($1,$2,$3,$3,'reserved',$2)`, [id, A.borrower.id, d]);
    const a = await anScoped();
    expect(a.by_weekday).toHaveLength(7);
    expect(a.by_weekday[0].bookings, "Sunday").toBe(3);
    expect(a.by_weekday[1].bookings, "Monday").toBe(1);
    expect(a.by_weekday.reduce((s, d) => s + d.bookings, 0)).toBe(4);
  });

  it("counts a booking whatever its status — the heatmap is demand, not use", async () => {
    const id = await anAsset("DEMAND");
    for (const [d, st] of [["2026-10-06", "reserved"], ["2026-10-13", "cancelled"],
                           ["2026-10-20", "completed"]] as const)
      await pool.query(
        `INSERT INTO mo_equipment_bookings (equipment_item_id,user_id,starts_at,ends_at,status,created_by)
         VALUES ($1,$2,$3,$3,$4,$2)`, [id, A.borrower.id, d, st]);
    const a = await anScoped();
    expect(a.by_weekday[2].bookings, "three Tuesdays, three statuses").toBe(3);
  });

  it("carries the per-item figures the table draws, and sorts by use", async () => {
    const busy = await anAsset("BUSY", { purchase_cost: 90000 });
    const idle = await anAsset("IDLE", { purchase_cost: 1200 });
    for (let i = 0; i < 5; i++) await ledgerRow(busy, "check_out");
    await ledgerRow(idle, "check_out");
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id,kind,description,cost,reported_by,started_at)
       VALUES ($1,'repair','a',1500,$2,CURRENT_DATE), ($1,'repair','b',500,$2,CURRENT_DATE)`,
      [busy, A.custodian.id]);
    const a = await anScoped();
    const mine = a.items.filter((x) => [busy, idle].includes(Number(x.id)));
    expect(mine.map((x) => Number(x.id)), "not sorted by checkouts").toEqual([busy, idle]);
    const b = mine[0];
    expect(b.checkouts).toBe(5);
    expect(b.maintenance_cost).toBe(2000);
    expect(Number(b.purchase_cost)).toBe(90000);
    expect(b.condition).toBe("good");
    expect(a.items.find((x) => Number(x.id) === idle)!.maintenance_cost,
      "an asset with no repairs should cost zero, not null").toBe(0);
  });

  it("leaves pooled assets out of the per-item table, as the table always has", async () => {
    const pooled = await anAsset("POOL", { pool_quantity: 12 });
    await ledgerRow(pooled, "check_out");
    const a = await anScoped();
    expect(a.items.map((x) => Number(x.id))).not.toContain(pooled);
    /* But its checkouts still count towards the category — the chart has never
       excluded them. */
    expect(a.by_category.find((c) => Number(c.category_id) === anCategoryId)!.checkouts)
      .toBeGreaterThan(0);
  });

  it("keeps retired assets in, because their history happened", async () => {
    const id = await anAsset("RETD");
    await ledgerRow(id, "check_out");
    await pool.query(`UPDATE mo_equipment_items SET status='retired' WHERE id=$1`, [id]);
    const a = await anScoped();
    expect(a.items.map((x) => Number(x.id)),
      "a retired asset's history vanished from analytics").toContain(id);
  });

  it("pages the per-item table and clamps a nonsense page", async () => {
    const a1 = await anScoped("&limit=2&offset=0");
    expect(a1.items.length).toBeLessThanOrEqual(2);
    expect(a1.limit).toBe(2);
    const a2 = await anScoped("&limit=2&offset=2");
    const ids1 = a1.items.map((x) => x.id), ids2 = a2.items.map((x) => x.id);
    expect(ids1.filter((x) => ids2.includes(x)), "pages overlapped").toEqual([]);
    expect((await anScoped("&limit=99999")).limit).toBe(200);
    expect((await anScoped("&limit=abc")).limit).toBe(50);
    expect((await anScoped("&offset=-3")).offset).toBe(0);
  });
});

maybe("analytics date range: inclusive at both ends", () => {
  it("counts only what falls inside the range, boundary days included", async () => {
    const id = await anAsset("RANGE");
    for (const d of ["2027-03-01", "2027-03-15", "2027-03-31", "2027-04-01"])
      await ledgerRow(id, "check_out", `${d}T09:00:00+05:30`);

    const inside = await anScoped("&from=2027-03-01&to=2027-03-31");
    expect(inside.items.find((x) => Number(x.id) === id)!.checkouts,
      "the first and last day of the range are inside it").toBe(3);

    const narrow = await anScoped("&from=2027-03-15&to=2027-03-15");
    expect(narrow.items.find((x) => Number(x.id) === id)!.checkouts).toBe(1);

    const after = await anScoped("&from=2027-04-01&to=2027-04-30");
    expect(after.items.find((x) => Number(x.id) === id)!.checkouts).toBe(1);
  });

  it("uses the IST day a timestamp falls on, not the UTC one", async () => {
    const id = await anAsset("TZ");
    /* 01:00 IST on the 2nd is 19:30 UTC on the 1st. The day it belongs to is
       the 2nd, which is the convention GET /equipment/transactions uses. */
    await ledgerRow(id, "check_out", "2027-06-02T01:00:00+05:30");
    const onTheSecond = await anScoped("&from=2027-06-02&to=2027-06-02");
    expect(onTheSecond.items.find((x) => Number(x.id) === id)!.checkouts).toBe(1);
    const onTheFirst = await anScoped("&from=2027-06-01&to=2027-06-01");
    expect(onTheFirst.items.find((x) => Number(x.id) === id)!.checkouts).toBe(0);
  });

  it("narrows the category chart and the weekday chart with the same range", async () => {
    const id = await anAsset("RANGE2");
    await ledgerRow(id, "check_out", "2027-08-10T09:00:00+05:30");
    await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id,user_id,starts_at,ends_at,status,created_by)
       VALUES ($1,$2,'2027-08-10','2027-08-11','reserved',$2)`, [id, A.borrower.id]);
    const inside = await anScoped("&from=2027-08-01&to=2027-08-31");
    expect(inside.by_category.find((c) => Number(c.category_id) === anCategoryId)!.checkouts).toBe(1);
    expect(inside.by_weekday.reduce((s, d) => s + d.bookings, 0)).toBe(1);
    const outside = await anScoped("&from=2027-09-01&to=2027-09-30");
    expect(outside.by_category.find((c) => Number(c.category_id) === anCategoryId)!.checkouts).toBe(0);
    expect(outside.by_weekday.reduce((s, d) => s + d.bookings, 0)).toBe(0);
  });

  it("means all of history when no range is given", async () => {
    const a = await anScoped();
    expect(a.from).toBeNull();
    expect(a.to).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE TRUNCATION PROOF.

   /state caps transactions at "the latest row per item plus the most recent
   500 overall", and bookings at "live, or ended within the last 90 days".
   Analytics built from those arrays cannot see past the cap. These fixtures
   are deliberately bigger than it, so anything that goes back to /state — or
   to any 500-row page — fails here.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("analytics count all of history, not the slice /state ships", () => {
  it("counts 1,200 checkouts on one asset, well past the 500-row cap", async () => {
    const id = await anAsset("BIGTX");
    const N = 1200;
    await pool.query(
      `INSERT INTO mo_equipment_transactions
         (equipment_item_id, holder_id, action, quantity, condition_noted, occurred_at, recorded_via, recorded_by)
       SELECT $1, $2, 'check_out', 1, 'good', NOW() - (g * INTERVAL '1 hour'), 'desktop', $2
         FROM generate_series(1, ${N}) g`, [id, A.borrower.id]);

    /* What /state would have shipped for this asset: its latest row, plus
       whatever of the most recent 500 overall happen to be its. The analytics
       figure must not be that number. */
    const capped = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_transactions t
        WHERE t.equipment_item_id = $1
          AND (t.id IN (SELECT DISTINCT ON (equipment_item_id) id FROM mo_equipment_transactions
                         ORDER BY equipment_item_id, occurred_at DESC, id DESC)
            OR t.id IN (SELECT id FROM mo_equipment_transactions
                         ORDER BY occurred_at DESC, id DESC LIMIT 500))`, [id])).rows[0].c);
    expect(capped, "the fixture is not bigger than the cap it is testing")
      .toBeLessThan(N);

    const a = await anScoped();
    const row = a.items.find((x) => Number(x.id) === id)!;
    expect(row.checkouts, `analytics counted ${row.checkouts}; /state would have shown ${capped}`)
      .toBe(N);
    expect(a.by_category.find((c) => Number(c.category_id) === anCategoryId)!.checkouts)
      .toBeGreaterThanOrEqual(N);
  });

  it("counts bookings older than the 90-day window /state keeps", async () => {
    const id = await anAsset("BIGBK");
    /* Non-overlapping, all completed, all well over 90 days old — every one of
       them outside what /state ships. */
    await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id,user_id,starts_at,ends_at,status,created_by)
       SELECT $1, $2, DATE '2024-01-01' + (g * 3), DATE '2024-01-01' + (g * 3) + 1, 'completed', $2
         FROM generate_series(1, 300) g`, [id, A.borrower.id]);
    const shipped = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings
        WHERE equipment_item_id=$1
          AND (status IN ('reserved','active') OR ends_at >= CURRENT_DATE - 90)`, [id])).rows[0].c);
    expect(shipped, "the fixture is not outside the window it is testing").toBe(0);

    const a = await anScoped();
    expect(a.by_weekday.reduce((s, d) => s + d.bookings, 0),
      "300 old bookings did not reach the heatmap").toBeGreaterThanOrEqual(300);
  });

  it("sums maintenance cost across a long repair history", async () => {
    const id = await anAsset("BIGMT");
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id,kind,description,cost,reported_by,started_at,resolved_at)
       SELECT $1,'repair','r'||g, 25, $2, CURRENT_DATE - (g*2), CURRENT_DATE - (g*2) + 1
         FROM generate_series(1, 600) g`, [id, A.custodian.id]);
    const a = await anScoped("&limit=200");
    expect(a.items.find((x) => Number(x.id) === id)!.maintenance_cost).toBe(600 * 25);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   THE BOOT CONTRACT (Phase 7).

   Three equipment history arrays left /state. These assert they are gone, that
   what remains is still there, and — the part that matters — that the endpoint
   which replaced each one actually answers. A future change that puts an array
   back, or that removes a lookup the UI still needs, fails here.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("/state no longer ships equipment history", () => {
  const boot = async () => {
    const r = await as("borrower", "GET", "/state");
    expect(r.status).toBe(200);
    return r.body as unknown as Record<string, unknown>;
  };

  it("carries no equipment history and no asset table", async () => {
    const st = await boot();
    for (const k of ["equipment_transactions", "equipment_bookings",
                     "maintenance_records", "equipment_items"])
      expect(st[k], `/state still ships ${k}`).toBeUndefined();
  });

  it("still carries the small lookups, which are not history", async () => {
    const st = await boot();
    /* Categories, kits and the kit membership rows: a few dozen rows that the
       UI needs to draw an icon and a name. The assets a kit points at are
       resolved through the asset cache, not shipped here. */
    for (const k of ["equipment_categories", "equipment_kits", "kit_items"])
      expect(Array.isArray(st[k]), `/state stopped shipping ${k}`).toBe(true);
  });

  /* THE REGRESSION THAT MATTERS. A boot payload with no assets in it, and a
     page that has a whole prototype estate compiled into it: equip() must
     answer from the server's cache or not at all. */
  it("has no asset rows at all in the payload", async () => {
    const st = await boot();
    const text = JSON.stringify(st);
    expect(text).not.toContain("\"equipment_items\"");
    expect(text).not.toContain("\"equipment_transactions\"");
  });

  it("still carries the session contract itself", async () => {
    const st = await boot();
    for (const k of ["users", "projects", "shoots", "shoot_crew"])
      expect(Array.isArray(st[k]), `/state stopped shipping ${k}`).toBe(true);
    expect(st.module_defaults, "module_defaults left the boot contract").toBeTruthy();
  });

  /* Each removed array, against the endpoint that replaced it. If a future
     change drops an array without its replacement working, one of these says
     which. */
  it("answers each removed array's question through its own read model", async () => {
    const id = await newAsset("Boot Contract");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("borrower", "POST", `/equipment/${id}/checkin`, {});
    await as("borrower", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayFromNow(4), ends_at: dayFromNow(5) });
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id,kind,description,reported_by,started_at)
       VALUES ($1,'repair','boot contract',$2,CURRENT_DATE)`, [id, A.custodian.id]);

    const tx = await as("borrower", "GET", `/equipment/transactions?asset_id=${id}`);
    expect(Number(tx.body.total), "transactions: no replacement").toBe(2);
    const bk = await as("borrower", "GET", `/equipment/bookings?asset_id=${id}`);
    expect(Number(bk.body.total), "bookings: no replacement").toBe(1);
    const mt = await as("borrower", "GET", `/equipment/maintenance?asset_id=${id}`);
    expect(Number(mt.body.total), "maintenance: no replacement").toBe(1);
  });

  /* Shoots asks for several shoots at once, which is what keeps the table one
     request instead of one per row. */
  it("answers the Shoots table's question for many shoots in one request", async () => {
    /* A project of this suite's own: the shoots table has a NOT NULL project,
       and a database with none would otherwise decide whether this runs. */
    const projectId = Number((await pool.query(
      `INSERT INTO mo_projects (project_type_id, code, name, created_by)
       VALUES ((SELECT id FROM mo_project_types ORDER BY id LIMIT 1), $1, $2, $3) RETURNING id`,
      [`${PX}-P1`, `${PX} project`, A.custodian.id])).rows[0].id);
    const shootIds: number[] = [];
    for (let i = 0; i < 3; i++)
      shootIds.push(Number((await pool.query(
        `INSERT INTO mo_shoots (project_id, title, shoot_date, call_time, end_time, location, status, created_by)
         VALUES ($3,$1,CURRENT_DATE,'09:00','18:00','Studio','planned',$2)
         RETURNING id`, [`${PX} shoot ${i}`, A.custodian.id, projectId])).rows[0].id));
    const assets: number[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await newAsset(`Shoot Kit ${i}`);
      assets.push(a);
      await pool.query(
        `INSERT INTO mo_equipment_bookings (equipment_item_id,user_id,shoot_id,starts_at,ends_at,status,created_by)
         VALUES ($1,$2,$3,CURRENT_DATE,CURRENT_DATE+1,'reserved',$2)`, [a, A.borrower.id, shootIds[i]]);
    }
    const r = await as("borrower", "GET",
      `/equipment/bookings?shoot_id=${shootIds.join(",")}&status=reserved,active&limit=200`);
    const rows = r.body.items as Array<{ shoot_id: string; asset_tag: string }>;
    expect(rows.length).toBe(3);
    expect(new Set(rows.map((x) => Number(x.shoot_id)))).toEqual(new Set(shootIds));
    /* The row carries the asset, so Shoots needs no second array to name it. */
    for (const row of rows) expect(row.asset_tag).toMatch(/^EQ-ZEQ-/);

    await pool.query(`DELETE FROM mo_equipment_bookings WHERE shoot_id = ANY($1::bigint[])`, [shootIds]);
    await pool.query(`DELETE FROM mo_shoots WHERE id = ANY($1::bigint[])`, [shootIds]);
    await pool.query(`DELETE FROM mo_projects WHERE id=$1`, [projectId]);
  });

  it("ignores nonsense in the shoot list rather than trusting it", async () => {
    const r = await as("borrower", "GET", "/equipment/bookings?shoot_id=abc,-1,0");
    expect(r.status).toBe(200);
    expect(Number(r.body.total), "a junk shoot list matched everything").toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17F — THE RULES A LOAN HAS TO SATISFY

   Three product decisions, each of which used to have no answer at all:

     D-1  pooled inventory cannot be checked out yet, and says so
     D-2  a loan may not run into somebody else's reservation
     D-3  a loan has an end date: required, in the future, within 30 days

   Every refusal below must also leave the ledger and the trail untouched. A
   system that refuses a checkout and audits one anyway is worse than one that
   never refused.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("a loan needs a due date", () => {
  const tryOut = (id: number, due: unknown) =>
    as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, ...(due === undefined ? {} : { expected_return_at: due }) });

  it("REFUSES a checkout with no due date at all", async () => {
    const id = await newAsset("Due None");
    const r = await tryOut(id, undefined);
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/expected return date is required/i);
    expect(await txCount(id), "a refused checkout still wrote to the ledger").toBe(0);
  });

  it("refuses null, an empty string and a non-date", async () => {
    const id = await newAsset("Due Junk");
    for (const bad of [null, "", "   ", "soon", "2026-13-45", "01/10/2026"]) {
      const r = await tryOut(id, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await txCount(id)).toBe(0);
  });

  it("REFUSES a date in the past — a loan cannot start overdue", async () => {
    /* The old handler accepted one. It produced a loan that was late the moment
       it was made, which then blocked the borrower from every further
       checkout under BR-7. */
    const id = await newAsset("Due Past");
    const r = await tryOut(id, dayFromNow(-1));
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/must be in the future/i);
    expect(await txCount(id)).toBe(0);
  });

  it("refuses today, because a loan runs to the END of some future day", async () => {
    const id = await newAsset("Due Today");
    expect((await tryOut(id, dayFromNow(0))).status).toBe(400);
  });

  it("refuses a loan longer than the policy window", async () => {
    const id = await newAsset("Due Long");
    const r = await tryOut(id, dayFromNow(31));
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/at most 30 days/i);
    expect((await tryOut(id, dayFromNow(30))).status, "the boundary itself was refused").toBe(201);
  });

  it("accepts tomorrow, and records the day it was given", async () => {
    const id = await newAsset("Due Ok");
    const due = dayFromNow(1);
    const r = await tryOut(id, due);
    expect(r.status).toBe(201);
    expect((r.body.transaction as unknown as { expected_return_at: string }).expected_return_at)
      .toContain(due);
  });

  it("judges the date on the SERVER's calendar", async () => {
    /* The browser's clock is not evidence. The boundary is computed in SQL, so
       a client in another timezone cannot talk its way past the window. */
    const id = await newAsset("Due Server");
    const serverToday = (await pool.query(
      `SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') AS d`)).rows[0].d as string;
    expect((await tryOut(id, serverToday)).status).toBe(400);
  });
});

maybe("pooled inventory cannot be checked out yet", () => {
  it("refuses it in words a person can act on, and writes nothing", async () => {
    const id = await newAsset("Pool Battery");
    await pool.query(
      `UPDATE mo_equipment_items SET tracking_mode='pooled', pool_quantity=48 WHERE id=$1`, [id]);
    const r = await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/pooled inventory/i);
    expect(await txCount(id), "a pooled checkout reached the ledger").toBe(0);
    /* And the pool itself is untouched — no quantity was decremented. */
    expect((await itemRow(id)).pool_quantity).toBe(48);
    expect((await itemRow(id)).status).toBe("available");
  });

  it("still lets a serialized asset in the same category through", async () => {
    const id = await newAsset("Pool Sibling");
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE })).status).toBe(201);
  });
});

maybe("a loan may not run into somebody else's reservation", () => {
  /* A reservation is an intent to hold; a checkout is custody. They are
     different domains and 17F does not merge them — but a walk-up that would
     still be out when the reservation begins is a reservation that will not be
     honoured, and the ledger is the wrong place to discover that. */
  const reserve = async (assetId: number, who: string, from: string, to: string) => {
    const r = await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, starts_at, ends_at, status, created_by)
       VALUES ($1,$2,$3::date,$4::date,'reserved',$2) RETURNING id`, [assetId, who, from, to]);
    return Number(r.rows[0].id);
  };

  it("ALLOWS a loan that ends before the reservation starts", async () => {
    const id = await newAsset("Rs Before");
    await reserve(id, A.borrower2.id, dayFromNow(10), dayFromNow(12));
    const r = await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(9) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });

  it("REFUSES a loan that would still be out when the reservation begins", async () => {
    const id = await newAsset("Rs Into");
    await reserve(id, A.borrower2.id, dayFromNow(10), dayFromNow(12));
    const r = await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(11) });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/reserved by somebody else/i);
    /* The message names the window, so the person can pick a date that works. */
    expect(String(r.body.message)).toContain(dayFromNow(10));
    expect(await txCount(id), "a refused checkout reached the ledger").toBe(0);
  });

  it("refuses a loan that starts inside a reservation already running", async () => {
    const id = await newAsset("Rs Now");
    await reserve(id, A.borrower2.id, dayFromNow(0), dayFromNow(3));
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(1) })).status).toBe(409);
  });

  it("does NOT block the person whose reservation it is", async () => {
    /* Turning up to collect what you booked is the happy path, not a conflict. */
    const id = await newAsset("Rs Mine");
    await reserve(id, A.borrower.id, dayFromNow(0), dayFromNow(5));
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(4) })).status).toBe(201);
  });

  it("ignores a cancelled or completed reservation", async () => {
    const id = await newAsset("Rs Dead");
    const bid = await reserve(id, A.borrower2.id, dayFromNow(2), dayFromNow(4));
    await pool.query(`UPDATE mo_equipment_bookings SET status='cancelled' WHERE id=$1`, [bid]);
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(3) })).status).toBe(201);
  });

  it("mutates no booking when it refuses", async () => {
    const id = await newAsset("Rs Intact");
    const bid = await reserve(id, A.borrower2.id, dayFromNow(6), dayFromNow(8));
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(7) });
    const b = (await pool.query(`SELECT status FROM mo_equipment_bookings WHERE id=$1`, [bid])).rows[0];
    expect(b.status, "a refused checkout changed a reservation").toBe("reserved");
  });
});

maybe("a refusal leaves no trace of success", () => {
  const auditCount = async (id: number, action: string) => Number((await pool.query(
    `SELECT COUNT(*)::int c FROM mo_audit_logs
      WHERE entity_type='equipment_item' AND entity_id=$1 AND action=$2`, [id, action])).rows[0].c);

  it("writes no checkout audit when validation fails", async () => {
    const id = await newAsset("Au NoDue");
    await as("custodian", "POST", `/equipment/${id}/checkout`, { holder_id: A.borrower.id });
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: dayFromNow(-1) });
    expect(await auditCount(id, "equipment.checked_out")).toBe(0);
    expect(await txCount(id)).toBe(0);
  });

  it("writes no check-in audit when there is nothing to return", async () => {
    const id = await newAsset("Au NoLoan");
    const r = await as("custodian", "POST", `/equipment/${id}/checkin`, {});
    expect(r.status).toBe(409);
    expect(await auditCount(id, "equipment.checked_in")).toBe(0);
    expect(await txCount(id)).toBe(0);
  });

  it("audits exactly one event for a checkout that did happen", async () => {
    const id = await newAsset("Au Ok");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    expect(await auditCount(id, "equipment.checked_out")).toBe(1);
    await as("custodian", "POST", `/equipment/${id}/checkin`, {});
    expect(await auditCount(id, "equipment.checked_in")).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17G — MODIFYING A RESERVATION (D-8)

   The booking keeps its identity. Cancel-and-recreate would have been easier,
   and it is what a UI does when the API gives it nothing better — but a shoot
   whose dates moved twice should read as one booking that moved twice, not
   three bookings of which two are cancelled, and a checkout made against the
   booking id would be pointing at a corpse.

   The exclusion constraint remains the authority. The new window is written and
   the database decides; nothing is pre-checked in JavaScript and then trusted.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("a reservation can be moved", () => {
  const book = async (actor: ActorName, id: number, s: string, e: string) => {
    const r = await as(actor, "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: s, ends_at: e });
    if (r.status !== 201) throw new Error(`booking fixture failed: ${r.status} ${JSON.stringify(r.body)}`);
    return Number((r.body.booking as { id: number }).id);
  };
  const row = async (bid: number) => (await pool.query(
    `SELECT status, to_char(starts_at,'YYYY-MM-DD') s, to_char(ends_at,'YYYY-MM-DD') e
       FROM mo_equipment_bookings WHERE id=$1`, [bid])).rows[0];

  it("moves the dates and keeps the same booking", async () => {
    const id = await newAsset("Mv Ok");
    const bid = await book("borrower", id, "2031-03-01", "2031-03-03");
    const r = await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-03-05", ends_at: "2031-03-07" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body.booking as unknown as Record<string, string>;
    expect(Number(b.id), "the booking was replaced rather than moved").toBe(bid);
    expect(b.starts_at).toBe("2031-03-05");
    expect(b.ends_at).toBe("2031-03-07");
    expect(await row(bid)).toMatchObject({ status: "reserved", s: "2031-03-05", e: "2031-03-07" });
  });

  it("extends a booking into free time", async () => {
    const id = await newAsset("Mv Extend");
    const bid = await book("borrower", id, "2031-04-01", "2031-04-03");
    expect((await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { ends_at: "2031-04-06" })).status).toBe(200);
    expect(await row(bid)).toMatchObject({ s: "2031-04-01", e: "2031-04-06" });
  });

  it("REFUSES a move into somebody else's window, and changes nothing", async () => {
    const id = await newAsset("Mv Clash");
    const mine = await book("borrower", id, "2031-05-01", "2031-05-03");
    await book("borrower2", id, "2031-05-10", "2031-05-12");
    const r = await as("borrower", "PATCH", `/equipment/bookings/${mine}`,
      { starts_at: "2031-05-09", ends_at: "2031-05-11" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/AC-7/);
    /* THE ORIGINAL SURVIVES. A failed move must not leave a half-moved booking. */
    expect(await row(mine)).toMatchObject({ status: "reserved", s: "2031-05-01", e: "2031-05-03" });
  });

  it("refuses a window the create endpoint would refuse, in the same words", async () => {
    const id = await newAsset("Mv Bad");
    const bid = await book("borrower", id, "2031-06-01", "2031-06-03");
    expect((await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-06-10", ends_at: "2031-06-01" })).status).toBe(400);
    const long = await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-06-01", ends_at: "2031-08-01" });
    expect(long.status).toBe(400);
    expect(String(long.body.message)).toMatch(/VR-8/);
    expect(await row(bid)).toMatchObject({ s: "2031-06-01", e: "2031-06-03" });
  });

  it("lets a booking keep one end and move the other", async () => {
    const id = await newAsset("Mv OneEnd");
    const bid = await book("borrower", id, "2031-07-01", "2031-07-03");
    expect((await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-07-02" })).status).toBe(200);
    expect(await row(bid)).toMatchObject({ s: "2031-07-02", e: "2031-07-03" });
  });

  it("reports an unchanged request as unchanged, without touching the row", async () => {
    const id = await newAsset("Mv Same");
    const bid = await book("borrower", id, "2031-08-01", "2031-08-03");
    const r = await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-08-01", ends_at: "2031-08-03" });
    expect(r.status).toBe(200);
    expect(r.body.changed).toBe(false);
  });

  it("will not move a booking that is finished", async () => {
    const id = await newAsset("Mv Done");
    const bid = await book("borrower", id, "2031-09-01", "2031-09-03");
    await pool.query(`UPDATE mo_equipment_bookings SET status='completed' WHERE id=$1`, [bid]);
    const r = await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-09-05", ends_at: "2031-09-06" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/completed/);
  });

  it("is refused to a bystander, and 404s across a scope boundary", async () => {
    const id = await newAsset("Mv Auth");
    const bid = await book("borrower", id, "2031-10-01", "2031-10-03");
    const bystander = await as("borrower2", "PATCH", `/equipment/bookings/${bid}`,
      { ends_at: "2031-10-05" });
    expect(bystander.status).toBe(403);
    /* A custodian may act on their inventory's bookings. */
    expect((await as("custodian", "PATCH", `/equipment/bookings/${bid}`,
      { ends_at: "2031-10-05" })).status).toBe(200);
    /* An id that does not exist answers the same way an inaccessible one does. */
    const ghost = await as("borrower", "PATCH", `/equipment/bookings/2147483600`, { ends_at: "2031-10-05" });
    expect(ghost.status).toBe(404);
    expect(String(ghost.body.message)).toBe("Booking not found.");
  });

  it("audits the move with both windows", async () => {
    const id = await newAsset("Mv Audit");
    const bid = await book("borrower", id, "2031-11-01", "2031-11-03");
    await as("borrower", "PATCH", `/equipment/bookings/${bid}`,
      { starts_at: "2031-11-05", ends_at: "2031-11-07" });
    const a = (await pool.query(
      `SELECT before, after FROM mo_audit_logs
        WHERE entity_type='equipment_booking' AND entity_id=$1 AND action='equipment.booking_changed'`,
      [bid])).rows[0];
    expect(a).toBeDefined();
    /* DAYS, not instants. Both snapshots are serialised the way every booking
       response is, so the trail and the API agree about what a date is. */
    expect((a.before as Record<string, string>).starts_at).toBe("2031-11-01");
    expect((a.after as Record<string, string>).starts_at).toBe("2031-11-05");
    expect(String((a.before as Record<string, string>).ends_at)).not.toMatch(/[TZ]/);
  });

  it("lets exactly one of two simultaneous moves into one window through", async () => {
    const id = await newAsset("Mv Race");
    const a = await book("borrower", id, "2032-01-01", "2032-01-02");
    const b = await book("borrower2", id, "2032-01-10", "2032-01-11");
    /* Both try to move onto the same free week. */
    const results = await Promise.all([
      as("borrower", "PATCH", `/equipment/bookings/${a}`, { starts_at: "2032-01-20", ends_at: "2032-01-22" }),
      as("borrower2", "PATCH", `/equipment/bookings/${b}`, { starts_at: "2032-01-21", ends_at: "2032-01-23" }),
    ]);
    const outcome = results
      .map((r) => `${r.status}:${String((r.body as { message?: string })?.message ?? "").slice(0, 50)}`).join(" | ");
    expect(results.filter((r) => r.status === 200).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    /* And the loser is still where it was. */
    const rows = (await pool.query(
      `SELECT id, to_char(starts_at,'YYYY-MM-DD') s FROM mo_equipment_bookings
        WHERE id = ANY($1::bigint[]) ORDER BY id`, [[a, b]])).rows;
    expect(rows.filter((r) => r.s === "2032-01-20" || r.s === "2032-01-21").length, outcome).toBe(1);
  });

  it("holds when a move races a create for the same window", async () => {
    const id = await newAsset("Mv VsCreate");
    const bid = await book("borrower", id, "2032-02-01", "2032-02-02");
    const results = await Promise.all([
      as("borrower", "PATCH", `/equipment/bookings/${bid}`, { starts_at: "2032-02-10", ends_at: "2032-02-12" }),
      as("borrower2", "POST", "/equipment/bookings",
        { equipment_item_id: id, starts_at: "2032-02-11", ends_at: "2032-02-13" }),
    ]);
    const outcome = results.map((r) => r.status).join(",");
    expect(results.filter((r) => r.status === 200 || r.status === 201).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17G — A RESERVATION THAT IS OVER (D-11)

   Nothing sweeps the booking table and no scheduler exists to. A reservation
   whose last day has passed is therefore still `reserved` in the column, and
   "is it over?" has to be answered from the dates. The places that already did
   that keep working; this is the one that did not.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("a reservation whose dates have passed is over", () => {
  /* A booking in the past, which the create endpoint will make (it validates
     the span, not the direction of travel) — this is how one comes to exist. */
  const stale = async (assetId: number, who: ActorName) => {
    const r = await as(who, "POST", "/equipment/bookings",
      { equipment_item_id: assetId, starts_at: dayFromNow(-9), ends_at: dayFromNow(-7) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number((r.body.booking as { id: number }).id);
  };

  it("does not block a new reservation later on", async () => {
    const id = await newAsset("Ex Later");
    await stale(id, "borrower");
    expect((await as("borrower2", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayFromNow(5), ends_at: dayFromNow(6) })).status).toBe(201);
  });

  it("does not block a checkout", async () => {
    const id = await newAsset("Ex Checkout");
    await stale(id, "borrower2");
    expect((await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE })).status).toBe(201);
  });

  it("is not the asset's current reservation", async () => {
    const id = await newAsset("Ex NotCurrent");
    await stale(id, "borrower");
    const st = (await as("borrower", "GET", `/equipment/${id}`)).body
      .item as unknown as { state: { reservation: unknown } };
    expect(st.state.reservation, "an expired booking was reported as the live one").toBeNull();
  });

  it("is excluded from the live filter, and kept in history", async () => {
    const id = await newAsset("Ex Filter");
    const bid = await stale(id, "borrower");
    const live = (await as("borrower", "GET",
      `/equipment/bookings?asset_id=${id}&status=reserved,active&live=1`))
      .body.items as unknown as { id: number }[];
    expect(live.map((x) => Number(x.id))).not.toContain(bid);
    /* Still reserved in the column, still readable, still auditable. */
    const all = (await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&status=reserved,active`))
      .body.items as unknown as { id: number; status: string }[];
    expect(all.map((x) => Number(x.id))).toContain(bid);
    expect(all.find((x) => Number(x.id) === bid)!.status).toBe("reserved");
    const past = (await as("borrower", "GET", `/equipment/bookings?asset_id=${id}&live=0`))
      .body.items as unknown as { id: number }[];
    expect(past.map((x) => Number(x.id))).toContain(bid);
  });

  it("still blocks a reservation that overlaps the window it actually held", async () => {
    /* Expiry is about TODAY, not about forgetting. The past window is still
       taken, which is what keeps the history honest. */
    const id = await newAsset("Ex Past");
    await stale(id, "borrower");
    expect((await as("borrower2", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: dayFromNow(-8), ends_at: dayFromNow(-8) })).status).toBe(409);
  });
});

maybe("booking boundaries are inclusive at both ends", () => {
  const tryBook = (actor: ActorName, id: number, s: string, e: string) =>
    as(actor, "POST", "/equipment/bookings", { equipment_item_id: id, starts_at: s, ends_at: e });

  it("treats the end of one booking and the start of the next as a clash", async () => {
    /* 10–12 and 12–14 OVERLAP: the 12th belongs to both, and an asset cannot be
       in two places on one day. Checkout uses the identical daterange test, so
       "conflicts" means one thing across the system. */
    const id = await newAsset("Bd Adjacent");
    expect((await tryBook("borrower", id, "2033-01-10", "2033-01-12")).status).toBe(201);
    expect((await tryBook("borrower2", id, "2033-01-12", "2033-01-14")).status).toBe(409);
  });

  it("allows the very next day", async () => {
    const id = await newAsset("Bd NextDay");
    expect((await tryBook("borrower", id, "2033-02-10", "2033-02-12")).status).toBe(201);
    expect((await tryBook("borrower2", id, "2033-02-13", "2033-02-14")).status).toBe(201);
  });

  it("refuses an identical, a nested and a containing window", async () => {
    const id = await newAsset("Bd Nested");
    expect((await tryBook("borrower", id, "2033-03-10", "2033-03-20")).status).toBe(201);
    for (const [s, e] of [["2033-03-10", "2033-03-20"], ["2033-03-12", "2033-03-14"],
                          ["2033-03-01", "2033-03-31"]] as const)
      expect((await tryBook("borrower2", id, s, e)).status, `${s}..${e}`).toBe(409);
  });

  it("refuses a second single-day booking on the same day", async () => {
    const id = await newAsset("Bd OneDay");
    expect((await tryBook("borrower", id, "2033-04-10", "2033-04-10")).status).toBe(201);
    expect((await tryBook("borrower2", id, "2033-04-10", "2033-04-10")).status).toBe(409);
  });

  it("lets a cancelled booking's window be taken", async () => {
    const id = await newAsset("Bd Cancelled");
    const mk = await tryBook("borrower", id, "2033-05-10", "2033-05-12");
    const bid = Number((mk.body.booking as { id: number }).id);
    expect((await tryBook("borrower2", id, "2033-05-11", "2033-05-13")).status).toBe(409);
    await as("borrower", "POST", `/equipment/bookings/${bid}/cancel`, {});
    expect((await tryBook("borrower2", id, "2033-05-11", "2033-05-13")).status).toBe(201);
  });

  it("returns the same date shape whether or not the booking was already cancelled", async () => {
    /* One endpoint, two exits: the second used to echo a raw row, so the dates
       came back as UTC instants for a pair of DATE columns. */
    const id = await newAsset("Bd CancelDates");
    const mk = await tryBook("borrower", id, "2033-06-10", "2033-06-12");
    const bid = Number((mk.body.booking as { id: number }).id);
    const first = await as("borrower", "POST", `/equipment/bookings/${bid}/cancel`, {});
    const again = await as("borrower", "POST", `/equipment/bookings/${bid}/cancel`, {});
    for (const r of [first, again]) {
      const b = r.body.booking as unknown as Record<string, string>;
      expect(b.starts_at).toBe("2033-06-10");
      expect(String(b.ends_at)).not.toMatch(/[TZ]/);
    }
  });

  it("audits a cancellation with days, not instants", async () => {
    const id = await newAsset("Bd CancelAudit");
    const mk = await tryBook("borrower", id, "2033-07-10", "2033-07-12");
    const bid = Number((mk.body.booking as { id: number }).id);
    await as("borrower", "POST", `/equipment/bookings/${bid}/cancel`, {});
    const a = (await pool.query(
      `SELECT before, after FROM mo_audit_logs
        WHERE entity_type='equipment_booking' AND entity_id=$1
          AND action='equipment.booking_cancelled'`, [bid])).rows[0];
    expect((a.before as Record<string, string>).starts_at).toBe("2033-07-10");
    expect((a.after as Record<string, string>).status).toBe("cancelled");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17I — CONDITION, MAINTENANCE CLOSURE AND INSPECTION

   The invariant this whole section exists to create:

     an open maintenance record  →  the asset cannot leave 'maintenance'
     resolving the last record   →  does NOT make it available
     an inspection that passes   →  may release it
     an inspection that fails    →  opens work and it stays put

   Before this phase a maintenance record could be opened and never closed: the
   only UPDATE of that table in the repository was a test fixture. An asset that
   went in for repair therefore carried an open record for ever, and returning
   it to service produced a contradiction — lifecycle 'available' beside open
   maintenance — that nothing could clear and nothing prevented.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("closing a maintenance record", () => {
  const openOne = async (assetId: number, desc = "ZEQ cracked filter") => {
    const r = await as("custodian", "POST", `/equipment/${assetId}/damage`, { description: desc });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number((r.body.record as { id: number }).id);
  };
  const resolve = (actor: ActorName, mid: number, note?: string) =>
    as(actor, "POST", `/equipment/maintenance/${mid}/resolve`,
       note === undefined ? {} : { resolution_note: note });
  const rec = async (mid: number) => (await pool.query(
    `SELECT resolved_at, resolved_by, resolution_note FROM mo_maintenance_records WHERE id=$1`,
    [mid])).rows[0];

  it("closes it, naming who closed it and why", async () => {
    const id = await newAsset("Mx Close");
    const mid = await openOne(id);
    const r = await resolve("custodian", mid, "New filter fitted.");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await rec(mid);
    expect(row.resolved_at).toBeTruthy();
    expect(row.resolved_by).toBe(A.custodian.id);
    expect(row.resolution_note).toBe("New filter fitted.");
  });

  it("returns the date as a day, not an instant", async () => {
    const id = await newAsset("Mx Dates");
    const mid = await openOne(id);
    const r = await resolve("custodian", mid, "done");
    const rr = r.body.record as unknown as Record<string, string>;
    expect(rr.resolved_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(rr.started_at)).not.toMatch(/[TZ]/);
  });

  it("DOES NOT put the asset back into service", async () => {
    /* D-2 — resolving repair work and returning a camera to the shelf are two
       decisions. Collapsing them is how gear goes back out because somebody
       ticked "repair done". */
    const id = await newAsset("Mx NotReleased");
    const mid = await openOne(id);
    expect((await itemRow(id)).status).toBe("maintenance");
    const r = await resolve("custodian", mid, "fixed");
    expect((await itemRow(id)).status, "resolving released the asset").toBe("maintenance");
    expect(r.body.awaiting_inspection).toBe(true);
    expect(Number(r.body.open_maintenance)).toBe(0);
  });

  it("reports what is still open when several records exist", async () => {
    const id = await newAsset("Mx Several");
    const a = await openOne(id, "ZEQ lens mount");
    await openOne(id, "ZEQ battery door");
    const r = await resolve("custodian", a, "one of two");
    expect(Number(r.body.open_maintenance)).toBe(1);
    expect(r.body.awaiting_inspection).toBe(false);
  });

  it("refuses to close the same record twice", async () => {
    const id = await newAsset("Mx Twice");
    const mid = await openOne(id);
    expect((await resolve("custodian", mid, "first")).status).toBe(200);
    const second = await resolve("custodian", mid, "again");
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toMatch(/already resolved/i);
    expect((await rec(mid)).resolution_note, "the second close overwrote the first").toBe("first");
  });

  it("is refused to the person who reported it, and to a bystander", async () => {
    /* D-1 — reporting a fault does not qualify anybody to sign it off. The
       holder who broke it is exactly who should not be closing the record. */
    const id = await newAsset("Mx Auth");
    const mid = await openOne(id);
    expect((await resolve("borrower", mid, "I fixed it myself")).status).toBe(403);
    expect((await resolve("borrower2", mid, "nothing to do with me")).status).toBe(403);
    expect((await rec(mid)).resolved_at).toBeNull();
    expect((await resolve("admin", mid, "signed off")).status).toBe(200);
  });

  it("404s a record that does not exist", async () => {
    const r = await resolve("custodian", 2147483600, "ghost");
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Maintenance record not found.");
  });

  it("lets exactly one of two simultaneous closures through", async () => {
    const id = await newAsset("Mx Race");
    const mid = await openOne(id);
    const results = await Promise.all([
      resolve("custodian", mid, "by A"),
      resolve("admin", mid, "by B"),
    ]);
    const outcome = results.map((r) => r.status).join(",");
    expect(results.filter((r) => r.status === 200).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs
        WHERE entity_type='equipment_item' AND entity_id=$1
          AND action='equipment.maintenance_resolved'`, [id])).rows[0].c),
      `two closures were audited · ${outcome}`).toBe(1);
  });
});

maybe("an asset with open work stays in maintenance", () => {
  const openOne = async (assetId: number) => Number(((await as("custodian", "POST",
    `/equipment/${assetId}/damage`, { description: "ZEQ open work" })).body as
    { record: { id: number } }).record.id);

  it("REFUSES the lifecycle transition out of maintenance", async () => {
    const id = await newAsset("Lk Blocked");
    const mid = await openOne(id);
    const r = await as("custodian", "POST", `/equipment/${id}/status`, { status: "available" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/open maintenance record/i);
    expect((await itemRow(id)).status).toBe("maintenance");
    /* Resolve it and the same call goes through. */
    await as("custodian", "POST", `/equipment/maintenance/${mid}/resolve`, { resolution_note: "done" });
    expect((await as("custodian", "POST", `/equipment/${id}/status`,
      { status: "available" })).status).toBe(200);
  });

  it("still allows retirement, which is not a return to service", async () => {
    const id = await newAsset("Lk Retire");
    await openOne(id);
    expect((await as("custodian", "POST", `/equipment/${id}/status`,
      { status: "retired" })).status).toBe(200);
  });

  it("does not let a CHECK-IN put it back on the shelf either", async () => {
    /* The other route to 'available'. A repair can be opened while the camera
       is already in somebody's hands, and returning it undamaged used to put
       it straight back into circulation with the work still open. */
    const id = await newAsset("Lk Checkin");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    await openOne(id);
    expect((await itemRow(id)).status, "custody was overwritten by a damage report").toBe("checked_out");
    const r = await as("custodian", "POST", `/equipment/${id}/checkin`, {});
    expect(r.status).toBe(201);
    expect((await itemRow(id)).status, "a check-in released an asset with open work").toBe("maintenance");
  });

  it("makes the open-maintenance / available contradiction unreachable", async () => {
    /* D-21 — the conflict detector stays as a diagnostic, but no write path
       can produce the state it detects. */
    const id = await newAsset("Lk NoConflict");
    await openOne(id);
    for (const attempt of [
      as("custodian", "POST", `/equipment/${id}/status`, { status: "available" }),
      as("custodian", "POST", `/equipment/${id}/status`, { status: "lost" }),
    ]) expect((await attempt).status).toBe(409);
    const st = (await as("custodian", "GET", `/equipment/${id}`)).body
      .item as unknown as { state: { conflicts: string[]; lifecycle: { status: string } } };
    expect(st.state.lifecycle.status).toBe("maintenance");
    expect(st.state.conflicts).toEqual([]);
  });
});

maybe("inspection is a record of what somebody saw", () => {
  const inspect = (actor: ActorName, id: number, body: Record<string, unknown>) =>
    as(actor, "POST", `/equipment/${id}/inspections`, body);
  const history = (actor: ActorName, id: number, qs = "") =>
    as(actor, "GET", `/equipment/${id}/inspections${qs}`);

  it("records the inspector, the condition, the outcome and the day", async () => {
    const id = await newAsset("In Basic");
    const r = await inspect("custodian", id, { observed_condition: "good", outcome: "passed" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const ins = r.body.inspection as unknown as Record<string, unknown>;
    expect(ins.inspector_id).toBe(A.custodian.id);
    expect(ins.observed_condition).toBe("good");
    expect(ins.outcome).toBe("passed");
    expect(ins.inspected_at).toBeTruthy();
    /* The observation becomes the asset's condition — it is the most recent
       thing anybody actually knows about it. */
    expect((await itemRow(id)).condition).toBe("good");
  });

  it("does NOT rewrite what the ledger recorded at checkout or check-in", async () => {
    /* D-11 — condition history is append-only. */
    const id = await newAsset("In Append");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("custodian", "POST", `/equipment/${id}/checkin`, { condition_noted: "poor" });
    const before = (await pool.query(
      `SELECT action, condition_noted FROM mo_equipment_transactions
        WHERE equipment_item_id=$1 ORDER BY id`, [id])).rows;
    await inspect("custodian", id, { observed_condition: "fair", outcome: "passed" });
    const after = (await pool.query(
      `SELECT action, condition_noted FROM mo_equipment_transactions
        WHERE equipment_item_id=$1 ORDER BY id`, [id])).rows;
    expect(after, "an inspection rewrote the custody ledger").toEqual(before);
  });

  it("opens the work it finds, and leaves the asset in maintenance", async () => {
    const id = await newAsset("In Fails");
    const r = await inspect("custodian", id,
      { observed_condition: "poor", outcome: "maintenance_required", notes: "Mount is cracked." });
    expect(r.status).toBe(201);
    expect((r.body.maintenance as unknown as { kind: string }).kind).toBe("repair");
    expect((await itemRow(id)).status).toBe("maintenance");
    expect((await itemRow(id)).condition).toBe("poor");
    expect(r.body.released).toBe(false);
  });

  it("will not fail an inspection without saying what is wrong", async () => {
    const id = await newAsset("In NoWhy");
    const r = await inspect("custodian", id,
      { observed_condition: "poor", outcome: "maintenance_required" });
    expect(r.status).toBe(400);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_asset_inspections WHERE equipment_item_id=$1`,
      [id])).rows[0].c), "a refused inspection was still recorded").toBe(0);
  });

  it("refuses an outcome and a condition nobody defined", async () => {
    const id = await newAsset("In Bad");
    expect((await inspect("custodian", id,
      { observed_condition: "mint", outcome: "passed" })).status).toBe(400);
    expect((await inspect("custodian", id,
      { observed_condition: "good", outcome: "looks_fine" })).status).toBe(400);
  });

  it("RELEASES a repaired asset when it passes, and only then", async () => {
    /* D-10 — the whole point of the phase. */
    const id = await newAsset("In Release");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ needs a service" })).body as { record: { id: number } }).record.id);

    /* While the work is open, a passing inspection may not release it. */
    const early = await inspect("custodian", id,
      { observed_condition: "good", outcome: "passed", release: true });
    expect(early.status).toBe(409);
    expect(String(early.body.message)).toMatch(/open maintenance record/i);
    expect((await itemRow(id)).status).toBe("maintenance");

    await as("custodian", "POST", `/equipment/maintenance/${mid}/resolve`, { resolution_note: "serviced" });
    /* Resolved, but still not available until somebody looks at it. */
    expect((await itemRow(id)).status).toBe("maintenance");

    const ok = await inspect("custodian", id,
      { observed_condition: "good", outcome: "passed", release: true });
    expect(ok.status).toBe(201);
    expect(ok.body.released).toBe(true);
    expect((await itemRow(id)).status).toBe("available");
  });

  it("does not release unless asked, even when it could", async () => {
    const id = await newAsset("In NoAsk");
    await as("custodian", "POST", `/equipment/${id}/status`, { status: "maintenance" });
    const r = await inspect("custodian", id, { observed_condition: "good", outcome: "passed" });
    expect(r.body.released).toBe(false);
    expect((await itemRow(id)).status).toBe("maintenance");
  });

  it("refuses to release something that is not in maintenance", async () => {
    const id = await newAsset("In NotMaint");
    const r = await inspect("custodian", id,
      { observed_condition: "good", outcome: "passed", release: true });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/not in maintenance/i);
  });

  it("is append-only — a correction is another inspection", async () => {
    /* D-25 — there is no PATCH, and the earlier judgement stays on the record. */
    const id = await newAsset("In Correct");
    await inspect("custodian", id,
      { observed_condition: "poor", outcome: "maintenance_required", notes: "Looked cracked." });
    await inspect("custodian", id,
      { observed_condition: "good", outcome: "passed", notes: "Second look — it was dirt." });
    const h = await history("custodian", id);
    const rows0 = h.body.items as unknown as Record<string, unknown>[];
    expect(rows0.length).toBe(2);
    expect(rows0[0].observed_condition, "newest first").toBe("good");
    expect(rows0[1].observed_condition, "the first judgement was rewritten").toBe("poor");
    expect((await as("custodian", "PATCH", `/equipment/${id}/inspections`, {})).status)
      .toBeGreaterThanOrEqual(400);
  });

  it("pages its history and names the inspector", async () => {
    const id = await newAsset("In Paged");
    for (let i = 0; i < 3; i++)
      await inspect("custodian", id, { observed_condition: "good", outcome: "passed" });
    const h = await history("custodian", id, "?limit=2&offset=0");
    expect((h.body.items as unknown as unknown[]).length).toBe(2);
    expect(Number(h.body.total)).toBe(3);
    expect((h.body.items as unknown as { inspector_name: string }[])[0].inspector_name).toBeTruthy();
  });

  it("is refused to a holder and a bystander", async () => {
    /* D-24 — being able to hand a camera back does not make somebody an
       inspector. */
    const id = await newAsset("In Auth");
    expect((await inspect("borrower", id, { observed_condition: "good", outcome: "passed" })).status).toBe(403);
    expect((await inspect("outsider", id, { observed_condition: "good", outcome: "passed" })).status).toBe(403);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_asset_inspections WHERE equipment_item_id=$1`,
      [id])).rows[0].c)).toBe(0);
  });

  it("refuses a retired asset", async () => {
    const id = await newAsset("In Retired");
    await as("custodian", "POST", `/equipment/${id}/retire`, { reason: "end of life" });
    expect((await inspect("custodian", id,
      { observed_condition: "good", outcome: "passed" })).status).toBe(409);
  });

  it("audits the inspection, and the release separately", async () => {
    const id = await newAsset("In Audit");
    await as("custodian", "POST", `/equipment/${id}/status`, { status: "maintenance" });
    await inspect("custodian", id, { observed_condition: "good", outcome: "passed", release: true });
    const acts = (await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='equipment_item' AND entity_id=$1
        ORDER BY id`, [id])).rows.map((r) => r.action);
    expect(acts).toContain("equipment.inspected");
    expect(acts.filter((a) => a === "equipment.status_changed").length).toBeGreaterThanOrEqual(1);
  });

  it("lets exactly one of two simultaneous releases through", async () => {
    const id = await newAsset("In RaceRelease");
    await as("custodian", "POST", `/equipment/${id}/status`, { status: "maintenance" });
    const results = await Promise.all([
      inspect("custodian", id, { observed_condition: "good", outcome: "passed", release: true }),
      inspect("admin", id, { observed_condition: "good", outcome: "passed", release: true }),
    ]);
    const outcome = results.map((r) => r.status).join(",");
    /* Both inspections are legitimate records — two people did look at it. Only
       one release happened, and the asset is available exactly once. */
    expect(results.filter((r) => (r.body as { released?: boolean }).released === true).length,
      outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    expect((await itemRow(id)).status).toBe("available");
  });

  it("cannot be released past a damage report filed a moment earlier", async () => {
    /* D-20 — the release re-reads open work under the lock that writes the
       status, so a report that commits first wins. */
    const id = await newAsset("In RaceDamage");
    await as("custodian", "POST", `/equipment/${id}/status`, { status: "maintenance" });
    const [rel] = await Promise.all([
      inspect("custodian", id, { observed_condition: "good", outcome: "passed", release: true }),
      as("admin", "POST", `/equipment/${id}/damage`, { description: "ZEQ found a crack" }),
    ]);
    const item = await itemRow(id);
    const open = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records
        WHERE equipment_item_id=$1 AND resolved_at IS NULL`, [id])).rows[0].c);
    /* Whichever order they landed in, the end state is never "available with
       open work on it". */
    expect(open > 0 ? item.status : "maintenance",
      `released=${String((rel.body as { released?: boolean }).released)} open=${open}`)
      .not.toBe(open > 0 ? "available" : "x");
  });

  it("404s across an inventory boundary, for both reading and writing", async () => {
    const id = await newAsset("In Scope");
    /* This suite's assets are unscoped, so a scoped custodian reaches them.
       The boundary case proper lives in the inventory-scope suites; what is
       asserted here is that an invented id answers the same way. */
    expect((await inspect("custodian", 2147483600,
      { observed_condition: "good", outcome: "passed" })).status).toBe(404);
    expect((await history("custodian", 2147483600)).status).toBe(404);
    expect((await history("custodian", id)).status).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17J — MAINTENANCE MANAGEMENT

   Three columns had existed since the schema was written, were returned by the
   API, drawn in the UI, and written by nothing: cost, vendor_id, next_due_at.
   And AUTO-8 — "Maintenance due / damage opened" — sat in the rules table
   enabled, with a lead_days knob an Admin could turn, referenced by no line of
   the automation runner.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("updating an open maintenance record", () => {
  const openOne = async (assetId: number) => Number(((await as("custodian", "POST",
    `/equipment/${assetId}/damage`, { description: "ZEQ initial report" })).body as
    { record: { id: number } }).record.id);
  const patch = (actor: ActorName, mid: number, body: Record<string, unknown>) =>
    as(actor, "PATCH", `/equipment/maintenance/${mid}`, body);
  const row = async (mid: number) => (await pool.query(
    `SELECT description, cost::text AS cost, vendor_id,
            to_char(next_due_at,'YYYY-MM-DD') AS next_due_at
       FROM mo_maintenance_records WHERE id=$1`, [mid])).rows[0];

  it("records what the repair cost, who did it, and when service is next due", async () => {
    const id = await newAsset("Up Full");
    const mid = await openOne(id);
    const vendor = Number((await pool.query(`SELECT id FROM mo_vendors ORDER BY id LIMIT 1`)).rows[0]?.id ?? 0);
    const r = await patch("custodian", mid, {
      description: "Lens mount replaced", cost: "2500.50",
      ...(vendor ? { vendor_id: vendor } : {}), next_due_at: dayFromNow(120) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = await row(mid);
    expect(after.description).toBe("Lens mount replaced");
    /* NUMERIC(12,2) — the money never became a float. */
    expect(after.cost).toBe("2500.50");
    expect(after.next_due_at).toBe(dayFromNow(120));
    if (vendor) expect(Number(after.vendor_id)).toBe(vendor);
  });

  it("returns dates as days, not instants", async () => {
    const id = await newAsset("Up Dates");
    const mid = await openOne(id);
    const r = await patch("custodian", mid, { next_due_at: dayFromNow(90) });
    const rec = r.body.record as unknown as Record<string, string>;
    expect(rec.next_due_at).toBe(dayFromNow(90));
    expect(String(rec.started_at)).not.toMatch(/[TZ]/);
  });

  it("allows an internal repair with no vendor", async () => {
    const id = await newAsset("Up NoVendor");
    const mid = await openOne(id);
    expect((await patch("custodian", mid, { vendor_id: null, cost: "0" })).status).toBe(200);
    expect((await row(mid)).vendor_id).toBeNull();
  });

  it("refuses a vendor that does not exist, and a nonsense cost", async () => {
    const id = await newAsset("Up Bad");
    const mid = await openOne(id);
    expect((await patch("custodian", mid, { vendor_id: 2147483600 })).status).toBe(400);
    expect((await patch("custodian", mid, { cost: "-5" })).status).toBe(400);
    expect((await patch("custodian", mid, { cost: "not money" })).status).toBe(400);
    expect((await patch("custodian", mid, { next_due_at: "next tuesday" })).status).toBe(400);
    expect((await row(mid)).description, "a refused update still wrote").toBe("ZEQ initial report");
  });

  it("REFUSES to move the record to another asset, or rewrite its history", async () => {
    const a = await newAsset("Up A");
    const bAsset = await newAsset("Up B");
    const mid = await openOne(a);
    for (const bad of [{ equipment_item_id: bAsset }, { kind: "maintenance" },
                       { started_at: "2020-01-01" }, { resolved_at: "2020-01-01" },
                       { resolved_by: A.custodian.id }, { reported_by: A.borrower.id }]) {
      const r = await patch("custodian", mid, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(String(r.body.message)).toMatch(/cannot be changed/i);
    }
    expect(Number((await pool.query(
      `SELECT equipment_item_id FROM mo_maintenance_records WHERE id=$1`, [mid])).rows[0].equipment_item_id))
      .toBe(a);
  });

  it("REFUSES to edit a record that has been resolved — it is history", async () => {
    const id = await newAsset("Up Closed");
    const mid = await openOne(id);
    await as("custodian", "POST", `/equipment/maintenance/${mid}/resolve`, { resolution_note: "done" });
    const r = await patch("custodian", mid, { cost: "100" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/resolved and is now history/i);
    expect((await row(mid)).cost).toBeNull();
  });

  it("is refused to a holder and a bystander", async () => {
    const id = await newAsset("Up Auth");
    const mid = await openOne(id);
    expect((await patch("borrower", mid, { cost: "10" })).status).toBe(403);
    expect((await patch("outsider", mid, { cost: "10" })).status).toBe(403);
    expect((await patch("admin", mid, { cost: "10" })).status).toBe(200);
  });

  it("404s a record that does not exist", async () => {
    const r = await patch("custodian", 2147483600, { cost: "10" });
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Maintenance record not found.");
  });

  it("does not let an update land on a record being resolved at the same moment", async () => {
    const id = await newAsset("Up Race");
    const mid = await openOne(id);
    const [p, rres] = await Promise.all([
      patch("custodian", mid, { cost: "999.00" }),
      as("admin", "POST", `/equipment/maintenance/${mid}/resolve`, { resolution_note: "closed" }),
    ]);
    const outcome = `patch=${p.status} resolve=${rres.status}`;
    expect(rres.status, outcome).toBe(200);
    /* The update either landed before the close or was refused as history.
       What must never happen is a closed record quietly changing afterwards. */
    expect([200, 409], outcome).toContain(p.status);
    const after = await row(mid);
    if (p.status === 409) expect(after.cost, outcome).toBeNull();
    expect((await pool.query(
      `SELECT resolved_at FROM mo_maintenance_records WHERE id=$1`, [mid])).rows[0].resolved_at,
      outcome).toBeTruthy();
  });

  it("does not weaken the lifecycle invariant", async () => {
    /* J-D13 — an update is not a way out of maintenance. */
    const id = await newAsset("Up Invariant");
    const mid = await openOne(id);
    await patch("custodian", mid, { cost: "10", next_due_at: dayFromNow(30) });
    expect((await itemRow(id)).status).toBe("maintenance");
    expect((await as("custodian", "POST", `/equipment/${id}/status`,
      { status: "available" })).status).toBe(409);
  });
});

maybe("opening maintenance tells the people who run that cupboard", () => {
  const notesFor = async (uid: string, mid: number) => Number((await pool.query(
    `SELECT COUNT(*)::int c FROM mo_notifications
      WHERE user_id=$1 AND entity_type='maintenance' AND entity_id=$2`, [uid, mid])).rows[0].c);

  it("notifies the custodian when damage is reported", async () => {
    const id = await newAsset("Nt Damage");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ cracked" })).body as { record: { id: number } }).record.id);
    expect(await notesFor(A.custodian.id, mid)).toBe(1);
  });

  it("notifies when BR-8 opens one on return, and when an inspection fails", async () => {
    const id = await newAsset("Nt BR8");
    await as("custodian", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.borrower.id, expected_return_at: DUE });
    await as("custodian", "POST", `/equipment/${id}/checkin`, { condition_noted: "poor" });
    const br8 = Number((await pool.query(
      `SELECT id FROM mo_maintenance_records WHERE equipment_item_id=$1 ORDER BY id DESC LIMIT 1`,
      [id])).rows[0].id);
    expect(await notesFor(A.custodian.id, br8)).toBe(1);

    const other = await newAsset("Nt Inspect");
    const r = await as("custodian", "POST", `/equipment/${other}/inspections`,
      { observed_condition: "poor", outcome: "maintenance_required", notes: "ZEQ mount cracked" });
    const mid = Number((r.body.maintenance as unknown as { id: number }).id);
    expect(await notesFor(A.custodian.id, mid)).toBe(1);
  });

  it("does not notify somebody with no business seeing the asset", async () => {
    const id = await newAsset("Nt Scope");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ scoped" })).body as { record: { id: number } }).record.id);
    /* A plain borrower is not a custodian and runs no inventory. */
    expect(await notesFor(A.borrower.id, mid)).toBe(0);
    expect(await notesFor(A.outsider.id, mid)).toBe(0);
  });
});

maybe("AUTO-8 stops being a rule that does nothing", () => {
  const run = async () => (await import("./mediaops-api.js")).runMediaOpsAutomations();

  it("survives a recipient who cannot be written to, and says how many", async () => {
    /* THE WHOLE PASS USED TO DIE ON ONE ROW. The recipient lists are read at
       the top and used in a loop below; an account deleted in between makes
       the notification insert fail its foreign key, and unguarded that threw
       out of the loop — cancelling every later overdue notice AND the whole
       maintenance-due rule after it. It showed up as five AUTO-8 assertions
       failing at once for a reason that had nothing to do with AUTO-8.

       The race is a real one and it is not reproducible to order: it needs a
       user to vanish between two statements inside a function this test calls
       from outside. So the runtime half asserts the contract — the pass
       completes and reports what it could not deliver — and the source half
       asserts the guard is still there, the way db-pool-safety.test.ts pins
       invariants that cannot be provoked on demand. */
    const r = await run();
    expect(typeof r.undeliverable, "the pass stopped reporting undeliverable recipients")
      .toBe("number");
    expect(r.undeliverable).toBeGreaterThanOrEqual(0);

    const src = (await import("node:fs")).readFileSync("server/mediaops-api.ts", "utf8");
    const body = src.slice(src.indexOf("export async function runMediaOpsAutomations"));
    const fn = body.slice(body.indexOf("const notify ="), body.indexOf("const notify =") + 900);
    expect(fn, "the automation's notify() lost its guard — one bad recipient can kill the pass again")
      .toMatch(/try\s*\{[\s\S]*INSERT INTO mo_notifications[\s\S]*\}\s*catch/);
  });
  const notesFor = async (uid: string, mid: number, kind: string) => Number((await pool.query(
    `SELECT COUNT(*)::int c FROM mo_notifications
      WHERE user_id=$1 AND entity_type='maintenance' AND entity_id=$2 AND kind=$3`,
    [uid, mid, kind])).rows[0].c);

  it("tells the custodian about service falling due, ahead of the date", async () => {
    const id = await newAsset("A8 Due");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ serviced" })).body as { record: { id: number } }).record.id);
    await as("custodian", "PATCH", `/equipment/maintenance/${mid}`, { next_due_at: dayFromNow(3) });
    await run();
    expect(await notesFor(A.custodian.id, mid, "maintenance_due")).toBe(1);
  });

  it("says nothing about a date beyond the lead window", async () => {
    const id = await newAsset("A8 Far");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ far off" })).body as { record: { id: number } }).record.id);
    await as("custodian", "PATCH", `/equipment/maintenance/${mid}`, { next_due_at: dayFromNow(300) });
    await run();
    expect(await notesFor(A.custodian.id, mid, "maintenance_due")).toBe(0);
  });

  it("DOES NOT create maintenance records — 17J has no recurrence", async () => {
    const id = await newAsset("A8 NoCreate");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ count me" })).body as { record: { id: number } }).record.id);
    await as("custodian", "PATCH", `/equipment/maintenance/${mid}`, { next_due_at: dayFromNow(1) });
    const before = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records WHERE equipment_item_id=$1`, [id])).rows[0].c);
    await run();
    await run();
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records WHERE equipment_item_id=$1`, [id])).rows[0].c),
      "the automation invented work orders").toBe(before);
  });

  it("does not spam: running it twice tells nobody twice", async () => {
    const id = await newAsset("A8 Once");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ once" })).body as { record: { id: number } }).record.id);
    await run();
    await run();
    await run();
    expect(await notesFor(A.custodian.id, mid, "maintenance"),
      "the runner notified the same person about the same record repeatedly").toBe(1);
  });

  it("stays quiet about a resolved record", async () => {
    const id = await newAsset("A8 Closed");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ closed" })).body as { record: { id: number } }).record.id);
    /* Clear the notice the open path already sent, then close it. */
    await pool.query(`DELETE FROM mo_notifications WHERE entity_type='maintenance' AND entity_id=$1`, [mid]);
    await as("custodian", "POST", `/equipment/maintenance/${mid}/resolve`, { resolution_note: "done" });
    await run();
    expect(await notesFor(A.custodian.id, mid, "maintenance")).toBe(0);
  });

  it("does not leak another inventory's asset tag", async () => {
    /* The notice carries an asset tag, which is exactly what inventory scope
       exists to keep inside its own cupboard. */
    const id = await newAsset("A8 Scope");
    const mid = Number(((await as("custodian", "POST", `/equipment/${id}/damage`,
      { description: "ZEQ scoped" })).body as { record: { id: number } }).record.id);
    await run();
    expect(await notesFor(A.borrower.id, mid, "maintenance")).toBe(0);
    expect(await notesFor(A.outsider.id, mid, "maintenance")).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   SCANNING A LABEL — the resolution cases the earlier phases did not cover.

   Resolution itself, the internal code, the asset tag, an unknown token, a
   duplicate value and the cross-inventory silence are all tested already
   (this file and mediaops-inventory-scope-auth). What follows is the rest of
   the list a scanner actually meets in a store cupboard: a barcode instead of
   a QR, a label somebody typed badly, an asset that has been retired, and one
   that has been deleted.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("a scanned label resolves, or says nothing useful", () => {
  const resolve = (actor: ActorName, v: string) =>
    as(actor, "GET", `/equipment/resolve/${encodeURIComponent(v)}`);

  it("resolves a barcode, because the table stores the kind and matches the value", async () => {
    const id = await newAsset("Barcoded");
    const bc = `${PX}-BC-8901234567890`;
    const add = await as("custodian", "POST", `/equipment/${id}/identifiers`,
      { kind: "barcode", value: bc });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const r = await resolve("custodian", bc);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Number((r.body.item as unknown as { id: number }).id)).toBe(id);
    /* And it says where it matched, so a worn label can be told from a QR. */
    expect((r.body.matched as unknown as { kind: string }).kind).toBe("barcode");
  });

  it("gives a malformed identifier the same nothing as an unknown one", async () => {
    /* Whatever somebody's fingers or a damaged label produce, it is a string
       to look up — never a pattern to interpret, and never an error that
       distinguishes "wrong shape" from "not yours". */
    const junk = ["../../etc/passwd", "'; DROP TABLE mo_equipment_items; --",
                  "%00", "<script>alert(1)</script>", "A".repeat(400), "🙂🙂🙂"];
    for (const v of junk) {
      const r = await resolve("custodian", v);
      expect([400, 404], `${v} → ${r.status}`).toContain(r.status);
      if (r.status === 404)
        expect(String(r.body.message)).toBe("No asset carries that identifier.");
    }
    /* The estate is still there, which is the point of the third one. */
    expect((await resolve("custodian", "AT-NOTHING")).status).toBe(404);
  });

  it("still resolves a RETIRED asset, because the label is on a real object", async () => {
    /* Retired is a lifecycle fact, not a disappearance. Somebody holding the
       camera and scanning it deserves to be told what it is and that it is
       retired — refusing would leave them with an unidentifiable object. */
    const id = await newAsset("Retire Scan");
    const tag = String((await pool.query(
      `SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].asset_tag);
    expect((await as("custodian", "POST", `/equipment/${id}/retire`,
      { reason: "ZEQ end of life" })).status).toBe(200);
    const r = await resolve("custodian", tag);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const item = r.body.item as unknown as { status: string; state: { lifecycle: { status: string } } };
    expect(item.status, "a retired asset resolved as something else").toBe("retired");
    expect(item.state.lifecycle.status).toBe("retired");
  });

  it("stops resolving a DELETED asset, and does not say it ever existed", async () => {
    const id = await newAsset("Deleted Scan");
    const tag = String((await pool.query(
      `SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].asset_tag);
    expect((await resolve("custodian", tag)).status).toBe(200);
    await pool.query(`UPDATE mo_equipment_items SET deleted_at=NOW() WHERE id=$1`, [id]);
    const gone = await resolve("custodian", tag);
    const never = await resolve("custodian", "EQ-ZEQ-NEVER-EXISTED");
    expect(gone.status).toBe(404);
    /* Byte-identical to a tag nobody ever issued. */
    expect(JSON.stringify(gone.body)).toBe(JSON.stringify(never.body));
    await pool.query(`UPDATE mo_equipment_items SET deleted_at=NULL WHERE id=$1`, [id]);
  });

  it("is refused to a caller with no equipment module at all", async () => {
    const id = await newAsset("NoMod Scan");
    const tag = String((await pool.query(
      `SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].asset_tag);
    expect((await resolve("outsider", tag)).status).toBe(403);
  });
});
