/* ═══════════════════════════════════════════════════════════════════════════
   AI ERRORS + SECRET REDACTION

   Every string that leaves the AI layer — an HTTP response body, a log line, a
   thrown message — passes through redactSecret() first. The key is read from
   config in exactly one place and is never interpolated into a message, so this
   is defence in depth rather than the only guard: if a provider ever echoes the
   Authorization header back inside an error payload, it still cannot escape.
   ═══════════════════════════════════════════════════════════════════════════ */

export type AiErrorKind =
  | "not_configured"     // no usable AI configuration
  | "invalid_config"     // configuration present but unusable (bad URL, missing model)
  | "timeout"
  | "network"            // DNS, refused, TLS
  | "auth"               // 401 / 403
  | "rate_limit"         // 429
  | "model_unavailable"  // model rejected by the provider
  | "invalid_request"    // 400 that is not a model problem
  | "provider_error"     // 5xx
  | "malformed_response"; // 2xx whose body was not the expected shape

/** Longest provider-supplied text we will ever surface or log. Provider errors
    can be enormous HTML pages; a summary is all an operator needs. */
const MAX_DETAIL = 300;

export class AiProviderError extends Error {
  readonly kind: AiErrorKind;
  readonly status?: number;
  /** Whether a caller could sensibly retry. Used by later phases, not Phase 1. */
  readonly retryable: boolean;

  constructor(kind: AiErrorKind, message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "AiProviderError";
    this.kind = kind;
    this.status = opts.status;
    this.retryable = opts.retryable ?? (kind === "timeout" || kind === "network"
      || kind === "rate_limit" || kind === "provider_error");
  }
}

/**
 * Remove a secret from arbitrary text.
 *
 * Substring replacement rather than a pattern: we know the exact value, so this
 * cannot miss it through a formatting difference, and it cannot accidentally
 * scrub unrelated content. Short values are ignored — a 3-character "key" would
 * match everywhere and destroy the message.
 */
export function redactSecret(text: string, secret?: string): string {
  if (!text) return "";
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("***");
}

/** Trim provider text to something loggable, on one line, with the key removed. */
export function summariseDetail(detail: unknown, secret?: string): string {
  const raw = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  const flat = redactSecret(raw, secret).replace(/\s+/g, " ").trim();
  return flat.length > MAX_DETAIL ? flat.slice(0, MAX_DETAIL) + "…" : flat;
}

/** Map an HTTP status from an OpenAI-compatible endpoint onto an error kind. */
export function kindForStatus(status: number): AiErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 404 || status === 422) return "invalid_request";
  if (status >= 500) return "provider_error";
  return "provider_error";
}

/**
 * Turn anything thrown by fetch() into a typed error.
 *
 * An AbortError means our own timeout fired (or the caller cancelled); every
 * other throw from fetch is a transport failure. Neither carries the key, but
 * both are redacted anyway so this function is safe to use on any input.
 */
export function fromTransportError(e: unknown, secret?: string): AiProviderError {
  const name = (e as { name?: string })?.name;
  if (name === "AbortError" || name === "TimeoutError")
    return new AiProviderError("timeout", "The AI provider did not respond in time.");
  const msg = summariseDetail((e as { message?: string })?.message ?? String(e), secret);
  return new AiProviderError("network", `Could not reach the AI provider: ${msg}`);
}

/** One-line operator-facing message. Safe to hand to console.error. */
export function describeError(e: unknown): string {
  if (e instanceof AiProviderError) return `[${e.kind}] ${e.message}`;
  return summariseDetail((e as { message?: string })?.message ?? String(e));
}
