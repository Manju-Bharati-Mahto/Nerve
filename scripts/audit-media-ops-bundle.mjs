#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════════
   MEDIA OPS BUNDLE AUDIT

   WHY THIS EXISTS. The whole Media Ops frontend is one inline <script> inside
   public/media-ops/index.html — about 1.5 million characters of it. Nothing in
   the toolchain reads that file: it is served as a static asset, so tsc never
   sees it, eslint never sees it, vite never parses it, and no test imports it.
   A stray bracket in it is a blank application for every user of the module,
   and the first thing that would notice is a person opening the page.

   This closes that hole with the cheapest possible check — `node --check` on
   the extracted script — plus two rules that only matter for this file:

     1. Every `data-act="name"` in the markup must have a `name:` handler in the
        ACTIONS object. A button wired to a handler somebody deleted throws
        "ACTIONS[...] is not a function" on click and nowhere earlier.
     2. No handler may reach a route that the router does not serve. A nav entry
        pointing at a removed view is how Follow-ups shipped a stack trace to
        three roles for six weeks.

   Run: npm run audit:media-ops
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FILE = "public/media-ops/index.html";
const html = readFileSync(FILE, "utf8");
const problems = [];

/* ── The script itself ──────────────────────────────────────────────────── */
const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (blocks.length === 0) problems.push("no inline <script> found — has the bundle moved?");

blocks.forEach((src, i) => {
  const tmp = join(tmpdir(), `mo-bundle-${process.pid}-${i}.js`);
  writeFileSync(tmp, src);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    const detail = String(e.stderr || e.message).split("\n").slice(0, 6).join("\n");
    problems.push(`inline script block ${i} does not parse:\n${detail}`);
  } finally {
    try { unlinkSync(tmp); } catch { /* best effort */ }
  }
});

const script = blocks.join("\n");

/* ── Wired controls that lead nowhere ───────────────────────────────────── */
const acted = new Set([...html.matchAll(/data-act="([A-Za-z0-9_$]+)"/g)].map((m) => m[1]));
/* ACTIONS entries are written `name:(d)=>` / `name:async()=>` / `name:function`.
   Matching the declaration rather than every mention keeps a handler that is
   only ever CALLED (ACTIONS.foo(d)) from vouching for itself. */
const declared = new Set([...script.matchAll(/^\s{2}([A-Za-z0-9_$]+)\s*:\s*(?:async\s*)?(?:\(|function)/gm)].map((m) => m[1]));
/* A handful of controls are bound directly — `node.querySelector('[data-act=undo]')
   .onclick = ...` — rather than through the delegated ACTIONS lookup. Those are
   wired, just not that way, so a direct binding counts as a handler. */
const bound = new Set([...script.matchAll(/\[data-act=['"]?([A-Za-z0-9_$]+)['"]?\]/g)].map((m) => m[1]));
const dangling = [...acted].filter((a) => !declared.has(a) && !bound.has(a)).sort();
if (dangling.length)
  problems.push(`data-act with no handler in ACTIONS: ${dangling.join(", ")}`);

/* ── Links into routes the router does not serve ────────────────────────── */
const routed = [...script.matchAll(/\[\/\^#\\\/media\\\/([^$\/]*)/g)].map((m) => m[1]);
const linked = new Set([...html.matchAll(/href="#\/media\/([a-z-]+)/g)].map((m) => m[1]));
const servable = (seg) => routed.some((r) => {
  const head = r.replace(/\\\//g, "/").split("/")[0];
  return head === seg || head.includes("\\w") || head.includes("[");
});
const orphans = [...linked].filter((seg) => !servable(seg)).sort();
if (orphans.length)
  problems.push(`links to routes the router does not serve: ${orphans.map((o) => "#/media/" + o).join(", ")}`);

/* ── Routes whose view function does not exist ──────────────────────────── */
/* This is the Follow-ups bug exactly: the view was deleted, the ROUTES entry
   calling it was not, and `viewFollowups is not defined` reached users as a
   stack trace. The route table is one array of [regex, handler] pairs, so the
   names it calls can be read straight out of it and checked against the
   function declarations in the same script. */
const routeTable = script.match(/const ROUTES\s*=\s*\[[\s\S]*?\n\];/);
if (!routeTable) {
  problems.push("could not find the ROUTES table — has the router moved?");
} else {
  const called = new Set([...routeTable[0].matchAll(/=>\s*\{?\s*(?:return\s+)?([A-Za-z0-9_$]+)\s*\(/g)].map((m) => m[1]));
  const defined = new Set([
    ...[...script.matchAll(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]),
    ...[...script.matchAll(/^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\(|function)/gm)].map((m) => m[1]),
  ]);
  const missing = [...called].filter((n) => !defined.has(n)).sort();
  if (missing.length)
    problems.push(`ROUTES calls functions that do not exist: ${missing.join(", ")}`);
}

/* ── Report ─────────────────────────────────────────────────────────────── */
if (problems.length) {
  console.error(`\n✗ ${FILE}\n`);
  for (const p of problems) console.error("  • " + p + "\n");
  process.exit(1);
}
console.log(`✓ ${FILE}: parses, ${declared.size} handlers, ${acted.size} wired controls, no orphan routes`);
