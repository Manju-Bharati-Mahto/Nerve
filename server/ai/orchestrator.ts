/* ═══════════════════════════════════════════════════════════════════════════
   AI ORCHESTRATOR

   Owns tool selection, permission enforcement, execution and loop control.
   Deliberately contains NO business logic: there is no "find overdue work" and
   no "calculate workload" here, and there never should be. Those live in tools.
   Read this file as a state machine, not as a feature.

   The provider is never given the ability to execute anything. It reports that
   the model asked for a tool; this file decides whether that may happen.

   PHASE 2: the registry it drives is empty, so in production this currently
   loops zero times and returns the model's direct answer.
   ═══════════════════════════════════════════════════════════════════════════ */

import { randomUUID } from "node:crypto";
import { prepareAiContextForProvider } from "./egress.js";
import { AiProviderError, describeError, summariseDetail } from "./errors.js";
import {
  AI_ANSWER_JSON_SCHEMA, AI_ANSWER_SCHEMA, AI_ANSWER_SCHEMA_NAME,
  MAX_ROUNDS_MESSAGE, NERVE_AI_SYSTEM_PROMPT, TOOL_UNAVAILABLE_MESSAGE,
} from "./prompts.js";
import type { AiToolRegistry } from "./tools/registry.js";
import type {
  AiAnswer, AiMessage, AiOrchestrationResult, AiProvider, AiStopReason,
  AiToolCall, AiToolCallEvent, AiUserContext, AiUsage,
} from "./types.js";

/** Ceilings. Deliberately small — a request that needs more than four rounds of
    tool calls is asking the wrong question, and an unbounded loop is a bill. */
export const DEFAULT_MAX_ROUNDS = 4;
export const DEFAULT_ORCHESTRATION_TIMEOUT_MS = 60_000;
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 32_000;
export const DEFAULT_TOOL_RESULT_MAX_ROWS = 50;

export interface AiOrchestrationInput {
  provider: AiProvider;
  registry: AiToolRegistry;
  user: AiUserContext;
  /** The person's question. Never contains Nerve data assembled by us. */
  question: string;
  /** Extra framing for a specific feature (Phase 4+). Never raw Nerve data. */
  systemExtra?: string;
  maxRounds?: number;
  timeoutMs?: number;
  /** Reuse an id from the caller so one trace spans the whole request. */
  requestId?: string;
  /** Ask the model for the structured answer shape on its final turn. */
  finalizeStructured?: boolean;
}

/**
 * Cut a tool result down to something safe to show a model.
 *
 * Two ceilings, because they fail differently: a row cap keeps a list readable,
 * and a byte cap is the backstop for rows that are individually enormous. An
 * array is shrunk element-wise so the result stays the same SHAPE — a model that
 * receives a truncated array can still reason about it, where a string saying
 * "too big" just destroys the turn.
 */
export function boundToolResult(
  data: unknown,
  maxRows = DEFAULT_TOOL_RESULT_MAX_ROWS,
  maxBytes = DEFAULT_TOOL_RESULT_MAX_BYTES,
): { value: unknown; truncated: boolean; note?: string } {
  const size = (v: unknown) => { try { return JSON.stringify(v)?.length ?? 0; } catch { return Infinity; } };

  if (Array.isArray(data)) {
    const total = data.length;
    let rows = data.slice(0, maxRows);
    let truncated = rows.length < total;
    while (rows.length > 0 && size(rows) > maxBytes) { rows = rows.slice(0, Math.floor(rows.length / 2)); truncated = true; }
    if (rows.length === 0 && total > 0)
      return { value: [], truncated: true, note: `Result omitted: ${total} rows exceeded the size limit.` };
    return truncated
      ? { value: rows, truncated: true, note: `Showing ${rows.length} of ${total} rows.` }
      : { value: rows, truncated: false };
  }

  if (size(data) > maxBytes)
    return { value: null, truncated: true, note: "Result omitted: it exceeded the size limit." };
  return { value: data, truncated: false };
}

/** Never let a tool's internals reach a model or a user. */
function safeToolError(e: unknown): string {
  if (e instanceof AiProviderError) return e.message;
  // A tool failure could be anything, including a database error carrying SQL.
  // Report that it failed and nothing about how.
  return "The tool failed to complete.";
}

export async function runAiOrchestration(input: AiOrchestrationInput): Promise<AiOrchestrationResult> {
  const requestId = input.requestId ?? randomUUID();
  const maxRounds = Math.max(1, input.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const timeoutMs = Math.max(1_000, input.timeoutMs ?? DEFAULT_ORCHESTRATION_TIMEOUT_MS);
  const { provider, registry, user } = input;

  const toolEvents: AiToolCallEvent[] = [];
  const warnings: string[] = [];
  const usedTools = new Set<string>();
  let usage: AiUsage | undefined;
  let model: string | undefined;
  let rounds = 0;

  /* One deadline for the whole orchestration, passed into every provider call
     and every tool. A per-call timeout alone would let four slow rounds add up
     to four times the budget. */
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const timedOut = () => deadline.signal.aborted;

  const system = input.systemExtra
    ? `${NERVE_AI_SYSTEM_PROMPT}\n\n${input.systemExtra}`
    : NERVE_AI_SYSTEM_PROMPT;

  const messages: AiMessage[] = [
    { role: "system", content: system },
    { role: "user", content: input.question },
  ];

  const finish = (answer: AiAnswer, stopReason: AiStopReason): AiOrchestrationResult => {
    clearTimeout(timer);
    if (usedTools.size) answer.sources = [...usedTools];
    if (warnings.length) answer.warnings = [...(answer.warnings ?? []), ...warnings];
    return { requestId, answer, stopReason, rounds, toolEvents, usage, model };
  };

  /* Optional second pass that asks the model to split what it just said into
     facts and recommendations. Kept separate from the tool loop on purpose:
     combining tool calling with a forced response_format is the least portable
     corner of the OpenAI-compatible contract, and a provider that handles one
     but not both would break the whole request instead of just this refinement.

     Failure here is never fatal — the prose answer is already correct, so a
     structured pass that fails simply leaves it as prose. */
  const refine = async (text: string): Promise<AiAnswer> => {
    if (!input.finalizeStructured) return { answer: text };
    if (timedOut()) return { answer: text };
    try {
      const r = await provider.generateStructured({
        messages: [
          { role: "system", content: system },
          ...messages.slice(1),
          { role: "assistant", content: text },
          { role: "user", content:
            "Restate that answer in the required structure. Put statements taken from tool "
            + "results in `facts`, and your own interpretation in `recommendations`. Invent nothing." },
        ],
        schemaName: AI_ANSWER_SCHEMA_NAME,
        schema: AI_ANSWER_JSON_SCHEMA,
        signal: deadline.signal,
      });
      usage = r.usage ?? usage;
      // The provider guarantees JSON, not that it matches the schema — validate.
      const parsed = AI_ANSWER_SCHEMA.safeParse(r.data);
      if (!parsed.success) { warnings.push("The structured answer could not be validated; showing the plain answer."); return { answer: text }; }
      return { ...parsed.data, answer: parsed.data.answer || text };
    } catch {
      warnings.push("The structured answer could not be produced; showing the plain answer.");
      return { answer: text };
    }
  };

  try {
    /* The advertised list is computed ONCE from the user's capabilities. It is a
       convenience for the model, never the security boundary — every call is
       re-resolved against the registry below. */
    const definitions = registry.definitionsFor(user);

    while (rounds < maxRounds) {
      if (timedOut()) return finish({ answer: "The request took too long to complete." }, "timeout");

      const lastRound = rounds === maxRounds - 1;
      let response;
      try {
        response = await provider.generate({
          messages,
          signal: deadline.signal,
          // Stop offering tools on the final round: the model must answer now.
          ...(definitions.length && !lastRound ? { tools: definitions, toolChoice: "auto" as const } : {}),
        });
      } catch (e) {
        if (e instanceof AiProviderError && e.kind === "timeout")
          return finish({ answer: "The request took too long to complete." }, "timeout");
        console.error(`AI orchestration ${requestId} provider failure:`, describeError(e));
        return finish({ answer: "The AI provider is currently unavailable. Please try again." }, "provider_error");
      }

      rounds++;
      usage = response.usage ?? usage;
      model = response.model ?? model;

      const calls = response.toolCalls ?? [];
      if (!calls.length) {
        const text = response.text.trim();
        if (!text) return finish({ answer: "No answer was produced for this request." }, "no_answer");
        return finish(await refine(text), "final_answer");
      }

      // Echo the assistant's tool request back, then answer each one.
      messages.push({ role: "assistant", content: response.text ?? "", toolCalls: calls });
      for (const call of calls) {
        const { content, event } = await executeToolCall({ call, registry, user, requestId, signal: deadline.signal });
        if (event) { toolEvents.push(event); if (event.success) usedTools.add(event.toolName); }
        messages.push({ role: "tool", content, toolCallId: call.id });
      }

      if (rounds >= maxRounds) break;
    }

    /* Out of rounds with tools still outstanding. Rather than returning nothing,
       give the model one final turn with tools withheld — the honest answer is
       whatever it can say from what it already gathered. */
    if (timedOut()) return finish({ answer: "The request took too long to complete." }, "timeout");
    warnings.push("The answer may be incomplete: the tool budget for this request was reached.");
    messages.push({ role: "user", content: MAX_ROUNDS_MESSAGE });
    try {
      const final = await provider.generate({ messages, signal: deadline.signal });
      usage = final.usage ?? usage;
      model = final.model ?? model;
      const text = final.text.trim();
      if (!text) return finish({ answer: "No answer was produced for this request." }, "max_rounds");
      return finish(await refine(text), "max_rounds");
    } catch (e) {
      if (e instanceof AiProviderError && e.kind === "timeout")
        return finish({ answer: "The request took too long to complete." }, "timeout");
      console.error(`AI orchestration ${requestId} provider failure:`, describeError(e));
      return finish({ answer: "The AI provider is currently unavailable. Please try again." }, "provider_error");
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run one tool call the model asked for.
 *
 * Every failure returns a message the MODEL can read and recover from, because
 * a bad tool call is normal model behaviour, not a request-level error. What it
 * never returns is anything about why a tool was refused, or anything from
 * inside a failing implementation.
 */
async function executeToolCall(o: {
  call: AiToolCall; registry: AiToolRegistry; user: AiUserContext; requestId: string; signal: AbortSignal;
}): Promise<{ content: string; event?: AiToolCallEvent }> {
  const { call, registry, user, requestId, signal } = o;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const base = { requestId, userId: user.id, toolName: call.name, startedAt };

  // 1. Does it exist, and may this user use it? Re-checked here — the advertised
  //    list is not trusted, because the name came from model output.
  const resolved = registry.resolveFor(user, call.name);
  if (!resolved.ok) {
    return {
      content: TOOL_UNAVAILABLE_MESSAGE,
      event: { ...base, arguments: null, durationMs: Date.now() - t0, success: false,
               error: resolved.reason === "unknown" ? "unknown tool" : "unauthorized tool" },
    };
  }
  const tool = resolved.tool;

  // 2. Is the argument text even JSON? Model output, so assume nothing.
  let parsedJson: unknown;
  try {
    parsedJson = call.argumentsRaw?.trim() ? JSON.parse(call.argumentsRaw) : {};
  } catch {
    return {
      content: "Those arguments were not valid JSON. Call the tool again with valid JSON arguments.",
      event: { ...base, arguments: null, durationMs: Date.now() - t0, success: false, error: "malformed arguments" },
    };
  }

  // 3. Does it satisfy the schema? Invalid arguments never reach an implementation.
  const check = tool.params.safeParse(parsedJson);
  if (!check.success) {
    return {
      content: "Those arguments did not match the tool's schema. Check the parameters and call it again.",
      event: { ...base, arguments: null, durationMs: Date.now() - t0, success: false, error: "invalid arguments" },
    };
  }
  const args = check.data;

  // 4. Execute, then bound the result before the model ever sees it.
  try {
    if (signal.aborted) throw new AiProviderError("timeout", "The request took too long to complete.");
    const result = await tool.run(user, args as never, { requestId, signal });
    /* The egress boundary. Every tool result crosses it, so no tool can hand a
       provider anything the policy forbids — see server/ai/egress.ts. */
    const safe = prepareAiContextForProvider(tool.name, result.data);
    const bounded = boundToolResult(safe.value, tool.limit?.maxRows, tool.limit?.maxBytes);
    const truncated = bounded.truncated || !!result.truncated;
    const note = bounded.note ?? result.note;
    const payload = { data: bounded.value, ...(truncated ? { truncated: true } : {}), ...(note ? { note } : {}) };
    return {
      content: JSON.stringify(payload),
      event: { ...base, arguments: args, durationMs: Date.now() - t0, success: true, ...(truncated ? { truncated } : {}) },
    };
  } catch (e) {
    const message = safeToolError(e);
    console.error(`AI tool "${call.name}" failed in request ${requestId}:`, summariseDetail(describeError(e)));
    return {
      content: `That tool could not complete: ${message} Continue without it, and say what you could not determine.`,
      event: { ...base, arguments: args, durationMs: Date.now() - t0, success: false, error: message },
    };
  }
}
