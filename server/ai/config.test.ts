// @vitest-environment node
/* Configuration rules. Pure functions, so these run with no environment, no
   database and no HTTP — which is the point of keeping resolution separate. */
import { describe, expect, it } from "vitest";
import { describeAiConfig, resolveAiConfig, validateBaseUrl } from "./config.js";

const FULL = {
  provider: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-abcdefghijklmnop",
  model: "test-model-1",
};

describe("resolveAiConfig — provider configuration missing", () => {
  it("treats a completely empty environment as 'off', not as an error", () => {
    const r = resolveAiConfig({});
    expect(r.config).toBeNull();
    expect(r.reason).toBeNull();   // silence: absence is a normal state
  });

  it("treats undefined and null the same way", () => {
    expect(resolveAiConfig(undefined).config).toBeNull();
    expect(resolveAiConfig(null).config).toBeNull();
    expect(resolveAiConfig(null).reason).toBeNull();
  });

  it.each([
    ["apiKey", { ...FULL, apiKey: "" }, "AI_API_KEY"],
    ["model", { ...FULL, model: "" }, "AI_MODEL"],
    ["baseUrl", { ...FULL, baseUrl: "" }, "AI_BASE_URL"],
  ])("explains a partially configured environment (%s missing)", (_label, env, expected) => {
    const r = resolveAiConfig(env);
    expect(r.config).toBeNull();
    expect(r.reason).toContain(expected);
  });

  it("never puts a secret in the reason", () => {
    const r = resolveAiConfig({ ...FULL, model: "" });
    expect(r.reason).not.toContain(FULL.apiKey);
  });
});

describe("resolveAiConfig — provider configuration present", () => {
  it("produces a usable config", () => {
    const { config, reason } = resolveAiConfig(FULL);
    expect(reason).toBeNull();
    expect(config).toMatchObject({
      provider: "openai-compatible", model: "test-model-1",
      baseUrl: "https://api.example.com/v1", apiKey: FULL.apiKey,
    });
  });

  it("defaults the provider when only credentials are given", () => {
    const { config } = resolveAiConfig({ ...FULL, provider: "" });
    expect(config?.provider).toBe("openai-compatible");
  });

  it("trims whitespace and strips a trailing slash from the base URL", () => {
    const { config } = resolveAiConfig({ ...FULL, baseUrl: "  https://api.example.com/v1/  ", model: " m1 " });
    expect(config?.baseUrl).toBe("https://api.example.com/v1");
    expect(config?.model).toBe("m1");
  });

  it("applies defaults and clamps out-of-range limits", () => {
    expect(resolveAiConfig(FULL).config).toMatchObject({ timeoutMs: 30_000, maxOutputTokens: 1024 });
    expect(resolveAiConfig({ ...FULL, timeoutMs: 5 }).config?.timeoutMs).toBe(1_000);
    expect(resolveAiConfig({ ...FULL, timeoutMs: 999_999 }).config?.timeoutMs).toBe(120_000);
    expect(resolveAiConfig({ ...FULL, timeoutMs: Number.NaN }).config?.timeoutMs).toBe(30_000);
  });
});

describe("validateBaseUrl — no arbitrary URL fetching", () => {
  it("accepts https anywhere", () => {
    expect(validateBaseUrl("https://api.groq.com/openai/v1").ok).toBe(true);
  });

  it("accepts http only for a loopback host, so local inference still works", () => {
    expect(validateBaseUrl("http://127.0.0.1:11434/v1").ok).toBe(true);
    expect(validateBaseUrl("http://localhost:8000/v1").ok).toBe(true);
  });

  it("rejects plaintext http to a remote host — that would put the key on the wire", () => {
    const r = validateBaseUrl("http://api.example.com/v1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("https");
  });

  it.each(["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "not a url", ""])(
    "rejects %s", (bad) => {
      expect(validateBaseUrl(bad).ok).toBe(false);
    });

  it("refuses a non-http scheme through resolveAiConfig too", () => {
    const r = resolveAiConfig({ ...FULL, baseUrl: "file:///etc/passwd" });
    expect(r.config).toBeNull();
    expect(r.reason).toBeTruthy();
  });
});

describe("describeAiConfig — API key is never returned", () => {
  it("omits the key structurally when configured", () => {
    const { config } = resolveAiConfig(FULL);
    const desc = describeAiConfig(config);
    expect(JSON.stringify(desc)).not.toContain(FULL.apiKey);
    expect(desc).toEqual({
      configured: true, provider: "openai-compatible",
      model: "test-model-1", baseUrl: "https://api.example.com/v1",
    });
    expect("apiKey" in desc).toBe(false);
  });

  it("reports not-configured for null", () => {
    expect(describeAiConfig(null)).toEqual({ configured: false, provider: null, model: null, baseUrl: null });
  });
});
