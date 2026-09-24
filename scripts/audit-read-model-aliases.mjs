#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   READ-MODEL ALIAS AUDIT

   WHY THIS EXISTS. node-postgres builds each result row by assigning result
   columns to object keys IN ORDER. Two result columns with the same output name
   therefore collapse into one key and the LAST one wins — silently, with no
   error from Postgres, which is perfectly happy to return two columns called
   `tracking_mode`.

   That is not hypothetical. ASSET_SELECT carried

       COALESCE(i.tracking_mode, c.tracking_mode) AS tracking_mode,
       ...
       c.name AS category_name, c.tracking_mode,          <-- wins

   for four phases. Every read discarded the item-level override, so a pooled
   item in a serialized category reported itself as serialized. No test caught
   it because the tests that exercised pooling used a pooled category, where
   both answers agree.

   WHAT IT CHECKS.
     1. Explicit duplicate output names within one SELECT's projection.  This
        needs no database and has no known false positives on this repository;
        a finding here fails the run.
     2. `alias.*` beside explicit columns.  Resolved against the live schema
        when a database is reachable, and reported as ADVISORY otherwise — a
        star projection is only a defect if the starred table actually has a
        column of the same name as a later alias.

   WHAT IT DELIBERATELY DOES NOT DO. It does not rewrite SQL, and it does not
   flag repeated SOURCE columns — `a.id` and `b.id` are fine as long as their
   OUTPUT names differ. Only the output name matters.

   Usage:  node scripts/audit-read-model-aliases.mjs [files…]
           npm run audit:read-models
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, existsSync } from "node:fs";

const DEFAULT_FILES = ["server/mediaops-api.ts", "server/mediaops-db.ts",
                       "server/mediaops-tv.ts", "server/creator-automations.ts"];
const files = (process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES)
  .filter((f) => existsSync(f));

/* ── The live schema, when there is one. Star projections cannot be judged
      without knowing what columns the starred table actually has. ───────── */
async function loadSchema() {
  const env = [".env.test", ".env.local"].find((f) => existsSync(f));
  if (!env) return null;
  const m = readFileSync(env, "utf8").match(/^\s*DATABASE_URL\s*=\s*(.+)$/m);
  if (!m) return null;
  try {
    const pg = (await import("pg")).default;
    const pool = new pg.Pool({ connectionString: m[1].trim().replace(/^["']|["']$/g, "") });
    const cols = new Map();
    for (const r of (await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema='public'`)).rows) {
      if (!cols.has(r.table_name)) cols.set(r.table_name, new Set());
      cols.get(r.table_name).add(r.column_name);
    }
    await pool.end();
    return cols;
  } catch { return null; }
}

/** Comments carry prose commas that would otherwise split like projection items. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

/** Split on commas at paren-depth 0, so COALESCE(a, b) stays one item. */
function topLevelSplit(s) {
  const out = []; let depth = 0, buf = "";
  for (const ch of s) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

/** The key node-postgres will use, or a star marker. */
function outputName(item) {
  const t = item.trim();
  if (!t) return null;
  if (/\*\s*$/.test(t)) return { star: true, text: t, alias: (t.match(/([A-Za-z_]\w*)\s*\.\s*\*$/) || [])[1] };
  const as = t.match(/\bAS\s+("?)([A-Za-z_]\w*)\1\s*$/i);
  if (as) return { name: as[2].toLowerCase(), text: t };
  /* A bare column reference keeps its own name; an unaliased expression gets
     a name Postgres chooses, which no reader should be depending on anyway. */
  if (/^[A-Za-z_][\w."]*$/.test(t)) return { name: t.split(".").pop().replace(/"/g, "").toLowerCase(), text: t };
  return null;
}

/** Everything between SELECT and its own FROM, at depth 0.
 *
 *  STOPS AT AN INTERPOLATION TOO, and that is the whole correctness argument.
 *  These are TEMPLATE LITERALS: a query written `SELECT a, b ${FROM} WHERE …`
 *  contains no FROM keyword at all, so a scan looking only for FROM runs past
 *  the end of the projection — through the joins, through every UNION branch —
 *  and reports the next branch's columns as duplicates of this one's. That
 *  produced 28 confident failures against correct SQL.
 *
 *  Where the text becomes opaque, the scan stops. It means a projection that
 *  interpolates midway is only checked up to that point, which is a smaller
 *  claim than the scanner used to make and a true one. */
function projectionOf(sql, from) {
  let depth = 0;
  for (let i = from; i < sql.length; i++) {
    const c = sql[i];
    if (c === "(") depth++;
    else if (c === ")") { if (depth === 0) return sql.slice(from, i); depth--; }
    else if (depth === 0 && c === "$" && sql[i + 1] === "{") return sql.slice(from, i);
    else if (depth === 0 && /\s/.test(c) && /^\s*FROM\s/i.test(sql.slice(i, i + 7))) return sql.slice(from, i);
  }
  return null;
}

/** The table an alias refers to, read out of the FROM/JOIN clauses. */
const tableFor = (sql, alias) =>
  (strip(sql).match(new RegExp(`(?:FROM|JOIN)\\s+([a-z_]\\w*)\\s+(?:AS\\s+)?${alias}\\b`, "i")) || [])[1];

const schema = await loadSchema();
let failures = 0, advisory = 0, starsChecked = 0, projections = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const lit of src.matchAll(/`([^`]*)`/g)) {
    const raw = lit[1];
    if (!/\bSELECT\b/i.test(raw)) continue;
    const sql = strip(raw);
    const line = src.slice(0, lit.index).split("\n").length;

    /* Paren depth at every offset, so "same level" means what it says. */
    const depth = new Array(sql.length);
    { let d = 0;
      for (let i = 0; i < sql.length; i++) {
        if (sql[i] === "(") d++;
        depth[i] = d;
        if (sql[i] === ")") d--;
      } }

    for (const sel of sql.matchAll(/\bSELECT\b/gi)) {
      /* A UNION takes its column names from the FIRST branch and discards the
         rest, so a later branch cannot shadow anything.

         DEPTH-AWARE, because the first version was not. It compared the last
         UNION against the last SELECT anywhere before this one, so a branch
         containing a SUBQUERY looked like a first branch — the subquery's
         SELECT was nearer — and every branch after it was scanned as though its
         columns collided with the first branch's. That produced 28 confident
         reports of a defect that did not exist, which is how a scanner gets
         switched off. Only a UNION at this SELECT's own paren depth, with no
         intervening SELECT at that depth, means "I am a later branch". */
      const here = depth[sel.index] ?? 0;
      let isLaterBranch = false;
      for (let i = sel.index - 1; i >= 0; i--) {
        if ((depth[i] ?? 0) !== here) continue;
        if (/\bUNION\b/i.test(sql.slice(i, i + 5)) && /\bUNION\b/i.test(sql.slice(i, i + 6))) {
          isLaterBranch = true; break;
        }
        if (/\bSELECT\b/i.test(sql.slice(i, i + 6))) break;
      }
      if (isLaterBranch) continue;

      const proj = projectionOf(sql, sel.index + 6);
      if (!proj) continue;
      projections++;
      const items = topLevelSplit(proj).map(outputName).filter(Boolean);
      const named = items.filter((i) => i.name);

      const seen = new Map();
      for (const it of named) {
        if (seen.has(it.name)) {
          failures++;
          console.log(`\nFAIL  ${f}:${line}  two result columns named "${it.name}"`);
          console.log(`  discarded: ${seen.get(it.name).text.replace(/\s+/g, " ").slice(0, 100)}`);
          console.log(`  wins     : ${it.text.replace(/\s+/g, " ").slice(0, 100)}`);
        }
        seen.set(it.name, it);
      }

      for (const st of items.filter((i) => i.star && i.alias)) {
        const tbl = tableFor(raw, st.alias);
        const cols = schema && tbl ? schema.get(tbl) : null;
        if (!cols) {
          /* A CTE, a derived table, or no database — say so rather than guess. */
          advisory++;
          console.log(`\nNOTE  ${f}:${line}  ${st.alias}.*${tbl ? ` (${tbl})` : ""} not resolved`
            + `${schema ? " — a CTE or derived table; check by hand" : " — no database, star check skipped"}`);
          continue;
        }
        starsChecked++;
        const clash = named.filter((n) => cols.has(n.name));
        if (clash.length) {
          failures++;
          console.log(`\nFAIL  ${f}:${line}  ${st.alias}.* (${tbl}) is shadowed by a later column:`);
          for (const c of clash) console.log(`        ${c.name} <- ${c.text.replace(/\s+/g, " ").slice(0, 90)}`);
        }
      }
    }
  }
}

console.log(`\n${projections} projection(s) in ${files.length} file(s)`
  + ` · ${starsChecked} star projection(s) resolved against the schema`
  + ` · ${advisory} advisory · ${failures} failure(s)`);
if (!schema) console.log("No database was reachable, so star projections were not resolved.");
process.exit(failures ? 1 : 0);
