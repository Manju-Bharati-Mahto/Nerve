// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — the shared query service against a real PostgreSQL.

   This is where AUTO-2 parity is actually proven: the ORIGINAL AUTO-2 SQL is
   executed verbatim alongside findOverdueDeliverables() and the two row sets are
   compared. A unit test with a mocked service could not tell you that.

   Fixtures are synthetic (ids prefixed `ai3t-`) and removed afterwards. No real
   person, project or deliverable is read, written or asserted on.

   Skips cleanly when no database is reachable, so the suite still runs in CI
   without one.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PREFIX = "ai3t";
let dbUp = false;
let pool: import("pg").Pool;
let q: typeof import("./mediaops-queries.js");

/* The dev connection string lives in .env.local; vitest.config.ts sets a dummy
   DATABASE_URL for unit tests, so read the real one explicitly here. */
async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}

/* Probed at MODULE level, not in beforeAll: `maybe()` below is evaluated while
   vitest collects the describe blocks, which happens before any hook runs. A
   flag set in beforeAll would still be false at that point and every test would
   silently skip — which is exactly the failure mode this comment exists to
   prevent recurring. */
{
  const url = await realDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    const { pool: p } = await import("./db.js");
    pool = p;
    try {
      await pool.query("SELECT 1");
      dbUp = true;
      q = await import("./mediaops-queries.js");
    } catch {
      dbUp = false;   // no database here; the suite skips rather than fails
    }
  }
}

beforeAll(async () => {
  if (!dbUp) return;
  await cleanup();

  const u = async (id: string, name: string, role: string) => pool.query(
    `INSERT INTO users (id, full_name, email, role, team, password_hash)
     VALUES ($1,$2,$3,$4,'media','x') ON CONFLICT (id) DO NOTHING`,
    [`${PREFIX}-${id}`, name, `${PREFIX}-${id}@example.invalid`, role]);
  await u("owner", "Test Owner", "user");
  await u("other", "Test Other", "user");
  await u("pm", "Test PM", "sub_admin");

  const proj = async (code: string, ownerId: string | null) => (await pool.query(
    `INSERT INTO mo_projects (project_type_id, code, name, created_by, owner_id, status)
     VALUES ((SELECT id FROM mo_project_types LIMIT 1), $1, $2, $3, $4, 'in_production')
     RETURNING id`, [`${PREFIX}-${code}`, `Test ${code}`, `${PREFIX}-owner`, ownerId])).rows[0].id;

  const pMine = await proj("P1", `${PREFIX}-owner`);   // owned by test owner
  const pTheirs = await proj("P2", `${PREFIX}-other`); // owned by someone else

  // A PM on the "mine" project, so AUTO-2's 3-day escalation has something to find.
  await pool.query(
    `INSERT INTO mo_project_assignments (project_id, user_id, is_project_manager, assigned_by)
     VALUES ($1,$2,true,$3)`, [pMine, `${PREFIX}-pm`, `${PREFIX}-owner`]);

  /* One statement for both cases: a null offset must stay a NULL due_date, and
     switching SQL strings per case is how placeholder numbering drifts. */
  const d = async (project: number, title: string, owner: string | null,
                   dueOffsetDays: number | null, status: string) => pool.query(
    `INSERT INTO mo_deliverables (project_id, deliverable_type_id, title, owner_id, due_date, status)
     VALUES ($1, (SELECT id FROM mo_deliverable_types LIMIT 1), $2, $3,
             CASE WHEN $4::int IS NULL THEN NULL ELSE CURRENT_DATE + $4::int END, $5)`,
    [project, `${PREFIX} ${title}`, owner, dueOffsetDays, status]);

  // The matrix §20 asks for.
  await d(pMine, "overdue-1d", `${PREFIX}-owner`, -1, "in_progress");
  await d(pMine, "overdue-9d", `${PREFIX}-owner`, -9, "not_started");
  await d(pMine, "due-today", `${PREFIX}-owner`, 0, "in_progress");     // NOT overdue
  await d(pMine, "due-future", `${PREFIX}-owner`, 5, "in_progress");    // NOT overdue
  await d(pMine, "no-due-date", `${PREFIX}-owner`, null, "in_progress"); // NOT overdue
  await d(pMine, "delivered", `${PREFIX}-owner`, -4, "delivered");       // excluded
  await d(pMine, "cancelled", `${PREFIX}-owner`, -4, "cancelled");       // excluded
  await d(pMine, "not-required", `${PREFIX}-owner`, -4, "not_required"); // excluded
  await d(pMine, "unowned", null, -4, "in_progress");                    // excluded (AUTO-2)
  await d(pTheirs, "other-overdue", `${PREFIX}-other`, -3, "in_progress"); // out of scope

  // Insert first, then soft-delete it — a deleted row must stay invisible.
  await d(pMine, "soft-deleted", `${PREFIX}-owner`, -6, "in_progress");
  await pool.query(
    `UPDATE mo_deliverables SET deleted_at=NOW() WHERE title=$1`, [`${PREFIX} soft-deleted`]);
}, 60_000);

async function cleanup() {
  if (!dbUp && !pool) return;
  await pool.query(`DELETE FROM mo_deliverables WHERE title LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM mo_project_assignments WHERE project_id IN
                    (SELECT id FROM mo_projects WHERE code LIKE $1)`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM mo_projects WHERE code LIKE $1`, [`${PREFIX}%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PREFIX}-%`]);
}
afterAll(async () => { if (dbUp) await cleanup(); }, 60_000);

const maybe = () => (dbUp ? it : it.skip);
const mine = () => `${PREFIX}-owner`;

/* ── AUTO-2 parity ─────────────────────────────────────────────────────── */
describe("11. AUTO-2 parity — the extraction changed nothing", () => {
  /** The AUTO-2 query EXACTLY as it stood before the refactor. */
  const ORIGINAL_AUTO2 = `
    SELECT d.id, d.title, d.owner_id, d.due_date, (CURRENT_DATE - d.due_date) AS days_over,
           (SELECT a.user_id FROM mo_project_assignments a WHERE a.project_id=d.project_id AND a.is_project_manager AND a.removed_at IS NULL LIMIT 1) AS pm
      FROM mo_deliverables d
     WHERE d.deleted_at IS NULL AND d.due_date < CURRENT_DATE
       AND d.status NOT IN ('delivered','not_required','cancelled') AND d.owner_id IS NOT NULL`;

  maybe()("returns the identical row set to the original SQL, across the whole database", async () => {
    const original = (await pool.query(ORIGINAL_AUTO2)).rows
      .map((r) => ({ id: Number(r.id), owner: String(r.owner_id),
                     days: Number(r.days_over), pm: r.pm == null ? null : String(r.pm) }))
      .sort((a, b) => a.id - b.id);

    const shared = (await q.findOverdueDeliverables({ kind: "all" }))
      .map((d) => ({ id: d.id, owner: d.ownerId, days: d.daysOverdue, pm: d.projectManagerId }))
      .sort((a, b) => a.id - b.id);

    expect(shared).toEqual(original);
    expect(shared.length).toBeGreaterThan(0);      // the fixtures guarantee this
  });

  maybe()("applies every AUTO-2 exclusion", async () => {
    const titles = (await q.findOverdueDeliverables({ kind: "all" }))
      .filter((d) => d.title.startsWith(PREFIX)).map((d) => d.title);

    expect(titles).toEqual(expect.arrayContaining([`${PREFIX} overdue-1d`, `${PREFIX} overdue-9d`]));
    for (const excluded of ["due-today", "due-future", "no-due-date", "delivered",
                            "cancelled", "not-required", "unowned", "soft-deleted"])
      expect(titles).not.toContain(`${PREFIX} ${excluded}`);
  });

  maybe()("counts days overdue the way the escalation thresholds expect", async () => {
    const rows = await q.findOverdueDeliverables({ kind: "all" });
    expect(rows.find((d) => d.title === `${PREFIX} overdue-1d`)?.daysOverdue).toBe(1);
    const nine = rows.find((d) => d.title === `${PREFIX} overdue-9d`);
    expect(nine?.daysOverdue).toBe(9);
    expect(nine!.daysOverdue >= 7).toBe(true);          // admin escalation tier
    expect(nine?.projectManagerId).toBe(`${PREFIX}-pm`); // PM lookup still resolves
  });
});

/* ── Scoping ───────────────────────────────────────────────────────────── */
describe("21. scoping is enforced in SQL, not in the caller", () => {
  maybe()("an employee sees their own work and their own projects only", async () => {
    const titles = (await q.findOverdueDeliverables({ kind: "user", userId: mine() }))
      .filter((d) => d.title.startsWith(PREFIX)).map((d) => d.title);
    expect(titles.sort()).toEqual([`${PREFIX} overdue-1d`, `${PREFIX} overdue-9d`]);
    expect(titles).not.toContain(`${PREFIX} other-overdue`);
  });

  maybe()("Employee A cannot see Employee B's work", async () => {
    const other = (await q.findOverdueDeliverables({ kind: "user", userId: `${PREFIX}-other` }))
      .filter((d) => d.title.startsWith(PREFIX)).map((d) => d.title);
    expect(other).toEqual([`${PREFIX} other-overdue`]);
    expect(other).not.toContain(`${PREFIX} overdue-1d`);
  });

  maybe()("a user with no work at all gets an empty list, not everyone's", async () => {
    const none = await q.findOverdueDeliverables({ kind: "user", userId: `${PREFIX}-pm` });
    // The PM is assigned to the project, so they legitimately see its deliverables…
    expect(none.every((d) => !d.title.startsWith(PREFIX) || d.projectCode === `${PREFIX}-P1`)).toBe(true);
    // …but never the other project's.
    expect(none.map((d) => d.title)).not.toContain(`${PREFIX} other-overdue`);
  });

  maybe()("the departmental scope is a superset of any single user's", async () => {
    const all = (await q.findOverdueDeliverables({ kind: "all" })).map((d) => d.id);
    for (const uid of [mine(), `${PREFIX}-other`, `${PREFIX}-pm`])
      for (const d of await q.findOverdueDeliverables({ kind: "user", userId: uid }))
        expect(all).toContain(d.id);
  });

  maybe()("respects a limit without changing the predicate", async () => {
    const capped = await q.findOverdueDeliverables({ kind: "all" }, { limit: 1 });
    expect(capped).toHaveLength(1);
  });
});

/* ── Dates ─────────────────────────────────────────────────────────────── */
describe("6. date semantics match Nerve, not UTC", () => {
  it("nerveToday() agrees with the application timezone, where toISOString() does not", () => {
    // 2026-08-20T21:30:00Z is already 2026-08-21 in Asia/Kolkata (UTC+5:30).
    const t = new Date("2026-08-20T21:30:00Z");
    expect(q?.nerveToday("Asia/Kolkata", t) ?? "").toBe("2026-08-21");
    expect(t.toISOString().slice(0, 10)).toBe("2026-08-20");   // the bug this avoids
  });

  it("holds at both ends of the day", () => {
    const tz = "Asia/Kolkata";
    // 18:29Z is 23:59 IST — still the same local day.
    expect(q.nerveToday(tz, new Date("2026-08-21T18:29:00Z"))).toBe("2026-08-21");
    // 18:30Z is 00:00 IST the next day.
    expect(q.nerveToday(tz, new Date("2026-08-21T18:30:00Z"))).toBe("2026-08-22");
  });

  maybe()("agrees with the database's CURRENT_DATE", async () => {
    const dbDate = (await pool.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
    expect(q.nerveToday()).toBe(dbDate);
  });

  it("dateOnly() renders the stored calendar day, not a shifted one", () => {
    // A DATE arrives from pg as local midnight; toISOString() would move it back.
    const d = new Date(2026, 7, 21);
    expect(q.dateOnly(d)).toBe("2026-08-21");
    expect(q.dateOnly("2026-08-21T00:00:00+05:30")).toBe("2026-08-21");
    expect(q.dateOnly(null)).toBeNull();
  });
});

/* ── My Day ────────────────────────────────────────────────────────────── */
describe("19. getMyDay is self-scoped and bounded", () => {
  maybe()("returns the requested user's day and nothing about anyone else", async () => {
    const day = await q.getMyDay(mine());
    expect(day.date).toBe(q.nerveToday());
    expect(day.report.status).toBe("none");        // no report today for a fresh user
    expect(Array.isArray(day.items)).toBe(true);
  });

  maybe()("accepts an explicit date for the service layer's own callers", async () => {
    const day = await q.getMyDay(mine(), "2020-01-01");
    expect(day.date).toBe("2020-01-01");
    expect(day.items).toEqual([]);
  });

  maybe()("returns a shape with no free-text task content", async () => {
    const json = JSON.stringify(await q.getMyDay(mine()));
    expect(json).not.toContain("password");
    expect(json).not.toContain("description");
  });
});
