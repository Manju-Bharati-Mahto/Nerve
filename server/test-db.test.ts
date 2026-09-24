// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   UNIT — the test-database safety rules.

   The mechanism that stops the suite writing to a developer's database should
   itself be tested, or the first anybody knows about a hole in it is a lost
   afternoon of data. These are the rules from server/test-db.ts, exercised
   directly.

   The real proof that it works end to end is that pointing TEST_DATABASE_URL
   or .env.test at `nerve` aborts the run before a single test executes; what
   is pinned here is the decision logic that produces that refusal.
   ═══════════════════════════════════════════════════════════════════════════ */
import { describe, it, expect, afterEach } from "vitest";
import {
  databaseNameOf, isTestDatabaseName, redact, resolveTestDatabaseUrl,
  TestDatabaseSafetyError,
} from "./test-db.js";

const saved = process.env.TEST_DATABASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = saved;
});

describe("what counts as a test database", () => {
  it("accepts names that say so", () => {
    for (const n of ["nerve_test", "test", "test_nerve", "nerve_test_ci", "app_test"])
      expect(isTestDatabaseName(n), n).toBe(true);
  });

  /* An ALLOW-list, not a deny-list: the database this project actually uses in
     development must be refused, and so must any name nobody thought of. */
  it("refuses everything else, including names nobody anticipated", () => {
    for (const n of ["nerve", "nerve_prod", "nerve_staging", "postgres", "protest", "latest", ""])
      expect(isTestDatabaseName(n), n).toBe(false);
  });

  it("reads the database name out of a url", () => {
    expect(databaseNameOf("postgres://u:p@127.0.0.1:5432/nerve_test")).toBe("nerve_test");
    expect(databaseNameOf("postgres://u:p@host:5432/nerve?sslmode=require")).toBe("nerve");
    expect(databaseNameOf("not a url")).toBe("");
  });

  it("removes credentials before a url goes into an error message", () => {
    expect(redact("postgres://user:hunter2@127.0.0.1:5432/nerve_test"))
      .toBe("postgres://<redacted>@127.0.0.1:5432/nerve_test");
    expect(redact("postgres://user:hunter2@127.0.0.1:5432/nerve_test")).not.toContain("hunter2");
  });
});

describe("resolving the url the suite will use", () => {
  it("takes TEST_DATABASE_URL first when it names a test database", () => {
    process.env.TEST_DATABASE_URL = "postgres://u:p@127.0.0.1:5432/other_test";
    expect(resolveTestDatabaseUrl()).toBe("postgres://u:p@127.0.0.1:5432/other_test");
  });

  /* The whole point. This is the url that was being used for every run. */
  it("REFUSES a development database rather than silently redirecting it", () => {
    process.env.TEST_DATABASE_URL = "postgres://nerve_app:p@127.0.0.1:5432/nerve";
    expect(() => resolveTestDatabaseUrl()).toThrow(TestDatabaseSafetyError);
    expect(() => resolveTestDatabaseUrl()).toThrow(/not a test database|Refusing/i);
  });

  it("names the source and the offending database, so the fix is obvious", () => {
    process.env.TEST_DATABASE_URL = "postgres://u:p@127.0.0.1:5432/nerve";
    try {
      resolveTestDatabaseUrl();
      throw new Error("should have refused");
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain("nerve");
      expect(m).toContain("TEST_DATABASE_URL");
      expect(m).toContain("test:db:setup");
      expect(m).not.toContain(":p@");            // credentials never leak
    }
  });

  it("falls through to the url vitest injected, which is already a test one", () => {
    delete process.env.TEST_DATABASE_URL;
    const url = resolveTestDatabaseUrl();
    expect(isTestDatabaseName(databaseNameOf(url))).toBe(true);
  });
});
