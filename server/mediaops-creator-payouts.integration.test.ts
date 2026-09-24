// @vitest-environment node
/* ═══════════════════════════════════════════════════════════════════════════
   INTEGRATION — Creator Network Phase 5: payouts, financial ledger, payment.

   TWO LEDGERS, TWO JOBS, AND THE LINE BETWEEN THEM IS THE POINT OF THIS FILE.

     THE POINT LEDGER IS THE SOURCE OF TRUTH FOR PERFORMANCE. Phase 5 reads it
     and never writes it. Every test that moves money takes a checksum of the
     point ledger before and after and asserts it did not change — a ₹200
     bonus must never become 20 points.

     THE FINANCIAL LEDGER IS THE SOURCE OF TRUTH FOR MONEY. Entries are amounts
     OWED, so the sum over a payout is what is still outstanding and zero means
     settled. Nothing is edited, nothing is deleted; a correction is an
     opposite entry sitting beside the original.

   Money never becomes a JavaScript number here either: amounts are compared as
   strings, because `0.1 + 0.2` is how money goes missing.

   Real handlers, real database. Fixtures are `zfp-` and removed afterwards.
   ═══════════════════════════════════════════════════════════════════════════ */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PX = "zfp";
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
  c1:           { id: `${PX}-c1`,     role: "user",  team: "creator", cr: "creator" },
  c2:           { id: `${PX}-c2`,     role: "user",  team: "creator", cr: "creator" },
  c3:           { id: `${PX}-c3`,     role: "user",  team: "creator", cr: "creator" },
  cB:           { id: `${PX}-cB`,     role: "user",  team: "creator", cr: "creator" },
} as const;
type ActorName = keyof typeof A;

async function realDatabaseUrl(): Promise<string | null> {
  const { readFileSync, existsSync } = await import("node:fs");
  for (const f of [".env.local", ".env"]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^DATABASE_URL=(.+)$/m);
    if (m) return m[1].trim();
  }
  return null;
}
{
  const url = await realDatabaseUrl();
  if (url) {
    process.env.DATABASE_URL = url;
    process.env.SESSION_SECRET ||= "integration-test-secret";
    process.env.SUPER_ADMIN_PASSWORD ||= "integration-test-password";
    const { pool: p } = await import("./db.js");
    pool = p;
    try { await pool.query("SELECT 1"); dbUp = true; } catch { dbUp = false; }
  }
}
const maybe = dbUp ? describe : describe.skip;

async function boot() {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const a = A[(req.headers["x-actor"] as ActorName)];
    res.locals.currentUser = a
      ? { id: a.id, role: a.role, team: a.team, full_name: `ZFP ${a.id}` }
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

/* ── Fixtures ─────────────────────────────────────────────────────────────

   Cycles here are created CLOSED, directly. Making one active would take a
   globally exclusive slot (`idx_mo_cr_cycle_one_active`) that sibling test
   files legitimately compete for, and a payout is calculated from a closed
   cycle anyway. Point totals are seeded as ledger rows — which is exactly what
   Phase 4 would have written — so the arithmetic under test is the payout's,
   not the award path's. That the award path still works is asserted
   separately, against a real approved submission. */
async function closedCycle(label: string, from = "2026-09-01", to = "2026-09-30") {
  return Number((await pool.query(
    `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
     VALUES ($1,$2,$3,'closed') RETURNING id`, [`${PX} ${label}`, from, to])).rows[0].id);
}
async function givePoints(userId: string, cycleId: number, points: number, reason = "seeded") {
  await pool.query(
    `INSERT INTO mo_creator_point_ledger (user_id, cycle_id, points, source_type, reason, created_by)
     VALUES ($1,$2,$3,'manual',$4,$5)`, [userId, cycleId, points, `${PX} ${reason}`, A.creatorAdmin.id]);
}
async function rate(name: string, value: string, from: string, to: string | null = null) {
  const r = await as("creatorAdmin", "POST", "/creator/payout-rules",
    { name: `${PX} ${name}`, rate: value, effective_from: from, effective_to: to });
  return { status: r.status, id: Number(r.body.id), body: r.body };
}
/** Everything the money side of a payout is made of, read back from the API. */
async function payoutOf(userId: string, cycleId: number) {
  const r = await as("creatorAdmin", "GET", `/creator/payouts?creator_id=${userId}&cycle_id=${cycleId}`);
  return (r.body.payouts as Array<Record<string, unknown>>)[0];
}
const entriesOf = async (payoutId: number) => (await pool.query(
  `SELECT * FROM mo_creator_financial_ledger WHERE payout_id=$1 ORDER BY id`, [payoutId])).rows;

/* A fingerprint of every point this file's creators hold. Compared across
   every payout operation: money moving must never move a point. */
async function pointFingerprint() {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int n, COALESCE(SUM(points),0)::int total,
            COALESCE(md5(string_agg(id || '|' || user_id || '|' || points || '|' ||
              COALESCE(cycle_id::text,'~'), ',' ORDER BY id)), '') AS hash
       FROM mo_creator_point_ledger WHERE user_id LIKE $1`, [`${PX}-%`]);
  return rows[0] as { n: number; total: number; hash: string };
}

async function seed() {
  for (const [, a] of Object.entries(A)) {
    await pool.query(
      `INSERT INTO users (id, full_name, email, role, team, status, password_hash, department)
       VALUES ($1,$2,$3,$4,$5,'active','x','')
       ON CONFLICT (id) DO UPDATE SET role=EXCLUDED.role, team=EXCLUDED.team, status='active'`,
      [a.id, `ZFP ${a.id}`, `${a.id}@cpay.invalid`, a.role, a.team]);
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
  teamB = await mk("Vlog Team", A.cB.id);
  for (const [t, u] of [[teamA, A.c1.id], [teamA, A.c2.id], [teamA, A.c3.id], [teamA, A.leadA.id],
                        [teamB, A.cB.id]] as const)
    await pool.query(`INSERT INTO mo_creator_team_members (team_id, user_id, is_primary)
                      VALUES ($1,$2,true) ON CONFLICT DO NOTHING`, [t, u]);
}

async function cleanup() {
  /* Phase 6 recognition first: an achievement award is RESTRICT-protected on
     purpose — recognition outlives a suspension or an archive — so a fixture
     has to take its own down before its people and its cycles. */
  await pool.query(`DELETE FROM mo_creator_achievement_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_cycle_awards WHERE user_id LIKE $1 OR awarded_by LIKE $1`, [`${PX}-%`]);
  /* Financial history is RESTRICT all the way down — deliberately, so it
     cannot be half-deleted. It therefore has to come apart in order:
     reversals, then the entries they point at, then payouts, then the cycles
     and people they reference. */
  const fin = `payout_id IN (SELECT id FROM mo_creator_payouts WHERE user_id LIKE $1)
               OR user_id LIKE $1 OR created_by LIKE $1`;
  await pool.query(`DELETE FROM mo_creator_financial_ledger WHERE reversal_of_id IS NOT NULL
                      AND (${fin})`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_financial_ledger WHERE ${fin}`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_payouts WHERE user_id LIKE $1 OR calculated_by LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_payout_rules WHERE name LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_point_ledger WHERE reversal_of_id IS NOT NULL
                      AND (user_id LIKE $1 OR created_by LIKE $1)`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_point_ledger WHERE user_id LIKE $1 OR created_by LIKE $1
                      OR cycle_id IN (SELECT id FROM mo_creator_cycles WHERE label LIKE $2)`,
    [`${PX}-%`, `${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_submissions WHERE assignment_id IN
                      (SELECT id FROM mo_creator_assignments WHERE user_id LIKE $1)`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_assignments WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_interests WHERE user_id LIKE $1`, [`${PX}-%`]);
  await pool.query(`DELETE FROM mo_creator_events WHERE title LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_cycles WHERE label LIKE $1`, [`${PX} %`]);
  await pool.query(`DELETE FROM mo_creator_point_rules WHERE name LIKE $1`, [`${PX} %`]);
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

/* ── §47: the required end-to-end ────────────────────────────────────────── */

maybe("closed cycle → calculate → approve → pay → the creator sees it", () => {
  let sept = 0, rateId = 0, payoutId = 0;
  let fingerprint: Awaited<ReturnType<typeof pointFingerprint>>;

  it("a rate is ₹ per point, with the window it applies to", async () => {
    sept = await closedCycle("September 2026");
    await givePoints(A.c1.id, sept, 184, "September work");
    const r = await rate("Standard 2026-27", "10.00", "2026-09-01");
    expect(r.status).toBe(201);
    rateId = r.id;
  });

  it("calculating reads the points and snapshots everything that decided the amount", async () => {
    fingerprint = await pointFingerprint();     // nothing after this may move a point
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${sept}/payouts`, {});
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(1);
    expect(r.body.rate).toBe("10.0000");

    const p = await payoutOf(A.c1.id, sept);
    payoutId = Number(p.id);
    expect(p.points_basis).toBe(184);
    expect(p.rate).toBe("10.0000");
    expect(p.gross_amount).toBe("1840.00");     // 184 × ₹10, computed in Postgres
    expect(p.currency).toBe("INR");
    expect(p.status).toBe("calculated");
  });

  it("nothing is owed yet — calculating is not approving", async () => {
    expect(await entriesOf(payoutId)).toHaveLength(0);
    const p = await payoutOf(A.c1.id, sept);
    expect(p.outstanding).toBe("0.00");
    expect(p.paid_amount).toBe("0.00");
  });

  it("approving recognises the liability in the financial ledger", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/approve`, {});
    expect(r.status).toBe(200);
    const entries = await entriesOf(payoutId);
    expect(entries).toHaveLength(1);
    expect(entries[0].entry_type).toBe("payout");
    expect(String(entries[0].amount)).toBe("1840.00");

    const p = await payoutOf(A.c1.id, sept);
    expect(p.status).toBe("approved");
    expect(p.net_amount).toBe("1840.00");
    expect(p.outstanding).toBe("1840.00");      // owed, not paid
    expect(p.paid_amount).toBe("0.00");
  });

  it("paying settles it and records the reference", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/pay`,
      { payment_reference: "UTR-ZFP-0099123456" });
    expect(r.status).toBe(200);
    expect(r.body.settled).toBe("1840.00");

    const entries = await entriesOf(payoutId);
    expect(entries.map((e) => [e.entry_type, String(e.amount)]))
      .toEqual([["payout", "1840.00"], ["payment", "-1840.00"]]);

    const p = await payoutOf(A.c1.id, sept);
    expect(p.status).toBe("paid");
    expect(p.paid_amount).toBe("1840.00");
    expect(p.outstanding).toBe("0.00");         // settled
    expect(p.payment_reference).toBe("UTR-ZFP-0099123456");
  });

  it("the creator sees their own payout, and can read how it was reached", async () => {
    const list = await as("c1", "GET", "/creator/payouts");
    const mine = (list.body.payouts as Array<Record<string, unknown>>)[0];
    expect(list.body.scope).toBe("self");
    expect(mine).toMatchObject({ points_basis: 184, rate: "10.0000", gross_amount: "1840.00",
      net_amount: "1840.00", status: "paid", payment_reference: "UTR-ZFP-0099123456" });

    const detail = await as("c1", "GET", `/creator/payouts/${payoutId}`);
    expect(detail.status).toBe(200);
    // §6 — the amount traces back to the point transactions that made it.
    const basis = detail.body.points_basis_entries as Array<{ points: number }>;
    expect(basis.reduce((a, b) => a + b.points, 0)).toBe(184);
    expect(detail.body.basis_matches_current).toBe(true);
    expect((detail.body.financial_entries as unknown[]).length).toBe(2);
    expect(detail.body.can_manage).toBe(false);
  });

  it("and not one point moved through calculating, approving or paying", async () => {
    const after = await pointFingerprint();
    expect(after.hash).toBe(fingerprint.hash);
    expect(after.total).toBe(fingerprint.total);
    expect(after.n).toBe(fingerprint.n);
  });

  it("changing the rate does not restate September", async () => {
    // The old rate is ended and a new one begins — that is how a rate changes.
    expect((await as("creatorAdmin", "PATCH", `/creator/payout-rules/${rateId}`,
      { effective_to: "2026-09-30" })).status).toBe(200);
    expect((await rate("Standard from October", "12.00", "2026-10-01")).status).toBe(201);

    const p = await payoutOf(A.c1.id, sept);
    expect(p.rate).toBe("10.0000");             // exactly as it was calculated
    expect(p.gross_amount).toBe("1840.00");

    // And a new cycle picks up the new rate.
    const oct = await closedCycle("October 2026", "2026-10-01", "2026-10-31");
    await givePoints(A.c1.id, oct, 100, "October work");
    const before = await pointFingerprint();
    const gen = await as("creatorAdmin", "POST", `/creator/cycles/${oct}/payouts`, {});
    expect(gen.body.rate).toBe("12.0000");
    expect((await payoutOf(A.c1.id, oct)).gross_amount).toBe("1200.00");
    expect((await pointFingerprint()).hash).toBe(before.hash);
    // September is still priced at what it was calculated at.
    expect((await payoutOf(A.c1.id, sept)).gross_amount).toBe("1840.00");
  });
});

/* ── §48 and §49: bonus, then a correction after payment ─────────────────── */

maybe("a bonus is money, and a correction leaves history alone", () => {
  let cycle = 0, payoutId = 0, before: Awaited<ReturnType<typeof pointFingerprint>>;

  beforeAll(async () => {
    if (!dbUp) return;
    // Inside the ₹10 window, so the spec's ₹1,840 + ₹200 = ₹2,040 is literal.
    cycle = await closedCycle("September Bonus 2026", "2026-09-01", "2026-09-15");
    await givePoints(A.c2.id, cycle, 184, "bonus-cycle work");
    await as("creatorAdmin", "POST", `/creator/cycles/${cycle}/payouts`, {});
    payoutId = Number((await payoutOf(A.c2.id, cycle)).id);
    before = await pointFingerprint();
  });

  it("₹1,840 base + ₹200 bonus = ₹2,040, and the creator still has 184 points", async () => {
    expect((await payoutOf(A.c2.id, cycle)).gross_amount).toBe("1840.00");
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/adjust`,
      { amount: "200.00", reason: "Bonus — covered the closing ceremony at short notice" });
    expect(r.status).toBe(201);

    const p = await payoutOf(A.c2.id, cycle);
    expect(p.gross_amount).toBe("1840.00");     // the snapshot is untouched
    expect(p.adjustments).toBe("200.00");
    expect(p.net_amount).toBe("2040.00");
    expect(p.points_basis).toBe(184);

    const pts = Number((await pool.query(
      `SELECT COALESCE(SUM(points),0)::int t FROM mo_creator_point_ledger
        WHERE user_id=$1 AND cycle_id=$2`, [A.c2.id, cycle])).rows[0].t);
    expect(pts).toBe(184);                      // §21 — points did not become money
    expect((await pointFingerprint()).hash).toBe(before.hash);
  });

  it("approval and payment settle the adjusted total, not the gross", async () => {
    await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/approve`, {});
    expect((await payoutOf(A.c2.id, cycle)).outstanding).toBe("2040.00");
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/pay`,
      { payment_reference: "UTR-ZFP-0099123457" });
    expect(r.body.settled).toBe("2040.00");
    const p = await payoutOf(A.c2.id, cycle);
    expect(p.paid_amount).toBe("2040.00");
    expect(p.outstanding).toBe("0.00");
  });

  it("§49 — a paid payout that was wrong is corrected, never edited", async () => {
    /* Paid ₹2,040, should have been ₹1,900. The original entries stay exactly
       where they are and a −₹140 correction sits beside them. */
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/adjust`,
      { amount: "-140.00", reason: "Correction — the bonus was agreed at ₹60, not ₹200" });
    expect(r.status).toBe(201);

    const entries = await entriesOf(payoutId);
    expect(entries.map((e) => [e.entry_type, String(e.amount)])).toEqual([
      ["adjustment", "200.00"],      // the bonus, recorded before approval
      ["payout", "1840.00"],         // the liability, recognised on approval
      ["payment", "-2040.00"],       // the cash, settling both
      ["adjustment", "-140.00"]]);   // the correction, after the fact

    const p = await payoutOf(A.c2.id, cycle);
    expect(p.gross_amount).toBe("1840.00");     // never rewritten
    expect(p.net_amount).toBe("1900.00");       // what it should have been
    expect(p.paid_amount).toBe("2040.00");      // what actually left the bank
    expect(p.outstanding).toBe("-140.00");      // overpaid, and visibly so
    expect(p.status).toBe("paid");
  });

  it("a paid payout cannot be edited or voided", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/void`,
      { reason: "changed my mind" })).status).toBe(400);
    for (const [m, p] of [["PATCH", `/creator/payouts/${payoutId}`],
                          ["PUT", `/creator/payouts/${payoutId}`],
                          ["DELETE", `/creator/payouts/${payoutId}`]] as const)
      expect([404, 405], `${m} ${p}`).toContain(
        (await as("creatorAdmin", m, p, { gross_amount: "1.00" })).status);
    // Approving or paying again changes nothing.
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/approve`, {})).status).toBe(409);
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/pay`,
      { payment_reference: "UTR-ZFP-second" })).status).toBe(409);
    expect((await payoutOf(A.c2.id, cycle)).gross_amount).toBe("1840.00");
  });

  it("an adjustment can be reversed once, and the point ledger still has not moved", async () => {
    const adj = (await entriesOf(payoutId)).find(
      (e) => e.entry_type === "adjustment" && String(e.amount) === "-140.00")!;
    const r = await as("creatorAdmin", "POST", `/creator/finance/${adj.id}/reverse`,
      { reason: "The ₹60 figure was itself wrong" });
    expect(r.status).toBe(201);
    expect(r.body.amount).toBe("140.00");
    expect((await payoutOf(A.c2.id, cycle)).net_amount).toBe("2040.00");
    // Twice is refused by the index, not by a check.
    expect((await as("creatorAdmin", "POST", `/creator/finance/${adj.id}/reverse`,
      { reason: "again" })).status).toBe(409);
    expect((await pointFingerprint()).hash).toBe(before.hash);
  });

  it("the payment and payout entries are not reversible on their own", async () => {
    const entries = await entriesOf(payoutId);
    const pay = entries.find((e) => e.entry_type === "payment")!;
    const liability = entries.find((e) => e.entry_type === "payout")!;
    const rev = entries.find((e) => e.entry_type === "reversal")!;
    for (const [id, word] of [[pay.id, "adjustment"], [liability.id, "voiding"], [rev.id, "reversal"]] as const) {
      const r = await as("creatorAdmin", "POST", `/creator/finance/${id}/reverse`,
        { reason: "trying the wrong instrument" });
      expect(r.status).toBe(400);
      expect(String(r.body.message).toLowerCase()).toContain(word);
    }
  });
});

/* ── §26, §27, §35: idempotency and concurrency ──────────────────────────── */

maybe("one payout, however many requests arrive", () => {
  let cycle = 0;
  beforeAll(async () => {
    if (!dbUp) return;
    cycle = await closedCycle("Concurrency 2026", "2026-12-01", "2026-12-31");
    await givePoints(A.c3.id, cycle, 50, "December work");
  });

  it("A — ten simultaneous generate requests produce ONE payout", async () => {
    const all = await Promise.all(Array.from({ length: 10 }, () =>
      as("creatorAdmin", "POST", `/creator/cycles/${cycle}/payouts`, {})));
    expect(all.every((r) => r.status === 200)).toBe(true);
    // Exactly one of them created it; the rest were no-ops, not errors.
    expect(all.reduce((a, r) => a + Number(r.body.created), 0)).toBe(1);
    const n = await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_payouts WHERE user_id=$1 AND cycle_id=$2`,
      [A.c3.id, cycle]);
    expect(n.rows[0].c).toBe(1);
  });

  it("generating again later still leaves one payout", async () => {
    const again = await as("creatorAdmin", "POST", `/creator/cycles/${cycle}/payouts`, {});
    expect(again.body.created).toBe(0);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_payouts WHERE cycle_id=$1`, [cycle])).rows[0].c)).toBe(1);
  });

  it("B — ten simultaneous approvals produce ONE liability entry", async () => {
    const id = Number((await payoutOf(A.c3.id, cycle)).id);
    const all = await Promise.all(Array.from({ length: 10 }, () =>
      as("creatorAdmin", "POST", `/creator/payouts/${id}/approve`, {})));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    expect(all.filter((r) => r.status === 409)).toHaveLength(9);
    const entries = await entriesOf(id);
    expect(entries.filter((e) => e.entry_type === "payout")).toHaveLength(1);
    expect(String((await payoutOf(A.c3.id, cycle)).outstanding)).toBe("600.00");
  });

  it("C — ten simultaneous payments produce ONE payment entry", async () => {
    const id = Number((await payoutOf(A.c3.id, cycle)).id);
    const all = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      as("creatorAdmin", "POST", `/creator/payouts/${id}/pay`,
        { payment_reference: `UTR-ZFP-RACE-${i}` })));
    expect(all.filter((r) => r.status === 200)).toHaveLength(1);
    const entries = await entriesOf(id);
    expect(entries.filter((e) => e.entry_type === "payment")).toHaveLength(1);
    const p = await payoutOf(A.c3.id, cycle);
    expect(p.paid_amount).toBe("600.00");
    expect(p.outstanding).toBe("0.00");
  });

  it("C — and the database refuses a second payment entry outright", async () => {
    const id = Number((await payoutOf(A.c3.id, cycle)).id);
    await expect(pool.query(
      `INSERT INTO mo_creator_financial_ledger (user_id, payout_id, cycle_id, entry_type, amount, description)
       VALUES ($1,$2,$3,'payment',-1,'forced')`, [A.c3.id, id, cycle])).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO mo_creator_financial_ledger (user_id, payout_id, cycle_id, entry_type, amount, description)
       VALUES ($1,$2,$3,'payout',1,'forced')`, [A.c3.id, id, cycle])).rejects.toThrow();
  });

  it("D — concurrent adjustments all land, and the balance is exactly their sum", async () => {
    /* Five bonuses are five bonuses — they are not deduplicated, because two
       identical awards are a legitimate thing for a manager to record. What
       must not happen is a lost update, and with a ledger there is no counter
       to lose: the balance is the sum of the rows. */
    const id = Number((await payoutOf(A.c3.id, cycle)).id);
    await Promise.all(Array.from({ length: 5 }, (_, i) =>
      as("creatorAdmin", "POST", `/creator/payouts/${id}/adjust`,
        { amount: "10.00", reason: `Concurrent bonus ${i}` })));
    const adj = (await entriesOf(id)).filter((e) => e.entry_type === "adjustment");
    expect(adj).toHaveLength(5);
    const p = await payoutOf(A.c3.id, cycle);
    expect(p.adjustments).toBe("50.00");
    expect(p.net_amount).toBe("650.00");        // 50 points × ₹12, plus the bonuses
    expect(p.outstanding).toBe("50.00");        // paid 600, now owed 50 more
  });
});

/* ── §36: money is NUMERIC, never a float ────────────────────────────────── */

maybe("money survives the round trip exactly", () => {
  let cycle = 0, payoutId = 0;
  beforeAll(async () => {
    if (!dbUp) return;
    cycle = await closedCycle("Precision 2027", "2027-01-01", "2027-01-31");
    await givePoints(A.cB.id, cycle, 1, "precision fixture");
    await as("creatorAdmin", "POST", `/creator/cycles/${cycle}/payouts`, {});
    payoutId = Number((await payoutOf(A.cB.id, cycle)).id);
  });

  it("every amount the spec names round-trips to the paisa", async () => {
    const amounts = ["0.01", "0.10", "1.99", "999.99", "10000.00", "100000.00"];
    let running = 0;
    for (const a of amounts) {
      const r = await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/adjust`,
        { amount: a, reason: `Precision probe ${a}` });
      expect(r.status, a).toBe(201);
      expect(r.body.amount, a).toBe(a);
      running++;
    }
    expect((await entriesOf(payoutId)).filter((e) => e.entry_type === "adjustment")).toHaveLength(running);
    // 0.01+0.10+1.99+999.99+10000+100000 — summed by Postgres, exact.
    expect((await payoutOf(A.cB.id, cycle)).adjustments).toBe("111002.09");
  });

  it("a figure that only exists because of float arithmetic is refused", async () => {
    for (const bad of [0.1 + 0.2, "0.30000000000000004", "1.005", "1.999", 1e21, "abc", "", "1e5"])
      expect((await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/adjust`,
        { amount: bad, reason: "should not be accepted" })).status, String(bad)).toBe(400);
  });

  it("zero is not a movement, and neither is a blank", async () => {
    for (const bad of ["0", "0.00", "-0.00", 0])
      expect((await as("creatorAdmin", "POST", `/creator/payouts/${payoutId}/adjust`,
        { amount: bad, reason: "nothing at all" })).status).toBe(400);
  });

  it("a fractional rate rounds once, in the database, half away from zero", async () => {
    /* The rounding rule: ROUND(points × rate, 2) in Postgres on NUMERIC —
       half away from zero. 3 × 0.3333 = 0.9999 → 1.00, and 7 × 1.005 =
       7.035 → 7.04. Deterministic, and no JavaScript number is involved. */
    const c = await closedCycle("Rounding 2027", "2027-02-01", "2027-02-28");
    await pool.query(`UPDATE mo_creator_payout_rules SET effective_to='2027-01-31'
                       WHERE name LIKE $1 AND effective_to IS NULL`, [`${PX} %`]);
    await rate("Fractional", "0.3333", "2027-02-01", "2027-02-28");
    await givePoints(A.c1.id, c, 3, "fractional");
    await givePoints(A.c2.id, c, 7, "fractional");
    await as("creatorAdmin", "POST", `/creator/cycles/${c}/payouts`, {});
    expect((await payoutOf(A.c1.id, c)).gross_amount).toBe("1.00");        // 0.9999
    expect((await payoutOf(A.c2.id, c)).gross_amount).toBe("2.33");        // 2.3331

    const c2 = await closedCycle("Rounding half 2027", "2027-03-01", "2027-03-31");
    await rate("Half up", "1.0050", "2027-03-01", "2027-03-31");
    await givePoints(A.c3.id, c2, 7, "half");
    await as("creatorAdmin", "POST", `/creator/cycles/${c2}/payouts`, {});
    expect((await payoutOf(A.c3.id, c2)).gross_amount).toBe("7.04");       // 7.035, away from zero
  });

  it("a rate must be positive, and is refused beyond four decimal places", async () => {
    for (const bad of ["0", "-5", "1.00001", "abc", ""])
      expect((await as("creatorAdmin", "POST", "/creator/payout-rules",
        { name: `${PX} Bad ${bad}`, rate: bad, effective_from: "2028-01-01" })).status,
        String(bad)).toBe(400);
  });

  it("two active rates cannot cover the same day", async () => {
    const r = await as("creatorAdmin", "POST", "/creator/payout-rules",
      { name: `${PX} Overlapping`, rate: "5.00", effective_from: "2027-03-15", effective_to: "2027-03-20" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toContain("cannot have two rates");
  });

  it("a rate that has priced a payout cannot have its figure edited", async () => {
    const used = (await pool.query(
      `SELECT id FROM mo_creator_payout_rules WHERE name=$1`, [`${PX} Fractional`])).rows[0];
    const r = await as("creatorAdmin", "PATCH", `/creator/payout-rules/${used.id}`, { rate: "99.00" });
    expect(r.status).toBe(409);
    expect(String((await pool.query(
      `SELECT rate FROM mo_creator_payout_rules WHERE id=$1`, [used.id])).rows[0].rate)).toBe("0.3333");
  });
});

/* ── §29, §50: the cycle is the accounting boundary ──────────────────────── */

maybe("only a closed cycle pays, and a paid cycle does not reopen", () => {
  it("a draft cycle is refused", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
       VALUES ($1,'2027-04-01','2027-04-30','draft') RETURNING id`, [`${PX} Draft 2027`])).rows[0].id);
    await givePoints(A.c1.id, id, 10, "draft cycle");
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${id}/payouts`, {});
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("closed cycle");
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_payouts WHERE cycle_id=$1`, [id])).rows[0].c)).toBe(0);
  });

  it("an archived cycle is refused", async () => {
    const id = Number((await pool.query(
      `INSERT INTO mo_creator_cycles (label, starts_on, ends_on, status)
       VALUES ($1,'2027-05-01','2027-05-31','archived') RETURNING id`, [`${PX} Archived 2027`])).rows[0].id);
    expect((await as("creatorAdmin", "POST", `/creator/cycles/${id}/payouts`, {})).status).toBe(400);
  });

  it("a cycle that does not exist is refused", async () => {
    expect((await as("creatorAdmin", "POST", "/creator/cycles/999999999/payouts", {})).status).toBe(404);
  });

  it("a closed cycle with payouts cannot be reopened", async () => {
    const paid = (await pool.query(
      `SELECT cycle_id FROM mo_creator_payouts WHERE user_id=$1 AND status='paid' LIMIT 1`,
      [A.c1.id])).rows[0];
    const r = await as("creatorAdmin", "PATCH", `/creator/cycles/${paid.cycle_id}`, { status: "active" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toContain("cannot be");
    expect((await pool.query(
      `SELECT status FROM mo_creator_cycles WHERE id=$1`, [paid.cycle_id])).rows[0].status).toBe("closed");
  });

  it("and a closed cycle with no payouts still can be", async () => {
    const id = await closedCycle("Reopenable 2027", "2027-06-01", "2027-06-30");
    const r = await as("creatorAdmin", "PATCH", `/creator/cycles/${id}`, { status: "active" });
    // Either it reopened, or another cycle holds the one active slot — both
    // prove the payout guard was not what stopped it.
    expect([200, 409]).toContain(r.status);
    if (r.status === 409) expect(String(r.body.message)).toContain("already active");
    await pool.query(`UPDATE mo_creator_cycles SET status='closed' WHERE id=$1`, [id]);
  });

  it("a creator with no points gets no payout at all", async () => {
    const id = await closedCycle("Empty 2027", "2027-07-01", "2027-07-31");
    await rate("July", "10.00", "2027-07-01", "2027-07-31");
    await givePoints(A.c1.id, id, 5, "some");
    await givePoints(A.c2.id, id, -5, "clawed back to zero");
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${id}/payouts`, {});
    expect(r.body.created).toBe(1);             // only the creator in credit
    const rows = await pool.query(`SELECT user_id FROM mo_creator_payouts WHERE cycle_id=$1`, [id]);
    expect(rows.rows.map((x) => x.user_id)).toEqual([A.c1.id]);
  });

  it("with no rate covering the cycle, nothing is invented", async () => {
    const id = await closedCycle("Unrated 2029", "2029-01-01", "2029-01-31");
    await givePoints(A.c1.id, id, 10, "unrated");
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${id}/payouts`, {});
    expect(r.status).toBe(400);
    expect(String(r.body.message)).toContain("No active payout rate");
  });
});

/* ── §13: the lifecycle refuses what it should ───────────────────────────── */

maybe("the lifecycle holds", () => {
  let cycle = 0, id = 0;
  beforeAll(async () => {
    if (!dbUp) return;
    cycle = await closedCycle("Lifecycle 2027", "2027-08-01", "2027-08-31");
    await rate("August", "10.00", "2027-08-01", "2027-08-31");
    await givePoints(A.c1.id, cycle, 20, "lifecycle");
    await as("creatorAdmin", "POST", `/creator/cycles/${cycle}/payouts`, {});
    id = Number((await payoutOf(A.c1.id, cycle)).id);
  });

  it("a calculated payout cannot be paid before it is approved", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${id}/pay`,
      { payment_reference: "UTR-ZFP-TOO-EARLY" });
    expect(r.status).toBe(409);
    expect(String(r.body.message)).toContain("approved");
    expect(await entriesOf(id)).toHaveLength(0);
  });

  it("nor voided before it is approved", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${id}/void`,
      { reason: "not yet" })).status).toBe(409);
  });

  it("rejecting needs a reason, closes the statement, and moves no money", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${id}/reject`, {})).status).toBe(400);
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${id}/reject`,
      { reason: "Points were awarded against the wrong event" });
    expect(r.status).toBe(200);
    expect(await entriesOf(id)).toHaveLength(0);
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${id}/approve`, {})).status).toBe(409);
  });

  it("a rejected statement lets the cycle be calculated again", async () => {
    const r = await as("creatorAdmin", "POST", `/creator/cycles/${cycle}/payouts`, {});
    expect(r.body.created).toBe(1);
    const live = await payoutOf(A.c1.id, cycle);
    expect(live.status).toBe("calculated");
    expect(Number(live.id)).not.toBe(id);
    id = Number(live.id);
  });

  it("voiding an approved payout reverses the money and leaves the trail", async () => {
    await as("creatorAdmin", "POST", `/creator/payouts/${id}/approve`, {});
    await as("creatorAdmin", "POST", `/creator/payouts/${id}/adjust`,
      { amount: "50.00", reason: "Bonus before the void" });
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${id}/void`,
      { reason: "The whole cycle was recalculated" });
    expect(r.status).toBe(200);
    expect(r.body.entries_reversed).toBe(2);    // the liability and the bonus

    const entries = await entriesOf(id);
    expect(entries.filter((e) => e.entry_type === "reversal")).toHaveLength(2);
    // Every original entry is still there, and the balance is zero.
    expect(entries.filter((e) => e.entry_type === "payout")).toHaveLength(1);
    const bal = String((await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(12,2) t FROM mo_creator_financial_ledger WHERE payout_id=$1`,
      [id])).rows[0].t);
    expect(bal).toBe("0.00");
  });

  it("voiding requires a reason, and a voided payout is finished", async () => {
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${id}/void`, {})).status).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${id}/pay`,
      { payment_reference: "UTR-ZFP-VOIDED" })).status).toBe(409);
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${id}/adjust`,
      { amount: "10.00", reason: "after the void" })).status).toBe(400);
  });

  it("a payment reference is required, bounded, and never a credential", async () => {
    const c = await closedCycle("Reference 2027", "2027-09-01", "2027-09-30");
    await rate("September 2027", "10.00", "2027-09-01", "2027-09-30");
    await givePoints(A.c2.id, c, 10, "reference");
    await as("creatorAdmin", "POST", `/creator/cycles/${c}/payouts`, {});
    const pid = Number((await payoutOf(A.c2.id, c)).id);
    await as("creatorAdmin", "POST", `/creator/payouts/${pid}/approve`, {});
    for (const bad of ["", "ab", "x".repeat(121), "upi password 4321", "api_key=abc123"])
      expect((await as("creatorAdmin", "POST", `/creator/payouts/${pid}/pay`,
        { payment_reference: bad })).status, bad.slice(0, 20)).toBe(400);
    expect((await as("creatorAdmin", "POST", `/creator/payouts/${pid}/pay`,
      { payment_reference: "NEFT/2027/000912" })).status).toBe(200);
  });
});

/* ── §34: the security matrix ────────────────────────────────────────────── */

maybe("the client is never trusted with money", () => {
  let othersPayout = 0, othersEntry = 0, cycle = 0, sandbox = 0;
  beforeAll(async () => {
    if (!dbUp) return;
    const r = (await pool.query(
      `SELECT p.id, p.cycle_id FROM mo_creator_payouts p WHERE p.user_id=$1 ORDER BY p.id LIMIT 1`,
      [A.c2.id])).rows[0];
    othersPayout = Number(r.id); cycle = Number(r.cycle_id);
    othersEntry = Number((await pool.query(
      `SELECT id FROM mo_creator_financial_ledger WHERE payout_id=$1 ORDER BY id LIMIT 1`,
      [othersPayout])).rows[0].id);
    /* A payout of this block's own, so the probes below — injection strings,
       forged fields, reversals — move money that no other test is asserting. */
    const c = await closedCycle("Security 2028", "2028-01-01", "2028-01-31");
    await rate("Security 2028", "10.00", "2028-01-01", "2028-01-31");
    await givePoints(A.cB.id, c, 30, "security fixture");
    await as("creatorAdmin", "POST", `/creator/cycles/${c}/payouts`, {});
    sandbox = Number((await payoutOf(A.cB.id, c)).id);
  });

  it("TESTS 1, 2 — anonymous and ordinary employees are refused everywhere", async () => {
    for (const p of ["/creator/payouts", "/creator/finance/ledger", "/creator/payout-rules",
                     `/creator/payouts/${othersPayout}`, "/creator/payouts/summary/all"]) {
      expect((await as("anon", "GET", p)).status, p).toBe(403);
      expect((await as("mediaEmp", "GET", p)).status, p).toBe(403);
    }
    for (const [m, p] of [["POST", `/creator/cycles/${cycle}/payouts`],
                          ["POST", `/creator/payouts/${othersPayout}/approve`],
                          ["POST", `/creator/payouts/${othersPayout}/pay`],
                          ["POST", `/creator/payouts/${othersPayout}/adjust`],
                          ["POST", "/creator/payout-rules"]] as const) {
      expect((await as("anon", m, p, { amount: "1.00", reason: "x" })).status, p).toBe(403);
      expect((await as("mediaEmp", m, p, { amount: "1.00", reason: "x" })).status, p).toBe(403);
    }
  });

  it("TEST 3 — a creator cannot see another creator's payout", async () => {
    // Indistinguishable from one that does not exist.
    expect((await as("c1", "GET", `/creator/payouts/${othersPayout}`)).status).toBe(404);
    const list = await as("c1", "GET", "/creator/payouts?limit=200");
    expect((list.body.payouts as Array<{ user_id: string }>).every((p) => p.user_id === A.c1.id)).toBe(true);
  });

  it("TESTS 4, 5, 6, 7 — a creator cannot calculate, approve, pay or move money", async () => {
    for (const [m, p, b] of [
      ["POST", `/creator/cycles/${cycle}/payouts`, {}],
      ["POST", `/creator/payouts/${othersPayout}/approve`, {}],
      ["POST", `/creator/payouts/${othersPayout}/pay`, { payment_reference: "UTR-ZFP-FAKE" }],
      ["POST", `/creator/payouts/${othersPayout}/adjust`, { amount: "500.00", reason: "for me" }],
      ["POST", `/creator/payouts/${othersPayout}/void`, { reason: "for me" }],
      ["POST", `/creator/payouts/${othersPayout}/reject`, { reason: "for me" }],
      ["POST", `/creator/finance/${othersEntry}/reverse`, { reason: "for me" }],
      ["POST", "/creator/payout-rules", { name: `${PX} Rogue`, rate: "999", effective_from: "2030-01-01" }],
    ] as const)
      expect((await as("c1", m, p, b)).status, p).toBe(403);
  });

  it("TESTS 8, 9, 10 — forged ids reach nothing", async () => {
    // A creator's own list cannot be widened by naming someone else.
    expect(((await as("c1", "GET", `/creator/payouts?creator_id=${A.c2.id}`)).body.payouts)).toEqual([]);
    expect(((await as("c1", "GET", `/creator/finance/ledger?creator_id=${A.c2.id}`)).body.entries)).toEqual([]);
    expect(((await as("c1", "GET", `/creator/payouts?cycle_id=${cycle}&creator_id=${A.c2.id}`))
      .body.payouts)).toEqual([]);
    expect(((await as("c1", "GET", `/creator/finance/ledger?payout_id=${othersPayout}`))
      .body.entries)).toEqual([]);
  });

  it("TESTS 11, 12 — a Team Lead has no financial authority and no financial visibility", async () => {
    /* Leading a team is not a financial role. A lead keeps their Phase 4 view
       of their team's points and sees no money that is not their own. */
    const list = await as("leadA", "GET", "/creator/payouts?limit=200");
    expect(list.status).toBe(200);
    expect(list.body.scope).toBe("self");
    expect((list.body.payouts as Array<{ user_id: string }>).every((p) => p.user_id === A.leadA.id)).toBe(true);
    expect((await as("leadA", "GET", `/creator/payouts/${othersPayout}`)).status).toBe(404);
    expect((await as("leadA", "GET", "/creator/payout-rules")).status).toBe(403);
    expect((await as("leadA", "GET", "/creator/payouts/summary/all")).status).toBe(403);
    for (const [m, p, b] of [
      ["POST", `/creator/payouts/${othersPayout}/approve`, {}],
      ["POST", `/creator/payouts/${othersPayout}/adjust`, { amount: "100.00", reason: "my team" }],
      ["POST", `/creator/cycles/${cycle}/payouts`, {}],
    ] as const)
      expect((await as("leadA", m, p, b)).status, p).toBe(403);
    // And Phase 4 is untouched: the lead still sees their team's points.
    expect((await as("leadA", "GET", "/creator/points/ledger")).status).toBe(200);
  });

  it("TESTS 13, 14 — a Creator Admin acts, and a Nerve Admin follows Phase 0", async () => {
    expect((await as("creatorAdmin", "GET", "/creator/payouts")).body.scope).toBe("all");
    expect((await as("nerveAdmin", "GET", "/creator/payouts")).body.scope).toBe("all");
    expect((await as("nerveAdmin", "GET", "/creator/payout-rules")).status).toBe(200);
    // Holding the module is still not being a Creator Admin.
    expect(await api.creatorRoleOf({ id: A.nerveAdmin.id, role: "admin", team: "media" })).toBeNull();
  });

  it("a payout cannot be approved by the creator it belongs to", async () => {
    /* The Creator Admin here is a Media Ops account, so this is asserted by
       making a creator the actor on their own statement — the check is on the
       payout's owner, not on the role. */
    const own = (await pool.query(
      `SELECT id FROM mo_creator_payouts WHERE user_id=$1 AND status='calculated' LIMIT 1`,
      [A.c1.id])).rows[0];
    if (own) expect((await as("c1", "POST", `/creator/payouts/${own.id}/approve`, {})).status).toBe(403);
  });

  it("TESTS 15, 16 — paid payouts and financial history cannot be edited", async () => {
    const paid = (await pool.query(
      `SELECT id FROM mo_creator_payouts WHERE status='paid' AND user_id LIKE $1 LIMIT 1`,
      [`${PX}-%`])).rows[0];
    for (const [m, p] of [["PATCH", `/creator/payouts/${paid.id}`],
                          ["DELETE", `/creator/payouts/${paid.id}`],
                          ["PATCH", `/creator/finance/${othersEntry}`],
                          ["DELETE", `/creator/finance/${othersEntry}`],
                          ["PATCH", "/creator/finance/ledger"]] as const)
      expect([404, 405], `${m} ${p}`).toContain(
        (await as("creatorAdmin", m, p, { amount: "1.00" })).status);
  });

  it("TEST 16 — and the source has no way to change one either", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/UPDATE\s+mo_creator_financial_ledger/i);
    expect(src).not.toMatch(/DELETE\s+FROM\s+mo_creator_financial_ledger/i);
  });

  it("TEST 18 — a rule change does not modify historical payouts", async () => {
    const before = (await pool.query(
      `SELECT id, rate, gross_amount FROM mo_creator_payouts WHERE user_id LIKE $1 ORDER BY id`,
      [`${PX}-%`])).rows.map((r) => [Number(r.id), String(r.rate), String(r.gross_amount)]);
    const rule = (await pool.query(
      `SELECT id FROM mo_creator_payout_rules WHERE name=$1`, [`${PX} Standard from October`])).rows[0];
    await as("creatorAdmin", "PATCH", `/creator/payout-rules/${rule.id}`, { is_active: false });
    const after = (await pool.query(
      `SELECT id, rate, gross_amount FROM mo_creator_payouts WHERE user_id LIKE $1 ORDER BY id`,
      [`${PX}-%`])).rows.map((r) => [Number(r.id), String(r.rate), String(r.gross_amount)]);
    expect(after).toEqual(before);
    await as("creatorAdmin", "PATCH", `/creator/payout-rules/${rule.id}`, { is_active: true });
  });

  it("TESTS 23, 25 — bad money is refused and injection is stored as text", async () => {
    for (const bad of [{ amount: "10.00" }, { amount: "10.00", reason: "x" }, { reason: "no amount" }])
      expect((await as("creatorAdmin", "POST", `/creator/payouts/${sandbox}/adjust`, bad)).status).toBe(400);
    const r = await as("creatorAdmin", "POST", `/creator/payouts/${sandbox}/adjust`,
      { amount: "1.00", reason: "'); DROP TABLE mo_creator_financial_ledger;--" });
    expect(r.status).toBe(201);
    expect((await pool.query(`SELECT to_regclass('mo_creator_financial_ledger')::text t`)).rows[0].t)
      .toBe("mo_creator_financial_ledger");
    expect((await as("creatorAdmin", "POST", "/creator/payouts/999999999/adjust",
      { amount: "1.00", reason: "nowhere" })).status).toBe(404);
  });

  it("TEST 26 — a payout cannot be pointed at a different cycle or creator", async () => {
    const live = (await pool.query(
      `SELECT id, user_id, cycle_id FROM mo_creator_payouts WHERE id=$1`, [sandbox])).rows[0];
    // Every write takes the payout id and reads the rest from the row.
    await as("creatorAdmin", "POST", `/creator/payouts/${sandbox}/adjust`,
      { amount: "1.00", reason: "forged fields ride along", user_id: A.c1.id,
        cycle_id: 999999, currency: "USD", payout_id: 1 });
    const last = (await pool.query(
      `SELECT user_id, cycle_id, currency FROM mo_creator_financial_ledger
        WHERE payout_id=$1 ORDER BY id DESC LIMIT 1`, [sandbox])).rows[0];
    expect(last.user_id).toBe(live.user_id);
    expect(Number(last.cycle_id)).toBe(Number(live.cycle_id));
    expect(last.currency).toBe("INR");
  });

  it("TEST 28 — suspending a creator does not erase their financial history", async () => {
    const before = Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_payouts WHERE user_id=$1`, [A.c2.id])).rows[0].c);
    await pool.query(`UPDATE mo_creator_profiles SET status='suspended' WHERE user_id=$1`, [A.c2.id]);
    expect(Number((await pool.query(
      `SELECT COUNT(*)::int c FROM mo_creator_payouts WHERE user_id=$1`, [A.c2.id])).rows[0].c)).toBe(before);
    // An admin can still see and settle it.
    expect((await as("creatorAdmin", "GET", `/creator/payouts?creator_id=${A.c2.id}`)).status).toBe(200);
    // The suspended creator themselves is out of the network entirely.
    expect((await as("c2", "GET", "/creator/payouts")).status).toBe(403);
    await pool.query(`UPDATE mo_creator_profiles SET status='active' WHERE user_id=$1`, [A.c2.id]);
  });

  it("TESTS 29, 30, 31 — corrections need a reason, an owner, and cannot repeat", async () => {
    const adj = (await pool.query(
      `SELECT f.id FROM mo_creator_financial_ledger f
        WHERE f.payout_id=$1 AND f.entry_type='adjustment'
          AND NOT EXISTS (SELECT 1 FROM mo_creator_financial_ledger r WHERE r.reversal_of_id=f.id)
        LIMIT 1`, [sandbox])).rows[0];
    expect((await as("creatorAdmin", "POST", `/creator/finance/${adj.id}/reverse`, {})).status).toBe(400);
    expect((await as("c1", "POST", `/creator/finance/${adj.id}/reverse`, { reason: "mine now" })).status).toBe(403);
    expect((await as("creatorAdmin", "POST", `/creator/finance/${adj.id}/reverse`,
      { reason: "A genuine correction" })).status).toBe(201);
    expect((await as("creatorAdmin", "POST", `/creator/finance/${adj.id}/reverse`,
      { reason: "and again" })).status).toBe(409);
  });

  it("TEST 32 — no financial secret reaches the audit trail or the ledger", async () => {
    const blob = (JSON.stringify((await pool.query(
      `SELECT before, after FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`])).rows)
      + JSON.stringify((await pool.query(
        `SELECT description, reference FROM mo_creator_financial_ledger WHERE user_id LIKE $1`,
        [`${PX}-%`])).rows)).toLowerCase();
    for (const secret of ["password", "passwd", "api_key", "apikey", "token", "secret",
                          "cvv", "upi pin", "credential"])
      expect(blob, secret).not.toContain(secret);
  });
});

/* ── §42, §43, §44, §51: nothing else moved ──────────────────────────────── */

maybe("the rest of Nerve is exactly where it was", () => {
  it("§43 — an approved submission still awards points, unchanged by Phase 5", async () => {
    const ruleId = Number((await pool.query(
      `INSERT INTO mo_creator_point_rules (name, description, points) VALUES ($1,'',10)
       ON CONFLICT (lower(name)) DO UPDATE SET points=10 RETURNING id`,
      [`${PX} Approved Reel`])).rows[0].id);
    const tag = Math.random().toString(36).slice(2, 8);
    const ev = await as("creatorAdmin", "POST", "/creator/events",
      { title: `${PX} Event ${tag}`, event_date: "2027-10-01" });
    const op = await as("creatorAdmin", "POST", "/creator/opportunities",
      { event_id: Number(ev.body.id), title: "Reel Creator", required_count: 1, point_rule_id: ruleId });
    const oppId = Number(op.body.id);
    await as("creatorAdmin", "PATCH", `/creator/events/${Number(ev.body.id)}`, { status: "open" });
    await as("creatorAdmin", "PATCH", `/creator/opportunities/${oppId}`, { status: "open" });
    const asg = await as("creatorAdmin", "POST", "/creator/assignments",
      { opportunity_id: oppId, user_id: A.c3.id });
    const aid = Number(asg.body.id);
    for (const to of ["accepted", "in_progress", "completed"])
      await as("c3", "PATCH", `/creator/assignments/${aid}`, { status: to });
    const sub = await as("c3", "POST", `/creator/assignments/${aid}/submissions`,
      { content_url: `https://drive.google.com/file/d/${PX}-${tag}/view` });
    const sid = Number((sub.body.submission as Record<string, unknown>).id);
    const rev = await as("creatorAdmin", "POST", `/creator/submissions/${sid}/review`, { outcome: "approved" });
    expect(rev.status).toBe(200);
    expect((rev.body.points as Record<string, unknown>).awarded).toBe(10);
    const led = await pool.query(
      `SELECT user_id, points FROM mo_creator_point_ledger
        WHERE source_type='approved_submission' AND source_id=$1`, [sid]);
    expect(led.rows).toHaveLength(1);
    expect(led.rows[0].user_id).toBe(A.c3.id);

    // And paying somebody does not touch a submission or an assignment.
    const before = await pool.query(
      `SELECT s.status ss, a.status ast FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id WHERE s.id=$1`, [sid]);
    const anyPayout = (await pool.query(
      `SELECT id FROM mo_creator_payouts WHERE user_id LIKE $1 AND status='calculated' LIMIT 1`,
      [`${PX}-%`])).rows[0];
    if (anyPayout) await as("creatorAdmin", "POST", `/creator/payouts/${anyPayout.id}/approve`, {});
    const after = await pool.query(
      `SELECT s.status ss, a.status ast FROM mo_creator_submissions s
         JOIN mo_creator_assignments a ON a.id = s.assignment_id WHERE s.id=$1`, [sid]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("§42, §51 — Phase 4 points and ranking survive every payout operation", async () => {
    const cycleRow = (await pool.query(
      `SELECT id FROM mo_creator_cycles WHERE label=$1`, [`${PX} September 2026`])).rows[0];
    const board = await as("creatorAdmin", "GET", `/creator/leaderboard?cycle_id=${cycleRow.id}`);
    const rows = (board.body.rows as Array<{ user_id: string; points: number }>)
      .filter((r) => r.user_id.startsWith(`${PX}-`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ user_id: A.c1.id, points: 184, place: 1, creator_status: "active" });
    // The point total the payout was built from is still exactly that.
    expect(Number((await pool.query(
      `SELECT COALESCE(SUM(points),0)::int t FROM mo_creator_point_ledger
        WHERE user_id=$1 AND cycle_id=$2`, [A.c1.id, cycleRow.id])).rows[0].t)).toBe(184);
  });

  it("§42 — no Phase 5 code writes to the point ledger", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    const phase5 = src.slice(src.indexOf("CREATOR NETWORK — Phase 5"));
    for (const forbidden of [/INSERT INTO mo_creator_point_ledger/i,
                             /UPDATE mo_creator_point_ledger/i,
                             /DELETE FROM mo_creator_point_ledger/i])
      expect(phase5, String(forbidden)).not.toMatch(forbidden);
    // It reads them, which is the whole job.
    expect(phase5).toMatch(/FROM mo_creator_point_ledger/);
  });

  it("§44 — Media Ops holds no creator money and is not the route to it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./mediaops-api.ts", import.meta.url), "utf8");
    const phase5 = src.slice(src.indexOf("CREATOR NETWORK — Phase 5"), src.indexOf("  // ── helpers ──"));
    for (const t of ["mo_projects", "mo_assignments", "mo_deliverable_versions"])
      expect(phase5, `Phase 5 must not touch ${t}`).not.toContain(t);
    expect((await as("c1", "GET", "/state")).status).toBe(403);
    const state = await as("nerveAdmin", "GET", "/state");
    expect(state.status).toBe(200);
    expect(JSON.stringify(state.body)).not.toContain("creator_payout");
  });

  it("the audit trail names every financial action", async () => {
    const seen = (await pool.query(
      `SELECT DISTINCT action FROM mo_audit_logs WHERE actor_id LIKE $1`, [`${PX}-%`]))
      .rows.map((r) => r.action);
    for (const a of ["creator_payout_rule.created", "creator_payout_rule.updated",
                     "creator_payout_rule.deactivated",
                     "creator_payout.calculated", "creator_payout.approved", "creator_payout.rejected",
                     "creator_payout.paid", "creator_payout.voided", "creator_payout.adjusted",
                     "creator_financial_entry.reversed"])
      expect(seen, `missing audit action ${a}`).toContain(a);
  });

  it("an approval records the amount, the creator and the currency", async () => {
    const row = (await pool.query(
      `SELECT after FROM mo_audit_logs WHERE action='creator_payout.approved' AND actor_id LIKE $1
        ORDER BY id DESC LIMIT 1`, [`${PX}-%`])).rows[0];
    const after = typeof row.after === "string" ? JSON.parse(row.after) : row.after;
    expect(after).toMatchObject({ status: "approved", currency: "INR",
      gross_amount: expect.any(String) });
    expect(String(after.user_id)).toMatch(new RegExp(`^${PX}-`));
  });

  it("a creator is told when money happens to them", async () => {
    const { rows } = await pool.query(
      `SELECT title FROM mo_notifications WHERE user_id=$1 AND kind='payout' ORDER BY id`, [A.c1.id]);
    const titles = rows.map((r) => String(r.title));
    expect(titles.some((t) => t.includes("has been calculated"))).toBe(true);
    expect(titles.some((t) => t.includes("has been approved"))).toBe(true);
    expect(titles.some((t) => t.includes("has been paid"))).toBe(true);
  });

  it("the admin summary adds up to what the ledger says", async () => {
    const cycleRow = (await pool.query(
      `SELECT id FROM mo_creator_cycles WHERE label=$1`, [`${PX} September 2026`])).rows[0];
    const s = await as("creatorAdmin", "GET", `/creator/payouts/summary/${cycleRow.id}`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ payouts: 1, paid: 1, gross: "1840.00", paid_gross: "1840.00",
      outstanding: "0.00", settled: "1840.00", currency: "INR" });
  });
});
