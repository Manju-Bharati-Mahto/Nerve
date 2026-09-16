/**
 * §8.2 / §25 — what an Editor is allowed to know about a social media page.
 *
 * "Editors can view the list of social media pages / accounts relevant to their
 * assigned clients or projects (platform name, page/handle, and connected
 * status)... Editors must not be able to view analytics, performance metrics,
 * follower counts, engagement data, or insights for any social media page."
 *
 * §25 makes that an API guarantee rather than a UI one: "Enforce that Editors
 * can never retrieve social media analytics data through the API, even by direct
 * request." So the editor's view is built by naming the three fields they may
 * have — an allowlist — rather than by deleting the ones they may not. A field
 * added to the page model later is then invisible to editors by default, which
 * is the safe direction to fail.
 */
import type { VideoRole } from "./types.js";

/** Exactly what §8.2 permits an editor to see. */
export interface EditorVisiblePage {
  id: string;
  handle: string;
  platform: string;
  /** Whether the page is hooked up to the sync, not how it is performing. */
  connected: boolean;
}

/**
 * The only page fields this module reads. Deliberately has no index signature:
 * the editor projection must depend on these four and nothing else, so a richer
 * page type can be passed in without widening what an editor can be shown.
 */
export interface SourcePage {
  id: string;
  handle: string;
  platform: string;
  last_synced_at?: string | null;
}

export function isAnalyticsRestricted(role: VideoRole): boolean {
  return role === "editor";
}

/**
 * Shapes the page list for a role. Editors get the §8.2 allowlist; every other
 * role gets the pages unchanged, since analytics access is restricted "to roles
 * other than Editor".
 */
export function socialPagesForRole<T extends SourcePage>(
  pages: T[],
  role: VideoRole,
): { pages: EditorVisiblePage[] | T[]; analyticsVisible: boolean } {
  if (!isAnalyticsRestricted(role)) {
    return { pages, analyticsVisible: true };
  }
  return {
    pages: pages.map(p => ({
      id: p.id,
      handle: p.handle,
      platform: p.platform,
      connected: !!p.last_synced_at,
    })),
    analyticsVisible: false,
  };
}
