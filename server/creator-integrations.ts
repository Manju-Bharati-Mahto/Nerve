/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — the external platform integration contract

   WHAT IS LIVE: nothing. This file ships the adapter interface and a test
   provider, and that is a deliberate stopping point, not an unfinished one.

   No credentials exist for any platform in this deployment — no Instagram,
   YouTube, TikTok or Meta app, no client id, no OAuth redirect, no scopes
   granted. Writing a provider against an API nobody can call would produce
   code that has never run and a screen that implies a connection that does
   not exist. So the boundary is defined, a test provider proves the shape,
   and the status endpoint says plainly that nothing is connected.

   WHEN A PLATFORM ARRIVES, the things that must be true are written down here
   rather than discovered later:

     TOKENS stay server-side. They are never returned to a browser, never put
     in a prompt or a tool result, and never written to an audit row. The AI
     layer sees sanitised metrics through a tool, exactly as it sees everything
     else — it never holds a credential.

     EXTERNAL METRICS ARE NOT CREATOR POINTS. An Instagram view is a view. It
     does not become a point, a rank or a rupee unless a business rule says so
     explicitly, and that rule would go through the Phase 4 point architecture
     like any other award — never by writing to the ledger from here.

     EXTERNAL CONTENT DOES NOT OVERWRITE A SUBMISSION. A published post is
     mapped alongside Nerve's own record (creator, platform, external id, url,
     published_at, metadata), never merged into it. No such table exists yet,
     because nothing writes one.
   ═══════════════════════════════════════════════════════════════════════════ */

/** What any platform adapter must be able to do. */
export interface CreatorIntegrationProvider {
  /** Stable key, e.g. "instagram". Used in status and in tool results. */
  readonly platform: string;
  readonly displayName: string;
  /** False until real credentials are configured for this deployment. */
  isConfigured(): boolean;
  /** A liveness probe. Never returns a token or a raw provider payload. */
  verifyConnection(): Promise<IntegrationHealth>;
  /** The connected account, as little of it as possible. */
  getProfile(creatorId: string): Promise<ExternalProfile | null>;
  /** Published content for a creator, within a window. */
  getContent(creatorId: string, since: string, until: string): Promise<ExternalContent[]>;
  /** Aggregate metrics. Sanitised — counts and ids, never credentials. */
  getMetrics(creatorId: string, since: string, until: string): Promise<ExternalMetrics | null>;
}

export type IntegrationStatus = "not_configured" | "connected" | "disconnected" | "expired" | "error";
export interface IntegrationHealth {
  platform: string;
  status: IntegrationStatus;
  checkedAt: string;
  /** Safe summary. Never a token, a URL with a secret, or a provider body. */
  detail?: string;
}
export interface ExternalProfile {
  platform: string; handle: string; displayName: string | null; followers: number | null;
}
export interface ExternalContent {
  platform: string; externalId: string; url: string; publishedAt: string;
  caption: string | null; kind: string | null;
}
export interface ExternalMetrics {
  platform: string; since: string; until: string;
  posts: number; views: number | null; likes: number | null; comments: number | null;
}

/**
 * The test provider.
 *
 * Exists so the contract above is exercised by tests and so the UI can be
 * built against a real shape. It reports `not_configured` and returns nothing,
 * which is the honest answer for a deployment with no credentials — it never
 * pretends to be a platform.
 */
export class TestIntegrationProvider implements CreatorIntegrationProvider {
  readonly platform = "test";
  readonly displayName = "Test provider (no external calls)";
  isConfigured(): boolean { return false; }
  async verifyConnection(): Promise<IntegrationHealth> {
    return { platform: this.platform, status: "not_configured",
      checkedAt: new Date().toISOString(),
      detail: "No credentials are configured for this platform in this deployment." };
  }
  async getProfile(): Promise<ExternalProfile | null> { return null; }
  async getContent(): Promise<ExternalContent[]> { return []; }
  async getMetrics(): Promise<ExternalMetrics | null> { return null; }
}

const providers: CreatorIntegrationProvider[] = [new TestIntegrationProvider()];

/** Register a real adapter when one exists. Nothing calls this today. */
export function registerCreatorIntegration(p: CreatorIntegrationProvider): void {
  if (!providers.some((x) => x.platform === p.platform)) providers.push(p);
}

/** What an operator sees: which platforms exist, and that none is connected. */
export function listCreatorIntegrations() {
  return providers.map((p) => ({
    platform: p.platform, displayName: p.displayName,
    configured: p.isConfigured(),
    status: p.isConfigured() ? "connected" : "not_configured",
  }));
}

/** Configured adapters only. Returns an empty list in this deployment. */
export function activeCreatorIntegrations(): CreatorIntegrationProvider[] {
  return providers.filter((p) => p.isConfigured());
}
