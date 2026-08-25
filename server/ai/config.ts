/* ═══════════════════════════════════════════════════════════════════════════
   AI CONFIGURATION RESOLUTION

   A PURE function over already-read environment values. The reading itself
   happens once, in server/config.ts, alongside SMTP and Apify — Nerve keeps one
   configuration mechanism, and this module keeps the rules about what counts as
   usable configuration.

   Being pure also means the whole ruleset is testable without a database, a
   session, or any environment at all.
   ═══════════════════════════════════════════════════════════════════════════ */

import type { AiProviderConfig } from "./types.js";

/** The raw, untrusted shape as it comes out of the environment. */
export interface RawAiEnv {
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  /* Read by the route, not by the provider layer — a usage policy is a Nerve
     concern, not something the adapter should know about. Declared here only so
     the shape of config.ai stays in one place. */
  dailyRequestLimit?: number;
}

export interface AiConfigResolution {
  /** The usable config, or null when AI is simply not set up. */
  config: AiProviderConfig | null;
  /** Why it is unusable. null when config is non-null. Never contains the key. */
  reason: string | null;
}

const DEFAULT_PROVIDER = "openai-compatible";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/** Hosts for which plaintext http:// is acceptable — a model running on the
    same box. Anywhere else, http:// would put the API key on the wire. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * Validate the base URL.
 *
 * This is also the answer to "no arbitrary URL fetching": the adapter builds
 * every request path from this origin, and the origin comes only from the
 * server environment — never from a request, a user, or a model.
 */
export function validateBaseUrl(raw: string): { ok: true; url: string } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "AI_BASE_URL is not a valid URL." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, reason: `AI_BASE_URL must use http or https, not ${u.protocol}` };
  if (u.protocol === "http:" && !LOOPBACK.has(u.hostname))
    return { ok: false, reason: "AI_BASE_URL must use https for a remote host — plaintext http would expose the API key." };
  // Normalise: drop any trailing slash so path joining stays predictable.
  return { ok: true, url: u.toString().replace(/\/+$/, "") };
}

function clampInt(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Decide whether AI is configured, and produce the config if so.
 *
 * Absence is a normal, silent state — not an error. Nerve must boot and run
 * identically with none of these variables set, so the only thing an unset
 * environment produces here is `{config: null, reason: null}`.
 */
export function resolveAiConfig(raw: RawAiEnv | null | undefined): AiConfigResolution {
  const apiKey = (raw?.apiKey ?? "").trim();
  const model = (raw?.model ?? "").trim();
  const baseUrl = (raw?.baseUrl ?? "").trim();
  const provider = (raw?.provider ?? "").trim() || DEFAULT_PROVIDER;

  // Nothing set at all: AI is off, and that is not a misconfiguration.
  if (!apiKey && !model && !baseUrl) return { config: null, reason: null };

  // Partially set: worth telling an operator, because they clearly intended to
  // switch it on. The message names the missing variable, never a value.
  if (!apiKey) return { config: null, reason: "AI_API_KEY is not set." };
  if (!model) return { config: null, reason: "AI_MODEL is not set." };
  if (!baseUrl) return { config: null, reason: "AI_BASE_URL is not set." };

  const url = validateBaseUrl(baseUrl);
  if (!url.ok) return { config: null, reason: url.reason };

  return {
    config: {
      provider,
      baseUrl: url.url,
      apiKey,
      model,
      timeoutMs: clampInt(raw?.timeoutMs, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maxOutputTokens: clampInt(raw?.maxOutputTokens, DEFAULT_MAX_OUTPUT_TOKENS, 1, 32_000),
    },
    reason: null,
  };
}

/**
 * The safe, public description of the current configuration.
 *
 * Deliberately built by naming each field rather than spreading the config, so
 * a field added to AiProviderConfig later cannot leak into an API response by
 * accident. apiKey is structurally absent from the return type.
 */
export function describeAiConfig(config: AiProviderConfig | null): {
  configured: boolean; provider: string | null; model: string | null; baseUrl: string | null;
} {
  if (!config) return { configured: false, provider: null, model: null, baseUrl: null };
  return { configured: true, provider: config.provider, model: config.model, baseUrl: config.baseUrl };
}
