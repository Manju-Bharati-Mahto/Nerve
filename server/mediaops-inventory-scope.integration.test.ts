// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Inventory Scope (Phase 13A foundation).

   A scope is WHOSE STOCK an asset belongs to: the owner a custodian can be
   custodian OF. This phase creates that object and nothing else. It does not
   decide who may borrow, see or book anything — mo_equipment_items.scope_id is
   nullable, no asset has one, and no authorization path reads it. Several
   tests below exist specifically to hold that line, so that the phase which
   DOES enforce scope has to change them deliberately rather than inherit an
   enforcement nobody wrote.

   The scope is managed by the generic CRUD engine, registered as
   `inventory_scopes` beside Campuses — which mo_equipment_items already
   carries a nullable FK to. So this file is also the engine's first direct
   test coverage: the audit found no test in the repository issuing a request
   to any /crud/ endpoint, which is how permissions, dependency-checked delete
   and the archive path came to be entirely unexercised.

   Every fixture is prefixed `zis` and removed afterwards. Nothing here writes
   an unscoped UPDATE or DELETE: sibling suites run against the same database
   at the same time.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zis";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let categoryId = 0;
/* MEASURED BY ACTOR, NOT BY TOTAL. The claims below used to count every row in
   the table, which was correct while this was the only suite that created a
   scope. Phase 13B added a second one, running in parallel against the same
   database, and a global count then failed intermittently for a reason that had
   nothing to do with the migration. A seed written by a MIGRATION has no actor,
   so created_by IS NULL is precisely the signature of the thing being ruled out
   — and no test can produce it, because every suite creates scopes as somebody.

   Fixture categories are the same idea on the asset side: every suite in this
   repository names its own '<zxx> Something', so a category that does NOT match
   that shape is one the registry seeded, and an asset in one is an asset no
   sibling suite can have touched. That is the population a migration backfill
   would move, and the only one worth counting here. TEST_STABILITY entry 14. */
const FIXTURE_CATEGORY = "^z[a-z][a-z] ";

/* The four rungs crudCan() actually distinguishes, plus an outsider. A media
   'user' resolves to 'employee' and may only read; 'sub_admin' resolves to
   'team_lead' and may create/edit/disable but not archive or delete; 'admin'
   may do everything. `outsider` is not media crew at all. */
const A = {
  admin:    { id: `${PX}-admin`, role: "admin",     team: "media" },
  lead:     { id: `${PX}-lead`,  role: "sub_admin", team: "media" },
  member:   { id: `${PX}-memb`,  role: "user",      team: "media" },
  outsider: { id: `${PX}-out`,   role: "user",      team: "branding" },
} as const;
type ActorName = keyof typeof A;

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
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZIS ${a.id}` }
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

/** Create a scope through the real endpoint and return its row. */
async function newScope(name: string, code: string, actor: ActorName = "admin") {
  const r = await as(actor, "POST", "/crud/inventory_scopes", { name, code });
  if (r.status !== 201) throw new Error(`fixture scope failed: ${r.status} ${JSON.stringify(r.body)}`);
  const row = r.body.row as unknown as Record<string, unknown>;
  /* node-postgres hands a BIGINT back as a STRING, so an id compared with ===
     against Number(x.id) is never equal and the assertion quietly passes by
     being vacuously false. Coerced once, here, rather than at each call. */
  return { ...row, id: Number(row.id) } as { id: number; name: string; code: string;
           is_active: boolean; archived_at: string | null; created_by: string };
}
const scopeRow = async (id: number) =>
  (await pool.query(`SELECT * FROM mo_inventory_scopes WHERE id=$1`, [id])).rows[0];

async function cleanup() {
  /* Assets first: they hold the FK that would otherwise refuse the scope
     delete below, and they are keyed on the prefix rather than on an
     in-memory id so an interrupted run still cleans up after itself. */
  const ids = (await pool.query(
    `SELECT id FROM mo_equipment_items
      WHERE asset_tag LIKE $1
         OR category_id IN (SELECT id FROM mo_equipment_categories WHERE name LIKE $2)`,
    [`EQ-${PX.toUpperCase()}-%`, `${PX} %`])).rows.map((r) => Number(r.id));
  if (ids.length) {
    await pool.query(`DELETE FROM mo_asset_identifiers WHERE asset_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_transactions WHERE equipment_item_id = ANY($1::bigint[])`, [ids]);
    await pool.query(`DELETE FROM mo_equipment_items WHERE id = ANY($1::bigint[])`, [ids]);
  }
  await pool.query(`DELETE FROM mo_equipment_categories WHERE name LIKE $1`, [`${PX} %`]);
  /* Keyed on created_by as well as on the code, because a scope's code is the
     one field a test is allowed to make unrecognisable — the empty-code case
     below stores ''. created_by carries the prefix whatever the code becomes,
     and it is also the FK that refuses the users delete two lines down. */
  await pool.query(`DELETE FROM mo_inventory_scopes WHERE code LIKE $1 OR created_by LIKE $2`,
    [`${PX}-%`, `${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  const { bootstrapMediaOpsDatabase } = await import("./mediaops-db.js");
  await bootstrapMediaOpsDatabase();
  await cleanup();

  for (const a of Object.values(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZIS ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
  }
  categoryId = Number((await pool.query(
    `INSERT INTO mo_equipment_categories (name, tracking_mode, sort_order)
     VALUES ($1,'individual',0) RETURNING id`, [`${PX} Cameras`])).rows[0].id);
  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

beforeEach(async () => {
  if (!dbUp) return;
  await pool.query(`DELETE FROM mo_equipment_items WHERE asset_tag LIKE $1`, [`EQ-${PX.toUpperCase()}-%`]);
  await pool.query(`DELETE FROM mo_inventory_scopes WHERE code LIKE $1 OR created_by LIKE $2`,
    [`${PX}-%`, `${PX}-%`]);
});

/* ─────────────────────────────────────────────────────────────────────────
   The migration itself. A table nobody has migrated to is not a foundation.
   ───────────────────────────────────────────────────────────────────────── */
maybe("the migration", () => {
  it("creates mo_inventory_scopes with the engine's lifecycle contract", async () => {
    const cols = (await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name='mo_inventory_scopes'`)).rows as { column_name: string; is_nullable: string }[];
    const by = Object.fromEntries(cols.map((c) => [c.column_name, c.is_nullable]));
    // Identity + the two human fields.
    expect(by.id).toBe("NO");
    expect(by.name).toBe("NO");
    expect(by.code).toBe("NO");
    // The five columns the generic CRUD engine requires of every config table.
    for (const c of ["is_active", "archived_at", "created_by", "created_at", "updated_at"])
      expect(by[c], `missing lifecycle column ${c}`).toBeDefined();
    expect(by.is_active).toBe("NO");
    expect(by.archived_at).toBe("YES");
  });

  it("does not create the columns this phase deliberately refused", async () => {
    /* Each of these was proposed and rejected with a reason recorded in the
       migration. A later phase may add one — additively, on evidence. This
       test is here so that adding one is a decision rather than a drift. */
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='mo_inventory_scopes'`)
    ).rows.map((r) => String(r.column_name));
    for (const c of ["parent_scope_id", "metadata", "type", "scope_type", "department_id", "campus_id", "academic_unit_id"])
      expect(cols, `unexpected column ${c}`).not.toContain(c);
  });

  it("gives equipment a nullable scope_id and backfills nothing", async () => {
    const col = (await pool.query(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_name='mo_equipment_items' AND column_name='scope_id'`)).rows[0];
    expect(col, "scope_id was not added to mo_equipment_items").toBeDefined();
    // Nullable means "not yet scoped". It must never mean "belongs to everyone",
    // which is precisely why the enforcing phase has to fail closed on NULL.
    expect(col.is_nullable).toBe("YES");
    expect(col.column_default).toBeNull();
  });

  it("seeds the two APPROVED inventories, and invents nothing else", async () => {
    /* CHANGED DELIBERATELY BY PHASE 17A.

       Until 17A this asserted that the migration seeded NO scope at all, and
       that was right: 'PID' and '24 Frames' were product decisions nobody had
       taken, and a migration is no place to take one. Decision P-1 was taken
       on 2026-09-22 — Media Crew and PID approved by name — so the migration
       now seeds APPROVED data rather than inventing it.

       The guard survives in a narrower form: exactly those two, nothing else,
       and still not one asset assigned to either. A third seeded scope, or a
       backfilled asset, fails here. */
    const seeded = (await pool.query(
      `SELECT code, name, code_prefix FROM mo_inventory_scopes
        WHERE created_by IS NULL ORDER BY code`)).rows;
    expect(seeded.map((r) => r.code)).toEqual(["media_crew", "pid"]);
    expect(seeded.map((r) => r.name)).toEqual(["Media Crew", "PID"]);
    expect(seeded.map((r) => r.code_prefix)).toEqual(["MC", "PID"]);

    /* THE PART THAT HAS NOT CHANGED, and is the whole point: approving the
       NAME of an inventory assigns no asset to it.

       Measuring this at all is harder than it looks, and two earlier attempts
       were wrong. A bare global count failed whenever a sibling suite had a
       fixture attached to a seeded inventory — which Phase 17C made routine
       and 17D made constant. Moving the count into beforeAll did not fix it;
       it only narrowed the window, because a sibling can already be running by
       then. What DOES separate the two populations is the category: sibling
       fixtures live in a fixture category, the estate a migration would
       backfill lives in a registry one. So the count is restricted to registry
       assets, and can then be taken live — which is stricter than the
       beforeAll version ever was, since a backfill at any point in the run
       fails here. TEST_STABILITY entry 14, fourth correction of this shape. */
    const backfilled = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_equipment_items i
         JOIN mo_inventory_scopes s ON s.id = i.scope_id
         JOIN mo_equipment_categories c ON c.id = i.category_id
        WHERE s.created_by IS NULL AND c.name !~ $1`, [FIXTURE_CATEGORY])).rows[0].c);
    expect(backfilled, "the migration backfilled an asset").toBe(0);
  });

  it("is idempotent — the columns exist exactly once", async () => {
    /* Every suite in this repository bootstraps the same database in its own
       beforeAll, so by the time this runs the migration has been applied many
       times over. Duplicate or conflicting DDL would show up as a column count
       that is not the eight declared. This suite deliberately does NOT call
       bootstrap again to prove the point: concurrent ALTER TABLE across
       workers is how sibling suites deadlock each other. */
    /* Named rather than counted: a bare count tells you a column arrived but
       not which, and two phases have legitimately added one — 17A's
       code_prefix (the inventory's internal-code prefix) and PID Borrowing's
       lends_to_students, which is the governed answer to "may an institute
       student hold equipment from this cupboard". Both are listed, so a third
       arriving unannounced still fails here. */
    const cols = (await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name='mo_inventory_scopes' ORDER BY column_name`)).rows.map((r) => r.column_name);
    expect(cols).toEqual(["archived_at", "code", "code_prefix", "created_at", "created_by",
                          "id", "is_active", "lends_to_students", "name", "updated_at"]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Creating, reading, renaming, retiring.
   ───────────────────────────────────────────────────────────────────────── */
maybe("a scope's life", () => {
  it("is created through the existing config endpoint", async () => {
    const r = await as("admin", "POST", "/crud/inventory_scopes",
      { name: "ZIS Product Innovation Dept", code: `${PX}-pid` });
    expect(r.status).toBe(201);
    const row = r.body.row as unknown as Record<string, unknown>;
    expect(row.name).toBe("ZIS Product Innovation Dept");
    expect(row.code).toBe(`${PX}-pid`);
    expect(row.is_active).toBe(true);
    expect(row.archived_at).toBeNull();
  });

  it("records who created it, without being asked to", async () => {
    const s = await newScope("ZIS Owned", `${PX}-owned`);
    expect((await scopeRow(s.id)).created_by).toBe(A.admin.id);
  });

  it("normalises the code, so the machine identifier is predictable", async () => {
    // `code` is a slug: the engine lowercases it and collapses anything that
    // is not [a-z0-9_-]. Two people typing the same name get the same code.
    const s = await newScope("ZIS Twenty Four Frames", `${PX} Twenty Four`);
    expect(s.code).toBe(`${PX}-twenty-four`);
  });

  it("lists scopes for anyone on the media crew", async () => {
    await newScope("ZIS Alpha", `${PX}-alpha`);
    const r = await as("member", "GET", "/crud/inventory_scopes");
    expect(r.status).toBe(200);
    const rows = r.body.rows as unknown as { code: string }[];
    expect(rows.some((x) => x.code === `${PX}-alpha`)).toBe(true);
  });

  it("returns one scope with its dependencies and its audit history", async () => {
    const s = await newScope("ZIS Detail", `${PX}-detail`);
    const r = await as("admin", "GET", `/crud/inventory_scopes/${s.id}`);
    expect(r.status).toBe(200);
    expect((r.body.row as unknown as { code: string }).code).toBe(`${PX}-detail`);
    expect(r.body.dependencies).toEqual([]);
    const hist = r.body.audit as unknown as { action: string }[];
    expect(hist.some((h) => h.action === "crud.created")).toBe(true);
  });

  it("renames without disturbing the code", async () => {
    const s = await newScope("ZIS Before", `${PX}-stable`);
    const r = await as("admin", "PATCH", `/crud/inventory_scopes/${s.id}`, { name: "ZIS After" });
    expect(r.status).toBe(200);
    const row = await scopeRow(s.id);
    expect(row.name).toBe("ZIS After");
    // The display name is for humans and may change; the code is what a
    // future scoped query would resolve against, so it survives a rename.
    expect(row.code).toBe(`${PX}-stable`);
  });

  it("deactivates rather than deletes, and drops out of the active list", async () => {
    const s = await newScope("ZIS Retiring", `${PX}-retiring`);
    const r = await as("admin", "POST", `/crud/inventory_scopes/${s.id}/state`, { action: "disable" });
    expect(r.status).toBe(200);
    expect((await scopeRow(s.id)).is_active).toBe(false);

    const active = await as("admin", "GET", "/crud/inventory_scopes?status=active");
    expect((active.body.rows as unknown as { id: number }[]).some((x) => Number(x.id) === s.id)).toBe(false);
    const off = await as("admin", "GET", "/crud/inventory_scopes?status=disabled");
    expect((off.body.rows as unknown as { id: number }[]).some((x) => Number(x.id) === s.id)).toBe(true);
    // The row is still there. Deactivate-never-delete (VR-11).
    expect(await scopeRow(s.id)).toBeDefined();
  });

  it("archives and restores", async () => {
    const s = await newScope("ZIS Archivable", `${PX}-arch`);
    expect((await as("admin", "POST", `/crud/inventory_scopes/${s.id}/state`, { action: "archive" })).status).toBe(200);
    expect((await scopeRow(s.id)).archived_at).not.toBeNull();
    expect((await as("admin", "POST", `/crud/inventory_scopes/${s.id}/state`, { action: "restore" })).status).toBe(200);
    expect((await scopeRow(s.id)).archived_at).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Input that should be refused.
   ───────────────────────────────────────────────────────────────────────── */
maybe("bad input", () => {
  it("refuses a duplicate code", async () => {
    await newScope("ZIS First", `${PX}-dup`);
    const r = await as("admin", "POST", "/crud/inventory_scopes", { name: "ZIS Second", code: `${PX}-dup` });
    expect(r.status).toBe(409);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_inventory_scopes WHERE code=$1`, [`${PX}-dup`])).rows[0].c)).toBe(1);
  });

  it("refuses a duplicate that only differs by case or spacing", async () => {
    // Because the code is slugged before it is stored, "ZIS Dup2" and
    // "zis-dup2" are the same identifier — and the UNIQUE index says so.
    await newScope("ZIS First", `${PX}-dup2`);
    const r = await as("admin", "POST", "/crud/inventory_scopes",
      { name: "ZIS Second", code: `${PX.toUpperCase()} DUP2` });
    expect(r.status).toBe(409);
  });

  it("refuses a scope with no name", async () => {
    const r = await as("admin", "POST", "/crud/inventory_scopes", { code: `${PX}-nameless` });
    expect(r.status).toBe(400);
  });

  it("refuses a scope with no code", async () => {
    const r = await as("admin", "POST", "/crud/inventory_scopes", { name: "ZIS Codeless" });
    expect(r.status).toBe(400);
  });

  it("KNOWN GAP — accepts a code that slugs away to nothing", async () => {
    /* PRE-EXISTING ENGINE DEFECT, pinned here rather than fixed, because the
       fix lives in crudValidate() and would change behaviour for every config
       module with a required slug — Campuses included — and this phase was told not to fix
       unrelated things opportunistically.

       `required` is checked BEFORE the slug transform runs, so "!!!" passes as
       non-empty and is then normalised to "". The row is stored with an empty
       machine identifier. Anything with no [a-z0-9_-] character at all does
       this — which at this university includes a name typed in Gujarati or
       Hindi, so it is not a theoretical input.

       The UNIQUE index limits the damage to one such row per table. The
       recommended fix (re-check `required` after normalising) is recorded in
       the phase document. This test exists so that fix shows up as a
       deliberate change to an assertion. */
    const r = await as("admin", "POST", "/crud/inventory_scopes", { name: "ZIS Empty", code: "!!!" });
    expect(r.status).toBe(201);
    expect((r.body.row as unknown as { code: string }).code).toBe("");
    await pool.query(`DELETE FROM mo_inventory_scopes WHERE name='ZIS Empty'`);
  });

  it("writes nothing when it refuses", async () => {
    /* COUNTED BY ACTOR, not globally. Sibling suites create and delete scopes
       of their own against this database at the same time, so a bare
       COUNT(*) moves between the two reads for reasons that have nothing to do
       with the refusal being tested. The CRUD engine stamps created_by with
       the caller, so this suite's rows are exactly the ones it could have
       written. */
    const mine = async () => Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_inventory_scopes WHERE created_by LIKE $1`,
      [`${PX}-%`])).rows[0].c);
    const before = await mine();
    await as("admin", "POST", "/crud/inventory_scopes", { code: `${PX}-ghost` });
    await as("admin", "POST", "/crud/inventory_scopes", { name: "ZIS Ghost" });
    expect(await mine()).toBe(before);
  });

  it("404s for a scope that does not exist", async () => {
    expect((await as("admin", "GET", "/crud/inventory_scopes/2147483000")).status).toBe(404);
    expect((await as("admin", "PATCH", "/crud/inventory_scopes/2147483000", { name: "x" })).status).toBe(404);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   Who may do what. No new role was created; these are the existing rungs.
   ───────────────────────────────────────────────────────────────────────── */
maybe("authorization", () => {
  it("turns away a caller with no session", async () => {
    /* 403 rather than 401: requireMedia() resolves the caller's media role and
       refuses anyone without one, and an absent session has none. The
       distinction between "not logged in" and "not media crew" is not one this
       surface draws, and this phase is not the place to start drawing it. */
    expect((await as("anon", "GET", "/crud/inventory_scopes")).status).toBe(403);
    expect((await as("anon", "POST", "/crud/inventory_scopes",
      { name: "ZIS Anon", code: `${PX}-anon` })).status).toBe(403);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_inventory_scopes WHERE code=$1`, [`${PX}-anon`])).rows[0].c)).toBe(0);
  });

  it("turns away someone who is not media crew", async () => {
    expect((await as("outsider", "GET", "/crud/inventory_scopes")).status).toBe(403);
    expect((await as("outsider", "POST", "/crud/inventory_scopes",
      { name: "ZIS Out", code: `${PX}-out` })).status).toBe(403);
  });

  it("lets an ordinary crew member read but not write", async () => {
    const s = await newScope("ZIS ReadOnly", `${PX}-ro`);
    expect((await as("member", "GET", "/crud/inventory_scopes")).status).toBe(200);
    expect((await as("member", "POST", "/crud/inventory_scopes",
      { name: "ZIS Nope", code: `${PX}-nope` })).status).toBe(403);
    expect((await as("member", "PATCH", `/crud/inventory_scopes/${s.id}`, { name: "ZIS Hijacked" })).status).toBe(403);
    expect((await as("member", "DELETE", `/crud/inventory_scopes/${s.id}`)).status).toBe(403);
    expect((await scopeRow(s.id)).name).toBe("ZIS ReadOnly");
  });

  it("shuts a team lead out of scope governance entirely", async () => {
    /* CHANGED DELIBERATELY BY PHASE 15 — and this test is why the change is
       visible rather than silent.

       Until Phase 15 this asserted the opposite: that a Team Lead could create,
       rename and deactivate a scope, because crudCan() grants writes on every
       config module to admin OR team_lead and a scope was registered as
       ordinary reference data. Phase 13A called that acceptable for a lookup
       table and said so; Phase 13B made a scope an authorization boundary, at
       which point deactivating one withdraws every custodian's access to it.
       The comment here asked the phase that made scope decide access to
       revisit the line. Phase 15 did: inventory_scopes now carries
       manage:"admin", so every write requires isMoAdmin() — the same bar that
       already governs POST /crew/:id/duties.

       The override is per module. mediaops-custodian.integration.test.ts holds
       the regression that the other twenty config modules kept their old
       permissions. */
    const before = await newScope("ZIS Admin Made", `${PX}-adminmade`);
    expect((await as("lead", "POST", "/crud/inventory_scopes",
      { name: "ZIS Lead Made", code: `${PX}-lead` })).status).toBe(403);
    expect((await as("lead", "PATCH", `/crud/inventory_scopes/${before.id}`,
      { name: "ZIS Lead Edited" })).status).toBe(403);
    expect((await as("lead", "POST", `/crud/inventory_scopes/${before.id}/state`,
      { action: "disable" })).status).toBe(403);
    expect((await as("lead", "POST", `/crud/inventory_scopes/${before.id}/state`,
      { action: "archive" })).status).toBe(403);
    expect((await as("lead", "DELETE", `/crud/inventory_scopes/${before.id}`)).status).toBe(403);
    // Nothing the Team Lead attempted took effect.
    const row = await scopeRow(before.id);
    expect(row.name).toBe("ZIS Admin Made");
    expect(row.is_active).toBe(true);
    expect(row.archived_at).toBeNull();
    // A reader may still read: the scope list is a lookup, not the boundary.
    expect((await as("lead", "GET", "/crud/inventory_scopes")).status).toBe(200);
  });

  it("refuses a force-delete to a media admin", async () => {
    // Force Delete nulls out live references. It is the Super Admin's, and a
    // media 'admin' is deliberately not one.
    const s = await newScope("ZIS Forceful", `${PX}-force`);
    const r = await as("admin", "POST", `/crud/inventory_scopes/${s.id}/force-delete`, { confirm: "DELETE" });
    expect(r.status).toBe(403);
    expect(await scopeRow(s.id)).toBeDefined();
  });

  it("audits every mutation through the existing trail", async () => {
    const s = await newScope("ZIS Audited", `${PX}-audited`);
    await as("admin", "PATCH", `/crud/inventory_scopes/${s.id}`, { name: "ZIS Audited II" });
    await as("admin", "POST", `/crud/inventory_scopes/${s.id}/state`, { action: "disable" });
    const rows = (await pool.query(
      `SELECT action FROM mo_audit_logs WHERE entity_type='inventory_scopes' AND entity_id=$1
        ORDER BY occurred_at`, [s.id])).rows.map((r) => String(r.action));
    expect(rows).toContain("crud.created");
    expect(rows).toContain("crud.updated");
    expect(rows).toContain("crud.disabled");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The estate carries on exactly as before. This is the compatibility claim.
   ───────────────────────────────────────────────────────────────────────── */
maybe("existing equipment is undisturbed", () => {
  const newAsset = async (model = "ZIS Body") => {
    const r = await as("admin", "POST", "/equipment", { category_id: categoryId, make: "ZIS", model });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return Number((r.body.item as unknown as { id: number }).id);
  };

  it("registers an asset with no scope at all", async () => {
    const id = await newAsset();
    const row = (await pool.query(`SELECT scope_id FROM mo_equipment_items WHERE id=$1`, [id])).rows[0];
    expect(row.scope_id).toBeNull();
  });

  it("lists and opens an unscoped asset normally", async () => {
    const id = await newAsset("ZIS Listable");
    const list = await as("admin", "GET", "/equipment?q=ZIS Listable");
    expect(list.status).toBe(200);
    expect((list.body.items as unknown as { id: number }[]).some((x) => Number(x.id) === id)).toBe(true);
    expect((await as("admin", "GET", `/equipment/${id}`)).status).toBe(200);
  });

  it("does not leak scope into the equipment read models", async () => {
    /* Nothing reads scope_id yet, so nothing should ship it. When a later
       phase surfaces scope, this test is the one that says so out loud. */
    const id = await newAsset("ZIS Quiet");
    const list = await as("admin", "GET", "/equipment?q=ZIS Quiet");
    const row = (list.body.items as unknown as Record<string, unknown>[])
      .find((x) => Number(x.id) === id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row.scope_id).toBeUndefined();
    const detail = await as("admin", "GET", `/equipment/${id}`);
    expect((detail.body.item as unknown as Record<string, unknown>).scope_id).toBeUndefined();
  });

  it("keeps scope out of /state", async () => {
    // /state stopped shipping the estate in Phase 7/8. It is not getting a
    // new equipment dataset now.
    const r = await as("admin", "GET", "/state");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).not.toContain("inventory_scopes");
  });

  it("carries a scope once one is set, and still behaves identically", async () => {
    const s = await newScope("ZIS Holder", `${PX}-holder`);
    const id = await newAsset("ZIS Assigned");
    // Set directly: no endpoint assigns scope in this phase, on purpose.
    await pool.query(`UPDATE mo_equipment_items SET scope_id=$1 WHERE id=$2`, [s.id, id]);
    const list = await as("admin", "GET", "/equipment?q=ZIS Assigned");
    expect((list.body.items as unknown as { id: number }[]).some((x) => Number(x.id) === id)).toBe(true);
    expect((await as("admin", "GET", `/equipment/${id}`)).status).toBe(200);
  });

  it("shows an assigned asset as a dependency, and refuses to delete the scope", async () => {
    const s = await newScope("ZIS InUse", `${PX}-inuse`);
    const id = await newAsset("ZIS Dependent");
    await pool.query(`UPDATE mo_equipment_items SET scope_id=$1 WHERE id=$2`, [s.id, id]);

    const detail = await as("admin", "GET", `/crud/inventory_scopes/${s.id}`);
    expect(detail.body.dependencies).toEqual([{ label: "Equipment items", count: 1 }]);

    const del = await as("admin", "DELETE", `/crud/inventory_scopes/${s.id}`);
    expect(del.status).toBe(409);
    // The asset keeps its scope; the scope keeps existing.
    expect(await scopeRow(s.id)).toBeDefined();
    expect(Number((await pool.query(
      `SELECT scope_id FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].scope_id)).toBe(Number(s.id));
  });

  it("deletes a scope that owns nothing", async () => {
    const s = await newScope("ZIS Unused", `${PX}-unused`);
    expect((await as("admin", "DELETE", `/crud/inventory_scopes/${s.id}`)).status).toBe(200);
    expect(await scopeRow(s.id)).toBeUndefined();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
   The line this phase must not cross.
   ───────────────────────────────────────────────────────────────────────── */
maybe("scope became an authorization boundary in Phase 13B", () => {
  it("restricts who may see a scoped asset", async () => {
    /* CHANGED DELIBERATELY BY PHASE 13B, which is what this test was for.

       Until 13B this asserted the opposite — that a crew member with no
       relationship to a scope could still read a scoped asset, because nothing
       enforced scope. It was written to fail the moment enforcement arrived,
       so that enforcement could not be inherited by accident or left
       half-applied without anyone noticing. It failed on the first run of
       13B's changes, and this is the edit it was asking for.

       `member` holds the Equipment module and no scope assignment, which is
       every user in the database today. They get 404 — not 403 — so the id
       tells them nothing. The full cross-scope proof lives in
       mediaops-inventory-scope-auth.integration.test.ts. */
    const s = await newScope("ZIS Boundary", `${PX}-boundary`);
    const r = await as("admin", "POST", "/equipment", { category_id: categoryId, make: "ZIS", model: "ZIS Scoped" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    await pool.query(`UPDATE mo_equipment_items SET scope_id=$1 WHERE id=$2`, [s.id, id]);

    expect((await as("member", "GET", `/equipment/${id}`)).status).toBe(404);
    // The admin's access is unchanged, and the asset really is still there.
    expect((await as("admin", "GET", `/equipment/${id}`)).status).toBe(200);
  });

  it("leaves the unscoped estate reachable, so nothing went dark", async () => {
    /* The other half of 13B: an asset with no scope predates the model and
       stays visible to everyone who could already see it. Without this, the
       enforcement above would have been indistinguishable from an outage. */
    const r = await as("admin", "POST", "/equipment", { category_id: categoryId, make: "ZIS", model: "ZIS Unscoped" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    expect((await pool.query(`SELECT scope_id FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].scope_id).toBeNull();
    expect((await as("member", "GET", `/equipment/${id}`)).status).toBe(200);
  });

  it("still offers no endpoint that assigns an asset to a scope", async () => {
    /* Unchanged by 13B, deliberately. 13B decides who may REACH a scoped
       asset; it does not decide how an asset comes to be scoped. scope_id is
       absent from ASSET_EDITABLE, so the field is dropped rather than written,
       and self-service rescoping — which would defeat the whole model — is
       impossible through the API. Assignment remains a later phase's design. */
    const s = await newScope("ZIS NoAssign", `${PX}-noassign`);
    const r = await as("admin", "POST", "/equipment", { category_id: categoryId, make: "ZIS", model: "ZIS Unassignable" });
    const id = Number((r.body.item as unknown as { id: number }).id);
    const patched = await as("admin", "PATCH", `/equipment/${id}`, { scope_id: s.id });
    // The endpoint may accept the call, but it must not honour the field.
    expect((await pool.query(`SELECT scope_id FROM mo_equipment_items WHERE id=$1`, [id])).rows[0].scope_id).toBeNull();
    expect([200, 400, 403]).toContain(patched.status);
  });
});
