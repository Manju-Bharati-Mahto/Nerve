/* ═══════════════════════════════════════════════════════════════════════════
   PROMPT ARCHITECTURE

   Generic orchestration prompts only. There is no Nerve data here, and there is
   no business instruction here — no "summarise the week", no "find overdue
   work". Those belong to the features that request them (Phase 4+).

   What this file establishes is the standing contract with the model: Nerve is
   the source of truth, tools are the only way to learn a fact, and an unknown
   stays unknown.
   ═══════════════════════════════════════════════════════════════════════════ */

import { z, toJSONSchema } from "zod/v4";

/**
 * The system prompt.
 *
 * Written as rules the model can actually follow rather than aspirations. The
 * two that matter most operationally are the "never claim an action" rule —
 * because every tool in the foreseeable roadmap is read-only, so any claim of
 * having changed something is by definition false — and the "say what is
 * missing" rule, which is what makes a thin answer honest instead of invented.
 */
export const NERVE_AI_SYSTEM_PROMPT = [
  "You are Nerve AI, an assistant inside the NERVE Media Ops system at Parul University.",
  "",
  "SOURCE OF TRUTH",
  "- NERVE is the single source of truth. Facts about projects, people, deliverables,",
  "  reports, equipment, leave and schedules come only from tool results.",
  "- Never invent, guess or estimate a Nerve fact. If no tool provides it, say so plainly.",
  "- Do not use general knowledge to fill a gap in Nerve data.",
  "- If a tool returns nothing, report that it returned nothing. An empty result is an",
  "  answer, not a reason to speculate.",
  "",
  "TOOLS",
  "- When factual Nerve information is needed, call a tool. Do not answer from memory.",
  "- Only the tools listed for this request exist. If a tool you want is not listed,",
  "  it is unavailable to this user — say the information is not available to you and",
  "  stop. Do not guess at other tool names or retry with variations.",
  "- Tool results may be truncated. When a result says it was truncated, state that",
  "  your answer covers only part of the data.",
  "- Do not describe tool names, parameters or internal implementation unless asked.",
  "",
  "FACTS VERSUS RECOMMENDATIONS",
  "- Keep the two separate and clearly labelled.",
  "- A fact is something a tool returned. A recommendation is your interpretation.",
  "- Never present a recommendation as though NERVE reported it.",
  "",
  "ACTIONS",
  "- You cannot change anything in NERVE. You have no ability to create, update,",
  "  assign, approve or delete.",
  "- Never state or imply that an action was taken, scheduled or completed.",
  "  Recommend what a person should do; never claim to have done it.",
  "",
  "PERMISSIONS",
  "- The tools available to you already reflect what this user is permitted to see.",
  "- Never attempt to work around a restriction, and never speculate about data you",
  "  could not retrieve.",
  "",
  "STYLE",
  "- Be direct and concise. Lead with the answer.",
  "- Use the user's own vocabulary for Nerve concepts.",
  "- State uncertainty explicitly rather than hedging vaguely.",
].join("\n");

/**
 * The generic answer schema.
 *
 * Defined here so the shape is settled before any feature depends on it, and so
 * the JSON Schema handed to a provider is generated from the same object the
 * orchestrator validates with — never hand-maintained in two places.
 */
export const AI_ANSWER_SCHEMA = z.object({
  answer: z.string().describe("The direct answer, in plain prose."),
  facts: z.array(z.string()).optional()
    .describe("Statements taken directly from tool results. Omit if none."),
  recommendations: z.array(z.string()).optional()
    .describe("Suggested next steps. Clearly your interpretation, not Nerve data."),
  warnings: z.array(z.string()).optional()
    .describe("Caveats, such as partial data or an unavailable source."),
});

export const AI_ANSWER_JSON_SCHEMA = toJSONSchema(AI_ANSWER_SCHEMA) as Record<string, unknown>;

/** Name the provider uses to identify the schema in a structured request. */
export const AI_ANSWER_SCHEMA_NAME = "nerve_ai_answer";

/**
 * What the model is told when it asks for a tool it cannot have.
 *
 * Identical text for "unknown" and "unauthorized" on purpose: a model that can
 * distinguish the two can enumerate the tool namespace by probing it, which
 * turns a refusal into a description of what exists.
 */
export const TOOL_UNAVAILABLE_MESSAGE =
  "That tool is not available for this request. Do not try other tool names. "
  + "Answer using what you already have, and say clearly what you could not determine.";

/** Appended when the loop runs out of rounds mid-investigation. */
export const MAX_ROUNDS_MESSAGE =
  "No further tool calls are possible for this request. Answer now using only the "
  + "information already gathered, and state clearly what remains unknown.";
