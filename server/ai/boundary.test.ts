// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   ARCHITECTURAL BOUNDARY

   Phase 2 promises that server/ai/ can talk to a model and enforce permissions,
   and that it cannot reach Nerve data. That promise is only worth anything if
   something checks it, so these tests read the source itself.

   PHASE 3 REVISIT (as flagged in Phase 2): tools now import a Nerve SERVICE —
   server/mediaops-queries.ts — which is what holds the pool and the SQL. That is
   the intended shape: the AI layer asks a question, the service answers it. The
   allowance list below is the full, deliberate surface, and it is asserted
   exactly so a fourth import cannot appear without this test failing.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const AI_DIR = join(process.cwd(), "server", "ai");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
  });
}

const files = sourceFiles(AI_DIR);
const rel = (f: string) => f.slice(process.cwd().length + 1);

describe("19. no database access anywhere in server/ai/", () => {
  it("finds source files to check", () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it.each(files.map((f) => [rel(f), f]))("%s does not import the database", (_name, file) => {
    const src = readFileSync(file, "utf8");
    const imports = [...src.matchAll(/^\s*import[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const spec of imports) {
      expect(spec).not.toMatch(/\bdb\.js$/);
      expect(spec).not.toMatch(/mediaops-db|branding-db|design-db|outreach-db|settings-db/);
      expect(spec).not.toBe("pg");
    }
  });

  it.each(files.map((f) => [rel(f), f]))("%s contains no SQL or pool usage", (_name, file) => {
    // Strip comments first: the files explain the rule in prose, and the prose
    // must not be what trips the check.
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).not.toMatch(/\bpool\s*\.\s*query\b/);
    expect(src).not.toMatch(/\bSELECT\s+[\s\S]{0,40}\bFROM\b/i);
    expect(src).not.toMatch(/\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/i);
    expect(src).not.toMatch(/\bmo_[a-z_]+\b/);            // no Nerve table names
  });

  it("only the declared seams reach outside server/ai/", () => {
    /* Resolve each relative specifier against its own file rather than matching
       on text: "../config.js" means server/ai/config.ts from tools/registry.ts
       but server/config.ts from index.ts, and only the second leaves the layer. */
    const escapes: Array<[string, string]> = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*import[^;]*?from\s+["'](\.[^"']+)["']/gm)) {
        const target = resolve(dirname(file), m[1]);
        if (!target.startsWith(AI_DIR + sep)) escapes.push([rel(file), m[1]]);
      }
    }
    /* Exactly two seams, both intentional:
         index.ts       → server/config.ts          (configuration)
         nerve-tools.ts → server/mediaops-queries.ts (the Nerve service layer)
       Neither is the database. A new entry here means someone widened the
       boundary, and that should be a decision, not a diff nobody noticed. */
    expect(escapes.sort()).toEqual([
      ["server/ai/index.ts", "../config.js"],
      ["server/ai/tools/nerve-tools.ts", "../../mediaops-queries.js"],
    ]);
  });
});

describe("20. no secrets or Nerve data in the AI source", () => {
  it.each(files.map((f) => [rel(f), f]))("%s embeds no credential-shaped literal", (_name, file) => {
    const src = readFileSync(file, "utf8");
    expect(src).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);       // provider key shape
    expect(src).not.toMatch(/postgres(ql)?:\/\//);
    expect(src).not.toMatch(/@paruluniversity\.ac\.in/);    // no real people
  });
});

describe("the shipped tool registry holds only this phase's three tools", () => {
  it("registers exactly the Phase 3 slice, and nothing beyond it", async () => {
    const { createAiToolRegistry } = await import("./tools/registry.js");
    const names = createAiToolRegistry().listAll().map((t) => t.name).sort();
    expect(names).toEqual(["get_current_user", "get_my_day", "get_overdue_deliverables"]);
  });

  it("keeps every tool read-only and parameterless in this slice", async () => {
    const { createAiToolRegistry } = await import("./tools/registry.js");
    for (const t of createAiToolRegistry().listAll()) {
      // No write verb anywhere in the surface a model can see.
      expect(t.name).not.toMatch(/create|update|delete|assign|approve|send|set_/);
      // No arguments means no argument through which scope could be influenced.
      expect((t.parametersJsonSchema as { properties?: object }).properties ?? {}).toEqual({});
    }
  });
});
