#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   MIGRATION ORDER AUDIT

   WHY THIS EXISTS. Every migration in this repository is written to be safe to
   run twice — `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`,
   `CREATE INDEX IF NOT EXISTS`. That makes a statement safe to REPEAT. It does
   not make it safe to run EARLY, and the difference is invisible on any
   database that already has the schema.

   Phase 17N added five reporting indexes and put them where the phase happened
   to be editing — several hundred lines above the tables they index. Every
   developer database and the test database already had those tables, so
   `CREATE INDEX IF NOT EXISTS` found them and nothing ever complained. A
   database being created for the FIRST time did not:

       error: relation "mo_equipment_transactions" does not exist

   and bootstrapMediaOpsDatabase() stopped there — a first deployment that
   cannot start. Two more of the same shape were found behind it, one of them
   predating 17N by several phases:

       error: relation "mo_maintenance_records" does not exist
       error: column "scope_id" does not exist

   The test suite could not catch any of them: its database is created once and
   kept, so it is never fresh.

   WHAT IT CHECKS. For every `CREATE INDEX ... ON mo_x (cols)` in the migration
   file, that mo_x's `CREATE TABLE` appears earlier, and that every column named
   in the index is available by then — either declared in that CREATE TABLE or
   added by an earlier `ALTER TABLE ... ADD COLUMN`.

   It is deliberately conservative: it only reports a column when it can see
   where that column is introduced, so a name it cannot resolve is silence
   rather than a false alarm. Anything it does report is an ordering fault.

   Exit 1 on a finding. Run it with `npm run audit:migration-order`.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from "node:fs";

/* Overridable so the guard itself can be tested against a deliberately broken
   copy without touching the real migration file. */
const FILES = process.argv.slice(2).length ? process.argv.slice(2) : ["server/mediaops-db.ts"];

/* SQL keywords and expression fragments that appear inside an index definition
   and are not column names. Matching one would be a false positive. */
const NOT_A_COLUMN = new Set([
  "desc", "asc", "nulls", "first", "last", "where", "and", "or", "not", "null",
  "is", "using", "gist", "btree", "gin", "hash", "text", "date", "int", "true",
  "false", "lower", "upper", "coalesce", "nullif", "timezone", "asia",
  "kolkata", "interval", "cast", "with", "tsvector", "to_tsvector", "english",
  "daterange", "varchar_pattern_ops", "text_pattern_ops",
]);

/** Blank out block comments, keeping every line number intact. */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) || []).length));

const lineOf = (src, index) => src.slice(0, index).split("\n").length;

let findings = 0;

for (const file of FILES) {
  const src = stripComments(readFileSync(file, "utf8"));

  /* Where each table, and each of its columns, first exists. */
  const at = new Map();                       // "table" | "table.column" -> line
  const remember = (key, line) => { if (!at.has(key)) at.set(key, line); };

  for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS (mo_[a-z0-9_]+)\s*\(([\s\S]*?)\n\s*\)/g)) {
    const [, table, body] = m;
    const line = lineOf(src, m.index);
    remember(table, line);
    /* A column declaration opens a line, or follows a comma on one. */
    for (const c of body.matchAll(/(?:^|,)\s*([a-z][a-z0-9_]*)\s+(?=[A-Z])/gm))
      remember(`${table}.${c[1]}`, line);
  }
  for (const m of src.matchAll(/ALTER TABLE (mo_[a-z0-9_]+)\s+ADD COLUMN IF NOT EXISTS\s+([a-z0-9_]+)/g))
    remember(`${m[1]}.${m[2]}`, lineOf(src, m.index));

  for (const m of src.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+([a-z0-9_]+)\s+ON\s+(mo_[a-z0-9_]+)\s*(?=[(U])/g)) {
    const [, index, table] = m;
    const line = lineOf(src, m.index);
    const tableLine = at.get(table);
    if (tableLine === undefined) {
      console.log(`  ${file}:${line}  ${index} indexes ${table}, which this file never creates`);
      findings++; continue;
    }
    if (line < tableLine) {
      console.log(`  ${file}:${line}  ${index} is created before ${table} exists (line ${tableLine})`);
      findings++; continue;
    }
    /* The columns named between the first '(' and its matching close. */
    const rest = src.slice(m.index + m[0].length);
    const defn = rest.slice(0, rest.indexOf(")"));
    for (const c of new Set(defn.match(/\b[a-z][a-z0-9_]{2,}\b/g) || [])) {
      if (NOT_A_COLUMN.has(c)) continue;
      const colLine = at.get(`${table}.${c}`);
      if (colLine !== undefined && line < colLine) {
        console.log(`  ${file}:${line}  ${index} uses ${table}.${c}, which is added later (line ${colLine})`);
        findings++;
      }
    }
  }
}

console.log(findings
  ? `${findings} ordering fault(s) — a fresh database cannot be built.`
  : "migration order clean — every index follows the table and columns it needs.");
process.exit(findings ? 1 : 0);
