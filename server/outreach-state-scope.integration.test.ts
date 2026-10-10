// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — outreach geography migration and state-scoped reads (PRD 6.3,
   6.4) against a real PostgreSQL.

   The migration rewrites free-text states to the master list's spelling at
   every start; these pin that it is idempotent, never guesses or deletes, and
   leaves the archive tables, posts and updated_at alone. The scope half pins
   that a State User's lists are filtered IN SQL — including under the
   2000-post cap — and that campaigns show only that user's pages.

   Fixtures are "PRD…" rows, removed afterwards. Skips cleanly when no test
   database is reachable.
   ═══════════════════════════════════════════════════════════════════════════ */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveTestDatabaseUrl } from "./test-db.js";

let dbUp = false;
let db: typeof import("./outreach-db.js");
let scopeMod: typeof import("./outreach-scope.js");
let pool: import("pg").Pool;

{
  try {
    const url = resolveTestDatabaseUrl();
    process.env.DATABASE_URL = url;
    const pg = await import("pg");
    pool = new pg.default.Pool({ connectionString: url });
    await pool.query("SELECT 1");
    db = await import("./outreach-db.js");
    scopeMod = await import("./outreach-scope.js");
    dbUp = true;
  } catch {
    dbUp = false;   // no database here; the suite skips rather than fails
  }
}

const maybe = () => (dbUp ? it : it.skip);

const RUN = `prd-${Date.now().toString(36)}`;
const pageIds: string[] = [];
const creatorIds: string[] = [];
const campaignIds: string[] = [];
const userIds: string[] = [];

/** A page row written straight to the table — the way legacy, un-normalised rows got there. */
async function rawPage(tag: string, state: string, geography = "Somewhere") {
  const id = `${RUN}-p-${tag}`;
  await pool.query(
    `INSERT INTO outreach_pages (id, handle, geography, state, type, follower_tier, updated_at)
     VALUES ($1, $1, $2, $3, 'state', '1', '2020-01-01T00:00:00Z')`, [id, geography, state]);
  pageIds.push(id);
  return id;
}

async function rawCreator(tag: string, state: string, geography = "Somewhere") {
  const id = `${RUN}-c-${tag}`;
  await pool.query(
    `INSERT INTO outreach_creators (id, handle, geography, state, type, follower_tier)
     VALUES ($1, $1, $2, $3, 'state', '1')`, [id, geography, state]);
  creatorIds.push(id);
  return id;
}

async function rawCampaign(tag: string, state: string, pages: string[] = [], creators: string[] = []) {
  const id = `${RUN}-k-${tag}`;
  await pool.query(
    `INSERT INTO outreach_campaigns (id, name, start_date, state, status, assigned_page_ids, assigned_creator_ids)
     VALUES ($1, $1, '2026-10-01', $2, 'planning', $3::jsonb, $4::jsonb)`,
    [id, state, JSON.stringify(pages), JSON.stringify(creators)]);
  campaignIds.push(id);
  return id;
}

async function rawPost(tag: string, owner: { page?: string; creator?: string }, date: string, live = false) {
  const id = `${RUN}-post-${tag}`;
  await pool.query(
    `INSERT INTO outreach_posts (id, instagram_id, page_id, creator_id, date, type, status, added_as_live)
     VALUES ($1, $1, $2, $3, $4, 'static', 'published', $5)`,
    [id, owner.page ?? null, owner.creator ?? null, date, live]);
  return id;
}

const valueOf = async (table: string, column: string, id: string) =>
  (await pool.query(`SELECT ${column} AS v FROM ${table} WHERE id = $1`, [id])).rows[0]?.v as string;

/** Another worker's bootstrap may hold the migration's try-lock for a moment. */
async function migrate() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const summary = await db.migrateOutreachStates();
    if (!summary.skipped) return summary;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("migration lock never came free");
}

beforeAll(async () => {
  if (!dbUp) return;
  /* Other suites bootstrap in parallel workers, and two bootstraps racing on
     the same idempotent DDL can collide on a catalog row; the second try finds
     everything in place. */
  for (let attempt = 0; ; attempt++) {
    try { await db.bootstrapOutreach(); break; } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise(r => setTimeout(r, 200));
    }
  }
});

afterAll(async () => {
  if (!dbUp) return;
  await pool.query(`DELETE FROM outreach_campaigns WHERE id = ANY($1::text[])`, [campaignIds]);
  await pool.query(`DELETE FROM outreach_pages WHERE id = ANY($1::text[])`, [pageIds]);
  await pool.query(`DELETE FROM outreach_creators WHERE id = ANY($1::text[])`, [creatorIds]);
  await pool.query(`DELETE FROM users WHERE id = ANY($1::text[])`, [userIds]);
  // The delete triggers archived them; these are fixtures, not history.
  await pool.query(`DELETE FROM outreach_posts_archive WHERE id LIKE $1`, [`${RUN}%`]);
  await pool.query(`DELETE FROM outreach_pages_archive WHERE id LIKE $1`, [`${RUN}%`]);
  await pool.query(`DELETE FROM outreach_campaigns_archive WHERE id LIKE $1`, [`${RUN}%`]);
  await pool.query(`DELETE FROM outreach_state_migration_log WHERE row_id LIKE $1`, [`${RUN}%`]);
  await pool.end();
});

describe("geography spellings that only match as a group", () => {
  /* "Start up" and "Startup" are not states, so no single value says which is
     right — only seeing both does. Letters unique to this run, because the key
     ignores digits and the pass looks across the whole table. */
  const token = `Zq${RUN.replace(/[^a-z]/gi, "").slice(-6)}`;
  // Lakshadweep, which no other test here scopes to, so these rows cannot leak into a State User's results.

  maybe()("rewrites every spelling of one geography to one, across pages and creators", async () => {
    const a = await rawPage("g1", "Lakshadweep", `${token} Start up`);
    const b = await rawPage("g2", "Lakshadweep", `${token}Startup`);
    const c = await rawPage("g3", "Lakshadweep", `${token}Startup`);
    const d = await rawCreator("g4", "Lakshadweep", `${token.toLowerCase()} start up`);

    await migrate();

    const values = [
      await valueOf("outreach_pages", "geography", a),
      await valueOf("outreach_pages", "geography", b),
      await valueOf("outreach_pages", "geography", c),
      await valueOf("outreach_creators", "geography", d),
    ];
    // Two rows say "…Startup", one "… Start up", one lower case: the commonest wins.
    expect(new Set(values)).toEqual(new Set([`${token}Startup`]));
  });

  maybe()("stores a new page under the spelling already in use", async () => {
    await rawPage("g5", "Lakshadweep", `${token}Law`);
    expect(await db.settledGeography(`${token.toLowerCase()} law`)).toBe(`${token}Law`);
    // A geography nobody uses yet is kept as typed (tidied).
    expect(await db.settledGeography(`  ${token}Fresh   Place `)).toBe(`${token}Fresh Place`);
  });
});

describe("the state / geography migration", () => {
  maybe()("merges spellings, tidies geography, leaves unknowns, and is idempotent", async () => {
    const padded = await rawPage("padded", "  gujarat  ", "gujarat");
    const lower = await rawPage("lower", "gujarat", "  Vadodara   City ");
    const ladakh = await rawPage("ladakh", "ladakh", "New Delhi");
    const tamil = await rawPage("tamil", "Tamilnadu", "Tamilnadu");
    const guj = await rawCreator("guj", "Guj", "Vadodara");
    const odisha = await rawCreator("orissa", "Orissa", "Orissa");
    const unscoped = await rawCampaign("unscoped", "");
    const cmp = await rawCampaign("tn", "tamil nadu");
    const post = await rawPost("kept", { page: lower }, "2026-01-01");
    // A forensic copy of a deleted row: must stay exactly as it was archived.
    await pool.query(
      `INSERT INTO outreach_pages_archive (id, handle, geography, state) VALUES ($1, $1, 'gujarat', 'gujarat')`,
      [`${RUN}-archived`]);

    const first = await migrate();

    expect(await valueOf("outreach_pages", "state", padded)).toBe("Gujarat");
    expect(await valueOf("outreach_pages", "state", lower)).toBe("Gujarat");
    expect(await valueOf("outreach_pages", "state", ladakh)).toBe("Ladakh");
    expect(await valueOf("outreach_pages", "state", tamil)).toBe("Tamil Nadu");
    expect(await valueOf("outreach_creators", "state", odisha)).toBe("Odisha");
    expect(await valueOf("outreach_campaigns", "state", cmp)).toBe("Tamil Nadu");
    // Campaign '' means "not tied to a state" and stays that way.
    expect(await valueOf("outreach_campaigns", "state", unscoped)).toBe("");

    /* Geography: a state name takes the state's spelling; a city is only
       tidied. UPDATED: "Orissa" used to stay "Orissa" (no aliases for
       geography); the product owner asked for abbreviations and old names to
       merge too, so it is now "Odisha". The city-name aliases still do not
       apply: New Delhi stays New Delhi. */
    expect(await valueOf("outreach_pages", "geography", padded)).toBe("Gujarat");
    expect(await valueOf("outreach_pages", "geography", lower)).toBe("Vadodara City");
    expect(await valueOf("outreach_pages", "geography", ladakh)).toBe("New Delhi");
    expect(await valueOf("outreach_pages", "geography", tamil)).toBe("Tamil Nadu");
    expect(await valueOf("outreach_creators", "geography", odisha)).toBe("Odisha");

    // Never guessed: "Guj" is left exactly as it is, and recorded once.
    expect(await valueOf("outreach_creators", "state", guj)).toBe("Guj");
    expect(first.unmatched.some(u => u.table === "outreach_creators" && u.from === "Guj")).toBe(true);

    // Nothing else moves: posts keep their page, updated_at is untouched, the archive is untouched.
    expect((await pool.query(`SELECT page_id FROM outreach_posts WHERE id = $1`, [post])).rows[0].page_id).toBe(lower);
    const touched = await pool.query(`SELECT updated_at FROM outreach_pages WHERE id = $1`, [padded]);
    expect(new Date(touched.rows[0].updated_at).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect((await pool.query(`SELECT state, geography FROM outreach_pages_archive WHERE id = $1`, [`${RUN}-archived`])).rows[0])
      .toEqual({ state: "gujarat", geography: "gujarat" });

    // Every changed row is logged with its old value under this run.
    const logged = await pool.query(
      `SELECT row_id, column_name, old_value, new_value, outcome FROM outreach_state_migration_log
        WHERE run_id = $1 AND row_id = $2 ORDER BY column_name`, [first.runId, padded]);
    expect(logged.rows).toEqual([
      { row_id: padded, column_name: "geography", old_value: "gujarat", new_value: "Gujarat", outcome: "merged" },
      { row_id: padded, column_name: "state", old_value: "  gujarat  ", new_value: "Gujarat", outcome: "merged" },
    ]);

    // A second start changes none of these rows and does not log "Guj" again.
    const second = await migrate();
    const mine = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outreach_state_migration_log WHERE run_id = $1 AND row_id LIKE $2`,
      [second.runId, `${RUN}%`]);
    expect(mine.rows[0].n).toBe(0);
    const gujLog = await pool.query(
      `SELECT COUNT(*)::int AS n FROM outreach_state_migration_log WHERE row_id = $1 AND outcome = 'unmatched'`, [guj]);
    expect(gujLog.rows[0].n).toBe(1);

    // The documented rollback restores one run's values.
    await pool.query(
      `UPDATE outreach_pages t SET state = l.old_value
         FROM outreach_state_migration_log l
        WHERE l.run_id = $1 AND l.table_name = 'outreach_pages' AND l.column_name = 'state'
          AND l.row_id = t.id AND l.outcome <> 'unmatched' AND t.state = l.new_value AND t.id = ANY($2::text[])`,
      [first.runId, pageIds]);
    expect(await valueOf("outreach_pages", "state", padded)).toBe("  gujarat  ");
    expect(await valueOf("outreach_pages", "state", ladakh)).toBe("ladakh");
  });

  maybe()("the write path stores the canonical spelling, and keeps an unknown value it was handed", async () => {
    const page = await db.createPage({
      handle: `${RUN}_written`, geography: " gujarat ", state: "  tamil-nadu ", type: "state",
      follower_tier: "1", inventory_posts: 1, inventory_stories: 1,
    });
    pageIds.push(page.id);
    expect(page.state).toBe("Tamil Nadu");
    expect(page.geography).toBe("Gujarat");
    // The route refuses an unknown state; the database layer only tidies it.
    const updated = await db.updatePage(page.id, { state: " FIX " });
    expect(updated?.state).toBe("FIX");
    // A patch without state or geography leaves them alone.
    expect((await db.updatePage(page.id, { notes: "x" }))?.state).toBe("FIX");
  });
});

describe("state-scoped reads", () => {
  maybe()("a State User sees only their states' pages, creators, campaigns and posts", async () => {
    const pGuj = await rawPage("s-guj", "Gujarat");
    const pLad = await rawPage("s-lad", "Ladakh");
    const cGuj = await rawCreator("s-guj", "Gujarat");
    const cLad = await rawCreator("s-lad", "Ladakh");
    const mixed = await rawCampaign("s-mixed", "", [pLad, pGuj], [cLad, cGuj]);
    const ladakhOnly = await rawCampaign("s-lad", "Ladakh", [pLad]);
    const gujNoPages = await rawCampaign("s-guj", "Gujarat");
    const viaCreator = await rawCampaign("s-creator", "", [], [cGuj]);
    const postGuj = await rawPost("s-guj", { page: pGuj }, "2026-02-01");
    const postLad = await rawPost("s-lad", { page: pLad }, "2026-02-01");
    const postCGuj = await rawPost("s-cguj", { creator: cGuj }, "2026-02-01", true);
    const postCLad = await rawPost("s-clad", { creator: cLad }, "2026-02-01", true);
    const guj = { kind: "states" as const, states: ["Gujarat"] };
    const mineOnly = <T extends { id: string }>(rows: T[]) => rows.filter(r => r.id.startsWith(RUN));

    expect(mineOnly(await db.listPages(guj)).map(p => p.id)).toEqual([pGuj]);
    expect(mineOnly(await db.listCreators(guj)).map(c => c.id)).toEqual([cGuj]);

    const campaigns = mineOnly(await db.listCampaigns(guj));
    expect(campaigns.map(c => c.id).sort()).toEqual([gujNoPages, mixed, viaCreator].sort());
    const m = campaigns.find(c => c.id === mixed)!;
    // Another state's page ids never leave the server.
    expect(m.assigned_page_ids).toEqual([pGuj]);
    expect(m.assigned_creator_ids).toEqual([cGuj]);
    expect(campaigns.some(c => c.id === ladakhOnly)).toBe(false);

    const posts = mineOnly(await db.listPosts({}, guj)).map(p => p.id).sort();
    expect(posts).toEqual([postCGuj, postGuj].sort());
    expect(posts).not.toContain(postLad);
    expect(posts).not.toContain(postCLad);
    // Asking for another state's page by id is the same as asking for one that does not exist.
    expect(await db.listPosts({ pageId: pLad }, guj)).toEqual([]);

    // Two states: the union. No states: nothing — never everything.
    const both = { kind: "states" as const, states: ["Gujarat", "Ladakh"] };
    expect(mineOnly(await db.listPages(both)).map(p => p.id).sort()).toEqual([pGuj, pLad].sort());
    const none = { kind: "states" as const, states: [] };
    expect(await db.listPages(none)).toEqual([]);
    expect(await db.listCampaigns(none)).toEqual([]);
    expect(await db.listPosts({}, none)).toEqual([]);

    // Full access reads exactly what it always did.
    const all = mineOnly(await db.listCampaigns({ kind: "all" }));
    expect(all.find(c => c.id === mixed)!.assigned_page_ids).toEqual([pLad, pGuj]);
    expect(mineOnly(await db.listPages()).length).toBe(mineOnly(await db.listPages({ kind: "all" })).length);
  });

  maybe()("filters posts before the 2000-row cap, so other states cannot crowd them out", async () => {
    const busy = await rawPage("cap-busy", "Ladakh");
    const quiet = await rawPage("cap-quiet", "Gujarat");
    await pool.query(
      `INSERT INTO outreach_posts (id, instagram_id, page_id, date, type, status)
       SELECT $1 || n, $1 || n, $2, DATE '2026-09-01' - (n % 300), 'static', 'published'
         FROM generate_series(1, 2100) AS n`,
      [`${RUN}-post-busy-`, busy]);
    const old = await rawPost("cap-old", { page: quiet }, "2001-01-01");

    const unscoped = (await db.listPosts()).map(p => p.id);
    expect(unscoped).not.toContain(old);   // what the cap does to an unscoped read
    const scoped = (await db.listPosts({}, { kind: "states", states: ["Gujarat"] })).map(p => p.id);
    expect(scoped).toContain(old);
  });

  maybe()("resolves a State User's states fresh from outreach_user_states, and cleans up with the user", async () => {
    const userId = `${RUN}-user`;
    const granter = `${RUN}-granter`;
    for (const [id, role] of [[userId, "outreach_editor"], [granter, "outreach_manager"]]) {
      await pool.query(
        `INSERT INTO users (id, full_name, email, role, team, password_hash) VALUES ($1, $1, $2, $3, 'outreach', 'x')`,
        [id, `${id}@example.test`, role]);
      userIds.push(id);
    }
    const subject = { id: userId, role: "outreach_state_user", team: "outreach" };
    expect(await scopeMod.resolveOutreachScope(subject)).toEqual({ kind: "states", states: [] });

    await pool.query(
      `INSERT INTO outreach_user_states (user_id, state, granted_by) VALUES ($1, 'Ladakh', $2), ($1, 'Gujarat', $2)`,
      [userId, granter]);
    // Read per request: the very next call sees the change.
    expect(await scopeMod.resolveOutreachScope(subject)).toEqual({ kind: "states", states: ["Gujarat", "Ladakh"] });

    // Deleting the manager who granted them must not fail, nor take the grants away.
    await pool.query(`DELETE FROM users WHERE id = $1`, [granter]);
    expect(await db.listUserStates(userId)).toEqual(["Gujarat", "Ladakh"]);
    // Deleting the State User removes their grants with them.
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    expect((await pool.query(`SELECT 1 FROM outreach_user_states WHERE user_id = $1`, [userId])).rowCount).toBe(0);
  });
});
