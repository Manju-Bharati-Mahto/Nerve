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
    /* Four seams, every one intentional and every one a SERVICE:
         index.ts         → server/config.ts           (configuration)
         nerve-tools.ts   → server/mediaops-queries.ts (Media Ops service layer)
         creator-tools.ts → server/creator-queries.ts  (Creator read service)
         creator-tools.ts → server/creator-actions.ts  (the one whitelisted write)
       None of them is the database. A new entry here means someone widened the
       boundary, and that should be a decision, not a diff nobody noticed. */
    expect(escapes.sort()).toEqual([
      ["server/ai/index.ts", "../config.js"],
      ["server/ai/tools/creator-tools.ts", "../../creator-actions.js"],
      ["server/ai/tools/creator-tools.ts", "../../creator-queries.js"],
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

describe("the shipped tool registry holds exactly what the phases put in it", () => {
  it("registers the Media Ops slice and the Creator Network set, and nothing else", async () => {
    const { createAiToolRegistry } = await import("./tools/registry.js");
    const names = createAiToolRegistry().listAll().map((t) => t.name).sort();
    expect(names).toEqual([
      // Phase 3 — Media Ops
      "get_current_user", "get_my_day", "get_overdue_deliverables",
      // Phase 8 — Creator Network
      "creator_get_competition_summary", "creator_get_creator_analytics",
      "creator_get_creators", "creator_get_discussion", "creator_get_my_analytics",
      "creator_get_my_content", "creator_get_my_payouts", "creator_get_my_profile",
      "creator_get_my_standing", "creator_get_my_work", "creator_get_network_summary",
      "creator_get_operational_signals", "creator_get_opportunity_conversion",
      "creator_get_payout_summary", "creator_get_recognition_summary",
      "creator_get_review_backlog", "creator_get_team_analytics",
      "creator_send_notification",
    ].sort());
  });

  it("holds exactly ONE tool that can change anything", async () => {
    const { createAiToolRegistry } = await import("./tools/registry.js");
    const { CREATOR_AI_ACTIONS } = await import("../creator-actions.js");
    /* Anchored on whole snake_case tokens, so "payouts" in a read tool's name
       is not mistaken for the verb "pay". */
    const writeVerb = /(^|_)(create|update|delete|assign|approve|reject|pay|award|send|set|revoke)(_|$)/;
    const writers = createAiToolRegistry().listAll()
      .map((t) => t.name).filter((n) => writeVerb.test(n));
    expect(writers).toEqual(["creator_send_notification"]);
    // And it is the whitelist, not a coincidence.
    expect([...CREATOR_AI_ACTIONS]).toEqual(["creator_send_notification"]);
  });

  it("gives no tool a free-text argument that could steer a query", async () => {
    const { createAiToolRegistry } = await import("./tools/registry.js");
    /* Every argument a model may supply, across the whole registry. A period is
       a closed enum, an id is an id, and the notification fields are the text
       being sent. Nothing here is a filter, a column, a sort or a query. */
    const allowed = new Set(["period", "creator_id", "creator_ids", "kind", "id",
                             "title", "body", "confirm_token"]);
    for (const t of createAiToolRegistry().listAll()) {
      const props = (t.parametersJsonSchema as { properties?: Record<string, unknown> }).properties ?? {};
      for (const key of Object.keys(props))
        expect(allowed, `${t.name}.${key}`).toContain(key);
    }
  });

  it("keeps every Media Ops tool parameterless, as Phase 3 left them", async () => {
    const { createAiToolRegistry } = await import("./tools/registry.js");
    for (const t of createAiToolRegistry().listAll().filter((x) => !x.name.startsWith("creator_"))) {
      expect(t.name).not.toMatch(/create|update|delete|assign|approve|send|set_/);
      expect((t.parametersJsonSchema as { properties?: object }).properties ?? {}).toEqual({});
    }
  });
});
