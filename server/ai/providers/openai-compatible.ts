/* ═══════════════════════════════════════════════════════════════════════════
   OPENAI-COMPATIBLE ADAPTER

   Speaks the /chat/completions wire format, which is the de-facto contract for
   OpenAI itself, Azure-style deployments, Groq, Together, Fireworks, vLLM,
   llama.cpp and Ollama's compatibility endpoint. Everything that varies between
   them — origin, credential, model id — is configuration, so pointing Nerve at
   a different one is an env change, not a code change.

   This is the ONLY file permitted to know that wire format. It has no import
   from anywhere in Nerve, no database handle, and no notion of a user.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  AiProviderError, fromTransportError, kindForStatus, redactSecret, summariseDetail,
} from "../errors.js";
import type {
  AiCompletionRequest, AiCompletionResponse, AiConnectionResult, AiProvider,
  AiProviderConfig, AiProviderInfo, AiStructuredRequest, AiStructuredResponse,
  AiToolCall, AiUsage,
} from "../types.js";

/** The subset of the response we rely on. Everything else is ignored. */
interface WireToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatCompletionBody {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

const mapUsage = (u: ChatCompletionBody["usage"]): AiUsage | undefined => {
  if (!u) return undefined;
  const p = Number(u.prompt_tokens ?? 0), c = Number(u.completion_tokens ?? 0);
  return { promptTokens: p, completionTokens: c, totalTokens: Number(u.total_tokens ?? p + c) };
};

/** A 400 that is really "this model does not exist here" deserves its own kind —
    it is the single most common misconfiguration and the fix is different. */
function looksLikeModelProblem(detail: string): boolean {
  const d = detail.toLowerCase();
  return d.includes("model") && (d.includes("not found") || d.includes("does not exist")
    || d.includes("unknown") || d.includes("invalid") || d.includes("no such"));
}

/**
 * Request-shape differences between models on the same endpoint.
 *
 * OpenAI's newer models reject `max_tokens` in favour of `max_completion_tokens`,
 * and some accept only the default `temperature`. Which model needs which is not
 * something this adapter should try to remember — a name-pattern guess would be
 * wrong the day a new model ships.
 *
 * So nothing is assumed. The first request goes out in the standard shape; if
 * the API objects, its own error text names the parameter at fault, and the
 * adapter adjusts and retries once. The adjustment then sticks for the life of
 * the process, so the correction is paid for once rather than per request.
 */
interface WireQuirks {
  useMaxCompletionTokens: boolean;
  omitTemperature: boolean;
}

/** Does this 400 tell us the request shape was wrong, rather than the content? */
function quirkFromError(detail: string): keyof WireQuirks | null {
  const d = detail.toLowerCase();
  if (d.includes("max_completion_tokens")) return "useMaxCompletionTokens";
  if (d.includes("temperature") && (d.includes("unsupported") || d.includes("not support")
      || d.includes("does not support") || d.includes("only the default")))
    return "omitTemperature";
  return null;
}

export class OpenAiCompatibleProvider implements AiProvider {
  private readonly quirks: WireQuirks = { useMaxCompletionTokens: false, omitTemperature: false };

  constructor(private readonly config: AiProviderConfig) {}

  info(): AiProviderInfo {
    return {
      provider: this.config.provider,
      model: this.config.model,
      baseUrl: this.config.baseUrl,
      // Declared, not implemented: the wire format supports SSE streaming, and
      // Phase 1 has no consumer for it. The flag lets a later phase branch
      // without re-interrogating the adapter.
      supportsStreaming: true,
      supportsStructuredOutput: true,
    };
  }

  /** One place builds a request, so one place attaches the credential. */
  private async call(path: string, init: { method: "GET" | "POST"; body?: unknown; signal?: AbortSignal }):
    Promise<{ status: number; ok: boolean; body: unknown; text: string }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.config.timeoutMs);
    // Honour a caller's cancellation as well as our own deadline.
    const onAbort = () => ctl.abort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const r = await fetch(this.config.baseUrl + path, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: ctl.signal,
      });
      const text = await r.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: r.status, ok: r.ok, body, text };
    } catch (e) {
      throw fromTransportError(e, this.config.apiKey);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Turn a non-2xx into a typed, redacted error. */
  private failure(status: number, body: unknown, text: string): AiProviderError {
    const b = body as ChatCompletionBody | null;
    const detail = summariseDetail(b?.error?.message ?? text ?? "", this.config.apiKey);
    if (status === 400 && looksLikeModelProblem(detail))
      return new AiProviderError("model_unavailable",
        `The AI provider rejected the model "${this.config.model}". ${detail}`, { status });
    const kind = kindForStatus(status);
    const lead = kind === "auth" ? "The AI provider rejected the API key."
      : kind === "rate_limit" ? "The AI provider is rate limiting requests."
      : kind === "provider_error" ? "The AI provider returned an error."
      : "The AI provider rejected the request.";
    return new AiProviderError(kind, detail ? `${lead} ${detail}` : lead, { status });
  }

  /* ── Translation, in both directions ─────────────────────────────────────
     This is the adapter's entire job where tools are concerned: turn the
     neutral representation into this provider's function-calling shape and
     back. It decides nothing about whether a tool may run — that is the
     orchestrator's, and only the orchestrator's. */

  private toWireMessage(m: AiCompletionRequest["messages"][number]): Record<string, unknown> {
    if (m.role === "tool")
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant" && m.toolCalls?.length)
      return {
        role: "assistant",
        // The wire format wants null, not "", for a pure tool-call turn.
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id, type: "function",
          function: { name: c.name, arguments: c.argumentsRaw },
        })),
      };
    return { role: m.role, content: m.content };
  }

  private static fromWireToolCalls(calls: WireToolCall[] | undefined): AiToolCall[] | undefined {
    if (!Array.isArray(calls) || !calls.length) return undefined;
    const out = calls
      .filter((c) => typeof c?.function?.name === "string" && c.function.name.length > 0)
      .map((c, i) => ({
        // Some compatible endpoints omit the id; the conversation still needs
        // one to pair the result with its request.
        id: c.id ?? `call_${i}`,
        name: String(c.function!.name),
        argumentsRaw: typeof c.function?.arguments === "string" ? c.function.arguments : "",
      }));
    return out.length ? out : undefined;
  }

  private buildBody(req: AiCompletionRequest, extra: Record<string, unknown> = {}) {
    const cap = req.maxOutputTokens ?? this.config.maxOutputTokens;
    return {
      model: this.config.model,
      messages: req.messages.map((m) => this.toWireMessage(m)),
      ...(this.quirks.useMaxCompletionTokens ? { max_completion_tokens: cap } : { max_tokens: cap }),
      ...(req.temperature === undefined || this.quirks.omitTemperature
        ? {} : { temperature: req.temperature }),
      // Omitted entirely when there are no tools, so a request without them is
      // byte-identical to what Phase 1 sent.
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
            tool_choice: req.toolChoice ?? "auto",
          }
        : {}),
      ...extra,
    };
  }

  private readText(body: unknown, status: number, text: string): { content: string; b: ChatCompletionBody } {
    const b = body as ChatCompletionBody | null;
    if (!b || !Array.isArray(b.choices) || !b.choices.length)
      throw new AiProviderError("malformed_response",
        `The AI provider returned an unexpected response shape. ${summariseDetail(text, this.config.apiKey)}`,
        { status });
    // content is legitimately null when the model was cut off at max_tokens, and
    // also when the turn is purely a tool call.
    return { content: b.choices[0]?.message?.content ?? "", b };
  }

  /**
   * Post a chat request, correcting the request shape at most once.
   *
   * The retry only ever fires on a 400 whose message names a parameter — never
   * on an auth failure, a rate limit, a server error or a content problem, none
   * of which a retry would help.
   */
  private async postChat(req: AiCompletionRequest, extra: Record<string, unknown> = {}) {
    let r = await this.call("/chat/completions", { method: "POST", body: this.buildBody(req, extra), signal: req.signal });
    if (!r.ok && r.status === 400) {
      const detail = summariseDetail((r.body as ChatCompletionBody | null)?.error?.message ?? r.text, this.config.apiKey);
      const quirk = quirkFromError(detail);
      if (quirk && !this.quirks[quirk]) {
        this.quirks[quirk] = true;
        r = await this.call("/chat/completions", { method: "POST", body: this.buildBody(req, extra), signal: req.signal });
      }
    }
    return r;
  }

  async generate(req: AiCompletionRequest): Promise<AiCompletionResponse> {
    const r = await this.postChat(req);
    if (!r.ok) throw this.failure(r.status, r.body, r.text);
    const { content, b } = this.readText(r.body, r.status, r.text);
    const toolCalls = OpenAiCompatibleProvider.fromWireToolCalls(b.choices?.[0]?.message?.tool_calls);
    return {
      text: content,
      model: b.model ?? this.config.model,
      finishReason: b.choices?.[0]?.finish_reason ?? null,
      usage: mapUsage(b.usage),
      // Reported, never executed.
      ...(toolCalls ? { toolCalls } : {}),
    };
  }

  /**
   * Structured output.
   *
   * The schema is passed straight through to the provider — the adapter never
   * inspects or validates it, because the meaning of a schema belongs to the
   * feature that defined it. What the adapter guarantees is narrower and
   * honest: the returned text parsed as JSON. Checking that the JSON matches
   * the schema is the caller's job (zod, in later phases).
   */
  async generateStructured<T = unknown>(req: AiStructuredRequest): Promise<AiStructuredResponse<T>> {
    const r = await this.postChat(req, {
      response_format: { type: "json_schema", json_schema: { name: req.schemaName, schema: req.schema, strict: true } },
    });
    if (!r.ok) throw this.failure(r.status, r.body, r.text);
    const { content, b } = this.readText(r.body, r.status, r.text);
    let data: T;
    try {
      data = JSON.parse(content) as T;
    } catch {
      throw new AiProviderError("malformed_response",
        "The AI provider did not return valid JSON for a structured request.", { status: r.status });
    }
    return { data, raw: content, model: b.model ?? this.config.model, usage: mapUsage(b.usage) };
  }

  /**
   * Connection probe.
   *
   * GET /models first: it is free, it proves both reachability and credentials,
   * and when the endpoint returns a catalogue it also tells us whether the
   * configured model exists. Endpoints that do not implement it fall through to
   * a one-token completion, which proves the same things at trivial cost.
   *
   * Every return path yields a plain, serialisable result — this method never
   * throws, so a caller cannot accidentally surface a stack trace containing a
   * request that had an Authorization header on it.
   */
  async testConnection(): Promise<AiConnectionResult> {
    const base: AiConnectionResult = {
      configured: true,
      provider: this.config.provider,
      model: this.config.model,
      reachable: false,
      authenticated: false,
      modelAvailable: null,
      checkedAt: new Date().toISOString(),
    };
    try {
      const list = await this.call("/models", { method: "GET" });
      if (list.status === 401 || list.status === 403)
        return { ...base, reachable: true, error: "The AI provider rejected the API key." };
      if (list.ok) {
        const data = (list.body as { data?: Array<{ id?: string }> } | null)?.data;
        const modelAvailable = Array.isArray(data) && data.length
          ? data.some((m) => m?.id === this.config.model)
          : null;   // reachable and authenticated, but the catalogue told us nothing
        return {
          ...base, reachable: true, authenticated: true, modelAvailable,
          ...(modelAvailable === false
            ? { error: `The provider is reachable but does not list the model "${this.config.model}".` }
            : {}),
        };
      }
      // 404/405 and friends: no catalogue here. Fall through and probe directly.
    } catch (e) {
      const err = e instanceof AiProviderError ? e : fromTransportError(e, this.config.apiKey);
      if (err.kind === "network" || err.kind === "timeout")
        return { ...base, error: redactSecret(err.message, this.config.apiKey) };
      // Any other failure: the catalogue is unusable but the host answered.
    }

    try {
      await this.generate({
        messages: [{ role: "user", content: "ping" }],
        maxOutputTokens: 1,
        temperature: 0,
      });
      return { ...base, reachable: true, authenticated: true, modelAvailable: true };
    } catch (e) {
      const err = e instanceof AiProviderError ? e : fromTransportError(e, this.config.apiKey);
      const msg = redactSecret(err.message, this.config.apiKey);
      switch (err.kind) {
        case "network": case "timeout":
          return { ...base, error: msg };
        case "auth":
          return { ...base, reachable: true, error: msg };
        case "model_unavailable":
          return { ...base, reachable: true, authenticated: true, modelAvailable: false, error: msg };
        default:
          // Reached it and got past auth, but the request itself failed.
          return { ...base, reachable: true, authenticated: true, error: msg };
      }
    }
  }
}
