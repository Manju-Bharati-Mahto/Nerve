// @vitest-environment node
/* 10/12. The egress boundary — the one privacy rule enforced in code. */
import { describe, expect, it, vi } from "vitest";
import { AI_EGRESS_POLICY, prepareAiContextForProvider } from "./egress.js";

describe("category E never reaches a provider", () => {
  it("strips credential-shaped fields at any depth", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const hostile = {
      name: "Priya Shah", designation: "Videographer",
      password: "hunter2", password_hash: "$2b$10$abc", api_key: "sk-leak-123456",
      nested: { token: "t-1", secret: "s-1", project: "Convocation",
                deeper: [{ authorization: "Bearer x", title: "Aftermovie" }] },
    };
    const { value, removed } = prepareAiContextForProvider("test_tool", hostile);
    const json = JSON.stringify(value);

    for (const leak of ["hunter2", "$2b$10$abc", "sk-leak-123456", "t-1", "s-1", "Bearer x"])
      expect(json).not.toContain(leak);
    // Legitimate work data survives — this is a boundary, not a shredder.
    expect(json).toContain("Priya Shah");
    expect(json).toContain("Convocation");
    expect(json).toContain("Aftermovie");
    expect(removed.sort()).toEqual([
      "api_key", "nested.deeper[0].authorization", "nested.secret", "nested.token",
      "password", "password_hash",
    ]);
  });

  it("strips personal contact details, which are category E", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { value } = prepareAiContextForProvider("t", {
      name: "A", email: "a@example.invalid", phone: "+910000000000", mobile: "x" });
    expect(Object.keys(value as object)).toEqual(["name"]);
  });

  it("is loud when it fires — a scrub means a tool is buggy", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    prepareAiContextForProvider("bad_tool", { secret: "x" });
    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0])).toContain("bad_tool");
    // The removed VALUE is never logged, only the path.
    expect(JSON.stringify(spy.mock.calls)).not.toContain('"x"');
  });

  it("passes clean data through untouched, and reports nothing removed", () => {
    const clean = { total: 2, deliverables: [{ id: 1, title: "T", daysOverdue: 3 }] };
    const r = prepareAiContextForProvider("get_overdue_deliverables", clean);
    expect(r.value).toEqual(clean);
    expect(r.removed).toEqual([]);
  });

  it("handles arrays, primitives and null without changing them", () => {
    for (const v of [null, 0, "", false, [1, 2, 3], "text"])
      expect(prepareAiContextForProvider("t", v).value).toEqual(v);
  });

  it("does not recurse without bound", () => {
    const deep: Record<string, unknown> = {};
    let cur = deep;
    for (let i = 0; i < 40; i++) { cur.next = {}; cur = cur.next as Record<string, unknown>; }
    expect(() => prepareAiContextForProvider("t", deep)).not.toThrow();
  });
});

describe("the policy is explicit about what may leave", () => {
  it("marks sensitive data as never permitted", () => {
    expect(AI_EGRESS_POLICY.E_sensitive.permitted).toBe(false);
    for (const cat of ["A_identity", "B_work", "C_reporting", "D_operations"] as const)
      expect(AI_EGRESS_POLICY[cat].permitted).toBe(true);
  });

  it("names every category the brief asks to classify", () => {
    expect(Object.keys(AI_EGRESS_POLICY).sort()).toEqual(
      ["A_identity", "B_work", "C_reporting", "D_operations", "E_sensitive"]);
  });
});
