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

// ── Scheduled auto-sync (9:30 AM & 4:30 PM IST) ────────────────────────────
//
// The product spec requires metrics to auto-refresh twice a day. We don't pull
// in a cron dependency — instead `maybeRunScheduledSync()` is called from the
// existing 5-minute server interval (see server/index.ts) and self-gates:
//   - It only fires inside a short window after each slot's wall-clock time
//     (so a process restart at, say, 14:00 does NOT trigger a stale 9:30 run —
//     important during tsx-watch dev restarts since Apify is paid).
//   - Each (IST-date, slot) pair runs at most once, tracked in-memory.
// The manual "Sync now" button is unaffected and always available.
const SYNC_SLOTS_IST = [
  { label: "09:30", minutes: 9 * 60 + 30 },
  { label: "16:30", minutes: 16 * 60 + 30 },
] as const;
// How long after a slot's time we'll still fire it. With a 5-minute tick a
// 20-minute window is comfortably wide enough to catch the slot at least once.
const SYNC_WINDOW_MINUTES = 20;
const completedSyncSlots = new Set<string>();

/** Current wall-clock in Asia/Kolkata as a date string + minutes-since-midnight. */
function istNow(): { date: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? "00";
  let hour = parseInt(get("hour"), 10);
  if (hour === 24) hour = 0; // some ICU builds emit "24" for midnight
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: hour * 60 + parseInt(get("minute"), 10),
  };
}

/**
 * Runs a full Apify sync if we've entered a scheduled slot's window and it
 * hasn't already run today. Returns the slot label when a sync was triggered,
 * or null otherwise. Errors propagate to the caller (the interval logs them);
 * the slot stays marked done so a hard failure doesn't retry-spam Apify.
 */
export async function maybeRunScheduledSync(): Promise<{ slot: string; result: SyncResult } | null> {
  if (process.env.OUTREACH_AUTO_SYNC === "false") return null;
  const { date, minutes } = istNow();
  // Drop yesterday's keys so the set never grows unbounded.
  for (const key of completedSyncSlots) {
    if (!key.startsWith(date)) completedSyncSlots.delete(key);
  }
  for (const slot of SYNC_SLOTS_IST) {
    const key = `${date}:${slot.label}`;
    const inWindow = minutes >= slot.minutes && minutes < slot.minutes + SYNC_WINDOW_MINUTES;
    if (inWindow && !completedSyncSlots.has(key)) {
      completedSyncSlots.add(key); // mark before awaiting to prevent a double-fire
      const result = await syncOutreach({});
      return { slot: slot.label, result };
    }
  }
  return null;
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

  const subjectHandle = (page ?? creator)!.handle.trim().toLowerCase().replace(/^@/, "");

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
  // For reels Apify returns two view-ish fields:
  //   videoPlayCount  → the big number Instagram now shows publicly as "views"
  //   videoViewCount  → an older, smaller count (often missing)
  // Prefer plays so our totals match what users see on the post page.
  const views = post.videoPlayCount ?? post.videoViewCount ?? 0;

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
