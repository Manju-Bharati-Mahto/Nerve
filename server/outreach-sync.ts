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
  type OutreachCampaign,
  type OutreachPage,
} from "./outreach-db.js";
import { fetchInstagramProfiles, inferPostType, type ApifyLatestPost } from "./integrations/apify.js";

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

  const targetPages = opts.handles && opts.handles.length > 0
    ? allPages.filter(p => opts.handles!.some(h => h.trim().toLowerCase() === p.handle.trim().toLowerCase()))
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
  const views = post.videoViewCount ?? post.videoPlayCount ?? 0;

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
