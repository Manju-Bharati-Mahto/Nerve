// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 3: content submission and review.

   COMPLETION IS NOT APPROVAL. A creator marking a task complete says the work
   is done and ready to look at; the verdict is management's separate act. The
   assignment never moves because of a review, and the review never edits the
   content. Both are asserted below.

   Three things carry the risk and get the attention:

     OWNERSHIP    a submission takes no creator id — the row is written from
                  the session against an assignment proven to be the caller's.
     VERSIONS     V1 is immutable and stays readable; V2 is a new row. The
                  database owns the numbering, so two simultaneous submissions
                  become V2 and V3, never V2 twice.
     VERDICTS     only a version actually awaiting one can receive one, which
                  is what stops two reviewers both deciding, and stops an
                  approved version being re-decided.

   Real handlers, real database. Fixtures are `zcs-` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectTestDatabase } from "./test-db.js";

const PX = "zcs";
let dbUp = false;
let pool: import("pg").Pool;
let api: typeof import("./mediaops-api.js");
let server: Server;
let base = "";
let teamA = 0, teamB = 0;

const A = {
  nerveAdmin:   { id: `${PX}-nadmin`, role: "admin", team: "media",   cr: null },
  mediaEmp:     { id: `${PX}-memp`,   role: "user",  team: "media",   cr: null },
  creatorAdmin: { id: `${PX}-cadmin`, role: "user",  team: "media",   cr: "creator_admin" },
  leadA:        { id: `${PX}-leadA`,  role: "user",  team: "creator", cr: "team_lead" },
  leadB:        { id: `${PX}-leadB`,  role: "user",  team: "creator", cr: "team_lead" },
  c1:           { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  c2:           { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  cB:           { id: `${PX}-cB`,     role: "user",  team: "creator", cr: "creator" },
} as const;
type ActorName = keyof typeof A;

/* The connection comes from server/test-db.ts, which resolves it from
   TEST_DATABASE_URL or .env.test and REFUSES any database whose name does not
   mark it as a test database. This file used to read .env.local itself and
   assign the DEVELOPMENT url over the top of vitest's — seventeen siblings did
   the same — which is how the suite came to run against `nerve`. */
{
  const t = await connectTestDatabase();
  pool = t.pool;
  dbUp = t.dbUp;
}
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZCS ${a.id}` }
      : { id: "", role: "user", team: null };
    next();
  });
  const noLimit = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: noLimit as never,
    otpVerifyLimiter: noLimit as never,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/media`;
}
async function as(actor: ActorName | "anon", method: string, path: string, body?: unknown) {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (actor !== "anon") h["x-actor"] = actor;
  const r = await fetch(base + path, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
}

const URL1 = "https://drive.google.com/file/d/zcs-v1/view";
const URL2 = "https://drive.google.com/file/d/zcs-v2/view";

/** An assignment belonging to `who`, already completed — the state from which
    a submission is allowed. */
async function completedTask(who: ActorName = "c1") {
  const ev = await as("creatorAdmin", "POST", "/creator/events",
    { title: `${PX} Event ${Math.random().toString(36).slice(2, 7)}`, event_date: "2026-11-05" });
  const eventId = Number(ev.body.id);
  const op = await as("creatorAdmin", "POST", "/creator/opportunities",
    { event_id: eventId, title: "Reel Creator", required_count: 3, task_deadline: "2026-11-08" });
  const oppId = Number(op.body.id);
  await as("creatorAdmin", "PATCH", `/creator/events/${eventId}`, { status: "open" });
  await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`, { status: "open" });
  const asg = await as("creatorAdmin", "POST", "/creator/assignments",
    { opportunity_id: oppId, user_id: A[who].id });
  const id = Number(asg.body.id);
  for (const to of ["accepted", "in_progress", "completed"])
    await as(who, "PATCH", `/creator/assignments/${id}`, { status: to });
  return { eventId, oppId, assignmentId: id };
}

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZCS ${a.id}`, `${a.id}@csub.invalid`, a.role, a.team]);
    if (a.team === "media")
      await pool.query(
        `INSERT INTO mo_user_profiles (user_id, designation, mo_role) VALUES ($1,'probe',$2)
         ON CONFLICT (user_id) DO UPDATE SET mo_role=EXCLUDED.mo_role`,
        [a.id, a.role === "admin" ? "admin" : "employee"]);
    if (a.cr)
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status) VALUES ($1,$2,'active')
         ON CONFLICT (user_id) DO UPDATE SET creator_role=EXCLUDED.creator_role, status='active'`,
        [a.id, a.cr]);
  }
  const mk = async (n: string, lead: string) => Number((await pool.query(
    `INSERT INTO mo_creator_teams (name, lead_user_id, is_active) VALUES ($1,$2,true) RETURNING id`,
    [`${PX} ${n}`, lead])).rows[0].id);
  teamA = await mk("Reels Team", A.leadA.id);
  teamB = await mk("Vlog Team", A.leadB.id);
  for (const [t, u] of [[teamA, A.c1.id], [teamA, A.c2.id], [teamA, A.leadA.id],
                        [teamB, A.cB.id], [teamB, A.leadB.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);
}

async function cleanup() {
  /* Phase 6 recognition first: an achievement award is RESTRICT-protected on
     purpose — recognition outlives a suspension or an archive — so a fixture
     has to take its own down before its people and its cycles. */
  await pool.query(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
                      (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_events WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_teams WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_user_profiles WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_notifications WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM users WHERE id LIKE $1`, [`${PX}-%`]);
}

beforeAll(async () => {
  if (!dbUp) return;
  const db = await import("./mediaops-db.js");
  await db.bootstrapCreatorNetwork();
  api = await import("./mediaops-api.js");
  await cleanup(); await seed(); await boot();
});
afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  if (dbUp) await cleanup();
});

/* ── The whole journey, once ─────────────────────────────────────────────── */

maybe("V1 → changes requested → V2 → approved", () => {
  let assignmentId = 0, v1 = 0, v2 = 0;

  it("a completed task can be submitted against", async () => {
    ({ assignmentId } = await completedTask("c1"));
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1, note: "First cut", submission_type: "Reel" });
    expect(r.status).toBe(201);
    expect(r.body.version_no).toBe(1);
    v1 = Number((r.body.submission as Record<string, unknown>).id);
  });

  it("completing did not approve anything — the verdict is still open", async () => {
    const a = (await pool.query(
      `SELECT status FROM mo_creator_assignments WHERE id=$1`, [assignmentId])).rows[0];
    expect(a.status).toBe("completed");          // the task did not move
    const s = (await pool.query(`SELECT status FROM mo_creator_submissions WHERE id=$1`, [v1])).rows[0];
    expect(s.status).toBe("submitted");          // and nothing has been approved
  });

  it("the reviewer is told there is something to look at", async () => {
    const n = await pool.query(
      `SELECT count(*)::int c FROM mo_notifications
        WHERE user_id=$1 AND entity_type='creator_submission' AND entity_id=$2`, [A.creatorAdmin.id, v1]);
    expect(n.rows[0].c).toBe(1);
  });

  it("it reaches the admin's review queue", async () => {
    const r = await as("creatorAdmin", "GET", "/creator/submissions?status=submitted&limit=200");
    const mine = (r.body.submissions as Array<Record<string, unknown>>).find((s) => s.id === v1)!;
    expect(mine.creator_id).toBe(A.c1.id);
    expect((mine.event as Record<string, unknown>).title).toContain(PX);
    expect(r.body.can_review).toBe(true);
  });

  it("requesting changes needs a comment, and records who said what", async () => {
    const bare = await as("creatorAdmin", "POST", `/creator/submissions/${v1}/review`,
      { outcome: "changes_requested" });
    expect(bare.status).toBe(400);
    const r = await as("creatorAdmin", "POST", `/creator/submissions/${v1}/review`,
      { outcome: "changes_requested", comment: "Please replace the opening shot." });
    expect(r.status).toBe(200);
    const row = (await pool.query(`SELECT * FROM mo_creator_submissions WHERE id=$1`, [v1])).rows[0];
    expect(row.status).toBe("changes_requested");
    expect(row.reviewed_by).toBe(A.creatorAdmin.id);
    expect(row.review_comment).toContain("opening shot");
    expect(row.reviewed_at).not.toBeNull();
  });

  it("the creator is told, and can read the comment", async () => {
    /* THE CREATOR'S NOTIFICATION, not whichever notification is newest.

       Opening an opportunity broadcasts to every active creator, so a sibling
       suite doing that puts its own row on top of this one's inbox — the
       assertion then read "War Zone: zrg Reel Battle is open" and failed on a
       notification this file did not cause. Scoping to the review notification
       asks the same question of a population this file owns: the creator was
       told, and the comment came with it. */
    const n = await pool.query(
      `SELECT title, body FROM mo_notifications
        WHERE user_id=$1 AND title ILIKE '%Changes requested%'
        ORDER BY id DESC LIMIT 1`, [A.c1.id]);
    expect(n.rows.length, "the creator was not told at all").toBe(1);
    expect(n.rows[0].title).toContain("Changes requested");
    expect(n.rows[0].body).toContain("opening shot");
  });

  it("resubmitting creates V2 and leaves V1 exactly as it was", async () => {
    const before = (await pool.query(`SELECT * FROM mo_creator_submissions WHERE id=$1`, [v1])).rows[0];
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL2, note: "Reshot the opening" });
    expect(r.status).toBe(201);
    expect(r.body.version_no).toBe(2);
    v2 = Number((r.body.submission as Record<string, unknown>).id);
    const after = (await pool.query(`SELECT * FROM mo_creator_submissions WHERE id=$1`, [v1])).rows[0];
    expect(after).toEqual(before);               // V1 is untouched, not overwritten
  });

  it("approving V2 is final, and the whole history stays readable", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/submissions/${v2}/review`, { outcome: "approved" });
    expect(r.status).toBe(200);
    const hist = await as("c1", "GET", `/creator/assignments/${assignmentId}/submissions`);
    const rows = hist.body.submissions as Array<Record<string, unknown>>;
    expect(rows.map((s) => [s.version_no, s.status]))
      .toEqual([[1, "changes_requested"], [2, "approved"]]);
    expect(rows[0].content_url).toBe(URL1);      // V1 still has its own content
    expect(rows[0].review_comment).toContain("opening shot");
  });

  it("nothing further can be submitted once approved", async () => {
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL2 });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toContain("already been approved");
  });

  it("and an approved version cannot be re-decided", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/submissions/${v2}/review`,
      { outcome: "changes_requested", comment: "Actually, no" });
    expect(r.status).toBe(409);
    const row = (await pool.query(`SELECT status FROM mo_creator_submissions WHERE id=$1`, [v2])).rows[0];
    expect(row.status).toBe("approved");
  });
});

/* ── Eligibility ─────────────────────────────────────────────────────────── */

maybe("what may be submitted against", () => {
  it("an incomplete task cannot be submitted against", async () => {
    const ev = await completedTask("c1");
    // Wind a second assignment back to accepted by making a fresh one.
    const fresh = await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: ev.oppId, user_id: A.c2.id });
    const id = Number(fresh.body.id);
    const r = await as("c2", "POST", `/creator/assignments/${id}/submissions`, { content_url: URL1 });
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("Mark the task complete first");
  });

  it("a cancelled assignment cannot be submitted against", async () => {
    const { assignmentId } = await completedTask("c1");
    await pool.query(`UPDATE mo_creator_assignments SET status='cancelled' WHERE id=$1`, [assignmentId]);
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    expect(r.status).toBe(400);
  });

  it("a rejected submission closes the task to further versions", async () => {
    const { assignmentId } = await completedTask("c1");
    const s = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    await as("creatorAdmin", "POST", `/creator/submissions/${Number((s.body.submission as Record<string, unknown>).id)}/review`,
      { outcome: "rejected", comment: "Not usable — brief not followed." });
    const again = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL2 });
    expect(again.status).toBe(409);
    expect(String(again.body.message)).toContain("rejected");
  });

  it("a second version cannot stack on one still awaiting review", async () => {
    const { assignmentId } = await completedTask("c1");
    expect((await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1 })).status).toBe(201);
    const second = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL2 });
    expect(second.status).toBe(409);
    expect(String(second.body.message)).toContain("awaiting review");
  });

  it("TEST 15 — a suspended creator cannot submit", async () => {
    const { assignmentId } = await completedTask("c2");
    await pool.query(`UPDATE mo_creator_profiles SET status='suspended' WHERE user_id=$1`, [A.c2.id]);
    expect((await as("c2", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1 })).status).toBe(403);
    await pool.query(`UPDATE mo_creator_profiles SET status='archived' WHERE user_id=$1`, [A.c2.id]);
    expect((await as("c2", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1 })).status).toBe(403);
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.c2.id]);
  });
});

/* ── URL validation ──────────────────────────────────────────────────────── */

maybe("the content link", () => {
  it("TEST 23 — rejects every scheme but https", async () => {
    const { assignmentId } = await completedTask("c1");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
                       "file:///etc/passwd", "http://drive.google.com/x", "ftp://host/x",
                       "  ", "not-a-url", "javascript:void(0)"]) {
      const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
        { content_url: bad });
      expect(r.status, `accepted ${bad}`).toBe(400);
    }
  });

  it("accepts the links creators actually use", async () => {
    for (const [who, url] of [["c1", "https://drive.google.com/file/d/abc/view"],
                              ["c2", "https://www.instagram.com/reel/abc/"]] as const) {
      const { assignmentId } = await completedTask(who);
      expect((await as(who, "POST", `/creator/assignments/${assignmentId}/submissions`,
        { content_url: url })).status, url).toBe(201);
    }
  });

  it("TEST 24 — an injection attempt is stored as data, not executed", async () => {
    const { assignmentId } = await completedTask("c1");
    const evil = "https://example.com/x?q=%27%29%3B%20DROP%20TABLE%20mo_creator_submissions%3B--";
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: evil, note: "'); DROP TABLE mo_creator_submissions;--" });
    expect(r.status).toBe(201);
    // The table is still there, and the text round-tripped verbatim.
    const row = (await pool.query(
      `SELECT note FROM mo_creator_submissions WHERE assignment_id=$1`, [assignmentId])).rows[0];
    expect(row.note).toBe("'); DROP TABLE mo_creator_submissions;--");
  });
});

/* ── Versions and concurrency ────────────────────────────────────────────── */

maybe("TEST 21/22 — versioning is the database's job", () => {
  it("numbers are generated server-side and a client cannot choose one", async () => {
    const { assignmentId } = await completedTask("c1");
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1, version_no: 99, id: 12345 });
    expect(r.body.version_no).toBe(1);
  });

  it("concurrent submissions never produce two V2s", async () => {
    /* Four requests at once against a task whose V1 was sent back. Exactly one
       may open the next review; the rest must be refused, and the version
       numbers that exist must be unique. */
    const { assignmentId } = await completedTask("c1");
    const first = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    await as("creatorAdmin", "POST",
      `/creator/submissions/${Number((first.body.submission as Record<string, unknown>).id)}/review`,
      { outcome: "changes_requested", comment: "Please revise the cut." });

    const all = await Promise.all([1, 2, 3, 4].map(() =>
      as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL2 })));
    expect(all.filter((r) => r.status === 201)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409)).toHaveLength(3);

    const rows = await pool.query(
      `SELECT version_no FROM mo_creator_submissions WHERE assignment_id=$1 ORDER BY version_no`, [assignmentId]);
    const nums = rows.rows.map((r) => Number(r.version_no));
    expect(nums).toEqual([1, 2]);
    expect(new Set(nums).size).toBe(nums.length);      // no duplicates, by construction
  });

  it("a retried request after success does not open a second review", async () => {
    const { assignmentId } = await completedTask("c2");
    const a = await as("c2", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    const b = await as("c2", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(409);
    const n = await pool.query(
      `SELECT count(*)::int c FROM mo_creator_submissions WHERE assignment_id=$1`, [assignmentId]);
    expect(n.rows[0].c).toBe(1);
  });
});

/* ── Security ────────────────────────────────────────────────────────────── */

maybe("the client is never trusted", () => {
  it("TEST 1/2 — anonymous and non-network callers are denied", async () => {
    expect((await as("anon", "GET", "/creator/submissions")).status).toBe(403);
    expect((await as("mediaEmp", "GET", "/creator/submissions")).status).toBe(403);
  });

  it("TEST 4/5 — a creator cannot submit to somebody else's assignment", async () => {
    const { assignmentId } = await completedTask("c1");
    const r = await as("c2", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    expect(r.status).toBe(404);          // not theirs ⇒ indistinguishable from absent
  });

  it("TEST 6/7 — a forged creator_id or team_id changes nothing", async () => {
    const { assignmentId } = await completedTask("c1");
    const r = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1, creator_id: A.c2.id, user_id: A.c2.id, team_id: teamB });
    expect(r.status).toBe(201);
    const row = (await pool.query(
      `SELECT submitted_by FROM mo_creator_submissions WHERE assignment_id=$1`, [assignmentId])).rows[0];
    expect(row.submitted_by).toBe(A.c1.id);
  });

  it("TEST 3 — a creator cannot read another creator's submission history", async () => {
    const { assignmentId } = await completedTask("c1");
    await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    expect((await as("c2", "GET", `/creator/assignments/${assignmentId}/submissions`)).status).toBe(404);
    expect((await as("c1", "GET", `/creator/assignments/${assignmentId}/submissions`)).status).toBe(200);
  });

  it("TEST 8/9/10 — a creator cannot pass any verdict, least of all on themselves", async () => {
    const { assignmentId } = await completedTask("c1");
    const s = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    const id = Number((s.body.submission as Record<string, unknown>).id);
    for (const outcome of ["approved", "changes_requested", "rejected"]) {
      const r = await as("c1", "POST", `/creator/submissions/${id}/review`, { outcome, comment: "ok fine" });
      expect(r.status, outcome).toBe(403);
    }
    const row = (await pool.query(`SELECT status FROM mo_creator_submissions WHERE id=$1`, [id])).rows[0];
    expect(row.status).toBe("submitted");
  });

  it("BR-5 — not even a Creator Admin may review their own submission", async () => {
    /* The Creator Admin here is also enrolled, so they can be assigned work.
       Reviewing it themselves is the conflict BR-5 already forbids elsewhere. */
    await pool.query(
      `INSERT INTO mo_creator_team_members (team_id, user_id, is_primary) VALUES ($1,$2,true)
       ON CONFLICT DO NOTHING`, [teamA, A.creatorAdmin.id]);
    const { assignmentId } = await completedTask("creatorAdmin" as ActorName);
    const s = await as("creatorAdmin", "POST", `/creator/assignments/${assignmentId}/submissions`,
      { content_url: URL1 });
    const id = Number((s.body.submission as Record<string, unknown>).id);
    const r = await as("creatorAdmin", "POST", `/creator/submissions/${id}/review`, { outcome: "approved" });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain("cannot be reviewed by the person who submitted");
  });

  it("TEST 17/18 — a Team Lead sees their team's work and not another's", async () => {
    const mine = await completedTask("c1");            // team A
    const theirs = await completedTask("cB");          // team B
    await as("c1", "POST", `/creator/assignments/${mine.assignmentId}/submissions`, { content_url: URL1 });
    await as("cB", "POST", `/creator/assignments/${theirs.assignmentId}/submissions`, { content_url: URL1 });

    const seen = await as("leadA", "GET", "/creator/submissions?limit=200");
    const ids = (seen.body.submissions as Array<{ creator_id: string }>).map((s) => s.creator_id);
    expect(ids).toContain(A.c1.id);
    expect(ids).not.toContain(A.cB.id);
    // And a forged team id cannot widen it.
    const forged = await as("leadA", "GET", `/creator/submissions?team_id=${teamB}&limit=200`);
    expect((forged.body.submissions as unknown[])).toHaveLength(0);
    expect((await as("leadA", "GET", `/creator/assignments/${theirs.assignmentId}/submissions`)).status).toBe(404);
  });

  it("a Team Lead cannot pass a verdict — Phase 2's rule is unchanged", async () => {
    const { assignmentId } = await completedTask("c1");
    const s = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    const id = Number((s.body.submission as Record<string, unknown>).id);
    const r = await as("leadA", "POST", `/creator/submissions/${id}/review`,
      { outcome: "approved", comment: "looks good" });
    expect(r.status).toBe(403);
    expect(String(r.body.message)).toContain("Only a Creator Admin");
  });

  it("TEST 20 — a Nerve Admin may review, and is still not a creator_admin", async () => {
    const { assignmentId } = await completedTask("c1");
    const s = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    const id = Number((s.body.submission as Record<string, unknown>).id);
    expect((await as("nerveAdmin", "POST", `/creator/submissions/${id}/review`,
      { outcome: "approved" })).status).toBe(200);
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });

  it("two reviewers acting at once: one verdict wins, the other is told", async () => {
    const { assignmentId } = await completedTask("c1");
    const s = await as("c1", "POST", `/creator/assignments/${assignmentId}/submissions`, { content_url: URL1 });
    const id = Number((s.body.submission as Record<string, unknown>).id);
    const both = await Promise.all([
      as("creatorAdmin", "POST", `/creator/submissions/${id}/review`, { outcome: "approved" }),
      as("nerveAdmin", "POST", `/creator/submissions/${id}/review`,
        { outcome: "rejected", comment: "No good" }),
    ]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    expect(both.filter((r) => r.status === 409)).toHaveLength(1);
  });
});

/* ── Audit — including the Phase 2 regression that must not come back ────── */

maybe("the trail", () => {
  it("records the submission and review actions", async () => {
    const { rows } = await pool.query(
      `SELECT DISTINCT action FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
    const seen = rows.map((r) => r.action);
    for (const a of ["creator_submission.submitted", "creator_submission.changes_requested",
                     "creator_submission.approved", "creator_submission.rejected"])
      expect(seen, `missing audit action ${a}`).toContain(a);
  });

  it("REGRESSION — a creator's own actions really do reach the trail", async () => {
    /* Phase 2 found that audit() wrote the raw platform role, which the CHECK
       rejected, silently losing every creator-originated row. Submission is a
       creator action, so this is the direct test that the fix holds. */
    const rows = await pool.query(
      `SELECT actor_role FROM mo_audit_logs
        WHERE actor_id=$1 AND action='creator_submission.submitted' LIMIT 1`, [A.c1.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].actor_role).toBe("creator");
  });

  it("stores no secret in the trail", async () => {
    const { rows } = await pool.query(
      `SELECT before::text b, after::text a FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]);
    for (const r of rows)
      for (const bad of ["password", "token", "secret", "password_hash"])
        expect(`${r.b} ${r.a}`.toLowerCase(), `audit leaked ${bad}`).not.toContain(bad);
  });
});

/* ── Regression ──────────────────────────────────────────────────────────── */

maybe("nothing else moved", () => {
  it("submissions never touch the Media Ops tables", async () => {
    const d = await pool.query(
      `SELECT count(*)::int c FROM mo_deliverable_versions WHERE drive_url LIKE $1`, ["%zcs-%"]);
    expect(d.rows[0].c).toBe(0);
    const p = await pool.query(`SELECT count(*)::int c FROM mo_projects WHERE name LIKE $1`, [`${PX}%`]);
    expect(p.rows[0].c).toBe(0);
  });

  it("Media Ops still refuses creators and serves staff", async () => {
    expect((await as("c1", "GET", "/state")).status).toBe(403);
    expect((await as("nerveAdmin", "GET", "/state")).status).toBe(200);
  });

  it("the creator shell payload still carries no Media Ops data", async () => {
    const r = await as("c1", "GET", "/creator/state");
    for (const k of ["projects", "deliverables", "users", "shoots", "equipment_items"])
      expect(Object.keys(r.body), `leaked ${k}`).not.toContain(k);
  });
});
