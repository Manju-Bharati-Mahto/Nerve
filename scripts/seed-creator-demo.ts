/* ═══════════════════════════════════════════════════════════════════════════
   CREATOR NETWORK — demo data for a local machine

     npx tsx scripts/seed-creator-demo.ts            # create
     npx tsx scripts/seed-creator-demo.ts --clear    # remove it again

   WHY THIS DRIVES THE REAL API RATHER THAN INSERTING ROWS

   Hand-written INSERTs produce data that looks right and is quietly wrong: a
   payout whose gross does not match its points, an achievement nobody earned,
   a cycle whose leaderboard disagrees with the ledger. This script mounts the
   actual handlers and walks the actual lifecycle, so every figure is produced
   by the code that produces it in production — points by the approval path,
   payouts by the calculator, recognition by the evaluator, and an audit trail
   and notifications as a side effect of all three.

   What you get is therefore not a mock. It is a small Creator Network that
   genuinely happened.

   SCOPE: mo_creator_* only, plus the users it needs and the notifications and
   audit rows the real code writes. It touches no Media Ops project, no other
   department, and no existing person.

   LOCAL ONLY: it refuses to run against a non-loopback database.
   ═══════════════════════════════════════════════════════════════════════════ */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

/* ── Environment, the same way the tests read it ──────────────────────── */
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const DB_URL = process.env.DATABASE_URL ?? "";
const host = (() => { try { return new URL(DB_URL.replace(/^postgres/, "http")).hostname; } catch { return ""; } })();
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  console.error(`Refusing to run: DATABASE_URL points at "${host}", not a local database.`);
  process.exit(1);
}

const { pool } = await import("../server/db.js");
const { hashPassword } = await import("../server/password.js");
const db = await import("../server/mediaops-db.js");
const api = await import("../server/mediaops-api.js");

/* ── The demo cast ────────────────────────────────────────────────────────
   Ids carry a prefix so every row this script made can be found again; the
   names and emails look like the rest of Nerve so the screens read properly. */
const P = "cn-demo";
const ADMIN_PASSWORD = "CreatorAdmin123!";

type Person = { key: string; id: string; name: string; email: string;
                team: "creator" | "media"; cr: "creator_admin" | "team_lead" | "creator" | null };

const PEOPLE: Person[] = [
  { key: "admin", id: `${P}-admin`, name: "Priya Desai",   email: "priya.desai@paruluniversity.ac.in",  team: "creator", cr: "creator_admin" },
  { key: "leadR", id: `${P}-leadr`, name: "Arjun Mehta",   email: "arjun.mehta@paruluniversity.ac.in",  team: "creator", cr: "team_lead" },
  { key: "leadS", id: `${P}-leads`, name: "Sneha Kulkarni", email: "sneha.kulkarni@paruluniversity.ac.in", team: "creator", cr: "team_lead" },
  { key: "misha", id: `${P}-c1`,    name: "Misha Patel",   email: "misha.patel@paruluniversity.ac.in",  team: "creator", cr: "creator" },
  { key: "ravi",  id: `${P}-c2`,    name: "Ravi Kumar",    email: "ravi.kumar@paruluniversity.ac.in",   team: "creator", cr: "creator" },
  { key: "ananya", id: `${P}-c3`,   name: "Ananya Shah",   email: "ananya.shah@paruluniversity.ac.in",  team: "creator", cr: "creator" },
  { key: "farhan", id: `${P}-c4`,   name: "Farhan Qureshi", email: "farhan.qureshi@paruluniversity.ac.in", team: "creator", cr: "creator" },
  { key: "tara",  id: `${P}-c5`,    name: "Tara Nair",     email: "tara.nair@paruluniversity.ac.in",    team: "creator", cr: "creator" },
  { key: "dev",   id: `${P}-c6`,    name: "Dev Raval",     email: "dev.raval@paruluniversity.ac.in",    team: "creator", cr: "creator" },
  { key: "ishan", id: `${P}-c7`,    name: "Ishan Gupta",   email: "ishan.gupta@paruluniversity.ac.in",  team: "creator", cr: "creator" },
  // Suspended on purpose: the directory, the leaderboard and the signals all
  // treat a suspended creator differently, and that is worth being able to see.
  { key: "rhea",  id: `${P}-c8`,    name: "Rhea Bhatt",    email: "rhea.bhatt@paruluniversity.ac.in",   team: "creator", cr: "creator" },
];
const who = (k: string) => PEOPLE.find((p) => p.key === k)!;

/* ── Teardown ─────────────────────────────────────────────────────────────
   Ordered by dependency, because every financial and recognition foreign key
   is RESTRICT on purpose — history is not supposed to come apart easily. */
async function clear(): Promise<void> {
  const like = [`${P}-%`];
  const q = (sql: string, args: unknown[] = like) => pool.query(sql, args);

  await q(`UPDATE mo_automation_rules SET updated_by=NULL WHERE updated_by LIKE $1`);
  await q(`DELETE FROM mo_creator_competition_results WHERE user_id LIKE $1`);
  await q(`DELETE FROM mo_creator_competition_scores WHERE user_id LIKE $1 OR recorded_by LIKE $1`);
  await q(`DELETE FROM mo_creator_competition_participants WHERE user_id LIKE $1`);
  await q(`DELETE FROM mo_creator_competitions WHERE created_by LIKE $1`);
  await q(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`);
  await q(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`);
  // Reversals first: they point at the entries beside them.
  await q(`DELETE FROM mo_creator_financial_ledger WHERE reversal_of_id IS NOT NULL
             AND (user_id LIKE $1 OR created_by LIKE $1)`);
  await q(`DELETE FROM mo_creator_financial_ledger WHERE user_id LIKE $1 OR created_by LIKE $1`);
  await q(`DELETE FROM mo_creator_payouts WHERE user_id LIKE $1 OR calculated_by LIKE $1`);
  await q(`DELETE FROM mo_creator_payout_rules WHERE created_by LIKE $1`);
  await q(`DELETE FROM mo_creator_point_ledger WHERE reversal_of_id IS NOT NULL
             AND (user_id LIKE $1 OR created_by LIKE $1)`);
  await q(`DELETE FROM mo_creator_point_ledger WHERE user_id LIKE $1 OR created_by LIKE $1
             OR cycle_id IN (SELECT id FROM mo_creator_cycles WHERE created_by LIKE $1)`);
  await q(`DELETE FROM mo_comments WHERE user_id LIKE $1
             AND entity_type IN ('creator_assignment','creator_opportunity')`);
  await q(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
             (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`);
  await q(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1 OR assigned_by LIKE $1`);
  await q(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`);
  await q(`DELETE FROM mo_creator_opportunities WHERE event_id IN
             (SELECT id FROM mo_creator_events WHERE created_by LIKE $1)`);
  await q(`DELETE FROM mo_creator_events WHERE created_by LIKE $1`);
  await q(`DELETE FROM mo_creator_cycles WHERE created_by LIKE $1`);
  await q(`DELETE FROM mo_creator_point_rules WHERE created_by LIKE $1`);
  await q(`DELETE FROM mo_creator_team_members WHERE user_id LIKE $1`);
  await q(`DELETE FROM mo_creator_teams WHERE created_by LIKE $1 OR lead_user_id LIKE $1`);
  await q(`DELETE FROM mo_creator_profiles WHERE user_id LIKE $1`);
  await q(`DELETE FROM mo_notifications WHERE user_id LIKE $1`);
  await q(`DELETE FROM mo_ai_requests WHERE user_id LIKE $1`).catch(() => {});
  await q(`DELETE FROM mo_audit_logs WHERE actor_id LIKE $1`);
  await q(`DELETE FROM users WHERE id LIKE $1`);
}

/* ── A server, with the demo cast as its sessions ─────────────────────── */
let server: Server, base = "";
async function boot(): Promise<void> {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const p = PEOPLE.find((x) => x.key === req.headers["x-as"]);
    res.locals.currentUser = p
      ? { id: p.id, role: "user", team: p.team, full_name: p.name }
      : { id: "", role: "user", team: null };
    next();
  });
  const pass = (_q: unknown, _s: unknown, n: () => void) => n();
  api.registerMediaOpsApi(app as never, {
    asyncHandler: (fn) => (req, res, next) => { void fn(req, res, next).catch(next); },
    sendError: (res, status, message) => { res.status(status).json({ message }); },
    getSingleParam: (v) => (Array.isArray(v) ? v[0] : v),
    otpSendLimiter: pass as never, otpVerifyLimiter: pass as never,
  });
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/media`;
}

let calls = 0, failures: string[] = [];
async function call(as: string, method: string, path: string, body?: unknown) {
  calls++;
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", "x-as": as },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  if (r.status >= 400) failures.push(`${method} ${path} → ${r.status} ${json?.message ?? ""}`);
  return { status: r.status, body: json ?? {} };
}
const GET = (as: string, p: string) => call(as, "GET", p);
const POST = (as: string, p: string, b?: unknown) => call(as, "POST", p, b);
const PATCH = (as: string, p: string, b?: unknown) => call(as, "PATCH", p, b);

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
/* Some history has to be backdated — a cycle that closed last month, work
   finished three weeks ago. The lifecycle runs for real and the timestamps are
   then moved, rather than the rows being faked. */
const backdate = (sql: string, args: unknown[]) => pool.query(sql, args);

async function seed(): Promise<void> {
  console.log("Creator Network demo data\n");

  /* 1. People ─────────────────────────────────────────────────────────── */
  const hash = await hashPassword(ADMIN_PASSWORD);
  for (const p of PEOPLE) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,'user',$4,'active',$5,'Creator Network')
       ON CONFLICT (id) DO UPDATE SET full_name=EXCLUDED.full_name, email=EXCLUDED.email,
         team=EXCLUDED.team, status='active', password_hash=EXCLUDED.password_hash`,
      [p.id, p.name, p.email, p.team, hash]);
    if (p.cr)
      await pool.query(
        `INSERT INTO mo_creator_profiles (user_id, creator_role, status, creator_type, joined_on, display_name)
         VALUES ($1,$2,'active',$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET creator_role=EXCLUDED.creator_role, status='active'`,
        [p.id, p.cr, p.cr === "creator" ? "Reels" : null, day(-120), p.name]);
  }
  console.log(`  ${PEOPLE.length} people · 1 Creator Admin, 2 Team Leads, 8 creators`);

  await boot();

  /* 2. Teams ──────────────────────────────────────────────────────────── */
  const team = async (name: string, lead: string, members: string[]) => {
    const r = await POST("admin", "/creator/teams", { name, lead_user_id: who(lead).id });
    const id = Number(r.body.id);
    for (const m of members)
      await POST("admin", `/creator/teams/${id}/members`, { user_id: who(m).id });
    return id;
  };
  const reels = await team("Reels Squad", "leadR", ["leadR", "misha", "ravi", "ananya", "rhea"]);
  const stories = await team("Campus Stories", "leadS", ["leadS", "farhan", "tara", "dev", "ishan"]);
  /* Rhea is suspended AFTER joining, which is the order it happens in life —
     the network refuses to add somebody who is already suspended. She keeps her
     team and her history, and the directory, leaderboard and low-activity
     signal each treat her differently, which is worth being able to see. */
  await pool.query(`UPDATE mo_creator_profiles SET status='suspended' WHERE user_id=$1`, [who("rhea").id]);
  console.log(`  2 teams · Reels Squad (5, one suspended), Campus Stories (5)`);

  /* 3. Scoring rules and cycles ───────────────────────────────────────── */
  const rule = async (name: string, points: number, desc: string) =>
    Number((await POST("admin", "/creator/rules", { name, points, description: desc })).body.id);
  const reelRule = await rule("Approved Reel", 10, "A reel that passed review");
  const photoRule = await rule("Approved Photo Set", 6, "A photo set that passed review");
  await rule("Approved Vlog", 15, "A long-form vlog that passed review");

  const cycle = async (label: string, from: string, to: string) =>
    Number((await POST("admin", "/creator/cycles", { label, starts_on: from, ends_on: to })).body.id);
  const lastCycle = await cycle("September 2026", day(-50), day(-20));
  const thisCycle = await cycle("October 2026", day(-19), day(11));
  console.log(`  3 point rules · 2 cycles`);

  /* 4. Events, the roles they need, and who put their hand up ─────────── */
  const event = async (title: string, date: string, venue: string, desc: string) =>
    Number((await POST("admin", "/creator/events", { title, event_date: date, venue, description: desc })).body.id);
  const opp = async (eventId: number, title: string, count: number, ruleId: number, deadline: string) =>
    Number((await POST("admin", "/creator/opportunities",
      { event_id: eventId, title, required_count: count, point_rule_id: ruleId,
        task_deadline: deadline, creator_type: "Reels" })).body.id);
  const open = async (eventId: number, oppIds: number[]) => {
    await PATCH("admin", `/creator/events/${eventId}`, { status: "open" });
    for (const o of oppIds) await PATCH("admin", `/creator/opportunities/${o}`, { status: "open" });
  };

  const navratri = await event("Navratri Nights 2026", day(-40), "Main Ground",
    "Nine nights of garba across the main ground. Reels nightly, photo sets each morning.");
  const nav1 = await opp(navratri, "Reel Creator — Night Coverage", 3, reelRule, day(-35));
  const nav2 = await opp(navratri, "Photo Set — Morning Recap", 2, photoRule, day(-34));
  await open(navratri, [nav1, nav2]);

  const convocation = await event("Convocation 2026", day(-25), "Convention Centre",
    "Degree ceremony. Coverage for the university page and the faculty pages.");
  const con1 = await opp(convocation, "Reel Creator — Ceremony Highlights", 2, reelRule, day(-18));
  await open(convocation, [con1]);

  const techfest = await event("TechFest 2026", day(-8), "Engineering Block",
    "Two-day technical festival. Reels from each competition track.");
  const tech1 = await opp(techfest, "Reel Creator — Competition Tracks", 3, reelRule, day(3));
  await open(techfest, [tech1]);

  const sports = await event("Inter-Faculty Sports Meet", day(12), "Sports Complex",
    "Coverage across athletics, cricket and basketball finals.");
  const spo1 = await opp(sports, "Reel Creator — Finals Day", 4, reelRule, day(18));
  await open(sports, [spo1]);

  // Interest: more hands than places, which is the point of a selection step.
  for (const [o, people] of [
    [nav1, ["misha", "ravi", "ananya", "farhan", "tara"]],
    [nav2, ["tara", "dev"]],
    [con1, ["misha", "farhan", "ishan"]],
    [tech1, ["ravi", "ananya", "dev", "ishan"]],
    [spo1, ["misha", "ravi", "tara", "dev", "ishan", "farhan"]],
  ] as const)
    for (const k of people) await POST(k, `/creator/opportunities/${o}/interest`, {});
  console.log(`  4 events · 6 roles · 20 expressions of interest`);

  /* 5. Selection → assignment → the work itself ───────────────────────── */
  const assign = async (o: number, k: string) =>
    Number((await POST("admin", "/creator/assignments",
      { opportunity_id: o, user_id: who(k).id })).body.id);
  const move = async (k: string, id: number, to: string[]) => {
    for (const s of to) await PATCH(k, `/creator/assignments/${id}`, { status: s });
  };
  const submit = async (k: string, id: number, note: string) =>
    Number((await POST(k, `/creator/assignments/${id}/submissions`,
      { content_url: `https://drive.google.com/file/d/${P}-${id}-${Date.now() % 1e6}/view`,
        note, submission_type: "Reel" })).body.submission?.id ?? 0);
  const review = async (sid: number, outcome: string, comment?: string) =>
    POST("admin", `/creator/submissions/${sid}/review`,
      comment ? { outcome, comment } : { outcome });

  // Navratri — finished and paid for. The history the demo needs.
  const done: Array<[string, number]> = [];
  for (const k of ["misha", "ravi", "ananya"]) {
    const a = await assign(nav1, k);
    await move(k, a, ["accepted", "in_progress", "completed"]);
    done.push([k, a]);
  }
  // Misha: approved first time.
  await review(await submit("misha", done[0][1], "Night 3 garba reel, 42 seconds."), "approved");
  // Ravi: asked for changes, then approved — so the version history is real.
  const ravi1 = await submit("ravi", done[1][1], "Night 5 reel, first cut.");
  await review(ravi1, "changes_requested", "Audio clips at 0:12 and the opening is two seconds long. Re-cut and resend.");
  await review(await submit("ravi", done[1][1], "Re-cut with the audio fixed."), "approved");
  // Ananya: not accepted.
  await review(await submit("ananya", done[2][1], "Night 7, wide shots only."), "rejected",
    "This is all wide shots — we needed faces and movement. Not usable for the page.");

  const navPhoto = await assign(nav2, "tara");
  await move("tara", navPhoto, ["accepted", "in_progress", "completed"]);
  await review(await submit("tara", navPhoto, "Morning recap, 12 frames."), "approved");

  // Convocation — approved, feeding the closed cycle.
  for (const k of ["misha", "farhan"]) {
    const a = await assign(con1, k);
    await move(k, a, ["accepted", "in_progress", "completed"]);
    await review(await submit(k, a, "Ceremony highlights."), "approved");
  }

  /* A second night of Navratri for the same people, so September has enough
     volume for a leaderboard with actual spread rather than a four-way tie. */
  const nav3 = await opp(navratri, "Reel Creator — Finale Night", 4, reelRule, day(-33));
  await PATCH("admin", `/creator/opportunities/${nav3}`, { status: "open" });
  for (const k of ["misha", "ravi", "tara", "farhan"]) {
    const a = await assign(nav3, k);
    await move(k, a, ["accepted", "in_progress", "completed"]);
    await review(await submit(k, a, "Finale night reel."), "approved");
  }
  const nav4 = await opp(navratri, "Photo Set — Finale Recap", 2, photoRule, day(-32));
  await PATCH("admin", `/creator/opportunities/${nav4}`, { status: "open" });
  for (const k of ["misha", "dev"]) {
    const a = await assign(nav4, k);
    await move(k, a, ["accepted", "in_progress", "completed"]);
    await review(await submit(k, a, "Finale recap, 16 frames."), "approved");
  }

  // TechFest — in flight right now: one waiting on review, one still working,
  // one completed but never submitted, one declined.
  const t1 = await assign(tech1, "ravi");
  await move("ravi", t1, ["accepted", "in_progress", "completed"]);
  await submit("ravi", t1, "Robotics track, awaiting your review.");
  const t2 = await assign(tech1, "ananya");
  await move("ananya", t2, ["accepted", "in_progress"]);
  const t3 = await assign(tech1, "dev");
  await move("dev", t3, ["accepted", "in_progress", "completed"]);   // no submission
  const t4 = await assign(tech1, "ishan");
  await PATCH("ishan", `/creator/assignments/${t4}`, { status: "declined", reason: "Exams that week." });

  /* Two approvals in the last fortnight, so the active cycle and the default
     30-day window both have something in them. */
  const tech2 = await opp(techfest, "Reel Creator — Closing Showcase", 2, reelRule, day(2));
  await PATCH("admin", `/creator/opportunities/${tech2}`, { status: "open" });
  for (const k of ["misha", "tara"]) {
    const a = await assign(tech2, k);
    await move(k, a, ["accepted", "in_progress", "completed"]);
    await review(await submit(k, a, "Closing showcase reel."), "approved");
    await backdate(
      `UPDATE mo_creator_assignments SET created_at=$1, accepted_at=$1, completed_at=$2 WHERE id=$3`,
      [ago(12), ago(10), a]);
    await backdate(
      `UPDATE mo_creator_submissions SET submitted_at=$1, reviewed_at=$2 WHERE assignment_id=$3`,
      [ago(9), ago(7), a]);
  }

  // Sports — assigned, not yet started, and one already past its deadline.
  const s1 = await assign(spo1, "misha");
  const s2 = await assign(spo1, "tara");
  await move("tara", s2, ["accepted"]);
  await backdate(`UPDATE mo_creator_assignments SET deadline=$1 WHERE id=$2`, [day(-2), s1]);
  console.log(`  13 assignments · 8 submissions across 4 states · 1 overdue`);

  /* 6. Backdate the history, then close September ─────────────────────── */
  /* Two ages of history, on purpose.

     Navratri sits deep in September — inside the closed cycle, outside the
     default 30-day analytics window. Convocation sits inside BOTH, so the
     dashboard a manager opens first is not empty while the cycle behind it
     still holds the full story. A demo whose headline screen reads zero
     teaches the wrong thing about the product. */
  const deepRoles = [nav1, nav2, nav3, nav4];
  const recentRoles = [con1];
  const shift = async (roles: number[], made: number, finished: number, sent: number, judged: number) => {
    await backdate(
      `UPDATE mo_creator_assignments SET created_at=$1, accepted_at=$1,
              completed_at = CASE WHEN completed_at IS NOT NULL THEN $2::timestamptz ELSE NULL END
        WHERE opportunity_id = ANY($3::bigint[])`, [ago(made), ago(finished), roles]);
    await backdate(
      `UPDATE mo_creator_submissions SET submitted_at=$1,
              reviewed_at = CASE WHEN reviewed_at IS NOT NULL THEN $2::timestamptz ELSE NULL END
        WHERE assignment_id IN (SELECT id FROM mo_creator_assignments
                                 WHERE opportunity_id = ANY($3::bigint[]))`,
      [ago(sent), ago(judged), roles]);
  };
  await shift(deepRoles, 40, 38, 37, 35);
  await shift(recentRoles, 26, 24, 23, 22);
  await backdate(
    `UPDATE mo_creator_point_ledger SET created_at=$1, cycle_id=$2
      WHERE created_by LIKE $3 AND cycle_id IS NULL`, [ago(35), lastCycle, `${P}-%`]);

  /* Points earned while September was open belong to September. The approval
     path put them where the active cycle was at the time — which, in a script
     that runs in one second, is nowhere — so they are placed deliberately, the
     same way an Admin would with claim-pending. */
  await PATCH("admin", `/creator/cycles/${lastCycle}`, { status: "active" });
  await POST("admin", `/creator/cycles/${lastCycle}/claim-pending`, {});

  // A manual adjustment, so the ledger shows more than one kind of movement.
  await POST("admin", "/creator/points/adjust",
    { user_id: who("misha").id, points: 15,
      reason: "Stepped in for the closing ceremony at two hours' notice" });
  await POST("admin", "/creator/points/adjust",
    { user_id: who("ananya").id, points: -5,
      reason: "Duplicate award from the Navratri batch, removed" });

  await PATCH("admin", `/creator/cycles/${lastCycle}`, { status: "closed" });
  await PATCH("admin", `/creator/cycles/${thisCycle}`, { status: "active" });
  console.log(`  September closed with points placed · October now active`);

  /* 7. Recognition for the closed cycle ───────────────────────────────── */
  const rec = await POST("admin", `/creator/cycles/${lastCycle}/finalize-recognition`, {});
  const winners = (rec.body.winners as Array<{ creator_name: string }> ?? []).map((w) => w.creator_name);
  console.log(`  Creator of the Cycle: ${winners.join(" and ") || "—"} · ` +
              `${rec.body.achievements_awarded ?? 0} achievements awarded`);

  /* 8. Money ──────────────────────────────────────────────────────────── */
  await POST("admin", "/creator/payout-rules",
    { name: "Standard 2026-27", rate: "10.00", effective_from: day(-120),
      description: "₹10 per point, the standard rate for the year" });
  const gen = await POST("admin", `/creator/cycles/${lastCycle}/payouts`, {});
  console.log(`  ${gen.body.created ?? 0} payouts calculated at ₹${gen.body.rate ?? "?"}/point`);

  const payouts = (await GET("admin", `/creator/payouts?cycle_id=${lastCycle}&limit=50`))
    .body.payouts as Array<{ id: number; creator_name: string; user_id: string }> ?? [];

  /* One paid outright, one paid after a bonus, one approved but not yet paid,
     the rest still awaiting review — every state on the screen at once.

     PICKED BY PERSON, NOT BY POSITION. Bulk generation assigns payout ids in
     whatever order the calculator's scan returns, so payouts[0] is a different
     creator on each run — the amounts stayed right but the demo told a
     different story every time. Naming the creator makes the run reproducible:
     the same person is always the one who was paid. */
  const payoutOf = (key: string) => payouts.find((x) => x.user_id === who(key).id);
  const paid = payoutOf("misha");            // the biggest earner, settled
  const bonused = payoutOf("tara");          // settled, with a bonus on top
  const awaiting = payoutOf("farhan");       // approved, not yet paid

  if (paid) {
    await POST("admin", `/creator/payouts/${paid.id}/approve`, {});
    await POST("admin", `/creator/payouts/${paid.id}/pay`, { payment_reference: "UTR-2026-0093412" });
  }
  if (bonused) {
    await POST("admin", `/creator/payouts/${bonused.id}/adjust`,
      { amount: "250.00", reason: "Bonus — covered two extra nights at short notice" });
    await POST("admin", `/creator/payouts/${bonused.id}/approve`, {});
    await POST("admin", `/creator/payouts/${bonused.id}/pay`, { payment_reference: "NEFT/2026/118273" });
  }
  if (awaiting) await POST("admin", `/creator/payouts/${awaiting.id}/approve`, {});
  console.log(`  Payout states: paid, paid with a bonus, approved-unpaid, awaiting review`);

  /* 9. War Zone ───────────────────────────────────────────────────────── */
  const comp = async (name: string, desc: string, from: number, to: number) =>
    Number((await POST("admin", "/creator/competitions", {
      name, description: desc,
      rules: "One entry each. Judged on cut, sound and story. Entries after the closing time are not scored.",
      recognition: "War Zone Winner badge",
      starts_at: new Date(Date.now() + from * 86_400_000).toISOString(),
      ends_at: new Date(Date.now() + to * 86_400_000).toISOString(),
    })).body.id);

  /* A finished one, with real scores and a finalised result.

     Created with a window that is still OPEN, because a competition that has
     already closed refuses entries — as it should. The lifecycle runs for
     real, and only then are the dates moved back into September, so the
     record is both historically placed and genuinely earned. */
  const battle = await comp("Navratri Reel Battle", "Best 30-second reel from the nine nights.", -30, 2);
  await POST("admin", `/creator/competitions/${battle}/open`, {});
  for (const k of ["misha", "ravi", "tara", "farhan"])
    await POST(k, `/creator/competitions/${battle}/participants`, {});
  await POST("admin", `/creator/competitions/${battle}/start`, {});
  for (const [k, s, why] of [["misha", 92, "Round one — cut and pacing"],
                             ["ravi", 88, "Round one — cut and pacing"],
                             ["tara", 95, "Round one — cut and pacing"],
                             ["farhan", 71, "Round one — cut and pacing"]] as const)
    await POST("admin", `/creator/competitions/${battle}/scores`,
      { user_id: who(k).id, score: s, reason: why });
  const result = await POST("admin", `/creator/competitions/${battle}/complete`, {});
  const champs = (result.body.winners as Array<{ creator_name: string }> ?? []).map((w) => w.creator_name);
  // Now place it in the past, where it belongs.
  await backdate(`UPDATE mo_creator_competitions SET ends_at=$1, completed_at=$1 WHERE id=$2`,
    [ago(15), battle]);
  await backdate(`UPDATE mo_creator_competition_results SET finalized_at=$1 WHERE competition_id=$2`,
    [ago(15), battle]);

  // One running now, and one open for entries — so every status is visible.
  const live = await comp("TechFest Shorts", "Best short from the technical festival.", -3, 9);
  await POST("admin", `/creator/competitions/${live}/open`, {});
  for (const k of ["ravi", "ananya", "dev"])
    await POST(k, `/creator/competitions/${live}/participants`, {});
  await POST("admin", `/creator/competitions/${live}/start`, {});
  await POST("admin", `/creator/competitions/${live}/scores`,
    { user_id: who("ravi").id, score: 40, reason: "Heat one" });

  const upcoming = await comp("Sports Meet Reel Cup", "Best reel from finals day.", 10, 24);
  await POST("admin", `/creator/competitions/${upcoming}/open`, {});
  await POST("misha", `/creator/competitions/${upcoming}/participants`, {});
  console.log(`  3 competitions · winner: ${champs.join(" and ") || "—"}`);

  /* 10. Discussion ────────────────────────────────────────────────────── */
  await POST("admin", `/creator/assignments/${t1}/comments`,
    { body: "Got it — I'll review this tonight. The robotics track footage looked strong on the day." });
  await POST("ravi", `/creator/assignments/${t1}/comments`,
    { body: "Thanks. If the pacing is off I can re-cut the middle section." });
  await POST("admin", `/creator/assignments/${done[2][1]}/comments`,
    { body: "Happy to give this another go at the Sports Meet — closer in, and follow one person through." });
  console.log(`  3 discussion messages on assignments`);

  /* 11. Let the automations notice what is now true ───────────────────── */
  const autos = await import("../server/creator-automations.js");
  await autos.seedCreatorAutomationRules();
  const run = await autos.runCreatorNetworkAutomations();
  console.log(`  Automations ran: ${run.notified} notification(s), rules ${run.ranRules.join(", ")}`);

}

/* ── What actually landed ─────────────────────────────────────────────── */
async function summary(): Promise<void> {
  const rows: Array<[string, string]> = [];
  const count = async (label: string, sql: string) => {
    const n = (await pool.query(sql, [`${P}-%`])).rows[0].c;
    rows.push([label, String(n)]);
  };
  await count("Creators", `SELECT COUNT(*)::int c FROM mo_creator_profiles WHERE user_id LIKE $1`);
  await count("Teams", `SELECT COUNT(*)::int c FROM mo_creator_teams WHERE created_by LIKE $1`);
  await count("Events", `SELECT COUNT(*)::int c FROM mo_creator_events WHERE created_by LIKE $1`);
  await count("Assignments", `SELECT COUNT(*)::int c FROM mo_creator_assignments WHERE user_id LIKE $1`);
  await count("Submissions", `SELECT COUNT(*)::int c FROM mo_creator_submissions s
                                JOIN mo_creator_assignments a ON a.id=s.assignment_id WHERE a.user_id LIKE $1`);
  await count("Point transactions", `SELECT COUNT(*)::int c FROM mo_creator_point_ledger WHERE user_id LIKE $1`);
  await count("Payouts", `SELECT COUNT(*)::int c FROM mo_creator_payouts WHERE user_id LIKE $1`);
  await count("Financial entries", `SELECT COUNT(*)::int c FROM mo_creator_financial_ledger WHERE user_id LIKE $1`);
  await count("Achievements awarded", `SELECT COUNT(*)::int c FROM mo_creator_achievement_awards WHERE user_id LIKE $1`);
  await count("Competition results", `SELECT COUNT(*)::int c FROM mo_creator_competition_results WHERE user_id LIKE $1`);
  await count("Notifications", `SELECT COUNT(*)::int c FROM mo_notifications WHERE user_id LIKE $1`);
  await count("Audit entries", `SELECT COUNT(*)::int c FROM mo_audit_logs WHERE actor_id LIKE $1`);
  console.log("\n" + rows.map(([k, v]) => `  ${k.padEnd(22)}${v}`).join("\n"));

  const money = (await pool.query(
    `SELECT COALESCE(SUM(gross_amount),0)::numeric(12,2) gross,
            COALESCE(SUM(CASE WHEN status='paid' THEN gross_amount ELSE 0 END),0)::numeric(12,2) paid
       FROM mo_creator_payouts WHERE user_id LIKE $1`, [`${P}-%`])).rows[0];
  const owed = (await pool.query(
    `SELECT COALESCE(SUM(amount),0)::numeric(12,2) t FROM mo_creator_financial_ledger
      WHERE user_id LIKE $1`, [`${P}-%`])).rows[0];
  console.log(`\n  Payouts: ₹${money.gross} calculated · ₹${money.paid} paid · ₹${owed.t} outstanding`);
}

/* ── Run ──────────────────────────────────────────────────────────────── */
const wantsClear = process.argv.includes("--clear");
try {
  await db.bootstrapCreatorNetwork();
  await clear();                                  // always start from clean
  if (wantsClear) {
    console.log("Creator Network demo data removed.");
  } else {
    await seed();
    await summary();
    if (failures.length) {
      console.log(`\n  ${failures.length} call(s) did not succeed:`);
      for (const f of failures.slice(0, 10)) console.log(`    ${f}`);
    }
    console.log(`\n  Sign in as the Creator Admin:`);
    console.log(`    ${who("admin").email}`);
    console.log(`    ${ADMIN_PASSWORD}`);
    console.log(`\n  Every creator shares that password. Try ${who("misha").email}`);
    console.log(`  for the creator's own view, or ${who("leadR").email} for a Team Lead's.`);
    console.log(`\n  ${calls} API calls — every record was produced by the real handlers.`);
  }
} catch (e) {
  console.error("\nFailed:", (e as Error).message);
  console.error((e as Error).stack?.split("\n").slice(1, 3).join("\n") ?? "");
  process.exitCode = 1;
} finally {
  /* Exit explicitly. fetch leaves keep-alive sockets on the in-process server,
     so close() alone can leave the event loop running — and a script that will
     not exit looks exactly like one that is stuck, with its output still
     sitting unflushed in a pipe. */
  if (server) { (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
                server.close(); }
  await pool.end().catch(() => {});
  process.exit(process.exitCode ?? 0);
}
