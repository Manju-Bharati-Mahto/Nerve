/**
 * Apify Instagram + Facebook clients.
 *
 * Instagram (two scrapers):
 *   - Profile Scraper (apify/instagram-profile-scraper) → batch refresh of
 *     follower counts + latest posts for our seed handles (see outreach-sync).
 *   - Post Scraper   (apify/instagram-post-scraper)    → on-demand metrics
 *     for specific post / reel URLs the user pastes in the UI.
 *
 * Facebook (one scraper, two call shapes — see fetchFacebookPagePosts vs
 * fetchFacebookPostsByUrls below):
 *   - Facebook Posts Scraper (apify/facebook-posts-scraper) → given a page URL,
 *     returns that page's recent posts; given a specific post/reel URL, returns
 *     just that post. Same actor, same endpoint — only `startUrls` differs.
 *
 * All go through run-sync-get-dataset-items so results come back in a single
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

/**
 * The true public "views" for a post. A platform's video "Views" count is
 * reported by scrapers under different keys across post types, actor versions,
 * and — for Facebook — even across the two call shapes of the same actor
 * (page-feed vs direct-URL). A given key can be zero, absent, or an
 * older/smaller count that doesn't match the unified "Views".
 *
 * Rather than a fixed `??` chain (which a present-but-zero field would shadow,
 * and which misses whatever key the actor actually populated), we scan every
 * top-level numeric field whose name looks like a view/play/impression count
 * and take the LARGEST — that's the public "Views" number. Returns null only
 * when no such field is present, so callers can keep an existing value instead
 * of zeroing it out. Platform-agnostic by design — reused for both Instagram
 * and Facebook scraper responses.
 */
function isViewCountKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("playcount") ||
    k.includes("viewcount") ||
    k.includes("impressioncount") ||
    k === "views" || k === "plays" || k === "impressions" ||
    k === "viewscount" || k === "playscount" || k === "viewcount" || k === "playcount"
  );
}

export function bestViewCount(post: unknown): number | null {
  if (!post || typeof post !== "object") return null;
  let best: number | null = null;
  for (const [key, value] of Object.entries(post as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && isViewCountKey(key)) {
      if (best === null || value > best) best = value;
    }
  }
  return best;
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
  // Diagnostic: set OUTREACH_SYNC_DEBUG=true to log every numeric field the
  // actor returns per post. Used to identify which key holds Instagram's
  // unified "Views" when the displayed count looks too low.
  if (process.env.OUTREACH_SYNC_DEBUG === "true") {
    for (const item of data as Record<string, unknown>[]) {
      const nums = Object.fromEntries(
        Object.entries(item).filter(([, v]) => typeof v === "number"),
      );
      console.log(
        `[apify-debug] post ${String(item.shortCode ?? item.url ?? "?")} numeric fields: ${JSON.stringify(nums)}`,
      );
    }
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

// ── Facebook Posts Scraper (apify/facebook-posts-scraper) ──────────────────

/**
 * Extracts a stable id + inferred type from a Facebook post/reel/video URL.
 * Recognises the URL shapes Facebook emits: /reel/<id>, /<page>/videos/<id>,
 * /watch/?v=<id>, fb.watch/<id>, /share/r|p/<id>, /<page>/posts/<id>,
 * /photo(.php)?fbid=<id>, /permalink.php?story_fbid=<id>.
 */
export function extractFacebookPostRef(url: string): { id: string; type: "static" | "reel" } | null {
  if (!/(?:^|\.)?(?:facebook\.com|fb\.com|fb\.watch)\//i.test(url)) return null;
  const patterns: { re: RegExp; type: "static" | "reel" }[] = [
    { re: /facebook\.com\/reel\/([A-Za-z0-9]+)/i,                 type: "reel" },
    { re: /facebook\.com\/[^/?#]+\/videos\/(\d+)/i,               type: "reel" },
    { re: /facebook\.com\/watch\/?\?(?:.*&)?v=(\d+)/i,            type: "reel" },
    { re: /fb\.watch\/([A-Za-z0-9_-]+)/i,                         type: "reel" },
    { re: /facebook\.com\/share\/[rv]\/([A-Za-z0-9]+)/i,          type: "reel" },
    { re: /facebook\.com\/share\/p\/([A-Za-z0-9]+)/i,             type: "static" },
    { re: /facebook\.com\/[^/?#]+\/posts\/([A-Za-z0-9]+)/i,       type: "static" },
    { re: /facebook\.com\/photo(?:\.php)?\/?\?(?:.*&)?fbid=(\d+)/i, type: "static" },
    { re: /facebook\.com\/permalink\.php\?(?:.*&)?story_fbid=(\d+)/i, type: "static" },
  ];
  for (const { re, type } of patterns) {
    const m = url.match(re);
    if (m) return { id: m[1], type };
  }
  return null;
}

/**
 * Parses a count that may arrive as a clean number, a digit string, or an
 * abbreviated string like "1.2K" / "3.4M" (seen in `share_count_reduced` when
 * the actor scrapes a direct post/reel URL rather than a page feed).
 */
function parseCount(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !v.trim()) return undefined;
  const s = v.trim().toUpperCase().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([KM]?)$/);
  if (!m) { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
  const mult = m[2] === "K" ? 1_000 : m[2] === "M" ? 1_000_000 : 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/**
 * Normalised shape after mapping the actor's raw dataset item. The actor
 * returns TWO structurally different response shapes depending on whether
 * `startUrls` held a page URL (feed mode: flat `likes`/`shares`/`text`/`url`
 * fields) or a direct post/reel URL (permalink mode: nested `message.text`,
 * string `share_count_reduced`, no top-level `url`) — this function absorbs
 * that difference so callers never see raw actor output.
 */
export interface ApifyFacebookPost {
  /** Stable id extracted from the result's own URL — used to match back to
   *  the row/URL that was requested. */
  ref: string;
  url: string;
  pageName?: string;
  /**
   * The POSTING page's own numeric Facebook id (Meta's stable identifier,
   * e.g. "100044561550831") — present as `user.id` for every post type in
   * feed mode and for static/photo posts in direct-URL mode, and as
   * `video.owner.id` for a video/reel scraped by its direct URL (that shape
   * omits the top-level `user` object entirely). This is what "Add live
   * posts" verifies a pasted URL against the target page's own id — never
   * derived from the pasted URL itself, so a wrong-page URL can't spoof it.
   */
  ownerId?: string;
  caption: string;
  likes?: number;
  comments?: number;
  shares?: number;
  views: number | null;
  mediaType: "static" | "reel" | "carousel" | null;
  /** ISO date the post was published, when the actor reported one. */
  publishedAt?: string;
  /** Set when this specific startUrl produced a page-feed item (`inputUrl`
   *  reflects the page URL that was requested — feed mode only). */
  inputUrl?: string;
}

function normalizeFacebookPost(raw: Record<string, unknown>): ApifyFacebookPost | null {
  // Field priority is deliberately `url` FIRST, `facebookUrl` second — the two
  // response shapes disagree about what `facebookUrl` even means:
  //   - Page-feed mode (startUrls = a page URL): `url` is the post's own
  //     permalink; `facebookUrl` is the PAGE's URL (same for every post in the
  //     batch — using it here would silently collapse every post's permalink
  //     to the page's own link).
  //   - Direct-URL mode (startUrls = a specific post/reel URL): there is no
  //     `url` field at all; `facebookUrl` IS the post's own URL (Facebook
  //     echoes back exactly what was requested).
  // `url ?? facebookUrl` picks the correct one in both shapes.
  const url = String(raw.url ?? raw.facebookUrl ?? raw.topLevelUrl ?? "");
  const ref = extractFacebookPostRef(url)?.id
    ?? (typeof raw.post_id === "number" || typeof raw.post_id === "string" ? String(raw.post_id) : undefined)
    ?? (typeof raw.postId === "number" || typeof raw.postId === "string" ? String(raw.postId) : undefined);
  if (!ref || !url) return null;

  const media = Array.isArray(raw.media) ? raw.media as Record<string, unknown>[] : [];
  const hasVideo = !!raw.video || media.some(m => m.__typename === "Video");
  const photoCount = media.filter(m => m.__typename === "Photo").length;
  const mediaType: ApifyFacebookPost["mediaType"] =
    hasVideo ? "reel" : photoCount > 1 ? "carousel" : photoCount === 1 ? "static" : null;

  const messageObj = raw.message as Record<string, unknown> | undefined;
  const caption = typeof raw.text === "string" ? raw.text
    : typeof messageObj?.text === "string" ? messageObj.text
    : "";

  const timeIso = typeof raw.time === "string" ? raw.time : undefined;
  const creationSec = typeof raw.creation_time === "number" ? raw.creation_time
    : typeof raw.timestamp === "number" ? raw.timestamp : undefined;
  const publishedAt = timeIso ?? (creationSec ? new Date(creationSec * 1000).toISOString() : undefined);

  // user.id is present at top level for every post type in feed mode, and for
  // static/photo posts scraped by direct URL; a video/reel scraped by direct
  // URL omits the top-level `user` object entirely and carries the same id at
  // video.owner.id instead.
  const userObj = raw.user as Record<string, unknown> | undefined;
  const videoObj = raw.video as Record<string, unknown> | undefined;
  const videoOwner = videoObj?.owner as Record<string, unknown> | undefined;
  const ownerId = typeof userObj?.id === "string" ? userObj.id
    : typeof videoOwner?.id === "string" ? videoOwner.id
    : undefined;

  // likes: prefer the flat number, then the two structured reaction-count
  // objects the actor also returns (`likers.count` / `unified_reactors.count`
  // — both mirror `likes` when present, and are a safety net for post/page
  // combinations where `likes` itself comes back missing or non-numeric),
  // then fall back to parsing it as a possibly-abbreviated string (mirrors
  // the `share_count_reduced` handling below).
  const likersObj = raw.likers as Record<string, unknown> | undefined;
  const reactorsObj = raw.unified_reactors as Record<string, unknown> | undefined;
  const likes = typeof raw.likes === "number" ? raw.likes
    : typeof likersObj?.count === "number" ? likersObj.count
    : typeof reactorsObj?.count === "number" ? reactorsObj.count
    : parseCount(raw.likes);

  return {
    ref,
    url,
    pageName: typeof raw.pageName === "string" ? raw.pageName : undefined,
    ownerId,
    caption,
    likes,
    comments: typeof raw.comments === "number" ? raw.comments : parseCount(raw.total_comment_count),
    shares: typeof raw.shares === "number" ? raw.shares : parseCount(raw.share_count_reduced),
    views: bestViewCount(raw),
    mediaType,
    publishedAt,
    inputUrl: typeof raw.inputUrl === "string" ? raw.inputUrl : undefined,
  };
}

/**
 * Batch page-level scrape: given page URLs, returns each page's recent posts
 * (up to `resultsLimit` per page — the actor's documented per-startUrl
 * convention, matching how apify/instagram-profile-scraper's resultsLimit
 * works). This is the Facebook equivalent of fetchInstagramProfiles.
 *
 * Deliberately conservative default (10) — Facebook page scraping is a newer,
 * costlier integration than the Instagram one; raise once real usage patterns
 * are understood.
 */
export async function fetchFacebookPagePosts(pageUrls: string[], resultsLimit = 10): Promise<ApifyFacebookPost[]> {
  const token = config.apify.token;
  if (!token) throw new Error("APIFY_TOKEN is not configured.");
  const urls = pageUrls.map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) return [];

  const actor = config.apify.facebookPostActor;
  const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startUrls: urls.map(url => ({ url })),
      resultsLimit,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Apify HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json() as unknown;
  if (!Array.isArray(data)) throw new Error("Apify returned an unexpected payload shape.");
  return (data as Record<string, unknown>[])
    .map(normalizeFacebookPost)
    .filter((p): p is ApifyFacebookPost => p !== null);
}

/**
 * Fetches metrics for specific Facebook post/reel/video URLs. Used by
 * "Add live posts" (initial scrape) and refreshLivePostMetrics (re-scrape).
 * Same actor as fetchFacebookPagePosts — only `startUrls` differs (specific
 * post URLs instead of page URLs) and `resultsLimit` is fixed at 1 per URL.
 *
 * Results are matched back to requested URLs by the caller via `.ref`
 * (extractFacebookPostRef applied to both the input URL and the result's own
 * URL) — the actor's `inputUrl` field is only populated in page-feed mode,
 * not when scraping a direct post/reel URL, so `.ref` is the reliable key.
 *
 * Known gap: scraping a REEL by its direct URL returns likes/comments/shares
 * reliably but no view-count field at all (verified against the raw payload —
 * it's simply absent from this call shape, not a parsing miss). `views` comes
 * back null in that case and the caller keeps the existing value (never zeroed
 * — same monotonic-clamp philosophy as the Instagram path). fetchFacebookPagePosts
 * (page-feed mode) DOES return a reliable view count for the same reel, so a
 * page-level "Sync now" self-heals this the next time the reel is still within
 * that page's recent-posts window.
 */
export async function fetchFacebookPostsByUrls(urls: string[]): Promise<ApifyFacebookPost[]> {
  const token = config.apify.token;
  if (!token) throw new Error("APIFY_TOKEN is not configured.");
  const postUrls = urls.map(u => u.trim()).filter(Boolean);
  if (postUrls.length === 0) return [];

  const actor = config.apify.facebookPostActor;
  const endpoint = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startUrls: postUrls.map(url => ({ url })),
      resultsLimit: 1,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Apify HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
  const data = await response.json() as unknown;
  if (!Array.isArray(data)) throw new Error("Apify returned an unexpected payload shape.");
  return (data as Record<string, unknown>[])
    .map(normalizeFacebookPost)
    .filter((p): p is ApifyFacebookPost => p !== null);
}
