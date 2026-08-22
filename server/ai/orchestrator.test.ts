// @vitest-environment node
/* Orchestration loop. Every provider here is a scripted double — no real LLM is
   ever contacted, and no tool touches a database. */
import { describe, expect, it, vi } from "vitest";
import { z, toJSONSchema } from "zod/v4";
import { AiProviderError } from "./errors.js";
import { boundToolResult, DEFAULT_MAX_ROUNDS, runAiOrchestration } from "./orchestrator.js";
import { AiToolRegistry } from "./tools/registry.js";
import type {
  AiCapability, AiCompletionRequest, AiCompletionResponse, AiProvider,
  AiStructuredResponse, AiTool, AiToolResult, AiUserContext,
} from "./types.js";

const paramsSchema = z.object({ limit: z.number().int().min(1).max(50).optional() });

function tool(o: {
  name: string; requires: AiCapability;
  run?: (u: AiUserContext, a: { limit?: number }) => Promise<AiToolResult>;
}): AiTool<never> {
  return {
    name: o.name, description: `mock ${o.name}`,
    params: paramsSchema as never,
    parametersJsonSchema: toJSONSchema(paramsSchema) as Record<string, unknown>,
    requires: o.requires,
    run: (o.run ?? (async () => ({ data: { ok: true } }))) as never,
  } as unknown as AiTool<never>;
}

const user = (caps: AiCapability[] = ["media.read", "projects.read"]): AiUserContext =>
  ({ id: "mo-u7", role: "employee", capabilities: new Set(caps) });

/** A provider that replays a script, recording what it was sent. */
function scriptedProvider(script: Array<Partial<AiCompletionResponse> | (() => never)>) {
  const seen: AiCompletionRequest[] = [];
  let i = 0;
  const provider: AiProvider = {
    info: () => ({ provider: "mock", model: "mock-1", baseUrl: "https://mock.invalid",
                   supportsStreaming: false, supportsStructuredOutput: true }),
    async generate(req) {
      /* Snapshot the messages. The orchestrator appends to ONE array across
         rounds, so storing the request by reference would make every captured
         turn show the final state — and an assertion about "what round 2 saw"
         would silently be checking round 3. */
      seen.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
      const step = script[Math.min(i++, script.length - 1)];
      if (typeof step === "function") step();
      return { text: "", model: "mock-1", finishReason: "stop", ...(step as object) } as AiCompletionResponse;
    },
    async generateStructured<T>(): Promise<AiStructuredResponse<T>> {
      throw new AiProviderError("provider_error", "not scripted");
    },
    async testConnection() {
      return { configured: true, provider: "mock", model: "mock-1", reachable: true,
               authenticated: true, modelAvailable: true, checkedAt: new Date().toISOString() };
    },
  };
  return { provider, seen, calls: () => i };
}

const callFor = (name: string, args: unknown = {}, id = "c1") =>
  ({ toolCalls: [{ id, name, argumentsRaw: JSON.stringify(args) }] });

describe("1–3. a request reaches the provider and the answer comes back", () => {
  it("sends the system prompt and the question, and returns the final answer", async () => {
    const { provider, seen } = scriptedProvider([{ text: "42 projects are active." }]);
    const r = await runAiOrchestration({
      provider, registry: new AiToolRegistry(), user: user(), question: "How many projects are active?",
    });

    expect(r.answer.answer).toBe("42 projects are active.");
    expect(r.stopReason).toBe("final_answer");
    expect(r.rounds).toBe(1);
    expect(seen[0].messages[0].role).toBe("system");
    expect(seen[0].messages[0].content).toContain("Nerve AI");
    expect(seen[0].messages[1]).toMatchObject({ role: "user", content: "How many projects are active?" });
  });

  it("does not advertise tools when the registry is empty", async () => {
    const { provider, seen } = scriptedProvider([{ text: "done" }]);
    await runAiOrchestration({ provider, registry: new AiToolRegistry(), user: user(), question: "hi" });
    expect(seen[0].tools).toBeUndefined();
  });

  it("reports no_answer rather than inventing one when the model returns nothing", async () => {
    const { provider } = scriptedProvider([{ text: "   " }]);
    const r = await runAiOrchestration({ provider, registry: new AiToolRegistry(), user: user(), question: "hi" });
    expect(r.stopReason).toBe("no_answer");
  });
});

describe("4–7. a tool round trip", () => {
  it("executes a registered tool and feeds the result back", async () => {
    const run = vi.fn(async () => ({ data: [{ id: 1, name: "Convocation" }] }));
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read", run }));
    const { provider, seen } = scriptedProvider([
      callFor("projects.list", { limit: 5 }),
      { text: "There is 1 active project: Convocation." },
    ]);

    const r = await runAiOrchestration({ provider, registry, user: user(), question: "list projects" });

    expect(run).toHaveBeenCalledTimes(1);
    expect(r.answer.answer).toContain("Convocation");
    expect(r.answer.sources).toEqual(["projects.list"]);
    expect(r.rounds).toBe(2);

    // The tool result was returned to the provider as a tool message.
    const second = seen[1].messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant" });
    expect(second.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    expect(String(second.at(-1)!.content)).toContain("Convocation");
  });

  it("advertises only the permitted tool definitions to the provider", async () => {
    const registry = new AiToolRegistry()
      .register(tool({ name: "projects.list", requires: "projects.read" }))
      .register(tool({ name: "team.workload", requires: "team.read" }));
    const { provider, seen } = scriptedProvider([{ text: "ok" }]);
    await runAiOrchestration({ provider, registry, user: user(["media.read", "projects.read"]), question: "q" });
    expect(seen[0].tools?.map((t) => t.name)).toEqual(["projects.list"]);
  });

  it("F. hands the tool the authenticated user context", async () => {
    let sawUser: AiUserContext | null = null;
    let sawCtx: { requestId: string } | null = null;
    const registry = new AiToolRegistry().register(tool({
      name: "projects.list", requires: "projects.read",
      run: async (u, _a) => { sawUser = u; return { data: [] }; },
    }));
    // capture ctx via a second tool shape
    const reg2 = new AiToolRegistry().register({
      ...tool({ name: "projects.list", requires: "projects.read" }),
      run: (async (u: AiUserContext, _a: unknown, ctx: { requestId: string }) => {
        sawUser = u; sawCtx = ctx; return { data: [] };
      }) as never,
    } as AiTool<never>);
    void registry;

    const { provider } = scriptedProvider([callFor("projects.list"), { text: "done" }]);
    const r = await runAiOrchestration({ provider, registry: reg2, user: user(), question: "q", requestId: "req-xyz" });

    expect(sawUser).toMatchObject({ id: "mo-u7", role: "employee" });
    expect(sawCtx).toMatchObject({ requestId: "req-xyz" });
    expect(r.requestId).toBe("req-xyz");
  });

  it("8. supports several tool rounds", async () => {
    const registry = new AiToolRegistry()
      .register(tool({ name: "projects.list", requires: "projects.read" }))
      .register(tool({ name: "projects.detail", requires: "projects.read" }));
    const { provider } = scriptedProvider([
      callFor("projects.list", {}, "c1"),
      callFor("projects.detail", {}, "c2"),
      { text: "final" },
    ]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });
    expect(r.rounds).toBe(3);
    expect(r.stopReason).toBe("final_answer");
    expect(new Set(r.answer.sources)).toEqual(new Set(["projects.list", "projects.detail"]));
  });

  it("runs several tool calls returned in one turn", async () => {
    const registry = new AiToolRegistry()
      .register(tool({ name: "projects.list", requires: "projects.read" }))
      .register(tool({ name: "projects.detail", requires: "projects.read" }));
    const { provider } = scriptedProvider([
      { toolCalls: [
        { id: "a", name: "projects.list", argumentsRaw: "{}" },
        { id: "b", name: "projects.detail", argumentsRaw: "{}" },
      ] },
      { text: "final" },
    ]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });
    expect(r.toolEvents).toHaveLength(2);
    expect(r.toolEvents.every((e) => e.success)).toBe(true);
  });
});

describe("H. the loop is bounded", () => {
  it("stops at four rounds when the model keeps calling tools", async () => {
    const run = vi.fn(async () => ({ data: { ok: true } }));
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read", run }));
    // Always asks for a tool; only the forced final turn returns prose.
    const { provider, seen } = scriptedProvider([
      callFor("projects.list"), callFor("projects.list"),
      callFor("projects.list"), callFor("projects.list"),
      { text: "partial answer" },
    ]);

    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });

    expect(DEFAULT_MAX_ROUNDS).toBe(4);
    expect(r.rounds).toBe(4);
    expect(r.stopReason).toBe("max_rounds");
    expect(r.answer.warnings?.join(" ")).toContain("tool budget");
    // Tools are withheld on the last round so the model must answer.
    expect(seen[3].tools).toBeUndefined();
  });

  it("honours a lower configured ceiling", async () => {
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read" }));
    const { provider } = scriptedProvider([callFor("projects.list"), { text: "stopped" }]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q", maxRounds: 1 });
    expect(r.rounds).toBe(1);
    expect(r.stopReason).toBe("max_rounds");
  });
});

describe("I. timeout stops execution", () => {
  it("returns a timeout result when the provider exceeds the deadline", async () => {
    const provider: AiProvider = {
      info: () => ({ provider: "mock", model: "m", baseUrl: "https://mock.invalid",
                     supportsStreaming: false, supportsStructuredOutput: false }),
      generate: (req: AiCompletionRequest) => new Promise((_res, rej) => {
        req.signal?.addEventListener("abort", () =>
          rej(new AiProviderError("timeout", "The AI provider did not respond in time.")));
      }),
      generateStructured: async () => { throw new AiProviderError("provider_error", "x"); },
      testConnection: async () => ({ configured: true, provider: "mock", model: "m", reachable: true,
        authenticated: true, modelAvailable: true, checkedAt: new Date().toISOString() }),
    };
    const r = await runAiOrchestration({
      provider, registry: new AiToolRegistry(), user: user(), question: "q", timeoutMs: 1000,
    });
    expect(r.stopReason).toBe("timeout");
    expect(r.answer.answer).toContain("too long");
  });
});

describe("11–13. K. tool calls that must be refused", () => {
  it("D/K. rejects a tool that was never registered, and does not crash", async () => {
    const { provider } = scriptedProvider([callFor("rm_minus_rf"), { text: "recovered" }]);
    const r = await runAiOrchestration({
      provider, registry: new AiToolRegistry(), user: user(), question: "q",
    });
    expect(r.stopReason).toBe("final_answer");
    expect(r.toolEvents[0]).toMatchObject({ toolName: "rm_minus_rf", success: false, error: "unknown tool" });
  });

  it("C. refuses a registered tool the user lacks the capability for", async () => {
    const run = vi.fn(async () => ({ data: { secret: true } }));
    const registry = new AiToolRegistry().register(tool({ name: "team.workload", requires: "team.read", run }));
    const { provider } = scriptedProvider([callFor("team.workload"), { text: "could not determine" }]);

    const r = await runAiOrchestration({
      provider, registry, user: user(["media.read", "projects.read"]), question: "who is overloaded?",
    });

    expect(run).not.toHaveBeenCalled();                       // never executed
    expect(r.toolEvents[0]).toMatchObject({ success: false, error: "unauthorized tool" });
    expect(r.answer.sources).toBeUndefined();
  });

  it("J. tells the model the same thing for unknown and unauthorized, so it cannot map the namespace", async () => {
    const registry = new AiToolRegistry().register(tool({ name: "team.workload", requires: "team.read" }));
    const u = user(["media.read"]);

    const a = scriptedProvider([callFor("team.workload"), { text: "x" }]);
    await runAiOrchestration({ provider: a.provider, registry, user: u, question: "q" });
    const b = scriptedProvider([callFor("does.not.exist"), { text: "x" }]);
    await runAiOrchestration({ provider: b.provider, registry, user: u, question: "q" });

    const msgA = String(a.seen[1].messages.at(-1)!.content);
    const msgB = String(b.seen[1].messages.at(-1)!.content);
    expect(msgA).toBe(msgB);
    expect(msgA).not.toContain("team.workload");
    expect(msgA).not.toMatch(/unauthor|permission|forbidden/i);
  });
});

describe("14. E. invalid arguments never reach the implementation", () => {
  it("rejects arguments that fail the schema", async () => {
    const run = vi.fn(async () => ({ data: { ok: true } }));
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read", run }));
    const { provider } = scriptedProvider([callFor("projects.list", { limit: 9999 }), { text: "done" }]);

    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });

    expect(run).not.toHaveBeenCalled();
    expect(r.toolEvents[0]).toMatchObject({ success: false, error: "invalid arguments" });
  });

  it("17. rejects arguments that are not JSON at all", async () => {
    const run = vi.fn(async () => ({ data: { ok: true } }));
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read", run }));
    const { provider } = scriptedProvider([
      { toolCalls: [{ id: "c1", name: "projects.list", argumentsRaw: "{not json" }] },
      { text: "done" },
    ]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });
    expect(run).not.toHaveBeenCalled();
    expect(r.toolEvents[0]).toMatchObject({ success: false, error: "malformed arguments" });
  });

  it("treats empty arguments as an empty object when the schema allows it", async () => {
    const run = vi.fn(async () => ({ data: { ok: true } }));
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read", run }));
    const { provider } = scriptedProvider([
      { toolCalls: [{ id: "c1", name: "projects.list", argumentsRaw: "" }] }, { text: "done" },
    ]);
    await runAiOrchestration({ provider, registry, user: user(), question: "q" });
    expect(run).toHaveBeenCalledWith(expect.anything(), {}, expect.anything());
  });

  it("records only VALIDATED arguments in the audit event, never the raw model text", async () => {
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read" }));
    const { provider } = scriptedProvider([callFor("projects.list", { limit: 5 }), { text: "done" }]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });
    expect(r.toolEvents[0].arguments).toEqual({ limit: 5 });
  });
});

describe("15–16. failures are handled, not leaked", () => {
  it("returns a clean message when the provider fails", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = scriptedProvider([() => { throw new AiProviderError("provider_error", "upstream exploded"); }]);
    const r = await runAiOrchestration({ provider, registry: new AiToolRegistry(), user: user(), question: "q" });
    expect(r.stopReason).toBe("provider_error");
    expect(r.answer.answer).toContain("currently unavailable");
    expect(errSpy).toHaveBeenCalled();
  });

  it("16. survives a tool that throws, and never surfaces its internals", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const registry = new AiToolRegistry().register(tool({
      name: "projects.list", requires: "projects.read",
      run: async () => { throw new Error('relation "mo_projects" does not exist at /srv/nerve/server/db.ts:42'); },
    }));
    const { provider, seen } = scriptedProvider([callFor("projects.list"), { text: "could not determine" }]);

    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });

    expect(r.stopReason).toBe("final_answer");
    const toolMsg = String(seen[1].messages.at(-1)!.content);
    for (const leak of ["mo_projects", "/srv/nerve", "db.ts", "relation"])
      expect(toolMsg).not.toContain(leak);
    expect(JSON.stringify(r.toolEvents)).not.toContain("mo_projects");
    expect(r.toolEvents[0]).toMatchObject({ success: false, error: "The tool failed to complete." });
  });
});

describe("18. the request id is preserved throughout", () => {
  it("uses a supplied id across the result and every tool event", async () => {
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read" }));
    const { provider } = scriptedProvider([callFor("projects.list"), { text: "done" }]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q", requestId: "trace-123" });
    expect(r.requestId).toBe("trace-123");
    expect(r.toolEvents.every((e) => e.requestId === "trace-123")).toBe(true);
  });

  it("generates a unique id when none is supplied", async () => {
    const { provider: p1 } = scriptedProvider([{ text: "a" }]);
    const { provider: p2 } = scriptedProvider([{ text: "b" }]);
    const base = { registry: new AiToolRegistry(), user: user(), question: "q" };
    const a = await runAiOrchestration({ provider: p1, ...base });
    const b = await runAiOrchestration({ provider: p2, ...base });
    expect(a.requestId).toBeTruthy();
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("records timing and user on every audit event", async () => {
    const registry = new AiToolRegistry().register(tool({ name: "projects.list", requires: "projects.read" }));
    const { provider } = scriptedProvider([callFor("projects.list"), { text: "done" }]);
    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });
    expect(r.toolEvents[0]).toMatchObject({ userId: "mo-u7", toolName: "projects.list", success: true });
    expect(typeof r.toolEvents[0].durationMs).toBe("number");
    expect(Date.parse(r.toolEvents[0].startedAt)).not.toBeNaN();
  });
});

describe("9. tool results are bounded before a model sees them", () => {
  it("caps rows and reports the truncation", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ i }));
    const r = boundToolResult(rows, 50);
    expect((r.value as unknown[]).length).toBe(50);
    expect(r.truncated).toBe(true);
    expect(r.note).toBe("Showing 50 of 500 rows.");
  });

  it("shrinks further when rows are individually enormous", () => {
    const rows = Array.from({ length: 40 }, () => ({ blob: "x".repeat(5_000) }));
    const r = boundToolResult(rows, 50, 20_000);
    expect((r.value as unknown[]).length).toBeLessThan(40);
    expect(r.truncated).toBe(true);
  });

  it("passes small results through untouched", () => {
    const r = boundToolResult([{ a: 1 }], 50);
    expect(r).toEqual({ value: [{ a: 1 }], truncated: false });
  });

  it("omits a non-array result that is too large rather than stringifying it", () => {
    const r = boundToolResult({ blob: "x".repeat(100_000) }, 50, 1_000);
    expect(r.value).toBeNull();
    expect(r.truncated).toBe(true);
  });

  it("flows the cap through the orchestrator and flags it to the model", async () => {
    const registry = new AiToolRegistry().register({
      ...tool({ name: "projects.list", requires: "projects.read" }),
      limit: { maxRows: 2 },
      run: (async () => ({ data: [1, 2, 3, 4, 5] })) as never,
    } as AiTool<never>);
    const { provider, seen } = scriptedProvider([callFor("projects.list"), { text: "done" }]);

    const r = await runAiOrchestration({ provider, registry, user: user(), question: "q" });

    const payload = JSON.parse(String(seen[1].messages.at(-1)!.content));
    expect(payload.data).toEqual([1, 2]);
    expect(payload.truncated).toBe(true);
    expect(payload.note).toBe("Showing 2 of 5 rows.");
    expect(r.toolEvents[0].truncated).toBe(true);
  });
});

describe("11. the structured answer keeps facts apart from recommendations", () => {
  it("splits them when finalizeStructured is requested", async () => {
    const { provider } = scriptedProvider([{ text: "Three projects are overdue." }]);
    provider.generateStructured = (async () => ({
      data: {
        answer: "Three projects are overdue.",
        facts: ["3 projects have passed their end date."],
        recommendations: ["Review the two oldest with their project managers."],
      },
      raw: "{}", model: "mock-1",
    })) as never;

    const r = await runAiOrchestration({
      provider, registry: new AiToolRegistry(), user: user(), question: "q", finalizeStructured: true,
    });
    expect(r.answer.facts).toEqual(["3 projects have passed their end date."]);
    expect(r.answer.recommendations).toHaveLength(1);
  });

  it("falls back to the prose answer when the structured pass fails", async () => {
    const { provider } = scriptedProvider([{ text: "Plain answer." }]);
    provider.generateStructured = (async () => { throw new AiProviderError("malformed_response", "not json"); }) as never;
    const r = await runAiOrchestration({
      provider, registry: new AiToolRegistry(), user: user(), question: "q", finalizeStructured: true,
    });
    expect(r.answer.answer).toBe("Plain answer.");
    expect(r.answer.warnings?.join(" ")).toContain("structured answer");
  });

  it("rejects a structured payload that does not match the schema", async () => {
    const { provider } = scriptedProvider([{ text: "Plain answer." }]);
    provider.generateStructured = (async () => ({ data: { nope: 1 }, raw: "{}", model: "m" })) as never;
    const r = await runAiOrchestration({
      provider, registry: new AiToolRegistry(), user: user(), question: "q", finalizeStructured: true,
    });
    expect(r.answer.answer).toBe("Plain answer.");
    expect(r.answer.facts).toBeUndefined();
  });

  it("leaves the answer as prose by default", async () => {
    const { provider } = scriptedProvider([{ text: "Prose." }]);
    const structured = vi.fn();
    provider.generateStructured = structured as never;
    const r = await runAiOrchestration({ provider, registry: new AiToolRegistry(), user: user(), question: "q" });
    expect(structured).not.toHaveBeenCalled();
    expect(r.answer.answer).toBe("Prose.");
  });
});
