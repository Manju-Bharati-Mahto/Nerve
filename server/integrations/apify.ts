/**
 * Apify Instagram clients.
 *
 * Two scrapers are used:
 *   - Profile Scraper (apify/instagram-profile-scraper) → batch refresh of
 *     follower counts + latest posts for our seed handles (see outreach-sync).
 *   - Post Scraper   (apify/instagram-post-scraper)    → on-demand metrics
 *     for specific post / reel URLs the user pastes in the UI.
 *
 * Both go through run-sync-get-dataset-items so results come back in a single
 * HTTP call. Apify charges per item scraped — don't call this on a tight loop.
 *
 * Docs: https://docs.apify.com/api/v2#/reference/actors/run-actor-synchronously-and-get-dataset-items
 */
import { config } from "../config.js";

/**
 * Builds the `sessionCookies` payload that Apify's Instagram actors accept
 * when scraping as a logged-in user. Returns null if no cookie is configured.
 *
 * Accepts two input forms via APIFY_IG_SESSION_COOKIE:
 *   1. A bare sessionid value (long string from the browser cookie of the
 *      same name). We wrap it in the standard cookie object shape.
 *   2. A JSON array of cookie objects. Forwarded verbatim.
 */
function buildInstagramSessionCookies(): unknown[] | null {
  const raw = config.apify.instagramSessionCookie;
  if (!raw) return null;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to treating it as a bare value.
    }
  }
  return [{
    name: "sessionid",
    value: raw,
    domain: ".instagram.com",
    path: "/",
    secure: true,
    httpOnly: true,
  }];
}

export interface ApifyLatestPost {
  id?: string;
  shortCode?: string;
  type?: string;
  caption?: string;
  url?: string;
  displayUrl?: string;
  timestamp?: string;
  likesCount?: number;
  commentsCount?: number;
  videoViewCount?: number;
  videoPlayCount?: number;
  productType?: string;
}

export interface ApifyProfileResult {
  username: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  profilePicUrl?: string;
  verified?: boolean;
  private?: boolean;
  isBusinessAccount?: boolean;
  latestPosts?: ApifyLatestPost[];
  error?: string;
}

interface FetchOptions {
  handles: string[];
  resultsLimit?: number;
}

export async function fetchInstagramProfiles({ handles, resultsLimit = 30 }: FetchOptions): Promise<ApifyProfileResult[]> {
  const token = config.apify.token;
  if (!token) {
    throw new Error("APIFY_TOKEN is not configured.");
  }
  if (handles.length === 0) return [];

  // Normalize handles: strip @, whitespace, URLs the actor accepts both URLs
  // and bare usernames but we keep it simple.
  const usernames = handles.map(h => h.trim().replace(/^@/, "")).filter(Boolean);

  const actor = config.apify.profileActor;
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const sessionCookies = buildInstagramSessionCookies();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames,
      resultsLimit,
      // The actor returns latestPosts inline when this is set.
      resultsType: "posts",
      ...(sessionCookies ? { sessionCookies } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Apify HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Apify returned an unexpected payload shape.");
  }
  return data as ApifyProfileResult[];
}

/** Maps Apify's post `type` / `productType` to our internal PostType. */
export function inferPostType(p: ApifyLatestPost): "static" | "reel" | "story" | "carousel" {
  const t = (p.type ?? "").toLowerCase();
  const pt = (p.productType ?? "").toLowerCase();
  if (pt.includes("clips") || pt.includes("reel") || t === "video") return "reel";
  if (t === "sidecar" || t === "carousel") return "carousel";
  if (t === "story" || pt.includes("story")) return "story";
  return "static";
}

// ── Post-by-URL scraper ────────────────────────────────────────────────────

/**
 * Single-post result from the Instagram Post Scraper actor. Field set is a
 * superset of ApifyLatestPost — the Post Scraper also returns the owner so we
 * can verify the URL belongs to the page the user picked.
 */
export interface ApifyPostResult extends ApifyLatestPost {
  ownerUsername?: string;
  ownerFullName?: string;
  error?: string;
}

/**
 * Fetches metrics for the given Instagram post/reel URLs. Used by the
 * "add live posts" dialog so a user can paste a few links and pull real
 * numbers without re-scraping the entire profile.
 */
export async function fetchInstagramPostsByUrls(urls: string[]): Promise<ApifyPostResult[]> {
  const token = config.apify.token;
  if (!token) {
    throw new Error("APIFY_TOKEN is not configured.");
  }
  const postUrls = urls.map(u => u.trim()).filter(Boolean);
  if (postUrls.length === 0) return [];

  const actor = config.apify.postActor;
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;

  const sessionCookies = buildInstagramSessionCookies();
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // The actor's input schema names the URL list field `username` — yes,
    // even though it accepts post / reel URLs. We also send `directUrls` for
    // forward-compatibility with the general instagram-scraper actor in case
    // APIFY_POST_ACTOR is overridden.
    body: JSON.stringify({
      username: postUrls,
      directUrls: postUrls,
      resultsLimit: 1,
      ...(sessionCookies ? { sessionCookies } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Apify HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as unknown;
  if (!Array.isArray(data)) {
    throw new Error("Apify returned an unexpected payload shape.");
  }
  return data as ApifyPostResult[];
}

/**
 * Extracts the canonical Instagram post/reel shortcode from a URL.
 * Returns null if the URL doesn't look like a post / reel.
 *
 * Handles both URL shapes Instagram emits:
 *   - Legacy:   instagram.com/p/<code>/ , instagram.com/reel/<code>/ ,
 *               instagram.com/reels/<code>/ , instagram.com/tv/<code>/
 *   - Newer:    instagram.com/<username>/reel/<code>/ and
 *               instagram.com/<username>/p/<code>/  (username injected in path)
 *
 * Usernames are 1–30 chars: letters, digits, dot, underscore. We intentionally
 * NOT use a generic `[A-Za-z0-9_.]+/` so we don't accidentally match other
 * path segments (e.g. `/explore/`, `/stories/`) — the alternation with the
 * known type tokens ensures the right segment is captured.
 */
export function extractInstagramShortcode(url: string): string | null {
  const m = url.match(
    /instagram\.com\/(?:[A-Za-z0-9_.]{1,30}\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i,
  );
  return m ? m[1] : null;
}
