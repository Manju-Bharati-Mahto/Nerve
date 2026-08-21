/* ═══════════════════════════════════════════════════════════════════════════
   PROVIDER FACTORY

   The registry that turns a config into an adapter. Pure: it reads no
   environment and imports nothing from Nerve, so the whole selection rule is
   testable on its own.

   Adding Anthropic, Bedrock or a local runtime later means writing one adapter
   and adding one line here. No call site changes, because every caller depends
   on the AiProvider interface rather than on a class.
   ═══════════════════════════════════════════════════════════════════════════ */

import { AiProviderError } from "./errors.js";
import { OpenAiCompatibleProvider } from "./providers/openai-compatible.js";
import type { AiProvider, AiProviderConfig } from "./types.js";

type AdapterFactory = (config: AiProviderConfig) => AiProvider;

/* Aliases are names an operator is likely to type in AI_PROVIDER. They all
   resolve to the same wire format — which is the point: "groq" is not special
   cased anywhere in the code, it is just an origin and a model id. */
const ADAPTERS: Record<string, AdapterFactory> = {
  "openai-compatible": (c) => new OpenAiCompatibleProvider(c),
  openai:              (c) => new OpenAiCompatibleProvider(c),
  azure:               (c) => new OpenAiCompatibleProvider(c),
  groq:                (c) => new OpenAiCompatibleProvider(c),
  together:            (c) => new OpenAiCompatibleProvider(c),
  vllm:                (c) => new OpenAiCompatibleProvider(c),
  ollama:              (c) => new OpenAiCompatibleProvider(c),
};

export const supportedProviders = (): string[] => Object.keys(ADAPTERS);

/**
 * Build the adapter for a resolved config.
 *
 * Throws only on an unknown provider name, which is an operator typo worth
 * surfacing loudly at the point of use. A null config is not this function's
 * problem — callers check for "not configured" before getting here.
 */
export function createAiProvider(config: AiProviderConfig): AiProvider {
  const factory = ADAPTERS[config.provider.toLowerCase()];
  if (!factory)
    throw new AiProviderError("invalid_config",
      `Unknown AI_PROVIDER "${config.provider}". Supported: ${supportedProviders().join(", ")}.`);
  return factory(config);
}
