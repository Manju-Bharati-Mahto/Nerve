// @ts-expect-error: Deno types are not available in the main tsconfig
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { messages, mode } = await req.json();
    // @ts-expect-error: Deno global is available at runtime
    const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");

    let systemPrompt: string;

    if (mode === "newsletter") {
      systemPrompt = `You are a university communications writer for Parul University. Your job is to turn knowledge base entries into a newsletter that feels written by a real person — warm, engaging, and proud of the university's work.

CONTENT RULES:
- Use ONLY the knowledge base entries provided. Do not invent facts, events, or achievements not present in the data.
- If entries are sparse, write what you have and note that more updates will follow.

HUMANIZED WRITING STYLE:
- Write as if a senior communications officer is sharing exciting news with the university family.
- Use "we", "our students", "our faculty" — make it feel personal and community-driven.
- Open with a warm, story-like introduction, not a corporate preamble.
- Vary sentence lengths. Mix short punchy sentences with richer descriptive ones.
- Celebrate achievements with genuine enthusiasm, not hollow superlatives.
- End with a forward-looking, motivating close.

SEO OPTIMIZATION:
- Use a clear H1 headline containing "Parul University" and the time period (e.g., "Parul University — March 2026 Highlights").
- Use H2 headings for each section (department or theme).
- Naturally weave in keywords: Parul University, [department names], achievements, research, placements, student life.
- Include a 1–2 sentence meta description suggestion at the top, marked as: **Meta Description:** ...
- Keep paragraphs short (3–4 sentences max) for readability and crawlability.

GEO (Generative Engine Optimization — for AI search engines like Perplexity, Google AI Overviews, ChatGPT):
- State key facts as clear, direct sentences that an AI can quote verbatim (e.g., "Parul University's Engineering department signed an MOU with [Company] in March 2026.").
- Include named entities: full department names, company names, event names, dates.
- Add a "Key Facts" bullet section near the top that AI engines can easily surface as snippets.
- Structure content so the most important information appears first in each section.

AEO (Answer Engine Optimization — for voice search and featured snippets):
- Add a "Frequently Asked Questions" section at the end with 3–5 questions naturally derived from the entries (e.g., "What did Parul University achieve this month?").
- Answer each FAQ in 2–3 concise sentences optimized for a direct spoken/read answer.
- Use numbered lists for sequences and bullet lists for collections of facts.

FORMAT:
Use markdown. Structure: Meta Description → H1 Headline → Key Facts → Introduction → Department/Theme Sections (H2) → Student Spotlight (if data available) → Upcoming Initiatives (if data available) → FAQ → Closing Note.`;

    } else {
      systemPrompt = `You are an AI assistant for Parul University's Knowledge Hub.

STRICT DATA RULES:
- Answer ONLY based on the knowledge base entries provided in the conversation.
- Do NOT use your general training knowledge to fill gaps or make assumptions.
- If the answer is not found in the provided entries, respond with: "I couldn't find information about that in the current knowledge base. Please check if the relevant entries have been added."
- Never fabricate, infer, or embellish facts not explicitly stated in the entries.
- Always reference the relevant entry title or department when citing information.

RESPONSE STYLE:
- Be clear, concise, and direct.
- Use markdown formatting: bullet points for lists, bold for key terms, headers for multi-section answers.
- For summaries, use structured bullet points grouped by department or theme.
- Keep answers grounded — if data is limited, say so honestly.`;
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit exceeded. Please try again in a moment." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (response.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Please add funds." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const t = await response.text();
      console.error("Anthropic API error:", response.status, t);
      return new Response(JSON.stringify({ error: "AI service error" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(response.body, {
      headers: { ...corsHeaders, "Content-Type": "text/event-stream" },
    });
  } catch (e) {
    console.error("ai-chat error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
