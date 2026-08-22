// @vitest-environment node
/* Adapter behaviour against a mocked HTTP layer. No network is used, and no
   Nerve module is imported — the provider layer genuinely stands alone. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAiConfig } from "./config.js";
import { AiProviderError, redactSecret, summariseDetail } from "./errors.js";
import { createAiProvider, supportedProviders } from "./provider.js";
import type { AiProvider, AiProviderConfig } from "./types.js";

const KEY = "sk-secret-DO-NOT-LEAK-123456";
const cfg = (over: Partial<AiProviderConfig> = {}): AiProviderConfig => ({
  provider: "openai-compatible",
  baseUrl: "https://api.example.com/v1",
  apiKey: KEY,
  model: "test-model-1",
  timeoutMs: 5_000,
  maxOutputTokens: 256,
  ...over,
});

/** Minimal fetch double: queue responses, inspect what was sent. */
function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(async (url: unknown, init: unknown) =>
    handler(String(url), (init ?? {}) as RequestInit));
  vi.stubGlobal("fetch", spy);
  return spy;
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const chatOk = {
  model: "test-model-1",
  choices: [{ message: { content: "hello there" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 },
};

let provider: AiProvider;
beforeEach(() => { provider = createAiProvider(cfg()); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("provider instantiation", () => {
  it("builds an adapter for every supported provider alias", () => {
    for (const name of supportedProviders())
      expect(createAiProvider(cfg({ provider: name }))).toBeTruthy();
    expect(supportedProviders()).toContain("ollama");
  });

  it("is case-insensitive about the provider name", () => {
    expect(createAiProvider(cfg({ provider: "OpenAI-Compatible" }))).toBeTruthy();
  });

  it("throws a typed error for an unknown provider", () => {
    try {
      createAiProvider(cfg({ provider: "definitely-not-real" }));
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AiProviderError);
      expect((e as AiProviderError).kind).toBe("invalid_config");
    }
  });

  it("reports capability metadata without any network call", () => {
    const spy = mockFetch(() => json({}));
    expect(provider.info()).toEqual({
      provider: "openai-compatible", model: "test-model-1",
      baseUrl: "https://api.example.com/v1",
      supportsStreaming: true, supportsStructuredOutput: true,
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("successful request (mocked HTTP)", () => {
  it("posts to /chat/completions and maps the response", async () => {
    const spy = mockFetch(() => json(chatOk));
    const r = await provider.generate({ messages: [{ role: "user", content: "hi" }] });

    expect(r.text).toBe("hello there");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ promptTokens: 11, completionTokens: 4, totalTokens: 15 });

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "test-model-1", max_tokens: 256 });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("sends the key as a bearer token and nowhere else", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(url).not.toContain(KEY);                    // never in the query string
    expect(String(init.body)).not.toContain(KEY);      // never in the payload
  });

  it("honours a per-request output cap", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [{ role: "user", content: "hi" }], maxOutputTokens: 7, temperature: 0 });
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.max_tokens).toBe(7);
    expect(body.temperature).toBe(0);
  });

  it("tolerates a missing usage block", async () => {
    mockFetch(() => json({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }));
    const r = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(r.usage).toBeUndefined();
    expect(r.text).toBe("x");
  });

  it("treats null content (cut off at max_tokens) as empty text, not a crash", async () => {
    mockFetch(() => json({ choices: [{ message: { content: null }, finish_reason: "length" }] }));
    const r = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(r.text).toBe("");
    expect(r.finishReason).toBe("length");
  });
});

describe("authentication failure", () => {
  it("maps 401 to an auth error", async () => {
    mockFetch(() => json({ error: { message: "Incorrect API key provided" } }, 401));
    await expect(provider.generate({ messages: [{ role: "user", content: "hi" }] }))
      .rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("maps 403 to an auth error and 429 to rate_limit", async () => {
    mockFetch(() => json({ error: { message: "forbidden" } }, 403));
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "auth" });
    mockFetch(() => json({ error: { message: "slow down" } }, 429));
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "rate_limit", retryable: true });
  });

  it("recognises a rejected model as its own failure kind", async () => {
    mockFetch(() => json({ error: { message: "The model `test-model-1` does not exist" } }, 400));
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "model_unavailable" });
  });

  it("maps 5xx to provider_error", async () => {
    mockFetch(() => json({ error: { message: "upstream boom" } }, 503));
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "provider_error", retryable: true });
  });
});

describe("network failure", () => {
  it("maps a transport throw to a network error", async () => {
    mockFetch(() => { throw new TypeError("fetch failed: ECONNREFUSED"); });
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "network", retryable: true });
  });

  it("maps an abort to a timeout error", async () => {
    mockFetch(() => { const e = new Error("aborted"); e.name = "AbortError"; throw e; });
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("malformed provider response", () => {
  it.each([
    ["no choices array", {}],
    ["empty choices array", { choices: [] }],
    ["choices is not an array", { choices: "nope" }],
  ])("rejects %s", async (_label, body) => {
    mockFetch(() => json(body));
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("rejects a 200 whose body is not JSON at all", async () => {
    mockFetch(() => new Response("<html>gateway</html>", { status: 200 }));
    await expect(provider.generate({ messages: [] })).rejects.toMatchObject({ kind: "malformed_response" });
  });
});

describe("structured output", () => {
  const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

  it("passes the schema through and parses the JSON result", async () => {
    const spy = mockFetch(() => json({ ...chatOk, choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
    const r = await provider.generateStructured<{ ok: boolean }>({
      messages: [{ role: "user", content: "give me json" }], schemaName: "probe", schema,
    });
    expect(r.data).toEqual({ ok: true });
    expect(r.raw).toBe('{"ok":true}');

    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.response_format).toEqual({
      type: "json_schema", json_schema: { name: "probe", schema, strict: true },
    });
  });

  it("reports malformed_response when the model returns prose instead of JSON", async () => {
    mockFetch(() => json({ choices: [{ message: { content: "Sure! Here you go." }, finish_reason: "stop" }] }));
    await expect(provider.generateStructured({ messages: [], schemaName: "p", schema }))
      .rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("does not validate the schema itself — that is the caller's job", async () => {
    // Valid JSON that does NOT satisfy the schema still comes back; the provider
    // only guarantees parseable JSON.
    mockFetch(() => json({ choices: [{ message: { content: '{"unexpected":1}' }, finish_reason: "stop" }] }));
    const r = await provider.generateStructured({ messages: [], schemaName: "p", schema });
    expect(r.data).toEqual({ unexpected: 1 });
  });
});

describe("connection test", () => {
  it("reports success from the model catalogue, and confirms the model is listed", async () => {
    mockFetch((url) => url.endsWith("/models")
      ? json({ data: [{ id: "test-model-1" }, { id: "other" }] })
      : json(chatOk));
    const r = await provider.testConnection();
    expect(r).toMatchObject({
      configured: true, reachable: true, authenticated: true,
      modelAvailable: true, provider: "openai-compatible", model: "test-model-1",
    });
    expect(r.error).toBeUndefined();
  });

  it("flags a model the provider does not list", async () => {
    mockFetch(() => json({ data: [{ id: "something-else" }] }));
    const r = await provider.testConnection();
    expect(r).toMatchObject({ reachable: true, authenticated: true, modelAvailable: false });
    expect(r.error).toContain("test-model-1");
  });

  it("reports auth failure without claiming authentication", async () => {
    mockFetch(() => json({ error: { message: "bad key" } }, 401));
    const r = await provider.testConnection();
    expect(r).toMatchObject({ reachable: true, authenticated: false });
  });

  it("falls back to a one-token completion when /models is unimplemented", async () => {
    const seen: string[] = [];
    mockFetch((url) => { seen.push(url); return url.endsWith("/models") ? json({}, 404) : json(chatOk); });
    const r = await provider.testConnection();
    expect(r).toMatchObject({ reachable: true, authenticated: true, modelAvailable: true });
    expect(seen.some((u) => u.endsWith("/chat/completions"))).toBe(true);
  });

  it("reports unreachable on a transport failure, and never throws", async () => {
    mockFetch(() => { throw new TypeError("ECONNREFUSED"); });
    const r = await provider.testConnection();
    expect(r).toMatchObject({ reachable: false, authenticated: false, modelAvailable: null });
    expect(r.error).toBeTruthy();
  });

  it("sends no Nerve data — the entire fallback payload is 'ping'", async () => {
    const bodies: string[] = [];
    mockFetch((url, init) => {
      if (init.body) bodies.push(String(init.body));
      return url.endsWith("/models") ? json({}, 404) : json(chatOk);
    });
    await provider.testConnection();
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]);
    expect(body.messages).toEqual([{ role: "user", content: "ping" }]);
    expect(body.max_tokens).toBe(1);
  });
});

describe("the API key never escapes", () => {
  it("is absent from every connection-test result", async () => {
    for (const responder of [
      () => json({ data: [{ id: "test-model-1" }] }),
      () => json({ error: { message: `key ${KEY} is invalid` } }, 401),
      () => json({ error: { message: `denied for ${KEY}` } }, 500),
      () => { throw new TypeError(`connect failed using ${KEY}`); },
    ]) {
      mockFetch(responder);
      const r = await createAiProvider(cfg()).testConnection();
      expect(JSON.stringify(r)).not.toContain(KEY);
    }
  });

  it("is scrubbed from an error message even when the provider echoes it back", async () => {
    mockFetch(() => json({ error: { message: `Invalid Authorization: Bearer ${KEY}` } }, 401));
    await expect(provider.generate({ messages: [] })).rejects.toSatisfy(
      (e: AiProviderError) => !e.message.includes(KEY) && e.message.includes("***"));
  });

  it("redactSecret ignores values too short to be a real key", () => {
    // A 3-char "secret" would otherwise match everywhere and destroy the message.
    expect(redactSecret("the cat sat", "cat")).toBe("the cat sat");
    expect(redactSecret(`prefix ${KEY} suffix`, KEY)).toBe("prefix *** suffix");
  });

  it("summariseDetail truncates, flattens and redacts", () => {
    const long = `${KEY} ` + "x".repeat(600);
    const out = summariseDetail(long, KEY);
    expect(out).not.toContain(KEY);
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out).not.toContain("\n");
  });
});

describe("the API key is never logged", () => {
  it("keeps it out of console output on every failure path", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    mockFetch(() => json({ error: { message: `bad key ${KEY}` } }, 401));
    await createAiProvider(cfg()).testConnection();
    mockFetch(() => { throw new TypeError(`ECONNREFUSED with ${KEY}`); });
    await createAiProvider(cfg()).testConnection();
    mockFetch(() => json({ error: { message: KEY } }, 500));
    await provider.generate({ messages: [] }).catch(() => {});

    for (const spy of [errSpy, logSpy, warnSpy])
      for (const call of spy.mock.calls)
        expect(JSON.stringify(call)).not.toContain(KEY);
  });
});

describe("resolve → create round trip", () => {
  it("builds a working provider straight from raw environment values", async () => {
    const { config } = resolveAiConfig({
      provider: "groq", baseUrl: "https://api.groq.com/openai/v1",
      apiKey: KEY, model: "llama-3.1-8b",
    });
    expect(config).not.toBeNull();
    const p = createAiProvider(config!);
    const spy = mockFetch(() => json(chatOk));
    await p.generate({ messages: [{ role: "user", content: "hi" }] });
    expect((spy.mock.calls[0] as [string, RequestInit])[0])
      .toBe("https://api.groq.com/openai/v1/chat/completions");
  });
});

/* ── Phase 2: tool-call translation ───────────────────────────────────────
   The adapter's only tool responsibility is translation. These assert the wire
   shape in both directions, and that a request WITHOUT tools is unchanged from
   Phase 1. */
describe("tool calling — request translation", () => {
  const toolDef = {
    name: "projects.list",
    description: "List projects",
    parameters: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
  };

  it("omits tool fields entirely when no tools are supplied (Phase 1 shape preserved)", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect("tools" in body).toBe(false);
    expect("tool_choice" in body).toBe(false);
  });

  it("translates tool definitions into the function-calling shape", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [{ role: "user", content: "hi" }], tools: [toolDef] });
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.tools).toEqual([{ type: "function", function: toolDef }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("honours toolChoice: none", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [], tools: [toolDef], toolChoice: "none" });
    expect(JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body)).tool_choice).toBe("none");
  });

  it("translates an assistant tool-call turn and a tool result message", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "projects.list", argumentsRaw: '{"limit":5}' }] },
      { role: "tool", content: '{"data":[]}', toolCallId: "c1" },
    ] });
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.messages[1]).toEqual({
      role: "assistant", content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "projects.list", arguments: '{"limit":5}' } }],
    });
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: '{"data":[]}' });
  });
});

describe("tool calling — response translation", () => {
  it("surfaces tool calls the model asked for", async () => {
    mockFetch(() => json({ model: "test-model-1", choices: [{
      message: { content: null, tool_calls: [
        { id: "call_1", type: "function", function: { name: "projects.list", arguments: '{"limit":5}' } },
      ] },
      finish_reason: "tool_calls",
    }] }));
    const r = await provider.generate({ messages: [] });
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "projects.list", argumentsRaw: '{"limit":5}' }]);
    expect(r.text).toBe("");
    expect(r.finishReason).toBe("tool_calls");
  });

  it("supplies an id when a compatible endpoint omits one", async () => {
    mockFetch(() => json({ choices: [{
      message: { content: null, tool_calls: [{ function: { name: "a", arguments: "{}" } }] },
      finish_reason: "tool_calls",
    }] }));
    const r = await provider.generate({ messages: [] });
    expect(r.toolCalls?.[0]).toMatchObject({ id: "call_0", name: "a" });
  });

  it("ignores malformed tool calls that carry no function name", async () => {
    mockFetch(() => json({ choices: [{
      message: { content: "text", tool_calls: [{ id: "x", type: "function", function: {} }] },
      finish_reason: "stop",
    }] }));
    const r = await provider.generate({ messages: [] });
    expect(r.toolCalls).toBeUndefined();
    expect(r.text).toBe("text");
  });

  it("leaves toolCalls absent on an ordinary answer", async () => {
    mockFetch(() => json(chatOk));
    expect((await provider.generate({ messages: [] })).toolCalls).toBeUndefined();
  });

  it("never executes anything — it only reports the request", async () => {
    // The adapter has no registry, no run(), and no way to invoke a tool. If it
    // ever gained one, this shape check would be the first thing to change.
    mockFetch(() => json({ choices: [{
      message: { content: null, tool_calls: [{ id: "c", type: "function",
        function: { name: "projects.list", arguments: "{}" } }] }, finish_reason: "tool_calls" }] }));
    const r = await provider.generate({ messages: [] });
    expect(Object.keys(r)).not.toContain("run");
    expect(r.toolCalls).toHaveLength(1);
  });
});

/* ── Phase 4B: OpenAI production request-shape compatibility ───────────────
   Newer OpenAI models reject `max_tokens` and some reject a non-default
   `temperature`. The adapter does not guess which — it reacts to the API's own
   error text, corrects once, and remembers. */
describe("OpenAI parameter compatibility", () => {
  it("sends max_tokens by default", async () => {
    const spy = mockFetch(() => json(chatOk));
    await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    const body = JSON.parse(String((spy.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body.max_tokens).toBe(256);
    expect("max_completion_tokens" in body).toBe(false);
  });

  it("switches to max_completion_tokens when the API asks for it, and retries once", async () => {
    let call = 0;
    const spy = mockFetch(() => {
      call++;
      return call === 1
        ? json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } }, 400)
        : json(chatOk);
    });
    const r = await provider.generate({ messages: [{ role: "user", content: "hi" }] });
    expect(r.text).toBe("hello there");
    expect(spy).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String((spy.mock.calls[1] as [string, RequestInit])[1].body));
    expect(retry.max_completion_tokens).toBe(256);
    expect("max_tokens" in retry).toBe(false);
  });

  it("remembers the correction, so it is paid for once", async () => {
    let call = 0;
    const spy = mockFetch(() => {
      call++;
      return call === 1
        ? json({ error: { message: "Use 'max_completion_tokens' instead." } }, 400)
        : json(chatOk);
    });
    await provider.generate({ messages: [] });          // 2 calls: fail + retry
    await provider.generate({ messages: [] });          // 1 call: already corrected
    expect(spy).toHaveBeenCalledTimes(3);
    const third = JSON.parse(String((spy.mock.calls[2] as [string, RequestInit])[1].body));
    expect("max_completion_tokens" in third).toBe(true);
  });

  it("drops temperature when the model only accepts the default", async () => {
    let call = 0;
    const spy = mockFetch(() => {
      call++;
      return call === 1
        ? json({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) is supported." } }, 400)
        : json(chatOk);
    });
    await provider.generate({ messages: [], temperature: 0.2 });
    const retry = JSON.parse(String((spy.mock.calls[1] as [string, RequestInit])[1].body));
    expect("temperature" in retry).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry an auth failure, a rate limit or a server error", async () => {
    for (const [status, msg] of [[401, "bad key"], [429, "slow down"], [500, "boom"]] as const) {
      const spy = mockFetch(() => json({ error: { message: msg } }, status));
      await createAiProvider(cfg()).generate({ messages: [] }).catch(() => {});
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it("does NOT retry a 400 that is about content rather than a parameter", async () => {
    const spy = mockFetch(() => json({ error: { message: "Invalid value for 'messages': too long" } }, 400));
    await provider.generate({ messages: [] }).catch(() => {});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("applies the correction to structured requests too", async () => {
    let call = 0;
    const spy = mockFetch(() => {
      call++;
      return call === 1
        ? json({ error: { message: "Use 'max_completion_tokens' instead." } }, 400)
        : json({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] });
    });
    const r = await provider.generateStructured({ messages: [], schemaName: "s", schema: { type: "object" } });
    expect(r.data).toEqual({ ok: true });
    const retry = JSON.parse(String((spy.mock.calls[1] as [string, RequestInit])[1].body));
    expect(retry.max_completion_tokens).toBe(256);
    expect(retry.response_format).toBeTruthy();     // the schema survives the retry
  });
});
