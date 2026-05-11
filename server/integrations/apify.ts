/**
 * Apify "Instagram Profile Scraper" client.
 *
 * Calls the run-sync-get-dataset-items endpoint so we get the scraped results
 * back in a single HTTP request. This is fine for our scale (~100 handles) but
 * note Apify charges per profile scraped — don't call this on a tight loop.
 *
 * Docs: https://docs.apify.com/api/v2#/reference/actors/run-actor-synchronously-and-get-dataset-items
 * Actor: https://apify.com/apify/instagram-profile-scraper
 */
import { config } from "../config.js";

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

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      usernames,
      resultsLimit,
      // The actor returns latestPosts inline when this is set.
      resultsType: "posts",
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
