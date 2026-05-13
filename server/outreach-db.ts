/**
 * Outreach domain: persistence layer.
 *
 * Tables:
 *  - outreach_pages       — Instagram pages we publish to, with inventory limits.
 *  - outreach_creators    — individual creators (UGC). Same shape as pages but
 *                           kept separate: they don't appear in the "All Pages"
 *                           ledger and aren't synced by Apify automatically.
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

export const FOLLOWER_TIERS = ["1", "2", "3", "4", "5"] as const;
export type FollowerTier = typeof FOLLOWER_TIERS[number];

export const POST_TYPES = ["static", "reel", "story", "carousel"] as const;
export type PostType = typeof POST_TYPES[number];

// Content types a page produces. Subset of POST_TYPES that the team uses
// when classifying pages on add/filter (no `story` — stories aren't classed
// per page in this workflow).
export const PAGE_CONTENT_TYPES = ["static", "reel", "carousel"] as const;
export type PageContentType = typeof PAGE_CONTENT_TYPES[number];

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
  content_types: PageContentType[];
  followers: number;
  inventory_posts: number;
  inventory_stories: number;
  notes: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

// Creators share the same shape as pages — separate table so they don't show up
// in the All Pages ledger and have their own identity.
export interface OutreachCreator {
  id: string;
  handle: string;
  geography: string;
  state: string;
  type: PageType;
  follower_tier: FollowerTier;
  content_types: PageContentType[];
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
  assigned_creator_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface OutreachPost {
  id: string;
  instagram_id: string | null;
  // A post is owned by either a page OR a creator (never both, never neither —
  // enforced by a CHECK constraint). `campaign_id` is optional for both, but
  // the live-posts route still requires it for page posts to preserve the
  // "page must belong to the campaign" check.
  page_id: string | null;
  creator_id: string | null;
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
      follower_tier TEXT NOT NULL CHECK (follower_tier IN ('1', '2', '3', '4', '5')),
      content_types JSONB NOT NULL DEFAULT '[]'::JSONB,
      followers INTEGER NOT NULL DEFAULT 0,
      inventory_posts INTEGER NOT NULL DEFAULT 0,
      inventory_stories INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Migrations for installations created before the tier-rename + content_types
  // addition. Idempotent: safe to re-run on a fresh schema.
  //
  // Order matters: drop the OLD check constraint before remapping values,
  // otherwise the UPDATE would violate the constraint that the new values
  // don't satisfy yet.
  await pool.query(`ALTER TABLE outreach_pages DROP CONSTRAINT IF EXISTS outreach_pages_follower_tier_check`);
  await pool.query(`UPDATE outreach_pages SET follower_tier = '1' WHERE follower_tier = 'nano'`);
  await pool.query(`UPDATE outreach_pages SET follower_tier = '2' WHERE follower_tier = 'micro'`);
  await pool.query(`UPDATE outreach_pages SET follower_tier = '3' WHERE follower_tier = 'mid'`);
  await pool.query(`UPDATE outreach_pages SET follower_tier = '4' WHERE follower_tier = 'macro'`);
  await pool.query(`
    ALTER TABLE outreach_pages
    ADD CONSTRAINT outreach_pages_follower_tier_check
    CHECK (follower_tier IN ('1', '2', '3', '4', '5'))
  `);
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS content_types JSONB NOT NULL DEFAULT '[]'::JSONB`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_creators (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      geography TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL CHECK (type IN ('state', 'pu')),
      follower_tier TEXT NOT NULL CHECK (follower_tier IN ('1', '2', '3', '4', '5')),
      content_types JSONB NOT NULL DEFAULT '[]'::JSONB,
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
      assigned_creator_ids JSONB NOT NULL DEFAULT '[]'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotent migration for installations that pre-date the creator split.
  await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS assigned_creator_ids JSONB NOT NULL DEFAULT '[]'::JSONB`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_posts (
      id TEXT PRIMARY KEY,
      instagram_id TEXT UNIQUE,
      page_id TEXT REFERENCES outreach_pages(id) ON DELETE CASCADE,
      creator_id TEXT REFERENCES outreach_creators(id) ON DELETE CASCADE,
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
      synced_at TIMESTAMPTZ,
      CONSTRAINT outreach_posts_owner_check CHECK (
        (page_id IS NOT NULL AND creator_id IS NULL)
        OR (page_id IS NULL AND creator_id IS NOT NULL)
      )
    )
  `);

  // Migrations for installations that pre-date the creator-attachment feature.
  // page_id used to be NOT NULL; relax it and add creator_id alongside.
  await pool.query(`ALTER TABLE outreach_posts ADD COLUMN IF NOT EXISTS creator_id TEXT REFERENCES outreach_creators(id) ON DELETE CASCADE`);
  await pool.query(`ALTER TABLE outreach_posts ALTER COLUMN page_id DROP NOT NULL`);
  // Idempotent CHECK install — drop a prior version (if any) before re-adding,
  // because Postgres has no ADD CONSTRAINT IF NOT EXISTS.
  await pool.query(`ALTER TABLE outreach_posts DROP CONSTRAINT IF EXISTS outreach_posts_owner_check`);
  await pool.query(`
    ALTER TABLE outreach_posts
    ADD CONSTRAINT outreach_posts_owner_check CHECK (
      (page_id IS NOT NULL AND creator_id IS NULL)
      OR (page_id IS NULL AND creator_id IS NOT NULL)
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_page_id_idx ON outreach_posts(page_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_creator_id_idx ON outreach_posts(creator_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_campaign_id_idx ON outreach_posts(campaign_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_date_idx ON outreach_posts(date)`);

  // Page directory seeding is opt-in. Set OUTREACH_SEED_HANDLES=true to import
  // the original BR_POST_2026 handle list on an empty table. Otherwise the
  // team adds pages manually through the UI.
  if (process.env.OUTREACH_SEED_HANDLES === "true") {
    const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM outreach_pages`);
    if (Number(rows[0].count) === 0) {
      await importSeedHandles();
    }
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
  content_types?: PageContentType[];
  followers?: number;
  inventory_posts: number;
  inventory_stories: number;
  notes?: string;
}

export async function listPages(): Promise<OutreachPage[]> {
  const { rows } = await pool.query<OutreachPage>(`SELECT * FROM outreach_pages ORDER BY handle`);
  return rows.map(mapPageRow);
}

export async function createPage(input: CreatePageInput): Promise<OutreachPage> {
  const id = slug(input.handle) || newId("page");
  const { rows } = await pool.query<OutreachPage>(
    `INSERT INTO outreach_pages (id, handle, geography, state, type, follower_tier, content_types, followers, inventory_posts, inventory_stories, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [
      id, input.handle.trim(), input.geography, input.state, input.type, input.follower_tier,
      JSON.stringify(input.content_types ?? []),
      input.followers ?? 0, input.inventory_posts, input.inventory_stories, input.notes ?? "",
    ],
  );
  return mapPageRow(rows[0]);
}

export async function updatePage(id: string, patch: Partial<CreatePageInput> & { last_synced_at?: string }): Promise<OutreachPage | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "content_types") {
      fields.push(`${k} = $${i++}::jsonb`);
      values.push(JSON.stringify(v));
    } else {
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
  }
  if (fields.length === 0) {
    const { rows } = await pool.query<OutreachPage>(`SELECT * FROM outreach_pages WHERE id = $1`, [id]);
    return rows[0] ? mapPageRow(rows[0]) : null;
  }
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await pool.query<OutreachPage>(
    `UPDATE outreach_pages SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return rows[0] ? mapPageRow(rows[0]) : null;
}

function mapPageRow(row: OutreachPage): OutreachPage {
  // pg returns JSONB pre-parsed, but defend against legacy string-encoded values.
  const ct = (row as unknown as { content_types: unknown }).content_types;
  return {
    ...row,
    content_types: Array.isArray(ct) ? ct as PageContentType[] : safeJson(ct, [] as PageContentType[]),
  };
}

export async function deletePage(id: string): Promise<void> {
  await pool.query(`DELETE FROM outreach_pages WHERE id = $1`, [id]);
}

// ── Creator CRUD ───────────────────────────────────────────────────────────

export interface CreateCreatorInput {
  handle: string;
  geography: string;
  state: string;
  type: PageType;
  follower_tier: FollowerTier;
  content_types?: PageContentType[];
  followers?: number;
  inventory_posts: number;
  inventory_stories: number;
  notes?: string;
}

export async function listCreators(): Promise<OutreachCreator[]> {
  const { rows } = await pool.query<OutreachCreator>(`SELECT * FROM outreach_creators ORDER BY handle`);
  return rows.map(mapCreatorRow);
}

export async function createCreator(input: CreateCreatorInput): Promise<OutreachCreator> {
  const id = `creator-${slug(input.handle) || randomBytes(6).toString("hex")}`;
  const { rows } = await pool.query<OutreachCreator>(
    `INSERT INTO outreach_creators (id, handle, geography, state, type, follower_tier, content_types, followers, inventory_posts, inventory_stories, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [
      id, input.handle.trim(), input.geography, input.state, input.type, input.follower_tier,
      JSON.stringify(input.content_types ?? []),
      input.followers ?? 0, input.inventory_posts, input.inventory_stories, input.notes ?? "",
    ],
  );
  return mapCreatorRow(rows[0]);
}

export async function updateCreator(id: string, patch: Partial<CreateCreatorInput> & { last_synced_at?: string }): Promise<OutreachCreator | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (k === "content_types") {
      fields.push(`${k} = $${i++}::jsonb`);
      values.push(JSON.stringify(v));
    } else {
      fields.push(`${k} = $${i++}`);
      values.push(v);
    }
  }
  if (fields.length === 0) {
    const { rows } = await pool.query<OutreachCreator>(`SELECT * FROM outreach_creators WHERE id = $1`, [id]);
    return rows[0] ? mapCreatorRow(rows[0]) : null;
  }
  fields.push(`updated_at = NOW()`);
  values.push(id);
  const { rows } = await pool.query<OutreachCreator>(
    `UPDATE outreach_creators SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    values,
  );
  return rows[0] ? mapCreatorRow(rows[0]) : null;
}

export async function deleteCreator(id: string): Promise<void> {
  await pool.query(`DELETE FROM outreach_creators WHERE id = $1`, [id]);
}

export async function getCreator(id: string): Promise<OutreachCreator | null> {
  const { rows } = await pool.query<OutreachCreator>(`SELECT * FROM outreach_creators WHERE id = $1`, [id]);
  return rows[0] ? mapCreatorRow(rows[0]) : null;
}

function mapCreatorRow(row: OutreachCreator): OutreachCreator {
  const ct = (row as unknown as { content_types: unknown }).content_types;
  return {
    ...row,
    content_types: Array.isArray(ct) ? ct as PageContentType[] : safeJson(ct, [] as PageContentType[]),
  };
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
  assigned_creator_ids?: string[];
}

export async function listCampaigns(): Promise<OutreachCampaign[]> {
  const { rows } = await pool.query<OutreachCampaign>(
    `SELECT * FROM outreach_campaigns ORDER BY start_date DESC`,
  );
  return rows.map(mapCampaignRow);
}

export async function getCampaign(id: string): Promise<OutreachCampaign | null> {
  const { rows } = await pool.query<OutreachCampaign>(
    `SELECT * FROM outreach_campaigns WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapCampaignRow(rows[0]) : null;
}

export async function getPage(id: string): Promise<OutreachPage | null> {
  const { rows } = await pool.query<OutreachPage>(
    `SELECT * FROM outreach_pages WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createCampaign(input: CreateCampaignInput): Promise<OutreachCampaign> {
  const id = slug(input.name) || newId("c");
  const { rows } = await pool.query<OutreachCampaign>(
    `INSERT INTO outreach_campaigns
       (id, name, start_date, end_date, goal, status,
        budget_posts, budget_stories, budget_reels,
        approvers, creative_variants, assigned_page_ids, assigned_creator_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      id, input.name.trim(), input.start_date, input.end_date, input.goal ?? "", input.status,
      input.budget_posts, input.budget_stories, input.budget_reels,
      JSON.stringify(input.approvers), JSON.stringify(input.creative_variants),
      JSON.stringify(input.assigned_page_ids), JSON.stringify(input.assigned_creator_ids ?? []),
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
    if (k === "approvers" || k === "creative_variants" || k === "assigned_page_ids" || k === "assigned_creator_ids") {
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
    assigned_creator_ids: Array.isArray(row.assigned_creator_ids) ? row.assigned_creator_ids : safeJson(row.assigned_creator_ids, []),
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
  // Exactly one of page_id/creator_id must be set — the DB CHECK enforces it.
  page_id?: string | null;
  creator_id?: string | null;
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

export async function listPosts(filters: { pageId?: string; creatorId?: string; campaignId?: string } = {}): Promise<OutreachPost[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filters.pageId)     { where.push(`page_id = $${i++}`);     values.push(filters.pageId); }
  if (filters.creatorId)  { where.push(`creator_id = $${i++}`);  values.push(filters.creatorId); }
  if (filters.campaignId) { where.push(`campaign_id = $${i++}`); values.push(filters.campaignId); }
  const sql = `SELECT * FROM outreach_posts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY date DESC LIMIT 2000`;
  const { rows } = await pool.query<OutreachPost>(sql, values);
  return rows.map(mapPostRow);
}

export interface CreatePlannedPostInput {
  page_id?: string | null;
  creator_id?: string | null;
  campaign_id?: string | null;
  date: string;
  type: PostType;
  creative_variant?: string | null;
  caption?: string;
  status: PostStatus;
}

/**
 * Creates planned/scheduled posts (no instagram_id yet). Used by the
 * calendar's CSV importer. Metrics default to 0 — Apify sync will
 * supersede them with the real numbers once the post goes live, although
 * the current schema doesn't link a planned row to its synced row.
 */
export async function createPostsBulk(inputs: CreatePlannedPostInput[]): Promise<OutreachPost[]> {
  if (inputs.length === 0) return [];
  const created: OutreachPost[] = [];
  for (const input of inputs) {
    const id = newId("post");
    const { rows } = await pool.query<OutreachPost>(
      `INSERT INTO outreach_posts
         (id, instagram_id, page_id, creator_id, campaign_id, date, type, creative_variant, caption,
          status, likes, comments, views, saves, shares)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, 0, 0, 0, 0, 0)
       RETURNING *`,
      [
        id, input.page_id ?? null, input.creator_id ?? null, input.campaign_id ?? null,
        input.date, input.type, input.creative_variant ?? null, input.caption ?? "",
        input.status,
      ],
    );
    created.push(mapPostRow(rows[0]));
  }
  return created;
}

export async function upsertPostByInstagramId(input: UpsertPostInput): Promise<OutreachPost> {
  const id = newId("post");
  const { rows } = await pool.query<OutreachPost>(
    `INSERT INTO outreach_posts
       (id, instagram_id, page_id, creator_id, campaign_id, date, type, creative_variant, caption,
        status, likes, comments, views, saves, shares, media_url, permalink, synced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW())
     ON CONFLICT (instagram_id) DO UPDATE SET
       page_id          = EXCLUDED.page_id,
       creator_id       = EXCLUDED.creator_id,
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
      id, input.instagram_id, input.page_id ?? null, input.creator_id ?? null, input.campaign_id ?? null,
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
  ["vadodaraourcity", "Vadodara", "Gujarat", "state", "3",48, 24],
  ["Vadodara Sankari Nagri", "Vadodara", "Gujarat", "state", "3",48, 24],
  ["Vadodara the Amazing city", "Vadodara", "Gujarat", "state", "3",48, 24],
  ["Aapdu Vadodara", "Vadodara", "Gujarat", "pu", "3",48, 24],
  ["Smart city Vadodara", "Vadodara", "Gujarat", "state", "2",48, 24],
  ["Vadodara Live", "Vadodara", "Gujarat", "state", "3",48, 24],
  ["Baroda Mirror", "Vadodara", "Gujarat", "pu", "3",48, 24],
  ["Sweet Vadodara", "Vadodara", "Gujarat", "state", "3",48, 24],
  ["I am Vadodara | Micro-Nano", "Vadodara", "Gujarat", "pu", "2",25, 30],
  ["Vadodara Darshan", "Vadodara", "Gujarat", "pu", "2",20, 20],
  // Gujarat
  ["iamsuratcity", "Gujarat", "Gujarat", "state", "3",48, 24],
  ["Ahmedabad Updates", "Gujarat", "Gujarat", "state", "3",48, 24],
  ["Apnu Amdavad", "Gujarat", "Gujarat", "state", "3",48, 24],
  ["CityofAmdavad", "Gujarat", "Gujarat", "pu", "3",24, 24],
  // Maharashtra
  ["pune guide", "Maharashtra", "Maharashtra", "state", "2",24, 12],
  ["I love Aurangabad", "Maharashtra", "Maharashtra", "state", "3",48, 24],
  ["Being Punekar", "Maharashtra", "Maharashtra", "pu", "3",25, 25],
  // Rajasthan
  ["Udaipur Blog", "Rajasthan", "Rajasthan", "pu", "3",48, 24],
  ["Jaipur Waley", "Rajasthan", "Rajasthan", "pu", "2",15, 15],
  // North-East
  ["Justassamthings", "North-East", "Assam", "state", "3",48, 24],
  ["Guwahati Plus", "North-East", "Assam", "pu", "3",48, 24],
  // Madhya Pradesh
  ["apna bhopal", "Madhya Pradesh", "Madhya Pradesh", "state", "2",48, 24],
  // Uttar Pradesh
  ["Lucknow Hearts", "Uttar Pradesh", "Uttar Pradesh", "pu", "3",48, 24],
  ["Kanpur Wale", "Uttar Pradesh", "Uttar Pradesh", "state", "2",24, 24],
  // Goa
  ["Goa Viral News", "Goa", "Goa", "state", "2",24, 24],
  ["Goastory", "Goa", "Goa", "state", "2",24, 24],
  ["amchegoa_", "Goa", "Goa", "state", "2",24, 24],
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
