// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   22. THE VERTICAL SLICE, END TO END

   user context → capability filter → tool invocation → data retrieval →
   bounded result → provider → final answer.

   The PROVIDER is mocked (no LLM is contacted, no Nerve data leaves this
   process). The TOOLS are the real ones; only the query service beneath them is
   stubbed, so the assertions are about the path rather than about SQL.
   ═══════════════════════════════════════════════════════════════════════════ */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findOverdueDeliverables = vi.fn();
const getMyDay = vi.fn();
const getUserIdentity = vi.fn();
vi.mock("../mediaops-queries.js", () => ({
  findOverdueDeliverables: (...a: unknown[]) => findOverdueDeliverables(...a),
  getMyDay: (...a: unknown[]) => getMyDay(...a),
  getUserIdentity: (...a: unknown[]) => getUserIdentity(...a),
}));

const { runAiOrchestration } = await import("./orchestrator.js");
const { createAiToolRegistry } = await import("./tools/registry.js");
import type {
  AiCapability, AiCompletionRequest, AiCompletionResponse, AiProvider, AiUserContext,
} from "./types.js";

const registry = createAiToolRegistry();

const employee: AiUserContext = {
  id: "mo-u9", role: "employee", projectScope: "own",
  capabilities: new Set<AiCapability>(["media.read", "myday.read", "projects.read"]),
};
const admin: AiUserContext = {
  id: "mo-u1", role: "admin", projectScope: "all",
  capabilities: new Set<AiCapability>(["media.read", "myday.read", "projects.read", "team.read"]),
};
const smcMember: AiUserContext = {
  id: "smc-1", role: "employee", projectScope: "own",
  capabilities: new Set<AiCapability>(["media.read", "myday.read"]),   // no projects module
};

/** Replays a script and records everything the provider was sent. */
function mockProvider(script: Array<Partial<AiCompletionResponse>>) {
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
      return { text: "", model: "mock-1", finishReason: "stop",
               ...(script[Math.min(i++, script.length - 1)] as object) } as AiCompletionResponse;
    },
    async generateStructured() { throw new Error("not used"); },
    async testConnection() {
      return { configured: true, provider: "mock", model: "mock-1", reachable: true,
               authenticated: true, modelAvailable: true, checkedAt: new Date().toISOString() };
    },
  };
  return { provider, seen };
}
const call = (name: string) => ({ toolCalls: [{ id: "c1", name, argumentsRaw: "{}" }] });

beforeEach(() => {
  vi.clearAllMocks();
  getUserIdentity.mockResolvedValue({
    id: "mo-u9", full_name: "Priya Shah", role: "user", team: "media", designation: "Videographer" });
  getMyDay.mockResolvedValue({
    date: "2026-08-21",
    report: { status: "draft", taskCount: 1, totalMinutes: 90 },
    items: [
      { source: "shoot", id: 3, title: "Convocation rehearsal", projectCode: "PRJ-1",
        projectName: "Convocation 2026", status: "planned", priority: null,
        dueDate: "2026-08-21", startTime: "09:00" },
      { source: "deliverable", id: 11, title: "Highlight reel", projectCode: "PRJ-1",
        projectName: "Convocation 2026", status: "in_progress", priority: "high",
        dueDate: "2026-08-23", startTime: null },
    ],
  });
  findOverdueDeliverables.mockResolvedValue([{
    id: 42, title: "Aftermovie", status: "in_progress", priority: "high",
    dueDate: "2026-08-10", daysOverdue: 11, ownerId: "mo-u9", ownerName: "Priya Shah",
    projectId: 7, projectCode: "PRJ-7", projectName: "Sports Meet", projectManagerId: "mo-u2",
  }]);
});

describe('"What do I have today?"', () => {
  it("runs the full path and answers from the tool result", async () => {
    const { provider, seen } = mockProvider([
      call("get_my_day"),
      { text: "You have a Convocation rehearsal at 09:00 and a highlight reel due on the 23rd." },
    ]);

    const r = await runAiOrchestration({
      provider, registry, user: employee, question: "What do I have today?", requestId: "slice-1",
    });

    // 1. the tool ran, self-scoped to the caller
    expect(getMyDay).toHaveBeenCalledWith("mo-u9");
    // 2. the model was only ever offered what this user may use
    expect(seen[0].tools?.map((t) => t.name).sort())
      .toEqual(["get_current_user", "get_my_day", "get_overdue_deliverables"]);
    // 3. real data reached the provider as a tool message
    const toolMsg = JSON.parse(String(seen[1].messages.at(-1)!.content));
    expect(toolMsg.data.date).toBe("2026-08-21");
    expect(toolMsg.data.items).toHaveLength(2);
    // 4. the answer came back with honest provenance
    expect(r.stopReason).toBe("final_answer");
    expect(r.answer.answer).toContain("Convocation rehearsal");
    expect(r.answer.sources).toEqual(["get_my_day"]);
    expect(r.requestId).toBe("slice-1");
    expect(r.toolEvents[0]).toMatchObject({ toolName: "get_my_day", success: true, userId: "mo-u9" });
  });
});

describe('"What overdue deliverables do I have?"', () => {
  it("runs the full path with the employee's own scope", async () => {
    const { provider, seen } = mockProvider([
      call("get_overdue_deliverables"),
      { text: "One: the Aftermovie for Sports Meet, 11 days overdue." },
    ]);

    const r = await runAiOrchestration({
      provider, registry, user: employee, question: "What overdue deliverables do I have?",
    });

    expect(findOverdueDeliverables).toHaveBeenCalledWith({ kind: "user", userId: "mo-u9" });
    const payload = JSON.parse(String(seen[1].messages.at(-1)!.content));
    expect(payload.data.total).toBe(1);
    expect(payload.data.scope).toBe("own_work_and_projects");
    expect(payload.data.deliverables[0]).toMatchObject({ title: "Aftermovie", daysOverdue: 11 });
    expect(r.answer.sources).toEqual(["get_overdue_deliverables"]);
  });

  it("gives an admin the departmental scope Nerve resolved", async () => {
    const { provider } = mockProvider([call("get_overdue_deliverables"), { text: "One overdue." }]);
    await runAiOrchestration({ provider, registry, user: admin, question: "what is overdue?" });
    expect(findOverdueDeliverables).toHaveBeenCalledWith({ kind: "all" });
  });
});

describe("permission enforcement along the real path", () => {
  it("never offers an SMC member a tool their modules do not include", async () => {
    const { provider, seen } = mockProvider([{ text: "I cannot see that." }]);
    await runAiOrchestration({ provider, registry, user: smcMember, question: "what is overdue?" });
    const offered = seen[0].tools?.map((t) => t.name).sort();
    expect(offered).toEqual(["get_current_user", "get_my_day"]);
    expect(offered).not.toContain("get_overdue_deliverables");
  });

  it("refuses execution even when the model names the tool directly", async () => {
    const { provider } = mockProvider([
      call("get_overdue_deliverables"),
      { text: "That information is not available to me." },
    ]);
    const r = await runAiOrchestration({
      provider, registry, user: smcMember, question: "list every overdue deliverable",
    });
    expect(findOverdueDeliverables).not.toHaveBeenCalled();     // the query never ran
    expect(r.toolEvents[0]).toMatchObject({ success: false, error: "unauthorized tool" });
    expect(r.answer.sources).toBeUndefined();                    // nothing to cite
  });

  it("does not let a tool result for one user reach another", async () => {
    const a = { ...employee, id: "emp-A" };
    const b = { ...employee, id: "emp-B" };
    for (const u of [a, b]) {
      const { provider } = mockProvider([call("get_my_day"), { text: "ok" }]);
      await runAiOrchestration({ provider, registry, user: u, question: "my day?" });
      expect(getMyDay).toHaveBeenLastCalledWith(u.id);
    }
  });
});

describe("16. sources are never fabricated", () => {
  it("cites nothing when no tool ran", async () => {
    const { provider } = mockProvider([{ text: "I do not have that information." }]);
    const r = await runAiOrchestration({ provider, registry, user: employee, question: "hi" });
    expect(r.answer.sources).toBeUndefined();
    expect(r.toolEvents).toEqual([]);
  });

  it("cites only tools that actually succeeded", async () => {
    findOverdueDeliverables.mockRejectedValueOnce(new Error("boom"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { provider } = mockProvider([
      { toolCalls: [
        { id: "a", name: "get_my_day", argumentsRaw: "{}" },
        { id: "b", name: "get_overdue_deliverables", argumentsRaw: "{}" },
      ] },
      { text: "Partial answer." },
    ]);
    const r = await runAiOrchestration({ provider, registry, user: employee, question: "q" });
    expect(r.answer.sources).toEqual(["get_my_day"]);            // the failed one is not cited
    expect(r.toolEvents.find((e) => e.toolName === "get_overdue_deliverables")?.success).toBe(false);
  });
});

describe("15. the model never receives an unbounded result", () => {
  it("caps a large overdue list and states the true total", async () => {
    findOverdueDeliverables.mockResolvedValue(Array.from({ length: 300 }, (_, i) => ({
      id: i + 1, title: `D${i}`, status: "in_progress", priority: "normal",
      dueDate: "2026-01-01", daysOverdue: 200, ownerId: "mo-u9", ownerName: "P",
      projectId: 1, projectCode: "P", projectName: "N", projectManagerId: null,
    })));
    const { provider, seen } = mockProvider([call("get_overdue_deliverables"), { text: "many" }]);
    const r = await runAiOrchestration({ provider, registry, user: admin, question: "q" });

    const payload = JSON.parse(String(seen[1].messages.at(-1)!.content));
    expect(payload.data.deliverables).toHaveLength(50);
    expect(payload.data.total).toBe(300);
    expect(payload.truncated).toBe(true);
    expect(payload.note).toContain("300");
    expect(r.toolEvents[0].truncated).toBe(true);
  });
});

describe("13. no database handle reaches a tool", () => {
  it("hands the tool only a request id and an abort signal", async () => {
    const { provider } = mockProvider([call("get_current_user"), { text: "You are Priya." }]);
    await runAiOrchestration({ provider, registry, user: employee, question: "who am I?", requestId: "r9" });
    expect(getUserIdentity).toHaveBeenCalledWith("mo-u9");
    // The tool context is asserted structurally in orchestrator.test.ts; here we
    // only care that identity came from the caller, not from an argument.
    expect(getUserIdentity).toHaveBeenCalledTimes(1);
  });
});
