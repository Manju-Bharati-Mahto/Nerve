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
import { Pool, type PoolClient } from "pg";
import { config } from "./config.js";
import {
  canonicalGeography, canonicalState, geographyKey, isCanonicalState, preferredGeographySpelling, tidyText,
} from "./outreach-states.js";
import { handleKey, normalisePageHandle, normalisePageLink } from "./outreach-page-edit.js";
import type { OutreachScope } from "./outreach-scope.js";

const pool = new Pool({ connectionString: config.databaseUrl });

// ── Types ──────────────────────────────────────────────────────────────────

export const PAGE_TYPES = ["state", "pu"] as const;
export type PageType = typeof PAGE_TYPES[number];

// Which social network a page / post lives on. Instagram is the original (and
// default) platform; Facebook is synced via the Facebook Posts Scraper (Apify).
export const PLATFORMS = ["instagram", "facebook"] as const;
export type Platform = typeof PLATFORMS[number];

export const FOLLOWER_TIERS = ["1", "2", "3", "4", "5"] as const;
export type FollowerTier = typeof FOLLOWER_TIERS[number];

export const POST_TYPES = ["static", "reel", "story", "carousel"] as const;
export type PostType = typeof POST_TYPES[number];

// Content types a page produces. Subset of POST_TYPES that the team uses
// when classifying pages on add/filter (no `story` — stories aren't classed
// per page in this workflow).
export const PAGE_CONTENT_TYPES = ["static", "reel", "carousel"] as const;
export type PageContentType = typeof PAGE_CONTENT_TYPES[number];

// Content preference / category a page is known for (PRD 6.5). Distinct from
// `content_types` (which is post FORMAT). Configurable, multi-select; drives the
// Smart Page Recommendation engine (6.4) and the Underperformance reason (6.6).
// Empty array on a page means "Not Set".
export const PAGE_CONTENT_PREFERENCES = [
  "Comedy", "News", "Motivational", "Devotional", "Local Info", "Reels-only",
] as const;
export type PageContentPreference = typeof PAGE_CONTENT_PREFERENCES[number];

export const POST_STATUSES = ["draft", "scheduled", "pending_approval", "published"] as const;
export type PostStatus = typeof POST_STATUSES[number];

export const CAMPAIGN_STATUSES = ["planning", "active", "completed", "paused"] as const;
export type CampaignStatus = typeof CAMPAIGN_STATUSES[number];

export interface OutreachPage {
  id: string;
  handle: string;
  platform: Platform;
  geography: string;
  state: string;
  type: PageType;
  follower_tier: FollowerTier;
  content_types: PageContentType[];
  // PRD 6.5 — content preference/category (multi-select); empty = "Not Set".
  content_preferences: string[];
  followers: number;
  inventory_posts: number;
  inventory_stories: number;
  notes: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
  // Facebook only — Meta's own numeric page id, cached after first resolution.
  // Null for Instagram pages and for a Facebook page not yet resolved.
  platform_page_id: string | null;
  /* §8 — entered by a person, not synced. Empty until somebody fills them in. */
  page_link: string;
  contact_person: string;
  /** Whether we still post here. Not the same as whether the sync can reach it. */
  status: string;
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
  // State this campaign targets (e.g. "Gujarat"). Drives the state-wise
  // dashboard / analytics filters. Empty string = unscoped / all states.
  state: string;
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
  // External post id. For Instagram: the IG media id / shortcode. For Facebook:
  // "fb:<post id>" (namespaced so the two can never collide in the UNIQUE index).
  instagram_id: string | null;
  platform: Platform;
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
  // True when this row was explicitly added by an admin via AddLivePostsDialog
  // (server: addLivePosts). False for posts pulled by the Apify auto-sync.
  // Page/inventory analytics only count rows where this is true.
  added_as_live: boolean;
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
  // Idempotent re-add: skip if a constraint with this name already exists
  // (e.g. the inline CHECK from CREATE TABLE auto-names to the same identifier,
  // and we may race with another bootstrap call during tsx-watch restarts).
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'outreach_pages_follower_tier_check'
      ) THEN
        ALTER TABLE outreach_pages
          ADD CONSTRAINT outreach_pages_follower_tier_check
          CHECK (follower_tier IN ('1', '2', '3', '4', '5'));
      END IF;
    END $$;
  `);
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS content_types JSONB NOT NULL DEFAULT '[]'::JSONB`);
  // PRD 6.5 — page content preference/category. Existing rows default to [] ("Not Set").
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS content_preferences JSONB NOT NULL DEFAULT '[]'::JSONB`);

  /* Campaign & Content Management PRD §8 — what a social media page record has
     to carry beyond the sync's own fields. All three are entered by a person
     rather than synced, so they default to empty and nothing requires them:
     an existing page simply has none until somebody fills them in.

     `status` is deliberately separate from whether the sync can reach the
     page. A page can be perfectly reachable and still not somewhere we post
     any more, and conflating the two would quietly resurrect retired pages
     every time the sync ran. */
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS page_link TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS contact_person TEXT NOT NULL DEFAULT ''`);
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`);
  // Platform split (Instagram / Facebook). Every pre-existing row is Instagram.
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'instagram'`);
  // The same handle may exist on BOTH platforms (an org's IG and FB page often
  // share a name) — uniqueness is per platform, not global.
  await pool.query(`ALTER TABLE outreach_pages DROP CONSTRAINT IF EXISTS outreach_pages_handle_key`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_pages_handle_platform_key') THEN
        ALTER TABLE outreach_pages ADD CONSTRAINT outreach_pages_handle_platform_key
          UNIQUE (handle, platform);
      END IF;
    END $$;
  `);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_pages_platform_check') THEN
        ALTER TABLE outreach_pages ADD CONSTRAINT outreach_pages_platform_check
          CHECK (platform IN ('instagram', 'facebook'));
      END IF;
    END $$;
  `);
  // The Facebook page's own numeric id (Meta's stable identifier, e.g.
  // "100044561550831"), NOT our handle/slug. Resolved lazily by scraping the
  // page's own URL the first time a live post is added or synced, then cached
  // here — this is the trust anchor "Add live posts" verifies a pasted post's
  // scraped owner id against, so a post from a different Facebook page can't
  // be attached to this one (mirrors Instagram's ownerUsername check).
  await pool.query(`ALTER TABLE outreach_pages ADD COLUMN IF NOT EXISTS platform_page_id TEXT`);

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
      state TEXT NOT NULL DEFAULT '',
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
  // Idempotent migration for installations that pre-date the state-wise filter.
  await pool.query(`ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT ''`);
  // Campaigns are open-ended: end_date became optional (empty = no end date).
  await pool.query(`ALTER TABLE outreach_campaigns ALTER COLUMN end_date DROP NOT NULL`);
  /* Deleting a page or creator used to leave its id in every campaign's
     assignment array (the arrays aren't foreign keys), and such a ghost can't
     be unticked from the UI. deletePage/deleteCreator now clear it; this
     clears the ones already stored. Idempotent: no ghosts, no rows touched. */
  for (const [column, table] of [["assigned_page_ids", "outreach_pages"], ["assigned_creator_ids", "outreach_creators"]] as const) {
    await pool.query(`
      UPDATE outreach_campaigns c
         SET ${column} = COALESCE((
               SELECT jsonb_agg(e.id ORDER BY e.n)
                 FROM jsonb_array_elements_text(c.${column}) WITH ORDINALITY AS e(id, n)
                WHERE EXISTS (SELECT 1 FROM ${table} t WHERE t.id = e.id)
             ), '[]'::jsonb)
       WHERE jsonb_typeof(c.${column}) = 'array'
         AND EXISTS (
               SELECT 1 FROM jsonb_array_elements_text(c.${column}) AS g(id)
                WHERE NOT EXISTS (SELECT 1 FROM ${table} t WHERE t.id = g.id)
             )
    `);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_posts (
      id TEXT PRIMARY KEY,
      instagram_id TEXT UNIQUE,
      page_id TEXT REFERENCES outreach_pages(id) ON DELETE CASCADE,
      creator_id TEXT REFERENCES outreach_creators(id) ON DELETE CASCADE,
      campaign_id TEXT REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
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

  // Platform split for posts (Instagram / Facebook). Pre-existing rows are all
  // Instagram. Facebook rows are populated by the Facebook Posts Scraper.
  await pool.query(`ALTER TABLE outreach_posts ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'instagram'`);
  await pool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'outreach_posts_platform_check') THEN
        ALTER TABLE outreach_posts ADD CONSTRAINT outreach_posts_platform_check
          CHECK (platform IN ('instagram', 'facebook'));
      END IF;
    END $$;
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_page_id_idx ON outreach_posts(page_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_creator_id_idx ON outreach_posts(creator_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_campaign_id_idx ON outreach_posts(campaign_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_date_idx ON outreach_posts(date)`);

  // Migration: campaign_id FK was originally `ON DELETE SET NULL` so deleting
  // a campaign just orphaned its posts (they kept showing on each page's
  // historical list with no campaign attribution). New behaviour: deleting
  // a campaign cascades the deletion through to every post that was attached
  // to it. Pages are NOT touched — they reference outreach_pages via a
  // separate FK that's already ON DELETE CASCADE.
  //
  // We re-issue the constraint only if its current behaviour is something
  // other than CASCADE. Postgres encodes `confdeltype` as 'a' (NO ACTION),
  // 'r' (RESTRICT), 'c' (CASCADE), 'n' (SET NULL), 'd' (SET DEFAULT).
  // 'c' means CASCADE — anything else means we need to swap.
  await pool.query(`
    DO $$
    DECLARE
      current_action CHAR(1);
      fk_name TEXT;
    BEGIN
      SELECT conname, confdeltype INTO fk_name, current_action
        FROM pg_constraint
       WHERE conrelid = 'outreach_posts'::regclass
         AND contype  = 'f'
         AND pg_get_constraintdef(oid) LIKE '%outreach_campaigns%'
       LIMIT 1;
      IF fk_name IS NOT NULL AND current_action <> 'c' THEN
        EXECUTE 'ALTER TABLE outreach_posts DROP CONSTRAINT ' || quote_ident(fk_name);
        ALTER TABLE outreach_posts
          ADD CONSTRAINT outreach_posts_campaign_id_fkey
          FOREIGN KEY (campaign_id) REFERENCES outreach_campaigns(id) ON DELETE CASCADE;
      END IF;
    END $$;
  `);

  // Live-added flag: distinguishes posts explicitly added by an admin from
  // Apify-auto-synced ones, so page analytics/inventory only count live posts.
  // Default false → all pre-existing rows are treated as auto-synced.
  await pool.query(`ALTER TABLE outreach_posts ADD COLUMN IF NOT EXISTS added_as_live BOOLEAN NOT NULL DEFAULT false`);

  // ── Audit trail / soft-deletion via archive tables ──────────────────────────
  // Every DELETE on outreach_posts / outreach_campaigns / outreach_pages copies
  // the row into a matching *_archive table first. This catches direct deletes,
  // cascade deletes, and accidental wipes — nothing leaves the database
  // permanently. To restore, INSERT a row from the archive table back into the
  // live table, then DELETE the archive row (or leave it as a trail).
  //
  // The trigger reads two optional session variables when archiving:
  //   - app.user_id   (who initiated the delete)
  //   - app.archive_reason (free-text reason, e.g. "user requested removal")
  // Set them via `SET LOCAL app.user_id = '...'` inside a transaction before
  // performing destructive operations. Defaults are NULL if unset.

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_posts_archive (
      archive_id BIGSERIAL PRIMARY KEY,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_by TEXT,
      archived_reason TEXT,
      id TEXT, instagram_id TEXT, page_id TEXT, creator_id TEXT, campaign_id TEXT,
      date DATE, type TEXT, creative_variant TEXT, caption TEXT, status TEXT,
      likes INTEGER, comments INTEGER, views INTEGER, saves INTEGER, shares INTEGER,
      media_url TEXT, permalink TEXT, synced_at TIMESTAMPTZ, added_as_live BOOLEAN
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_archive_id_idx ON outreach_posts_archive(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_archive_page_id_idx ON outreach_posts_archive(page_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_posts_archive_campaign_id_idx ON outreach_posts_archive(campaign_id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_campaigns_archive (
      archive_id BIGSERIAL PRIMARY KEY,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_by TEXT,
      archived_reason TEXT,
      id TEXT, name TEXT, start_date DATE, end_date DATE, state TEXT, goal TEXT, status TEXT,
      budget_posts INTEGER, budget_stories INTEGER, budget_reels INTEGER,
      approvers JSONB, creative_variants JSONB,
      assigned_page_ids JSONB, assigned_creator_ids JSONB,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    )
  `);
  // Back-fill the archive schema for installations created before the state column.
  await pool.query(`ALTER TABLE outreach_campaigns_archive ADD COLUMN IF NOT EXISTS state TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_campaigns_archive_id_idx ON outreach_campaigns_archive(id)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_pages_archive (
      archive_id BIGSERIAL PRIMARY KEY,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_by TEXT,
      archived_reason TEXT,
      id TEXT, handle TEXT, geography TEXT, state TEXT, type TEXT,
      follower_tier TEXT, content_types JSONB, content_preferences JSONB,
      followers INTEGER, inventory_posts INTEGER, inventory_stories INTEGER,
      notes TEXT, last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
    )
  `);
  // Back-fill the archive schema for installations created before content_preferences.
  await pool.query(`ALTER TABLE outreach_pages_archive ADD COLUMN IF NOT EXISTS content_preferences JSONB`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_pages_archive_id_idx ON outreach_pages_archive(id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_pages_archive_handle_idx ON outreach_pages_archive(handle)`);

  // Trigger functions — CREATE OR REPLACE so re-running bootstrap is idempotent.
  await pool.query(`
    CREATE OR REPLACE FUNCTION archive_outreach_post() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO outreach_posts_archive (
        archived_by, archived_reason,
        id, instagram_id, page_id, creator_id, campaign_id,
        date, type, creative_variant, caption, status,
        likes, comments, views, saves, shares,
        media_url, permalink, synced_at, added_as_live
      ) VALUES (
        NULLIF(current_setting('app.user_id', true), ''),
        NULLIF(current_setting('app.archive_reason', true), ''),
        OLD.id, OLD.instagram_id, OLD.page_id, OLD.creator_id, OLD.campaign_id,
        OLD.date, OLD.type, OLD.creative_variant, OLD.caption, OLD.status,
        OLD.likes, OLD.comments, OLD.views, OLD.saves, OLD.shares,
        OLD.media_url, OLD.permalink, OLD.synced_at, OLD.added_as_live
      );
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION archive_outreach_campaign() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO outreach_campaigns_archive (
        archived_by, archived_reason,
        id, name, start_date, end_date, state, goal, status,
        budget_posts, budget_stories, budget_reels,
        approvers, creative_variants, assigned_page_ids, assigned_creator_ids,
        created_at, updated_at
      ) VALUES (
        NULLIF(current_setting('app.user_id', true), ''),
        NULLIF(current_setting('app.archive_reason', true), ''),
        OLD.id, OLD.name, OLD.start_date, OLD.end_date, OLD.state, OLD.goal, OLD.status,
        OLD.budget_posts, OLD.budget_stories, OLD.budget_reels,
        OLD.approvers, OLD.creative_variants, OLD.assigned_page_ids, OLD.assigned_creator_ids,
        OLD.created_at, OLD.updated_at
      );
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await pool.query(`
    CREATE OR REPLACE FUNCTION archive_outreach_page() RETURNS TRIGGER AS $$
    BEGIN
      INSERT INTO outreach_pages_archive (
        archived_by, archived_reason,
        id, handle, geography, state, type, follower_tier, content_types, content_preferences,
        followers, inventory_posts, inventory_stories, notes, last_synced_at,
        created_at, updated_at
      ) VALUES (
        NULLIF(current_setting('app.user_id', true), ''),
        NULLIF(current_setting('app.archive_reason', true), ''),
        OLD.id, OLD.handle, OLD.geography, OLD.state, OLD.type, OLD.follower_tier, OLD.content_types, OLD.content_preferences,
        OLD.followers, OLD.inventory_posts, OLD.inventory_stories, OLD.notes, OLD.last_synced_at,
        OLD.created_at, OLD.updated_at
      );
      RETURN OLD;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // Triggers — drop-then-create so we can update the function body across
  // deploys without leaving stale wiring behind.
  await pool.query(`DROP TRIGGER IF EXISTS trace_delete_outreach_posts ON outreach_posts`);
  await pool.query(`
    CREATE TRIGGER trace_delete_outreach_posts
      BEFORE DELETE ON outreach_posts
      FOR EACH ROW EXECUTE FUNCTION archive_outreach_post()
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trace_delete_outreach_campaigns ON outreach_campaigns`);
  await pool.query(`
    CREATE TRIGGER trace_delete_outreach_campaigns
      BEFORE DELETE ON outreach_campaigns
      FOR EACH ROW EXECUTE FUNCTION archive_outreach_campaign()
  `);
  await pool.query(`DROP TRIGGER IF EXISTS trace_delete_outreach_pages ON outreach_pages`);
  await pool.query(`
    CREATE TRIGGER trace_delete_outreach_pages
      BEFORE DELETE ON outreach_pages
      FOR EACH ROW EXECUTE FUNCTION archive_outreach_page()
  `);

  // Page directory seeding is opt-in. Set OUTREACH_SEED_HANDLES=true to import
  // the original BR_POST_2026 handle list on an empty table. Otherwise the
  // team adds pages manually through the UI.
  if (process.env.OUTREACH_SEED_HANDLES === "true") {
    const { rows } = await pool.query<{ count: string }>(`SELECT COUNT(*) FROM outreach_pages`);
    if (Number(rows[0].count) === 0) {
      await importSeedHandles();
    }
  }

  /* bootstrapOutreach is one link in the startup chain every department
     shares: anything it throws exits the process and takes branding, design
     and media down with outreach. The two steps below are new, so neither is
     allowed to: each logs and lets the server start. If the state table is
     missing, scope reads fail and State Users get an error (fail closed);
     everyone with full access never reads it. If the migration fails, it
     simply runs again on the next start. */
  try {
    await bootstrapOutreachStateAccess();
  } catch (err) {
    console.error("Outreach: could not create the outreach access tables — configured people will be refused until they exist:", err);
  }
  try {
    await migrateOutreachStates();
  } catch (err) {
    console.error("Outreach: the state/geography migration failed and will retry on the next start:", err);
  }
}

/**
 * Which states each State User may see (PRD 6.3). Its own table rather than a
 * column on users: the users table and its mapping are shared by every
 * department, and one person can hold several states. `state` holds the
 * canonical name from outreach-states.ts — the same text outreach_pages.state
 * holds after the migration below — so scoping is a plain equality.
 *
 * ON DELETE CASCADE / SET NULL matter: Nerve hard-deletes users, and a
 * foreign key without them would make deleting a State User, or the manager
 * who granted their states, fail for whoever tried it.
 */
async function bootstrapOutreachStateAccess() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_user_states (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      granted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, state)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS outreach_user_states_state_idx ON outreach_user_states(state)`);

  /* Account Tabs requirements §1 and §2. A row here means an admin has
     CONFIGURED this person: from then on they get exactly the tabs in
     outreach_user_tabs and the states in outreach_user_states (or every state,
     when all_states). No row means not configured yet — they keep what their
     role gave them before, so deploying this changes nobody's access.
     Outreach-owned tables, not columns on the shared users table. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_user_access (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      all_states BOOLEAN NOT NULL DEFAULT FALSE,
      configured_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  /* Who changed whose outreach access, and when — and who removed whom.
     Ids are kept as plain text, not foreign keys: an audit row must outlive
     the people it names. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_user_audit (
      id BIGSERIAL PRIMARY KEY,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_id TEXT,
      actor_email TEXT,
      action TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      target_email TEXT,
      detail JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  /* Disable (Users tab, PRD §4.5) keeps a person's password here while they
     are disabled, and puts a hash nothing matches in its place, so sign-in
     refuses them. Nerve's own status check does not stop a sign-in
     (getUserById does not return status), and that check is shared with
     every department, so outreach does not rely on it. Enable puts the
     password back — unless it was reset in the meantime. */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_disabled_logins (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      disabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_user_tabs (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tab TEXT NOT NULL,
      level TEXT NOT NULL CHECK (level IN ('view', 'edit')),
      PRIMARY KEY (user_id, tab)
    )
  `);
}

export interface OutreachAccessRow {
  allStates: boolean;
  tabs: Record<string, "view" | "edit">;
  configuredAt: string;
  configuredBy: string | null;
}

/** A configured person's saved access, or null when nobody has configured them. Read per request. */
export async function getUserAccess(userId: string): Promise<OutreachAccessRow | null> {
  const { rows } = await pool.query<{ all_states: boolean; configured_at: string; configured_by: string | null }>(
    `SELECT all_states, configured_at, configured_by FROM outreach_user_access WHERE user_id = $1`, [userId]);
  if (!rows[0]) return null;
  const tabs = await pool.query<{ tab: string; level: "view" | "edit" }>(
    `SELECT tab, level FROM outreach_user_tabs WHERE user_id = $1`, [userId]);
  return {
    allStates: rows[0].all_states,
    tabs: Object.fromEntries(tabs.rows.map(r => [r.tab, r.level])),
    configuredAt: new Date(rows[0].configured_at).toISOString(),
    configuredBy: rows[0].configured_by,
  };
}

/**
 * Saves one person's tabs and states in a single transaction, so nobody ever
 * reads half of a change — the old tabs with the new states. The single-tab
 * grants that came before (outreach:* capabilities) are removed: once a
 * person is configured the grid is the whole answer, and a leftover grant
 * would only be something to misread later.
 */
export async function saveUserAccess(
  userId: string,
  access: { tabs: Record<string, "view" | "edit">; allStates: boolean; states: string[] },
  actorId: string | null,
): Promise<void> {
  await inTransaction(async client => {
    await client.query(
      `INSERT INTO outreach_user_access (user_id, all_states, configured_by, configured_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET all_states = EXCLUDED.all_states,
         configured_by = EXCLUDED.configured_by, configured_at = NOW()`,
      [userId, access.allStates, actorId]);
    await client.query(`DELETE FROM outreach_user_tabs WHERE user_id = $1`, [userId]);
    for (const [tab, level] of Object.entries(access.tabs)) {
      await client.query(`INSERT INTO outreach_user_tabs (user_id, tab, level) VALUES ($1, $2, $3)`, [userId, tab, level]);
    }
    await client.query(`DELETE FROM outreach_user_states WHERE user_id = $1`, [userId]);
    for (const state of access.allStates ? [] : access.states) {
      await client.query(
        `INSERT INTO outreach_user_states (user_id, state, granted_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, state, actorId]);
    }
    await client.query(`DELETE FROM user_capabilities WHERE user_id = $1 AND capability_key LIKE 'outreach:%'`, [userId]);
  });
}

/**
 * Changes only which states a person sees — the State window (§2). Saving it
 * for somebody not yet configured configures them, with the tabs they
 * effectively had, so choosing their states never takes a tab away.
 */
export async function saveUserStates(
  userId: string,
  states: { allStates: boolean; states: string[] },
  fallbackTabs: Record<string, "view" | "edit">,
  actorId: string | null,
): Promise<void> {
  const current = await getUserAccess(userId);
  await saveUserAccess(userId, { tabs: current?.tabs ?? fallbackTabs, ...states }, actorId);
}

/** Every configured person's states, for the State window and the Users table. */
export async function listAllUserStates(): Promise<Array<{ userId: string; allStates: boolean; states: string[] }>> {
  const { rows } = await pool.query<{ user_id: string; all_states: boolean; states: string[] | null }>(
    `SELECT a.user_id, a.all_states,
            ARRAY(SELECT s.state FROM outreach_user_states s WHERE s.user_id = a.user_id ORDER BY s.state) AS states
       FROM outreach_user_access a`);
  return rows.map(r => ({ userId: r.user_id, allStates: r.all_states, states: r.states ?? [] }));
}

/** The canonical states assigned to one user, sorted. Read per request — never cached. */
export async function listUserStates(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ state: string }>(
    `SELECT state FROM outreach_user_states WHERE user_id = $1 ORDER BY state`, [userId]);
  return rows.map(r => r.state);
}

// ── One-time state / geography clean-up (PRD 6.4) ──────────────────────────

/* The tables and columns this migration may touch, named one by one. Media
   Ops has its own `state` column (mo_asset_import_rows); matching on column
   name would rewrite another department's data. The archive tables are
   forensic copies of deleted rows and stay exactly as they were. */
const STATE_MIGRATION_TARGETS = [
  { table: "outreach_pages", column: "state", kind: "state" },
  { table: "outreach_creators", column: "state", kind: "state" },
  { table: "outreach_campaigns", column: "state", kind: "state" },
  { table: "outreach_pages", column: "geography", kind: "geography" },
  { table: "outreach_creators", column: "geography", kind: "geography" },
] as const;

export type StateMigrationOutcome = "merged" | "tidied" | "unmatched";

export interface StateMigrationChange {
  table: string;
  column: string;
  from: string;
  to: string;
  outcome: StateMigrationOutcome;
  rows: number;
}

export interface StateMigrationSummary {
  /** True when another process held the lock, so this one changed nothing. */
  skipped: boolean;
  runId: string;
  changes: StateMigrationChange[];
  /** Values that match no state — left exactly as they are. */
  unmatched: StateMigrationChange[];
}

/** What a stored value should become, or null to leave it alone. */
function plannedStateValue(kind: "state" | "geography", value: string): { to: string; outcome: StateMigrationOutcome } | null {
  if (kind === "geography") {
    const to = canonicalGeography(value);
    if (to === value) return null;
    return { to, outcome: isCanonicalState(to) && tidyText(value) !== to ? "merged" : "tidied" };
  }
  const canonical = canonicalState(value);
  if (canonical === null) return { to: value, outcome: "unmatched" };
  if (canonical === value) return null;
  // "   " → "" is tidying; "gujarat" → "Gujarat" is a merge into a listed state.
  return { to: canonical, outcome: canonical === "" ? "tidied" : "merged" };
}

/**
 * Rewrites every outreach state to its canonical name ("  gujarat  ",
 * "gujarat" → "Gujarat", "ladakh" → "Ladakh") and every geography that is a
 * state name to that state's spelling (other geographies are only trimmed and
 * have their spaces collapsed).
 *
 * - Idempotent: canonical values map to themselves, so a second run changes
 *   nothing. Runs at every start, so rows an older process wrote raw during a
 *   deploy are cleaned on the next one.
 * - Never guesses and never deletes: a value matching nothing ("Guj", "efef")
 *   is left as it is and recorded as unmatched. No row is removed, posts are
 *   not touched (they reach their page by id), and updated_at is left alone —
 *   so no analytics or inventory moves.
 * - One transaction, under a try-lock with short timeouts, so two processes
 *   starting together cannot both run it and neither can hold up the shared
 *   startup chain waiting for the other.
 * - Every changed row is written to outreach_state_migration_log with its old
 *   value and this run's id. To undo one run:
 *     UPDATE <table> t SET <column> = l.old_value
 *       FROM outreach_state_migration_log l
 *      WHERE l.run_id = '<run>' AND l.table_name = '<table>' AND l.column_name = '<column>'
 *        AND l.row_id = t.id AND l.outcome <> 'unmatched' AND t.<column> = l.new_value;
 *   (the last condition leaves alone any row somebody has edited since).
 */
export async function migrateOutreachStates(): Promise<StateMigrationSummary> {
  const runId = `${new Date().toISOString()}-${randomBytes(3).toString("hex")}`;
  const summary: StateMigrationSummary = { skipped: false, runId, changes: [], unmatched: [] };
  await pool.query(`
    CREATE TABLE IF NOT EXISTS outreach_state_migration_log (
      id BIGSERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      table_name TEXT NOT NULL,
      row_id TEXT NOT NULL,
      column_name TEXT NOT NULL,
      old_value TEXT NOT NULL,
      new_value TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('merged', 'tidied', 'unmatched'))
    )
  `);
  // An unmatched value is recorded once, not again at every start.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS outreach_state_migration_log_unmatched_key
      ON outreach_state_migration_log (table_name, row_id, column_name, old_value)
      WHERE outcome = 'unmatched'
  `);

  await inTransaction(async client => {
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    await client.query(`SET LOCAL statement_timeout = '60s'`);
    const lock = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('outreach_state_migration')) AS locked`);
    if (!lock.rows[0]?.locked) { summary.skipped = true; return; }

    for (const { table, column, kind } of STATE_MIGRATION_TARGETS) {
      const { rows: distinct } = await client.query<{ value: string }>(
        `SELECT DISTINCT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`);
      for (const { value } of distinct) {
        const plan = plannedStateValue(kind, value);
        if (!plan) continue;
        if (plan.outcome === "unmatched") {
          await client.query(
            `INSERT INTO outreach_state_migration_log (run_id, table_name, row_id, column_name, old_value, new_value, outcome)
             SELECT $1, $2, id, $3, $4, $4, 'unmatched' FROM ${table} WHERE ${column} = $4
             ON CONFLICT (table_name, row_id, column_name, old_value) WHERE outcome = 'unmatched' DO NOTHING`,
            [runId, table, column, value]);
          const { rows: [{ n }] } = await client.query<{ n: string }>(
            `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = $1`, [value]);
          summary.unmatched.push({ table, column, from: value, to: value, outcome: "unmatched", rows: Number(n) });
          continue;
        }
        const { rows: changed } = await client.query<{ id: string }>(
          `UPDATE ${table} SET ${column} = $1 WHERE ${column} = $2 RETURNING id`, [plan.to, value]);
        if (!changed.length) continue;
        await client.query(
          `INSERT INTO outreach_state_migration_log (run_id, table_name, row_id, column_name, old_value, new_value, outcome)
           SELECT $1, $2, unnest($3::text[]), $4, $5, $6, $7`,
          [runId, table, changed.map(r => r.id), column, value, plan.to, plan.outcome]);
        summary.changes.push({ table, column, from: value, to: plan.to, outcome: plan.outcome, rows: changed.length });
      }
    }

    /* Second pass, geography only. The first pass settles each value on its
       own ("MP" → "Madhya Pradesh", "kolkata" → "Kolkata"), but two spellings
       of the same non-state geography — "Start up" and "Startup" — are only
       recognisable as one by looking at both. Pages and creators are pooled,
       so a geography is spelled the same in both lists, and every spelling in
       a group is rewritten to the one preferredGeographySpelling picks. */
    const { rows: spellings } = await client.query<{ value: string; n: string }>(
      `SELECT geography AS value, COUNT(*)::text AS n FROM (
         SELECT geography FROM outreach_pages UNION ALL SELECT geography FROM outreach_creators
       ) g WHERE geography <> '' GROUP BY geography`);
    const groups = new Map<string, Map<string, number>>();
    for (const { value, n } of spellings) {
      const key = geographyKey(value);
      const group = groups.get(key) ?? new Map<string, number>();
      group.set(value, Number(n));
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.size < 2) continue;
      const to = preferredGeographySpelling(group);
      for (const from of group.keys()) {
        if (from === to) continue;
        for (const table of ["outreach_pages", "outreach_creators"] as const) {
          const { rows: changed } = await client.query<{ id: string }>(
            `UPDATE ${table} SET geography = $1 WHERE geography = $2 RETURNING id`, [to, from]);
          if (!changed.length) continue;
          await client.query(
            `INSERT INTO outreach_state_migration_log (run_id, table_name, row_id, column_name, old_value, new_value, outcome)
             SELECT $1, $2, unnest($3::text[]), 'geography', $4, $5, 'merged'`,
            [runId, table, changed.map(r => r.id), from, to]);
          summary.changes.push({ table, column: "geography", from, to, outcome: "merged", rows: changed.length });
        }
      }
    }
  });

  if (summary.changes.length) {
    const described = summary.changes.map(c => `${c.table}.${c.column} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)} (${c.rows})`);
    console.log(`Outreach state migration ${runId}: ${described.join("; ")}.`);
  }
  if (summary.unmatched.length) {
    const described = summary.unmatched.map(c => `${c.table}.${c.column} ${JSON.stringify(c.from)} (${c.rows})`);
    console.log(`Outreach: left unchanged, not a recognised state — ${described.join("; ")}.`);
  }
  return summary;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

/**
 * A real duplicate — the same campaign name, or a page or creator already in
 * the ledger — reported in words the person can act on. Routes answer it 409.
 */
export class OutreachDuplicateError extends Error {
  constructor(message: string) { super(message); this.name = "OutreachDuplicateError"; }
}

/**
 * A request that names something that isn't there — a campaign, page or
 * creator id with no row. Routes answer it 400. Without it these reached the
 * database and failed a foreign key (a bare 500 "Internal server error."), or
 * worse, were stored as references to nothing.
 */
export class OutreachValidationError extends Error {
  constructor(message: string) { super(message); this.name = "OutreachValidationError"; }
}

const isUniqueViolation = (err: unknown) => (err as { code?: string } | null)?.code === "23505";

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

type OutreachTable = "outreach_pages" | "outreach_creators" | "outreach_campaigns";

/** The ids in `ids` that have no row in `table`, de-duplicated, in the order given. */
async function missingIds(table: OutreachTable, ids: string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [unique]);
  const found = new Set(rows.map(r => r.id));
  return unique.filter(id => !found.has(id));
}

async function assertAllExist(table: OutreachTable, ids: string[], noun: string): Promise<void> {
  const missing = await missingIds(table, ids);
  if (missing.length) {
    const named = missing.map(id => id || '""');   // a blank id would otherwise print as nothing
    throw new OutreachValidationError(`Unknown ${noun} id${missing.length === 1 ? "" : "s"}: ${named.join(", ")}.`);
  }
}

/**
 * A campaign's assignments are JSONB arrays, not foreign keys, so nothing but
 * this stops a ghost id being stored — and a ghost counts in the campaign's
 * "N pages" while having no row the Edit modal could untick.
 */
async function assertMembersExist(pageIds: string[] | undefined, creatorIds: string[] | undefined): Promise<void> {
  await assertAllExist("outreach_pages", pageIds ?? [], "page");
  await assertAllExist("outreach_creators", creatorIds ?? [], "creator");
}

/**
 * Inserts a row whose primary key is derived from a name, without letting the
 * derivation collide.
 *
 * Ids are slugs, and a slug throws information away: "Diwali!" and "diwali"
 * share one, "a.b" and "a_b" share one, and a renamed row keeps the slug of
 * its OLD name forever. Every such collision used to reach the user as a bare
 * "Internal server error." with nothing created — which is what "I am unable
 * to create a campaign" looked like from outside. On a key collision this
 * tries again with a short random suffix; any other failure is the caller's.
 */
async function insertWithFreeId<T>(base: string, insert: (id: string) => Promise<T>): Promise<T> {
  let id = base;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await insert(id);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      id = `${base}-${randomBytes(3).toString("hex")}`;
    }
  }
  throw new Error("Could not allocate an id after several attempts.");
}

/** Handles compared the way a person reads them: case-insensitive, without a leading @. */
const sameHandleSql = `lower(regexp_replace(handle, '^@+', '')) = lower(regexp_replace($1, '^@+', ''))`;

/**
 * State and geography as they are stored: the canonical state name, and a
 * tidied geography. The routes validate (and refuse an unknown state with a
 * 400); this is the backstop for every other caller — the seed importer, the
 * sync, a script — so nothing writes "gujarat " past them. An unknown state is
 * kept, only tidied: refusing is the route's job, and the integrity tests and
 * internal callers must not start throwing here.
 */
function placeFields<T extends { state?: string; geography?: string }>(input: T): T {
  const out = { ...input };
  if (typeof out.state === "string") out.state = canonicalState(out.state) ?? tidyText(out.state);
  if (typeof out.geography === "string") out.geography = canonicalGeography(out.geography);
  return out;
}

/**
 * The spelling to store for a geography someone typed: if the same geography
 * is already in use under another spelling ("Startup" when they typed "Start
 * up"), that one. A duplicate entry cannot be created this way — the PDF's
 * acceptance rule — and nobody has to know which spelling came first.
 */
export async function settledGeography(typed: string, db: { query: typeof pool.query } = pool): Promise<string> {
  const text = canonicalGeography(typed);
  if (!text) return text;
  const key = geographyKey(text);
  const { rows } = await db.query<{ value: string; n: string }>(
    `SELECT geography AS value, COUNT(*)::text AS n FROM (
       SELECT geography FROM outreach_pages UNION ALL SELECT geography FROM outreach_creators
     ) g WHERE geography <> '' GROUP BY geography`);
  const group = new Map<string, number>();
  for (const { value, n } of rows) if (geographyKey(value) === key) group.set(value, Number(n));
  if (!group.size) return text;
  // The new row counts too, so a first spelling never loses to itself.
  group.set(text, (group.get(text) ?? 0) + 1);
  return preferredGeographySpelling(group);
}

/** The SQL test "this row's state is one the scope may see", or null for no filter. */
function scopeStates(scope: OutreachScope | undefined): string[] | null {
  return scope && scope.kind === "states" ? scope.states : null;
}

// ── Page CRUD ──────────────────────────────────────────────────────────────

export interface CreatePageInput {
  handle: string;
  platform?: Platform;
  geography: string;
  state: string;
  type: PageType;
  follower_tier: FollowerTier;
  content_types?: PageContentType[];
  content_preferences?: string[];
  followers?: number;
  inventory_posts: number;
  inventory_stories: number;
  notes?: string;
  /* §8 — the human-maintained fields. */
  page_link?: string;
  contact_person?: string;
  status?: string;
}

/** Every page, or with a State User's scope only the pages in their states — filtered here, in SQL. */
export async function listPages(scope?: OutreachScope): Promise<OutreachPage[]> {
  const states = scopeStates(scope);
  const { rows } = states
    ? await pool.query<OutreachPage>(`SELECT * FROM outreach_pages WHERE state = ANY($1::text[]) ORDER BY handle`, [states])
    : await pool.query<OutreachPage>(`SELECT * FROM outreach_pages ORDER BY handle`);
  return rows.map(mapPageRow);
}

export async function createPage(rawInput: CreatePageInput): Promise<OutreachPage> {
  const input = placeFields(rawInput);
  input.geography = await settledGeography(input.geography);
  // Prefix Facebook page ids so an FB page can coexist with an IG page that
  // shares the same handle (the id is a slug of the handle).
  const platform = input.platform ?? "instagram";
  const handle = input.handle.trim();

  // The same account twice is a real duplicate; say so instead of failing.
  const dup = await pool.query(
    `SELECT handle FROM outreach_pages WHERE platform = $2 AND ${sameHandleSql} LIMIT 1`, [handle, platform]);
  if (dup.rowCount) throw new OutreachDuplicateError(`@${dup.rows[0].handle} is already in the ledger.`);

  const slugBase = slug(handle) || newId("page");
  const base = platform === "facebook" ? `fb-${slugBase}` : slugBase;
  const row = await insertWithFreeId(base, async id => (await pool.query<OutreachPage>(
    `INSERT INTO outreach_pages (id, handle, platform, geography, state, type, follower_tier, content_types, content_preferences, followers, inventory_posts, inventory_stories, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13)
     RETURNING *`,
    [
      id, handle, platform, input.geography, input.state, input.type, input.follower_tier,
      JSON.stringify(input.content_types ?? []),
      JSON.stringify(input.content_preferences ?? []),
      input.followers ?? 0, input.inventory_posts, input.inventory_stories, input.notes ?? "",
    ],
  )).rows[0]);
  return mapPageRow(row);
}

export async function updatePage(id: string, patch: Partial<CreatePageInput> & { last_synced_at?: string; platform_page_id?: string }): Promise<OutreachPage | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  // Only the fields present are placed: a page_link edit never re-reads state.
  for (const [k, v] of Object.entries(placeFields(patch))) {
    if (v === undefined) continue;
    if (k === "content_types" || k === "content_preferences") {
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

/** What a person may change on a page (PRD 6.5). `platform` is accepted only when unchanged. */
export interface EditPageInput {
  handle?: string;
  platform?: Platform;
  geography?: string;
  state?: string;
  type?: PageType;
  follower_tier?: FollowerTier;
  content_types?: PageContentType[];
  content_preferences?: string[];
  followers?: number;
  inventory_posts?: number;
  inventory_stories?: number;
  notes?: string;
  page_link?: string;
  contact_person?: string;
  status?: string;
}

/* The columns editPage writes, by name. The patch never reaches SQL as raw
   keys: id, platform, platform_page_id and the sync's own columns stay out of
   reach whatever the caller sends. */
const EDITABLE_PAGE_COLUMNS = [
  "handle", "geography", "state", "type", "follower_tier", "content_types", "content_preferences",
  "followers", "inventory_posts", "inventory_stories", "notes", "page_link", "contact_person", "status",
] as const;

/**
 * A person's edit of a page — the path the Edit page dialog uses. updatePage
 * stays for the sync's own bookkeeping (last_synced_at, platform_page_id).
 *
 * - Renaming keeps the id, so posts (outreach_posts.page_id), campaign
 *   assignments, video records and the page's URL all stay with it.
 * - A new handle is normalised (a pasted profile URL becomes the username) and
 *   must be a well-formed username: the sync finds the page by it.
 * - A handle another page on the same platform already has — in any case,
 *   with or without "@" — is a duplicate (409). The unique key on
 *   (handle, platform) is case-sensitive, so "AmazingDwarka" used to sit
 *   beside "amazingdwarka" and the sync, which looks pages up lower-cased,
 *   put both accounts' posts on one of them.
 * - Renaming a Facebook page to a different name clears platform_page_id, the
 *   cached Meta id that "Add live posts" checks a post's owner against. It
 *   was resolved from the OLD name, so after a typo fix it would vouch for the
 *   wrong page's posts and refuse the right one's. The next sync or live-post
 *   add resolves it again. A case-only change is the same Facebook page and
 *   keeps it; an Instagram rename has no such id.
 * - The link must be an http(s) URL on the page's own platform.
 * - The platform is fixed: posts are platform-specific.
 * - A value handed back unchanged is never re-validated, so a legacy row (an
 *   old handle with a space in it, a link typed before links were checked)
 *   can still have its inventory edited.
 *
 * Returns null when there is no such page.
 */
export async function editPage(id: string, input: EditPageInput): Promise<OutreachPage | null> {
  try {
    return await inTransaction(async client => {
      const { rows } = await client.query<OutreachPage>(`SELECT * FROM outreach_pages WHERE id = $1 FOR UPDATE`, [id]);
      const current = rows[0];
      if (!current) return null;
      const patch: EditPageInput = placeFields(input);
      if (typeof patch.geography === "string" && patch.geography !== current.geography) {
        patch.geography = await settledGeography(patch.geography, client);
      }

      if (patch.platform !== undefined && patch.platform !== current.platform) {
        throw new OutreachValidationError("A page's platform can't be changed — add the page again on the other platform.");
      }

      let clearFacebookId = false;
      if (typeof patch.handle === "string") {
        if (patch.handle.trim() === current.handle) {
          delete patch.handle;
        } else {
          const checked = normalisePageHandle(current.platform, patch.handle);
          if (!checked.ok) throw new OutreachValidationError(checked.problem);
          if (checked.handle === current.handle) {
            delete patch.handle;
          } else {
            const dup = await client.query<{ handle: string }>(
              `SELECT handle FROM outreach_pages WHERE platform = $2 AND id <> $3 AND ${sameHandleSql} LIMIT 1`,
              [checked.handle, current.platform, id],
            );
            if (dup.rowCount) throw new OutreachDuplicateError(`@${dup.rows[0].handle} is already in the ledger — choose another name.`);
            patch.handle = checked.handle;
            clearFacebookId = current.platform === "facebook" && handleKey(checked.handle) !== handleKey(current.handle);
          }
        }
      }

      if (typeof patch.page_link === "string") {
        if (patch.page_link.trim() === current.page_link) {
          delete patch.page_link;
        } else {
          const checked = normalisePageLink(current.platform, patch.page_link);
          if (!checked.ok) throw new OutreachValidationError(checked.problem);
          patch.page_link = checked.link;
        }
      }
      if (typeof patch.contact_person === "string") patch.contact_person = tidyText(patch.contact_person);

      const sets: string[] = [];
      const values: unknown[] = [];
      for (const column of EDITABLE_PAGE_COLUMNS) {
        const value = patch[column];
        if (value === undefined) continue;
        if (column === "content_types" || column === "content_preferences") {
          values.push(JSON.stringify(value));
          sets.push(`${column} = $${values.length}::jsonb`);
        } else {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (clearFacebookId) sets.push(`platform_page_id = NULL`);
      if (sets.length === 0) return mapPageRow(current);
      values.push(id);
      const updated = await client.query<OutreachPage>(
        `UPDATE outreach_pages SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
        values,
      );
      return mapPageRow(updated.rows[0]);
    });
  } catch (err) {
    // Two renames racing to one name: the second meets the unique key.
    if (isUniqueViolation(err)) throw new OutreachDuplicateError("Another page already has that name.");
    throw err;
  }
}

/**
 * Caches a Facebook page's Meta id — only if the page still has the handle the
 * id was scraped under, and has none cached yet. Returns the id now on the
 * row, or null when the page was renamed meanwhile.
 *
 * A sync or "Add live posts" reads the page, scrapes https://facebook.com/<handle>
 * for seconds, then writes what it found. If the page was renamed in between
 * (and editPage cleared the id), an unconditional write put back the OLD
 * page's id — the very trust anchor the rename was meant to drop.
 */
export async function cacheFacebookOwnerId(pageId: string, scrapedHandle: string, ownerId: string): Promise<string | null> {
  await pool.query(
    `UPDATE outreach_pages SET platform_page_id = $3
      WHERE id = $1 AND handle = $2 AND platform_page_id IS NULL`,
    [pageId, scrapedHandle, ownerId],
  );
  const { rows } = await pool.query<{ platform_page_id: string | null }>(
    `SELECT platform_page_id FROM outreach_pages WHERE id = $1 AND handle = $2`, [pageId, scrapedHandle]);
  return rows[0]?.platform_page_id ?? null;
}

/**
 * A DATE column as the calendar day it holds, "YYYY-MM-DD".
 *
 * node-postgres turns a DATE into a JS Date at LOCAL midnight. Reading it back
 * with toISOString() converts to UTC first, and anywhere east of Greenwich —
 * the server runs on Asia/Kolkata — local midnight is the previous day in UTC.
 * That is how every outreach campaign and post came back one day early: a
 * campaign starting on the 8th showed the 7th, drew on the wrong calendar day,
 * and raised an "overdue" alert on its own launch day.
 *
 * The local getters read the day the driver actually built, which is the day
 * stored, in any server timezone.
 */
function dayOf(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value.slice(0, 10);
  const d = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function mapPageRow(row: OutreachPage): OutreachPage {
  // pg returns JSONB pre-parsed, but defend against legacy string-encoded values.
  const ct = (row as unknown as { content_types: unknown }).content_types;
  const cp = (row as unknown as { content_preferences: unknown }).content_preferences;
  return {
    ...row,
    content_types: Array.isArray(ct) ? ct as PageContentType[] : safeJson(ct, [] as PageContentType[]),
    content_preferences: Array.isArray(cp) ? cp as string[] : safeJson(cp, [] as string[]),
  };
}

/**
 * Deletes a page and takes it out of every campaign it was assigned to.
 * The assignment is a JSONB array rather than a foreign key, so the row's
 * CASCADE never reached it: the campaign kept the id, went on saying
 * "1 pages" over an empty delivery table, and offered no row to untick.
 */
export async function deletePage(id: string): Promise<void> {
  await inTransaction(async client => {
    await client.query(
      `UPDATE outreach_campaigns SET assigned_page_ids = assigned_page_ids - $1::text, updated_at = NOW()
        WHERE assigned_page_ids ? $1::text`,
      [id],
    );
    await client.query(`DELETE FROM outreach_pages WHERE id = $1`, [id]);
  });
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

/** Every creator, or only those in a State User's states (creators are scoped exactly like pages). */
export async function listCreators(scope?: OutreachScope): Promise<OutreachCreator[]> {
  const states = scopeStates(scope);
  const { rows } = states
    ? await pool.query<OutreachCreator>(`SELECT * FROM outreach_creators WHERE state = ANY($1::text[]) ORDER BY handle`, [states])
    : await pool.query<OutreachCreator>(`SELECT * FROM outreach_creators ORDER BY handle`);
  return rows.map(mapCreatorRow);
}

export async function createCreator(rawInput: CreateCreatorInput): Promise<OutreachCreator> {
  const input = placeFields(rawInput);
  input.geography = await settledGeography(input.geography);
  const handle = input.handle.trim();
  const dup = await pool.query(`SELECT handle FROM outreach_creators WHERE ${sameHandleSql} LIMIT 1`, [handle]);
  if (dup.rowCount) throw new OutreachDuplicateError(`@${dup.rows[0].handle} is already a creator.`);

  const base = `creator-${slug(handle) || randomBytes(6).toString("hex")}`;
  const row = await insertWithFreeId(base, async id => (await pool.query<OutreachCreator>(
    `INSERT INTO outreach_creators (id, handle, geography, state, type, follower_tier, content_types, followers, inventory_posts, inventory_stories, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
     RETURNING *`,
    [
      id, handle, input.geography, input.state, input.type, input.follower_tier,
      JSON.stringify(input.content_types ?? []),
      input.followers ?? 0, input.inventory_posts, input.inventory_stories, input.notes ?? "",
    ],
  )).rows[0]);
  return mapCreatorRow(row);
}

/* The columns outreach_creators actually has. The creator payload used to be
   the page payload, so `platform` and `content_preferences` arrived here and
   were written into an UPDATE on columns that don't exist — a 500. A key
   outside this list is never a column name. */
const CREATOR_COLUMNS = new Set([
  "handle", "geography", "state", "type", "follower_tier", "content_types",
  "followers", "inventory_posts", "inventory_stories", "notes", "last_synced_at",
]);

export async function updateCreator(id: string, patch: Partial<CreateCreatorInput> & { last_synced_at?: string }): Promise<OutreachCreator | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  const placed = placeFields(patch);
  if (typeof placed.geography === "string") placed.geography = await settledGeography(placed.geography);
  for (const [k, v] of Object.entries(placed)) {
    if (v === undefined || !CREATOR_COLUMNS.has(k)) continue;
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

/** Deletes a creator and takes it out of every campaign — see deletePage. */
export async function deleteCreator(id: string): Promise<void> {
  await inTransaction(async client => {
    await client.query(
      `UPDATE outreach_campaigns SET assigned_creator_ids = assigned_creator_ids - $1::text, updated_at = NOW()
        WHERE assigned_creator_ids ? $1::text`,
      [id],
    );
    await client.query(`DELETE FROM outreach_creators WHERE id = $1`, [id]);
  });
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
  /** Optional — campaigns are open-ended; empty/absent means no end date. */
  end_date?: string | null;
  state?: string;
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

/**
 * Every campaign — or, for a State User, the campaigns whose own state is one
 * of theirs or that have one of their pages or creators assigned (most
 * campaigns carry no state at all, so the state alone would hide nearly all
 * of them). Their assignment lists come back holding only that user's pages
 * and creators: another state's page ids (and so its handles) never leave the
 * server.
 */
export async function listCampaigns(scope?: OutreachScope): Promise<OutreachCampaign[]> {
  const states = scopeStates(scope);
  if (!states) {
    const { rows } = await pool.query<OutreachCampaign>(
      `SELECT * FROM outreach_campaigns ORDER BY start_date DESC`,
    );
    return rows.map(mapCampaignRow);
  }
  const inScope = (column: string, table: string) => `
    SELECT jsonb_agg(e.id ORDER BY e.n)
      FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(c.${column}) = 'array' THEN c.${column} ELSE '[]'::jsonb END)
           WITH ORDINALITY AS e(id, n)
      JOIN ${table} t ON t.id = e.id
     WHERE t.state = ANY($1::text[])`;
  const { rows } = await pool.query<OutreachCampaign & { scoped_page_ids: string[] | null; scoped_creator_ids: string[] | null }>(
    `SELECT * FROM (
       SELECT c.*,
              (${inScope("assigned_page_ids", "outreach_pages")}) AS scoped_page_ids,
              (${inScope("assigned_creator_ids", "outreach_creators")}) AS scoped_creator_ids
         FROM outreach_campaigns c
     ) scoped
     WHERE state = ANY($1::text[]) OR scoped_page_ids IS NOT NULL OR scoped_creator_ids IS NOT NULL
     ORDER BY start_date DESC`,
    [states],
  );
  return rows.map(({ scoped_page_ids, scoped_creator_ids, ...row }) => mapCampaignRow({
    ...row,
    assigned_page_ids: scoped_page_ids ?? [],
    assigned_creator_ids: scoped_creator_ids ?? [],
  }));
}

export async function getCampaign(id: string): Promise<OutreachCampaign | null> {
  const { rows } = await pool.query<OutreachCampaign>(
    `SELECT * FROM outreach_campaigns WHERE id = $1`,
    [id],
  );
  return rows[0] ? mapCampaignRow(rows[0]) : null;
}

/** Which page or creator a post belongs to — enough to decide whose state it is. */
export async function getPostOwner(id: string): Promise<{ page_id: string | null; creator_id: string | null } | null> {
  const { rows } = await pool.query<{ page_id: string | null; creator_id: string | null }>(
    `SELECT page_id, creator_id FROM outreach_posts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

export async function getPage(id: string): Promise<OutreachPage | null> {
  const { rows } = await pool.query<OutreachPage>(
    `SELECT * FROM outreach_pages WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createCampaign(rawInput: CreateCampaignInput): Promise<OutreachCampaign> {
  const input = placeFields(rawInput);
  const name = input.name.trim();
  /* Two campaigns with the same name are almost always one created twice, and
     every dashboard and filter would show them as indistinguishable. Names
     that merely slug alike — "Diwali!" and "Diwali" — are different names and
     are allowed; insertWithFreeId keeps their ids apart. */
  const dup = await pool.query(
    `SELECT name FROM outreach_campaigns WHERE lower(trim(name)) = lower($1) LIMIT 1`, [name]);
  if (dup.rowCount) throw new OutreachDuplicateError(`A campaign called “${dup.rows[0].name}” already exists.`);
  await assertMembersExist(input.assigned_page_ids, input.assigned_creator_ids);

  const row = await insertWithFreeId(slug(name) || newId("c"), async id => (await pool.query<OutreachCampaign>(
    `INSERT INTO outreach_campaigns
       (id, name, start_date, end_date, state, goal, status,
        budget_posts, budget_stories, budget_reels,
        approvers, creative_variants, assigned_page_ids, assigned_creator_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING *`,
    [
      id, name, input.start_date, input.end_date || null, input.state ?? "", input.goal ?? "", input.status,
      input.budget_posts, input.budget_stories, input.budget_reels,
      JSON.stringify(input.approvers), JSON.stringify(input.creative_variants),
      JSON.stringify(input.assigned_page_ids), JSON.stringify(input.assigned_creator_ids ?? []),
    ],
  )).rows[0]);
  return mapCampaignRow(row);
}

export async function updateCampaign(id: string, patch: Partial<CreateCampaignInput>): Promise<OutreachCampaign | null> {
  await assertMembersExist(patch.assigned_page_ids, patch.assigned_creator_ids);
  const fields: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(placeFields(patch))) {
    if (v === undefined) continue;
    if (k === "approvers" || k === "creative_variants" || k === "assigned_page_ids" || k === "assigned_creator_ids") {
      fields.push(`${k} = $${i++}::jsonb`);
      values.push(JSON.stringify(v));
    } else if (k === "end_date") {
      // Empty string means "clear the end date" — the DATE column wants NULL.
      fields.push(`${k} = $${i++}`);
      values.push(v || null);
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
    start_date: dayOf(row.start_date),
    // NULL end_date (open-ended campaign) maps to '' for the client.
    end_date: dayOf(row.end_date),
  };
}

function safeJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

// ── Post CRUD / upsert ─────────────────────────────────────────────────────

export interface UpsertPostInput {
  instagram_id: string;
  platform?: Platform;
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
  added_as_live?: boolean;
}

export async function listPosts(
  filters: { pageId?: string; creatorId?: string; campaignId?: string } = {},
  scope?: OutreachScope,
): Promise<OutreachPost[]> {
  const where: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (filters.pageId)     { where.push(`page_id = $${i++}`);     values.push(filters.pageId); }
  if (filters.creatorId)  { where.push(`creator_id = $${i++}`);  values.push(filters.creatorId); }
  if (filters.campaignId) { where.push(`campaign_id = $${i++}`); values.push(filters.campaignId); }
  /* A post has no state of its own; it is in a State User's states when the
     page or creator that owns it is (every post has exactly one owner). This
     must be in the WHERE of both halves below, not applied afterwards: the
     synced half is capped at 2000 rows, and filtering after the cap would
     let other states' posts crowd this user's out. */
  const states = scopeStates(scope);
  if (states) {
    const n = i++;
    where.push(`(page_id IN (SELECT id FROM outreach_pages WHERE state = ANY($${n}::text[]))
              OR creator_id IN (SELECT id FROM outreach_creators WHERE state = ANY($${n}::text[])))`);
    values.push(states);
  }
  // The 2000-row LIMIT keeps the unfiltered /outreach/posts response from
  // ballooning over thousands of Apify-synced rows. But `date` here is the
  // Instagram post's PUBLISH date, not the row's creation date — so a
  // freshly added live post can have a years-old publish date, fall below
  // the cutoff, and become invisible to the page detail view.
  //
  // Always return every added_as_live row (operator-curated, small in
  // count). Cap only the Apify-synced backlog.
  const filterClause = where.length ? where.join(" AND ") + " AND " : "";
  const sql = `
    SELECT * FROM (
      SELECT * FROM outreach_posts WHERE ${filterClause}added_as_live = true
      UNION ALL
      SELECT * FROM (
        SELECT * FROM outreach_posts WHERE ${filterClause}added_as_live = false
        ORDER BY date DESC
        LIMIT 2000
      ) recent
    ) combined
    ORDER BY date DESC
  `;
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
  /* A campaign, page or creator that doesn't exist used to fail its foreign
     key mid-loop: a 500, with the rows before it already saved. Name it up
     front instead, and insert all-or-nothing. Every id the insert will write
     is checked, the blank string included: skipping falsy ids let "" past the
     check and into the foreign key. */
  const idsOf = (key: "campaign_id" | "page_id" | "creator_id") =>
    inputs.map(p => p[key]).filter((v): v is string => v != null);
  await assertAllExist("outreach_campaigns", idsOf("campaign_id"), "campaign");
  await assertAllExist("outreach_pages", idsOf("page_id"), "page");
  await assertAllExist("outreach_creators", idsOf("creator_id"), "creator");
  return inTransaction(client => insertPlannedPosts(client, inputs));
}

async function insertPlannedPosts(client: PoolClient, inputs: CreatePlannedPostInput[]): Promise<OutreachPost[]> {
  const created: OutreachPost[] = [];
  for (const input of inputs) {
    const id = newId("post");
    const { rows } = await client.query<OutreachPost>(
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
       (id, instagram_id, platform, page_id, creator_id, campaign_id, date, type, creative_variant, caption,
        status, likes, comments, views, saves, shares, media_url, permalink, synced_at, added_as_live)
     VALUES ($1, $2, $19, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NOW(), $18)
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
       -- Views on Instagram are monotonically increasing, but the scrapers are
       -- not equally reliable: the profile scraper (and occasionally the post
       -- scraper) can omit videoPlayCount and report only the much smaller
       -- videoViewCount. Never let a weaker scrape downgrade a known count.
       views            = GREATEST(outreach_posts.views, EXCLUDED.views),
       media_url        = EXCLUDED.media_url,
       permalink        = EXCLUDED.permalink,
       synced_at        = NOW(),
       added_as_live    = outreach_posts.added_as_live OR EXCLUDED.added_as_live
     RETURNING *`,
    [
      id, input.instagram_id, input.page_id ?? null, input.creator_id ?? null, input.campaign_id ?? null,
      input.date, input.type, input.creative_variant ?? null, input.caption,
      input.status, input.likes, input.comments, input.views, input.saves ?? 0, input.shares ?? 0,
      input.media_url ?? null, input.permalink ?? null, input.added_as_live ?? false,
      input.platform ?? "instagram",
    ],
  );
  return mapPostRow(rows[0]);
}

/**
 * Live (operator-curated) posts that still carry a permalink we can re-scrape.
 * These are what the dashboard's reach/views KPIs are built from, so a "Sync
 * now" needs to refresh exactly these rows. Optionally scoped to a set of page
 * ids (used when a sync targets a subset of handles).
 */
export async function listLivePostsWithPermalink(
  scope: { pageIds?: string[]; campaignId?: string } = {},
): Promise<OutreachPost[]> {
  const where: string[] = [
    `added_as_live = true`,
    `permalink IS NOT NULL AND permalink <> ''`,
    // Both platforms are re-scrapable now. The caller (refreshLivePostMetrics)
    // splits by platform and routes each to its own actor — an Instagram URL
    // must never reach the Facebook scraper, and vice versa.
  ];
  const values: unknown[] = [];
  let i = 1;
  if (scope.pageIds && scope.pageIds.length > 0) { where.push(`page_id = ANY($${i++})`); values.push(scope.pageIds); }
  if (scope.campaignId) { where.push(`campaign_id = $${i++}`); values.push(scope.campaignId); }
  const { rows } = await pool.query<OutreachPost>(
    `SELECT * FROM outreach_posts WHERE ${where.join(" AND ")} ORDER BY date DESC`,
    values,
  );
  return rows.map(mapPostRow);
}

/**
 * Updates only the live metrics of an existing post (keyed by primary id), and
 * bumps synced_at. Deliberately never touches page/creator/campaign/variant
 * associations or added_as_live — used to refresh reach without re-attributing.
 */
export async function updatePostMetrics(
  id: string,
  metrics: { likes: number; comments: number; views: number; shares?: number; media_url?: string | null },
): Promise<OutreachPost | null> {
  const { rows } = await pool.query<OutreachPost>(
    `UPDATE outreach_posts
        SET likes = $2, comments = $3,
            -- Monotonic clamp: a scrape missing videoPlayCount reports a much
            -- smaller count — never downgrade a previously captured views value.
            views = GREATEST(views, $4),
            -- Instagram's scrapers can't read shares (always undefined here);
            -- Facebook's can, so only overwrite when a real value is supplied.
            shares = COALESCE($6, shares),
            media_url = COALESCE($5, media_url),
            synced_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [id, metrics.likes, metrics.comments, metrics.views, metrics.media_url ?? null, metrics.shares ?? null],
  );
  return rows[0] ? mapPostRow(rows[0]) : null;
}

export async function deletePost(id: string): Promise<void> {
  await pool.query(`DELETE FROM outreach_posts WHERE id = $1`, [id]);
}

function mapPostRow(row: OutreachPost): OutreachPost {
  return {
    ...row,
    date: dayOf(row.date),
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
