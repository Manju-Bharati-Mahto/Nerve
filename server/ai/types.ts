/* ═══════════════════════════════════════════════════════════════════════════
   AI PROVIDER CONTRACTS — vendor-neutral by construction.

   Nothing in this file names a vendor, and nothing in it knows what Nerve is.
   That is the whole point of the boundary: an adapter may speak any wire format
   it likes, and the rest of Nerve only ever sees these shapes. A second adapter
   (Anthropic, Bedrock, a local runtime) is added by implementing AiProvider —
   no call site changes.

   Phase 1 deliberately stops here: these types describe how to TALK to a model,
   never what to say to it. Prompts, tools and context live in later phases.
   ═══════════════════════════════════════════════════════════════════════════ */

/** Resolved, validated provider configuration. Only ever built by resolveAiConfig(). */
export interface AiProviderConfig {
  /** Adapter key — selects the wire format, not a specific vendor's servers. */
  provider: string;
  /** API root, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1 */
  baseUrl: string;
  /** Secret. Never leaves this process — see errors.ts redaction. */
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

export type AiRole = "system" | "user" | "assistant" | "tool";

export interface AiMessage {
  role: AiRole;
  content: string;
  /** Assistant turns only: the tool invocations the model asked for. */
  toolCalls?: AiToolCall[];
  /** Tool turns only: which call this message is the result of. */
  toolCallId?: string;
}

/** A tool invocation requested BY the model. `argumentsRaw` is untrusted text —
    it is model output, not validated input, and must be parsed and schema-checked
    before it reaches any implementation. */
export interface AiToolCall {
  id: string;
  name: string;
  argumentsRaw: string;
}

/** A tool as advertised TO the model. Deliberately wire-shaped and minimal: the
    adapter translates this into whatever the provider's function-calling format
    is, and nothing about Nerve leaks into it beyond a name and a description. */
export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema, generated from the tool's own schema — one source of truth. */
  parameters: Record<string, unknown>;
}

export interface AiCompletionRequest {
  messages: AiMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Lets a caller cancel; the adapter also applies its own configured timeout. */
  signal?: AbortSignal;
  /** Tools the model may request. Omitted entirely when empty, so a provider
      that does not support function calling behaves exactly as it did before. */
  tools?: AiToolDefinition[];
  /** "auto" lets the model decide; "none" forbids tool use for this turn. */
  toolChoice?: "auto" | "none";
}

/** A generic JSON Schema. Deliberately untyped: business schemas belong to the
    feature that needs them (Phase 4+), never to the provider layer. */
export type AiJsonSchema = Record<string, unknown>;

export interface AiStructuredRequest extends AiCompletionRequest {
  /** Schema identifier passed through to providers that require one. */
  schemaName: string;
  schema: AiJsonSchema;
}

/** Token counts as reported by the provider. Optional: not every
    OpenAI-compatible endpoint returns a usage block. */
export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AiCompletionResponse {
  text: string;
  model: string;
  finishReason: string | null;
  usage?: AiUsage;
  /** Present when the model wants tools run. The provider NEVER executes them —
      it only reports the request. Execution belongs to the orchestrator. */
  toolCalls?: AiToolCall[];
}

export interface AiStructuredResponse<T = unknown> {
  /** Parsed JSON. Shape validation is the CALLER's job — the provider only
      guarantees this is valid JSON, not that it matches your schema. */
  data: T;
  /** The raw text, kept so a caller can log or re-parse after a schema failure. */
  raw: string;
  model: string;
  usage?: AiUsage;
}

/** Static capability metadata. Read without contacting the provider. */
export interface AiProviderInfo {
  provider: string;
  model: string;
  baseUrl: string;
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
}

/** The result of a live connection probe. Every field here is safe to return
    over HTTP — there is no key, no header and no raw provider payload in it. */
export interface AiConnectionResult {
  configured: boolean;
  provider: string | null;
  model: string | null;
  reachable: boolean;
  authenticated: boolean;
  /** Whether the configured model was accepted. null = could not be determined. */
  modelAvailable: boolean | null;
  checkedAt: string;
  /** Sanitised, truncated failure summary. Never contains the API key. */
  error?: string;
}

export interface AiProvider {
  info(): AiProviderInfo;
  generate(req: AiCompletionRequest): Promise<AiCompletionResponse>;
  generateStructured<T = unknown>(req: AiStructuredRequest): Promise<AiStructuredResponse<T>>;
  testConnection(): Promise<AiConnectionResult>;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ORCHESTRATION CONTRACTS (Phase 2)

   Everything above describes talking to a model. Everything below describes
   what the orchestrator is allowed to do on a user's behalf — still with no
   Nerve data anywhere in sight.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * The capability a tool requires.
 *
 * This is deliberately a SMALL, closed set of read intents, not a permission
 * system. The AI layer never decides whether a user holds one of these — it is
 * told, by the Nerve-side caller, using the permission helpers that already
 * exist. That direction of dependency is what stops this becoming a second RBAC:
 *
 *     Nerve authenticated user
 *       → existing Nerve permission checks   (mediaops-api.ts, unchanged)
 *       → AiUserContext.capabilities         (the result, handed in)
 *       → tool allowed / denied              (here)
 *
 * A capability can only ever NARROW what a user can reach. Nothing here can
 * grant access that Nerve itself would refuse.
 */
export const AI_CAPABILITIES = [
  "media.read",       // any Media Crew member — the baseline
  "myday.read",       // one's own scheduled day
  "projects.read",
  "reports.read",
  "team.read",        // workload / capacity
  "equipment.read",
  "leave.read",
  "events.read",
  "automation.read",  // alerts and system events the rules engine produced
  "smc.read",
] as const;

export type AiCapability = (typeof AI_CAPABILITIES)[number];

/**
 * Which EXISTING Nerve capability each AI capability must be derived from.
 *
 * Documentation, not an evaluator: nothing in server/ai/ reads this to make a
 * decision. It exists so Phase 3 wires the context from the real permission
 * layer instead of inventing a parallel taxonomy. The right-hand values are the
 * keys already present in the CAPS map and the module registry.
 */
export const AI_CAPABILITY_SOURCE: Record<AiCapability, string> = {
  "media.read":      "requireMedia()",                       // moRoleOf(u) !== null
  "myday.read":      "module:my-day",
  "projects.read":   "module:projects (CAPS pipeline.view)",
  "reports.read":    "role admin|team_lead + module:reports (CAPS team.workload)",
  "team.read":       "role admin|team_lead + module:team (CAPS team.workload)",
  "equipment.read":  "module:equipment (CAPS equipment.book)",
  "leave.read":      "module:leave (CAPS leave.request)",
  "events.read":     "module:projects (CAPS pipeline.view)",
  "automation.read": "isMoAdmin() (CAPS admin.audit)",
  "smc.read":        "isSmcManager() — duty smc_manager (CAPS smc.manage)",
};

/**
 * The minimum identity the AI layer needs.
 *
 * Deliberately NOT the Nerve user record: no name, no email, no team, no
 * profile. An id for audit, a role for prompt framing, and the resolved
 * capability set. Nothing here is ever put into a prompt.
 */
export interface AiUserContext {
  id: string;
  /** The media-ops role vocabulary: "admin" | "team_lead" | "employee". Carried
      for audit and prompt framing ONLY — never used to make a permission
      decision inside server/ai/. */
  role: string;
  capabilities: ReadonlySet<AiCapability>;
  /**
   * How far this user's project/deliverable visibility reaches, already decided
   * by Nerve.
   *
   * Resolved rather than derived on purpose: if a tool inspected `role` to work
   * out its own scope, the scoping rule would live in two places and the AI
   * layer would be making an authorisation decision. It receives the answer.
   *
   *   "all" → the whole department (Admin, Team Lead — mirrors visibleProjects())
   *   "own" → work they own, or on projects they own / are assigned to
   */
  projectScope: "all" | "own";
}

/** Per-execution context handed to a tool. No database handle, by design. */
export interface AiToolContext {
  requestId: string;
  /** Cancels when the orchestration deadline passes. */
  signal: AbortSignal;
}

/** What a tool returns. `data` must be JSON-serialisable and already bounded by
    the tool itself; the orchestrator enforces a ceiling regardless. */
export interface AiToolResult {
  data: unknown;
  /** Set when the tool itself dropped rows to stay within its own limit. */
  truncated?: boolean;
  /** Short operator/model-facing note, e.g. "showing first 50 of 214". */
  note?: string;
}

/** Size ceiling applied to a tool's output before it is shown to the model. */
export interface AiResultLimit {
  maxRows?: number;
  maxBytes?: number;
}

/**
 * A tool the model may call.
 *
 * `params` is a schema object with a `safeParse` method — in practice a zod
 * schema. Typing it structurally rather than importing zod here keeps this
 * contract free of any particular validation library.
 */
export interface AiParamsSchema<A = unknown> {
  safeParse(input: unknown): { success: true; data: A } | { success: false; error: unknown };
}

export interface AiTool<A = unknown> {
  /** Stable identifier the model uses. Snake/dot case, no spaces. */
  name: string;
  description: string;
  params: AiParamsSchema<A>;
  /** JSON Schema for the wire, derived from `params` — never hand-maintained. */
  parametersJsonSchema: Record<string, unknown>;
  requires: AiCapability;
  limit?: AiResultLimit;
  run(user: AiUserContext, args: A, ctx: AiToolContext): Promise<AiToolResult>;
}

/**
 * One tool execution, recorded for a future audit logger.
 *
 * `arguments` holds the VALIDATED arguments, never the model's raw text, and
 * never a prompt or a model response. Phase 8 persists this; Phase 2 only
 * returns it, so the shape is settled before anything depends on it.
 */
export interface AiToolCallEvent {
  requestId: string;
  userId: string;
  toolName: string;
  arguments: unknown;
  startedAt: string;
  durationMs: number;
  success: boolean;
  /** Sanitised failure summary. Never a stack trace, SQL, or a path. */
  error?: string;
  /** Whether the result was cut down to fit the size ceiling. */
  truncated?: boolean;
}

/** Why the orchestration loop stopped. */
export type AiStopReason =
  | "final_answer"
  | "max_rounds"
  | "timeout"
  | "provider_error"
  | "no_answer";

/**
 * The generic answer shape.
 *
 * The one requirement that matters: a stated FACT (grounded in a tool result)
 * stays distinguishable from a RECOMMENDATION (the model's interpretation).
 * `sources` names the tools that actually ran, so a caller can always show what
 * an answer was built from.
 */
export interface AiAnswer {
  answer: string;
  facts?: string[];
  recommendations?: string[];
  sources?: string[];
  warnings?: string[];
}

export interface AiOrchestrationResult {
  requestId: string;
  answer: AiAnswer;
  stopReason: AiStopReason;
  rounds: number;
  toolEvents: AiToolCallEvent[];
  usage?: AiUsage;
  model?: string;
}
