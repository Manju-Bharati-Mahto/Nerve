// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Asset 360° registry (Phase 17E).

   The detail page asks eight questions about one asset, and this file is about
   two properties of the answers.

   THEY STAY APART. Lifecycle, custody, verification, reservation and
   maintenance are five independent facts. The database keeps five columns and
   two tables; the read model keeps five named dimensions; nothing anywhere
   collapses them into one availability word. An asset can be active, checked
   out, pending verification, reserved and under repair, and every one of those
   is separately true.

   THEY ARE BOUNDED. History grows without limit, so every section is a page
   from the server. A section that returned everything would be a page that
   works for thirty assets and falls over at ten thousand — which is the exact
   mistake Phases 7 and 8 removed from /state and that this phase must not
   reintroduce one asset at a time.

   Fixtures are prefixed `zar`.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zar";
let dbUp = false;
/* PHASE 17F — a checkout needs a due date the SERVER will accept: in the
   future and inside the 30-day policy window. Captured from the database, not
   written as a literal, because a literal stops being in the future. */
let DUE = "";
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0, dutyId = 0, mediaCrew = 0, pid = 0;

const A = {
  admin:   { id: `${PX}-admin`, role: "admin", team: "media" },
  custMC:  { id: `${PX}-cmc`,   role: "user",  team: "media" },
  custPID: { id: `${PX}-cpid`,  role: "user",  team: "media" },
  plain:   { id: `${PX}-plain`, role: "user",  team: "media" },
  outsider:{ id: `${PX}-out`,   role: "user",  team: "branding" },
  /* An institute STUDENT. SMC members are students on the coverage network
     with real Nerve accounts — the identity an academic lending story would
     use — and team='smc' is what makes them one. */
  student: { id: `${PX}-student`, role: "user", team: "smc" },
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
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZAR ${a.id}` }
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
/* ── THE DAY THE SERVER IS HAVING ─────────────────────────────────────────
   Every date rule in this module is IST: the API compares against
   (NOW() AT TIME ZONE 'Asia/Kolkata')::date, and the fixtures that use SQL
   compare against the database's own CURRENT_DATE, which is the same day.
   `new Date().toISOString()` is the UTC day, and between 18:30 and 24:00 UTC
   those are DIFFERENT DAYS.

   That is not theoretical. This file's five local `day()` helpers all computed
   the UTC day, and at 20:48 UTC the project fixture — created with
   CURRENT_DATE + 10 — came back one day ahead of the day(10) it was compared
   against:

       expected '2026-10-04' to be '2026-10-03'

   Deterministic inside that window and invisible outside it, which is the worst
   shape a date bug can have: it passes all day and fails all evening. The
   sibling scope-auth suite has carried an istDay() for exactly this reason;
   this is that helper, shared, so a sixth block cannot reintroduce the UTC one. */
const IST_OFFSET_MS = 5.5 * 3_600_000;
const istDay = (offset = 0) =>
  new Date(Date.now() + offset * 86_400_000 + IST_OFFSET_MS).toISOString().slice(0, 10);

const mk = (actor: ActorName, body: Record<string, unknown> = {}) =>
  as(actor, "POST", "/equipment", { category_id: categoryId, make: "ZAR", model: "FX3", ...body });
const idOf = (r: { body: Record<string, never> }) =>
  Number((r.body.item as unknown as { id: number }).id);
const rows = (r: { body: Record<string, never> }) =>
  r.body.items as unknown as Record<string, unknown>[];

/* EVERY CATEGORY THIS FILE OWNS.

   Not just `zar %`. The asset-tag prefix is the first three LETTERS of the
   category name while the counter is per-category, so two categories both
   beginning "zar" each start at EQ-ZAR-001 and the second registration dies on
   the unique index. Phase 17N's fixtures therefore need their own three-letter
   stems — and anything this file creates, this file has to delete. */
const CATS = [`${PX} %`, "zna %", "zns %", "zop %", "zoq %", "zor %", "zos %",
              "zpb %", "zpc %", "zrp %"];

async function cleanup() {
  const ids = (await pool.query(
    `SELECT id FROM mo_equipment_items WHERE asset_tag LIKE $1
       OR category_id IN (SELECT id FROM mo_equipment_categories WHERE name LIKE ANY($2::text[]))`,
    [`EQ-${PX.toUpperCase()}-%`, CATS])).rows.map((r) => Number(r.id));
  if (ids.length) {
    await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_maintenance_records WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_audit_logs WHERE entity_type='equipment_item' AND entity_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  /* Policies reference categories. ON DELETE CASCADE would take them anyway,
     but deleting them by name keeps the teardown saying what it removes. */
  await pool.query(
    `DELETE FROM mo_inspection_policies WHERE category_id IN
       (SELECT id FROM mo_equipment_categories WHERE name LIKE ANY($1::text[]))`, [CATS]);
  await pool.query(`DELETE FROM mo_equipment_categories WHERE name LIKE ANY($1::text[])`, [CATS]);
  /* PROJECTS AND EVERYTHING POINTING AT THEM, before the users that created
     them. Phase 17H added projects to this suite and this teardown did not know
     about them, so `DELETE FROM users` tripped mo_projects_created_by_fkey —
     the same shape as the cross-suite failure 17F spent three sightings
     diagnosing, this time entirely self-inflicted. Children first, then the
     parent, then the actor. */
  await pool.query(`DELETE FROM mo_equipment_bookings WHERE project_id IN
                      (SELECT id FROM mo_projects WHERE code LIKE $1)
                       OR shoot_id IN (SELECT id FROM mo_shoots WHERE title LIKE $2)`,
    [`${PX}-%`, `${PX} %`]);
  await pool.query(`DELETE FROM mo_shoots WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_projects WHERE code LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
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
      [a.id, `ZAR ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  for (const a of [A.admin, A.custMC, A.custPID, A.plain])
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZAR','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules`,
      [a.id, JSON.stringify(["home", "my-day", "equipment"])]);

  dutyId = Number((await pool.query(
    `SELECT id FROM mo_duty_flags WHERE code='equipment_custodian'`)).rows[0].id);
  for (const a of [A.custMC, A.custPID])
    await pool.query(`INSERT INTO mo_user_duties (user_id, duty_flag_id, granted_at)
                      VALUES ($1,$2,CURRENT_DATE) ON CONFLICT DO NOTHING`, [a.id, dutyId]);

  /* '<zxx> Something' — the fixture-category shape the sibling suites use to
     tell a test's assets from the registry's. TEST_STABILITY entry 15. */
  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',9999) RETURNING id`, [`${PX} Camera`])).rows[0].id);
  mediaCrew = Number((await pool.query(
    `SELECT id FROM mo_inventory_scopes WHERE code='media_crew'`)).rows[0].id);
  pid = Number((await pool.query(
    `SELECT id FROM mo_inventory_scopes WHERE code='pid'`)).rows[0].id);

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
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_maintenance_records WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_audit_logs WHERE entity_type='equipment_item' AND entity_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(`DELETE FROM mo_user_inventory_scopes WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(
    `INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by) VALUES ($1,$2,$3),($4,$5,$3)
     ON CONFLICT DO NOTHING`, [A.custMC.id, mediaCrew, A.admin.id, A.custPID.id, pid]);
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE FIVE DIMENSIONS
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the asset's state has five separate answers", () => {
  it("names all five, and marks which are persisted", async () => {
    const r = await as("admin", "GET", `/equipment/${idOf(await mk("admin", { scope_id: mediaCrew }))}`);
    const st = (r.body.item as unknown as { state: Record<string, Record<string, unknown>> }).state;
    expect(Object.keys(st)).toEqual(expect.arrayContaining(
      ["lifecycle", "custody", "verification", "reservation", "maintenance"]));
    expect(st.lifecycle.persisted).toBe(true);
    expect(st.verification.persisted).toBe(true);
  });

  it("reports verification beside the others, without inventing a state", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, verification_state: "draft" }));
    const st = () => as("admin", "GET", `/equipment/${id}`)
      .then((r) => (r.body.item as unknown as { state: { verification: Record<string, unknown> } }).state.verification);
    expect(await st()).toMatchObject({ state: "draft", in_inventory: false, note: null });
    await as("admin", "POST", `/equipment/${id}/verification`, { action: "submit" });
    await as("admin", "POST", `/equipment/${id}/verification`, { action: "approve" });
    expect(await st()).toMatchObject({ state: "active", in_inventory: true });
    /* The four Phase 17D words, and no fifth. 'approved' is the ACT. */
    expect(["draft", "pending_verification", "active", "rejected"])
      .toContain((await st()).state);
  });

  it("NEVER collapses them into one availability word", async () => {
    /* Checked out, reserved, under repair and pending verification at once —
       four true statements about one camera, none of which overrides another. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
    await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, starts_at, ends_at, status)
       VALUES ($1,$2,CURRENT_DATE + 30, CURRENT_DATE + 31,'reserved')`, [id, A.admin.id]);
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, started_at)
       VALUES ($1,'repair','ZAR lens mount', CURRENT_DATE)`, [id]);
    await pool.query(`UPDATE mo_equipment_items SET verification_state='draft' WHERE id=$1`, [id]);

    const st = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as { state: Record<string, Record<string, unknown>> };
    expect(st.state.custody.status).toBe("checked_out");
    expect(st.state.reservation).not.toBeNull();
    expect(st.state.maintenance.active).toBe(true);
    expect(st.state.verification.state).toBe("draft");
    expect(st.state.lifecycle.status).toBe("checked_out");
    /* No such field, deliberately. */
    expect(st.state).not.toHaveProperty("available");
    expect(st.state).not.toHaveProperty("unavailable");
  });

  it("reports a contradiction rather than resolving it", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
    await pool.query(`UPDATE mo_equipment_items SET status='maintenance' WHERE id=$1`, [id]);
    const st = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as { state: { conflicts: string[]; custody: { status: string } } };
    expect(st.state.conflicts.length).toBeGreaterThan(0);
    expect(st.state.custody.status).toBe("checked_out");   // both facts survive
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE READ MODEL RETURNS THE VALUE IT NAMES  (Phase 17E.1)

   ASSET_SELECT joins the asset to its category and its inventory, and all three
   tables have columns called id, name, created_at and updated_at. node-postgres
   builds the row object key by key in result order, so a projection that emits
   two columns under one name silently keeps the LAST — which is exactly how the
   item-level tracking_mode override was discarded for four phases without a
   single test noticing.

   The reason it went unnoticed is the point of this group: the tests that
   exercised pooling put the pooled item in a pooled category, where the item's
   answer and the category's agree, so either one passing looks like success.
   Every test below makes the sources DISAGREE, so a lost alias cannot pass.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the read model returns the value it names", () => {
  it("takes tracking_mode from the ITEM when the category says otherwise", async () => {
    /* The regression test for the original defect. The fixture category is
       'individual'; the item says 'pooled'. Whichever column the projection
       emits last, only one of these answers is correct. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Disagrees",
      tracking_mode: "pooled", pool_quantity: 12 }));
    const cat = (await pool.query(
      `SELECT tracking_mode FROM mo_equipment_categories WHERE id=$1`, [categoryId])).rows[0];
    expect(cat.tracking_mode, "the fixture stopped being adversarial").toBe("individual");
    const item = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, unknown>;
    expect(item.tracking_mode).toBe("pooled");
    /* And the category's own default is still readable, under its own name. */
    expect(item.category_tracking_mode).toBe("individual");
  });

  it("still falls back to the category when the item does not say", async () => {
    /* The other half of the COALESCE: aliasing must not turn the fallback off. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Inherits" }));
    await pool.query(`UPDATE mo_equipment_items SET tracking_mode=NULL WHERE id=$1`, [id]);
    const item = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, unknown>;
    expect(item.tracking_mode).toBe("individual");
  });

  it("takes the id from the ASSET, not from its category or its inventory", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "WhoseId" }));
    const item = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, unknown>;
    expect(Number(item.id)).toBe(id);
    expect(Number(item.id)).not.toBe(categoryId);
    expect(Number(item.id)).not.toBe(mediaCrew);
  });

  it("takes the timestamps from the ASSET, not from its inventory", async () => {
    /* The seeded inventories were created by a migration long before any asset,
       so an inventory timestamp leaking through is visible as a date that
       predates the row it is attached to. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Timestamps" }));
    const mine = (await pool.query(
      `SELECT created_at, updated_at FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
    const theirs = (await pool.query(
      `SELECT created_at, updated_at FROM mo_inventory_scopes WHERE id=$1`, [mediaCrew])).rows[0];
    const item = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, string>;
    expect(new Date(item.created_at).getTime()).toBe(new Date(mine.created_at as string).getTime());
    expect(new Date(item.updated_at).getTime()).toBe(new Date(mine.updated_at as string).getTime());
    if (theirs?.created_at)
      expect(new Date(item.created_at).getTime())
        .not.toBe(new Date(theirs.created_at as string).getTime());
  });

  it("gives the category's and the inventory's names their own keys, never a bare one", async () => {
    /* `name` and `code` exist on mo_inventory_scopes and `name` on
       mo_equipment_categories. An unaliased one would arrive as `name`/`code`
       and read as though it belonged to the asset. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Named" }));
    const item = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, unknown>;
    expect(item.category_name).toBeTruthy();
    expect(item.inventory_name).toBe("Media Crew");
    expect(item.inventory_code).toBe("media_crew");
    for (const k of ["name", "code", "code_prefix", "is_active", "archived_at"])
      expect(Object.keys(item), `the asset row carries a bare ${k}`).not.toContain(k);
  });

  it("keeps the authorization key out of the row entirely", async () => {
    /* Phase 13B. scope_id decides what a caller may reach and has no business
       in a read model; inventory_code is what the UI switches on. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "NoKey" }));
    const item = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, unknown>;
    expect(Object.keys(item)).not.toContain("scope_id");
  });

  it("names every column of the timeline from its FIRST union branch", async () => {
    /* A UNION takes its column names from the first SELECT and discards the
       second's. The branches must therefore stay in the same ORDER as well as
       the same shape — a silent transposition would put a maintenance kind in
       the actor column and nothing would complain. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Union" }));
    await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
    await as("admin", "POST", `/equipment/${id}/damage`, { description: "ZAR union check" });
    const evs = rows(await as("admin", "GET", `/equipment/${id}/timeline`));
    const custody = evs.find((e) => e.source === "custody")!;
    const maint = evs.find((e) => e.source === "maintenance")!;
    expect(custody.event).toBe("check_out");
    expect(custody.actor_id).toBe(A.admin.id);
    expect(custody.kind).toBeNull();
    expect(maint.event).toBe("damage_report");
    expect(maint.kind).toBe("damage_report");
    expect(maint.detail).toBe("ZAR union check");
    expect(maint.recorded_via).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE TIMELINE
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("one asset's history, as one sequence", () => {
  const tl = (actor: ActorName | "anon", id: number, qs = "") =>
    as(actor, "GET", `/equipment/${id}/timeline${qs}`);

  async function withHistory() {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
    await as("admin", "POST", `/equipment/${id}/checkin`, {});
    await as("admin", "POST", `/equipment/${id}/damage`, { description: "ZAR cracked filter" });
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, started_at, resolved_at)
       VALUES ($1,'maintenance','ZAR annual service', CURRENT_DATE - 2, CURRENT_DATE - 1)`, [id]);
    return id;
  }

  it("merges the custody ledger and the maintenance record", async () => {
    const r = await tl("admin", await withHistory());
    expect(r.status).toBe(200);
    const evs = rows(r);
    expect(evs.map((e) => e.event)).toEqual(
      expect.arrayContaining(["check_out", "check_in", "damage_report", "maintenance"]));
    expect(new Set(evs.map((e) => e.source))).toEqual(new Set(["custody", "maintenance"]));
    expect(Number(r.body.total)).toBe(4);
  });

  it("is newest first", async () => {
    const evs = rows(await tl("admin", await withHistory()));
    const times = evs.map((e) => String(e.occurred_at));
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("carries who, when and what for each event", async () => {
    const evs = rows(await tl("admin", await withHistory()));
    const out = evs.find((e) => e.event === "check_out")!;
    expect(out.actor_id).toBe(A.admin.id);
    expect(out.actor_name).toBe(`ZAR ${A.admin.id}`);
    expect(out.recorded_via).toBeTruthy();
    expect(out.occurred_at).toBeTruthy();
  });

  it("narrows to one source when asked", async () => {
    const id = await withHistory();
    expect(rows(await tl("admin", id, "?kind=custody")).every((e) => e.source === "custody")).toBe(true);
    expect(rows(await tl("admin", id, "?kind=maintenance")).every((e) => e.source === "maintenance")).toBe(true);
    /* An unknown word is not a filter that matches nothing — it is no filter. */
    expect(Number((await tl("admin", id, "?kind=nonsense")).body.total)).toBe(4);
  });

  it("PAGES IN THE DATABASE, and the pages do not overlap", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    for (let i = 0; i < 7; i++) {
      await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
      await as("admin", "POST", `/equipment/${id}/checkin`, {});
    }
    const p1 = await tl("admin", id, "?limit=5&offset=0");
    const p2 = await tl("admin", id, "?limit=5&offset=5");
    expect(Number(p1.body.total)).toBe(14);
    expect(rows(p1).length).toBe(5);
    expect(rows(p2).length).toBe(5);
    const a = rows(p1).map((e) => `${e.source}:${e.id}`);
    const b = rows(p2).map((e) => `${e.source}:${e.id}`);
    expect(a.filter((x) => b.includes(x)), "a row appeared on two pages").toEqual([]);
  });

  it("never returns an unbounded history", async () => {
    const id = await withHistory();
    const r = await tl("admin", id, "?limit=99999");
    expect(Number(r.body.limit)).toBeLessThanOrEqual(200);
  });

  it("is empty, not absent, for an asset nothing has happened to", async () => {
    const r = await tl("admin", idOf(await mk("admin", { scope_id: mediaCrew })));
    expect(r.status).toBe(200);
    expect(rows(r)).toEqual([]);
    expect(Number(r.body.total)).toBe(0);
  });

  it("answers 404 across an inventory boundary — never 403", async () => {
    const theirs = idOf(await mk("admin", { scope_id: pid }));
    const r = await tl("custMC", theirs);
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Asset not found.");
    /* Identical to an id that does not exist at all. */
    const ghost = await tl("custMC", 2147483600);
    expect(ghost.status).toBe(404);
    expect(String(ghost.body.message)).toBe(String(r.body.message));
  });

  it("is refused to strangers", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    expect((await tl("anon", id)).status).toBe(403);
    expect((await tl("outsider", id)).status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE AUDIT TRAIL
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("what was done to the record", () => {
  const trail = (actor: ActorName | "anon", id: number, qs = "") =>
    as(actor, "GET", `/equipment/${id}/audit${qs}`);

  it("shows the asset's own events, newest first", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, verification_state: "draft" }));
    await as("admin", "POST", `/equipment/${id}/verification`, { action: "submit" });
    const r = await trail("admin", id);
    expect(r.status).toBe(200);
    const acts = rows(r).map((x) => x.action);
    expect(acts).toContain("equipment.verification_submitted");
    expect(rows(r)[0].actor_name).toBe(`ZAR ${A.admin.id}`);
  });

  it("shows ONLY this asset's events", async () => {
    const mine = idOf(await mk("admin", { scope_id: mediaCrew }));
    const other = idOf(await mk("admin", { scope_id: mediaCrew }));
    await as("admin", "POST", `/equipment/${other}/damage`, { description: "ZAR other" });
    const r = await trail("admin", mine);
    expect(rows(r).every((x) => x.action !== "equipment.damage_reported")).toBe(true);
  });

  it("cannot be turned into a general audit browser", async () => {
    /* entity_type is pinned server-side; a query string cannot widen it. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    const r = await trail("admin", id, "?entity_type=user&action=login&limit=200");
    expect(r.status).toBe(200);
    expect(rows(r).every((x) => String(x.action).startsWith("equipment."))).toBe(true);
  });

  it("narrows to the verification slice by prefix", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, verification_state: "draft" }));
    await as("admin", "POST", `/equipment/${id}/verification`, { action: "submit" });
    await as("admin", "POST", `/equipment/${id}/verification`, { action: "reject", reason: "ZAR mismatch." });
    const r = await trail("admin", id, "?action_prefix=equipment.verification_");
    expect(Number(r.body.total)).toBe(2);
    expect(rows(r).every((x) => String(x.action).startsWith("equipment.verification_"))).toBe(true);
    expect((rows(r)[0].after as Record<string, unknown>).reason).toBe("ZAR mismatch.");
  });

  it("is paginated, and never unbounded", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    for (let i = 0; i < 4; i++)
      await as("admin", "POST", `/equipment/${id}/damage`, { description: `ZAR d${i}` });
    const r = await trail("admin", id, "?limit=2&offset=0");
    expect(rows(r).length).toBe(2);
    expect(Number(r.body.total)).toBeGreaterThanOrEqual(4);
    expect(Number((await trail("admin", id, "?limit=99999")).body.limit)).toBeLessThanOrEqual(200);
  });

  it("keeps the reader's location out of it", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    await as("admin", "POST", `/equipment/${id}/damage`, { description: "ZAR ip" });
    for (const row of rows(await trail("admin", id)))
      for (const k of ["ip", "user_agent"]) expect(row, k).not.toHaveProperty(k);
  });

  it("is for custodians and admins, not for every colleague", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    expect((await trail("plain", id)).status).toBe(403);
    expect((await trail("anon", id)).status).toBe(403);
    expect((await trail("outsider", id)).status).toBe(403);
    expect((await trail("custMC", id)).status).toBe(200);
  });

  it("answers 404 across an inventory boundary — never 403", async () => {
    const theirs = idOf(await mk("admin", { scope_id: pid }));
    const r = await trail("custMC", theirs);
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Asset not found.");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE SECTIONS THE PAGE READS THROUGH EXISTING ENDPOINTS
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the sections are scoped and paginated reads", () => {
  it("splits maintenance from damage by kind, in one request each", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    await as("admin", "POST", `/equipment/${id}/damage`, { description: "ZAR knock" });
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, started_at)
       VALUES ($1,'maintenance','ZAR service', CURRENT_DATE), ($1,'repair','ZAR fix', CURRENT_DATE)`, [id]);

    const upkeep = await as("admin", "GET", `/equipment/maintenance?asset_id=${id}&kind=maintenance,repair`);
    expect(rows(upkeep).map((m) => m.kind).sort()).toEqual(["maintenance", "repair"]);
    const damage = await as("admin", "GET", `/equipment/maintenance?asset_id=${id}&kind=damage_report`);
    expect(rows(damage).map((m) => m.kind)).toEqual(["damage_report"]);
    /* An unknown kind matches nothing rather than everything. */
    expect(rows(await as("admin", "GET", `/equipment/maintenance?asset_id=${id}&kind=invented`))).toEqual([]);
  });

  it("reads reservations past and present through the booking endpoint", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, starts_at, ends_at, status)
       VALUES ($1,$2,CURRENT_DATE + 40, CURRENT_DATE + 41,'reserved'),
              ($1,$2,CURRENT_DATE - 40, CURRENT_DATE - 39,'completed')`, [id, A.admin.id]);
    const live = await as("admin", "GET", `/equipment/bookings?asset_id=${id}&status=reserved,active`);
    expect(rows(live).length).toBe(1);
    const past = await as("admin", "GET", `/equipment/bookings?asset_id=${id}&status=completed,cancelled`);
    expect(rows(past).length).toBe(1);
    expect(rows(past)[0].status).toBe("completed");
  });

  it("refuses a section across an inventory boundary", async () => {
    const theirs = idOf(await mk("admin", { scope_id: pid }));
    for (const url of [`/equipment/maintenance?asset_id=${theirs}`,
                       `/equipment/bookings?asset_id=${theirs}`,
                       `/equipment/transactions?asset_id=${theirs}`]) {
      const r = await as("custMC", "GET", url);
      /* A list endpoint narrows to nothing rather than answering 404 — the
         asset is outside scope, so there is simply nothing in it to return. */
      expect(r.status, url).toBe(200);
      expect(rows(r), url).toEqual([]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   THE LEGACY ESTATE, AND POOLED INVENTORY
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("an ungoverned asset still has a page", () => {
  /* An asset that predates the inventory model: no scope, no internal code.
     Every one of the 32 on dev looks like this, and the page must read them
     without inventing an inventory or a code for either. */
  const legacy = async () => Number((await pool.query(
    `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model)
     VALUES ($1,$2,'ZAR','Legacy') RETURNING id`,
    [categoryId, `EQ-${PX.toUpperCase()}-L${Math.random().toString(36).slice(2, 8).toUpperCase()}`]))
    .rows[0].id);

  it("reads with no inventory and no code, and invents neither", async () => {
    const r = await as("admin", "GET", `/equipment/${await legacy()}`);
    expect(r.status).toBe(200);
    const it0 = r.body.item as unknown as Record<string, unknown>;
    expect(it0.inventory_name).toBeNull();
    expect(it0.internal_code).toBeNull();
    /* Not the database id wearing a costume. */
    expect(String(it0.internal_code ?? "")).not.toContain(String(it0.id));
  });

  it("stays visible and active, and reaches every section", async () => {
    const id = await legacy();
    const it0 = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as { state: { verification: { state: string } } };
    expect(it0.state.verification.state).toBe("active");
    for (const url of [`/equipment/${id}/timeline`, `/equipment/${id}/audit`]) {
      const r = await as("admin", "GET", url);
      expect(r.status, url).toBe(200);
      expect(rows(r), url).toEqual([]);
    }
  });

  it("is reachable by a custodian, because the legacy estate belongs to nobody", async () => {
    /* Phase 13B: scope_id IS NULL is the estate everyone can still reach. */
    expect((await as("custMC", "GET", `/equipment/${await legacy()}/timeline`)).status).toBe(200);
  });
});

maybe("pooled inventory is one record with a quantity", () => {
  it("says pooled, and carries the count — not 48 invented assets", async () => {
    const id = idOf(await mk("admin", { scope_id: pid, model: "Battery",
      tracking_mode: "pooled", pool_quantity: 48 }));
    const it0 = (await as("admin", "GET", `/equipment/${id}`)).body
      .item as unknown as Record<string, unknown>;
    expect(it0.tracking_mode).toBe("pooled");
    expect(Number(it0.pool_quantity)).toBe(48);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE internal_code=$1`,
      [it0.internal_code])).rows[0].c), "a pooled row was split into units").toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   WHAT THE PAGE MUST NOT COST
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the shell stays cheap", () => {
  it("bounds every list the detail payload carries", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew }));
    for (let i = 0; i < 3; i++) {
      await as("admin", "POST", `/equipment/${id}/checkout`, { user_id: A.admin.id, expected_return_at: DUE });
      await as("admin", "POST", `/equipment/${id}/checkin`, {});
    }
    const d = (await as("admin", "GET", `/equipment/${id}`)).body as unknown as Record<string, unknown[]>;
    expect(d.transactions.length).toBeLessThanOrEqual(50);
    expect(d.maintenance.length).toBeLessThanOrEqual(50);
  });

  it("puts no equipment collection back into /state", async () => {
    /* Phases 7 and 8 took the estate out of the boot payload. A 360 page is a
       reason to read MORE per asset, never a reason to ship every asset. */
    const r = await as("admin", "GET", "/state");
    for (const k of ["equipment_items", "equipment_transactions", "equipment_bookings",
                     "maintenance_records", "inventory_scopes"])
      expect(Object.keys(r.body), `/state regained ${k}`).not.toContain(k);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17H — A PROJECT'S EQUIPMENT

   No new table, no new status, no second booking engine. A project's equipment
   IS its bookings, and the endpoint is a read over rows that already exist.

   The claim worth testing hardest is the one that is easy to get wrong: PROJECT
   VISIBILITY IS NOT EQUIPMENT VISIBILITY. Any media member may open any project
   — GET /projects/:id asks only requireMedia — so if this endpoint leaned on
   project access it would hand every colleague the whole estate through a door
   Phase 13B spent a phase closing.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("a project's equipment", () => {
  let projectA = 0, projectB = 0;

  const mkProject = async (code: string) => Number((await pool.query(
    `INSERT INTO mo_projects (project_type_id, code, name, created_by, start_date, end_date)
     VALUES ((SELECT id FROM mo_project_types ORDER BY id LIMIT 1), $1, $2, $3,
             CURRENT_DATE + 10, CURRENT_DATE + 20) RETURNING id`,
    [`${PX}-${code}`, `${PX} ${code}`, A.admin.id])).rows[0].id);

  const reserve = async (actor: ActorName, assetId: number, from: number, to: number,
                         project: number | null) =>
    as(actor, "POST", "/equipment/bookings", {
      equipment_item_id: assetId, project_id: project,
      starts_at: day(from), ends_at: day(to) });

  const day = istDay;
  const gear = (actor: ActorName | "anon", id: number, qs = "") =>
    as(actor, "GET", `/projects/${id}/equipment${qs}`);

  beforeEach(async () => {
    if (!dbUp) return;
    /* Projects this suite OWNS. Borrowing one — SELECT id FROM mo_projects
       ORDER BY id LIMIT 1 — is how a sibling suite's teardown came to fail on
       a booking foreign key. TEST_STABILITY entry 17. */
    await pool.query(`DELETE FROM mo_equipment_bookings WHERE project_id IN
                        (SELECT id FROM mo_projects WHERE code LIKE $1)
                         OR shoot_id IN (SELECT id FROM mo_shoots WHERE title LIKE $2)`,
      [`${PX}-%`, `${PX} %`]);
    await pool.query(`DELETE FROM mo_shoots WHERE title LIKE $1`, [`${PX} %`]);
    await pool.query(`DELETE FROM mo_projects WHERE code LIKE $1`, [`${PX}-%`]);
    projectA = await mkProject("PA");
    projectB = await mkProject("PB");
  });

  it("lists the project's reservations with the asset, inventory and dates", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "ProjCam" }));
    const r = await reserve("admin", id, 10, 12, projectA);
    expect(r.status, JSON.stringify(r.body)).toBe(201);

    const g = await gear("admin", projectA);
    expect(g.status).toBe(200);
    const up = g.body.upcoming as unknown as Record<string, unknown>[];
    expect(up.length).toBe(1);
    expect(up[0].asset_tag).toBeTruthy();
    expect(up[0].inventory_name).toBe("Media Crew");
    expect(up[0].internal_code).toMatch(/^MC-\d{4}$/);
    expect(up[0].starts_at).toBe(day(10));
    expect(String(up[0].ends_at)).not.toMatch(/[TZ]/);   // a day, not an instant
    expect(up[0].holder_id, "an unissued reservation named a holder").toBeNull();
  });

  it("reports the project's OWN dates without making them the booking's", async () => {
    const g = await gear("admin", projectA);
    const p = g.body.project as unknown as Record<string, string>;
    expect(p.start_date).toBe(day(10));
    expect(p.end_date).toBe(day(20));
    /* Gear needed for two days inside a ten-day project is the normal case. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "ShortNeed" }));
    await reserve("admin", id, 12, 13, projectA);
    const up = (await gear("admin", projectA)).body.upcoming as unknown as Record<string, string>[];
    expect(up[0].starts_at).toBe(day(12));
    expect(up[0].ends_at).toBe(day(13));
  });

  it("separates what is running now from what is still to come", async () => {
    const now = idOf(await mk("admin", { scope_id: mediaCrew, model: "RunningNow" }));
    const later = idOf(await mk("admin", { scope_id: mediaCrew, model: "Later" }));
    await reserve("admin", now, 0, 2, projectA);
    await reserve("admin", later, 20, 21, projectA);
    const g = await gear("admin", projectA);
    expect((g.body.current as unknown as { equipment_item_id: number }[])
      .map((x) => Number(x.equipment_item_id))).toEqual([now]);
    expect((g.body.upcoming as unknown as { equipment_item_id: number }[])
      .map((x) => Number(x.equipment_item_id))).toEqual([later]);
  });

  it("shows custody from the ledger once the gear is collected", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Collected" }));
    const bk = await reserve("admin", id, 0, 3, projectA);
    const bid = Number((bk.body.booking as { id: number }).id);
    /* The booking was made by whoever planned the shoot; the gear goes to
       whoever is carrying it. Checking out AGAINST the booking must not be
       refused by that booking. */
    const out = await as("admin", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.custMC.id, booking_id: bid, expected_return_at: day(3) });
    expect(out.status, JSON.stringify(out.body)).toBe(201);

    const row = (await gear("admin", projectA)).body
      .current as unknown as Record<string, unknown>[];
    expect(row[0].holder_id).toBe(A.custMC.id);
    expect(row[0].holder_name).toBe(`ZAR ${A.custMC.id}`);
    expect(row[0].due_at).toBe(day(3));
    expect(row[0].checked_out_at).toBeTruthy();
    expect(row[0].status, "checkout against a booking marks it active").toBe("active");

    /* And returning it clears custody without touching the project link. */
    await as("admin", "POST", `/equipment/${id}/checkin`, {});
    const after = (await gear("admin", projectA)).body as unknown as
      { current: Record<string, unknown>[]; history: { items: Record<string, unknown>[] } };
    const seen = [...after.current, ...after.history.items];
    expect(seen.length).toBe(1);
    expect(seen[0].holder_id).toBeNull();
  });

  it("moves a finished or cancelled reservation into history, paginated", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Cancelled" }));
    const bk = await reserve("admin", id, 10, 11, projectA);
    const bid = Number((bk.body.booking as { id: number }).id);
    await as("admin", "POST", `/equipment/bookings/${bid}/cancel`, {});

    const g = await gear("admin", projectA);
    expect(g.body.upcoming).toEqual([]);
    const h = g.body.history as unknown as { items: Record<string, unknown>[]; total: number };
    expect(h.total).toBe(1);
    expect(h.items[0].status).toBe("cancelled");
    /* History is the unbounded one, so it pages. */
    const paged = await gear("admin", projectA, "?limit=1&offset=1");
    expect((paged.body.history as unknown as { items: unknown[] }).items.length).toBe(0);
    expect(Number((paged.body.history as unknown as { limit: number }).limit)).toBe(1);
  });

  it("counts a reservation whose dates have passed as history, not as current", async () => {
    /* 17G's derived expiry, from the project's side. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Stale" }));
    await reserve("admin", id, -9, -7, projectA);
    const g = await gear("admin", projectA);
    expect(g.body.current).toEqual([]);
    expect(g.body.upcoming).toEqual([]);
    expect((g.body.history as unknown as { total: number }).total).toBe(1);
  });

  it("keeps one project's gear out of another's", async () => {
    const a = idOf(await mk("admin", { scope_id: mediaCrew, model: "ForA" }));
    const b = idOf(await mk("admin", { scope_id: mediaCrew, model: "ForB" }));
    await reserve("admin", a, 10, 11, projectA);
    await reserve("admin", b, 10, 11, projectB);
    const ga = (await gear("admin", projectA)).body.upcoming as unknown as { equipment_item_id: number }[];
    expect(ga.map((x) => Number(x.equipment_item_id))).toEqual([a]);
  });

  it("finds gear linked through the shoot when the booking names no project", async () => {
    /* Nothing writes this shape today, but the write path accepts shoot_id and
       project_id independently, so a read that only looked at project_id would
       lose the gear the moment anything did. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "ViaShoot" }));
    const shoot = Number((await pool.query(
      `INSERT INTO mo_shoots (project_id, title, shoot_date, call_time, end_time, location, status, created_by)
       VALUES ($1,$2,CURRENT_DATE,'09:00','18:00','Studio','planned',$3) RETURNING id`,
      [projectA, `${PX} shoot`, A.admin.id])).rows[0].id);
    await pool.query(
      `INSERT INTO mo_equipment_bookings (equipment_item_id, user_id, shoot_id, starts_at, ends_at, status, created_by)
       VALUES ($1,$2,$3,CURRENT_DATE + 10, CURRENT_DATE + 11,'reserved',$2)`,
      [id, A.admin.id, shoot]);
    const up = (await gear("admin", projectA)).body.upcoming as unknown as Record<string, unknown>[];
    expect(up.map((x) => Number(x.equipment_item_id))).toContain(id);
    expect(up[0].shoot_title).toBe(`${PX} shoot`);
  });

  it("is empty, not absent, for a project with no equipment", async () => {
    const g = await gear("admin", projectB);
    expect(g.status).toBe(200);
    expect(g.body.current).toEqual([]);
    expect(g.body.upcoming).toEqual([]);
    expect((g.body.history as unknown as { items: unknown[]; total: number }).items).toEqual([]);
    expect((g.body.history as unknown as { total: number }).total).toBe(0);
  });

  it("404s a project that does not exist or has been deleted", async () => {
    expect((await gear("admin", 2147483600)).status).toBe(404);
    await pool.query(`UPDATE mo_projects SET deleted_at=NOW() WHERE id=$1`, [projectB]);
    expect((await gear("admin", projectB)).status).toBe(404);
  });

  /* ── THE SECURITY CASE ─────────────────────────────────────────────────── */

  it("DOES NOT let project access become equipment access", async () => {
    /* custMC holds Media Crew and nothing else. A PID asset reserved against
       this project must not appear in it, even though they may open the
       project itself. */
    const theirs = idOf(await mk("admin", { scope_id: pid, model: "PidGear" }));
    const mine = idOf(await mk("admin", { scope_id: mediaCrew, model: "McGear" }));
    await reserve("admin", theirs, 10, 11, projectA);
    await reserve("admin", mine, 10, 11, projectA);

    const seen = (await gear("custMC", projectA)).body.upcoming as unknown as { equipment_item_id: number }[];
    expect(seen.map((x) => Number(x.equipment_item_id))).toEqual([mine]);

    /* The admin, who holds everything, sees both — so the row is really there
       and the custodian's view is a scope decision, not an empty table. */
    expect(((await gear("admin", projectA)).body.upcoming as unknown as unknown[]).length).toBe(2);
  });

  it("shows a colleague with no inventory only the legacy estate", async () => {
    /* Phase 13B: scope_id IS NULL belongs to everybody. A scoped asset does not. */
    const legacy = Number((await pool.query(
      `INSERT INTO mo_equipment_items (category_id, asset_tag, make, model)
       VALUES ($1,$2,'ZAR','Legacy') RETURNING id`,
      [categoryId, `EQ-${PX.toUpperCase()}-PL1`])).rows[0].id);
    const scoped = idOf(await mk("admin", { scope_id: mediaCrew, model: "ScopedOne" }));
    await reserve("admin", legacy, 10, 11, projectA);
    await reserve("admin", scoped, 10, 11, projectA);
    const seen = (await gear("plain", projectA)).body.upcoming as unknown as { equipment_item_id: number }[];
    expect(seen.map((x) => Number(x.equipment_item_id))).toEqual([legacy]);
  });

  it("refuses a custodian reserving an asset outside their inventory, from the project", async () => {
    /* The project endpoint adds no write path of its own — reserving still goes
       through POST /equipment/bookings, which answers 404 across a scope
       boundary exactly as it does everywhere else. No booking, no audit. */
    const theirs = idOf(await mk("admin", { scope_id: pid, model: "NotYours" }));
    const r = await reserve("custMC", theirs, 10, 11, projectA);
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Item not found.");
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings WHERE equipment_item_id=$1`,
      [theirs])).rows[0].c)).toBe(0);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs
        WHERE action='equipment.booked' AND actor_id=$1`, [A.custMC.id])).rows[0].c)).toBe(0);
  });

  it("is refused to anonymous and non-media callers", async () => {
    expect((await gear("anon", projectA)).status).toBe(403);
    expect((await gear("outsider", projectA)).status).toBe(403);
  });

  it("will not file a booking against a project that does not exist", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "GhostProj" }));
    const r = await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: id, project_id: 2147483600, starts_at: day(10), ends_at: day(11) });
    expect(r.status).toBe(400);
    await pool.query(`UPDATE mo_projects SET deleted_at=NOW() WHERE id=$1`, [projectB]);
    expect((await reserve("admin", id, 10, 11, projectB)).status).toBe(400);
  });

  /* ── CONCURRENCY ───────────────────────────────────────────────────────── */

  it("lets exactly one of two projects take an overlapping window", async () => {
    /* The exclusion constraint is still the authority; the project link changes
       nothing about it. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Contested" }));
    const results = await Promise.all([
      reserve("admin", id, 30, 32, projectA),
      reserve("admin", id, 31, 33, projectB),
    ]);
    const outcome = results
      .map((r) => `${r.status}:${String((r.body as { message?: string })?.message ?? "").slice(0, 40)}`).join(" | ");
    expect(results.filter((r) => r.status === 201).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(results.some((r) => r.status >= 500), outcome).toBe(false);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_bookings
        WHERE equipment_item_id=$1 AND status IN ('reserved','active')`, [id])).rows[0].c)).toBe(1);
  });

  it("lets two projects hold the same asset on windows that do not overlap", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Shared" }));
    expect((await reserve("admin", id, 40, 42, projectA)).status).toBe(201);
    expect((await reserve("admin", id, 43, 45, projectB)).status).toBe(201);
  });

  /* ── THE REVERSE DIRECTION ─────────────────────────────────────────────── */

  it("answers asset → projects through the booking read the asset page already uses", async () => {
    /* No second endpoint: GET /equipment/bookings?asset_id= already carries the
       project, which is what the Asset 360 Reservations tab draws. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "Reverse" }));
    await reserve("admin", id, 10, 11, projectA);
    const r = await as("admin", "GET", `/equipment/bookings?asset_id=${id}`);
    const rows0 = r.body.items as unknown as Record<string, unknown>[];
    expect(rows0.length).toBe(1);
    expect(Number(rows0[0].project_id)).toBe(projectA);
    expect(rows0[0].project_name).toBe(`${PX} PA`);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17K — THE INVENTORY DASHBOARD

   One read model over the tables that already own every figure. Nothing is
   persisted and nothing is cached, so the tests that matter are: does each
   number mean what it says, and does a scoped custodian see only their own
   cupboard in every one of the eight sections.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the inventory dashboard", () => {
  const dash = (actor: ActorName | "anon", qs = "") =>
    as(actor, "GET", `/equipment/dashboard${qs}`);
  const sum = async (actor: ActorName, qs = "") =>
    (await dash(actor, qs)).body.summary as unknown as Record<string, number>;
  const day = istDay;

  it("shows a caller only the assets they may reach", async () => {
    /* NAMED ASSETS, NOT TWO TOTALS. Comparing the admin's total with the
       custodian's compares two numbers taken from a shared database at two
       different moments, and sibling suites move both between the reads — it
       failed at 61 against 60 for reasons that had nothing to do with scope.
       The claim is about a SPECIFIC asset being visible to one caller and not
       the other, so that is what is asserted. TEST_STABILITY entry 17. */
    const mine = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashMine",
      verification_state: "draft" }));
    const theirs = idOf(await mk("admin", { scope_id: pid, model: "DashTheirs",
      verification_state: "draft" }));
    const queue = async (actor: ActorName) =>
      ((await dash(actor)).body.verification as unknown as { id: number }[])
        .map((r) => Number(r.id));

    const asAdmin = await queue("admin");
    expect(asAdmin, "the admin could not see a Media Crew draft").toContain(mine);
    expect(asAdmin, "the admin could not see a PID draft").toContain(theirs);

    const asCustodian = await queue("custMC");
    expect(asCustodian).toContain(mine);
    expect(asCustodian, "a Media Crew custodian saw a PID asset").not.toContain(theirs);
  });

  it("does NOT define available as total minus checked out", async () => {
    /* An asset on the shelf whose record nobody has accepted cannot be issued.
       Phase 17D refuses it, so the dashboard must not call it available. */
    const draft = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashDraft",
      verification_state: "draft" }));
    const before = await sum("admin", "?inventory=media_crew");
    expect(draft).toBeGreaterThan(0);
    expect(before.available + before.checked_out, "available was computed by subtraction")
      .toBeLessThanOrEqual(before.total);
    /* And the draft is counted where it belongs. */
    expect(before.pending_verification).toBeGreaterThanOrEqual(1);
  });

  it("counts checked out, overdue and reserved from the live records", async () => {
    const out = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashOut" }));
    await as("admin", "POST", `/equipment/${out}/checkout`,
      { holder_id: A.custMC.id, expected_return_at: DUE });
    const res0 = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashRes" }));
    await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: res0, starts_at: day(3), ends_at: day(4) });

    const s = await sum("admin", "?inventory=media_crew");
    expect(s.checked_out).toBeGreaterThanOrEqual(1);
    expect(s.reserved).toBeGreaterThanOrEqual(1);

    /* Overdue uses the existing rule: a loan past its return date. Backdated
       the way the ledger would have got there. */
    await pool.query(
      `UPDATE mo_equipment_transactions SET expected_return_at = CURRENT_DATE - 2
        WHERE equipment_item_id=$1 AND action='check_out'`, [out]);
    expect((await sum("admin", "?inventory=media_crew")).overdue).toBeGreaterThanOrEqual(1);
  });

  it("counts an asset needing attention ONCE, however many reasons it has", async () => {
    /* An asset that is overdue and under repair is one thing to deal with. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashBoth" }));
    await as("admin", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.custMC.id, expected_return_at: DUE });
    await pool.query(
      `UPDATE mo_equipment_transactions SET expected_return_at = CURRENT_DATE - 1
        WHERE equipment_item_id=$1 AND action='check_out'`, [id]);
    await as("admin", "POST", `/equipment/${id}/damage`, { description: "ZAR both" });

    const s = await sum("admin", "?inventory=media_crew");
    expect(s.attention).toBeLessThanOrEqual(s.total);
    /* The QUEUE lists the reasons separately — that is its job. */
    const q = (await dash("admin", "?inventory=media_crew")).body
      .attention as unknown as { id: number; reason: string }[];
    const reasons = q.filter((r) => Number(r.id) === id).map((r) => r.reason).sort();
    expect(reasons).toEqual(["maintenance", "overdue"]);

    /* PUT THE DATE BACK. Overdueness was faked with a direct UPDATE and, left
       there, it outlives this test: every OTHER suite's global automation pass
       then finds a permanently-overdue asset in a shared inventory and fans
       notifications out to THIS suite's users — who get deleted at teardown,
       so the insert hits the users foreign key and kills the whole pass.
       That surfaced as five unrelated AUTO-8 assertions failing at once.
       A fixture that only exists for one assertion should not outlive it.
       TEST_STABILITY entry B2. */
    await pool.query(
      `UPDATE mo_equipment_transactions SET expected_return_at = $2
        WHERE equipment_item_id=$1 AND action='check_out'`, [id, DUE]);
  });

  it("breaks the inventory down by category, tracking, lifecycle and condition", async () => {
    await mk("admin", { scope_id: mediaCrew, model: "DashPooled",
      tracking_mode: "pooled", pool_quantity: 12 });
    /* ONE RESPONSE. The breakdown and the total must agree with each other,
       which is a statement about internal consistency — taking them from two
       requests asks whether the database changed in between, which on a shared
       database it does. */
    const body = (await dash("admin", "?inventory=media_crew")).body as unknown as
      { breakdowns: Record<string, { count: number }[]>; summary: Record<string, number> };
    const b = body.breakdowns;
    for (const k of ["category", "tracking", "lifecycle", "condition"])
      expect(Array.isArray(b[k]), k).toBe(true);
    for (const k of ["lifecycle", "category", "condition", "tracking"]) {
      const sumOf = b[k].reduce((n, r) => n + Number(r.count), 0);
      expect(sumOf, `the ${k} breakdown does not add up to the total`).toBe(body.summary.total);
    }
    expect(b.tracking.some((r) => (r as unknown as { tracking_mode: string }).tracking_mode === "pooled")).toBe(true);
  });

  it("keeps every section inside the caller's inventory", async () => {
    /* One asset per section, all in PID, none of it visible to Media Crew. */
    const id = idOf(await mk("admin", { scope_id: pid, model: "DashPidAll",
      verification_state: "draft" }));
    await as("admin", "POST", `/equipment/${id}/damage`, { description: "ZAR pid damage" });
    const d = (await dash("custMC")).body as unknown as Record<string, unknown>;
    const ids = (k: string) => ((d[k] as { id?: number; equipment_item_id?: number }[]) ?? [])
      .map((r) => Number(r.equipment_item_id ?? r.id));
    for (const k of ["custody", "reservations", "maintenance", "verification", "attention"])
      expect(ids(k), `${k} leaked another inventory`).not.toContain(id);
    const act = (d.activity as { items: { equipment_item_id: number }[] }).items;
    expect(act.map((r) => Number(r.equipment_item_id))).not.toContain(id);
  });

  it("pages the activity feed and never returns the whole history", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashActivity" }));
    for (let i = 0; i < 3; i++) {
      await as("admin", "POST", `/equipment/${id}/checkout`,
        { holder_id: A.custMC.id, expected_return_at: DUE });
      await as("admin", "POST", `/equipment/${id}/checkin`, {});
    }
    const r = await dash("admin", "?inventory=media_crew&limit=2&offset=0");
    const a = r.body.activity as unknown as { items: unknown[]; total: number; limit: number };
    expect(a.items.length).toBe(2);
    expect(a.total).toBeGreaterThanOrEqual(6);
    /* And no argument asks for the whole table. */
    const wide = (await dash("admin", "?limit=99999")).body.activity as unknown as { limit: number };
    expect(Number(wide.limit)).toBeLessThanOrEqual(200);
  });

  it("narrows to one inventory without widening authority", async () => {
    /* A filter NARROWS. Asking for an inventory the caller has no authority
       over returns nothing, never everything. */
    const s = await sum("custMC", "?inventory=pid");
    expect(s.total).toBe(0);
  });

  it("filters by category, tracking mode, lifecycle and condition", async () => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashFiltered" }));
    expect((await sum("admin", `?category_id=${categoryId}`)).total).toBeGreaterThanOrEqual(1);
    expect((await sum("admin", "?tracking_mode=pooled&inventory=media_crew")).total)
      .toBeLessThanOrEqual((await sum("admin", "?inventory=media_crew")).total);
    expect((await sum("admin", "?lifecycle=retired&category_id=" + categoryId)).total).toBe(0);
    expect((await sum("admin", "?condition=good&category_id=" + categoryId)).total)
      .toBeGreaterThanOrEqual(1);
    expect(id).toBeGreaterThan(0);
  });

  it("writes nothing — no rows, no notifications, no audit", async () => {
    /* A dashboard is a window. Viewing it must change nothing at all. */
    /* COUNTED WITHIN THIS SUITE'S OWN FIXTURES. The claim is "opening the
       dashboard writes nothing", and a bare global count cannot test it on a
       shared database: a sibling suite checking a camera out between the two
       reads fails the assertion for a reason that has nothing to do with the
       dashboard. Scoped to this file's category, users and actors, which no
       other suite can write into. TEST_STABILITY entry 17. */
    const counts = async () => (await pool.query(
      `WITH mine AS (SELECT id FROM mo_equipment_items WHERE category_id=$1)
       SELECT (SELECT COUNT(*)::int FROM mine)                                      AS items,
              (SELECT COUNT(*)::int FROM mo_equipment_transactions
                WHERE equipment_item_id IN (SELECT id FROM mine))                   AS txns,
              (SELECT COUNT(*)::int FROM mo_equipment_bookings
                WHERE equipment_item_id IN (SELECT id FROM mine))                   AS bookings,
              (SELECT COUNT(*)::int FROM mo_maintenance_records
                WHERE equipment_item_id IN (SELECT id FROM mine))                   AS maint,
              (SELECT COUNT(*)::int FROM mo_asset_inspections
                WHERE equipment_item_id IN (SELECT id FROM mine))                   AS insp,
              (SELECT COUNT(*)::int FROM mo_notifications WHERE user_id LIKE $2)     AS notes,
              (SELECT COUNT(*)::int FROM mo_audit_logs WHERE actor_id LIKE $2)       AS audit`,
      [categoryId, `${PX}-%`])).rows[0];
    const before = await counts();
    await dash("admin");
    await dash("admin", "?inventory=media_crew");
    await dash("custMC");
    expect(await counts(), "the dashboard wrote something").toEqual(before);
  });

  it("is refused to anonymous and non-media callers", async () => {
    expect((await dash("anon")).status).toBe(403);
    expect((await dash("outsider")).status).toBe(403);
  });

  it("reflects a mutation on the next read, with no caching in between", async () => {
    /* A NAMED ASSET, not a delta on a shared count. media_crew is written to by
       sibling suites throughout the run, so "one more than before" measures
       them as well as this checkout — it failed at 1 against 2 for exactly that
       reason. Whether THIS asset appears in the custody list is the claim, and
       it is unaffected by anything else happening. TEST_STABILITY entry 17. */
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model: "DashLive" }));
    const held = async () => ((await dash("admin", "?inventory=media_crew")).body
      .custody as unknown as { id: number }[]).map((r) => Number(r.id));

    expect(await held(), "an unissued asset was listed as out").not.toContain(id);
    await as("admin", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.custMC.id, expected_return_at: DUE });
    expect(await held(), "the dashboard did not see the checkout").toContain(id);
    await as("admin", "POST", `/equipment/${id}/checkin`, {});
    expect(await held(), "the dashboard did not see the return").not.toContain(id);
  });

  it("answers the whole page in one request", async () => {
    /* Eight sections, one round trip — the alternative was six endpoints and
       the totals reconciled by whoever wrote the page. */
    const r = await dash("admin");
    expect(r.status).toBe(200);
    for (const k of ["scope", "summary", "breakdowns", "custody", "reservations",
                     "maintenance", "verification", "attention", "activity"])
      expect(Object.keys(r.body), k).toContain(k);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17L — IMPORT & RECONCILIATION

   The spreadsheet is not authoritative and the importer decides nothing. What
   is tested here is that refusal: that a possible match never becomes a merge,
   that a sequence number never becomes a manufacturer serial, that an existing
   asset is never touched, and that approving a row is atomic — an asset and a
   resolved row, or neither.

   The real 286-row source is not in the repository and is not imported. These
   fixtures are synthetic.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("importing an inventory spreadsheet", () => {
  /* The upload middleware is not mounted in this harness, so batches are
     seeded through the same normalisation the endpoint uses — the decision
     endpoint under test is the same either way. */
  const seedBatch = async (rows: Array<Record<string, unknown>>) => {
    const bid = Number((await pool.query(
      `INSERT INTO mo_asset_import_batches (file_name, uploaded_by, rows_total)
       VALUES ($1,$2,$3) RETURNING id`, [`${PX}-inventory.csv`, A.admin.id, rows.length])).rows[0].id);
    const ids: number[] = [];
    for (const [i, r] of rows.entries())
      ids.push(Number((await pool.query(
        `INSERT INTO mo_asset_import_rows
           (batch_id, source_row, source_name, source_inventory, source_sr_no, normalized_name,
            proposed_category_id, proposed_scope_id, proposed_tracking_mode, proposed_quantity,
            proposed_serial_no, warnings, candidates, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14) RETURNING id`,
        /* `??` would treat an EXPLICIT null as "use the default", which is
           exactly the case these fixtures exist to create — a row with no
           inventory, or no category. Presence of the key is what decides. */
        [bid, i + 2, r.name ?? "ZAR Camera", r.inventory ?? "Media Crew", r.srNo ?? null,
         r.name ?? "ZAR Camera",
         "categoryId" in r ? r.categoryId : categoryId,
         "scopeId" in r ? r.scopeId : mediaCrew,
         r.tracking ?? "individual", r.quantity ?? null, r.serial ?? null,
         JSON.stringify(r.warnings ?? []), JSON.stringify(r.candidates ?? []),
         r.state ?? "pending_review"])).rows[0].id));
    return { bid, ids };
  };
  const decide = (actor: ActorName | "anon", bid: number, rowId: number, body: Record<string, unknown>) =>
    as(actor, "POST", `/equipment/imports/${bid}/rows/${rowId}/decision`, body);
  const rowOf = async (id: number) => (await pool.query(
    `SELECT * FROM mo_asset_import_rows WHERE id=$1`, [id])).rows[0];

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_asset_import_batches WHERE file_name LIKE $1`, [`${PX}-%`]);
  });

  it("creates a DRAFT asset through the canonical path, never an active one", async () => {
    /* A spreadsheet is not verification. 17D's workflow stays authoritative. */
    const { bid, ids } = await seedBatch([{ name: "ZAR Import Cam" }]);
    const r = await decide("admin", bid, ids[0], { decision: "new" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const assetId = Number((await rowOf(ids[0])).created_asset_id);
    const asset = (await pool.query(
      `SELECT verification_state, internal_code, asset_tag, scope_id, serial_no, tracking_mode
         FROM mo_equipment_items WHERE id=$1`, [assetId])).rows[0];
    expect(asset.verification_state, "an imported asset went straight to active").toBe("draft");
    /* And it got a real identity from the real allocator. */
    expect(asset.internal_code).toMatch(/^MC-\d{4}$/);
    expect(asset.asset_tag).toMatch(/^EQ-[A-Z]{1,3}-\d{3}$/);
    expect(Number(asset.scope_id)).toBe(mediaCrew);
    /* Identifier rows exist, as they do for any asset. */
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_asset_identifiers WHERE asset_id=$1`, [assetId])).rows[0].c))
      .toBeGreaterThanOrEqual(2);
    expect((await rowOf(ids[0])).state).toBe("imported");
  });

  it("NEVER writes the sheet's Sr. No into the manufacturer serial", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR NoSerial", srNo: "7", serial: null }]);
    await decide("admin", bid, ids[0], { decision: "new" });
    const assetId = Number((await rowOf(ids[0])).created_asset_id);
    expect((await pool.query(
      `SELECT serial_no FROM mo_equipment_items WHERE id=$1`, [assetId])).rows[0].serial_no,
      "a row counter became a manufacturer serial").toBeNull();
    /* The provenance is kept, under its own name. */
    expect((await rowOf(ids[0])).source_sr_no).toBe("7");
  });

  it("keeps a real manufacturer serial and refuses a collision", async () => {
    const existing = idOf(await mk("admin", { scope_id: mediaCrew, model: "ZAR Serialled",
      serial_no: `${PX}-SER-1` }));
    expect(existing).toBeGreaterThan(0);
    const { bid, ids } = await seedBatch([{ name: "ZAR Clash", serial: `${PX}-SER-1` }]);
    const r = await decide("admin", bid, ids[0], { decision: "new" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/serial number or identifier already exists/i);
    /* Nothing half-made: no asset, and the row is still open. */
    expect((await rowOf(ids[0])).state).toBe("pending_review");
    expect((await rowOf(ids[0])).created_asset_id).toBeNull();
  });

  it("creates ONE pooled asset with a quantity, not one asset per unit", async () => {
    const { bid, ids } = await seedBatch([
      { name: "ZAR Batteries", tracking: "pooled", quantity: 48, state: "pooled_review" }]);
    const r = await decide("admin", bid, ids[0], { decision: "pooled", quantity: 48 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const assetId = Number((await rowOf(ids[0])).created_asset_id);
    const a = (await pool.query(
      `SELECT tracking_mode, pool_quantity, verification_state FROM mo_equipment_items WHERE id=$1`,
      [assetId])).rows[0];
    expect(a.tracking_mode).toBe("pooled");
    expect(a.pool_quantity).toBe(48);
    expect(a.verification_state).toBe("draft");
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE model=$1 AND category_id=$2`,
      ["ZAR Batteries", categoryId])).rows[0].c),
      "a pooled row was split into units").toBe(1);
  });

  it("refuses a pooled approval with no quantity", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR NoQty", state: "pooled_review" }]);
    expect((await decide("admin", bid, ids[0], { decision: "pooled" })).status).toBe(400);
  });

  it("MATCHES an existing asset without touching it", async () => {
    const target = idOf(await mk("admin", { scope_id: mediaCrew, model: "ZAR Existing" }));
    const before = (await pool.query(
      `SELECT * FROM mo_equipment_items WHERE id=$1`, [target])).rows[0];
    const { bid, ids } = await seedBatch([
      { name: "ZAR Existing", state: "identity_decision_required" }]);
    const r = await decide("admin", bid, ids[0], { decision: "match_existing", matched_asset_id: target });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await rowOf(ids[0])).state).toBe("matched_existing");
    expect(Number((await rowOf(ids[0])).matched_asset_id)).toBe(target);
    /* THE EXISTING ASSET IS UNCHANGED — every column of it. */
    expect((await pool.query(`SELECT * FROM mo_equipment_items WHERE id=$1`, [target])).rows[0],
      "matching modified the existing asset").toEqual(before);
    /* And no new asset was created for the row. */
    expect((await rowOf(ids[0])).created_asset_id).toBeNull();
  });

  it("requires a target for a match, and a reason for a rejection", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Needs" }, { name: "ZAR Needs2" }]);
    expect((await decide("admin", bid, ids[0], { decision: "match_existing" })).status).toBe(400);
    expect((await decide("admin", bid, ids[1], { decision: "reject" })).status).toBe(400);
    expect((await decide("admin", bid, ids[1], { decision: "duplicate" })).status).toBe(400);
    expect((await decide("admin", bid, ids[1],
      { decision: "reject", note: "Not ours." })).status).toBe(200);
  });

  it("defers a physical-verification row instead of creating anything", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Ambiguous", state: "physical_verification" }]);
    const r = await decide("admin", bid, ids[0], { decision: "physical_verification", note: "Two on the shelf." });
    expect(r.status).toBe(200);
    const row = await rowOf(ids[0]);
    expect(row.state).toBe("physical_verification");
    expect(row.created_asset_id, "a provisional asset was created").toBeNull();
    /* And it can still be resolved afterwards. */
    expect((await decide("admin", bid, ids[0], { decision: "new" })).status).toBe(200);
  });

  it("will not decide the same row twice", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Once" }]);
    expect((await decide("admin", bid, ids[0], { decision: "reject", note: "no" })).status).toBe(200);
    const again = await decide("admin", bid, ids[0], { decision: "new" });
    expect(again.status).toBe(409);
    expect(String(again.body.message)).toMatch(/already rejected/i);
  });

  it("lets exactly ONE of two simultaneous approvals through", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Race" }]);
    const results = await Promise.all([
      decide("admin", bid, ids[0], { decision: "new" }),
      decide("custMC", bid, ids[0], { decision: "new" }),
    ]);
    const outcome = results.map((r) => r.status).join(",");
    expect(results.filter((r) => r.status === 200).length, outcome).toBe(1);
    expect(results.filter((r) => r.status === 409).length, outcome).toBe(1);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE model=$1 AND category_id=$2`,
      ["ZAR Race", categoryId])).rows[0].c),
      `two assets were created from one row · ${outcome}`).toBe(1);
  });

  it("gives concurrent approvals distinct internal codes", async () => {
    const { bid, ids } = await seedBatch([
      { name: "ZAR Alloc A" }, { name: "ZAR Alloc B" }, { name: "ZAR Alloc C" }]);
    await Promise.all(ids.map((id) => decide("admin", bid, id, { decision: "new" })));
    const codes = (await pool.query(
      `SELECT i.internal_code FROM mo_asset_import_rows r
         JOIN mo_equipment_items i ON i.id = r.created_asset_id
        WHERE r.batch_id=$1`, [bid])).rows.map((r) => r.internal_code);
    expect(codes.length).toBe(3);
    expect(new Set(codes).size, `codes: ${codes.join(",")}`).toBe(3);
  });

  /* ── PROVENANCE ────────────────────────────────────────────────────────── */

  it("makes asset → audit → batch → source row reconstructable", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Traceable" }]);
    await decide("admin", bid, ids[0], { decision: "new" });
    const assetId = Number((await rowOf(ids[0])).created_asset_id);
    const trail = (await pool.query(
      `SELECT action, after FROM mo_audit_logs
        WHERE entity_type='equipment_item' AND entity_id=$1
          AND action='asset_import.new_asset_approved'`, [assetId])).rows[0];
    expect(trail, "no provenance audit was written").toBeDefined();
    const after = trail.after as Record<string, unknown>;
    expect(Number(after.batch_id)).toBe(bid);
    expect(Number(after.import_row_id)).toBe(ids[0]);
    expect(Number(after.source_row)).toBe(2);
    /* And no provenance column was added to the asset table. */
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='mo_equipment_items'`))
      .rows.map((r) => r.column_name);
    for (const c of ["import_batch_id", "source_row", "imported_from"])
      expect(cols, `a provenance column was added: ${c}`).not.toContain(c);
  });

  it("is visible to the 17K dashboard with no import-specific logic", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Dashboard" }]);
    await decide("admin", bid, ids[0], { decision: "new" });
    /* Created as a draft, so it belongs in the verification queue. */
    const d = (await as("admin", "GET", "/equipment/dashboard?inventory=media_crew")).body as unknown as
      { summary: Record<string, number>; verification: { id: number }[] };
    expect(d.summary.pending_verification).toBeGreaterThanOrEqual(1);
    const assetId = Number((await rowOf(ids[0])).created_asset_id);
    expect(d.verification.map((r) => Number(r.id))).toContain(assetId);
  });

  /* ── AUTHORIZATION ─────────────────────────────────────────────────────── */

  it("refuses a reviewer who does not hold the row's inventory", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR PidRow", scopeId: pid, inventory: "PID" }]);
    const r = await decide("custMC", bid, ids[0], { decision: "new" });
    expect(r.status).toBe(404);
    expect(String(r.body.message)).toBe("Import row not found.");
    expect((await rowOf(ids[0])).state).toBe("pending_review");
    /* The PID custodian may. */
    expect((await decide("custPID", bid, ids[0], { decision: "new" })).status).toBe(200);
  });

  it("refuses matching an asset the reviewer cannot reach", async () => {
    const theirs = idOf(await mk("admin", { scope_id: pid, model: "ZAR TheirAsset" }));
    const { bid, ids } = await seedBatch([{ name: "ZAR CrossMatch" }]);
    const r = await decide("custMC", bid, ids[0], { decision: "match_existing", matched_asset_id: theirs });
    expect(r.status).toBe(404);
    expect((await rowOf(ids[0])).matched_asset_id).toBeNull();
  });

  it("refuses a caller who cannot manage equipment at all", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Auth" }]);
    for (const who of ["plain", "outsider", "anon"] as const)
      expect((await decide(who, bid, ids[0], { decision: "new" })).status, who)
        .toBeGreaterThanOrEqual(403);
    expect((await as("plain", "GET", `/equipment/imports/${bid}`)).status).toBe(403);
  });

  it("hides another inventory's rows from the review list", async () => {
    const { bid } = await seedBatch([
      { name: "ZAR Mine", scopeId: mediaCrew }, { name: "ZAR Theirs", scopeId: pid }]);
    const seen = ((await as("custMC", "GET", `/equipment/imports/${bid}`)).body
      .rows as unknown as { items: { normalized_name: string }[] }).items.map((r) => r.normalized_name);
    expect(seen).toContain("ZAR Mine");
    expect(seen, "a PID row was shown to a Media Crew custodian").not.toContain("ZAR Theirs");
  });

  it("shows a row with no inventory to any importer, because that is the question", async () => {
    const { bid } = await seedBatch([{ name: "ZAR Homeless", scopeId: null,
      inventory: "Design Cell", state: "scope_decision_required" }]);
    const seen = ((await as("custMC", "GET", `/equipment/imports/${bid}`)).body
      .rows as unknown as { items: { normalized_name: string }[] }).items.map((r) => r.normalized_name);
    expect(seen).toContain("ZAR Homeless");
  });

  it("will not approve a row with no inventory or no category", async () => {
    const { bid, ids } = await seedBatch([
      { name: "ZAR NoScope", scopeId: null, state: "scope_decision_required" },
      { name: "ZAR NoCat", categoryId: null, state: "category_review_required" }]);
    expect((await decide("admin", bid, ids[0], { decision: "new" })).status).toBe(400);
    expect((await decide("admin", bid, ids[1], { decision: "new" })).status).toBe(400);
    /* Supplying the missing answer makes it approvable. */
    expect((await decide("admin", bid, ids[0],
      { decision: "new", scope_id: mediaCrew })).status).toBe(200);
  });

  /* ── THE BATCH ─────────────────────────────────────────────────────────── */

  it("counts what is left rather than storing a tally", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR C1" }, { name: "ZAR C2" }, { name: "ZAR C3" }]);
    await decide("admin", bid, ids[0], { decision: "new" });
    await decide("admin", bid, ids[1], { decision: "reject", note: "duplicate of C1" });
    const c = (await as("admin", "GET", `/equipment/imports/${bid}`)).body
      .counts as unknown as Record<string, number>;
    expect(Number(c.total)).toBe(3);
    expect(Number(c.imported)).toBe(1);
    expect(Number(c.rejected)).toBe(1);
    expect(Number(c.pending)).toBe(1);
  });

  it("closes a batch without touching an asset, and refuses decisions afterwards", async () => {
    const { bid, ids } = await seedBatch([{ name: "ZAR Closing" }]);
    const assetsBefore = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE category_id=$1`, [categoryId])).rows[0].c);
    expect((await as("admin", "POST", `/equipment/imports/${bid}/close`,
      { status: "cancelled" })).status).toBe(200);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE category_id=$1`, [categoryId])).rows[0].c),
      "cancelling a batch changed the estate").toBe(assetsBefore);
    const r = await decide("admin", bid, ids[0], { decision: "new" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toMatch(/cancelled/i);
  });

  it("404s a batch and a row that do not exist", async () => {
    expect((await as("admin", "GET", "/equipment/imports/2147483600")).status).toBe(404);
    const { bid } = await seedBatch([{ name: "ZAR Ghost" }]);
    expect((await decide("admin", bid, 2147483600, { decision: "new" })).status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17M — THE PHYSICAL VERIFICATION WORKLIST.

   The worklist is a READ MODEL over 17L reconciliation rows. There is no queue
   table and no second verification state, so most of what these tests assert is
   that nothing new was invented: a row is here because its 17L state says so,
   it leaves because a 17L decision moved it, and the evidence it collects is a
   17I inspection against a real asset.

   The three domains stay apart, and several tests below exist only to prove it:
   an inspection does not decide identity, a decision does not edit an asset,
   and neither of them verifies an asset for circulation.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the physical verification worklist", () => {
  type SeedRow = Record<string, unknown>;
  /* Batches are seeded directly: the upload middleware is not mounted in this
     harness, and the worklist reads rows rather than files. */
  const seedPV = async (rows: SeedRow[], fileTag = "pv") => {
    const bid = Number((await pool.query(
      `INSERT INTO mo_asset_import_batches (file_name, uploaded_by, rows_total)
       VALUES ($1,$2,$3) RETURNING id`, [`${PX}-${fileTag}.csv`, A.admin.id, rows.length])).rows[0].id);
    const ids: number[] = [];
    for (const [i, r] of rows.entries())
      ids.push(Number((await pool.query(
        `INSERT INTO mo_asset_import_rows
           (batch_id, source_row, source_name, source_inventory, source_sr_no, normalized_name,
            proposed_category_id, proposed_scope_id, proposed_tracking_mode, proposed_quantity,
            proposed_serial_no, warnings, candidates, state, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15) RETURNING id`,
        [bid, i + 2, r.name ?? "ZAR PV Camera", r.inventory ?? "Media Crew", r.srNo ?? null,
         r.name ?? "ZAR PV Camera",
         "categoryId" in r ? r.categoryId : categoryId,
         "scopeId" in r ? r.scopeId : mediaCrew,
         r.tracking ?? "individual", r.quantity ?? null, r.serial ?? null,
         JSON.stringify(r.warnings ?? []), JSON.stringify(r.candidates ?? []),
         r.state ?? "physical_verification", r.reviewedAt ?? null])).rows[0].id));
    return { bid, ids };
  };
  /* A candidate as 17L writes them into the row. */
  const cand = (id: number, tag: string, confidence = "POSSIBLE") =>
    ({ asset_id: id, asset_tag: tag, confidence, why: "Name contains the model" });

  const list = (actor: ActorName | "anon", qs = "") =>
    as(actor, "GET", `/equipment/verification-worklist${qs}`);
  const one = (actor: ActorName | "anon", rowId: number) =>
    as(actor, "GET", `/equipment/verification-worklist/${rowId}`);
  const decide = (actor: ActorName | "anon", bid: number, rowId: number, body: Record<string, unknown>) =>
    as(actor, "POST", `/equipment/imports/${bid}/rows/${rowId}/decision`, body);
  const rowOf = async (id: number) => (await pool.query(
    `SELECT * FROM mo_asset_import_rows WHERE id=$1`, [id])).rows[0];
  const inspect = (actor: ActorName, assetId: number, body: Record<string, unknown>) =>
    as(actor, "POST", `/equipment/${assetId}/inspections`, body);
  /* Only ever this suite's own rows: the worklist is global to the caller's
     scope, and sibling suites import too. */
  const mineIn = (r: { body: Record<string, never> }, ids: number[]) =>
    (r.body.items as unknown as { id: number }[]).map((x) => Number(x.id)).filter((x) => ids.includes(x));

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_asset_import_batches WHERE file_name LIKE $1`, [`${PX}-%`]);
  });

  /* ── The list itself ──────────────────────────────────────────────────── */

  it("gathers rows from every batch, so nobody opens batches one at a time", async () => {
    const a = await seedPV([{ name: "ZAR PV One" }], "pvA");
    const b = await seedPV([{ name: "ZAR PV Two" }], "pvB");
    const seen = mineIn(await list("admin", "?limit=200"), [...a.ids, ...b.ids]);
    expect(seen).toContain(a.ids[0]);
    expect(seen, "the worklist was still per-batch").toContain(b.ids[0]);
  });

  it("lists physical_verification and nothing else", async () => {
    const { ids } = await seedPV([
      { name: "ZAR PV Wanted" },
      { name: "ZAR PV Pending",  state: "pending_review" },
      { name: "ZAR PV Imported", state: "imported" },
      { name: "ZAR PV Rejected", state: "rejected" },
      { name: "ZAR PV Matched",  state: "matched_existing" },
      { name: "ZAR PV Identity", state: "identity_decision_required" },
    ]);
    expect(mineIn(await list("admin", "?limit=200"), ids)).toEqual([ids[0]]);
  });

  it("cannot be widened into a general row browser by asking", async () => {
    /* `state` is not a filter here. The endpoint IS the queue. */
    const { ids } = await seedPV([
      { name: "ZAR PV Open" }, { name: "ZAR PV Hidden", state: "pending_review" }]);
    for (const qs of ["?state=all", "?state=pending_review", "?state=imported"])
      expect(mineIn(await list("admin", `${qs}&limit=200`), ids), qs).toEqual([ids[0]]);
  });

  it("pages on the server and reports a total", async () => {
    const { ids } = await seedPV(Array.from({ length: 5 }, (_, i) => ({ name: `ZAR PV Page ${i}` })));
    const p1 = await list("admin", "?limit=2&offset=0");
    expect((p1.body.items as unknown[]).length).toBeLessThanOrEqual(2);
    expect(Number(p1.body.total)).toBeGreaterThanOrEqual(ids.length);
    /* Page 1 and page 2 do not overlap, which is the property paging has. */
    const idsOn = (r: { body: Record<string, never> }) =>
      (r.body.items as unknown as { id: number }[]).map((x) => Number(x.id));
    const p2 = await list("admin", "?limit=2&offset=2");
    expect(idsOn(p1).filter((x) => idsOn(p2).includes(x))).toEqual([]);
  });

  it("shows the source, the proposal and the top candidate without a second request", async () => {
    const asset = idOf(await mk("admin", { scope_id: mediaCrew, model: "PVCand" }));
    const tag = String((await pool.query(
      `SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [asset])).rows[0].asset_tag);
    const { ids } = await seedPV([{ name: "ZAR PV Shown", srNo: "14",
      candidates: [cand(asset, tag, "POSSIBLE"), cand(asset, tag, "POSSIBLE")] }]);
    const row = (await list("admin", "?limit=200")).body.items as unknown as Record<string, unknown>[];
    const mine = row.find((r) => Number(r.id) === ids[0])!;
    expect(mine.source_name).toBe("ZAR PV Shown");
    expect(mine.source_sr_no, "Sr. No was lost or mistaken for a serial").toBe("14");
    expect(mine.proposed_category_name).toBeTruthy();
    expect(mine.proposed_inventory_name).toBeTruthy();
    expect(Number(mine.candidate_count)).toBe(2);
    expect(mine.top_candidate_tag).toBe(tag);
    expect(mine.top_candidate_confidence).toBe("POSSIBLE");
    expect(Number(mine.age_days)).toBeGreaterThanOrEqual(0);
  });

  /* ── Filters ──────────────────────────────────────────────────────────── */

  it("filters by batch, name, inventory and whether there is a candidate at all", async () => {
    const asset = idOf(await mk("admin", { scope_id: mediaCrew, model: "PVFilter" }));
    const a = await seedPV([{ name: "ZAR PV Alpha", candidates: [cand(asset, "EQ-X-1")] }], "fA");
    const b = await seedPV([{ name: "ZAR PV Beta" }], "fB");
    const all = [...a.ids, ...b.ids];
    expect(mineIn(await list("admin", `?batch_id=${a.bid}&limit=200`), all)).toEqual(a.ids);
    expect(mineIn(await list("admin", "?q=Beta&limit=200"), all)).toEqual(b.ids);
    expect(mineIn(await list("admin", "?candidate=any&limit=200"), all)).toEqual(a.ids);
    expect(mineIn(await list("admin", "?candidate=none&limit=200"), all)).toEqual(b.ids);
    expect(mineIn(await list("admin", "?inventory=media_crew&limit=200"), all).sort()).toEqual([...all].sort());
  });

  it("filters by age using the day the row entered the queue, not an invented score", async () => {
    const old = new Date(Date.now() - 9 * 864e5).toISOString();
    const { ids } = await seedPV([
      { name: "ZAR PV Old", reviewedAt: old },
      { name: "ZAR PV New" }]);
    expect(mineIn(await list("admin", "?age_days=5&limit=200"), ids)).toEqual([ids[0]]);
    const aged = ((await list("admin", "?age_days=5&limit=200")).body.items as unknown as
      { id: number; age_days: number }[]).find((r) => Number(r.id) === ids[0])!;
    expect(Number(aged.age_days)).toBeGreaterThanOrEqual(9);
  });

  it("sorts by date only — oldest first by default, newest on request", async () => {
    const { ids } = await seedPV([
      { name: "ZAR PV Older", reviewedAt: new Date(Date.now() - 6 * 864e5).toISOString() },
      { name: "ZAR PV Newer", reviewedAt: new Date(Date.now() - 1 * 864e5).toISOString() }]);
    expect(mineIn(await list("admin", "?limit=200"), ids)).toEqual([ids[0], ids[1]]);
    expect(mineIn(await list("admin", "?sort=newest&limit=200"), ids)).toEqual([ids[1], ids[0]]);
  });

  it("filters by candidate confidence, which the row already records", async () => {
    const { ids } = await seedPV([
      { name: "ZAR PV High", candidates: [cand(1, "EQ-A-1", "HIGH")] },
      { name: "ZAR PV Poss", candidates: [cand(1, "EQ-A-2", "POSSIBLE")] }]);
    expect(mineIn(await list("admin", "?confidence=HIGH&limit=200"), ids)).toEqual([ids[0]]);
    expect(mineIn(await list("admin", "?confidence=POSSIBLE&limit=200"), ids)).toEqual([ids[1]]);
  });
});

maybe("physical verification is scoped, and cannot be stepped around", () => {
  const seedPV = async (rows: Record<string, unknown>[], fileTag = "sec") => {
    const bid = Number((await pool.query(
      `INSERT INTO mo_asset_import_batches (file_name, uploaded_by, rows_total)
       VALUES ($1,$2,$3) RETURNING id`, [`${PX}-${fileTag}.csv`, A.admin.id, rows.length])).rows[0].id);
    const ids: number[] = [];
    for (const [i, r] of rows.entries())
      ids.push(Number((await pool.query(
        `INSERT INTO mo_asset_import_rows
           (batch_id, source_row, source_name, normalized_name, proposed_category_id,
            proposed_scope_id, candidates, state)
         VALUES ($1,$2,$3,$3,$4,$5,$6::jsonb,'physical_verification') RETURNING id`,
        [bid, i + 2, r.name ?? "ZAR Sec Row", categoryId,
         "scopeId" in r ? r.scopeId : mediaCrew,
         JSON.stringify(r.candidates ?? [])])).rows[0].id));
    return { bid, ids };
  };
  const list = (actor: ActorName | "anon", qs = "") =>
    as(actor, "GET", `/equipment/verification-worklist${qs}`);
  const one = (actor: ActorName | "anon", rowId: number) =>
    as(actor, "GET", `/equipment/verification-worklist/${rowId}`);
  const mineIn = (r: { body: Record<string, never> }, ids: number[]) =>
    (r.body.items as unknown as { id: number }[]).map((x) => Number(x.id)).filter((x) => ids.includes(x));

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_asset_import_batches WHERE file_name LIKE $1`, [`${PX}-%`]);
  });

  it("shows each custodian their own inventory and not the other one", async () => {
    const { ids } = await seedPV([{ name: "ZAR Sec MC", scopeId: mediaCrew },
                                  { name: "ZAR Sec PID", scopeId: pid }]);
    expect(mineIn(await list("custMC", "?limit=200"), ids), "a Media Crew custodian saw PID work")
      .toEqual([ids[0]]);
    expect(mineIn(await list("custPID", "?limit=200"), ids), "a PID custodian saw Media Crew work")
      .toEqual([ids[1]]);
    expect(mineIn(await list("admin", "?limit=200"), ids).sort()).toEqual([...ids].sort());
  });

  it("answers 404 for a row in another inventory, exactly as for one that never existed", async () => {
    const { ids } = await seedPV([{ name: "ZAR Sec Hidden", scopeId: pid }]);
    const denied = await one("custMC", ids[0]);
    const absent = await one("custMC", 2147483600);
    expect(denied.status, "cross-inventory access leaked a different answer").toBe(404);
    expect(denied.status).toBe(absent.status);
    expect(JSON.stringify(denied.body)).toBe(JSON.stringify(absent.body));
  });

  it("shows a row with no inventory to everybody, because deciding that is the job", async () => {
    const { ids } = await seedPV([{ name: "ZAR Sec Orphan", scopeId: null }]);
    for (const who of ["custMC", "custPID", "admin"] as ActorName[])
      expect(mineIn(await list(who, "?limit=200"), ids), who).toEqual(ids);
  });

  it("narrowing to an inventory you do not hold returns nothing, never everything", async () => {
    const { ids } = await seedPV([{ name: "ZAR Sec MC2", scopeId: mediaCrew },
                                  { name: "ZAR Sec PID2", scopeId: pid }]);
    expect(mineIn(await list("custMC", "?inventory=pid&limit=200"), ids)).toEqual([]);
  });

  it("is refused to anonymous callers, outsiders and anyone without the duty", async () => {
    const { ids } = await seedPV([{ name: "ZAR Sec Auth" }]);
    for (const who of ["anon", "outsider", "plain"] as (ActorName | "anon")[]) {
      expect((await list(who)).status, who).toBe(403);
      expect((await one(who, ids[0])).status, who).toBe(403);
    }
  });

  it("does not list a candidate asset the caller may not see", async () => {
    /* The row is unscoped so it is visible; its candidate is in PID. A Media
       Crew custodian gets the row and an empty candidate list — and the 17L
       decision endpoint 404s that asset too, so the screen and the action
       agree about what exists. */
    const hidden = idOf(await mk("admin", { scope_id: pid, model: "SecHidden" }));
    const tag = String((await pool.query(
      `SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [hidden])).rows[0].asset_tag);
    const { bid, ids } = await seedPV([{ name: "ZAR Sec Leak", scopeId: null,
      candidates: [{ asset_id: hidden, asset_tag: tag, confidence: "POSSIBLE", why: "x" }] }]);
    const seen = await one("custMC", ids[0]);
    expect(seen.status).toBe(200);
    expect((seen.body.candidates as unknown[]).length, "a PID asset leaked through a candidate list").toBe(0);
    /* Admin, who may see it, does get it — so the empty list above is scope
       and not a broken join. */
    expect(((await one("admin", ids[0])).body.candidates as unknown[]).length).toBe(1);
    /* And it cannot be chosen. */
    expect((await as("custMC", "POST", `/equipment/imports/${bid}/rows/${ids[0]}/decision`,
      { decision: "match_existing", matched_asset_id: hidden })).status).toBe(404);
  });
});

maybe("what the verifier saw, and what it is allowed to change", () => {
  const seedPV = async (rows: Record<string, unknown>[], fileTag = "ev") => {
    const bid = Number((await pool.query(
      `INSERT INTO mo_asset_import_batches (file_name, uploaded_by, rows_total)
       VALUES ($1,$2,$3) RETURNING id`, [`${PX}-${fileTag}.csv`, A.admin.id, rows.length])).rows[0].id);
    const ids: number[] = [];
    for (const [i, r] of rows.entries())
      ids.push(Number((await pool.query(
        `INSERT INTO mo_asset_import_rows
           (batch_id, source_row, source_name, normalized_name, source_sr_no, proposed_category_id,
            proposed_scope_id, proposed_serial_no, candidates, state)
         VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8::jsonb,'physical_verification') RETURNING id`,
        [bid, i + 2, r.name ?? "ZAR Ev Row", r.srNo ?? null, categoryId, mediaCrew,
         r.serial ?? null, JSON.stringify(r.candidates ?? [])])).rows[0].id));
    return { bid, ids };
  };
  const cand = (id: number, tag: string, confidence = "POSSIBLE") =>
    ({ asset_id: id, asset_tag: tag, confidence, why: "Name contains the model" });
  const decide = (actor: ActorName, bid: number, rowId: number, body: Record<string, unknown>) =>
    as(actor, "POST", `/equipment/imports/${bid}/rows/${rowId}/decision`, body);
  const one = (actor: ActorName, rowId: number) =>
    as(actor, "GET", `/equipment/verification-worklist/${rowId}`);
  const list = (actor: ActorName, qs = "") =>
    as(actor, "GET", `/equipment/verification-worklist${qs}`);
  const rowOf = async (id: number) => (await pool.query(
    `SELECT * FROM mo_asset_import_rows WHERE id=$1`, [id])).rows[0];
  const assetRow = async (id: number) => (await pool.query(
    `SELECT * FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
  const inspect = (actor: ActorName, assetId: number, body: Record<string, unknown>) =>
    as(actor, "POST", `/equipment/${assetId}/inspections`, body);
  const withCandidate = async (model: string, serial: string | null = null) => {
    const id = idOf(await mk("admin", { scope_id: mediaCrew, model, ...(serial ? { serial_no: serial } : {}) }));
    const tag = String((await assetRow(id)).asset_tag);
    return { id, tag };
  };

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_asset_import_batches WHERE file_name LIKE $1`, [`${PX}-%`]);
  });

  /* ── The inspection is 17I's, unchanged ───────────────────────────────── */

  it("records evidence through the existing inspection endpoint, not a new one", async () => {
    const c = await withCandidate("EvInspect");
    const { ids } = await seedPV([{ name: "ZAR Ev Inspect", candidates: [cand(c.id, c.tag)] }]);
    const r = await inspect("admin", c.id, { observed_condition: "fair", outcome: "passed",
                                             notes: "ZAR seen on the shelf" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const kept = (await pool.query(
      `SELECT observed_condition, outcome, notes, inspector_id
         FROM mo_asset_inspections WHERE equipment_item_id=$1`, [c.id])).rows;
    expect(kept.length).toBe(1);
    expect(kept[0].observed_condition).toBe("fair");
    expect(kept[0].inspector_id).toBe(A.admin.id);
    /* 17I's own rule, untouched: the asset carries the latest observation. */
    expect((await assetRow(c.id)).condition).toBe("fair");
    expect(Number(ids.length)).toBe(1);
  });

  it("turns the row from waiting into looked-at without persisting a second state", async () => {
    const c = await withCandidate("EvProgress");
    const { ids } = await seedPV([{ name: "ZAR Ev Progress", candidates: [cand(c.id, c.tag)] }]);
    const inspectedFlag = async () => ((await one("admin", ids[0])).body.row as
      unknown as { inspected: boolean }).inspected;
    expect(await inspectedFlag(), "a row nobody looked at reported an inspection").toBe(false);
    await inspect("admin", c.id, { observed_condition: "good", outcome: "passed" });
    expect(await inspectedFlag(), "the worklist did not see the inspection").toBe(true);
    /* And the reconciliation state is the one 17L set. Nothing was added. */
    expect((await rowOf(ids[0])).state).toBe("physical_verification");
  });

  it("keeps 17I's maintenance behaviour exactly as it was", async () => {
    const c = await withCandidate("EvBroken");
    await seedPV([{ name: "ZAR Ev Broken", candidates: [cand(c.id, c.tag)] }]);
    await inspect("admin", c.id, { observed_condition: "poor", outcome: "maintenance_required",
                                   notes: "ZAR lens mount cracked" });
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records
        WHERE equipment_item_id=$1 AND resolved_at IS NULL`, [c.id])).rows[0].c)).toBe(1);
    expect((await assetRow(c.id)).status, "a failed inspection stopped moving the asset to maintenance")
      .toBe("maintenance");
  });

  it("lets two people inspect the same asset — an observation is not a decision", async () => {
    const c = await withCandidate("EvTwice");
    await seedPV([{ name: "ZAR Ev Twice", candidates: [cand(c.id, c.tag)] }]);
    const [a, b] = await Promise.all([
      inspect("admin", c.id, { observed_condition: "good", outcome: "passed" }),
      inspect("custMC", c.id, { observed_condition: "fair", outcome: "passed" })]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_asset_inspections WHERE equipment_item_id=$1`,
      [c.id])).rows[0].c)).toBe(2);
  });

  /* ── Identity ─────────────────────────────────────────────────────────── */

  it("matches when the serial the verifier read is the serial on record", async () => {
    const c = await withCandidate("EvSame", "ZAR-SN-1001");
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Same", candidates: [cand(c.id, c.tag, "HIGH")] }]);
    const r = await decide("admin", bid, ids[0],
      { decision: "match_existing", matched_asset_id: c.id, observed_serial_no: "zar sn 1001" });
    expect(r.status, "punctuation and case were treated as a different serial").toBe(200);
    expect((await rowOf(ids[0])).state).toBe("matched_existing");
  });

  it("REFUSES to match two different serials, and changes nothing while refusing", async () => {
    const c = await withCandidate("EvClash", "ZAR-SN-2002");
    const before = await assetRow(c.id);
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Clash", candidates: [cand(c.id, c.tag, "HIGH")] }]);
    const r = await decide("admin", bid, ids[0],
      { decision: "match_existing", matched_asset_id: c.id, observed_serial_no: "ZAR-SN-9999" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(String((r.body as { message?: string }).message ?? "")).toMatch(/identity conflict/i);
    /* THE ASSET IS UNTOUCHED — every column of it — and so is the row. */
    expect(await assetRow(c.id), "a refused match edited the asset").toEqual(before);
    expect((await rowOf(ids[0])).state, "a refused match closed the row").toBe("physical_verification");
  });

  it("allows the match when a human says so explicitly, and records that they did", async () => {
    const c = await withCandidate("EvOverride", "ZAR-SN-3003");
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Override", candidates: [cand(c.id, c.tag, "HIGH")] }]);
    const r = await decide("admin", bid, ids[0], { decision: "match_existing", matched_asset_id: c.id,
      observed_serial_no: "ZAR-SN-7777", confirm_identity_conflict: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    /* Still not rewritten. Confirming means "match them anyway", never
       "correct the record to what I typed". */
    expect((await assetRow(c.id)).serial_no).toBe("ZAR-SN-3003");
    /* Pinned to THIS row, not just to this actor and a LIMIT 1. Sequential
       tests make the looser query correct today and fragile the moment a
       second test in this file overrides a conflict. TEST_STABILITY entry 17. */
    const conflict = (await pool.query(
      `SELECT before, after FROM mo_audit_logs
        WHERE action='asset_import.identity_conflict' AND actor_id=$1
          AND (after->>'import_row_id')::bigint = $2`, [A.admin.id, ids[0]])).rows[0];
    expect(conflict, "an overridden conflict left no trace").toBeTruthy();
    expect(conflict.before.recorded_serial_no).toBe("ZAR-SN-3003");
    expect(conflict.after.observed_serial_no).toBe("ZAR-SN-7777");
  });

  it("is not a conflict when the record simply has no serial yet", async () => {
    const c = await withCandidate("EvBlank");
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Blank", candidates: [cand(c.id, c.tag, "HIGH")] }]);
    const r = await decide("admin", bid, ids[0],
      { decision: "match_existing", matched_asset_id: c.id, observed_serial_no: "ZAR-SN-4004" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    /* New information is still not a licence to write it. */
    expect((await assetRow(c.id)).serial_no).toBeNull();
  });

  it("completes a verification for equipment carrying no Nerve identifier at all", async () => {
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Nameless" }]);
    const r = await decide("admin", bid, ids[0], { decision: "new", observed_make: "Sony" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await rowOf(ids[0])).state).toBe("imported");
  });

  /* ── Closure ──────────────────────────────────────────────────────────── */

  it("creates a DRAFT asset carrying the serial that was read off the equipment", async () => {
    const { bid, ids } = await seedPV([{ name: "ZAR Ev New", serial: "SHEET-SAYS-1" }]);
    const r = await decide("admin", bid, ids[0],
      { decision: "new", observed_serial_no: "ACTUALLY-2", observed_make: "Sony" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const made = await assetRow(Number((await rowOf(ids[0])).created_asset_id));
    expect(made.serial_no, "the sheet outranked the person holding the camera").toBe("ACTUALLY-2");
    expect(made.verification_state, "physical verification skipped 17D").toBe("draft");
    /* The sheet's claim is not lost — it is in the provenance. */
    const ev = (await pool.query(
      `SELECT after FROM mo_audit_logs WHERE action='asset_import.new_asset_approved'
         AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [Number(made.id)])).rows[0];
    expect(ev.after.observed.source_claimed_serial_no).toBe("SHEET-SAYS-1");
  });

  it("requires a reason for duplicate and reject, and creates nothing either way", async () => {
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Dup" }, { name: "ZAR Ev Rej" }]);
    expect((await decide("admin", bid, ids[0], { decision: "duplicate" })).status).toBe(400);
    expect((await decide("admin", bid, ids[1], { decision: "reject" })).status).toBe(400);
    expect((await decide("admin", bid, ids[0],
      { decision: "duplicate", note: "ZAR already on row 4" })).status).toBe(200);
    expect((await decide("admin", bid, ids[1],
      { decision: "reject", note: "ZAR not equipment" })).status).toBe(200);
    for (const id of ids) {
      const row = await rowOf(id);
      expect(row.state).toBe("rejected");
      expect(row.created_asset_id, "a rejection made an asset").toBeNull();
    }
  });

  it("drops the row off the open worklist once it is resolved, keeping it in the batch", async () => {
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Leaves" }]);
    const mine = async () => ((await list("admin", "?limit=200")).body.items as
      unknown as { id: number }[]).map((x) => Number(x.id)).filter((x) => ids.includes(x));
    expect(await mine()).toEqual(ids);
    await decide("admin", bid, ids[0], { decision: "reject", note: "ZAR done" });
    expect(await mine(), "a resolved row stayed on the queue").toEqual([]);
    /* Still in the batch, with who decided it and when. */
    const row = await rowOf(ids[0]);
    expect(row.reviewed_by).toBe(A.admin.id);
    expect(row.reviewed_at).toBeTruthy();
    expect(Number((await as("admin", "GET", `/equipment/imports/${bid}`)).body.counts!.rejected)).toBe(1);
  });

  /* ── One decision, whatever the traffic ───────────────────────────────── */

  it("lets exactly one decision win when two land together", async () => {
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Race" }]);
    const [a, b] = await Promise.all([
      decide("admin",  bid, ids[0], { decision: "new" }),
      decide("custMC", bid, ids[0], { decision: "reject", note: "ZAR no such thing" })]);
    expect([a.status, b.status].sort(), `${a.status}/${b.status}`).toEqual([200, 409]);
    /* And the losing decision left nothing behind. */
    const row = await rowOf(ids[0]);
    expect(["imported", "rejected"]).toContain(row.state);
    if (row.state === "rejected") expect(row.created_asset_id).toBeNull();
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items WHERE model=$1`,
      ["ZAR Ev Race"])).rows[0].c), "the race created two assets").toBeLessThanOrEqual(1);
  });

  /* ── What verification must never disturb ─────────────────────────────── */

  it("leaves custody, bookings and maintenance exactly as they were", async () => {
    const c = await withCandidate("EvUntouched", "ZAR-SN-5005");
    await as("admin", "POST", `/equipment/${c.id}/checkout`,
      { holder_id: A.custMC.id, expected_return_at: DUE });
    const snap = async () => ({
      asset: await assetRow(c.id),
      tx: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_equipment_transactions WHERE equipment_item_id=$1`,
        [c.id])).rows[0].c),
      bk: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_equipment_bookings WHERE equipment_item_id=$1`,
        [c.id])).rows[0].c),
      mt: Number((await pool.query(
        `SELECT COUNT(*)::int c FROM mo_maintenance_records WHERE equipment_item_id=$1`,
        [c.id])).rows[0].c),
    });
    const before = await snap();
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Untouched", candidates: [cand(c.id, c.tag, "HIGH")] }]);
    await as("admin", "GET", `/equipment/verification-worklist/${ids[0]}`);
    const r = await decide("admin", bid, ids[0],
      { decision: "match_existing", matched_asset_id: c.id, observed_serial_no: "ZAR-SN-5005" });
    expect(r.status).toBe(200);
    expect(await snap(), "reconciliation disturbed the asset's operational life").toEqual(before);
  });

  /* ── Provenance ───────────────────────────────────────────────────────── */

  it("reconstructs batch → row → inspection → audit → asset", async () => {
    const { bid, ids } = await seedPV([{ name: "ZAR Ev Chain", srNo: "27" }]);
    const r = await decide("admin", bid, ids[0],
      { decision: "new", observed_serial_no: "CHAIN-1", observed_model: "ILME-FX3" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = await rowOf(ids[0]);
    const assetId = Number(row.created_asset_id);
    /* The inspection is recorded against the asset that now exists. */
    expect((await inspect("admin", assetId, { observed_condition: "good", outcome: "passed",
                                              notes: "ZAR verified on the shelf" })).status).toBe(201);
    const ev = (await pool.query(
      `SELECT after FROM mo_audit_logs WHERE action='asset_import.new_asset_approved'
         AND entity_type='equipment_item' AND entity_id=$1 ORDER BY id DESC LIMIT 1`, [assetId])).rows[0];
    expect(Number(ev.after.batch_id)).toBe(bid);
    expect(Number(ev.after.import_row_id)).toBe(ids[0]);
    expect(Number(ev.after.source_row)).toBe(2);
    expect(ev.after.observed.serial_no).toBe("CHAIN-1");
    expect(ev.after.observed.model).toBe("ILME-FX3");
    /* Sr. No stayed a row counter and never became a serial. */
    expect(row.source_sr_no).toBe("27");
    expect((await assetRow(assetId)).serial_no).toBe("CHAIN-1");
    /* And the inspection links to the same asset, which links back to the row. */
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_asset_inspections WHERE equipment_item_id=$1`,
      [assetId])).rows[0].c)).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17N — PHYSICAL ASSURANCE.

   "How recently has each asset actually been seen?" — derived entirely from
   mo_asset_inspections at read time.

   The block owns its OWN category. The endpoint is global within the caller's
   scope, and eleven other suites put assets into this inventory while it runs,
   so every count below is taken through `category_id=<ours>`. A bare total
   would be measuring the rest of the test run. TEST_STABILITY entry 17.

   NOTHING HERE ASSERTS A THRESHOLD, because no stocktake interval exists. The
   tests check facts — last seen, never seen, how many days — and one of them
   checks that the words "due" and "overdue" do not appear in the response.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("physical assurance is derived, never stored", () => {
  let cat = 0;
  /* Fixtures, created once: the counts below are exact because nothing else
     writes into this category. */
  let neverA = 0, neverB = 0, onceSeen = 0, thriceSeen = 0, tied = 0, pidAsset = 0, retired = 0;
  const DAY = 864e5;

  const seen = async (assetId: number, daysAgo: number, who: string,
                      condition = "good", outcome = "passed") =>
    Number((await pool.query(
      `INSERT INTO mo_asset_inspections
         (equipment_item_id, inspector_id, observed_condition, outcome, notes, inspected_at)
       VALUES ($1,$2,$3,$4,'ZAR assurance', NOW() - ($5||' days')::interval) RETURNING id`,
      [assetId, who, condition, outcome, String(daysAgo)])).rows[0].id);

  const pa = (actor: ActorName | "anon", qs = "") =>
    as(actor, "GET", `/equipment/physical-assurance?category_id=${cat}${qs}`);
  const rowsOf = (r: { body: Record<string, never> }) =>
    (r.body.assets as unknown as { items: Record<string, unknown>[] }).items;
  const one = (r: { body: Record<string, never> }, id: number) =>
    rowsOf(r).find((x) => Number(x.id) === id);
  const sum = (r: { body: Record<string, never> }) =>
    r.body.summary as unknown as Record<string, number | null>;

  beforeAll(async () => {
    if (!dbUp) return;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ($1,'individual')
       RETURNING id`, ["zna assurance"])).rows[0].id);
    const make = async (o: Record<string, unknown> = {}) =>
      idOf(await mk("admin", { category_id: cat, scope_id: mediaCrew, ...o }));

    neverA     = await make({ model: "PANever A" });
    neverB     = await make({ model: "PANever B" });
    onceSeen   = await make({ model: "PAOnce" });
    thriceSeen = await make({ model: "PAThrice" });
    tied       = await make({ model: "PATied" });
    pidAsset   = await make({ model: "PAPid", scope_id: pid });
    retired    = await make({ model: "PARetired" });
    await as("admin", "POST", `/equipment/${retired}/retire`, { reason: "ZAR beyond repair" });

    await seen(onceSeen, 12, A.custMC.id, "fair", "passed");
    /* Three inspections; only the newest may be reported. The oldest is the
       one with the distinctive condition, so picking the wrong row is visible. */
    await seen(thriceSeen, 40, A.admin.id, "poor", "maintenance_required");
    await seen(thriceSeen, 20, A.admin.id, "fair", "passed");
    await seen(thriceSeen, 2,  A.custMC.id, "excellent", "passed");
  }, 60_000);

  /* ── The latest inspection, and only the latest ────────────────────────── */

  it("reports the newest inspection of an asset that has several", async () => {
    const r = await pa("admin");
    const a = one(r, thriceSeen)!;
    expect(a.last_observed_condition, "an older inspection was reported as the latest").toBe("excellent");
    expect(a.last_outcome).toBe("passed");
    expect(a.last_inspector_name).toBeTruthy();
    expect(Number(a.days_since_inspection)).toBe(2);
  });

  it("breaks a tied timestamp the same way every time", async () => {
    /* inspected_at defaults to NOW(); two rows can share an instant. Without a
       deterministic tie-break the "latest" is whichever the planner returns,
       and one asset reports two different inspectors on two identical reads. */
    const at = new Date(Date.now() - 5 * DAY).toISOString();
    const lo = Number((await pool.query(
      `INSERT INTO mo_asset_inspections (equipment_item_id, inspector_id, observed_condition, outcome, inspected_at)
       VALUES ($1,$2,'poor','passed',$3::timestamptz) RETURNING id`, [tied, A.admin.id, at])).rows[0].id);
    const hi = Number((await pool.query(
      `INSERT INTO mo_asset_inspections (equipment_item_id, inspector_id, observed_condition, outcome, inspected_at)
       VALUES ($1,$2,'excellent','passed',$3::timestamptz) RETURNING id`, [tied, A.custMC.id, at])).rows[0].id);
    expect(hi).toBeGreaterThan(lo);
    for (let i = 0; i < 4; i++)
      expect(one(await pa("admin"), tied)!.last_observed_condition,
        "a tied timestamp resolved differently between two identical reads").toBe("excellent");
  });

  it("says nothing rather than something invented for an asset nobody has seen", async () => {
    const a = one(await pa("admin"), neverA)!;
    expect(a.last_inspected_at, "a never-inspected asset was given a date").toBeNull();
    expect(a.last_inspector_name).toBeNull();
    expect(a.last_observed_condition).toBeNull();
    expect(a.last_outcome).toBeNull();
    expect(a.days_since_inspection, "a never-inspected asset was given an age").toBeNull();
  });

  it("counts age in whole days on the server, not from the browser's clock", async () => {
    expect(Number(one(await pa("admin"), onceSeen)!.days_since_inspection)).toBe(12);
    /* TWO CONDITIONS, TWO CONCEPTS, AND THIS FIXTURE PROVES THEY ARE NOT THE
       SAME FIELD. The inspection history here was written straight to the
       table, so 17I's endpoint never ran and never copied the observation onto
       the asset: the asset still says what it was registered as, while the
       inspection says what somebody wrote down on the day. The read model
       reports both and reconciles neither — that is §19, and a page showing
       one of them labelled as the other would be lying about which. */
    const a = one(await pa("admin"), onceSeen)!;
    expect(a.last_observed_condition, "the observation was lost").toBe("fair");
    expect(a.condition, "the asset's own condition was overwritten by a read").toBe("good");
  });

  /* ── Coverage ─────────────────────────────────────────────────────────── */

  it("computes total, inspected, never inspected and coverage on the server", async () => {
    const s = sum(await pa("admin"));
    expect(Number(s.total), "the fixture set changed").toBe(7);
    expect(Number(s.inspected)).toBe(3);          // once, thrice, tied
    expect(Number(s.never_inspected)).toBe(4);    // neverA, neverB, pid, retired
    expect(Number(s.inspected) + Number(s.never_inspected)).toBe(Number(s.total));
    /* 3/7 = 42.857… → 42.9, rounded once, by the database. */
    expect(Number(s.coverage_pct)).toBeCloseTo(42.9, 1);
    expect(Number(s.oldest_days), "oldest is the longest-ago LAST inspection").toBe(12);
  });

  it("returns a null coverage rather than a zero for an empty selection", async () => {
    const s = sum(await pa("admin", "&lifecycle=lost"));
    expect(Number(s.total)).toBe(0);
    expect(s.coverage_pct, "0 of 0 was reported as 0% coverage").toBeNull();
  });

  /* ── It refuses to decide what nobody has decided ─────────────────────── */

  it("calls nothing due or overdue while its category has no policy", async () => {
    /* 17N asserted this absolutely, because no interval existed anywhere. 17O
       creates intervals, so the enduring property is narrower and stronger: a
       verdict requires a policy. This category has none, so every asset here
       is either never seen or explicitly ungoverned — and NOT quietly filed as
       fine, which is the failure mode that would hide a configuration gap. */
    const rows = rowsOf(await pa("admin"));
    expect(rows.length).toBe(7);
    for (const r of rows) {
      expect(["never_inspected", "no_policy"], String(r.asset_tag))
        .toContain(String(r.inspection_state));
      expect(r.due_at, "a due date was invented without a policy").toBeNull();
      expect(r.policy_id).toBeNull();
    }
    const s = sum(await pa("admin"));
    expect(Number(s.due)).toBe(0);
    expect(Number(s.overdue)).toBe(0);
    expect(Number(s.not_due)).toBe(0);
    expect(Number(s.no_policy), "inspected-but-ungoverned assets vanished").toBe(3);
    expect(Number(s.never_inspected)).toBe(4);
    /* And the five states account for every asset exactly once. */
    expect(Number(s.never_inspected) + Number(s.no_policy) + Number(s.not_due)
         + Number(s.due) + Number(s.overdue)).toBe(Number(s.total));
    expect(JSON.stringify((await pa("admin")).body)).not.toMatch(/compliance/i);
  });

  /* ── Filters ──────────────────────────────────────────────────────────── */

  it("filters to never inspected and to inspected", async () => {
    const ids = (r: { body: Record<string, never> }) =>
      rowsOf(r).map((x) => Number(x.id)).sort((a, b) => a - b);
    expect(ids(await pa("admin", "&inspection=never")))
      .toEqual([neverA, neverB, pidAsset, retired].sort((a, b) => a - b));
    expect(ids(await pa("admin", "&inspection=inspected")))
      .toEqual([onceSeen, thriceSeen, tied].sort((a, b) => a - b));
  });

  it("filters by inventory, lifecycle and verification state", async () => {
    const ids = (r: { body: Record<string, never> }) => rowsOf(r).map((x) => Number(x.id));
    expect(ids(await pa("admin", "&inventory=pid"))).toEqual([pidAsset]);
    expect(ids(await pa("admin", "&lifecycle=retired"))).toEqual([retired]);
    expect(Number(sum(await pa("admin", "&verification=active")).total)).toBe(7);
    expect(Number(sum(await pa("admin", "&verification=draft")).total)).toBe(0);
  });

  /* ── Ordering ─────────────────────────────────────────────────────────── */

  it("orders by date alone — oldest, newest, or never seen first", async () => {
    const insp = (r: { body: Record<string, never> }) =>
      rowsOf(r).filter((x) => x.last_inspected_at !== null).map((x) => Number(x.id));
    expect(insp(await pa("admin", "&sort=oldest")), "oldest first")
      .toEqual([onceSeen, tied, thriceSeen]);
    expect(insp(await pa("admin", "&sort=newest")), "newest first")
      .toEqual([thriceSeen, tied, onceSeen]);
    /* Never-inspected sort to the FRONT here and to the BACK above: an asset
       with no date is not "very old", it is a different question. */
    const first4 = rowsOf(await pa("admin", "&sort=never_first")).slice(0, 4)
      .map((x) => Number(x.id)).sort((a, b) => a - b);
    expect(first4).toEqual([neverA, neverB, pidAsset, retired].sort((a, b) => a - b));
    expect(rowsOf(await pa("admin", "&sort=oldest")).slice(-4)
      .every((x) => x.last_inspected_at === null)).toBe(true);
  });

  /* ── Paging ───────────────────────────────────────────────────────────── */

  it("pages on the server and never returns the whole estate", async () => {
    const p1 = await pa("admin", "&limit=3&offset=0");
    const p2 = await pa("admin", "&limit=3&offset=3");
    expect(rowsOf(p1).length).toBe(3);
    const a = rowsOf(p1).map((x) => Number(x.id)), b = rowsOf(p2).map((x) => Number(x.id));
    expect(a.filter((x) => b.includes(x)), "two pages overlapped").toEqual([]);
    expect(Number((p1.body.assets as unknown as { total: number }).total)).toBe(7);
    /* And no argument asks for everything. */
    const wide = (await pa("admin", "&limit=99999")).body.assets as unknown as { limit: number };
    expect(Number(wide.limit)).toBeLessThanOrEqual(200);
  });

  /* ── Reading changes nothing ──────────────────────────────────────────── */

  it("writes nothing at all — no inspection, no audit, no notification", async () => {
    /* SCOPED TO THESE ASSETS, not to this suite's USERS. Counting every
       notification addressed to a zar- user measures the sibling suites too:
       runMediaOpsAutomations() sweeps the whole estate and notifies whichever
       custodians hold the inventory an asset sits in, so a pass firing in
       another file legitimately writes rows to these people while this test is
       between its two reads. It went 50 to 52 for exactly that reason. What
       this test actually claims is that reading the assurance page writes
       nothing ABOUT THESE ASSETS, and that is what is counted.
       TEST_STABILITY entry 17. */
    const counts = async () => (await pool.query(
      `WITH mine AS (SELECT id FROM mo_equipment_items WHERE category_id = $1)
       SELECT (SELECT COUNT(*)::int FROM mo_asset_inspections
                WHERE equipment_item_id IN (SELECT id FROM mine))              AS insp,
              (SELECT COUNT(*)::int FROM mine)                                 AS assets,
              (SELECT COUNT(*)::int FROM mo_notifications
                WHERE entity_type IN ('equipment','maintenance')
                  AND entity_id IN (SELECT id FROM mine))                      AS notes,
              (SELECT COUNT(*)::int FROM mo_audit_logs
                WHERE entity_type='equipment_item'
                  AND entity_id IN (SELECT id FROM mine))                      AS audit`,
      [cat])).rows[0];
    const before = await counts();
    await pa("admin"); await pa("custMC"); await pa("admin", "&sort=never_first");
    await pa("admin", "&inspection=never&limit=200");
    expect(await counts(), "reading the assurance page wrote something").toEqual(before);
  });

  it("reflects a new inspection on the very next read", async () => {
    expect(one(await pa("admin"), neverB)!.last_inspected_at).toBeNull();
    const r = await as("admin", "POST", `/equipment/${neverB}/inspections`,
      { observed_condition: "good", outcome: "passed", notes: "ZAR first look" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const a = one(await pa("admin"), neverB)!;
    expect(a.last_inspected_at, "the read model did not see the inspection").toBeTruthy();
    expect(Number(a.days_since_inspection)).toBe(0);
    expect(a.last_inspector_name).toBeTruthy();
    /* Cleaned up so the coverage fixtures above stay exact for a re-run. */
    await pool.query(`DELETE FROM mo_asset_inspections WHERE equipment_item_id=$1`, [neverB]);
  });

  it("carries the identity a drill-through to Asset 360 needs", async () => {
    const a = one(await pa("admin"), onceSeen)!;
    expect(String(a.asset_tag)).toMatch(/^EQ-/);
    expect(a.internal_code).toBeTruthy();
    expect(a.inventory_name).toBe("Media Crew");
    expect(a.category_name).toBe("zna assurance");
    expect(a.lifecycle).toBeTruthy();
    expect(a.verification_state).toBe("active");
  });
});

maybe("physical assurance is scoped like everything else", () => {
  let cat = 0, mc = 0, pd = 0;
  const pa = (actor: ActorName | "anon", qs = "") =>
    as(actor, "GET", `/equipment/physical-assurance?category_id=${cat}${qs}`);
  const ids = (r: { body: Record<string, never> }) =>
    ((r.body.assets as unknown as { items: { id: number }[] }).items).map((x) => Number(x.id)).sort();

  beforeAll(async () => {
    if (!dbUp) return;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ($1,'individual')
       RETURNING id`, ["zns assurance scope"])).rows[0].id);
    mc = idOf(await mk("admin", { category_id: cat, scope_id: mediaCrew, model: "PAScopeMC" }));
    pd = idOf(await mk("admin", { category_id: cat, scope_id: pid, model: "PAScopePID" }));
  }, 60_000);

  it("shows each custodian their own inventory and not the other", async () => {
    expect(ids(await pa("custMC")), "a Media Crew custodian saw PID assurance").toEqual([mc]);
    expect(ids(await pa("custPID")), "a PID custodian saw Media Crew assurance").toEqual([pd]);
    expect(ids(await pa("admin"))).toEqual([mc, pd].sort());
  });

  it("narrowing to an inventory you do not hold returns nothing, never everything", async () => {
    expect(ids(await pa("custMC", "&inventory=pid"))).toEqual([]);
    /* And the summary agrees with the list — a filtered-out asset is not
       counted in a total the caller was never allowed to see. */
    expect(Number((await pa("custMC", "&inventory=pid")).body.summary!.total)).toBe(0);
  });

  it("gives somebody with no inventory none of the governed estate", async () => {
    /* `plain` holds no inventory. inventoryScopeSql narrows them to the legacy
       estate (scope_id IS NULL), so a scoped asset is simply not there. */
    expect(ids(await pa("plain"))).toEqual([]);
  });

  it("is refused to anonymous callers and to non-media users", async () => {
    for (const who of ["anon", "outsider"] as (ActorName | "anon")[])
      expect((await pa(who)).status, who).toBe(403);
  });

  it("counts only what the caller may see", async () => {
    expect(Number((await pa("custMC")).body.summary!.total)).toBe(1);
    expect(Number((await pa("custPID")).body.summary!.total)).toBe(1);
    expect(Number((await pa("admin")).body.summary!.total)).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17O — INSPECTION POLICY: administration.

   Policy is CONFIGURATION. The tests below are mostly about who may write it
   and what the database refuses to hold, because an interval that can be set
   wrongly is worse than no interval: 17N's honest "143 days, you decide" is
   replaced by a confident answer computed from a number nobody checked.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("inspection policy is governed configuration", () => {
  let cat = 0, other = 0;
  const pol = (actor: ActorName | "anon", method: string, path = "", body?: unknown) =>
    as(actor, method, `/equipment/inspection-policies${path}`, body);
  const mkPol = (body: Record<string, unknown>) =>
    pol("admin", "POST", "", { category_id: cat, interval_days: 30,
                               effective_from: "2026-01-01", ...body });
  const idOfPol = (r: { body: Record<string, never> }) =>
    Number((r.body.policy as unknown as { id: number }).id);

  beforeAll(async () => {
    if (!dbUp) return;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zop policy','individual')
       RETURNING id`)).rows[0].id);
    other = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zoq policy other','individual')
       RETURNING id`)).rows[0].id);
  }, 60_000);

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_inspection_policies WHERE category_id = ANY($1::bigint[])`,
      [[cat, other]]);
  });

  /* ── Who may write it ─────────────────────────────────────────────────── */

  it("is written by a Media Ops admin and by nobody else", async () => {
    expect((await mkPol({})).status).toBe(201);
    /* A custodian runs the cupboard. Setting how often the cupboard must be
       checked is not the same authority, and canManageEquipment would have
       let the governed choose their own cadence. */
    for (const who of ["custMC", "custPID", "plain"] as ActorName[])
      expect((await pol(who, "POST", "", { category_id: cat, interval_days: 45,
        effective_from: "2027-01-01" })).status, who).toBe(403);
    expect((await pol("anon", "POST", "", { category_id: cat, interval_days: 45,
      effective_from: "2027-01-01" })).status).toBe(403);
  });

  it("lets any equipment user READ it, because a global cadence is not a secret", async () => {
    await mkPol({});
    for (const who of ["admin", "custMC", "custPID"] as ActorName[])
      expect((await pol(who, "GET", "?category_id=" + cat)).status, who).toBe(200);
    expect((await pol("outsider", "GET")).status).toBe(403);
  });

  it("refuses a non-admin edit of an existing policy", async () => {
    const id = idOfPol(await mkPol({}));
    expect((await pol("custMC", "PATCH", `/${id}`, { interval_days: 1 })).status).toBe(403);
    expect(Number((await pol("admin", "GET", `/${id}`)).body.policy!.interval_days)).toBe(30);
  });

  /* ── What the database will not hold ──────────────────────────────────── */

  it("refuses an interval that is not a whole, positive, bounded number of days", async () => {
    for (const bad of [0, -1, 1.5, 3651, Number.NaN])
      expect((await mkPol({ interval_days: bad })).status, String(bad)).toBe(400);
    /* The documented bound is ten years, and the day either side of it is the
       test that the bound is the one the table actually carries. */
    expect((await mkPol({ interval_days: 3650, effective_from: "2030-01-01" })).status).toBe(201);
  });

  it("refuses a missing or backwards effective window", async () => {
    expect((await mkPol({ effective_from: "" })).status).toBe(400);
    expect((await mkPol({ effective_from: "01-01-2026" })).status).toBe(400);
    expect((await mkPol({ effective_from: "2026-06-01", effective_to: "2026-05-31" })).status).toBe(400);
    /* Equal dates are a one-day policy, which is legitimate. */
    expect((await mkPol({ effective_from: "2026-06-01", effective_to: "2026-06-01" })).status).toBe(201);
  });

  it("refuses a category that does not exist", async () => {
    expect((await pol("admin", "POST", "", { category_id: 2147483600, interval_days: 30,
      effective_from: "2026-01-01" })).status).toBe(400);
    expect((await pol("admin", "POST", "", { interval_days: 30,
      effective_from: "2026-01-01" })).status).toBe(400);
  });

  it("will not move a policy to another category", async () => {
    /* A policy's category is its identity. Re-pointing it would silently
       rewrite the history of two categories at once. */
    const id = idOfPol(await mkPol({}));
    expect((await pol("admin", "PATCH", `/${id}`, { category_id: other })).status).toBe(400);
  });

  /* ── Overlap ──────────────────────────────────────────────────────────── */

  it("refuses two active policies covering the same category on the same day", async () => {
    expect((await mkPol({ effective_from: "2026-01-01", effective_to: "2026-06-30" })).status).toBe(201);
    const clash = await mkPol({ effective_from: "2026-06-30", effective_to: "2026-12-31" });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    expect(String(clash.body.message)).toMatch(/overlap/i);
  });

  it("allows windows that touch but do not overlap", async () => {
    expect((await mkPol({ effective_from: "2026-01-01", effective_to: "2026-06-30" })).status).toBe(201);
    expect((await mkPol({ interval_days: 60, effective_from: "2026-07-01" })).status).toBe(201);
  });

  it("treats an open-ended policy as covering everything after it", async () => {
    expect((await mkPol({ effective_from: "2026-01-01" })).status).toBe(201);
    expect((await mkPol({ effective_from: "2029-01-01" })).status).toBe(409);
    /* Even a window that ENDS before it started being open-ended still clashes. */
    expect((await mkPol({ effective_from: "2026-02-01", effective_to: "2026-02-02" })).status).toBe(409);
  });

  it("lets an INACTIVE policy overlap, because history is allowed to", async () => {
    const id = idOfPol(await mkPol({ effective_from: "2026-01-01" }));
    expect((await pol("admin", "PATCH", `/${id}`, { is_active: false })).status).toBe(200);
    expect((await mkPol({ interval_days: 45, effective_from: "2026-01-01" })).status).toBe(201);
  });

  it("refuses to REACTIVATE a policy back into an overlap", async () => {
    const a = idOfPol(await mkPol({ effective_from: "2026-01-01" }));
    await pol("admin", "PATCH", `/${a}`, { is_active: false });
    expect((await mkPol({ interval_days: 45, effective_from: "2026-01-01" })).status).toBe(201);
    const back = await pol("admin", "PATCH", `/${a}`, { is_active: true });
    expect(back.status, "an overlap was reachable through reactivation").toBe(409);
  });

  it("keeps one category's policy out of another's way", async () => {
    expect((await mkPol({ effective_from: "2026-01-01" })).status).toBe(201);
    expect((await pol("admin", "POST", "", { category_id: other, interval_days: 90,
      effective_from: "2026-01-01" })).status, "categories collided").toBe(201);
  });

  /* ── Editing and history ──────────────────────────────────────────────── */

  it("updates an interval and says who did it", async () => {
    const id = idOfPol(await mkPol({}));
    const r = await pol("admin", "PATCH", `/${id}`, { interval_days: 45, note: "ZOP tightened" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = r.body.policy as unknown as Record<string, unknown>;
    expect(Number(p.interval_days)).toBe(45);
    expect(p.note).toBe("ZOP tightened");
    expect(p.updated_by).toBe(A.admin.id);
    /* A DATE IS A DAY — not an instant that drifts across a timezone. */
    expect(p.effective_from).toBe("2026-01-01");
  });

  it("keeps an ended policy rather than deleting it", async () => {
    const id = idOfPol(await mkPol({ effective_from: "2026-01-01" }));
    await pol("admin", "PATCH", `/${id}`, { effective_to: "2026-06-30" });
    await mkPol({ interval_days: 60, effective_from: "2026-07-01" });
    const list = (await pol("admin", "GET", `?category_id=${cat}`)).body.items as unknown as unknown[];
    expect(list.length, "the superseded policy was destroyed").toBe(2);
  });

  it("marks exactly one policy as the one in effect today", async () => {
    await mkPol({ effective_from: "2020-01-01", effective_to: "2020-12-31" });
    await mkPol({ interval_days: 60, effective_from: "2021-01-01" });
    const rows = (await pol("admin", "GET", `?category_id=${cat}`)).body
      .items as unknown as { interval_days: number; in_effect: boolean }[];
    const live = rows.filter((r) => r.in_effect);
    expect(live.length).toBe(1);
    expect(Number(live[0].interval_days)).toBe(60);
  });

  /* ── Audit ────────────────────────────────────────────────────────────── */

  it("audits creation and change, with the actor and both values", async () => {
    const id = idOfPol(await mkPol({}));
    await pol("admin", "PATCH", `/${id}`, { interval_days: 45, is_active: false });
    const events = (await pool.query(
      `SELECT action, actor_id, before, after FROM mo_audit_logs
        WHERE entity_type='inspection_policy' AND entity_id=$1 ORDER BY id`, [id])).rows;
    expect(events.map((e) => e.action))
      .toEqual(["inspection_policy.created", "inspection_policy.updated"]);
    expect(events[0].actor_id).toBe(A.admin.id);
    expect(Number(events[0].after.interval_days)).toBe(30);
    /* The activation flip is legible in the pair, which is why it needs no
       event name of its own. */
    expect(events[1].before.interval_days).toBe(30);
    expect(events[1].after.interval_days).toBe(45);
    expect(events[1].before.is_active).toBe(true);
    expect(events[1].after.is_active).toBe(false);
  });

  it("does not audit reading policy", async () => {
    const id = idOfPol(await mkPol({}));
    const count = async () => Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_audit_logs WHERE entity_type='inspection_policy' AND entity_id=$1`,
      [id])).rows[0].c);
    const before = await count();
    await pol("admin", "GET"); await pol("admin", "GET", `/${id}`); await pol("custMC", "GET");
    expect(await count()).toBe(before);
  });

  it("404s a policy that does not exist rather than inventing one", async () => {
    expect((await pol("admin", "GET", "/2147483600")).status).toBe(404);
    expect((await pol("admin", "PATCH", "/2147483600", { interval_days: 10 })).status).toBe(404);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17O — the derived state.

   last inspection + current effective policy + today → one of five states.

   The states are a PARTITION: every asset is in exactly one, and they sum to
   the total. Several tests below check that property directly, because a
   dashboard whose buckets add up to more than the estate is worse than one
   with no buckets at all.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("the inspection state is derived from the policy in effect today", () => {
  let cat = 0;
  const pa = (actor: ActorName | "anon", qs = "") =>
    as(actor, "GET", `/equipment/physical-assurance?category_id=${cat}${qs}`);
  const dash = (actor: ActorName, qs = "") =>
    as(actor, "GET", `/equipment/dashboard?category_id=${cat}${qs}`);
  const rowsOf = (r: { body: Record<string, never> }) =>
    (r.body.assets as unknown as { items: Record<string, unknown>[] }).items;
  const row = (r: { body: Record<string, never> }, id: number) =>
    rowsOf(r).find((x) => Number(x.id) === id)!;
  const sum = (r: { body: Record<string, never> }) =>
    r.body.summary as unknown as Record<string, number | null>;

  const asset = async (model: string) =>
    idOf(await mk("admin", { category_id: cat, scope_id: mediaCrew, model }));
  /* An inspection at noon IST on an exact IST day, so a day boundary in the
     assertion is a day boundary in the database and not a timezone accident. */
  const seenDaysAgo = (assetId: number, days: number) => pool.query(
    `INSERT INTO mo_asset_inspections (equipment_item_id, inspector_id, observed_condition, outcome, inspected_at)
     VALUES ($1,$2,'good','passed',
       ((((NOW() AT TIME ZONE 'Asia/Kolkata')::date - $3::int)::text || ' 12:00:00')::timestamp
         AT TIME ZONE 'Asia/Kolkata'))`, [assetId, A.admin.id, days]);
  const seenOn = (assetId: number, day: string) => pool.query(
    `INSERT INTO mo_asset_inspections (equipment_item_id, inspector_id, observed_condition, outcome, inspected_at)
     VALUES ($1,$2,'good','passed', (($3 || ' 12:00:00')::timestamp AT TIME ZONE 'Asia/Kolkata'))`,
    [assetId, A.admin.id, day]);
  const policy = (body: Record<string, unknown>) => pool.query(
    `INSERT INTO mo_inspection_policies (category_id, interval_days, is_active, effective_from, effective_to, created_by)
     VALUES ($1,$2,COALESCE($3,true),$4::date,$5::date,$6) RETURNING id`,
    [cat, body.interval_days ?? 30, body.is_active ?? null,
     body.effective_from ?? "2020-01-01", body.effective_to ?? null, A.admin.id]);

  beforeAll(async () => {
    if (!dbUp) return;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zor state','individual')
       RETURNING id`)).rows[0].id);
  }, 60_000);

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(`DELETE FROM mo_inspection_policies WHERE category_id=$1`, [cat]);
    await pool.query(
      `DELETE FROM mo_asset_inspections WHERE equipment_item_id IN
         (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE category_id=$1`, [cat]);
  });

  /* ── The five states ──────────────────────────────────────────────────── */

  it("distinguishes never seen, ungoverned, not due, due and overdue", async () => {
    const never = await asset("StNever");
    const ungov = await asset("StUngov");
    await seenDaysAgo(ungov, 5);
    /* No policy yet: one never seen, one seen but ungoverned. */
    let r = await pa("admin");
    expect(row(r, never).inspection_state).toBe("never_inspected");
    expect(row(r, ungov).inspection_state).toBe("no_policy");
    expect(row(r, ungov).due_at, "a due date without a policy").toBeNull();

    await policy({ interval_days: 30 });
    const fresh = await asset("StFresh");   await seenDaysAgo(fresh, 1);
    const exact = await asset("StExact");   await seenDaysAgo(exact, 30);
    const late  = await asset("StLate");    await seenDaysAgo(late, 31);

    r = await pa("admin");
    expect(row(r, fresh).inspection_state).toBe("not_due");
    expect(row(r, exact).inspection_state, "the due date itself is DUE, not overdue").toBe("due");
    expect(row(r, late).inspection_state).toBe("overdue");
    /* A policy does not turn a never-seen asset into an overdue one. */
    expect(row(r, never).inspection_state, "never seen was reclassified").toBe("never_inspected");
    expect(row(r, never).due_at).toBeNull();
    expect(Number(row(r, never).policy_interval_days), "the cadence was hidden").toBe(30);
  });

  it("puts the boundary exactly on the due day", async () => {
    await policy({ interval_days: 10 });
    const before = await asset("BdBefore"); await seenDaysAgo(before, 9);
    const on     = await asset("BdOn");     await seenDaysAgo(on, 10);
    const after  = await asset("BdAfter");  await seenDaysAgo(after, 11);
    const r = await pa("admin");
    expect(row(r, before).inspection_state).toBe("not_due");
    expect(row(r, on).inspection_state).toBe("due");
    expect(row(r, after).inspection_state).toBe("overdue");
    expect(Number(row(r, before).days_until_due)).toBe(1);
    expect(Number(row(r, on).days_until_due)).toBe(0);
    expect(Number(row(r, after).days_until_due)).toBe(-1);
  });

  it("counts the due date with real calendar arithmetic, across months and leap years", async () => {
    await policy({ interval_days: 30 });
    /* 2026 is not a leap year: 31 Jan + 30 days is 2 March. */
    const a = await asset("CalCommon"); await seenOn(a, "2026-01-31");
    /* 2028 is: 31 Jan + 30 days is 1 March. One day's difference, from the
       calendar rather than from any arithmetic this code performs. */
    const b = await asset("CalLeap");   await seenOn(b, "2028-01-31");
    /* And across a year end. */
    const c = await asset("CalYear");   await seenOn(c, "2026-12-20");
    const r = await pa("admin", "&limit=200");
    expect(row(r, a).due_at).toBe("2026-03-02");
    expect(row(r, b).due_at).toBe("2028-03-01");
    expect(row(r, c).due_at).toBe("2027-01-19");
  });

  /* ── Which policy applies ─────────────────────────────────────────────── */

  it("ignores a policy that has not started and one that has ended", async () => {
    const a = await asset("EffAsset"); await seenDaysAgo(a, 5);
    await policy({ interval_days: 90, effective_from: "2020-01-01", effective_to: "2020-12-31" });
    expect(row(await pa("admin"), a).inspection_state,
      "an expired policy was still governing").toBe("no_policy");
    await policy({ interval_days: 90, effective_from: "2099-01-01" });
    expect(row(await pa("admin"), a).inspection_state,
      "a future policy was applied early").toBe("no_policy");
  });

  it("ignores a deactivated policy", async () => {
    const a = await asset("InactAsset"); await seenDaysAgo(a, 5);
    await policy({ interval_days: 1, is_active: false });
    expect(row(await pa("admin"), a).inspection_state).toBe("no_policy");
  });

  it("applies one category's policy to that category alone", async () => {
    const mine = await asset("IsoMine"); await seenDaysAgo(mine, 40);
    await policy({ interval_days: 30 });
    /* A sibling category with no policy of its own is unaffected. */
    const otherCat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zos state other','individual')
       RETURNING id`)).rows[0].id);
    const theirs = idOf(await mk("admin", { category_id: otherCat, scope_id: mediaCrew, model: "IsoTheirs" }));
    await seenDaysAgo(theirs, 40);
    expect(row(await pa("admin"), mine).inspection_state).toBe("overdue");
    const r = await as("admin", "GET", `/equipment/physical-assurance?category_id=${otherCat}`);
    expect(((r.body.assets as unknown as { items: { id: number; inspection_state: string }[] })
      .items.find((x) => Number(x.id) === theirs))!.inspection_state).toBe("no_policy");
    await pool.query(`DELETE FROM mo_equipment_items WHERE category_id=$1`, [otherCat]);
    await pool.query(`DELETE FROM mo_equipment_categories WHERE id=$1`, [otherCat]);
  });

  /* ── THE APPROVED SEMANTICS ───────────────────────────────────────────── */

  it("judges today's obligation by TODAY'S policy, not the one in force when it was inspected",
    async () => {
    /* The approved decision, and the scenario from the brief. Inspected 200
       days ago under a 365-day policy that ran until 30 days ago, when a
       30-day policy took over. Under the superseded reading the asset would
       still be comfortably not due; under the approved one it is overdue,
       because the question is asked of the rule in force now. */
    const a = await asset("SemAsset"); await seenDaysAgo(a, 200);
    await pool.query(
      `INSERT INTO mo_inspection_policies (category_id, interval_days, effective_from, effective_to, created_by)
       VALUES ($1, 365, '2020-01-01', ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 31), $2)`,
      [cat, A.admin.id]);
    await pool.query(
      `INSERT INTO mo_inspection_policies (category_id, interval_days, effective_from, created_by)
       VALUES ($1, 30, ((NOW() AT TIME ZONE 'Asia/Kolkata')::date - 30), $2)`,
      [cat, A.admin.id]);
    const r = row(await pa("admin"), a);
    expect(Number(r.policy_interval_days), "the superseded policy was resolved").toBe(30);
    expect(r.inspection_state, "the obligation was judged by the old rule").toBe("overdue");
    /* Due 30 days after the inspection — 170 days ago, not 165 days hence. */
    expect(Number(r.days_until_due)).toBe(-170);
  });

  /* ── The summary, and everybody agreeing ──────────────────────────────── */

  it("partitions the estate — the five states sum to the total, once each", async () => {
    await policy({ interval_days: 20 });
    await asset("PtNever");
    const b = await asset("PtFresh"); await seenDaysAgo(b, 1);
    const c = await asset("PtDue");   await seenDaysAgo(c, 20);
    const d = await asset("PtLate");  await seenDaysAgo(d, 90);
    const s = sum(await pa("admin"));
    expect(Number(s.total)).toBe(4);
    expect(Number(s.never_inspected)).toBe(1);
    expect(Number(s.not_due)).toBe(1);
    expect(Number(s.due)).toBe(1);
    expect(Number(s.overdue)).toBe(1);
    expect(Number(s.no_policy)).toBe(0);
    expect(Number(s.never_inspected) + Number(s.no_policy) + Number(s.not_due)
         + Number(s.due) + Number(s.overdue)).toBe(Number(s.total));
    /* 17N's figures are untouched by any of this. */
    expect(Number(s.inspected)).toBe(3);
    expect(Number(s.coverage_pct)).toBeCloseTo(75, 1);
  });

  it("gives the dashboard and the assurance page the same answer", async () => {
    /* One derivation, spliced into two queries. If these ever disagree, the
       resolver has been copied instead of shared — which is the single thing
       this phase is built to prevent. */
    await policy({ interval_days: 15 });
    await asset("AgNever");
    const b = await asset("AgFresh"); await seenDaysAgo(b, 2);
    const c = await asset("AgDue");   await seenDaysAgo(c, 15);
    const d = await asset("AgLate");  await seenDaysAgo(d, 60);
    const s = sum(await pa("admin"));
    const ds = (await dash("admin")).body.summary as unknown as Record<string, number>;
    for (const k of ["never_inspected", "no_policy", "not_due", "due", "overdue"])
      expect(Number(ds[`insp_${k}`]), `dashboard and assurance disagree about ${k}`)
        .toBe(Number(s[k]));
    expect(Number(ds.inspected)).toBe(Number(s.inspected));
    expect(Number(ds.never_inspected)).toBe(Number(s.never_inspected));
  });

  /* ── Filters and sorting ──────────────────────────────────────────────── */

  it("filters by state and refuses a state nobody defined", async () => {
    await policy({ interval_days: 20 });
    const never = await asset("FtNever");
    const fresh = await asset("FtFresh"); await seenDaysAgo(fresh, 1);
    const late  = await asset("FtLate");  await seenDaysAgo(late, 90);
    const ids = (qs: string) => pa("admin", qs).then((r) => rowsOf(r).map((x) => Number(x.id)));
    expect(await ids("&inspection_status=overdue")).toEqual([late]);
    expect(await ids("&inspection_status=not_due")).toEqual([fresh]);
    expect(await ids("&inspection_status=never_inspected")).toEqual([never]);
    expect((await ids("&inspection_status=all")).sort()).toEqual([never, fresh, late].sort());
    /* The total travels with the filter rather than describing the page. */
    expect(Number(((await pa("admin", "&inspection_status=overdue")).body
      .assets as unknown as { total: number }).total)).toBe(1);
    const bad = await pa("admin", "&inspection_status=late");
    expect(bad.status, "an unknown state was quietly ignored").toBe(400);
  });

  it("sorts by due date, soonest or latest", async () => {
    await policy({ interval_days: 10 });
    const soon = await asset("SrSoon"); await seenDaysAgo(soon, 9);
    const mid  = await asset("SrMid");  await seenDaysAgo(mid, 20);
    const far  = await asset("SrFar");  await seenDaysAgo(far, 40);
    const withDue = (r: { body: Record<string, never> }) =>
      rowsOf(r).filter((x) => x.due_at !== null).map((x) => Number(x.id));
    expect(withDue(await pa("admin", "&sort=due_soon"))).toEqual([far, mid, soon]);
    expect(withDue(await pa("admin", "&sort=due_late"))).toEqual([soon, mid, far]);
  });

  it("writes nothing when any of this is read", async () => {
    await policy({ interval_days: 10 });
    const a = await asset("NwAsset"); await seenDaysAgo(a, 20);
    const counts = async () => (await pool.query(
      `WITH mine AS (SELECT id FROM mo_equipment_items WHERE category_id=$1)
       SELECT (SELECT COUNT(*)::int FROM mo_asset_inspections
                WHERE equipment_item_id IN (SELECT id FROM mine))        AS insp,
              (SELECT COUNT(*)::int FROM mine)                           AS assets,
              (SELECT COUNT(*)::int FROM mo_inspection_policies WHERE category_id=$1) AS pol,
              (SELECT COUNT(*)::int FROM mo_audit_logs
                WHERE entity_type='equipment_item'
                  AND entity_id IN (SELECT id FROM mine))                AS audit`, [cat])).rows[0];
    const before = await counts();
    await pa("admin"); await dash("admin"); await pa("admin", "&inspection_status=overdue");
    await pa("custMC"); await pa("admin", "&sort=due_soon");
    expect(await counts(), "reading the derived state wrote something").toEqual(before);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PID BORROWING — the engine, exercised against the PID inventory.

   NOTHING NEW IS BUILT HERE AND THAT IS THE POINT. PID is an inventory scope,
   and every borrowing mechanism the phases before built — booking, checkout,
   the ledger, check-in, inspection, the verification gate, the maintenance
   gate, the reservation conflict, the row lock, QR resolution, audit — is
   scope-agnostic by construction. These tests prove that claim rather than
   asserting it, because "it should just work" is how a second borrowing system
   gets written six months later by somebody who could not tell.

   WHAT THEY DELIBERATELY DO NOT COVER is anything needing a product decision:
   who may borrow, whether a loan needs approving, how many an academic may
   hold. Those are listed in the phase report, not invented here.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("PID lends through the same engine as everything else", () => {
  let cat = 0;
  const pidAsset = (model: string, extra: Record<string, unknown> = {}) =>
    mk("admin", { category_id: cat, scope_id: pid, model, ...extra }).then(idOf);
  const mcAsset = (model: string) =>
    mk("admin", { category_id: cat, scope_id: mediaCrew, model }).then(idOf);
  const out = (actor: ActorName, id: number, body: Record<string, unknown> = {}) =>
    as(actor, "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE, ...body });
  const back = (actor: ActorName, id: number, body: Record<string, unknown> = {}) =>
    as(actor, "POST", `/equipment/${id}/checkin`, body);
  const day = istDay;
  const ledger = async (id: number) => (await pool.query(
    `SELECT action, holder_id, to_char(expected_return_at,'YYYY-MM-DD') AS due
       FROM mo_equipment_transactions WHERE equipment_item_id=$1 ORDER BY id`, [id])).rows;
  const statusOf = async (id: number) => String((await pool.query(
    `SELECT status FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].status);

  beforeAll(async () => {
    if (!dbUp) return;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zpb lending','individual')
       RETURNING id`)).rows[0].id);
  }, 60_000);

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(
      `DELETE FROM mo_equipment_transactions WHERE equipment_item_id IN
         (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(
      `DELETE FROM mo_equipment_bookings WHERE equipment_item_id IN
         (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(
      `DELETE FROM mo_maintenance_records WHERE equipment_item_id IN
         (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE category_id=$1`, [cat]);
  });

  /* ── The loan ─────────────────────────────────────────────────────────── */

  it("lends and takes back a PID asset through the one custody ledger", async () => {
    const id = await pidAsset("PidLoan");
    const o = await out("custPID", id);
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(await statusOf(id)).toBe("checked_out");

    const i = await back("custPID", id, { condition_noted: "good" });
    expect(i.status, JSON.stringify(i.body)).toBe(201);
    expect(await statusOf(id)).toBe("available");

    /* ONE ledger, the same one Media Crew writes to — not a PID table. */
    const rows = await ledger(id);
    expect(rows.map((r) => r.action)).toEqual(["check_out", "check_in"]);
    expect(rows[0].holder_id).toBe(A.custPID.id);
    expect(rows[0].due, "the loan lost its end date").toBe(DUE);
  });

  it("reserves a PID asset in the same booking table, and the booking blocks the loan", async () => {
    const id = await pidAsset("PidReserve");
    const b = await as("custPID", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(2), ends_at: day(4) });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    /* 17G's rule, unchanged: a checkout whose due date runs into somebody
       else's reservation is refused. Nothing about PID changes it. */
    const clash = await out("admin", id, { expected_return_at: day(3) });
    expect(clash.status, JSON.stringify(clash.body)).toBe(409);
    /* And a second booking over the same days is refused by the same
       exclusion constraint that protects Media Crew. */
    const dup = await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(3), ends_at: day(5) });
    expect(dup.status).toBe(409);
  });

  it("applies the verification gate to PID exactly as to anything else", async () => {
    const draft = await pidAsset("PidDraft", { verification_state: "draft" });
    const r = await out("custPID", draft);
    expect(r.status, "an unverified PID asset was lent").toBe(409);
  });

  it("applies the maintenance gate to PID exactly as to anything else", async () => {
    const id = await pidAsset("PidBroken");
    expect((await as("custPID", "POST", `/equipment/${id}/damage`,
      { description: "ZPB cracked mount" })).status).toBe(201);
    const r = await out("custPID", id);
    expect(r.status, "an asset under repair was lent").toBe(409);
  });

  it("opens maintenance on a damaged return, through 17I and not a PID copy", async () => {
    const id = await pidAsset("PidReturnBad");
    expect((await out("custPID", id)).status).toBe(201);
    expect((await as("custPID", "POST", `/equipment/${id}/inspections`,
      { observed_condition: "poor", outcome: "maintenance_required",
        notes: "ZPB lens element loose" })).status).toBe(201);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_maintenance_records
        WHERE equipment_item_id=$1 AND resolved_at IS NULL`, [id])).rows[0].c)).toBe(1);
  });

  /* ── Jurisdiction ─────────────────────────────────────────────────────── */

  it("keeps Media Crew out of the PID cupboard, and PID out of Media Crew's", async () => {
    const p = await pidAsset("PidOnly");
    const m = await mcAsset("McOnly");
    /* The same 404 an invented id gets — an inventory boundary is not an
       error message that confirms the asset. */
    expect((await out("custMC", p)).status).toBe(404);
    expect((await out("custPID", m)).status).toBe(404);
    expect((await as("custMC", "GET", `/equipment/${p}`)).status).toBe(404);
    /* Admin reaches both, which is what makes the two above a scope result
       rather than a broken fixture. */
    expect((await out("admin", p)).status).toBe(201);
    expect((await out("admin", m)).status).toBe(201);
  });

  it("resolves a PID label for PID, and says nothing to Media Crew", async () => {
    const id = await pidAsset("PidScan");
    const tag = String((await pool.query(
      `SELECT asset_tag FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].asset_tag);
    const mine = await as("custPID", "GET", `/equipment/resolve/${tag}`);
    expect(mine.status).toBe(200);
    const theirs = await as("custMC", "GET", `/equipment/resolve/${tag}`);
    const ghost = await as("custMC", "GET", "/equipment/resolve/EQ-ZPB-NEVER");
    expect(theirs.status).toBe(404);
    expect(JSON.stringify(theirs.body), "scanning told Media Crew a PID asset exists")
      .toBe(JSON.stringify(ghost.body));
  });

  /* ── Who the loan is recorded against ─────────────────────────────────── */

  it("will not let a borrower put somebody else's name on a PID loan", async () => {
    const id = await pidAsset("PidForged");
    /* `plain` holds no custodial duty. Naming another holder is a management
       act, and the server refuses it whatever the browser sent. */
    const forged = await as("plain", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: A.custPID.id });
    expect([403, 404]).toContain(forged.status);
    expect((await ledger(id)).length, "a forged holder reached the ledger").toBe(0);
  });

  it("records the loan against the CALLER when no holder is named", async () => {
    const id = await pidAsset("PidSelf");
    expect((await out("custPID", id)).status).toBe(201);
    expect((await ledger(id))[0].holder_id).toBe(A.custPID.id);
  });

  /* ── One asset, one borrower ──────────────────────────────────────────── */

  it("lets exactly one of two simultaneous PID checkouts win", async () => {
    const id = await pidAsset("PidRace");
    const [a, b] = await Promise.all([out("admin", id), out("custPID", id)]);
    expect([a.status, b.status].sort(), `${a.status}/${b.status}`).toEqual([201, 409]);
    const rows = await ledger(id);
    expect(rows.length, "the race wrote two custody rows").toBe(1);
    expect(await statusOf(id)).toBe("checked_out");
  });

  /* ── It shows up everywhere it should, without being told to ──────────── */

  it("appears in the dashboard, the custody read and Asset 360 with no PID-specific plumbing", async () => {
    const id = await pidAsset("PidVisible");
    expect((await out("custPID", id)).status).toBe(201);

    const d = (await as("custPID", "GET", `/equipment/dashboard?category_id=${cat}`)).body;
    expect(Number((d.summary as unknown as Record<string, number>).checked_out)).toBe(1);
    expect(((d.custody as unknown as { id: number }[]) ?? []).map((r) => Number(r.id)))
      .toContain(id);

    const custody = await as("custPID", "GET", `/equipment/custody?limit=200&q=PidVisible`);
    /* The custody read nests the asset under its own key — it answers "who
       holds what", so a row is a custody fact with an asset attached, not an
       asset with a holder attached. */
    const held = custody.body.items as unknown as
      { asset: { id: number }; custody: { holder_id: string } }[];
    expect(held.map((r) => Number(r.asset.id)),
      "the PID loan is missing from the custody read").toContain(id);
    expect(held.find((r) => Number(r.asset.id) === id)!.custody.holder_id).toBe(A.custPID.id);

    /* Asset 360's timeline is the same ledger, so the loan is already there. */
    const tl = await as("custPID", "GET", `/equipment/${id}/timeline?limit=20`);
    expect((tl.body.items as unknown as { source?: string; event?: string }[])
      .some((r) => r.source === "custody" && r.event === "check_out"),
      "the PID loan is missing from the asset's timeline").toBe(true);
  });

  it("audits a PID loan with the same events as any other loan", async () => {
    const id = await pidAsset("PidAudit");
    expect((await out("custPID", id)).status).toBe(201);
    expect((await back("custPID", id, { condition_noted: "good" })).status).toBe(201);
    const actions = (await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='equipment_item' AND entity_id=$1
        ORDER BY id`, [id])).rows.map((r) => String(r.action));
    expect(actions).toContain("equipment.checked_out");
    expect(actions).toContain("equipment.checked_in");
    /* And no PID-flavoured event was invented alongside them. */
    expect(actions.filter((a) => /pid|borrow|loan/i.test(a)), "a PID audit vocabulary appeared")
      .toEqual([]);
  });

  /* ── The regression that matters most ─────────────────────────────────── */

  it("changes nothing about how Media Crew borrows", async () => {
    const id = await mcAsset("McUnchanged");
    expect((await out("custMC", id)).status).toBe(201);
    expect(await statusOf(id)).toBe("checked_out");
    expect((await back("custMC", id, { condition_noted: "good" })).status).toBe(201);
    expect((await ledger(id)).map((r) => r.action)).toEqual(["check_out", "check_in"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PID BORROWING — the two doors that are shut, recorded as tests.

   Neither is a defect and neither is fixed here. They are the exact points at
   which lending to an academic borrower stops today, and a test is the most
   durable way to record them: if somebody later opens either door, these fail
   and force the decision to be made deliberately rather than discovered.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("a student reserves, a custodian hands over", () => {
  /* THE APPROVED SPLIT, AND IT IS A SPLIT OF CAPABILITY RATHER THAN OF SYSTEM.

       student    module access + scope + RESERVE
       custodian  module access + scope + CHECKOUT / CHECK-IN

     No student role, no PID role, no borrower table, no second booking engine.
     A student is an SMC member — an institute student with an ordinary Nerve
     account — and the only thing that changed in the engine is which people
     may be recorded as holding an asset in an inventory that lends to them. */
  let cat = 0, student = "";
  const pidAsset = (model: string, extra: Record<string, unknown> = {}) =>
    mk("admin", { category_id: cat, scope_id: pid, model, ...extra }).then(idOf);
  const day = istDay;
  const ledger = async (id: number) => (await pool.query(
    `SELECT action, holder_id, recorded_by FROM mo_equipment_transactions
      WHERE equipment_item_id=$1 ORDER BY id`, [id])).rows;
  /* The student holds the equipment module for these tests; whether the
     smc_member DEFAULTS grant it is an administrator's setting, proved
     separately below. */
  const grantModules = (mods: string[]) => pool.query(
    `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
     VALUES ($1,'ZAR','employee',$2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET allowed_modules=EXCLUDED.allowed_modules`,
    [A.student.id, JSON.stringify(mods)]);

  beforeAll(async () => {
    if (!dbUp) return;
    student = A.student.id;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zpc student','individual')
       RETURNING id`)).rows[0].id);
  }, 60_000);

  /* The file's own beforeEach clears every zar- inventory grant and re-issues
     only the two custodians', so the student's has to be re-granted after it
     rather than once in beforeAll — nested hooks run outer-first, which is
     exactly what makes this the right place for it. */
  beforeEach(async () => {
    if (!dbUp) return;
    await grantModules(["home", "my-day", "equipment"]);
    /* Scope is jurisdiction, granted to a student exactly as to a custodian:
       PID and nothing else. */
    await pool.query(
      `INSERT INTO mo_user_inventory_scopes (user_id, scope_id, granted_by)
       VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [student, pid, A.admin.id]);
  });

  afterEach(async () => {
    if (!dbUp) return;
    await pool.query(
      `DELETE FROM mo_equipment_transactions WHERE equipment_item_id IN
         (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(
      `DELETE FROM mo_equipment_bookings WHERE equipment_item_id IN
         (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE category_id=$1`, [cat]);
  });

  /* ── What a student may do ────────────────────────────────────────────── */

  it("a student reaches Equipment only when configuration says so", async () => {
    await grantModules(["home", "my-day", "leave"]);
    const shut = await as("student", "GET", "/equipment?limit=1");
    expect(shut.status).toBe(403);
    expect(String(shut.body.message)).toMatch(/no access to the "equipment" module/i);
    await grantModules(["home", "my-day", "equipment"]);
    expect((await as("student", "GET", "/equipment?limit=1")).status).toBe(200);
  });

  it("a student browses PID and sees nothing of Media Crew", async () => {
    const mine = await pidAsset("StuBrowse");
    const theirs = idOf(await mk("admin", { category_id: cat, scope_id: mediaCrew, model: "StuHidden" }));
    /* TEST_STABILITY entry 17 — scoped to this block's own category. An
       unfiltered read is a page of the WHOLE estate, and the sibling suites
       fill 200 rows of it between one run and the next, so `mine` fell off the
       end of the page and the test read that as a scope failure. Both assets
       live in `cat`, so the filter narrows to this suite's two and the
       question — does the student see the PID one and not the Media Crew one —
       is asked of exactly the rows that answer it. */
    const seen = ((await as("student", "GET", `/equipment?category_id=${cat}&limit=200`)).body
      .items as unknown as { id: number }[]).map((r) => Number(r.id));
    expect(seen).toContain(mine);
    expect(seen, "a student saw a Media Crew asset").not.toContain(theirs);
    /* And the Media Crew asset really is there to be missed: a custodian who
       holds that inventory sees it through the very same read. */
    expect(((await as("custMC", "GET", `/equipment?category_id=${cat}&limit=200`)).body
      .items as unknown as { id: number }[]).map((r) => Number(r.id)),
      "the hidden asset was invisible to everyone, so the test proved nothing").toContain(theirs);
    /* And the availability view answers for them too. */
    expect((await as("student", "GET",
      `/equipment/availability?q=StuBrowse&limit=50&from=${day(1)}&to=${day(2)}`)).status).toBe(200);
  });

  it("a student RESERVES through the one booking engine", async () => {
    const id = await pidAsset("StuReserve");
    const r = await as("student", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(2), ends_at: day(4) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    /* The booking is theirs — user_id and created_by both name them, which is
       what makes "my reservations" answerable without a new column. */
    const row = (await pool.query(
      `SELECT user_id, created_by, status FROM mo_equipment_bookings WHERE equipment_item_id=$1`,
      [id])).rows[0];
    expect(row.user_id).toBe(student);
    expect(row.created_by).toBe(student);
    expect(row.status).toBe("reserved");
    /* And the exclusion constraint protects it from the next person. */
    expect((await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(3), ends_at: day(5) })).status).toBe(409);
  });

  /* ── What a student may not do ────────────────────────────────────────── */

  it("a student cannot take equipment off the shelf themselves", async () => {
    const id = await pidAsset("StuSelf");
    const r = await as("student", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE });
    expect(r.status, "a student self-issued equipment").toBe(403);
    expect(String(r.body.message)).toMatch(/custodian hands it over/i);
    expect((await ledger(id)).length).toBe(0);
  });

  it("a student cannot name anybody else as the holder", async () => {
    const id = await pidAsset("StuOther");
    const r = await as("student", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: A.custPID.id });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toMatch(/Only an Equipment Custodian or an Admin/i);
    expect((await ledger(id)).length).toBe(0);
  });

  it("a student cannot act as a custodian over anything", async () => {
    const id = await pidAsset("StuCustodial");
    expect((await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: student })).status).toBe(201);
    /* None of the custodial verbs are theirs. */
    expect((await as("student", "POST", `/equipment/${id}/retire`, { reason: "x" })).status).toBe(403);
    expect((await as("student", "PATCH", `/equipment/${id}`, { notes: "x" })).status).toBe(403);
    expect((await as("student", "POST", `/equipment/${id}/damage`,
      { description: "x" })).status).toBe(403);
    expect((await as("student", "POST", `/equipment/${id}/inspections`,
      { observed_condition: "good", outcome: "passed" })).status).toBe(403);
  });

  it("a student may return what THEY hold — the existing holder rule, unchanged", async () => {
    /* "Only the holder, a Custodian or an Admin may check this item in" has
       been the rule since Phase 4 and is shared with the crew. A student
       holding a camera is a holder, so returning it is that rule working, not
       a hole opened by this phase — and refusing it would have been a new
       restriction nobody approved.

       Worth knowing rather than assuming: it means a self-return records no
       inspection, so the condition on the way back is whatever the student
       typed. Listed as an open decision in the phase report. */
    const id = await pidAsset("StuSelfReturn");
    await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: student });
    const r = await as("student", "POST", `/equipment/${id}/checkin`, { condition_noted: "good" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await ledger(id)).map((x) => x.action)).toEqual(["check_out", "check_in"]);
  });

  it("a student cannot return somebody ELSE'S loan", async () => {
    const id = await pidAsset("StuOthersLoan");
    await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: A.custPID.id });
    const r = await as("student", "POST", `/equipment/${id}/checkin`, { condition_noted: "good" });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toMatch(/Only the holder, a Custodian or an Admin/i);
  });

  /* ── What a custodian may do ──────────────────────────────────────────── */

  it("a PID custodian hands a PID asset to a student, with no reservation first", async () => {
    const id = await pidAsset("StuHandover");
    const r = await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: student });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    /* THE TWO NAMES ARE DIFFERENT PEOPLE, and both are recorded: the student
       has the camera, the custodian answered for handing it over. */
    const row = (await ledger(id))[0];
    expect(row.holder_id, "the student is not the holder").toBe(student);
    expect(row.recorded_by, "the custodian is not on the record").toBe(A.custPID.id);
    /* The asset is out, through the one ledger and the one status column. */
    expect(String((await pool.query(
      `SELECT status FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].status)).toBe("checked_out");
  });

  it("the custodian takes it back and the student's loan closes", async () => {
    const id = await pidAsset("StuReturn");
    await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: student });
    expect((await as("custPID", "POST", `/equipment/${id}/checkin`,
      { condition_noted: "good" })).status).toBe(201);
    expect((await ledger(id)).map((r) => r.action)).toEqual(["check_out", "check_in"]);
    expect(String((await pool.query(
      `SELECT status FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].status)).toBe("available");
  });

  /* ── The eligibility is additive, not a hole ──────────────────────────── */

  it("a student may NOT hold a Media Crew asset, however senior the custodian", async () => {
    /* The new population is conditional on the inventory. Media Crew does not
       lend to students, so an admin with every scope still cannot do it — the
       team restriction was extended, not removed. */
    const mc = idOf(await mk("admin", { category_id: cat, scope_id: mediaCrew, model: "StuNotMC" }));
    const r = await as("admin", "POST", `/equipment/${mc}/checkout`,
      { expected_return_at: DUE, holder_id: student });
    expect(r.status, "a student was issued a Media Crew asset").toBe(400);
    expect(String(r.body.message)).toMatch(/does not lend to students/i);
    expect((await ledger(mc)).length).toBe(0);
  });

  it("an unscoped legacy asset lends to nobody outside the crew", async () => {
    const legacy = idOf(await mk("admin", { category_id: cat, scope_id: null, model: "StuLegacy" }));
    const r = await as("admin", "POST", `/equipment/${legacy}/checkout`,
      { expected_return_at: DUE, holder_id: student });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toMatch(/does not lend to students/i);
  });

  it("still refuses a holder who is neither crew nor student", async () => {
    /* `outsider` is team='branding'. The original refusal, word for word. */
    const id = await pidAsset("StuOutsider");
    const r = await as("admin", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: A.outsider.id });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toBe("That borrower is not an active member of the media crew.");
  });

  it("refuses a forged holder id that names nobody at all", async () => {
    const id = await pidAsset("StuGhost");
    const r = await as("admin", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: "zar-does-not-exist" });
    expect(r.status).toBe(400);
    expect((await ledger(id)).length).toBe(0);
  });

  /* ── Every other gate still stands in front of the student ────────────── */

  it("keeps the verification, maintenance and reservation gates in the way", async () => {
    const draft = await pidAsset("StuDraft", { verification_state: "draft" });
    expect((await as("custPID", "POST", `/equipment/${draft}/checkout`,
      { expected_return_at: DUE, holder_id: student })).status,
      "an unverified asset reached a student").toBe(409);

    const broken = await pidAsset("StuBroken");
    await as("custPID", "POST", `/equipment/${broken}/damage`, { description: "ZPC cracked" });
    expect((await as("custPID", "POST", `/equipment/${broken}/checkout`,
      { expected_return_at: DUE, holder_id: student })).status,
      "an asset under repair reached a student").toBe(409);

    const booked = await pidAsset("StuBooked");
    await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: booked, starts_at: day(2), ends_at: day(4) });
    expect((await as("custPID", "POST", `/equipment/${booked}/checkout`,
      { expected_return_at: day(3), holder_id: student })).status,
      "a handover ran over somebody else's reservation").toBe(409);
  });

  it("lets exactly one of two simultaneous handovers win", async () => {
    const id = await pidAsset("StuRace");
    const [a, b] = await Promise.all([
      as("custPID", "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE, holder_id: student }),
      as("admin",   "POST", `/equipment/${id}/checkout`, { expected_return_at: DUE, holder_id: student })]);
    expect([a.status, b.status].sort(), `${a.status}/${b.status}`).toEqual([201, 409]);
    expect((await ledger(id)).length, "the race wrote two custody rows").toBe(1);
  });

  it("reserve then hand over — the booking and the loan are the same two tables as always", async () => {
    const id = await pidAsset("StuFlow");
    expect((await as("student", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(1), ends_at: day(6) })).status).toBe(201);
    /* The custodian issues it inside the student's own window — their booking
       does not block them, which is what makes the flow work end to end. */
    const r = await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: day(5), holder_id: student });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await ledger(id))[0].holder_id).toBe(student);
  });

  it("writes the ordinary equipment audit, with no PID or student vocabulary", async () => {
    const id = await pidAsset("StuAudit");
    await as("custPID", "POST", `/equipment/${id}/checkout`,
      { expected_return_at: DUE, holder_id: student });
    const actions = (await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='equipment_item' AND entity_id=$1`,
      [id])).rows.map((r) => String(r.action));
    expect(actions).toContain("equipment.checked_out");
    expect(actions.filter((a) => /pid|student|borrow|loan/i.test(a))).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 17N — reporting, export and derived analytics.

   Everything here reads. The tests that matter most are the ones asserting
   that reading changes nothing, that a file cannot hold an inventory the
   caller may not see, and that a derived figure says what it is derived from.
   ═══════════════════════════════════════════════════════════════════════════ */
maybe("reporting respects the inventory it reports on", () => {
  let cat = 0;
  const pidA = (model: string) =>
    mk("admin", { category_id: cat, scope_id: pid, model }).then(idOf);
  const mcA = (model: string) =>
    mk("admin", { category_id: cat, scope_id: mediaCrew, model }).then(idOf);
  const csv = async (actor: ActorName | "anon", qs: string) => {
    const r = await fetch(`${base}/equipment/export${qs}`,
      { headers: actor === "anon" ? {} : { "x-actor": actor } });
    return { status: r.status, text: r.status === 200 ? await r.text() : "",
             disposition: r.headers.get("content-disposition") ?? "",
             type: r.headers.get("content-type") ?? "",
             rows: r.headers.get("x-row-count") ?? "" };
  };
  const insights = (actor: ActorName, qs = "") =>
    as(actor, "GET", `/equipment/insights?category_id=${cat}${qs}`);
  const day = istDay;

  beforeAll(async () => {
    if (!dbUp) return;
    cat = Number((await pool.query(
      `INSERT INTO mo_equipment_categories (name, tracking_mode) VALUES ('zrp reporting','individual')
       RETURNING id`)).rows[0].id);
  }, 60_000);

  afterEach(async () => {
    if (!dbUp) return;
    for (const t of ["mo_equipment_transactions", "mo_equipment_bookings", "mo_maintenance_records",
                     "mo_asset_inspections"])
      await pool.query(
        `DELETE FROM ${t} WHERE equipment_item_id IN
           (SELECT id FROM mo_equipment_items WHERE category_id=$1)`, [cat]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE category_id=$1`, [cat]);
  });

  /* ── PHASE A — the import list no longer leaks ────────────────────────── */

  it("shows an import batch only to somebody who may see its rows", async () => {
    const batch = async (scopeId: number | null, tag: string) => {
      const b = Number((await pool.query(
        `INSERT INTO mo_asset_import_batches (file_name, uploaded_by, rows_total)
         VALUES ($1,$2,1) RETURNING id`, [`${PX}-${tag}.csv`, A.admin.id])).rows[0].id);
      await pool.query(
        `INSERT INTO mo_asset_import_rows
           (batch_id, source_row, source_name, normalized_name, proposed_category_id,
            proposed_scope_id, candidates, state)
         VALUES ($1,2,$2,$2,$3,$4,'[]'::jsonb,'pending_review')`, [b, `ZRP ${tag}`, cat, scopeId]);
      return b;
    };
    const mine = await batch(mediaCrew, "mc");
    const theirs = await batch(pid, "pid");
    const unscoped = await batch(null, "none");
    const seen = async (who: ActorName) =>
      ((await as(who, "GET", "/equipment/imports?limit=200")).body
        .items as unknown as { id: number }[]).map((x) => Number(x.id));

    const mc = await seen("custMC");
    expect(mc, "a Media Crew custodian could not see their own batch").toContain(mine);
    expect(mc, "THE LEAK: a Media Crew custodian saw a PID batch").not.toContain(theirs);
    const pd = await seen("custPID");
    expect(pd).toContain(theirs);
    expect(pd, "THE LEAK: a PID custodian saw a Media Crew batch").not.toContain(mine);
    /* A row with no inventory is everybody's to decide, so its batch is too. */
    expect(mc).toContain(unscoped);
    expect(pd).toContain(unscoped);
    /* Admin sees the estate — which is what makes the two exclusions above a
       scope result rather than an empty query. */
    const all = await seen("admin");
    for (const b of [mine, theirs, unscoped]) expect(all).toContain(b);
    /* And the count agrees with the list it describes. */
    const r = await as("custMC", "GET", "/equipment/imports?limit=200");
    expect(Number(r.body.total)).toBe((r.body.items as unknown as unknown[]).length);
    await pool.query(`DELETE FROM mo_asset_import_batches WHERE file_name LIKE $1`, [`${PX}-%`]);
  });

  /* ── PHASE B — when a reservation was made ────────────────────────────── */

  it("records when a booking was created, server-side and unforgeable", async () => {
    const id = await pidA("BkCreated");
    const future = new Date(Date.now() + 86400000 * 400).toISOString();
    const r = await as("custPID", "POST", "/equipment/bookings", {
      equipment_item_id: id, starts_at: day(2), ends_at: day(4),
      /* A client that could set this could backdate demand. */
      created_at: future,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const row = (await pool.query(
      `SELECT created_at, starts_at FROM mo_equipment_bookings WHERE equipment_item_id=$1`,
      [id])).rows[0];
    expect(row.created_at, "a booking has no creation time").toBeTruthy();
    expect(new Date(row.created_at).getTime(),
      "the client forged created_at").toBeLessThan(Date.now() + 60_000);
    /* The two dates are different facts: made today, covering a window that
       starts the day after tomorrow. */
    expect(new Date(row.created_at).toISOString().slice(0, 10)).not.toBe(day(2));
  });

  it("still refuses an overlapping booking — the constraint is untouched", async () => {
    const id = await pidA("BkOverlap");
    expect((await as("custPID", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(2), ends_at: day(4) })).status).toBe(201);
    expect((await as("admin", "POST", "/equipment/bookings",
      { equipment_item_id: id, starts_at: day(3), ends_at: day(5) })).status).toBe(409);
  });

  /* ── PHASE D — the export is a rendering of an authorised read ────────── */

  it("exports custody as CSV, with headers and a filename", async () => {
    const id = await pidA("ExCustody");
    await as("custPID", "POST", `/equipment/${id}/checkout`,
      { holder_id: A.custPID.id, expected_return_at: DUE });
    const r = await csv("custPID", "?dataset=custody");
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/text\/csv/);
    expect(r.disposition).toMatch(/attachment; filename="nerve-equipment-custody-\d{4}-\d{2}-\d{2}\.csv"/);
    const [head, ...body] = r.text.trim().split("\r\n");
    expect(head).toBe("asset_tag,internal_code,make,model,category,inventory,holder,holder_id,"
      + "checked_out_at,due_at,overdue,overdue_days,recorded_via,recorded_by,project");
    expect(body.some((l) => l.includes("ExCustody"))).toBe(true);
  });

  it("gives an empty dataset a header row rather than an empty file", async () => {
    const r = await csv("custPID", "?dataset=custody&inventory=pid");
    expect(r.status).toBe(200);
    expect(r.text.trim().split("\r\n")[0]).toContain("asset_tag");
    expect(r.rows).toBe("0");
  });

  it("will not put another inventory in somebody's file", async () => {
    const mine = await pidA("ExMine");
    const theirs = await mcA("ExTheirs");
    expect(mine + theirs).toBeGreaterThan(0);
    const r = await csv("custPID", "?dataset=assurance");
    expect(r.status).toBe(200);
    expect(r.text).toContain("ExMine");
    expect(r.text, "an export carried another inventory's asset").not.toContain("ExTheirs");
    /* Narrowing to an inventory the caller does not hold yields nothing. */
    const narrowed = await csv("custPID", "?dataset=assurance&inventory=media_crew");
    expect(narrowed.rows).toBe("0");
  });

  it("refuses an unknown dataset and an unauthenticated caller", async () => {
    expect((await csv("custPID", "?dataset=everything")).status).toBe(400);
    expect((await csv("custPID", "")).status).toBe(400);
    expect((await csv("anon", "?dataset=custody")).status).toBe(403);
    expect((await csv("outsider", "?dataset=custody")).status).toBe(403);
  });

  it("escapes a field that would otherwise be read as a formula", async () => {
    /* A description beginning with = is data, not something a spreadsheet
       should execute when somebody opens the file. */
    const id = await pidA("ExInject");
    await as("custPID", "POST", `/equipment/${id}/damage`,
      { description: '=cmd|"/c calc"!A1' });
    const r = await csv("custPID", "?dataset=maintenance");
    expect(r.status).toBe(200);
    expect(r.text).toMatch(/'=cmd/);
    expect(r.text, "a formula was exported unescaped").not.toMatch(/,=cmd/);
  });

  it("records that an export happened, because data left the system", async () => {
    await pidA("ExAudited");
    /* The ROWS that appeared, not a count of them — a count can only say that
       a number moved, and this says which event was written and what it holds.
       TEST_STABILITY entry 19. */
    const events = async () => (await pool.query(
      `SELECT id, after FROM mo_audit_logs
        WHERE action='equipment.exported' AND actor_id=$1 ORDER BY id`,
      [A.custPID.id])).rows;
    const before = new Set((await events()).map((r) => Number(r.id)));
    await csv("custPID", "?dataset=transactions");
    const added = (await events()).filter((r) => !before.has(Number(r.id)));
    expect(added.length, "an export left no trace").toBe(1);
    expect(added[0].after.dataset).toBe("transactions");
    expect(added[0].after.scope).toBe("scoped");
  });

  /* ── PHASE E — figures that say what they are derived from ────────────── */

  it("averages only the loans that actually ended", async () => {
    const closed = await pidA("LnClosed");
    const open = await pidA("LnOpen");
    /* One loan of exactly four days, written straight to the ledger so the
       duration is exact rather than however long the test took. */
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, recorded_by, occurred_at)
       VALUES ($1,'check_out',$2,$2, NOW() - INTERVAL '10 days'),
              ($1,'check_in', $2,$2, NOW() - INTERVAL '6 days')`, [closed, A.custPID.id]);
    /* And one still out, which has no duration at all. */
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, recorded_by, occurred_at)
       VALUES ($1,'check_out',$2,$2, NOW() - INTERVAL '30 days')`, [open, A.custPID.id]);

    const l = (await insights("admin")).body.loans as unknown as Record<string, unknown>;
    expect(Number(l.closed)).toBe(1);
    expect(Number(l.still_out), "an open loan was counted as finished").toBe(1);
    expect(Number(l.avg_days), "the 30-day open loan dragged the average up").toBeCloseTo(4, 1);
    expect(String(l.basis)).toMatch(/closed loans only/i);
  });

  it("pairs each checkout with the NEXT check-in, over many cycles", async () => {
    const id = await pidA("LnCycles");
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, recorded_by, occurred_at)
       VALUES ($1,'check_out',$2,$2, NOW() - INTERVAL '20 days'),
              ($1,'check_in', $2,$2, NOW() - INTERVAL '18 days'),
              ($1,'check_out',$2,$2, NOW() - INTERVAL '10 days'),
              ($1,'check_in', $2,$2, NOW() - INTERVAL '8 days'),
              ($1,'check_out',$2,$2, NOW() - INTERVAL '4 days'),
              ($1,'check_in', $2,$2, NOW() - INTERVAL '2 days')`, [id, A.custPID.id]);
    const l = (await insights("admin")).body.loans as unknown as Record<string, unknown>;
    expect(Number(l.closed), "three circulations became one long loan").toBe(3);
    expect(Number(l.avg_days)).toBeCloseTo(2, 1);
  });

  it("reports maintenance resolution in whole days, and does not invent hours", async () => {
    const id = await pidA("MtResolve");
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, reported_by, started_at, resolved_at, cost)
       VALUES ($1,'repair','ZRP a',$2, CURRENT_DATE - 6, CURRENT_DATE - 2, 1000),
              ($1,'repair','ZRP b',$2, CURRENT_DATE - 3, CURRENT_DATE - 3, 500),
              ($1,'repair','ZRP open',$2, CURRENT_DATE - 1, NULL, NULL)`, [id, A.custPID.id]);
    const m = (await insights("admin")).body.maintenance as unknown as Record<string, unknown>;
    expect(Number(m.records)).toBe(3);
    expect(Number(m.open)).toBe(1);
    expect(Number(m.resolved)).toBe(2);
    /* (4 + 0) / 2 — a same-day repair is 0 days, not "a few hours". */
    expect(Number(m.avg_days_to_resolve)).toBeCloseTo(2, 1);
    expect(Number(m.longest_days_to_resolve)).toBe(4);
    expect(Number(m.total_cost)).toBe(1500);
    expect(String(m.basis)).toMatch(/whole days/i);
  });

  it("counts maintenance per asset without deciding what 'too many' is", async () => {
    const often = await pidA("MtOften");
    const once = await pidA("MtOnce");
    await pool.query(
      `INSERT INTO mo_maintenance_records (equipment_item_id, kind, description, reported_by, started_at)
       VALUES ($1,'repair','ZRP 1',$3, CURRENT_DATE - 5),
              ($1,'repair','ZRP 2',$3, CURRENT_DATE - 4),
              ($1,'repair','ZRP 3',$3, CURRENT_DATE - 3),
              ($2,'repair','ZRP 4',$3, CURRENT_DATE - 2)`, [often, once, A.custPID.id]);
    const top = (await insights("admin")).body.most_maintained as unknown as
      { id: number; maintenance_count: number }[];
    expect(top.map((r) => Number(r.id))).toContain(often);
    expect(top.find((r) => Number(r.id) === often)!.maintenance_count).toBe(3);
    /* An asset with a single record is not "repeat" anything, and no threshold
       beyond "more than one" is applied. */
    expect(top.map((r) => Number(r.id))).not.toContain(once);
  });

  it("counts a booking as converted only when a transaction names it", async () => {
    const converted = await pidA("CvYes");
    const ignored = await pidA("CvNo");
    const b = Number(((await as("custPID", "POST", "/equipment/bookings",
      { equipment_item_id: converted, starts_at: day(1), ends_at: day(3) })).body
      .booking as unknown as { id: number }).id);
    await as("custPID", "POST", "/equipment/bookings",
      { equipment_item_id: ignored, starts_at: day(1), ends_at: day(3) });
    /* A checkout that names the booking. */
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, recorded_by, booking_id)
       VALUES ($1,'check_out',$2,$2,$3)`, [converted, A.custPID.id, b]);
    /* And one that does not — same asset, same person, no booking_id. It must
       not be inferred into a conversion. */
    await pool.query(
      `INSERT INTO mo_equipment_transactions (equipment_item_id, action, holder_id, recorded_by)
       VALUES ($1,'check_out',$2,$2)`, [ignored, A.custPID.id]);
    const r = (await insights("admin")).body.reservations as unknown as Record<string, unknown>;
    expect(Number(r.bookings)).toBe(2);
    expect(Number(r.converted), "a conversion was inferred from a coincidence").toBe(1);
  });

  /* ── PHASE F — coverage, as reporting only ────────────────────────────── */

  it("reports identifier and governance coverage without changing anything", async () => {
    const a = await pidA("CovOne");
    const b = await pidA("CovTwo");
    const before = (await pool.query(
      `SELECT COUNT(*)::int AS ids FROM mo_asset_identifiers
        WHERE asset_id = ANY($1::bigint[])`, [[a, b]])).rows[0];
    const c = (await insights("admin")).body.coverage as unknown as Record<string, number>;
    expect(Number(c.total)).toBe(2);
    expect(Number(c.in_an_inventory)).toBe(2);
    expect(Number(c.verified)).toBe(2);
    expect(Number(c.ever_inspected)).toBe(0);
    /* Reading coverage mints nothing. */
    expect((await pool.query(
      `SELECT COUNT(*)::int AS ids FROM mo_asset_identifiers
        WHERE asset_id = ANY($1::bigint[])`, [[a, b]])).rows[0], "reporting created identifiers")
      .toEqual(before);
  });

  it("does not count an unscoped asset as missing a code it is not owed", async () => {
    /* 17A does not issue an internal code until an asset has an inventory, so
       an unscoped asset has no gap to report. */
    await mk("admin", { category_id: cat, scope_id: null, model: "CovLegacy" });
    const c = (await insights("admin")).body.coverage as unknown as Record<string, number>;
    expect(Number(c.total)).toBe(1);
    expect(Number(c.in_an_inventory)).toBe(0);
    expect(Number(c.without_internal_code), "an unscoped asset was reported as uncoded").toBe(0);
  });

  it("keeps insights inside the caller's inventory", async () => {
    await pidA("InPid");
    await mcA("InMc");
    expect(Number(((await insights("custPID")).body.coverage as unknown as { total: number }).total)).toBe(1);
    expect(Number(((await insights("custMC")).body.coverage as unknown as { total: number }).total)).toBe(1);
    expect(Number(((await insights("admin")).body.coverage as unknown as { total: number }).total)).toBe(2);
  });

  it("writes nothing when any of this is read", async () => {
    const id = await pidA("RoNothing");
    /* Written out rather than interpolated. Every subquery names this block's
       own category in full, so the discriminator is visible to a reader and to
       audit:test-isolation — which, like the read-model scanner before it,
       cannot see through a ${...} into the string it is checking. */
    const counts = async () => (await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM mo_equipment_items WHERE category_id=$1) AS assets,
              (SELECT COUNT(*)::int FROM mo_equipment_transactions
                WHERE equipment_item_id IN (SELECT id FROM mo_equipment_items WHERE category_id=$1)) AS tx,
              (SELECT COUNT(*)::int FROM mo_equipment_bookings
                WHERE equipment_item_id IN (SELECT id FROM mo_equipment_items WHERE category_id=$1)) AS bk,
              (SELECT COUNT(*)::int FROM mo_asset_identifiers
                WHERE asset_id IN (SELECT id FROM mo_equipment_items WHERE category_id=$1)) AS ids`,
      [cat])).rows[0];
    const before = await counts();
    await insights("admin"); await insights("custPID", "&from=2020-01-01&to=2030-01-01");
    await csv("admin", "?dataset=custody"); await csv("admin", "?dataset=assurance");
    expect(Number(id)).toBeGreaterThan(0);
    expect(await counts(), "a report wrote something").toEqual(before);
  });

  it("refuses a malformed date range rather than guessing", async () => {
    for (const qs of ["&from=yesterday", "&to=2026-13-40", "&from=2026-06-01&to=2026-05-01"])
      expect((await insights("admin", qs)).status, qs).toBe(400);
  });
});

/* ═══ PHASE C — the estate-wide audit ═════════════════════════════════════ */
maybe("the estate-wide audit log can be read past its first page", () => {
  const A_URL = "/audit";
  const get = (actor: ActorName | "anon", qs = "") => as(actor, "GET", `${A_URL}${qs}`);

  it("is Admin-only, and says so", async () => {
    for (const who of ["custMC", "custPID", "plain", "anon"] as (ActorName | "anon")[])
      expect((await get(who)).status, who).toBe(403);
    expect((await get("admin")).status).toBe(200);
  });

  it("pages with a total, and page two does not repeat page one", async () => {
    /* TEST_STABILITY entry 17. The audit log is ESTATE-WIDE and every suite
       running beside this one writes to it, so paging over the whole table is
       paging over a list that grows between the two requests: five events
       arrive, OFFSET 5 lands back inside what was page one, and rows repeat.
       That is offset paging over a live log behaving as it must, not a defect,
       and the first version of this test asserted it away on a quiet run and
       failed on a busy one. The boundary is asserted over a slice only this
       suite can produce.

       All twelve rows share one occurred_at — NOW() inside a single statement
       is the transaction timestamp — which is the HARDER case: the order is then
       decided entirely by the id tie-break, so a page boundary without one
       overlaps here every single time rather than occasionally. */
    const ET = `${PX}_audit_page`;
    const planted = (await pool.query(
      `INSERT INTO mo_audit_logs (actor_id, actor_role, action, entity_type, entity_id, occurred_at)
       SELECT $1, 'admin', 'equipment.paging_fixture', $2, g, NOW() FROM generate_series(1, 12) g
       RETURNING id`, [A.admin.id, ET])).rows.map((r) => Number(r.id)).sort((a, b) => b - a);

    const ids = (r: { body: Record<string, never> }) =>
      (r.body.items as unknown as { id: number }[]).map((x) => Number(x.id));
    const page = async (offset: number) => {
      const r = await get("admin", `?entity_type=${ET}&limit=5&offset=${offset}`);
      expect(r.status).toBe(200);
      expect(Number(r.body.total), "the total counts the slice, not the page").toBe(12);
      expect(Number(r.body.limit)).toBe(5);
      expect(Number(r.body.offset)).toBe(offset);
      return ids(r);
    };
    const p1 = await page(0), p2 = await page(5), p3 = await page(10);
    expect(p1.length).toBe(5);
    expect(p3.length, "the last page is the remainder").toBe(2);
    expect(p1.filter((x) => p2.includes(x)), "two pages overlapped").toEqual([]);
    /* Nothing repeated AND nothing fell down the gap between the pages, which
       is the failure a paged read hides rather than reports. */
    expect([...p1, ...p2, ...p3], "the three pages are not the twelve rows").toEqual(planted);

    /* Newest first. The ordering WITHIN one response does not depend on who
       else is writing, so that half can still be asked of the real log. */
    const live = await get("admin", "?limit=50");
    const t = (live.body.items as unknown as { occurred_at: string }[])
      .map((x) => new Date(x.occurred_at).getTime());
    expect(t.every((v, i) => i === 0 || t[i - 1] >= v), "not newest-first").toBe(true);
    await pool.query(`DELETE FROM mo_audit_logs WHERE entity_type=$1`, [ET]);
  });

  it("keeps the old envelope so the existing screen still works", async () => {
    const r = await get("admin", "?limit=3");
    expect(Array.isArray(r.body.audit), "the `audit` key was dropped").toBe(true);
    expect(JSON.stringify(r.body.audit)).toBe(JSON.stringify(r.body.items));
  });

  it("filters to a date range, inclusively, in IST days", async () => {
    const today = String((await pool.query(
      `SELECT to_char(${"(NOW() AT TIME ZONE 'Asia/Kolkata')::date"}, 'YYYY-MM-DD') d`)).rows[0].d);
    const r = await get("admin", `?date_from=${today}&date_to=${today}&limit=200`);
    expect(r.status).toBe(200);
    /* Everything returned really is from today, IST. */
    const days = (r.body.items as unknown as { occurred_at: string }[]).map((x) =>
      new Date(new Date(x.occurred_at).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10));
    expect(days.every((d) => d === today), `a row outside ${today}: ${days.filter((d) => d !== today)[0]}`).toBe(true);
  });

  it("returns an empty page rather than an error for a range with nothing in it", async () => {
    const r = await get("admin", "?date_from=1990-01-01&date_to=1990-01-02");
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(Number(r.body.total)).toBe(0);
  });

  it("combines a date range with the filters it already had", async () => {
    const today = String((await pool.query(
      `SELECT to_char(${"(NOW() AT TIME ZONE 'Asia/Kolkata')::date"}, 'YYYY-MM-DD') d`)).rows[0].d);
    const r = await get("admin", `?entity_type=equipment_item&action=check&date_from=${today}&limit=50`);
    expect(r.status).toBe(200);
    for (const row of r.body.items as unknown as { entity_type: string; action: string }[]) {
      expect(row.entity_type).toBe("equipment_item");
      expect(row.action).toMatch(/check/i);
    }
  });

  it("refuses a malformed or backwards range", async () => {
    expect((await get("admin", "?date_from=last-tuesday")).status).toBe(400);
    expect((await get("admin", "?date_to=2026-99-99")).status).toBe(400);
    expect((await get("admin", "?date_from=2026-06-01&date_to=2026-05-01")).status).toBe(400);
  });
});
