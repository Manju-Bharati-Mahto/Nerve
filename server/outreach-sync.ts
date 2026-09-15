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
  fetchFacebookPagePosts,
  fetchFacebookPostsByUrls,
  inferPostType,
  extractInstagramShortcode,
  extractFacebookPostRef,
  bestViewCount,
  type ApifyLatestPost,
  type ApifyPostResult,
  type ApifyFacebookPost,
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
// Facebook page batches are kept smaller than Instagram's — a newer, costlier
// integration; raise once real usage patterns are understood.
const FB_BATCH_SIZE = 10;

export async function syncOutreach(opts: SyncOptions = {}): Promise<SyncResult> {
  const allPages = await listPages();
  const campaigns = await listCampaigns();

  // Normalise both sides identically — strip whitespace, leading @,
  // lowercase — so `["@foo"]` matches a page stored as `"Foo"`.
  const normHandle = (h: string) => h.trim().toLowerCase().replace(/^@/, "");
  const igPages = allPages.filter(p => p.platform !== "facebook");
  const fbPages = allPages.filter(p => p.platform === "facebook");
  const targetPages = opts.handles && opts.handles.length > 0
    ? igPages.filter(p => opts.handles!.some(h => normHandle(h) === normHandle(p.handle)))
    : igPages;
  const targetFbPages = opts.handles && opts.handles.length > 0
    ? fbPages.filter(p => opts.handles!.some(h => normHandle(h) === normHandle(p.handle)))
    : fbPages;

  const skipped: SyncResult["skipped"] = [];
  let upsertedPosts = 0;
  let matched = 0;
  let unmatched = 0;
  let syncedPageCount = 0;

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
      syncedPageCount++;

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

  // Facebook pages — same shape of work as the Instagram loop above (batch
  // scrape each page's recent posts, upsert + auto-attribute by caption
  // match), just via the Facebook Posts Scraper actor and matched back to our
  // DB pages by the actor's `inputUrl` (falls back to pageName if a run drops
  // it) rather than by username, since Facebook page URLs vary in shape.
  const normName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  for (let i = 0; i < targetFbPages.length; i += FB_BATCH_SIZE) {
    const batch = targetFbPages.slice(i, i + FB_BATCH_SIZE);
    const pageUrlByPage = new Map(batch.map(p => [p.id, `https://www.facebook.com/${p.handle.trim().replace(/^@/, "")}`]));
    const pageByUrl = new Map<string, OutreachPage>();
    for (const p of batch) pageByUrl.set((pageUrlByPage.get(p.id) as string).toLowerCase().replace(/\/$/, ""), p);

    let items: ApifyFacebookPost[] = [];
    try {
      items = await fetchFacebookPagePosts(Array.from(pageUrlByPage.values()), opts.resultsLimit ? Math.min(opts.resultsLimit, 15) : 10);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Facebook scrape failed.";
      for (const p of batch) skipped.push({ handle: p.handle, reason });
      continue;
    }

    const touchedPageIds = new Set<string>();
    // Opportunistic: a page-feed scrape already carries each post's owner id
    // for free — cache it now so "Add live posts" doesn't need its own
    // extra actor call to resolve this page's identity later.
    const ownerIdByPageId = new Map<string, string>();
    for (const item of items) {
      const inputUrl = item.inputUrl ? item.inputUrl.toLowerCase().replace(/\/$/, "") : undefined;
      const page = (inputUrl && pageByUrl.get(inputUrl))
        ?? batch.find(p => item.pageName && normName(p.handle) === normName(item.pageName!));
      if (!page) continue; // best-effort attribution, same spirit as the IG loop's no-match skip

      touchedPageIds.add(page.id);
      if (item.ownerId && !page.platform_page_id) ownerIdByPageId.set(page.id, item.ownerId);
      const date = item.publishedAt ? item.publishedAt.slice(0, 10) : new Date().toISOString().slice(0, 10);
      const attribution = attributePostToCampaign(page.id, date, item.caption, campaigns);
      await upsertPostByInstagramId({
        instagram_id: `fb:${item.ref}`,
        platform: "facebook",
        page_id: page.id,
        campaign_id: attribution?.campaignId ?? null,
        date,
        type: item.mediaType ?? "static",
        creative_variant: attribution?.variant ?? null,
        caption: item.caption,
        status: "published",
        likes: item.likes ?? 0,
        comments: item.comments ?? 0,
        views: item.views ?? 0,
        // The actor doesn't reliably separate saves from other reactions.
        saves: 0,
        shares: item.shares ?? 0,
        media_url: null,
        permalink: item.url,
      });
      upsertedPosts++;
      if (attribution) matched++; else unmatched++;
    }

    for (const id of touchedPageIds) {
      syncedPageCount++;
      const cachedOwnerId = ownerIdByPageId.get(id);
      await updatePage(id, { last_synced_at: new Date().toISOString(), ...(cachedOwnerId ? { platform_page_id: cachedOwnerId } : {}) });
    }
    // Pages in this batch that produced nothing (private/empty/unreachable)
    // aren't silently dropped from the summary.
    for (const p of batch) {
      if (!touchedPageIds.has(p.id)) skipped.push({ handle: p.handle, reason: "No posts returned by the Facebook scraper." });
    }
  }

  // The profile/page scrapes above only see each account's most-recent posts,
  // so a tracked live post that has since scrolled past that window would
  // never get fresh numbers. Re-scrape the operator-curated live posts by
  // permalink to move the dashboard's reach/views KPIs — but ONLY on the
  // scheduled runs (opts.refreshLivePosts): those extra Post Scraper calls are
  // the expensive part, so manual "Sync now" skips them and just re-pulls feed
  // data.
  let refreshed = 0;
  if (opts.refreshLivePosts) {
    const pageIds = opts.handles && opts.handles.length > 0
      ? [...targetPages, ...targetFbPages].map(p => p.id)
      : undefined;
    ({ refreshed } = await refreshLivePostMetrics({ pageIds }));
  }

  return {
    ok: true,
    synced_pages: syncedPageCount,
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

  const igLivePosts = livePosts.filter(p => p.platform !== "facebook");
  const fbLivePosts = livePosts.filter(p => p.platform === "facebook");

  let refreshed = 0;
  let failed = 0;

  ({ refreshed, failed } = await refreshInstagramLiveMetrics(igLivePosts, refreshed, failed));
  ({ refreshed, failed } = await refreshFacebookLiveMetrics(fbLivePosts, refreshed, failed));

  return { refreshed, failed };
}

async function refreshInstagramLiveMetrics(
  livePosts: OutreachPost[], refreshedIn: number, failedIn: number,
): Promise<{ refreshed: number; failed: number }> {
  if (livePosts.length === 0) return { refreshed: refreshedIn, failed: failedIn };
  let refreshed = refreshedIn;
  let failed = failedIn;
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

/**
 * Re-scrapes Facebook live posts by permalink, matched back to their DB row
 * via extractFacebookPostRef (the actor's `inputUrl` field is only populated
 * in page-feed mode, not for direct post/reel URLs — see fetchFacebookPostsByUrls).
 * Never touches type/attribution — metrics only, same contract as the
 * Instagram path above.
 */
async function refreshFacebookLiveMetrics(
  livePosts: OutreachPost[], refreshedIn: number, failedIn: number,
): Promise<{ refreshed: number; failed: number }> {
  if (livePosts.length === 0) return { refreshed: refreshedIn, failed: failedIn };
  let refreshed = refreshedIn;
  let failed = failedIn;

  for (let i = 0; i < livePosts.length; i += LIVE_REFRESH_BATCH) {
    const batch = livePosts.slice(i, i + LIVE_REFRESH_BATCH);
    const urls = batch.map(p => p.permalink!).filter(Boolean);
    let results: ApifyFacebookPost[] = [];
    try {
      results = await fetchFacebookPostsByUrls(urls);
    } catch (err) {
      failed += batch.length;
      console.warn(`[refresh-reach] Facebook batch scrape failed:`, err instanceof Error ? err.message : err);
      continue;
    }

    const byRef = new Map<string, ApifyFacebookPost>();
    for (const r of results) byRef.set(r.ref.toLowerCase(), r);

    for (const post of batch) {
      const ref = extractFacebookPostRef(post.permalink!)?.id.toLowerCase();
      const r = ref ? byRef.get(ref) : undefined;
      if (!r) {
        failed++;
        console.warn(`[refresh-reach] kept last-known metrics for ${post.permalink}: no Facebook result returned`);
        continue;
      }
      await updatePostMetrics(post.id, {
        likes: r.likes ?? post.likes,
        comments: r.comments ?? post.comments,
        views: r.views ?? post.views,
        shares: r.shares,
      });
      refreshed++;
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
 * campaign (not the whole department's) — both Instagram and Facebook, each
 * routed to its own actor by refreshLivePostMetrics.
 */
export async function syncCampaignPosts(campaignId: string): Promise<{
  ok: true; refreshed: number; failed: number;
}> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) throw new Error("Campaign not found.");
  const { refreshed, failed } = await refreshLivePostMetrics({ campaignId });
  return { ok: true, refreshed, failed };
}

/**
 * Persists Facebook links as live posts under a Facebook page: platform
 * 'facebook', scraped metrics, mirroring persistLivePost's Instagram path.
 * The id is namespaced ("fb:<id>") into the same UNIQUE column the IG ids
 * use, so re-adding a link updates the existing row instead of duplicating it.
 *
 * URLs that don't scrape (deleted post, transient error) are still persisted
 * with zero metrics via extractFacebookPostRef's type inference — rather than
 * rejecting the whole link — since the operator's intent (attach this URL to
 * this campaign) is clear even when Apify can't confirm it yet; the next
 * "Sync" on the campaign will pick up real numbers once available.
 */
/**
 * Resolves — and caches on the page row — a Facebook page's own canonical
 * numeric id (Meta's stable identifier), by scraping the page's OWN URL
 * (built from its stored `handle`, which only an operator can set). This is
 * the trust anchor "Add live posts" verifies a pasted post's scraped owner id
 * against, so a post pasted under the wrong page can't be accepted: the
 * identity check never depends on anything derived from the pasted URL
 * itself, only on what the page's own feed reports about its own posts.
 *
 * Cached after the first successful resolution — subsequent calls for the
 * same page cost nothing extra. Returns null if the page has no scrapeable
 * posts yet (brand new, empty page) or the actor call fails.
 */
async function resolveFacebookOwnerId(page: OutreachPage): Promise<string | null> {
  if (page.platform_page_id) return page.platform_page_id;
  const pageUrl = `https://www.facebook.com/${page.handle.trim().replace(/^@/, "")}`;
  let items: ApifyFacebookPost[];
  try {
    items = await fetchFacebookPagePosts([pageUrl], 3);
  } catch (err) {
    console.warn(`[add-live-posts] could not resolve @${page.handle}'s Facebook identity:`, err instanceof Error ? err.message : err);
    return null;
  }
  const ownerId = items.find(i => i.ownerId)?.ownerId;
  if (!ownerId) return null;
  await updatePage(page.id, { platform_page_id: ownerId });
  return ownerId;
}

async function addFacebookLivePosts(ctx: {
  page: OutreachPage;
  campaign: OutreachCampaign | null;
  urls: string[];
  forceVariant?: string;
}): Promise<AddLivePostsResult> {
  const skipped: AddLivePostsResult["skipped"] = [];
  const validRefs: { url: string; ref: { id: string; type: "static" | "reel" } }[] = [];
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
    validRefs.push({ url, ref });
  }
  if (validRefs.length === 0) return { ok: true, posts: [], skipped };

  // Establish the target page's own identity BEFORE trusting anything scraped
  // from the pasted URLs. Refuse rather than risk attaching a stranger's post
  // when we can't verify ownership at all — same philosophy as Instagram's
  // "Could not verify the post owner" refusal.
  const ownerId = await resolveFacebookOwnerId(ctx.page);
  if (!ownerId) {
    throw new Error(`Could not verify @${ctx.page.handle}'s Facebook identity right now — try again shortly, or confirm the page URL is correct.`);
  }

  // Let a scrape failure propagate as a real error (same as the Instagram
  // path) instead of silently persisting placeholder zero-metric rows — a
  // misconfigured APIFY_TOKEN or an actor outage must be visible, not masked
  // as "saved with no likes/shares".
  const scraped = await fetchFacebookPostsByUrls(validRefs.map(v => v.url));
  const byRef = new Map(scraped.map(s => [s.ref.toLowerCase(), s]));

  const persisted: OutreachPost[] = [];
  const forceVariant = ctx.forceVariant && ctx.campaign?.creative_variants.includes(ctx.forceVariant) ? ctx.forceVariant : null;

  for (const { url, ref } of validRefs) {
    const s = byRef.get(ref.id.toLowerCase());
    if (!s) {
      skipped.push({ url, reason: "Apify did not return data for this URL." });
      continue;
    }
    if (!s.ownerId) {
      skipped.push({ url, reason: "Could not verify the post's owning Facebook page. Try again or use a different URL." });
      continue;
    }
    if (s.ownerId !== ownerId) {
      skipped.push({
        url,
        reason: s.pageName
          ? `Post belongs to ${s.pageName}, not @${ctx.page.handle}.`
          : `Post belongs to a different Facebook page, not @${ctx.page.handle}.`,
      });
      continue;
    }
    const post = await upsertPostByInstagramId({
      instagram_id: `fb:${ref.id}`,
      platform: "facebook",
      page_id: ctx.page.id,
      campaign_id: ctx.campaign?.id ?? null,
      date: s.publishedAt ? s.publishedAt.slice(0, 10) : new Date().toISOString().slice(0, 10),
      type: s.mediaType ?? ref.type,
      creative_variant: forceVariant,
      caption: s.caption,
      status: "published",
      likes: s.likes ?? 0,
      comments: s.comments ?? 0,
      views: s.views ?? 0,
      saves: 0,
      shares: s.shares ?? 0,
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
