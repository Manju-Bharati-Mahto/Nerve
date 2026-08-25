/* ═══════════════════════════════════════════════════════════════════════════
   PROVIDER EGRESS BOUNDARY

   The last place Nerve data passes through before it becomes part of a prompt.
   Today the provider is local and no third party is configured; this exists so
   that when one is, there is a single named place to look, review and change —
   rather than a decision spread across every tool.

   It is NOT a DLP engine and should not become one. It enforces one rule that
   can be enforced structurally, and documents the rest as policy for the people
   who will make those decisions.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * What the AI layer is permitted to send outward.
 *
 * A, B, C and D are permitted TODAY only because the provider is local. Sending
 * any of them to a third party is a governance decision that has not been made
 * — see the Phase 4B blockers. Category E is different in kind: it is never
 * permitted, under any provider, which is why it is the one enforced in code.
 */
export const AI_EGRESS_POLICY = {
  A_identity: {
    permitted: true,
    covers: ["full name", "designation", "media-ops role", "team"],
    note: "Needed to address someone correctly and reason about their role. "
        + "The obvious candidate for pseudonymisation if a third-party provider is approved.",
  },
  B_work: {
    permitted: true,
    covers: ["project name and code", "deliverable title", "due date", "assignment", "status"],
    note: "The substance of any useful operational answer.",
  },
  C_reporting: {
    permitted: true,
    covers: ["daily report status", "logged minutes", "task counts"],
    note: "Aggregates only. Free-text task descriptions are NOT sent by any current tool, "
        + "and performance judgements are explicitly out of scope (§7.15 rejects AI performance scoring).",
  },
  D_operations: {
    permitted: true,
    covers: ["shoot schedule", "equipment", "leave", "events"],
    note: "Not reachable by any Phase 3 tool; listed so the boundary is complete.",
  },
  E_sensitive: {
    permitted: false,
    covers: ["passwords", "password hashes", "session tokens", "API keys", "authorization headers",
             "email addresses", "phone numbers", "personal contact details",
             "unrelated employees' data"],
    note: "NEVER sent, regardless of provider or approval. Enforced below, not merely documented.",
  },
} as const;

/**
 * Key names that must never reach a provider.
 *
 * Matched on the KEY, not the value: a value-based scan is guesswork that both
 * misses real secrets and mangles legitimate text, whereas a field called
 * `password_hash` is unambiguous. No current tool returns any of these — this is
 * the backstop for the tool nobody has written yet.
 */
const FORBIDDEN_KEY = /^(password|password_hash|passwordhash|hash|salt|token|access_token|refresh_token|api_?key|secret|authorization|auth|session|cookie|otp|email|phone|mobile|contact_email|contact_phone)$/i;

export interface EgressResult {
  value: unknown;
  /** Dotted paths that were removed. Surfaced for audit, never sent onward. */
  removed: string[];
}

function scrub(value: unknown, path: string, removed: string[], depth = 0): unknown {
  // A guard against a pathological structure, not an expected case.
  if (depth > 12) return null;
  if (Array.isArray(value))
    return value.map((v, i) => scrub(v, `${path}[${i}]`, removed, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) { removed.push(path ? `${path}.${k}` : k); continue; }
      out[k] = scrub(v, path ? `${path}.${k}` : k, removed, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The seam.
 *
 * Every tool result passes through here on its way to the provider, so a tool
 * can never construct a provider payload itself. Data minimisation belongs in
 * the tool (it decides what is worth returning at all); the category-E guarantee
 * belongs here, where it applies uniformly and cannot be forgotten.
 */
export function prepareAiContextForProvider(toolName: string, data: unknown): EgressResult {
  const removed: string[] = [];
  const value = scrub(data, "", removed, 0);
  if (removed.length)
    // Loud on purpose: a tool returning a forbidden field is a bug in that tool,
    // and the scrub is a safety net rather than a licence to rely on it.
    console.error(`AI egress: tool "${toolName}" returned forbidden field(s), removed: ${removed.join(", ")}`);
  return { value, removed };
}
