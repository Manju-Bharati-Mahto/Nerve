/**
 * Outreach sync service: pulls latest Instagram profile + post metrics from
 * Apify and upserts them into outreach_pages / outreach_posts.
 *
 * Campaign attribution rule: a post is attributed to a campaign when ALL
 * of the following hold:
 *   - The page is in the campaign's assigned_page_ids
 *   - The post's date falls inside [campaign.start_date, campaign.end_date]
 *     (campaigns without an end_date are open-ended — start onwards)
 *   - The caption contains one of the campaign's creative_variants (case-
 *     insensitive substring)
 * If multiple campaigns match, the one with the closest start_date wins.
 */
import {
  listPages,
  listCampaigns,
  listPosts,
  updatePage,
  upsertPostByInstagramId,
  listLivePostsWithPermalink,
  updatePostMetrics,
  getCampaign,
  getPage,
  getCreator,
  type OutreachCampaign,
  type OutreachCreator,
  type OutreachPage,
  type OutreachPost,
} from "./outreach-db.js";
import {
  fetchInstagramProfiles,
  fetchInstagramPostsByUrls,
  inferPostType,
  extractInstagramShortcode,
  type ApifyLatestPost,
  type ApifyPostResult,
} from "./integrations/apify.js";

export interface SyncResult {
  ok: true;
  synced_pages: number;
  upserted_posts: number;
  skipped: { handle: string; reason: string }[];
  attribution: { matched: number; unmatched: number };
  /** Tracked live posts whose metrics (reach/likes/comments) were refreshed. */
  refreshed_live_posts: number;
}

export interface SyncOptions {
  /** Limit sync to a subset of handles; if omitted, syncs all pages in DB. */
  handles?: string[];
  /** How many recent posts to fetch per profile. Apify is paid; default 30. */
  resultsLimit?: number;
  /**
   * When true, also re-scrape every tracked live post by permalink (extra paid
   * Apify Post Scraper runs). Only the scheduled 9AM/5PM runs set this — manual
   * "Sync now" leaves it off to keep interactive syncs cheap (profile data only).
   */
  refreshLivePosts?: boolean;
}

const BATCH_SIZE = 20;

/**
 * The true public "views" for a post. Instagram's reel "Views" (the big number
 * shown on the app) is reported by Apify under different keys across post types
 * and actor versions — videoPlayCount, videoViewCount, igPlayCount, playCount,
 * viewCount, and sometimes a bare `views` — and any given field can be zero,
 * absent, or an older/smaller count that doesn't match the unified "Views".
 *
 * Rather than a fixed `??` chain (which a present-but-zero field would shadow,
 * and which misses whatever key the actor actually populated), we scan every
 * top-level numeric field whose name looks like a view/play/impression count
 * and take the LARGEST — that's the public "Views" number. Returns null only
 * when no such field is present, so callers can keep an existing value instead
 * of zeroing it out.
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

function bestViewCount(post: unknown): number | null {
  if (!post || typeof post !== "object") return null;
  let best: number | null = null;
  for (const [key, value] of Object.entries(post as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && isViewCountKey(key)) {
      if (best === null || value > best) best = value;
    }
  }
  return best;
}

export async function syncOutreach(opts: SyncOptions = {}): Promise<SyncResult> {
  const allPages = await listPages();
  const campaigns = await listCampaigns();

  // Normalise both sides identically — strip whitespace, leading @,
  // lowercase — so `["@foo"]` matches a page stored as `"Foo"`.
  const normHandle = (h: string) => h.trim().toLowerCase().replace(/^@/, "");
  // Only Instagram pages are syncable — the profile scraper is IG-only.
  // Facebook pages are reported as skipped (not silently dropped) so the sync
  // summary stays honest about what wasn't refreshed.
  const igPages = allPages.filter(p => p.platform !== "facebook");
  const fbPages = allPages.filter(p => p.platform === "facebook");
  const targetPages = opts.handles && opts.handles.length > 0
    ? igPages.filter(p => opts.handles!.some(h => normHandle(h) === normHandle(p.handle)))
    : igPages;
  const skippedFacebook: SyncResult["skipped"] = (opts.handles && opts.handles.length > 0
    ? fbPages.filter(p => opts.handles!.some(h => normHandle(h) === normHandle(p.handle)))
    : fbPages
  ).map(p => ({ handle: p.handle, reason: "Facebook page — sync starts once the Facebook scraper is integrated" }));

  if (targetPages.length === 0) {
    return { ok: true, synced_pages: 0, upserted_posts: 0, skipped: skippedFacebook, attribution: { matched: 0, unmatched: 0 }, refreshed_live_posts: 0 };
  }

  const skipped: SyncResult["skipped"] = [...skippedFacebook];
  let upsertedPosts = 0;
  let matched = 0;
  let unmatched = 0;

  // Index pages by lowercased handle so we can match Apify's `username`
  // (which is always the canonical lowercase form) to our records.
  const pageByHandle = new Map<string, OutreachPage>();
  for (const p of targetPages) {
    pageByHandle.set(p.handle.trim().toLowerCase().replace(/^@/, ""), p);
  }

  // Batch handles to keep Apify run sizes bounded.
  for (let i = 0; i < targetPages.length; i += BATCH_SIZE) {
    const batch = targetPages.slice(i, i + BATCH_SIZE);
    const handles = batch.map(p => p.handle);
    const profiles = await fetchInstagramProfiles({ handles, resultsLimit: opts.resultsLimit ?? 30 });

    for (const profile of profiles) {
      if (!profile.username) continue;
      const page = pageByHandle.get(profile.username.toLowerCase());
      if (!page) {
        skipped.push({ handle: profile.username, reason: "no matching page in DB" });
        continue;
      }
      if (profile.error) {
        skipped.push({ handle: profile.username, reason: profile.error });
        continue;
      }

      // Update follower count + last_synced_at on the page.
      await updatePage(page.id, {
        followers: profile.followersCount ?? page.followers,
        last_synced_at: new Date().toISOString(),
      });

      for (const post of profile.latestPosts ?? []) {
        const result = await persistPost(page, post, campaigns);
        if (result === "upserted_matched") { upsertedPosts++; matched++; }
        else if (result === "upserted_unmatched") { upsertedPosts++; unmatched++; }
      }
    }
  }

  // The profile scrape above only sees each account's most-recent posts, so a
  // tracked live post that has since scrolled past that window would never get
  // fresh numbers. Re-scrape the operator-curated live posts by permalink to
  // move the dashboard's reach/views KPIs — but ONLY on the scheduled runs
  // (opts.refreshLivePosts): those extra Post Scraper calls are the expensive
  // part, so manual "Sync now" skips them and just re-pulls profile data.
  let refreshed = 0;
  if (opts.refreshLivePosts) {
    const pageIds = opts.handles && opts.handles.length > 0 ? targetPages.map(p => p.id) : undefined;
    ({ refreshed } = await refreshLivePostMetrics({ pageIds }));
  }

  return {
    ok: true,
    // FB skips were never in targetPages — subtract only the IG-side skips.
    synced_pages: targetPages.length - (skipped.length - skippedFacebook.length),
    upserted_posts: upsertedPosts,
    skipped,
    attribution: { matched, unmatched },
    refreshed_live_posts: refreshed,
  };
}

// How many live-post permalinks to send to the Post Scraper per actor run.
const LIVE_REFRESH_BATCH = 50;

/**
 * Refreshes the metrics of every operator-added live post that has a permalink,
 * using the same by-URL Post Scraper the "Add live posts" dialog uses. This is
 * what makes the dashboard's Total Reach / Views update in real time on "Sync
 * now" — the profile scrape alone can't, since it's capped to recent posts.
 *
 * Matches each scraped result back to its stored row by Instagram shortcode and
 * updates metrics in place (never re-attributes campaign/page/creator). Rows
 * that Apify can't return (deleted post, transient error) keep their last-known
 * numbers rather than being zeroed.
 */
export async function refreshLivePostMetrics(
  scope: { pageIds?: string[]; campaignId?: string } = {},
): Promise<{ refreshed: number; failed: number }> {
  const livePosts = await listLivePostsWithPermalink(scope);
  if (livePosts.length === 0) return { refreshed: 0, failed: 0 };

  let refreshed = 0;
  let failed = 0;
  // Video posts whose batch result was missing videoPlayCount (Instagram's
  // real public "views"). The actor drops that field intermittently on batched
  // runs while single-URL runs reliably include it, so these get a targeted
  // second pass below. Without it a reel can sit at the far smaller
  // videoViewCount (e.g. 4.9k shown vs 23.9k actual plays).
  const missingPlays: OutreachPost[] = [];

  for (let i = 0; i < livePosts.length; i += LIVE_REFRESH_BATCH) {
    const batch = livePosts.slice(i, i + LIVE_REFRESH_BATCH);
    const urls = batch.map(p => p.permalink!).filter(Boolean);
    const results = await fetchInstagramPostsByUrls(urls);

    // Index scraped results by lowercased shortcode so we can match them back
    // to the rows we asked for (order isn't guaranteed by the actor).
    const byShortcode = new Map<string, ApifyPostResult>();
    for (const r of results) {
      const key = (r.shortCode ?? "").toLowerCase();
      if (key) byShortcode.set(key, r);
    }

    for (const post of batch) {
      const shortcode = extractInstagramShortcode(post.permalink!)?.toLowerCase();
      const r = shortcode ? byShortcode.get(shortcode) : undefined;
      if (!r || r.error) {
        failed++;
        // A failed post silently keeps its last-known numbers, which looks the
        // same as "Apify returned the old value" — log why so stale metrics
        // are diagnosable from the server log.
        console.warn(`[refresh-reach] kept last-known metrics for ${post.permalink}: ${!r ? "no result returned by actor" : r.error}`);
        continue;
      }
      const views = bestViewCount(r) ?? post.views;
      await updatePostMetrics(post.id, {
        likes: r.likesCount ?? post.likes,
        comments: r.commentsCount ?? post.comments,
        views,
        media_url: r.displayUrl ?? post.media_url,
      });
      refreshed++;
      // Queue videos with untrustworthy plays data for an individual re-scrape.
      // Plays are structurally >= unique views on Instagram, so a missing plays
      // count — or one that doesn't exceed the view count — means the batch
      // returned degraded data for this post.
      const isVideo = (r.videoViewCount ?? 0) > 0 || inferPostType(r) === "reel";
      const plays = typeof r.videoPlayCount === "number" ? r.videoPlayCount : 0;
      const playsTrustworthy = plays > (r.videoViewCount ?? 0);
      if (isVideo && !playsTrustworthy) missingPlays.push(post);
    }
  }

  // Second pass: individually re-scrape videos whose plays count was missing.
  // Each is its own (paid) actor run, so cap the pass; stragglers get another
  // chance on the next scheduled sync, and the monotonic views clamp means a
  // recovered plays count sticks forever after.
  const RETRY_CAP = 15;
  if (missingPlays.length > RETRY_CAP) {
    console.warn(`[refresh-reach] ${missingPlays.length} video post(s) missing plays count; retrying first ${RETRY_CAP} this run.`);
  }
  for (const post of missingPlays.slice(0, RETRY_CAP)) {
    try {
      const [r] = await fetchInstagramPostsByUrls([post.permalink!]);
      if (!r || r.error) continue;
      const views = bestViewCount(r);
      if (views == null) continue;
      await updatePostMetrics(post.id, {
        likes: r.likesCount ?? post.likes,
        comments: r.commentsCount ?? post.comments,
        views,
        media_url: r.displayUrl ?? post.media_url,
      });
      console.log(`[refresh-reach] recovered plays count for ${post.permalink}: ${views}`);
    } catch (err) {
      console.warn(`[refresh-reach] individual re-scrape failed for ${post.permalink}:`, err instanceof Error ? err.message : err);
    }
  }

  return { refreshed, failed };
}

// NOTE: the former scheduled auto-sync (9:00 AM & 5:00 PM IST) was removed by
// request — syncing is now MANUAL ONLY: the "Sync now" button (POST
// /api/outreach/sync) and the live-post refresh (POST /api/outreach/refresh-reach).
// Nothing calls Apify on a timer any more.

/**
 * Per-campaign sync: re-scrapes ONLY the live posts attributed to the given
 * campaign (not the whole department's). Facebook rows can't be scraped until
 * the FB scraper is integrated — they're counted and reported, never attempted.
 */
export async function syncCampaignPosts(campaignId: string): Promise<{
  ok: true; refreshed: number; failed: number; facebook_skipped: number;
}> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found.");
  const campaignPosts = await listPosts({ campaignId });
  const facebook_skipped = campaignPosts.filter(p => p.platform === "facebook" && p.added_as_live).length;
  const { refreshed, failed } = await refreshLivePostMetrics({ campaignId });
  return { ok: true, refreshed, failed, facebook_skipped };
}

// ── Facebook link parsing ──────────────────────────────────────────────────
//
// No Facebook scraper exists yet ("planned API scraper" — metrics stay 0 until
// it lands), but campaign links must already be enterable and tracked. This
// recognises the common shapes of a Facebook post / reel / video URL and
// returns a stable id + inferred type.
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
 * Persists Facebook links as manual (unscrapeable-for-now) live posts under a
 * Facebook page: platform 'facebook', metrics 0, date = added-on date. The id
 * is namespaced ("fb:<id>") into the same UNIQUE column the IG ids use, so
 * re-adding a link updates the existing row instead of duplicating it. Once
 * the Facebook scraper is integrated these rows are the ones it will hydrate.
 */
async function addFacebookLivePosts(ctx: {
  page: OutreachPage;
  campaign: OutreachCampaign | null;
  urls: string[];
  forceVariant?: string;
}): Promise<AddLivePostsResult> {
  const skipped: AddLivePostsResult["skipped"] = [];
  const persisted: OutreachPost[] = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const raw of ctx.urls) {
    const url = raw.trim();
    if (!url) continue;
    if (extractInstagramShortcode(url)) {
      skipped.push({ url, reason: `This is an Instagram URL, but @${ctx.page.handle} is a Facebook page.` });
      continue;
    }
    const ref = extractFacebookPostRef(url);
    if (!ref) {
      skipped.push({ url, reason: "Not a recognisable Facebook post / reel / video URL." });
      continue;
    }
    const post = await upsertPostByInstagramId({
      instagram_id: `fb:${ref.id}`,
      platform: "facebook",
      page_id: ctx.page.id,
      campaign_id: ctx.campaign?.id ?? null,
      date: today,
      type: ref.type,
      creative_variant: ctx.forceVariant && ctx.campaign?.creative_variants.includes(ctx.forceVariant) ? ctx.forceVariant : null,
      caption: "",
      status: "published",
      likes: 0, comments: 0, views: 0, saves: 0, shares: 0,
      media_url: null,
      permalink: url,
      added_as_live: true,
    });
    persisted.push(post);
  }
  return { ok: true, posts: persisted, skipped };
}

async function persistPost(
  page: OutreachPage,
  post: ApifyLatestPost,
  campaigns: OutreachCampaign[],
): Promise<"upserted_matched" | "upserted_unmatched" | "skipped"> {
  const instagramId = post.id || post.shortCode;
  if (!instagramId) return "skipped";
  if (!post.timestamp) return "skipped";

  const date = post.timestamp.slice(0, 10);
  const caption = post.caption ?? "";
  const type = inferPostType(post);
  const views = bestViewCount(post) ?? 0;

  const attribution = attributePostToCampaign(page.id, date, caption, campaigns);

  await upsertPostByInstagramId({
    instagram_id: instagramId,
    page_id: page.id,
    campaign_id: attribution?.campaignId ?? null,
    date,
    type,
    creative_variant: attribution?.variant ?? null,
    caption,
    status: "published",
    likes: post.likesCount ?? 0,
    comments: post.commentsCount ?? 0,
    views,
    // Apify Profile Scraper can't read saves/shares; leave at 0.
    saves: 0,
    shares: 0,
    media_url: post.displayUrl ?? null,
    permalink: post.url ?? null,
  });

  return attribution ? "upserted_matched" : "upserted_unmatched";
}

function attributePostToCampaign(
  pageId: string,
  date: string,
  caption: string,
  campaigns: OutreachCampaign[],
): { campaignId: string; variant: string } | null {
  const lowerCaption = caption.toLowerCase();
  const candidates: { campaign: OutreachCampaign; variant: string }[] = [];

  for (const c of campaigns) {
    if (!c.assigned_page_ids.includes(pageId)) continue;
    if (date < c.start_date) continue;
    // Open-ended campaigns (no end date) accept any post from the start onwards.
    if (c.end_date && date > c.end_date) continue;
    for (const variant of c.creative_variants) {
      if (!variant) continue;
      if (lowerCaption.includes(variant.toLowerCase())) {
        candidates.push({ campaign: c, variant });
        break;
      }
    }
  }

  if (candidates.length === 0) return null;
  // Tie-break: pick the campaign whose start_date is closest to the post date.
  candidates.sort((a, b) =>
    Math.abs(daysBetween(a.campaign.start_date, date)) - Math.abs(daysBetween(b.campaign.start_date, date)),
  );
  return { campaignId: candidates[0].campaign.id, variant: candidates[0].variant };
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(a).getTime() - new Date(b).getTime()) / 86400_000);
}

// ── Add-live-posts: per-URL fetch + upsert ────────────────────────────────

export interface AddLivePostsInput {
  /** Optional. Required when pageId is set (the page must belong to the campaign).
   *  For creators it's optional — a creator can hold standalone posts. */
  campaignId?: string;
  /** Provide exactly one of pageId or creatorId. */
  pageId?: string;
  creatorId?: string;
  urls: string[];
  /** Explicit "set" (creative variant) to tag all of these live posts with.
   *  When omitted, the per-post auto-match from caption is used (legacy
   *  behaviour). Must be one of `campaign.creative_variants` when set. */
  creativeVariant?: string;
}

export interface AddLivePostsResult {
  ok: true;
  posts: OutreachPost[];
  /** URLs that Apify returned but couldn't be mapped to a post (bad URL, owner mismatch, etc). */
  skipped: { url: string; reason: string }[];
}

/**
 * Pulls metrics for the given Instagram URLs and persists each as a post tied
 * to either a page (always inside a campaign) or a creator (campaign optional).
 *
 * Validation rules:
 *   - Exactly one of pageId / creatorId must be set.
 *   - For pageId: campaignId is required, and the page must be in the campaign's
 *     assigned_page_ids.
 *   - For creatorId: campaignId is optional; if provided, the creator must be
 *     in the campaign's assigned_creator_ids.
 *   - Each URL must look like an Instagram post / reel.
 *   - Scraped post's ownerUsername must match the subject's handle.
 */
export async function addLivePosts(input: AddLivePostsInput): Promise<AddLivePostsResult> {
  if (Boolean(input.pageId) === Boolean(input.creatorId)) {
    throw new Error("Provide exactly one of pageId or creatorId.");
  }

  let campaign: OutreachCampaign | null = null;
  if (input.campaignId) {
    campaign = await getCampaign(input.campaignId);
    if (!campaign) throw new Error("Campaign not found.");
  }

  // If the caller picked an explicit creative_variant, validate it belongs to
  // the campaign's known set list. Reject early rather than silently fall back.
  if (input.creativeVariant !== undefined && input.creativeVariant !== null && input.creativeVariant !== '') {
    if (!campaign) throw new Error("creativeVariant requires a campaign.");
    if (!campaign.creative_variants.includes(input.creativeVariant)) {
      throw new Error(`creativeVariant "${input.creativeVariant}" is not in this campaign.`);
    }
  }

  let page: OutreachPage | null = null;
  let creator: OutreachCreator | null = null;
  if (input.pageId) {
    page = await getPage(input.pageId);
    if (!page) throw new Error("Page not found.");
    // Campaign is now optional for page-side live posts (admin can add live
    // posts directly from the All Pages tab). When a campaign IS provided,
    // the page must still belong to it.
    if (campaign && !campaign.assigned_page_ids.includes(page.id)) {
      throw new Error("This page is not assigned to the selected campaign.");
    }
  } else {
    creator = await getCreator(input.creatorId!);
    if (!creator) throw new Error("Creator not found.");
    if (campaign && !campaign.assigned_creator_ids.includes(creator.id)) {
      throw new Error("This creator is not assigned to the selected campaign.");
    }
  }

  // Facebook pages take the manual (no-scraper-yet) path: links are validated
  // as Facebook URLs and persisted with zero metrics for later hydration.
  if (page && page.platform === "facebook") {
    return addFacebookLivePosts({ page, campaign, urls: input.urls, forceVariant: input.creativeVariant });
  }

  const subjectHandle = (page ?? creator)!.handle.trim().toLowerCase().replace(/^@/, "");

  const skipped: AddLivePostsResult["skipped"] = [];
  const validUrls: string[] = [];
  for (const raw of input.urls) {
    const url = raw.trim();
    if (!url) continue;
    if (!extractInstagramShortcode(url)) {
      skipped.push({
        url,
        reason: extractFacebookPostRef(url)
          ? `This is a Facebook URL, but @${subjectHandle} is an Instagram ${page ? "page" : "creator"}. Add it under a Facebook page instead.`
          : "Not a recognisable Instagram post or reel URL.",
      });
      continue;
    }
    validUrls.push(url);
  }

  if (validUrls.length === 0) {
    return { ok: true, posts: [], skipped };
  }

  const results = await fetchInstagramPostsByUrls(validUrls);
  const byShortcode = new Map<string, ApifyPostResult>();
  for (const r of results) {
    const key = (r.shortCode ?? "").toLowerCase();
    if (key) byShortcode.set(key, r);
  }

  const persisted: OutreachPost[] = [];

  for (const url of validUrls) {
    const shortcode = extractInstagramShortcode(url)!.toLowerCase();
    const result = byShortcode.get(shortcode);
    if (!result) {
      skipped.push({ url, reason: "Apify did not return data for this URL." });
      continue;
    }
    if (result.error) {
      skipped.push({ url, reason: result.error });
      continue;
    }
    const owner = (result.ownerUsername ?? "").toLowerCase();
    if (!owner) {
      // Apify didn't tell us who owns this post — refuse the upsert rather
      // than risk attaching a stranger's post to the picked subject.
      skipped.push({ url, reason: "Could not verify the post owner. Try again or use a different URL." });
      continue;
    }
    if (owner !== subjectHandle) {
      const display = page?.handle ?? creator?.handle ?? subjectHandle;
      skipped.push({ url, reason: `Post belongs to @${result.ownerUsername}, not @${display}.` });
      continue;
    }

    const post = await persistLivePost({ page, creator, campaign, post: result, forceVariant: input.creativeVariant });
    if (post) persisted.push(post);
    else skipped.push({ url, reason: "Apify response was missing an ID or timestamp." });
  }

  return { ok: true, posts: persisted, skipped };
}

async function persistLivePost(ctx: {
  page: OutreachPage | null;
  creator: OutreachCreator | null;
  campaign: OutreachCampaign | null;
  post: ApifyPostResult;
  /** When provided, this variant is used verbatim instead of caption auto-match. */
  forceVariant?: string;
}): Promise<OutreachPost | null> {
  const { page, creator, campaign, post, forceVariant } = ctx;
  const instagramId = post.id || post.shortCode;
  if (!instagramId) return null;
  if (!post.timestamp) return null;

  const date = post.timestamp.slice(0, 10);
  const caption = post.caption ?? "";
  const type = inferPostType(post);
  const views = bestViewCount(post) ?? 0;

  // Pick a creative_variant. Priority: explicit forceVariant from caller,
  // otherwise auto-match from caption against this campaign's variants
  // (skipped when there's no campaign — creator-side standalone posts).
  let variant: string | null = null;
  if (forceVariant && campaign?.creative_variants.includes(forceVariant)) {
    variant = forceVariant;
  } else if (campaign) {
    const lowerCaption = caption.toLowerCase();
    for (const v of campaign.creative_variants) {
      if (v && lowerCaption.includes(v.toLowerCase())) { variant = v; break; }
    }
  }

  return upsertPostByInstagramId({
    instagram_id: instagramId,
    page_id: page?.id ?? null,
    creator_id: creator?.id ?? null,
    campaign_id: campaign?.id ?? null,
    date,
    type,
    creative_variant: variant,
    caption,
    status: "published",
    likes: post.likesCount ?? 0,
    comments: post.commentsCount ?? 0,
    views,
    saves: 0,
    shares: 0,
    media_url: post.displayUrl ?? null,
    permalink: post.url ?? null,
    added_as_live: true,
  });
}
