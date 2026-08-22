/* ═══════════════════════════════════════════════════════════════════════════
   AI LAYER ENTRY POINT

   The single seam between Nerve's configuration and the provider layer. Every
   other file under server/ai/ is pure and Nerve-free; this one reads config and
   memoises the resolution, so it is also the only file a test needs to avoid.

   PHASE 1 BOUNDARY — there is no Nerve data anywhere below this point. No
   database handle, no user, no project, no query. The layer can talk to a
   model; it has nothing to say yet.
   ═══════════════════════════════════════════════════════════════════════════ */

import { config } from "../config.js";
import { describeAiConfig, resolveAiConfig } from "./config.js";
import { AiProviderError, describeError } from "./errors.js";
import { createAiProvider } from "./provider.js";
import type { AiConnectionResult, AiProvider } from "./types.js";

/* Resolved once. The environment cannot change under a running process, and
   re-validating a URL on every request would be wasted work. */
let resolved: ReturnType<typeof resolveAiConfig> | null = null;
let provider: AiProvider | null = null;
let providerError: string | null = null;
/* The most recent probe result, so the UI can tell "not set up" from "set up but
   unreachable" without paying for a live check on every page load. Memory only:
   it describes this process, and a restart should re-probe rather than trust a
   stale row. */
let lastCheck: AiConnectionResult | null = null;

function ensure() {
  if (resolved) return;
  resolved = resolveAiConfig(config.ai);
  if (!resolved.config) return;
  try {
    provider = createAiProvider(resolved.config);
  } catch (e) {
    // A bad AI_PROVIDER must not take the server down: log it and stay disabled.
    provider = null;
    providerError = describeError(e);
    console.error("AI provider could not be created:", providerError);
  }
}

/** The provider, or null when AI is not configured (or misconfigured). */
export function getAiProvider(): AiProvider | null {
  ensure();
  return provider;
}

export function isAiEnabled(): boolean {
  return getAiProvider() !== null;
}

/**
 * Safe status for an API response.
 *
 * Assembled field by field from describeAiConfig(), which has no apiKey in its
 * return type at all — so this cannot leak the key even if AiProviderConfig
 * grows new fields later.
 */
export interface AiStatus {
  enabled: boolean; configured: boolean; provider: string | null; model: string | null;
  baseUrl: string | null; supportsStreaming: boolean; supportsStructuredOutput: boolean;
  reason: string | null;
  /* Outcome of the last probe this process ran, or null if none has run. Carries
     no key, no header and no provider payload — only the three booleans an
     operator needs and when they were established. */
  lastCheck: { reachable: boolean; authenticated: boolean; modelAvailable: boolean | null;
               checkedAt: string; error?: string } | null;
}

export function getAiStatus(): AiStatus {
  ensure();
  const desc = describeAiConfig(resolved?.config ?? null);
  const info = provider?.info() ?? null;
  return {
    enabled: provider !== null,
    configured: desc.configured,
    provider: desc.provider,
    model: desc.model,
    baseUrl: desc.baseUrl,
    supportsStreaming: info?.supportsStreaming ?? false,
    supportsStructuredOutput: info?.supportsStructuredOutput ?? false,
    // Why it is off, when someone clearly meant to switch it on. Never a value.
    reason: providerError ?? resolved?.reason ?? null,
    lastCheck: lastCheck
      ? { reachable: lastCheck.reachable, authenticated: lastCheck.authenticated,
          modelAvailable: lastCheck.modelAvailable, checkedAt: lastCheck.checkedAt,
          ...(lastCheck.error ? { error: lastCheck.error } : {}) }
      : null,
  };
}

/**
 * Probe the provider. Never throws, never returns a secret.
 *
 * Contacts only the configured provider origin, and sends no Nerve data — the
 * fallback probe's entire payload is the word "ping".
 */
export async function testAiConnection(): Promise<AiConnectionResult> {
  ensure();
  const p = getAiProvider();
  if (!p) {
    return {
      configured: resolved?.config != null,
      provider: resolved?.config?.provider ?? null,
      model: resolved?.config?.model ?? null,
      reachable: false, authenticated: false, modelAvailable: null,
      checkedAt: new Date().toISOString(),
      error: providerError ?? resolved?.reason ?? "AI is not configured on this server.",
    };
  }
  try {
    const result = await p.testConnection();
    lastCheck = result;
    if (!result.reachable || !result.authenticated)
      console.error("AI provider connection check failed:", result.error ?? "unknown reason");
    return result;
  } catch (e) {
    // testConnection() is written not to throw; this is the belt-and-braces path.
    const message = describeError(e);
    console.error("AI provider connection check threw:", message);
    const info = p.info();
    return {
      configured: true, provider: info.provider, model: info.model,
      reachable: false, authenticated: false, modelAvailable: null,
      checkedAt: new Date().toISOString(),
      error: e instanceof AiProviderError ? e.message : "The connection check failed unexpectedly.",
    };
  }
}

/** Test-only: drop the memoised resolution so a new environment takes effect. */
export function resetAiRuntimeForTests(): void {
  resolved = null; provider = null; providerError = null; lastCheck = null;
}
