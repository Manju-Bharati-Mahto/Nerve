/**
 * Outreach sync service: pulls latest Instagram profile + post metrics from
 * Apify and upserts them into outreach_pages / outreach_posts.
 *
 * Campaign attribution rule: a post is attributed to a campaign when ALL
 * of the following hold:
 *   - The page is in the campaign's assigned_page_ids
 *   - The post's date falls inside [campaign.start_date, campaign.end_date]
 *   - The caption contains one of the campaign's creative_variants (case-
 *     insensitive substring)
 * If multiple campaigns match, the one with the closest start_date wins.
 */
import {
  listPages,
  listCampaigns,
  updatePage,
  upsertPostByInstagramId,
  getCampaign,
  getPage,
  type OutreachCampaign,
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
}

export interface SyncOptions {
  /** Limit sync to a subset of handles; if omitted, syncs all pages in DB. */
  handles?: string[];
  /** How many recent posts to fetch per profile. Apify is paid; default 30. */
  resultsLimit?: number;
}

const BATCH_SIZE = 20;

export async function syncOutreach(opts: SyncOptions = {}): Promise<SyncResult> {
  const allPages = await listPages();
  const campaigns = await listCampaigns();

  // Normalise both sides identically — strip whitespace, leading @,
  // lowercase — so `["@foo"]` matches a page stored as `"Foo"`.
  const normHandle = (h: string) => h.trim().toLowerCase().replace(/^@/, "");
  const targetPages = opts.handles && opts.handles.length > 0
    ? allPages.filter(p => opts.handles!.some(h => normHandle(h) === normHandle(p.handle)))
    : allPages;

  if (targetPages.length === 0) {
    return { ok: true, synced_pages: 0, upserted_posts: 0, skipped: [], attribution: { matched: 0, unmatched: 0 } };
  }

  const skipped: SyncResult["skipped"] = [];
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

  return {
    ok: true,
    synced_pages: targetPages.length - skipped.length,
    upserted_posts: upsertedPosts,
    skipped,
    attribution: { matched, unmatched },
  };
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
  // For reels Apify returns two view-ish fields:
  //   videoPlayCount  → the big number Instagram now shows publicly as "views"
  //   videoViewCount  → an older, smaller count (often missing)
  // Prefer plays so our totals match what users see on the post page.
  const views = post.videoPlayCount ?? post.videoViewCount ?? 0;

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
    if (date < c.start_date || date > c.end_date) continue;
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
  campaignId: string;
  pageId: string;
  urls: string[];
}

export interface AddLivePostsResult {
  ok: true;
  posts: OutreachPost[];
  /** URLs that Apify returned but couldn't be mapped to a post (bad URL, owner mismatch, etc). */
  skipped: { url: string; reason: string }[];
}

/**
 * Pulls metrics for the given Instagram URLs and persists each as a post tied
 * to (campaignId, pageId). Used by the "add live posts" dialog so a user can
 * spot-check specific posts/reels without re-scraping a whole profile.
 *
 * Validation rules:
 *   - Page must be in the campaign's assigned_page_ids
 *   - Each URL must look like an Instagram post / reel
 *   - Scraped post's ownerUsername must match the page's handle (we don't want
 *     someone pasting another page's link under page A)
 */
export async function addLivePosts(input: AddLivePostsInput): Promise<AddLivePostsResult> {
  const campaign = await getCampaign(input.campaignId);
  if (!campaign) throw new Error("Campaign not found.");
  const page = await getPage(input.pageId);
  if (!page) throw new Error("Page not found.");
  if (!campaign.assigned_page_ids.includes(page.id)) {
    throw new Error("This page is not assigned to the selected campaign.");
  }

  const skipped: AddLivePostsResult["skipped"] = [];
  const validUrls: string[] = [];
  for (const raw of input.urls) {
    const url = raw.trim();
    if (!url) continue;
    if (!extractInstagramShortcode(url)) {
      skipped.push({ url, reason: "Not a recognisable Instagram post or reel URL." });
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
  const pageHandle = page.handle.trim().toLowerCase().replace(/^@/, "");

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
      // than risk attaching a stranger's post to the picked page.
      skipped.push({ url, reason: "Could not verify the post owner. Try again or use a different URL." });
      continue;
    }
    if (owner !== pageHandle) {
      skipped.push({ url, reason: `Post belongs to @${result.ownerUsername}, not @${page.handle}.` });
      continue;
    }

    const post = await persistLivePost(page, campaign, result);
    if (post) persisted.push(post);
    else skipped.push({ url, reason: "Apify response was missing an ID or timestamp." });
  }

  return { ok: true, posts: persisted, skipped };
}

async function persistLivePost(
  page: OutreachPage,
  campaign: OutreachCampaign,
  post: ApifyPostResult,
): Promise<OutreachPost | null> {
  const instagramId = post.id || post.shortCode;
  if (!instagramId) return null;
  if (!post.timestamp) return null;

  const date = post.timestamp.slice(0, 10);
  const caption = post.caption ?? "";
  const type = inferPostType(post);
  // For reels Apify returns two view-ish fields:
  //   videoPlayCount  → the big number Instagram now shows publicly as "views"
  //   videoViewCount  → an older, smaller count (often missing)
  // Prefer plays so our totals match what users see on the post page.
  const views = post.videoPlayCount ?? post.videoViewCount ?? 0;

  // Pick a creative_variant if the caption mentions one — same rule as the
  // bulk sync, but constrained to *this* campaign's variants (we already know
  // the campaign here, no attribution lookup needed).
  let variant: string | null = null;
  const lowerCaption = caption.toLowerCase();
  for (const v of campaign.creative_variants) {
    if (v && lowerCaption.includes(v.toLowerCase())) { variant = v; break; }
  }

  return upsertPostByInstagramId({
    instagram_id: instagramId,
    page_id: page.id,
    campaign_id: campaign.id,
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
  });
}
