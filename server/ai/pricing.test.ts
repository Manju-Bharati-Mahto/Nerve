// @vitest-environment node
/* 12–13. Cost estimation. The governing rule: never invent a price, and never
   report 0 when the honest answer is "unknown". */
import { describe, expect, it, vi } from "vitest";
import { estimateAiCost, parseAiPricing } from "./pricing.js";

describe("no price is built in", () => {
  it("yields an empty table when unconfigured", () => {
    for (const v of [undefined, "", "   "]) expect(parseAiPricing(v)).toEqual({});
  });

  it("estimates nothing without a configured rate", () => {
    expect(estimateAiCost({}, "gpt-4o-mini", 1000, 500)).toBeNull();
  });

  it("ships no default rate for any model name", () => {
    const table = parseAiPricing(undefined);
    for (const m of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "o3", "gpt-5"])
      expect(estimateAiCost(table, m, 1000, 1000)).toBeNull();
  });
});

describe("configured pricing", () => {
  const raw = JSON.stringify({
    "test-model": { inputPerMillion: 10, outputPerMillion: 30, currency: "USD" } });

  it("parses and computes per million tokens", () => {
    const t = parseAiPricing(raw);
    expect(t["test-model"]).toEqual({ inputPerMillion: 10, outputPerMillion: 30, currency: "USD" });
    // 1,000,000 in @10 + 1,000,000 out @30 = 40
    expect(estimateAiCost(t, "test-model", 1_000_000, 1_000_000)).toBe(40);
    // 1,000 in + 500 out = 0.01 + 0.015
    expect(estimateAiCost(t, "test-model", 1_000, 500)).toBeCloseTo(0.025, 6);
  });

  it("matches on the exact model id only", () => {
    const t = parseAiPricing(raw);
    expect(estimateAiCost(t, "test-model-2", 1000, 1000)).toBeNull();
    expect(estimateAiCost(t, null, 1000, 1000)).toBeNull();
  });

  it("rounds to the precision the column stores", () => {
    const t = parseAiPricing(JSON.stringify({ m: { inputPerMillion: 1, outputPerMillion: 1 } }));
    const c = estimateAiCost(t, "m", 1, 0)!;
    expect(String(c).replace(/^0\./, "").length).toBeLessThanOrEqual(6);
  });
});

describe("unknown is not zero", () => {
  const t = parseAiPricing(JSON.stringify({ m: { inputPerMillion: 1, outputPerMillion: 1 } }));

  it("returns null when the provider reported no usage at all", () => {
    expect(estimateAiCost(t, "m", null, null)).toBeNull();
  });

  it("still costs a request that reported only one side", () => {
    expect(estimateAiCost(t, "m", 1_000_000, null)).toBe(1);
  });
});

describe("bad configuration disables cost, it never breaks a request", () => {
  it("survives malformed JSON", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(parseAiPricing("{not json")).toEqual({});
    expect(parseAiPricing("[1,2,3]")).toEqual({});
    expect(parseAiPricing("null")).toEqual({});
  });

  it("ignores a half-configured model rather than under-reporting it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = parseAiPricing(JSON.stringify({
      good: { inputPerMillion: 1, outputPerMillion: 2 },
      missingOutput: { inputPerMillion: 1 },
      negative: { inputPerMillion: -1, outputPerMillion: 1 },
    }));
    expect(Object.keys(t)).toEqual(["good"]);
  });

  it("does not log a rate as if it were a secret, but logs the model name", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    parseAiPricing(JSON.stringify({ broken: { inputPerMillion: 1 } }));
    expect(String(spy.mock.calls[0])).toContain("broken");
  });
});
