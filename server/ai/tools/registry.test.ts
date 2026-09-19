// @vitest-environment node
/* Registry + capability filtering. Uses mock tools only — the real registry
   ships empty in Phase 2, which is itself asserted below. */
import { describe, expect, it } from "vitest";
import { z, toJSONSchema } from "zod/v4";
import { AiProviderError } from "../errors.js";
import { AiToolRegistry, createAiToolRegistry } from "./registry.js";
import type { AiCapability, AiTool, AiUserContext } from "../types.js";
import { AI_CAPABILITIES, AI_CAPABILITY_SOURCE } from "../types.js";

const schema = z.object({ limit: z.number().int().min(1).max(50).optional() });

export function mockTool(name: string, requires: AiCapability, run?: AiTool["run"]): AiTool<never> {
  return {
    name, description: `mock ${name}`,
    params: schema as never,
    parametersJsonSchema: toJSONSchema(schema) as Record<string, unknown>,
    requires,
    run: run ?? (async () => ({ data: { ok: true } })),
  } as unknown as AiTool<never>;
}

export const userWith = (id: string, role: string, caps: AiCapability[]): AiUserContext =>
  ({ id, role, capabilities: new Set(caps), projectScope: role === "employee" ? "own" : "all",
     creatorScope: caps.includes("creator.network") ? "all"
                 : caps.includes("creator.team") ? "team"
                 : caps.includes("creator.self") ? "self" : "none",
     creatorTeamIds: [] });

describe("the shipped registry", () => {
  it("registers the Media Ops slice plus the Creator Network set", () => {
    const names = createAiToolRegistry().listAll().map((t) => t.name);
    expect(names.filter((n) => !n.startsWith("creator_"))).toHaveLength(3);
    expect(names.filter((n) => n.startsWith("creator_"))).toHaveLength(18);
    expect(createAiToolRegistry().size()).toBe(21);
  });

  it("gives a capability-less user nothing at all", () => {
    expect(createAiToolRegistry().definitionsFor(userWith("u2", "employee", []))).toEqual([]);
  });

  it("gives a creator only the self-scoped Creator tools", () => {
    /* The whole permission model in one assertion: the same registry produces
       a different assistant for a creator than for a Creator Admin, because a
       tool a user lacks the capability for is never even advertised. */
    const creator = userWith("u3", "employee", ["creator.self"]);
    const names = createAiToolRegistry().definitionsFor(creator).map((d) => d.name).sort();
    expect(names).toEqual([
      "creator_get_discussion", "creator_get_my_analytics", "creator_get_my_content",
      "creator_get_my_payouts", "creator_get_my_profile", "creator_get_my_standing",
      "creator_get_my_work",
    ]);
    // No management tool, and above all no way to send anything.
    expect(names).not.toContain("creator_send_notification");
    expect(names).not.toContain("creator_get_payout_summary");
  });

  it("gives a team lead their team's tools but not the network's money or actions", () => {
    const lead = userWith("u4", "employee", ["creator.self", "creator.team"]);
    const names = createAiToolRegistry().definitionsFor(lead).map((d) => d.name);
    expect(names).toContain("creator_get_team_analytics");
    expect(names).toContain("creator_get_review_backlog");
    expect(names).not.toContain("creator_get_payout_summary");
    expect(names).not.toContain("creator_send_notification");
  });

  it("gives a Creator Admin everything Creator, including the one action", () => {
    const admin = userWith("u5", "admin", [...AI_CAPABILITIES]);
    const names = createAiToolRegistry().definitionsFor(admin).map((d) => d.name);
    expect(names).toContain("creator_get_payout_summary");
    expect(names).toContain("creator_send_notification");
    expect(names).toHaveLength(21);
  });
});

describe("registration", () => {
  it("rejects a duplicate name", () => {
    const reg = new AiToolRegistry().register(mockTool("projects.list", "projects.read"));
    expect(() => reg.register(mockTool("projects.list", "projects.read"))).toThrow(AiProviderError);
  });

  it.each(["Projects.List", "get projects", "1bad", "has-dash", ""])(
    "rejects the malformed tool name %o", (name) => {
      expect(() => new AiToolRegistry().register(mockTool(name, "projects.read"))).toThrow(AiProviderError);
    });

  it("accepts dotted and snake names", () => {
    const reg = new AiToolRegistry()
      .register(mockTool("projects.list", "projects.read"))
      .register(mockTool("get_overdue_work", "projects.read"));
    expect(reg.size()).toBe(2);
  });
});

describe("A. an authorized user sees an allowed tool", () => {
  it("lists it and advertises it", () => {
    const reg = new AiToolRegistry().register(mockTool("projects.list", "projects.read"));
    const u = userWith("u1", "employee", ["media.read", "projects.read"]);
    expect(reg.listFor(u).map((t) => t.name)).toEqual(["projects.list"]);
    const defs = reg.definitionsFor(u);
    expect(defs).toHaveLength(1);
    expect(defs[0]).toMatchObject({ name: "projects.list", description: "mock projects.list" });
    expect(defs[0].parameters).toMatchObject({ type: "object" });
  });
});

describe("B. an unauthorized user is never even told the tool exists", () => {
  it("omits it from the advertised list", () => {
    const reg = new AiToolRegistry()
      .register(mockTool("projects.list", "projects.read"))
      .register(mockTool("team.workload", "team.read"));
    const u = userWith("u2", "employee", ["media.read", "projects.read"]);
    const names = reg.definitionsFor(u).map((d) => d.name);
    expect(names).toEqual(["projects.list"]);
    expect(names).not.toContain("team.workload");
  });

  it("gives a user with no capabilities nothing at all", () => {
    const reg = new AiToolRegistry().register(mockTool("projects.list", "projects.read"));
    expect(reg.definitionsFor(userWith("u3", "employee", []))).toEqual([]);
  });
});

describe("C. naming a tool directly does not bypass the check", () => {
  it("refuses to resolve a tool the user lacks the capability for", () => {
    const reg = new AiToolRegistry().register(mockTool("team.workload", "team.read"));
    const u = userWith("u4", "employee", ["media.read", "projects.read"]);
    expect(reg.resolveFor(u, "team.workload")).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("resolves it once the capability is present", () => {
    const reg = new AiToolRegistry().register(mockTool("team.workload", "team.read"));
    const lead = userWith("u5", "team_lead", ["media.read", "team.read"]);
    const r = reg.resolveFor(lead, "team.workload");
    expect(r.ok).toBe(true);
  });
});

describe("D. an unknown tool is rejected", () => {
  it("reports unknown rather than throwing", () => {
    const reg = new AiToolRegistry().register(mockTool("projects.list", "projects.read"));
    const u = userWith("u6", "admin", [...AI_CAPABILITIES]);
    expect(reg.resolveFor(u, "definitely_not_a_tool")).toEqual({ ok: false, reason: "unknown" });
    expect(reg.resolveFor(u, "")).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("the capability model stays anchored to Nerve's own permissions", () => {
  it("names an existing Nerve permission source for every capability", () => {
    for (const cap of AI_CAPABILITIES) {
      expect(AI_CAPABILITY_SOURCE[cap]).toBeTruthy();
      expect(typeof AI_CAPABILITY_SOURCE[cap]).toBe("string");
    }
  });

  it("stays small — a taxonomy, not a second RBAC", () => {
    /* A whole vertical was added in Phase 8 and cost three capabilities. The
       ceiling exists to stop a capability being minted per screen; it moves
       when a vertical arrives, not when a feature does. */
    expect(AI_CAPABILITIES.length).toBeLessThanOrEqual(15);
    expect(new Set(AI_CAPABILITIES).size).toBe(AI_CAPABILITIES.length);
  });
});
