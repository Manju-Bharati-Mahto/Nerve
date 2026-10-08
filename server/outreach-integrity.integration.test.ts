// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — outreach references against a real PostgreSQL.

   A campaign's page/creator assignments are JSONB arrays, not foreign keys, so
   nothing in the schema keeps them honest; and a planned post's campaign used
   to be checked only by its foreign key, mid-insert. These pin the rules that
   now do that work, plus the creator update that wrote unknown keys into SQL.

   Fixtures are synthetic ("fix-…" ids) and removed afterwards. Skips cleanly
   when no test database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

let dbUp = false;
let db: typeof import("./outreach-db.js");
let pool: import("pg").Pool;

{
  try {
    const url = resolveTestDatabaseUrl();
    process.env.DATABASE_URL = url;
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: url });
    await pool.query("SELECT 1");
    db = await import("./outreach-db.js");
    dbUp = true;
  } catch {
    dbUp = false;   // no database here; the suite skips rather than fails
  }
}

const maybe = () => (dbUp ? it : it.skip);

const RUN = `fix-g2-${Date.now().toString(36)}`;
const pageIds: string[] = [];
const creatorIds: string[] = [];
const campaignIds: string[] = [];

async function freshPage(tag: string) {
  const p = await db.createPage({
    handle: `${RUN}_${tag}`, geography: "FIX", state: "FIX", type: "state",
    follower_tier: "1", inventory_posts: 1, inventory_stories: 1,
  });
  pageIds.push(p.id);
  return p;
}

async function freshCreator(tag: string) {
  const c = await db.createCreator({
    handle: `${RUN}_c_${tag}`, geography: "FIX", state: "FIX", type: "state",
    follower_tier: "1", inventory_posts: 1, inventory_stories: 1,
  });
  creatorIds.push(c.id);
  return c;
}

async function freshCampaign(tag: string, assigned: { pages?: string[]; creators?: string[] } = {}) {
  const c = await db.createCampaign({
    name: `FIX ${RUN} ${tag}`, start_date: "2026-10-08", status: "planning",
    budget_posts: 1, budget_stories: 0, budget_reels: 0,
    approvers: [], creative_variants: [],
    assigned_page_ids: assigned.pages ?? [], assigned_creator_ids: assigned.creators ?? [],
  });
  campaignIds.push(c.id);
  return c;
}

beforeAll(async () => {
  if (!dbUp) return;
  await db.bootstrapOutreach();
});

afterAll(async () => {
  if (!dbUp) return;
  await pool.query(`DELETE FROM outreach_campaigns WHERE id = ANY($1::text[])`, [campaignIds]);
  await pool.query(`DELETE FROM outreach_pages WHERE id = ANY($1::text[])`, [pageIds]);
  await pool.query(`DELETE FROM outreach_creators WHERE id = ANY($1::text[])`, [creatorIds]);
  await pool.end();
});

describe("campaign assignments never point at nothing", () => {
  maybe()("deleting a page takes it out of every campaign that had it", async () => {
    const gone = await freshPage("gone");
    const kept = await freshPage("kept");
    const campaign = await freshCampaign("page-delete", { pages: [gone.id, kept.id] });

    await db.deletePage(gone.id);

    const after = await db.getCampaign(campaign.id);
    expect(after?.assigned_page_ids).toEqual([kept.id]);
  });

  maybe()("deleting a creator takes it out of every campaign that had it", async () => {
    const gone = await freshCreator("gone");
    const campaign = await freshCampaign("creator-delete", { creators: [gone.id] });

    await db.deleteCreator(gone.id);

    expect((await db.getCampaign(campaign.id))?.assigned_creator_ids).toEqual([]);
  });

  maybe()("refuses to create or patch a campaign with an id that doesn't exist", async () => {
    const real = await freshPage("real");
    await expect(freshCampaign("ghost-create", { pages: [real.id, `${RUN}-no-such-page`] }))
      .rejects.toBeInstanceOf(db.OutreachValidationError);

    const campaign = await freshCampaign("ghost-patch", { pages: [real.id] });
    await expect(db.updateCampaign(campaign.id, { assigned_creator_ids: [`${RUN}-no-such-creator`] }))
      .rejects.toThrow(/Unknown creator id: .*no-such-creator/);
    expect((await db.getCampaign(campaign.id))?.assigned_creator_ids).toEqual([]);
  });

  maybe()("bootstrap clears ghosts that were stored before deletes cleaned up", async () => {
    const real = await freshPage("legacy");
    const campaign = await freshCampaign("legacy-ghost", { pages: [real.id] });
    // What an old deletePage left behind: an id with no row.
    await pool.query(
      `UPDATE outreach_campaigns SET assigned_page_ids = $2::jsonb WHERE id = $1`,
      [campaign.id, JSON.stringify([`${RUN}-deleted-long-ago`, real.id])],
    );

    await db.bootstrapOutreach();

    expect((await db.getCampaign(campaign.id))?.assigned_page_ids).toEqual([real.id]);
  });
});

describe("planned posts name things that exist", () => {
  maybe()("an unknown campaign is a validation error, and nothing in the batch is saved", async () => {
    const page = await freshPage("posts");
    const campaign = await freshCampaign("posts", { pages: [page.id] });

    await expect(db.createPostsBulk([
      { page_id: page.id, campaign_id: campaign.id, date: "2026-10-08", type: "static", status: "draft" },
      { page_id: page.id, campaign_id: `${RUN}-no-such-campaign`, date: "2026-10-08", type: "static", status: "draft" },
    ])).rejects.toThrow(/Unknown campaign id/);

    expect(await db.listPosts({ pageId: page.id })).toEqual([]);
  });
});

describe("updateCreator", () => {
  maybe()("ignores keys that aren't creator columns instead of crashing in SQL", async () => {
    const creator = await freshCreator("patch");
    const patch = { inventory_posts: 7, platform: "facebook", content_preferences: ["News"] };

    const updated = await db.updateCreator(creator.id, patch as Parameters<typeof db.updateCreator>[1]);

    expect(updated?.inventory_posts).toBe(7);
  });
});
