/* ═══════════════════════════════════════════════════════════════════════════
   Apply the schema bootstrap to the TEST database.

   The same bootstrap functions the server runs at startup (server/index.ts),
   in the same order, against the test database instead of the development one.
   There is no separate test schema and no hand-maintained SQL dump to drift —
   the test database is built by the code that builds every other one.

   Refuses to run against anything that is not a test database, using the same
   allow-list the suites themselves use.
   ═══════════════════════════════════════════════════════════════════════════ */
import { isTestDatabaseName, resolveTestDatabaseUrl } from "../server/test-db.js";

/* Resolved by the same function the suites use — TEST_DATABASE_URL, then
   .env.test — so running this by hand and running it from test-db-setup.sh
   target the same database, and both refuse anything that is not a test one. */
let url: string;
try {
  url = resolveTestDatabaseUrl();
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}

process.env.DATABASE_URL = url;
process.env.SESSION_SECRET ||= "integration-test-secret";
process.env.SUPER_ADMIN_PASSWORD ||= "integration-test-password";

const { pool } = await import("../server/db.js");

// Prove, from the server's own answer, where we are about to write.
const actual = String((await pool.query("SELECT current_database() AS db")).rows[0].db);
if (!isTestDatabaseName(actual)) {
  console.error(`✗ Connected to "${actual}", which is not a test database. Stopping.`);
  process.exit(1);
}
console.log(`→ migrating ${actual}`);

const { bootstrapDatabase } = await import("../server/db.js");
const { bootstrapBrandingDatabase } = await import("../server/branding-db.js");
const { bootstrapSettingsDatabase } = await import("../server/settings-db.js");
const { bootstrapOutreach } = await import("../server/outreach-db.js");
const designDb = await import("../server/design-db.js");
const { bootstrapMediaOpsDatabase } = await import("../server/mediaops-db.js");

/* Same order as server/index.ts. A failure in one of the peripheral modules
   should not stop the Media Ops schema being created, because that is the one
   the integration suites need — so each step reports rather than aborting, and
   the exit code reflects whether Media Ops made it. */
const step = async (label: string, fn: () => Promise<unknown>, required = false) => {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    return true;
  } catch (e) {
    console.error(`  ${required ? "✗" : "!"} ${label}: ${(e as Error).message}`);
    if (required) process.exitCode = 1;
    return false;
  }
};

await step("core schema", bootstrapDatabase, true);
await step("branding", bootstrapBrandingDatabase);
await step("settings", bootstrapSettingsDatabase);
await step("outreach", bootstrapOutreach);
await step("design", designDb.bootstrapDesignDatabase);
await step("media ops (+ creator network, asset foundation)", bootstrapMediaOpsDatabase, true);

const tables = Number((await pool.query(
  `SELECT count(*)::int c FROM information_schema.tables WHERE table_schema='public'`)).rows[0].c);
console.log(`→ ${actual} now has ${tables} tables.`);
await pool.end();
