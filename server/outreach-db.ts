/**
 * Outreach domain: persistence layer.
 *
 * Tables:
 *  - outreach_pages       — Instagram pages we publish to, with inventory limits.
 *  - outreach_campaigns   — campaign metadata (manually created in the UI).
 *  - outreach_posts       — individual posts; rows are upserted by the sync job
 *                           that calls Apify's Instagram Profile Scraper.
 *
 * No seed data lives here on purpose. Pages are imported once via the
 * `importSeedHandles` helper (called from `bootstrapOutreach` when the table
 * is empty); campaigns and posts are user-created or sync-derived.
 */
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { config } from "./config.js";

const pool = new Pool({ connectionString: config.databaseUrl });

// ── Types ──────────────────────────────────────────────────────────────────

export const PAGE_TYPES = ["state", "pu"] as const;
export type PageType = typeof PAGE_TYPES[number];

export const FOLLOWER_TIERS = ["nano", "micro", "mid", "macro"] as const;
export type FollowerTier = typeof FOLLOWER_TIERS[number];

export const POST_TYPES = ["static", "reel", "story", "carousel"] as const;
export type PostType = typeof POST_TYPES[number];

export const POST_STATUSES = ["draft", "scheduled", "pending_approval", "published"] as const;
export type PostStatus = typeof POST_STATUSES[number];

export const CAMPAIGN_STATUSES = ["planning", "active", "completed", "paused"] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

export interface OutreachPage {
  id: string;
  handle: string;
  geography: string;
  state: string;
  type: PageType;
  follower_tier: FollowerTier;
  followers: number;
  inventory_posts: number;
  inventory_stories: number;
  notes: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface OutreachCampaign {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  goal: string;
  status: CampaignStatus;
  budget_posts: number;
  budget_stories: number;
  budget_reels: number;
  approvers: string[];
  creative_variants: string[];
  assigned_page_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface OutreachPost {
  id: string;
  instagram_id: string | null;
  page_id: string;
  campaign_id: string | null;
  date: string;
  type: PostType;
  creative_variant: string | null;
  caption: string;
  status: PostStatus;
  likes: number;
  comments: number;
  views: number;
  saves: number;
  shares: number;
  media_url: string | null;
  permalink: string | null;
  synced_at: string | null;
}

// ── Bootstrap ──────────────────────────────────────────────────────────────

export async function bootstrapOutreach() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_pages (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      geography TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('state', 'pu')),
      follower_tier TEXT NOT NULL CHECK (follower_tier IN ('nano', 'micro', 'mid', 'macro')),
      followers INTEGER NOT NULL DEFAULT 0,
      inventory_posts INTEGER NOT NULL DEFAULT 0,
      inventory_stories INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_campaigns (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('planning', 'active', 'completed', 'paused')),
      budget_posts INTEGER NOT NULL DEFAULT 0,
      budget_stories INTEGER NOT NULL DEFAULT 0,
      budget_reels INTEGER NOT NULL DEFAULT 0,
      approvers JSONB NOT NULL DEFAULT '[]'::JSONB,
      creative_variants JSONB NOT NULL DEFAULT '[]'::JSONB,
      assigned_page_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_posts (
      id TEXT PRIMARY KEY,
      instagram_id TEXT UNIQUE,
      page_id TEXT NOT NULL REFERENCES outreach_pages(id) ON DELETE CASCADE,
      campaign_id TEXT REFERENCES outreach_campaigns(id) ON DELETE SET NULL,
      date DATE NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('static', 'reel', 'story', 'carousel')),
      creative_variant TEXT,
      caption TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'pending_approval', 'published')),
      likes INTEGER NOT NULL DEFAULT 0,
      comments INTEGER NOT NULL DEFAULT 0,
      views INTEGER NOT NULL DEFAULT 0,
      saves INTEGER NOT NULL DEFAULT 0,
      shares INTEGER NOT NULL DEFAULT 0,
      media_url TEXT,
      permalink TEXT,
      synced_at TIMESTAMPTZ
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_page_id_idx ON outreach_posts(page_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_campaign_id_idx ON outreach_posts(campaign_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_date_idx ON outreach_posts(date)`);

  // One-time importer: seed the page directory with the handle list from the
  // original BR_POST_2026 PDF so the team doesn't have to type ~80 handles.
  // Followers + post metrics stay zero until the first Apify sync.
  const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM outreach_pages`);
  if (Number(rows[0].count) === 0) {
    await importSeedHandles();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

// ── Page CRUD ──────────────────────────────────────────────────────────────

export interface CreatePageInput {
  handle: string;
  geography: string;
  state: string;
  type: PageType;
  follower_tier: FollowerTier;
  followers?: number;
  inventory_posts: number;
  inventory_stories: number;
  notes?: string;
}

export async function listPages(): Promise<OutreachPage[]> {
  const { rows } = await pool.query<OutreachPage>(`SELECT * FROM outreach_pages ORDER BY handle`);
  return rows;
}

export async function createPage(input: CreatePageInput): Promise<OutreachPage> {
  const id = slug(input.handle) || newId("page");
  const { rows } = await pool.query<OutreachPage>(
    `INSERT INTO outreach_pages (id, handle, geography, state, type, follower_tier, followers, inventory_posts, inventory_stories, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      id, input.handle.trim(), input.geography, input.state, input.type, input.follower_tier,
      input.followers ?? 0, input.inventory_posts, input.inventory_stories, input.notes ?? "",
    ],
  );
  return rows[0];
}

export async function updatePage(id: string, patch: Partial<CreatePageInput> & { last_synced_at?: string }): Promise<OutreachPage | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    fields.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (fields.length === 0) {
    const { rows } = await pool.query<OutreachPage>(`SELECT * FROM outreach_pages WHERE id = $1`, [id]);
    return rows[0] ?? null;
  }
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await pool.query<OutreachPage>(
    `UPDATE outreach_pages SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function deletePage(id: string): Promise<void> {
  await pool.query(`DELETE FROM outreach_pages WHERE id = $1`, [id]);
}

// ── Campaign CRUD ──────────────────────────────────────────────────────────

export interface CreateCampaignInput {
  name: string;
  start_date: string;
  end_date: string;
  goal?: string;
  status: CampaignStatus;
  budget_posts: number;
  budget_stories: number;
  budget_reels: number;
  approvers: string[];
  creative_variants: string[];
  assigned_page_ids: string[];
}

export async function listCampaigns(): Promise<OutreachCampaign[]> {
  const { rows } = await pool.query<OutreachCampaign>(
    `SELECT * FROM outreach_campaigns ORDER BY start_date DESC`,
  );
  return rows.map(mapCampaignRow);
}

export async function createCampaign(input: CreateCampaignInput): Promise<OutreachCampaign> {
  const id = slug(input.name) || newId("c");
  const { rows } = await pool.query<OutreachCampaign>(
    `INSERT INTO outreach_campaigns
       (id, name, start_date, end_date, goal, status,
        budget_posts, budget_stories, budget_reels,
        approvers, creative_variants, assigned_page_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      id, input.name.trim(), input.start_date, input.end_date, input.goal ?? "", input.status,
      input.budget_posts, input.budget_stories, input.budget_reels,
      JSON.stringify(input.approvers), JSON.stringify(input.creative_variants), JSON.stringify(input.assigned_page_ids),
    ],
  );
  return mapCampaignRow(rows[0]);
}

export async function updateCampaign(id: string, patch: Partial<CreateCampaignInput>): Promise<OutreachCampaign | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "approvers" || k === "creative_variants" || k === "assigned_page_ids") {
      fields.push(`${k} = $${i++}::jsonb`);
      values.push(JSON.stringify(v));
    } else {
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
  }
  if (fields.length === 0) {
    const { rows } = await pool.query<OutreachCampaign>(`SELECT * FROM outreach_campaigns WHERE id = $1`, [id]);
    return rows[0] ? mapCampaignRow(rows[0]) : null;
  }
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await pool.query<OutreachCampaign>(
    `UPDATE outreach_campaigns SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return rows[0] ? mapCampaignRow(rows[0]) : null;
}

export async function deleteCampaign(id: string): Promise<void> {
  await pool.query(`DELETE FROM outreach_campaigns WHERE id = $1`, [id]);
}

function mapCampaignRow(row: OutreachCampaign): OutreachCampaign {
  // pg returns JSONB as parsed JS already; arrays come back as arrays.
  // Coerce to strings just to defend against stored strings (legacy migrations).
  return {
    ...row,
    approvers: Array.isArray(row.approvers) ? row.approvers : safeJson(row.approvers, []),
    creative_variants: Array.isArray(row.creative_variants) ? row.creative_variants : safeJson(row.creative_variants, []),
    assigned_page_ids: Array.isArray(row.assigned_page_ids) ? row.assigned_page_ids : safeJson(row.assigned_page_ids, []),
    start_date: typeof row.start_date === "string" ? row.start_date : new Date(row.start_date).toISOString().slice(0, 10),
    end_date: typeof row.end_date === "string" ? row.end_date : new Date(row.end_date).toISOString().slice(0, 10),
  };
}

function safeJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

// ── Post CRUD / upsert ─────────────────────────────────────────────────────

export interface UpsertPostInput {
  instagram_id: string;
  page_id: string;
  campaign_id?: string | null;
  date: string;
  type: PostType;
  creative_variant?: string | null;
  caption: string;
  status: PostStatus;
  likes: number;
  comments: number;
  views: number;
  saves?: number;
  shares?: number;
  media_url?: string | null;
  permalink?: string | null;
}

export async function listPosts(filters: { pageId?: string; campaignId?: string } = {}): Promise<OutreachPost[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filters.pageId)     { where.push(`page_id = $${i++}`);     values.push(filters.pageId); }
  if (filters.campaignId) { where.push(`campaign_id = $${i++}`); values.push(filters.campaignId); }
  const sql = `SELECT * FROM outreach_posts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date DESC LIMIT 2000`;
  const { rows } = await pool.query<OutreachPost>(sql, values);
  return rows.map(mapPostRow);
}

export async function upsertPostByInstagramId(input: UpsertPostInput): Promise<OutreachPost> {
  const id = newId("post");
  const { rows } = await pool.query<OutreachPost>(
    `INSERT INTO outreach_posts
       (id, instagram_id, page_id, campaign_id, date, type, creative_variant, caption,
        status, likes, comments, views, saves, shares, media_url, permalink, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, NOW())
     ON CONFLICT (instagram_id) DO UPDATE SET
       page_id          = EXCLUDED.page_id,
       campaign_id      = COALESCE(EXCLUDED.campaign_id, outreach_posts.campaign_id),
       date             = EXCLUDED.date,
       type             = EXCLUDED.type,
       creative_variant = COALESCE(EXCLUDED.creative_variant, outreach_posts.creative_variant),
       caption          = EXCLUDED.caption,
       likes            = EXCLUDED.likes,
       comments         = EXCLUDED.comments,
       views            = EXCLUDED.views,
       media_url        = EXCLUDED.media_url,
       permalink        = EXCLUDED.permalink,
       synced_at        = NOW()
     RETURNING *`,
    [
      id, input.instagram_id, input.page_id, input.campaign_id ?? null,
      input.date, input.type, input.creative_variant ?? null, input.caption,
      input.status, input.likes, input.comments, input.views, input.saves ?? 0, input.shares ?? 0,
      input.media_url ?? null, input.permalink ?? null,
    ],
  );
  return mapPostRow(rows[0]);
}

export async function deletePost(id: string): Promise<void> {
  await pool.query(`DELETE FROM outreach_posts WHERE id = $1`, [id]);
}

function mapPostRow(row: OutreachPost): OutreachPost {
  return {
    ...row,
    date: typeof row.date === "string" ? row.date : new Date(row.date).toISOString().slice(0, 10),
  };
}

// ── One-time importer for the original PDF handle list ─────────────────────

// Same handle list that lived in the frontend seed. Followers/posts metrics
// are NOT imported — Apify will fill those on first sync. Inventory numbers
// match the original spreadsheet so the team's existing capacity assumptions
// carry over.
type Seed = [handle: string, geography: string, state: string, type: PageType, tier: FollowerTier, posts: number, stories: number];
const SEED_HANDLES: Seed[] = [
  // Vadodara
  ["vadodaraourcity", "Vadodara", "Gujarat", "state", "mid", 48, 24],
  ["Vadodara Sankari Nagri", "Vadodara", "Gujarat", "state", "mid", 48, 24],
  ["Vadodara the Amazing city", "Vadodara", "Gujarat", "state", "mid", 48, 24],
  ["Aapdu Vadodara", "Vadodara", "Gujarat", "pu", "mid", 48, 24],
  ["Smart city Vadodara", "Vadodara", "Gujarat", "state", "micro", 48, 24],
  ["Vadodara Live", "Vadodara", "Gujarat", "state", "mid", 48, 24],
  ["Baroda Mirror", "Vadodara", "Gujarat", "pu", "mid", 48, 24],
  ["Sweet Vadodara", "Vadodara", "Gujarat", "state", "mid", 48, 24],
  ["I am Vadodara | Micro-Nano", "Vadodara", "Gujarat", "pu", "micro", 25, 30],
  ["Vadodara Darshan", "Vadodara", "Gujarat", "pu", "micro", 20, 20],
  // Gujarat
  ["iamsuratcity", "Gujarat", "Gujarat", "state", "mid", 48, 24],
  ["Ahmedabad Updates", "Gujarat", "Gujarat", "state", "mid", 48, 24],
  ["Apnu Amdavad", "Gujarat", "Gujarat", "state", "mid", 48, 24],
  ["CityofAmdavad", "Gujarat", "Gujarat", "pu", "mid", 24, 24],
  // Maharashtra
  ["pune guide", "Maharashtra", "Maharashtra", "state", "micro", 24, 12],
  ["I love Aurangabad", "Maharashtra", "Maharashtra", "state", "mid", 48, 24],
  ["Being Punekar", "Maharashtra", "Maharashtra", "pu", "mid", 25, 25],
  // Rajasthan
  ["Udaipur Blog", "Rajasthan", "Rajasthan", "pu", "mid", 48, 24],
  ["Jaipur Waley", "Rajasthan", "Rajasthan", "pu", "micro", 15, 15],
  // North-East
  ["Justassamthings", "North-East", "Assam", "state", "mid", 48, 24],
  ["Guwahati Plus", "North-East", "Assam", "pu", "mid", 48, 24],
  // Madhya Pradesh
  ["apna bhopal", "Madhya Pradesh", "Madhya Pradesh", "state", "micro", 48, 24],
  // Uttar Pradesh
  ["Lucknow Hearts", "Uttar Pradesh", "Uttar Pradesh", "pu", "mid", 48, 24],
  ["Kanpur Wale", "Uttar Pradesh", "Uttar Pradesh", "state", "micro", 24, 24],
  // Goa
  ["Goa Viral News", "Goa", "Goa", "state", "micro", 24, 24],
  ["Goastory", "Goa", "Goa", "state", "micro", 24, 24],
  ["amchegoa_", "Goa", "Goa", "state", "micro", 24, 24],
];

async function importSeedHandles() {
  for (const [handle, geography, state, type, tier, posts, stories] of SEED_HANDLES) {
    try {
      await createPage({
        handle, geography, state, type, follower_tier: tier,
        inventory_posts: posts, inventory_stories: stories,
        followers: 0, notes: "Imported from BR_POST_2026 directory",
      });
    } catch (err) {
      // Ignore duplicate handle errors — this importer only runs when the
      // table is empty, but a unique-violation here is harmless.
      if (!(err instanceof Error) || !err.message.includes("duplicate")) throw err;
    }
  }
}
