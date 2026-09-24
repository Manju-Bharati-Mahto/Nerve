// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — module defaults, and authorization that fails CLOSED.

   THE HOLE. effectiveModules() answered null for a group with no defaults row,
   and every gate read null as "unrestricted". Only the 'creator' row was ever
   seeded. So a FRESH installation gave an ordinary employee a pass on every
   module gate in the product — Settings and Users & Roles included — and the
   only thing standing between a new deployment and that was an administrator
   knowing to go and create configuration whose absence granted everything.

   It never showed in development because that database had all six rows,
   written by an administrator months ago. It surfaced the moment a database
   was built from scratch for the first time.

   Two changes are under test here and they only work together:
     · the bootstrap seeds a row for every group, so nothing is implicit;
     · a missing row denies instead of granting.

   WHY NO TEST HERE DELETES A DEFAULTS ROW. The obvious way to test "missing
   row denies" is to delete one. Every group's row is shared configuration read
   by every suite in the run, and an earlier version of this file removed the
   `coordinator` row on the assumption that nothing else used it — the project
   hierarchy suite promptly failed with "no access to the projects module",
   because its Coordinator resolves through that very row. There is no group
   that some sibling does not depend on.

   So the missing-row branch is covered where it can be covered honestly:

     · `effectiveModules()` returns [] for a caller whose group cannot be
       resolved at all — the same `return []` the missing-row branch takes, on
       a state no suite can disturb because no row exists to begin with;
     · the end-to-end 403 is driven by an EMPTY resolution via a per-user
       override, which is byte-for-byte the list a missing row produces and
       exercises the identical gate;
     · and the resolution itself is asserted directly, so the two halves meet.

   Nothing here writes to a row another suite reads.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase, withGlobalLock, GLOBAL_LOCK } from "./test-db.js";

const PX = "zmd";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let db: typeof import("./mediaops-db.js");
let server: Server;
let base = "";

const A = {
  admin:       { id: `${PX}-admin`, role: "admin", team: "media", mo: "admin" },
  employee:    { id: `${PX}-emp`,   role: "user",  team: "media", mo: "employee" },
  coordinator: { id: `${PX}-coord`, role: "user",  team: "media", mo: "coordinator" },
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
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZMD ${a.id}` }
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

const user = (n: ActorName) => ({ id: A[n].id, role: A[n].role, team: A[n].team });

/** Give one user an explicit override for the duration of `fn`. */
async function withOverride<T>(id: string, mods: string[] | null, fn: () => Promise<T>): Promise<T> {
  const had = (await pool.query(
    `SELECT allowed_modules FROM mo_user_profiles WHERE user_id=$1`, [id])).rows[0];
  await pool.query(
    `UPDATE mo_user_profiles SET allowed_modules=$2::jsonb WHERE user_id=$1`,
    [id, mods === null ? null : JSON.stringify(mods)]);
  try {
    return await fn();
  } finally {
    await pool.query(
      `UPDATE mo_user_profiles SET allowed_modules=$2::jsonb WHERE user_id=$1`,
      [id, had?.allowed_modules == null ? null : JSON.stringify(had.allowed_modules)]);
  }
}

async function cleanup() {
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  api = await import("./mediaops-api.js");
  db = await import("./mediaops-db.js");
  await db.bootstrapMediaOpsDatabase();
  await cleanup();
  for (const a of Object.values(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','') ON CONFLICT (id) DO UPDATE
         SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZMD ${a.id}`, `${a.id}@x.invalid`, a.role, a.team]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZMD',$2,NULL) ON CONFLICT (user_id) DO UPDATE
         SET mo_role=EXCLUDED.mo_role, allowed_modules=NULL`,
      [a.id, a.mo]);
  }
  await boot();
}, 60_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ══════════════════════════════════════════════════════════════════════════
   1. A fresh database carries the whole configuration.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("a fresh installation is configured, not implicit", () => {
  it("has a defaults row for every group moduleGroupOf() can return", async () => {
    const rows = (await pool.query(`SELECT role FROM mo_module_defaults`)).rows.map((r) => String(r.role));
    for (const g of ["admin", "team_lead", "coordinator", "employee", "smc_member", "creator"])
      expect(rows, `no module defaults for "${g}"`).toContain(g);
  });

  /* The seed is transcribed from the sidebar's own derivation. If a route is
     renamed and the seed is not updated, this catches it — either as a key that
     grants nothing, or as a module nobody can reach. */
  it("seeds only module keys the product actually defines", async () => {
    const { readFileSync } = await import("node:fs");
    const html = readFileSync("public/media-ops/index.html", "utf8");
    const real = new Set(
      [...html.matchAll(/\{r:'#\/media\/([\w/-]+)'/g)].map((m) => m[1]).concat("kiosk"));
    for (const [role, mods] of Object.entries(db.MODULE_DEFAULT_SEED))
      for (const key of mods) {
        if (key === "creator") continue;      // the network's own key, gated separately
        expect(real, `${role} is granted "${key}", which is not a sidebar module`).toContain(key);
      }
  });

  it("gives the creator group the network and nothing else", () => {
    expect(db.MODULE_DEFAULT_SEED.creator).toEqual(["creator"]);
  });

  /* Bootstrapping twice must not duplicate, widen or reset anything. */
  it("is idempotent — a second bootstrap changes no row", async () => {
    /* Reads the WHOLE table, so it has to exclude the files that legitimately
       toggle a row of it — the creator-network suite flips the 'creator' row
       and restores it, and this snapshot caught it mid-flight. Both sides take
       the module-defaults lock. */
    await withGlobalLock(pool, GLOBAL_LOCK.moduleDefaults, async () => {
      const snap = async () => (await pool.query(
        `SELECT role, modules FROM mo_module_defaults ORDER BY role`)).rows;
      const before = await snap();
      await db.bootstrapMediaOpsDatabase();
      expect(await snap()).toEqual(before);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   2–4. Enabled allows, disabled denies, MISSING denies.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("module authorization", () => {
  it("allows a module the group's defaults explicitly grant", async () => {
    const eff = await api.effectiveModules(user("employee"));
    expect(eff).toContain("equipment");
    expect((await as("employee", "GET", "/equipment")).status).toBe(200);
  });

  it("denies a module the group's defaults explicitly withhold", async () => {
    /* The employee default does not include 'tv' — it is opt-in, granted per
       person by an Admin. */
    const eff = await api.effectiveModules(user("employee"));
    expect(eff).not.toContain("tv");
    expect((await as("employee", "GET", "/tv/board")).status).toBe(403);
  });

  it("denies a module an explicit per-user override withholds", async () => {
    await withOverride(A.employee.id, ["home", "my-day"], async () => {
      expect(await api.effectiveModules(user("employee"))).toEqual(["home", "my-day"]);
      expect((await as("employee", "GET", "/equipment")).status).toBe(403);
    });
  });

  it("treats an administrator's deliberately EMPTY list as meaning it", async () => {
    await withOverride(A.employee.id, [], async () => {
      expect(await api.effectiveModules(user("employee"))).toEqual([]);
      expect((await as("employee", "GET", "/equipment")).status).toBe(403);
    });
  });

  /* THE FIX. Both of these resolved to "unrestricted" before. */
  it("DENIES when no module configuration resolves at all", async () => {
    /* A caller whose team maps to no group: moduleGroupOf() returns null, so
       there is no row to read. This is the same `return []` the missing-row
       branch takes, and it used to be `return null` — which every gate read as
       a pass. */
    const stranger = { id: `${PX}-stranger`, role: "user", team: "branding" };
    expect(await api.effectiveModules(stranger),
      "an unresolvable group answered UNRESTRICTED").toEqual([]);
  });

  it("DENIES a protected endpoint when the resolved module list is empty", async () => {
    await withOverride(A.coordinator.id, [], async () => {
      expect(await api.effectiveModules(user("coordinator"))).toEqual([]);
      const r = await as("coordinator", "GET", "/equipment");
      expect(r.status, "an empty module list granted access").toBe(403);
      expect(String(r.body.message)).toMatch(/module/i);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   SECURITY REGRESSION — missing configuration must never open a door.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("SECURITY — missing configuration is a denial, on every protected surface", () => {
  /* Before this change every one of these answered 200 for an ordinary
     employee on a fresh install, because the group had no row. */
  /* MODULE-GATED surfaces only. `GET /module-defaults` is deliberately not one
     of them — it is guarded by requireMedia() alone, because it describes the
     module map rather than living behind a module. That it is readable by any
     crew member is a pre-existing information-disclosure question, recorded in
     docs/MODULE_DEFAULTS_SECURITY.md §H, and not something fail-closed
     authorization has any opinion about. */
  const protectedGets = ["/equipment", "/tv/board", "/creator/state"];

  it("refuses every protected read when no module resolves", async () => {
    await withOverride(A.coordinator.id, [], async () => {
      for (const p of protectedGets) {
        const r = await as("coordinator", "GET", p);
        expect(r.status, `${p} answered ${r.status} with NO modules resolved`)
          .toBeGreaterThanOrEqual(400);
      }
    });
  });

  it("refuses a protected WRITE when no module resolves", async () => {
    await withOverride(A.coordinator.id, [], async () => {
      const r = await as("coordinator", "POST", "/equipment",
        { category_id: 1, make: "should not happen" });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
  });

  /* An administrator must never be locked out by the configuration they are
     the only one who can repair. */
  /* The admin's own DEFAULTS ROW is deliberately not removed to prove this.
     hasModuleGrant() has no admin bypass — it reads the resolved list directly
     — so deleting that shared row changes what other suites' admins can do
     while it is gone. An explicit empty override on this one user proves the
     same property and touches nothing anybody else reads. */
  it("still lets an Admin through, which is how a broken install gets fixed", async () => {
    await withOverride(A.admin.id, [], async () => {
      expect(await api.effectiveModules(user("admin"))).toEqual([]);
      expect((await as("admin", "GET", "/equipment")).status).toBe(200);
      expect((await as("admin", "GET", "/tv/board")).status).toBe(200);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5. An administrator's own configuration is never overwritten.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("an existing installation keeps what its administrator chose", () => {
  /* The shared rows are NOT mutated to prove this — see the note at the top of
     the file. The seeding statement's behaviour is asserted on a role of this
     suite's own, which no user resolves to and no sibling reads, and the real
     rows are then checked to be byte-identical across a re-seed. */
  const PROBE = `${PX}-probe-role`;

  afterAll(async () => {
    if (dbUp) await pool.query(`DELETE FROM mo_module_defaults WHERE role=$1`, [PROBE]);
  });

  it("writes a row only when none exists — ON CONFLICT DO NOTHING, not DO UPDATE", async () => {
    await pool.query(`DELETE FROM mo_module_defaults WHERE role=$1`, [PROBE]);
    const seedOnce = (mods: string[]) => pool.query(
      `INSERT INTO mo_module_defaults (role, modules) VALUES ($1,$2::jsonb)
       ON CONFLICT (role) DO NOTHING`, [PROBE, JSON.stringify(mods)]);

    await seedOnce(["home"]);                       // as a fresh install would
    await seedOnce(["home", "projects", "equipment", "admin/users"]);   // a later boot
    const after = (await pool.query(
      `SELECT modules FROM mo_module_defaults WHERE role=$1`, [PROBE])).rows[0];
    expect(after.modules, "a later boot widened an existing row").toEqual(["home"]);
  });

  it("does not resurrect or widen a deliberately EMPTY row", async () => {
    await pool.query(
      `INSERT INTO mo_module_defaults (role, modules) VALUES ($1,'[]'::jsonb)
       ON CONFLICT (role) DO UPDATE SET modules='[]'::jsonb`, [PROBE]);
    await pool.query(
      `INSERT INTO mo_module_defaults (role, modules) VALUES ($1,'["home"]'::jsonb)
       ON CONFLICT (role) DO NOTHING`, [PROBE]);
    expect((await pool.query(
      `SELECT modules FROM mo_module_defaults WHERE role=$1`, [PROBE])).rows[0].modules)
      .toEqual([]);
  });

  it("leaves every real row byte-identical when the seeder runs again", async () => {
    await withGlobalLock(pool, GLOBAL_LOCK.moduleDefaults, async () => {
      const snap = async () => (await pool.query(
        `SELECT role, modules FROM mo_module_defaults WHERE role = ANY($1::text[]) ORDER BY role`,
        [Object.keys(db.MODULE_DEFAULT_SEED)])).rows;
      const before = await snap();
      await db.seedModuleDefaults();
      expect(await snap()).toEqual(before);
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   5b. THE MIGRATION THAT WIDENED ACCESS ON EVERY BOOT.

   When module keys stopped being coarse groups and started mirroring the
   sidebar, a migration expanded each old key into the entries it used to
   cover, so that nobody lost access on the way across. It was written to be
   idempotent and it said so in a comment: "the new keys contain no legacy
   names, so a second run matches nothing."

   Two of them do. 'projects' and 'performance' are keys in BOTH vocabularies.
   So a profile an Admin had deliberately narrowed to ["home","projects"]
   matched the trigger every single boot and came back out as
   ["boards","calendar","home","pipeline","projects"] — three modules nobody
   ticked, one of them 'boards', which POST /crew/:id/role strips on demotion
   precisely because a lead may reach it and an employee may not. Restarting
   the server undid the demotion.

   Found by a crew-lifecycle test failing intermittently: a sibling suite's
   bootstrap ran between that test creating its member and reading them back.
   The migration is the defect; the flake was only the messenger.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("the legacy module-key expansion runs once, not on every boot", () => {
  const MODERN = `${PX}-mig-modern`, OLD = `${PX}-mig-old`, AMBIG = `${PX}-mig-ambiguous`;
  const mods = async (id: string) => (await pool.query(
    `SELECT allowed_modules m FROM mo_user_profiles WHERE user_id=$1`, [id])).rows[0]?.m;
  const plant = async (id: string, m: string[]) => {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,'user','media','active','x','') ON CONFLICT (id) DO NOTHING`,
      [id, `ZMD ${id}`, `${id}@x.invalid`]);
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
       VALUES ($1,'ZMD','employee',$2::jsonb) ON CONFLICT (user_id) DO UPDATE
         SET allowed_modules=EXCLUDED.allowed_modules`, [id, JSON.stringify(m)]);
  };

  beforeAll(async () => {
    if (!dbUp) return;
    await plant(MODERN, ["home", "projects"]);          // what an Admin ticks today
    await plant(OLD, ["dashboard", "projects"]);        // written in the old vocabulary
    await plant(AMBIG, ["performance"]);                // the other key in both
    /* The REAL bootstrap, not a copy of its SQL — a restatement would pass
       while the shipping statement went on widening. */
    await db.bootstrapMediaOpsDatabase();
  }, 90_000);

  it("leaves a grant an Admin narrowed to Projects exactly as they left it", async () => {
    expect(await mods(MODERN), "a boot handed out modules nobody ticked").toEqual(["home", "projects"]);
  });

  it("still carries a genuinely old profile across, losing nothing", async () => {
    /* 'dashboard' exists in no new vocabulary, so this row can only have been
       written before the change: it is expanded, including its ambiguous key,
       which is what the migration is for. */
    const m = (await mods(OLD)) as string[];
    for (const k of ["home", "projects", "pipeline", "boards", "calendar"])
      expect(m, `the old vocabulary lost ${k}`).toContain(k);
    expect(m, "a coarse key survived into the new vocabulary").not.toContain("dashboard");
  });

  it("does not widen a lone ambiguous key on the strength of the key alone", async () => {
    /* ["performance"] before the change and ["performance"] after it are the
       same row; nothing can tell them apart. The narrow reading is the safe
       one — an Admin can widen deliberately, silence cannot. */
    expect(await mods(AMBIG)).toEqual(["performance"]);
  });

  it("changes nothing at all on the boot after that", async () => {
    const before = [await mods(MODERN), await mods(OLD), await mods(AMBIG)];
    await db.bootstrapMediaOpsDatabase();
    expect([await mods(MODERN), await mods(OLD), await mods(AMBIG)],
      "a later boot moved a profile again").toEqual(before);
  }, 90_000);
});

/* ══════════════════════════════════════════════════════════════════════════
   6–7. The two verticals this must not disturb.
   ══════════════════════════════════════════════════════════════════════════ */
maybe("the Creator Network and Equipment are unchanged", () => {
  it("a creator still resolves to the network and nothing else", async () => {
    /* UNDER THE LOCK THIS FILE ALREADY USES TWICE.

       mediaops-creator-network flips the shared `creator` defaults row to
       ["creator","home"] to prove a re-bootstrap does not overwrite an
       administrator's edit, and restores it in a finally. It holds
       GLOBAL_LOCK.moduleDefaults while it does so — but a lock only excludes
       the people who take it, and this reader did not, so it could sample the
       row mid-flight and see the value the other suite was about to put back.
       That is exactly what it did: expected ["creator"], got
       ["creator","home"]. The writer was already careful; the guard was simply
       one-sided. */
    await withGlobalLock(pool, GLOBAL_LOCK.moduleDefaults, async () => {
      const creator = { id: `${PX}-creator`, role: "user", team: "creator" };
      const eff = await api.effectiveModules(creator);
      expect(eff).toEqual(["creator"]);
      for (const other of ["home", "projects", "equipment", "team", "admin/users"])
        expect(eff, `creator group leaked "${other}"`).not.toContain(other);
    });
  });

  it("equipment authorization still follows the module, as the audit left it", async () => {
    expect((await as("employee", "GET", "/equipment")).status).toBe(200);
    await withOverride(A.employee.id, ["home", "my-day"], async () => {
      const r = await as("employee", "GET", "/equipment");
      expect(r.status).toBe(403);
      expect(String(r.body.message)).toMatch(/module/i);
    });
  });

  it("an Admin keeps the bypass every other module already relied on", async () => {
    expect((await as("admin", "GET", "/equipment")).status).toBe(200);
    expect((await as("admin", "GET", "/tv/board")).status).toBe(200);
  });
});
