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
  ({ id, role, capabilities: new Set(caps), projectScope: role === "employee" ? "own" : "all" });

describe("the shipped registry in Phase 3", () => {
  it("registers exactly three real Nerve tools", () => {
    expect(createAiToolRegistry().size()).toBe(3);
  });

  it("gives an admin all three, and a capability-less user none", () => {
    const admin = userWith("u1", "admin", [...AI_CAPABILITIES]);
    expect(createAiToolRegistry().definitionsFor(admin).map((d) => d.name).sort())
      .toEqual(["get_current_user", "get_my_day", "get_overdue_deliverables"]);
    expect(createAiToolRegistry().definitionsFor(userWith("u2", "employee", []))).toEqual([]);
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
    expect(AI_CAPABILITIES.length).toBeLessThanOrEqual(12);
    expect(new Set(AI_CAPABILITIES).size).toBe(AI_CAPABILITIES.length);
  });
});
