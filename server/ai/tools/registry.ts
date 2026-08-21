/* ═══════════════════════════════════════════════════════════════════════════
   AI TOOL REGISTRY

   The only door between a model and Nerve. Two rules do all the work:

     1. A model can only ever name a tool that is IN the registry.
     2. A tool only runs if the caller's capability set contains what it requires
        — checked at execution time, not merely at advertisement time.

   Rule 2 is the important one. Filtering the advertised list is a convenience
   for the model; it is not a security control, because the model's output is
   untrusted and it can name anything it likes. So `resolveFor()` re-checks, and
   the orchestrator never calls a tool it did not obtain from that method.

   PHASE 2: this registry ships EMPTY. Real Nerve tools are Phase 3.
   ═══════════════════════════════════════════════════════════════════════════ */

import { AiProviderError } from "../errors.js";
import { nerveTools } from "./nerve-tools.js";
import type { AiTool, AiToolDefinition, AiUserContext } from "../types.js";

/** Tool names are addressed by the model; keep them boring and predictable. */
const NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export class AiToolRegistry {
  private readonly tools = new Map<string, AiTool<never>>();

  /** Registration is a startup-time act by Nerve code, never by a model. */
  register<A>(tool: AiTool<A>): this {
    if (!NAME_RE.test(tool.name))
      throw new AiProviderError("invalid_config",
        `Invalid tool name "${tool.name}". Use lower_snake or dotted.lower_snake.`);
    if (this.tools.has(tool.name))
      throw new AiProviderError("invalid_config", `Tool "${tool.name}" is already registered.`);
    this.tools.set(tool.name, tool as unknown as AiTool<never>);
    return this;
  }

  registerAll(tools: AiTool<never>[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  size(): number { return this.tools.size; }

  /** Every registered tool, regardless of permission. Diagnostics only —
      never hand this to a model or to a request handler. */
  listAll(): AiTool<never>[] { return [...this.tools.values()]; }

  /** Unfiltered lookup. Private on purpose: callers must go through
      resolveFor(), which is the path that checks capability. */
  private find(name: string): AiTool<never> | undefined { return this.tools.get(name); }

  /** The tools this user may actually use. */
  listFor(user: AiUserContext): AiTool<never>[] {
    return this.listAll().filter((t) => user.capabilities.has(t.requires));
  }

  /**
   * What gets advertised to the model.
   *
   * A user who lacks a capability never learns the tool exists — the model is
   * not told about it, so it cannot be tempted to ask, and an answer cannot hint
   * at data the person may not see.
   */
  definitionsFor(user: AiUserContext): AiToolDefinition[] {
    return this.listFor(user).map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parametersJsonSchema,
    }));
  }

  /**
   * Resolve a tool the model asked for, for this user.
   *
   * Returns a discriminated result rather than throwing: an unknown or forbidden
   * tool is a normal thing for a model to produce, and the orchestrator turns it
   * into a message the model can recover from — not a request failure.
   *
   * "unauthorized" is reported to the orchestrator but described to the MODEL as
   * simply unavailable, so a refusal never becomes a map of what exists.
   */
  resolveFor(user: AiUserContext, name: string):
    | { ok: true; tool: AiTool<never> }
    | { ok: false; reason: "unknown" | "unauthorized" } {
    const tool = this.find(name);
    if (!tool) return { ok: false, reason: "unknown" };
    if (!user.capabilities.has(tool.requires)) return { ok: false, reason: "unauthorized" };
    return { ok: true, tool };
  }
}

/**
 * The registry the application uses.
 *
 * Phase 3 registers the first three real tools. Every one is read-only, every
 * one declares a capability, and none of them can be reached by a user whose
 * resolved capability set does not contain it.
 */
export function createAiToolRegistry(): AiToolRegistry {
  return new AiToolRegistry().registerAll(nerveTools());
}
