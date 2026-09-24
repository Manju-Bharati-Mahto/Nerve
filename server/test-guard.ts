/* ═══════════════════════════════════════════════════════════════════════════
   A GLOBAL SETUP GUARD — runs before every test file, in every worker.

   server/test-db.ts protects the suites that call it. This protects the ones
   that do not: a new test file that reaches for `./db.js` directly, or an old
   one somebody edits back to reading .env.local. The check is cheap and it
   runs everywhere, so the safe path stays the default rather than something
   each author has to remember.

   It asserts one thing: while tests are running, DATABASE_URL must not name a
   database that fails the test-name rule. It does not rewrite the value —
   a wrong target stops the run with an explanation, because a guard that
   silently corrects is a guard nobody notices is broken.
   ═══════════════════════════════════════════════════════════════════════════ */
import { beforeAll } from "vitest";
import { databaseNameOf, isTestDatabaseName, redact, resolveTestDatabaseUrl } from "./test-db.js";

/* Resolve once, at setup, so a misconfigured environment fails on the first
   file rather than on whichever one happens to touch the database first. */
beforeAll(() => {
  const current = process.env.DATABASE_URL;
  if (!current) return;                 // pure unit files need no database

  const name = databaseNameOf(current);
  if (isTestDatabaseName(name)) return; // already pointing somewhere safe

  /* Something has put a non-test database on DATABASE_URL. Ask test-db.ts what
     it SHOULD be, so the message can name the right answer, then stop. */
  let expected = "(no test database configured)";
  try { expected = redact(resolveTestDatabaseUrl()); } catch { /* keep the placeholder */ }

  throw new Error(
    "\n" +
    "═══ TESTS REFUSED ════════════════════════════════════════════════════\n" +
    `  DATABASE_URL points at "${name || "(unparseable)"}", which is not a test database.\n` +
    `    current:  ${redact(current)}\n` +
    `    expected: ${expected}\n` +
    "\n" +
    "  Tests must never run against a development or production database.\n" +
    "  Run `npm run test:db:setup` to create one, or set TEST_DATABASE_URL.\n" +
    "══════════════════════════════════════════════════════════════════════\n");
});
