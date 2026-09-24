#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   TEST ISOLATION AUDIT  —  ADVISORY, NOT A GATE

   Every integration suite in this repository shares one database and they run
   in parallel. An assertion that reads rows it did not create is therefore
   measuring a moving target, and fails on a schedule nobody controls. Six such
   assertions have been corrected across four suites so far.

   WHY THIS IS NOT A LINT RULE. On the run that produced it, this scan raised
   36 candidates of which 4 were real defects — roughly a 90% false-positive
   rate. Most global reads here are legitimate: a migration invariant, a
   bootstrap idempotence check, or a deliberately global figure compared as a
   window. A rule that failed CI on those would be turned off within a week,
   and a rule narrow enough not to would miss the defects that matter. So this
   prints candidates for a human to classify and ALWAYS exits 0.

   HOW TO CLASSIFY WHAT IT PRINTS:

     A  legitimately global   the whole database IS the subject — a migration
                              invariant, a bootstrap seed, a schema check
     B  fixture-scoped        WHERE category_id = <captured fixture>
     C  scope-scoped          WHERE scope_id = <captured scope>
     D  user-scoped           WHERE user_id LIKE '<prefix>-%'
     E  UNSAFE                a global read used to prove what THIS test wrote

   Only E needs correcting. Do not mechanically rewrite A.

   Usage:  node scripts/audit-test-isolation.mjs
           npm run audit:test-isolation
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, readdirSync, existsSync } from "node:fs";

const dirs = ["server", "src/test"].filter(existsSync);
const files = dirs.flatMap((d) => readdirSync(d)
  .filter((f) => f.endsWith(".test.ts")).map((f) => `${d}/${f}`));

/* The things that make a query this suite's own: a bound parameter, the suite
   prefix, or a captured fixture id. */
const OWNED = /\$\d|\bPX\b|LIKE\s*\$|category_id|categoryId|scope_id|scopeId|user_id|actor_id|entity_id|entity_uid|asset_tag|equipment_item_id|payout_id|holder_id/i;

const kinds = new Map();
const add = (kind, at, ctx) => {
  if (!kinds.has(kind)) kinds.set(kind, []);
  kinds.get(kind).push([at, ctx.replace(/\s+/g, " ").trim().slice(0, 150)]);
};

for (const f of files) {
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((ln, i) => {
    /* Comments describe these patterns as often as they use them. */
    if (/^\s*(\*|\/\*|\/\/)/.test(ln)) return;
    const at = `${f}:${i + 1}`;
    const win = lines.slice(i, i + 3).join(" ");
    const ctx = lines.slice(i, i + 4).join(" ");

    if (/COUNT\(\*\)/i.test(ln)) {
      if (!/\bWHERE\b/i.test(win)) add("COUNT over a whole table", at, ctx);
      else if (!OWNED.test(win)) add("COUNT whose WHERE owns nothing", at, ctx);
    }
    if (/created_by\s+IS\s+NULL/i.test(ln))
      add("created_by IS NULL — never fixture ownership", at, ctx);
    if (/\b(currval|lastval|nextval)\s*\(/i.test(ln))
      add("sequence position", at, ctx);
    if (/\b(MAX|MIN)\s*\(/i.test(ln) && !OWNED.test(win))
      add("global MAX/MIN", at, ctx);
    if (/ORDER BY[^`]*\bDESC\b[^`]*LIMIT\s+1/i.test(ln) && !OWNED.test(win))
      add("global latest row", at, ctx);
  });
}

let total = 0;
for (const [kind, list] of [...kinds].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n### ${kind} — ${list.length}`);
  for (const [at, ctx] of list) { total++; console.log(`  ${at}\n      ${ctx}`); }
}
console.log(`\n${total} candidate(s) across ${files.length} suite(s).`);
console.log("Advisory only — classify each as A–E above. Exit code is always 0.");
