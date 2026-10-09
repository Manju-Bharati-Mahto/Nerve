// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — editing a page (PRD 6.5) against a real PostgreSQL.

   Pins what a rename must keep (the id, and with it the page's posts and
   campaign assignments), what it must refuse (a name another page already
   has, in any case), and what it must drop (a Facebook page's cached Meta id,
   which was resolved from the old name).

   Fixtures are synthetic ("fix-pe-…") and removed afterwards. Skips cleanly
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
    dbUp = false;
  }
}

const maybe = () => (dbUp ? it : it.skip);

const RUN = `fix_pe_${Date.now().toString(36)}`;
const pageIds: string[] = [];
const campaignIds: string[] = [];

async function freshPage(tag: string, platform: "instagram" | "facebook" = "instagram") {
  const p = await db.createPage({
    handle: `${RUN}_${tag}`, platform, geography: "Vadodara", state: "Gujarat", type: "state",
    follower_tier: "1", inventory_posts: 10, inventory_stories: 5,
  });
  pageIds.push(p.id);
  return p;
}

beforeAll(async () => {
  if (!dbUp) return;
  await db.bootstrapOutreach();
});

afterAll(async () => {
  if (!dbUp) return;
  await pool.query(`DELETE FROM outreach_campaigns WHERE id = ANY($1::text[])`, [campaignIds]);
  await pool.query(`DELETE FROM outreach_pages WHERE id = ANY($1::text[])`, [pageIds]);
  await pool.end();
});

describe("editPage — renaming", () => {
  maybe()("keeps the id, so posts and campaign assignments stay with the page", async () => {
    const page = await freshPage("ren");
    const campaign = await db.createCampaign({
      name: `FIX ${RUN} ren`, start_date: "2026-10-08", status: "planning",
      budget_posts: 1, budget_stories: 0, budget_reels: 0,
      approvers: [], creative_variants: [], assigned_page_ids: [page.id], assigned_creator_ids: [],
    });
    campaignIds.push(campaign.id);
    await db.upsertPostByInstagramId({
      instagram_id: `${RUN}_post`, platform: "instagram", page_id: page.id, campaign_id: campaign.id,
      date: "2026-10-08", type: "static", creative_variant: null, caption: "x", status: "published",
      likes: 5, comments: 1, views: 100, saves: 0, shares: 0, media_url: null, permalink: null,
    });

    const renamed = await db.editPage(page.id, { handle: `https://www.instagram.com/${RUN}_new/?hl=en` });
    expect(renamed?.id).toBe(page.id);
    expect(renamed?.handle).toBe(`${RUN}_new`);
    const posts = await pool.query(`SELECT page_id FROM outreach_posts WHERE instagram_id = $1`, [`${RUN}_post`]);
    expect(posts.rows[0].page_id).toBe(page.id);
    expect((await db.getCampaign(campaign.id))?.assigned_page_ids).toEqual([page.id]);
    expect((await db.getPage(page.id))?.inventory_posts).toBe(10);
  });

  maybe()("refuses a name another page on the same platform has, in any case or with @", async () => {
    const taken = await freshPage("taken");
    const other = await freshPage("other");
    for (const attempt of [taken.handle, taken.handle.toUpperCase(), `@${taken.handle}`]) {
      await expect(db.editPage(other.id, { handle: attempt })).rejects.toBeInstanceOf(db.OutreachDuplicateError);
    }
    expect((await db.getPage(other.id))?.handle).toBe(other.handle);
  });

  maybe()("allows the same name as a page on the OTHER platform, and a case change of its own", async () => {
    const ig = await freshPage("cross");
    const fb = await freshPage("fbcross", "facebook");
    expect((await db.editPage(fb.id, { handle: ig.handle }))?.handle).toBe(ig.handle);
    const upper = ig.handle.toUpperCase();
    expect((await db.editPage(ig.id, { handle: upper }))?.handle).toBe(upper);
  });

  maybe()("refuses a handle the sync could never find", async () => {
    const page = await freshPage("bad");
    await expect(db.editPage(page.id, { handle: "two words" })).rejects.toBeInstanceOf(db.OutreachValidationError);
  });

  maybe()("never changes the platform", async () => {
    const page = await freshPage("plat");
    await expect(db.editPage(page.id, { platform: "facebook" })).rejects.toBeInstanceOf(db.OutreachValidationError);
    expect((await db.editPage(page.id, { platform: "instagram", notes: "same platform is fine" }))?.platform).toBe("instagram");
  });

  maybe()("returns null for a page that isn't there", async () => {
    expect(await db.editPage(`${RUN}_nothing`, { notes: "x" })).toBeNull();
  });
});

describe("editPage — Facebook trust anchor", () => {
  maybe()("clears platform_page_id when a Facebook page gets a different name, keeps it otherwise", async () => {
    const page = await freshPage("fbid", "facebook");
    const setId = () => pool.query(`UPDATE outreach_pages SET platform_page_id = '111' WHERE id = $1`, [page.id]);

    await setId();
    expect((await db.editPage(page.id, { inventory_posts: 3 }))?.platform_page_id).toBe("111");
    expect((await db.editPage(page.id, { handle: page.handle.toUpperCase() }))?.platform_page_id).toBe("111");
    expect((await db.editPage(page.id, { handle: `${RUN}_fbid_renamed` }))?.platform_page_id).toBeNull();
  });

  maybe()("an Instagram rename leaves the column alone", async () => {
    const page = await freshPage("igid");
    await pool.query(`UPDATE outreach_pages SET platform_page_id = 'keep' WHERE id = $1`, [page.id]);
    expect((await db.editPage(page.id, { handle: `${RUN}_igid2` }))?.platform_page_id).toBe("keep");
  });

  maybe()("a scrape that finishes after a rename does not write the old page's id back", async () => {
    const page = await freshPage("race", "facebook");
    const scrapedUnder = page.handle;
    await db.editPage(page.id, { handle: `${RUN}_race_new` });
    expect(await db.cacheFacebookOwnerId(page.id, scrapedUnder, "old-page-id")).toBeNull();
    expect((await db.getPage(page.id))?.platform_page_id).toBeNull();
    // Scraped under the current name, it is cached.
    expect(await db.cacheFacebookOwnerId(page.id, `${RUN}_race_new`, "new-id")).toBe("new-id");
    expect((await db.getPage(page.id))?.platform_page_id).toBe("new-id");
  });
});

describe("editPage — the other fields", () => {
  maybe()("validates the link against the page's platform, and '' clears it", async () => {
    const page = await freshPage("link");
    expect((await db.editPage(page.id, { page_link: "instagram.com/x" }))?.page_link).toBe("https://instagram.com/x");
    await expect(db.editPage(page.id, { page_link: "https://facebook.com/x" })).rejects.toBeInstanceOf(db.OutreachValidationError);
    await expect(db.editPage(page.id, { page_link: "not a url" })).rejects.toBeInstanceOf(db.OutreachValidationError);
    expect((await db.editPage(page.id, { page_link: "" }))?.page_link).toBe("");
  });

  maybe()("hands back a legacy link or handle unchanged without re-checking it", async () => {
    const page = await freshPage("legacy");
    await pool.query(`UPDATE outreach_pages SET page_link = 'see sheet', handle = $2 WHERE id = $1`, [page.id, `${RUN} legacy name`]);
    const saved = await db.editPage(page.id, { handle: `${RUN} legacy name`, page_link: "see sheet", inventory_posts: 2 });
    expect(saved?.inventory_posts).toBe(2);
    expect(saved?.page_link).toBe("see sheet");
  });

  maybe()("lowers inventory below what is used, and canonicalises state", async () => {
    const page = await freshPage("inv");
    const saved = await db.editPage(page.id, { inventory_posts: 0, inventory_stories: 0, state: "tamil nadu", geography: "  chennai  " });
    expect(saved?.inventory_posts).toBe(0);
    expect(saved?.state).toBe("Tamil Nadu");
    expect(saved?.geography).toBe("chennai");
  });

  maybe()("an empty edit changes nothing, not even updated_at", async () => {
    const page = await freshPage("noop");
    const before = await db.getPage(page.id);
    const after = await db.editPage(page.id, {});
    expect(after?.updated_at).toEqual(before?.updated_at);
  });
});
