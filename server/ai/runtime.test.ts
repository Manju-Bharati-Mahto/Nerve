// @vitest-environment node
/* The one file in server/ai/ that reads real configuration.
   These tests cover the requirement that matters most in Phase 1: with no AI
   configured, nothing anywhere throws. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "sk-runtime-secret-abcdef123456";

/* server/config.ts requires these three or it throws at import — that is
   existing, deliberate behaviour for the platform's own secrets, unrelated to
   AI. Set them so we are testing the AI branch, not the bootstrap. */
const BASE_ENV = {
  DATABASE_URL: "postgres://u:p@127.0.0.1:5432/nerve_test",
  SESSION_SECRET: "test-session-secret-not-a-real-one",
  SUPER_ADMIN_PASSWORD: "test-bootstrap-password",
};

/** Load a fresh module graph under a given environment. */
async function loadRuntime(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...env }))
    if (v === undefined) vi.stubEnv(k, ""); else vi.stubEnv(k, v);
  return import("./index.js");
}

const AI_ON = {
  AI_PROVIDER: "openai-compatible",
  AI_BASE_URL: "https://api.example.com/v1",
  AI_API_KEY: KEY,
  AI_MODEL: "test-model-1",
};

beforeEach(() => { vi.stubEnv("AI_PROVIDER", ""); vi.stubEnv("AI_BASE_URL", "");
                   vi.stubEnv("AI_API_KEY", ""); vi.stubEnv("AI_MODEL", ""); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("AI disabled does not break Nerve", () => {
  it("imports cleanly and reports itself disabled with no AI environment", async () => {
    const ai = await loadRuntime({});
    expect(ai.isAiEnabled()).toBe(false);
    expect(ai.getAiProvider()).toBeNull();
    expect(ai.getAiStatus()).toMatchObject({
      enabled: false, configured: false, provider: null, model: null, reason: null,
    });
  });

  it("returns a structured result from testAiConnection instead of throwing", async () => {
    const ai = await loadRuntime({});
    const r = await ai.testAiConnection();
    expect(r).toMatchObject({ configured: false, reachable: false, authenticated: false });
    expect(r.error).toContain("not configured");
  });

  it("makes no network call at all when disabled", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const ai = await loadRuntime({});
    await ai.testAiConnection();
    expect(spy).not.toHaveBeenCalled();
  });

  it("explains a half-configured environment without failing", async () => {
    const ai = await loadRuntime({ AI_API_KEY: KEY, AI_MODEL: "m" });   // no base URL
    expect(ai.isAiEnabled()).toBe(false);
    expect(ai.getAiStatus().reason).toContain("AI_BASE_URL");
  });

  it("stays disabled — rather than crashing — on an unknown provider", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const ai = await loadRuntime({ ...AI_ON, AI_PROVIDER: "not-a-real-provider" });
    expect(ai.isAiEnabled()).toBe(false);
    expect(ai.getAiStatus().reason).toContain("not-a-real-provider");
  });

  it("stays disabled on a base URL that would leak the key over plaintext", async () => {
    const ai = await loadRuntime({ ...AI_ON, AI_BASE_URL: "http://api.example.com/v1" });
    expect(ai.isAiEnabled()).toBe(false);
    expect(ai.getAiStatus().reason).toContain("https");
  });
});

describe("AI enabled", () => {
  it("reports enabled with provider metadata", async () => {
    const ai = await loadRuntime(AI_ON);
    expect(ai.isAiEnabled()).toBe(true);
    expect(ai.getAiStatus()).toMatchObject({
      enabled: true, configured: true, provider: "openai-compatible",
      model: "test-model-1", baseUrl: "https://api.example.com/v1",
      supportsStreaming: true, supportsStructuredOutput: true, reason: null,
    });
  });

  it("probes the provider through testAiConnection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: [{ id: "test-model-1" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } })));
    const ai = await loadRuntime(AI_ON);
    expect(await ai.testAiConnection()).toMatchObject({
      configured: true, reachable: true, authenticated: true, modelAvailable: true,
    });
  });
});

describe("the API key never reaches an API response or a log", () => {
  it("is absent from getAiStatus() in every configuration state", async () => {
    for (const env of [AI_ON, { ...AI_ON, AI_BASE_URL: "http://evil.example.com" }, { AI_API_KEY: KEY }]) {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const ai = await loadRuntime(env);
      const status = ai.getAiStatus();
      expect(JSON.stringify(status)).not.toContain(KEY);
      expect("apiKey" in status).toBe(false);
    }
  });

  it("is absent from testAiConnection() results and from console output", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: { message: `rejected key ${KEY}` } }),
      { status: 401, headers: { "Content-Type": "application/json" } })));

    const ai = await loadRuntime(AI_ON);
    const r = await ai.testAiConnection();

    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(errSpy).toHaveBeenCalled();                       // failures ARE logged…
    for (const call of errSpy.mock.calls)                    // …but never with the key
      expect(JSON.stringify(call)).not.toContain(KEY);
  });
});
