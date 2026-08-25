/* ═══════════════════════════════════════════════════════════════════════════
   AI COST ESTIMATION

   Pricing is CONFIGURATION, not knowledge. Nothing here ships a rate for any
   model, and nothing here has a default: published prices change, they differ
   per organisation and per region, and a figure recalled from memory would be
   presented to an administrator as if it were authoritative. A NULL cost is
   honest; a confidently wrong invoice estimate is not.

   Supply rates through AI_PRICING and costs appear. Leave it unset and every
   estimated_cost stays NULL, which is the current state.
   ═══════════════════════════════════════════════════════════════════════════ */

export interface AiModelPrice {
  /** Currency per 1,000,000 input tokens. */
  inputPerMillion: number;
  /** Currency per 1,000,000 output tokens. */
  outputPerMillion: number;
  currency: string;
}

export type AiPricingTable = Record<string, AiModelPrice>;

/**
 * Parse AI_PRICING.
 *
 * Format — a JSON object keyed by the exact model id the provider reports:
 *
 *   AI_PRICING='{"gpt-4o-mini":{"inputPerMillion":0.15,"outputPerMillion":0.60,"currency":"USD"}}'
 *
 * Rates must come from the organisation's own OpenAI billing page. Malformed
 * configuration yields an empty table rather than an exception: a typo in a
 * pricing string must never stop Nerve from answering a question.
 */
export function parseAiPricing(raw: string | undefined): AiPricingTable {
  if (!raw?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    console.error("AI_PRICING is not valid JSON — cost estimation is disabled.");
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const out: AiPricingTable = {};
  for (const [model, v] of Object.entries(parsed as Record<string, unknown>)) {
    const p = v as Partial<AiModelPrice> | null;
    const inp = Number(p?.inputPerMillion), outp = Number(p?.outputPerMillion);
    // Both rates must be present and sane, or the entry is ignored entirely —
    // a half-configured model would silently under-report cost.
    if (!Number.isFinite(inp) || !Number.isFinite(outp) || inp < 0 || outp < 0) {
      console.error(`AI_PRICING entry for "${model}" is incomplete — ignored.`);
      continue;
    }
    out[model] = { inputPerMillion: inp, outputPerMillion: outp,
                   currency: String(p?.currency ?? "USD").slice(0, 8) };
  }
  return out;
}

/**
 * Cost for one request, or null when it cannot be known.
 *
 * Returns null — never 0 — when the model is unpriced or the provider reported
 * no usage. Zero is a claim that the request was free; null says we do not know,
 * and the two must not be confused in a billing report.
 */
export function estimateAiCost(
  table: AiPricingTable,
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
): number | null {
  if (!model) return null;
  const price = table[model];
  if (!price) return null;
  if (promptTokens == null && completionTokens == null) return null;
  const cost = ((promptTokens ?? 0) / 1_000_000) * price.inputPerMillion
             + ((completionTokens ?? 0) / 1_000_000) * price.outputPerMillion;
  // The column is NUMERIC(12,6); round rather than let float noise reach it.
  return Math.round(cost * 1e6) / 1e6;
}
