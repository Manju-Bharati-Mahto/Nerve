// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   3. buildAiUserContext() against a real database.

   Proves the one claim the whole permission story rests on: AI capabilities are
   DERIVED from Nerve's existing role, module and duty checks — never invented,
   and never wider than what Nerve already grants.

   Synthetic users only (ids prefixed `aiu-`), removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiCapability } from "./ai/types.js";

const PREFIX = "aiu";
let dbUp = false;
let pool: import("pg").Pool;
let build: (u: { id: string; role: string; team: string | null }) => Promise<{
  id: string; role: string; capabilities: ReadonlySet<AiCapability>; projectScope: "all" | "own";
}>;

async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

// Module-level probe — see the note in mediaops-queries.integration.test.ts.
{
  const url = await realDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    const { pool: p } = await import("./db.js");
    pool = p;
    try {
      await pool.query("SELECT 1");
      dbUp = true;
      ({ buildAiUserContext: build } = await import("./mediaops-api.js") as never);
    } catch { dbUp = false; }
  }
}
const maybe = () => (dbUp ? it : it.skip);

/** Create a user, optionally with an explicit allowed_modules override. */
async function mkUser(id: string, role: string, team: string | null, modules?: string[] | null) {
  await pool.query(
    `INSERT INTO users (id, full_name, email, role, team, password_hash)
     VALUES ($1,$2,$3,$4,$5,'x') ON CONFLICT (id) DO NOTHING`,
    [`${PREFIX}-${id}`, `Test ${id}`, `${PREFIX}-${id}@example.invalid`, role, team]);
  if (modules !== undefined)
    await pool.query(
      `INSERT INTO mo_user_profiles (user_id, allowed_modules) VALUES ($1,$2)
       ON CONFLICT (user_id) DO UPDATE SET allowed_modules = EXCLUDED.allowed_modules`,
      [`${PREFIX}-${id}`, modules === null ? null : JSON.stringify(modules)]);
  return { id: `${PREFIX}-${id}`, role, team };
}

async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM mo_user_duties WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
  await pool.query(`DELETE FROM mo_smc_profiles WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PREFIX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`]);
}

beforeAll(async () => { if (dbUp) await cleanup(); }, 60_000);
afterAll(async () => { if (dbUp) await cleanup(); }, 60_000);

const caps = async (u: { id: string; role: string; team: string | null }) =>
  [...(await build(u)).capabilities].sort();

describe("capabilities are derived from Nerve, not declared by the AI layer", () => {
  maybe()("a non-media user gets nothing at all — requireMedia() is the outer gate", async () => {
    const outsider = await mkUser("outsider", "user", "branding", null);
    const ctx = await build(outsider);
    expect([...ctx.capabilities]).toEqual([]);
    expect(ctx.role).toBe("none");
    expect(ctx.projectScope).toBe("own");
  });

  maybe()("an unrestricted employee gets the baseline read set", async () => {
    const emp = await mkUser("emp", "user", "media", null);   // allowed_modules NULL = unrestricted
    const c = await caps(emp);
    expect(c).toContain("media.read");
    expect(c).toContain("myday.read");
    expect(c).toContain("projects.read");
    // team.read and reports.read are Team Lead / Admin only, per CAPS team.workload.
    expect(c).not.toContain("team.read");
    expect(c).not.toContain("reports.read");
    expect(c).not.toContain("automation.read");
    expect((await build(emp)).projectScope).toBe("own");
  });

  maybe()("a team lead additionally gets team and report visibility, and departmental scope", async () => {
    const tl = await mkUser("lead", "sub_admin", "media", null);
    const c = await caps(tl);
    expect(c).toContain("team.read");
    expect(c).toContain("reports.read");
    expect(c).not.toContain("automation.read");     // admin.audit is Admin only
    expect((await build(tl)).projectScope).toBe("all");
  });

  maybe()("an admin gets the widest set, including automation", async () => {
    const ad = await mkUser("admin", "admin", "media", null);
    const c = await caps(ad);
    expect(c).toEqual(expect.arrayContaining([
      "media.read", "myday.read", "projects.read", "events.read",
      "team.read", "reports.read", "equipment.read", "leave.read", "automation.read"]));
    expect((await build(ad)).projectScope).toBe("all");
  });

  maybe()("a super admin is treated as a media admin", async () => {
    const sa = await mkUser("super", "super_admin", null, null);
    expect(await caps(sa)).toContain("automation.read");
  });
});

describe("module access can only ever REMOVE a capability", () => {
  maybe()("revoking the projects module removes projects.read", async () => {
    const emp = await mkUser("nomod", "user", "media", ["home", "my-day", "leave"]);
    const c = await caps(emp);
    expect(c).toContain("myday.read");
    expect(c).not.toContain("projects.read");
    expect(c).not.toContain("equipment.read");
  });

  maybe()("revoking my-day removes myday.read but leaves the baseline", async () => {
    const emp = await mkUser("nomyday", "user", "media", ["home", "projects"]);
    const c = await caps(emp);
    expect(c).toContain("media.read");
    expect(c).toContain("projects.read");
    expect(c).not.toContain("myday.read");
  });

  maybe()("a module grant cannot ADD a role-gated capability", async () => {
    // An employee handed the 'team' module still must not get team.read: CAPS
    // gates team.workload on role, and buildAiUserContext honours both.
    const emp = await mkUser("teammod", "user", "media",
      ["home", "my-day", "projects", "team", "reports"]);
    const c = await caps(emp);
    expect(c).not.toContain("team.read");
    expect(c).not.toContain("reports.read");
    expect((await build(emp)).projectScope).toBe("own");
  });

  maybe()("an admin bypasses module restrictions, as allowsModule() specifies", async () => {
    const ad = await mkUser("adminmod", "admin", "media", ["home"]);
    expect(await caps(ad)).toContain("projects.read");
  });
});

describe("10. SMC members use the unified identity model", () => {
  maybe()("an SMC member gets only what their default modules imply", async () => {
    const smc = await mkUser("smc", "user", "smc", ["home", "my-day", "leave"]);
    await pool.query(
      `INSERT INTO mo_smc_profiles (user_id, is_active) VALUES ($1,true)
       ON CONFLICT (user_id) DO UPDATE SET is_active = true`, [smc.id]);
    const c = await caps(smc);
    expect(c).toContain("media.read");        // moRoleOf resolves them to employee
    expect(c).toContain("myday.read");
    expect(c).toContain("leave.read");
    expect(c).not.toContain("projects.read"); // no projects module → no overdue tool
    expect(c).not.toContain("smc.read");      // being a member is not managing SMC
    expect((await build(smc)).projectScope).toBe("own");
  });

  maybe()("smc.read comes from the smc_manager DUTY, not from being an SMC member", async () => {
    const mgr = await mkUser("smcmgr", "user", "media", null);
    expect(await caps(mgr)).not.toContain("smc.read");
    await pool.query(
      `INSERT INTO mo_user_duties (user_id, duty_flag_id)
       SELECT $1, id FROM mo_duty_flags WHERE code='smc_manager'
       ON CONFLICT DO NOTHING`, [mgr.id]);
    expect(await caps(mgr)).toContain("smc.read");
  });
});

describe("the context carries nothing sensitive", () => {
  maybe()("exposes only id, role, capabilities and scope", async () => {
    const emp = await mkUser("shape", "user", "media", null);
    const ctx = await build(emp);
    expect(Object.keys(ctx).sort()).toEqual(["capabilities", "id", "projectScope", "role"]);
    const json = JSON.stringify({ ...ctx, capabilities: [...ctx.capabilities] });
    for (const banned of ["password", "email", "phone", "hash", "token", "secret"])
      expect(json.toLowerCase()).not.toContain(banned);
  });
});
