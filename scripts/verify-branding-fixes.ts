// Programmatic verification of all 5 branding-improvements fixes.
// Hits the live API on localhost:3001 + reads the DB to confirm migrations.

import { pool } from "../server/db.js";

const API = "http://localhost:3001/api";

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status} ${body}`);
  }
  const setCookie = res.headers.get("set-cookie") ?? "";
  const session = setCookie.split(";")[0];
  if (!session) throw new Error(`No session cookie returned for ${email}`);
  return session;
}

async function api<T = unknown>(method: string, path: string, cookie: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return text ? (JSON.parse(text) as T) : ({} as T);
}

interface Pass { name: string; ok: true; detail?: string }
interface Fail { name: string; ok: false; detail: string }
const results: (Pass | Fail)[] = [];
function pass(name: string, detail?: string) { results.push({ name, ok: true, detail }); }
function fail(name: string, detail: string) { results.push({ name, ok: false, detail }); }

(async () => {
  // ── 0. Schema migrations ─────────────────────────────────────────────
  const dailyCols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'daily_report_rows'
         AND column_name IN ('stopwatch_status','elapsed_seconds','stopwatch_started_at','carried_over_from_row_id')`
  );
  const dailyMissing = ['stopwatch_status','elapsed_seconds','stopwatch_started_at','carried_over_from_row_id']
    .filter(c => !dailyCols.rows.some(r => r.column_name === c));
  if (dailyMissing.length === 0) pass("schema: daily_report_rows has stopwatch columns");
  else fail("schema: daily_report_rows stopwatch columns", `missing: ${dailyMissing.join(", ")}`);

  const leaveCols = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'branding_leaves'
         AND column_name IN ('start_at','end_at','is_half_day','half_day_period')`
  );
  const leaveMissing = ['start_at','end_at','is_half_day','half_day_period']
    .filter(c => !leaveCols.rows.some(r => r.column_name === c));
  if (leaveMissing.length === 0) pass("schema: branding_leaves has datetime + half-day columns");
  else fail("schema: branding_leaves datetime columns", `missing: ${leaveMissing.join(", ")}`);

  // ── 1. Login as a branding member ────────────────────────────────────
  const userCookie = await login("brand-user@parul.ac.in", "Brand123");
  pass("auth: brand-user logged in");

  // ── 2. Daily report → save row with stopwatch state ──────────────────
  const today = new Date().toISOString().split("T")[0];
  const rep1 = await api<{ report: { id: string; rows: unknown[] } }>("GET", `/branding/portal/report?date=${today}`, userCookie);
  const reportId = rep1.report.id;
  pass("daily report: getOrCreate today", `report_id=${reportId}`);

  // Save a paused row (simulating the user pausing at 2m 15s = 135s)
  await api("PUT", `/branding/portal/report/${reportId}/rows`, userCookie, {
    rows: [
      {
        sr_no: 1,
        type_of_work: "Social Media",
        sub_category: "University Page Daily Post",
        specific_work: "Test paused row from verification script",
        time_taken: "2m 15s",
        collaborative_colleagues: [],
        stopwatch_status: "paused",
        elapsed_seconds: 135,
        stopwatch_started_at: null,
        carried_over_from_row_id: null,
      },
    ],
  });
  const rep2 = await api<{ report: { rows: { stopwatch_status: string; elapsed_seconds: number; time_taken: string }[] } }>("GET", `/branding/portal/report?date=${today}`, userCookie);
  const savedRow = rep2.report.rows[0];
  if (savedRow?.stopwatch_status === "paused" && savedRow.elapsed_seconds === 135 && savedRow.time_taken === "2m 15s") {
    pass("stopwatch: paused row persisted", `status=${savedRow.stopwatch_status}, elapsed=${savedRow.elapsed_seconds}s, time_taken="${savedRow.time_taken}"`);
  } else {
    fail("stopwatch: paused row persisted", `got status=${savedRow?.stopwatch_status}, elapsed=${savedRow?.elapsed_seconds}, time_taken="${savedRow?.time_taken}"`);
  }

  // ── 3. Live-sync: non-admin team scope fetch ─────────────────────────
  const teamRes = await api<{ reports: { user_id: string }[] }>("GET", `/branding/portal/reports?dateFrom=${today}&dateTo=${today}&scope=team`, userCookie);
  const distinctUsers = new Set(teamRes.reports.map(r => r.user_id));
  if (distinctUsers.size >= 1) {
    pass("live-sync: branding member can fetch team reports", `${teamRes.reports.length} reports from ${distinctUsers.size} user(s)`);
  } else {
    fail("live-sync: team scope", "0 users returned even though report just created");
  }

  // Without ?scope=team, a non-admin should ONLY see their own reports
  const ownRes = await api<{ reports: { user_id: string }[] }>("GET", `/branding/portal/reports?dateFrom=${today}&dateTo=${today}`, userCookie);
  const ownUsers = new Set(ownRes.reports.map(r => r.user_id));
  if (ownUsers.size <= 1) pass("live-sync: default scope still member-only");
  else fail("live-sync: default scope", `expected ≤1 user, got ${ownUsers.size}`);

  // ── 4. Leave: half-day detection ─────────────────────────────────────
  // Tomorrow so we don't conflict with today's report leave
  const tomorrow = new Date(Date.now() + 24 * 3600_000).toISOString().split("T")[0];
  // First half: 09:00-13:00 UTC
  const firstHalf = await api<{ leave: { is_half_day: boolean; half_day_period: string | null } }>(
    "POST", "/branding/portal/leave", userCookie, {
      start_at: `${tomorrow}T09:00:00.000Z`,
      end_at: `${tomorrow}T13:00:00.000Z`,
      reason: "Verification: first half",
    }
  );
  if (firstHalf.leave.is_half_day && firstHalf.leave.half_day_period === "first") {
    pass("leave: 9-1 detected as first half");
  } else {
    fail("leave: first half", `is_half_day=${firstHalf.leave.is_half_day}, period=${firstHalf.leave.half_day_period}`);
  }

  // Same day, second half (overwrites via ON CONFLICT)
  const secondHalf = await api<{ leave: { is_half_day: boolean; half_day_period: string | null } }>(
    "POST", "/branding/portal/leave", userCookie, {
      start_at: `${tomorrow}T14:00:00.000Z`,
      end_at: `${tomorrow}T17:00:00.000Z`,
      reason: "Verification: second half",
    }
  );
  if (secondHalf.leave.is_half_day && secondHalf.leave.half_day_period === "second") {
    pass("leave: 2-5 detected as second half");
  } else {
    fail("leave: second half", `is_half_day=${secondHalf.leave.is_half_day}, period=${secondHalf.leave.half_day_period}`);
  }

  // Multi-day (different start/end dates) → not a half day
  const dayAfter = new Date(Date.now() + 48 * 3600_000).toISOString().split("T")[0];
  const dayAfter2 = new Date(Date.now() + 72 * 3600_000).toISOString().split("T")[0];
  const multiDay = await api<{ leave: { is_half_day: boolean; half_day_period: string | null } }>(
    "POST", "/branding/portal/leave", userCookie, {
      start_at: `${dayAfter}T09:00:00.000Z`,
      end_at: `${dayAfter2}T17:00:00.000Z`,
      reason: "Verification: multi-day",
    }
  );
  if (!multiDay.leave.is_half_day && multiDay.leave.half_day_period === null) {
    pass("leave: multi-day not flagged as half-day");
  } else {
    fail("leave: multi-day", `unexpectedly flagged: ${JSON.stringify(multiDay.leave)}`);
  }

  // Clean up the verification leaves so they don't pollute the user's UI
  await pool.query(`DELETE FROM branding_leaves WHERE reason LIKE 'Verification: %'`);
  pass("cleanup: verification leaves removed");

  // ── 5. KRA penalty math ──────────────────────────────────────────────
  // Login as admin to read KRA dashboard which exposes penalty fields
  const adminCookie = await login("brand-admin@parul.ac.in", "brand123");
  const now = new Date();
  const kra = await api<{ dashboard: { user_name: string; expected_report_days: number; submitted_report_days: number; missed_report_days: number; penalty_percent: number; composite_score_after_penalty: number | null }[] }>(
    "GET", `/branding/portal/kra/admin/dashboard?month=${now.getMonth() + 1}&year=${now.getFullYear()}`, adminCookie
  );
  const sample = kra.dashboard[0];
  if (sample && typeof sample.expected_report_days === "number" && typeof sample.penalty_percent === "number") {
    pass("kra: penalty fields present in admin dashboard",
      `${sample.user_name}: ${sample.submitted_report_days}/${sample.expected_report_days} submitted, missed=${sample.missed_report_days}, penalty=−${sample.penalty_percent}%, finalScore=${sample.composite_score_after_penalty}`);
  } else {
    fail("kra: penalty fields", `dashboard returned ${kra.dashboard.length} rows; first=${JSON.stringify(sample)}`);
  }

  // ── Report ───────────────────────────────────────────────────────────
  console.log("\n=== VERIFICATION RESULTS ===");
  for (const r of results) {
    const sym = r.ok ? "✓" : "✗";
    console.log(`${sym} ${r.name}${r.detail ? "  →  " + r.detail : ""}`);
  }
  const okCount = results.filter(r => r.ok).length;
  const failCount = results.filter(r => !r.ok).length;
  console.log(`\n${okCount} passed, ${failCount} failed.`);
  await pool.end();
  process.exit(failCount === 0 ? 0 : 1);
})().catch(async e => {
  console.error("\nFATAL:", e instanceof Error ? e.message : e);
  await pool.end().catch(() => {});
  process.exit(1);
});
