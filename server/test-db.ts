/* ═══════════════════════════════════════════════════════════════════════════
   TEST DATABASE RESOLUTION — the one place a test decides what it connects to.

   WHAT WENT WRONG. vitest.config.ts set DATABASE_URL to nerve_test, correctly.
   Every integration file then opened .env.local itself, read the DEVELOPMENT
   url out of it, and assigned it over the top:

       for (const f of [".env.local", ".env"]) { … }
       process.env.DATABASE_URL = url;          // ← now pointing at `nerve`

   Eighteen files carried a byte-identical copy of that. The suite therefore ran
   against the developer's own database: it read their data, wrote fixtures into
   it, and — through one unscoped UPDATE in the creator points suite — closed a
   cycle belonging to their demo seed. The configured test database did not even
   exist.

   WHAT THIS MODULE DOES. It resolves the test url from sources that are ABOUT
   testing, asserts out loud that the result is a test database, and refuses to
   run otherwise. It never rewrites a url it does not recognise: a wrong
   DATABASE_URL is a stop, not something to quietly correct, because silently
   redirecting is how you end up trusting a guard that was never tested.

   Nothing here runs in production. It is imported only by test files.
   ═══════════════════════════════════════════════════════════════════════════ */
import { existsSync, readFileSync } from "node:fs";
import type { Pool } from "pg";

/** Pull DATABASE_URL out of a dotenv-style file, if it has one. */
function urlFromFile(file: string): string | null {
  if (!existsSync(file)) return null;
  const m = readFileSync(file, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
}

/** The database name in a postgres url, or "" when it cannot be parsed. */
export function databaseNameOf(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return "";
  }
}

/** A url with its credentials removed, safe to put in an error message. */
export function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//<redacted>@");
}

/**
 * Is this name one we are willing to let a test suite write to?
 *
 * Deliberately a NAME rule rather than a list of forbidden names. An allow-list
 * fails closed: a database nobody anticipated is refused, where a deny-list
 * would wave it through. `nerve` is not a test database, and neither is
 * `nerve_prod`, `nerve_staging` or anything else that does not say so.
 */
export function isTestDatabaseName(name: string): boolean {
  return /(^test$|^test_|_test$|_test_)/.test(name);
}

/** The databases a developer runs day to day, read so we can refuse them. */
function developerDatabaseUrls(): string[] {
  return [".env.local", ".env"]
    .map(urlFromFile)
    .filter((u): u is string => !!u);
}

export class TestDatabaseSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestDatabaseSafetyError";
  }
}

/**
 * Resolve the url the test suite should use, and prove it is a test database.
 * Throws — loudly, with instructions — rather than connecting to anything else.
 *
 * Order, most explicit first:
 *   1. TEST_DATABASE_URL          — what CI sets, and the intended override
 *   2. .env.test.local / .env.test — a developer's local test database
 *   3. DATABASE_URL                — injected by vitest.config.ts
 *
 * Note what is NOT in that list: .env.local. A test never reads the file that
 * configures development. That single omission is the fix.
 */
export function resolveTestDatabaseUrl(): string {
  const candidates: [string, string | null][] = [
    ["TEST_DATABASE_URL", process.env.TEST_DATABASE_URL ?? null],
    [".env.test.local", urlFromFile(".env.test.local")],
    [".env.test", urlFromFile(".env.test")],
    ["DATABASE_URL (vitest.config.ts)", process.env.DATABASE_URL ?? null],
  ];
  const picked = candidates.find(([, v]) => !!v);

  if (!picked || !picked[1])
    throw new TestDatabaseSafetyError(
      "No test database configured.\n" +
      "  Set TEST_DATABASE_URL, or create .env.test with a DATABASE_URL line.\n" +
      "  `npm run test:db:setup` creates the database and writes .env.test for you.");

  const [source, url] = picked as [string, string];
  const name = databaseNameOf(url);

  if (!isTestDatabaseName(name))
    throw new TestDatabaseSafetyError(
      `Refusing to run tests against the database "${name || "(unparseable)"}".\n` +
      `  Resolved from: ${source}\n` +
      `  URL:           ${redact(url)}\n` +
      "  A test database's name must contain \"test\" (e.g. nerve_test).\n" +
      "  This is an allow-list on purpose: an unrecognised database is refused,\n" +
      "  never silently redirected.\n" +
      "  Run `npm run test:db:setup` to create one.");

  /* Belt and braces. A developer could name their working database
     `nerve_test` and point .env.local at it; the name rule would pass and we
     would still be writing to the database they use every day. */
  for (const dev of developerDatabaseUrls())
    if (dev === url)
      throw new TestDatabaseSafetyError(
        "Refusing to run tests against the DEVELOPMENT database.\n" +
        `  The resolved test URL is identical to the one in .env.local / .env:\n` +
        `    ${redact(url)}\n` +
        "  Point TEST_DATABASE_URL or .env.test at a separate database.");

  return url;
}

export interface TestDatabase {
  /** The pg pool, already proven to answer. Null when no server is reachable. */
  pool: Pool;
  /** False when Postgres is not running — suites skip rather than fail. */
  dbUp: boolean;
  /** The database actually connected to, for assertions and messages. */
  name: string;
}

/**
 * Point the process at the test database and open a pool.
 *
 * Every integration suite calls this instead of reading .env.local. An
 * unreachable server is not an error — `dbUp` is false and the suite skips,
 * which is how these files have always behaved on a machine with no Postgres.
 * A MISCONFIGURED url, by contrast, always throws: that is the case worth
 * being noisy about.
 */
export async function connectTestDatabase(): Promise<TestDatabase> {
  const url = resolveTestDatabaseUrl();          // throws if it is not a test DB
  process.env.DATABASE_URL = url;
  process.env.SESSION_SECRET ||= "integration-test-secret";
  process.env.SUPER_ADMIN_PASSWORD ||= "integration-test-password";

  const { pool } = await import("./db.js");
  let dbUp = false;
  let name = databaseNameOf(url);
  try {
    const r = await pool.query("SELECT current_database() AS db");
    name = String(r.rows[0].db);
    dbUp = true;
  } catch {
    dbUp = false;
  }

  /* The name in the URL and the name Postgres reports should agree. If they do
     not, something between here and the server rewrote the target, and that is
     exactly the situation this module exists to catch. */
  if (dbUp && !isTestDatabaseName(name))
    throw new TestDatabaseSafetyError(
      `Connected to "${name}", which is not a test database.\n` +
      `  The URL asked for ${redact(url)}.\n` +
      "  Something is rewriting the connection target; stopping before any write.");

  return { pool, dbUp, name };
}


/* ═══════════════════════════════════════════════════════════════════════════
   SERIALISING A GENUINELY GLOBAL OPERATION.

   Almost everything these suites do is scoped by a fixture prefix, and that is
   what lets ~20 files share one database. A few operations cannot be scoped,
   because the PRODUCT does not scope them:

     runCreatorNetworkAutomations() walks every active creator profile in the
     database and writes notifications to the ones it finds. Run from one
     suite, it appends rows to another suite's fixtures — so a file asserting
     "reading a leaderboard notifies nobody" watched its own notification count
     move under it, from a pass another file was running at that moment.

   Scoping cannot fix that: the count genuinely changed, and the automation was
   right to change it. The only correct answer is that the global pass and the
   assertions about its effects must not overlap, which is what this lock is
   for. It is a Postgres ADVISORY lock, so it serialises across worker
   PROCESSES, which a JavaScript mutex could not.

   Use it sparingly, and only for an operation whose blast radius is the whole
   table. Everything else should be scoped by prefix instead.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Keys are arbitrary and constant; one per genuinely global resource. */
export const GLOBAL_LOCK = {
  /** Any pass that notifies every creator in the database. */
  creatorAutomations: 0x43524e31,        // 'CRN1'
  /** mo_module_defaults — one row per group, shared by every suite. A file
      that toggles a row and a file that asserts over the whole table are both
      legitimate and cannot overlap. */
  moduleDefaults: 0x4d4f4431,            // 'MOD1'
} as const;

/**
 * Run `fn` holding an exclusive advisory lock, on a connection of its own so
 * the lock survives whatever `fn` does with the pool. Always released.
 */
export async function withGlobalLock<T>(
  pool: Pool, key: number, fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`SELECT pg_advisory_lock($1)`, [key]);
    return await fn();
  } finally {
    await client.query(`SELECT pg_advisory_unlock($1)`, [key]).catch(() => {});
    client.release();
  }
}
