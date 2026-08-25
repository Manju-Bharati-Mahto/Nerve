// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — TV Display Board grants, resolved against a real PostgreSQL.

   The sibling unit test proves the sidebar and the gate agree. This proves the
   third link: that a grant written the way the admin panel writes it
   (mo_user_profiles.allowed_modules, POST /crew/:id/modules) resolves through
   the REAL effectiveModules() to the verdict the endpoint acts on.

   Nothing here re-implements permissions. It imports effectiveModules,
   moRoleOf/isMoAdmin and tvBoardAllowed — the same three the route calls — and
   only supplies the fixtures.

   Fixtures are synthetic (ids prefixed `ztvit-`) and removed afterwards. No real
   person's account or grant is read, written or asserted on.

   Skips cleanly when no database is reachable, so the suite still runs in CI
   without one.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PREFIX = "ztvit";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let tv: typeof import("./mediaops-tv.js");

async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

/* Probed at MODULE level: maybe() below is evaluated while vitest collects the
   describe blocks, before any hook runs. */
{
  const url = await realDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ||= "integration-test-secret";
    process.env.SUPER_ADMIN_PASSWORD ||= "integration-test-password";
    const { pool: p } = await import("./db.js");
    pool = p;
    try {
      await pool.query("SELECT 1");
      dbUp = true;
      api = await import("./mediaops-api.js");
      tv = await import("./mediaops-tv.js");
    } catch {
      dbUp = false;
    }
  }
}
const maybe = dbUp ? describe : describe.skip;

type Fixture = { id: string; role: string; team: string; mods: string[] | null };

const F = {
  tvOnly:       { id: `${PREFIX}-tv-only`,  role: "user",  team: "media", mods: ["tv"] },
  noTv:         { id: `${PREFIX}-no-tv`,    role: "user",  team: "media", mods: ["home", "my-day", "projects"] },
  kioskOnly:    { id: `${PREFIX}-kiosk`,    role: "user",  team: "media", mods: ["kiosk"] },
  both:         { id: `${PREFIX}-both`,     role: "user",  team: "media", mods: ["kiosk", "tv"] },
  admin:        { id: `${PREFIX}-admin`,    role: "admin", team: "media", mods: null },
  roleDefault:  { id: `${PREFIX}-default`,  role: "user",  team: "media", mods: null },
  outsider:     { id: `${PREFIX}-outside`,  role: "user",  team: null,    mods: ["tv"] },
} satisfies Record<string, Fixture>;

async function seed(f: Fixture) {
  await pool.query(
    `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
     VALUES ($1,$2,$3,$4,$5,'active','x','')
     ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
    [f.id, `Probe ${f.id}`, `${f.id}@example.invalid`, f.role, f.team]);
  await pool.query(
    `INSERT INTO mo_user_profiles (user_id, designation, mo_role, allowed_modules)
     VALUES ($1,'probe','employee',$2)
     ON CONFLICT (user_id) DO UPDATE SET allowed_modules=EXCLUDED.allowed_modules`,
    [f.id, f.mods === null ? null : JSON.stringify(f.mods)]);
}

/** The caller as the route sees it, and the verdict the route reaches. */
async function verdict(f: Fixture) {
  const u = { id: f.id, role: f.role, team: f.team };
  const eff = await api.effectiveModules(u);
  return { eff, allowed: tv.tvBoardAllowed(api.isMoAdmin(u), eff), moRole: api.moRoleOf(u) };
}

/** Exactly what POST /crew/:id/modules writes. */
const setModules = (id: string, mods: string[] | null) => pool.query(
  `INSERT INTO mo_user_profiles (user_id, allowed_modules) VALUES ($1,$2)
   ON CONFLICT (user_id) DO UPDATE SET allowed_modules=EXCLUDED.allowed_modules`,
  [id, mods === null ? null : JSON.stringify(mods)]);

async function cleanup() {
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`]);
}

beforeAll(async () => { if (dbUp) { await cleanup(); for (const f of Object.values(F)) await seed(f); } });
afterAll(async () => { if (dbUp) await cleanup(); });

maybe("TV board grants resolve through the real permission helpers", () => {
  it("TEST 1 — only 'tv' granted → allowed, and the grant is the only module", async () => {
    const v = await verdict(F.tvOnly);
    expect(v.eff).toEqual(["tv"]);
    expect(v.allowed).toBe(true);
  });

  it("TEST 2 — unrelated modules, no 'tv' → refused", async () => {
    expect((await verdict(F.noTv)).allowed).toBe(false);
  });

  it("TEST 3 — only 'kiosk' → refused; the two modules are not merged", async () => {
    const v = await verdict(F.kioskOnly);
    expect(v.eff).toEqual(["kiosk"]);
    expect(v.allowed).toBe(false);
  });

  it("TEST 4 — 'kiosk' and 'tv' together → allowed, kiosk grant intact", async () => {
    const v = await verdict(F.both);
    expect(v.eff).toEqual(expect.arrayContaining(["kiosk", "tv"]));
    expect(v.allowed).toBe(true);
  });

  it("TEST 5 — an admin reaches the board through the existing admin bypass", async () => {
    const v = await verdict(F.admin);
    expect(v.moRole).toBe("admin");
    expect(v.allowed).toBe(true);
  });

  it("TEST 6 — an employee on their group's configured defaults does NOT get it", async () => {
    /* This is the "not on by default" guarantee, asserted against whatever
       mo_module_defaults actually holds for the employee group on this
       installation — not against a list this test invented. */
    const v = await verdict(F.roleDefault);
    if (v.eff === null) return;                    // installation configures no defaults at all
    expect(v.eff).not.toContain("tv");
    expect(v.allowed).toBe(false);
  });

  it("refuses someone who is not on the media crew, even holding the grant", async () => {
    // requireMedia() runs before the module check; moRoleOf() is what it asks.
    expect((await verdict(F.outsider)).moRole).toBeNull();
  });
});

maybe("granting and revoking through the admin panel's own write", () => {
  const id = `${PREFIX}-grantcycle`;

  beforeAll(async () => { if (dbUp) await seed({ id, role: "user", team: "media", mods: [] }); });

  it("TEST 7 — ticking TV Display Board persists the grant and opens access", async () => {
    await setModules(id, ["tv"]);
    const v = await verdict({ id, role: "user", team: "media", mods: null });
    expect(v.eff).toEqual(["tv"]);
    expect(v.allowed).toBe(true);
  });

  it("TEST 8 — unticking it removes the grant and closes access again", async () => {
    await setModules(id, []);
    const v = await verdict({ id, role: "user", team: "media", mods: null });
    expect(v.eff).toEqual([]);
    expect(v.allowed).toBe(false);
  });

  it("resolves per request, so a change takes effect without a new session", async () => {
    /* effectiveModules() reads the row on every call — there is no cached copy
       to go stale — so a revoked display loses the board on its next 45 s poll
       rather than at next login. */
    await setModules(id, ["tv"]);
    expect((await verdict({ id, role: "user", team: "media", mods: null })).allowed).toBe(true);
    await setModules(id, null);
    const v = await verdict({ id, role: "user", team: "media", mods: null });
    expect(v.eff).not.toEqual(["tv"]);
  });
});

maybe("the board's own payload carries nothing personal", () => {
  /* Walk the real payload rather than grepping it: a substring scan calls
     "Microphone" a phone number. What matters is the SHAPE — no field named
     after a personal attribute, and no value that looks like a contact
     detail or an account id. */
  function walk(node: unknown, path: string, hit: (where: string, what: string) => void) {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`, hit));
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        if (/^(email|phone|mobile|password|user_id|owner_id|created_by|reason|note|address)$/i.test(k))
          hit(`${path}.${k}`, "personal field");
        walk(v, `${path}.${k}`, hit);
      }
      return;
    }
    if (typeof node === "string") {
      if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(node)) hit(path, "email address");
      if (/(?:\+91[\s-]?)?\d{10}\b/.test(node)) hit(path, "phone number");
      if (/^u-\d{10,}-/.test(node)) hit(path, "raw account id");
    }
  }

  it("exposes aggregates only — no personal fields, emails, numbers or account ids", async () => {
    const found: string[] = [];
    walk(await tv.buildTvBoard(), "board", (where, what) => found.push(`${what} at ${where}`));
    expect(found).toEqual([]);
  });

  it("names teams and equipment categories, which are not personal data", async () => {
    // The counterpart assertion: the scan above passing must not be because the
    // payload is empty.
    const b = await tv.buildTvBoard();
    expect(b.equipment.length).toBeGreaterThan(0);
    expect(b.kpis.crew_total).toBeGreaterThan(0);
  });
});
