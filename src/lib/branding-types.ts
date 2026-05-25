// ── Branding Portal — shared type definitions ─────────────────────────────

export interface WorkSubCategory {
  id: string;
  category_id: string;
  name: string;
  sort_order: number;
  is_others: boolean;
  created_at: string;
}

export interface WorkCategory {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
  sub_categories: WorkSubCategory[];
}

export type StopwatchStatus = 'idle' | 'running' | 'paused' | 'finished';

export interface DailyReportRow {
  id: string;
  report_id: string;
  sr_no: number;
  type_of_work: string;
  sub_category: string;
  specific_work: string;
  time_taken: string;
  collaborative_colleagues: string[];
  created_at: string;
  stopwatch_status: StopwatchStatus;
  elapsed_seconds: number;
  stopwatch_started_at: string | null;
  carried_over_from_row_id: string | null;
  last_paused_at: string | null;
}

export interface DraftRow {
  _key: string;
  sr_no: number;
  type_of_work: string;
  sub_category: string;
  specific_work: string;
  time_taken: string;
  collaborative_colleagues: string[];
  stopwatch_status: StopwatchStatus;
  elapsed_seconds: number;
  stopwatch_started_at: string | null;
  carried_over_from_row_id: string | null;
  last_paused_at: string | null;
}

export interface DailyReport {
  id: string;
  user_id: string;
  report_date: string;
  is_locked: boolean;
  submitted_at: string | null;
  created_at: string;
  rows: DailyReportRow[];
  user_name?: string;
  user_email?: string;
}

export interface KraParameter {
  id: string;
  name: string;
  description: string;
  max_score: number;
  sort_order: number;
}

export interface SelfAppraisal {
  id: string;
  user_id: string;
  month: number;
  year: number;
  scores: Record<string, number>;
  submitted_at: string;
}

export interface PeerMarking {
  id: string;
  reviewer_id: string;
  reviewee_id: string;
  month: number;
  year: number;
  scores: Record<string, number>;
  submitted_at: string;
  reviewer_name?: string;
  reviewee_name?: string;
}

export interface AdminKraScore {
  id: string;
  user_id: string;
  month: number;
  year: number;
  scores: Record<string, number>;
  is_final_pushed: boolean;
  pushed_at: string | null;
  pushed_by: string | null;
  updated_at: string;
  manual_penalty_percent: number;
  manual_penalty_reason: string;
  total_penalty_override: number | null;
  total_penalty_override_reason: string;
}

export interface KraReport {
  user_id: string;
  user_name: string;
  month: number;
  year: number;
  self_appraisal: SelfAppraisal | null;
  peer_average: Record<string, number>;
  peer_count: number;
  admin_score: AdminKraScore | null;
  composite_score: number | null;
  team_joined_at: string | null;
  kra_window_start: string;
  expected_report_days: number;
  submitted_report_days: number;
  missed_report_days: number;
  penalty_percent: number;
  manual_penalty_percent: number;
  manual_penalty_reason: string;
  total_penalty_override: number | null;
  total_penalty_override_reason: string;
  total_penalty_percent: number;
  composite_score_after_penalty: number | null;
  is_final_pushed: boolean;
}

export interface BrandingDesign {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  image_url: string;
  uploader_id: string;
  uploader_name: string;
  created_at: string;
  upvotes: number;
  downvotes: number;
  user_vote: "up" | "down" | null;
}

export interface DesignVoter {
  user_id: string;
  user_name: string;
  vote_type: "up" | "down";
  voted_at: string;
}

export interface BrandingPortalStats {
  designs_count: number;
  projects_count: number;
  today_submitted: number;
  today_total: number;
  recent_designs: {
    id: string;
    title: string;
    image_url: string;
    uploader_name: string;
    created_at: string;
    upvotes: number;
    downvotes: number;
  }[];
}

export interface MemberReportStatus {
  user_id: string;
  user_name: string;
  user_email: string;
  role: string;
  has_submitted: boolean;
}

export interface BrandingProject {
  id: string;
  name: string;
  description: string;
  deadline: string | null;
  status: "active" | "completed" | "on_hold";
  created_by: string;
  created_at: string;
  assigned_user_ids: string[];
}

// Lead-authored per-row feedback on a member's daily report.
export interface ReportRowComment {
  id: string;
  row_id: string;
  author_id: string;
  author_name: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export type HalfDayPeriod = 'first' | 'second';

export interface BrandingLeave {
  id: string;
  user_id: string;
  leave_date: string;           // YYYY-MM-DD (day portion of start_at)
  start_at: string;             // ISO datetime
  end_at: string;               // ISO datetime
  is_half_day: boolean;
  half_day_period: HalfDayPeriod | null;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  transfer_date: string | null; // YYYY-MM-DD
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  user_name?: string;
  user_email?: string;
}

export const TIME_OPTIONS = [
  "30 min", "1 hr", "1.5 hr", "2 hr", "2.5 hr", "3 hr", "3.5 hr",
  "4 hr", "4.5 hr", "5 hr", "5.5 hr", "6 hr", "6.5 hr", "7 hr", "7.5 hr", "8 hr",
] as const;

export function timeToHours(t: string): number {
  if (!t) return 0;
  if (t === "30 min") return 0.5;
  // Stopwatch composite formats: "Xh Ym Zs", "Xh Ym", "Xh", "Ym Zs", "Ym", "Zs", "0s"
  const composite = t.match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/);
  if (composite && (composite[1] || composite[2] || composite[3])) {
    const h = composite[1] ? parseInt(composite[1], 10) : 0;
    const m = composite[2] ? parseInt(composite[2], 10) : 0;
    const s = composite[3] ? parseInt(composite[3], 10) : 0;
    return h + m / 60 + s / 3600;
  }
  // Legacy "1.5 hr" / "2 hr" dropdown values
  const m = t.match(/^(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

// Format an elapsed seconds value into "Hh Mm Ss" (omits leading zero parts).
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Compact form used as `time_taken` once a stopwatch finishes/pauses.
// Examples: "30s", "2m 15s", "1h 5m". Always reflects what was tracked,
// even sub-minute, so a row paused at 30s shows "30s" not "0m".
// Per-day elapsed for a stopwatch row whose work may span multiple days
// via the carry-over chain. `elapsed_seconds` is cumulative — this
// subtracts the source row's cumulative so the caller gets just the
// portion tracked on the day of `row`. If the source row isn't in the
// supplied report set (filter window doesn't include the prior day),
// falls back to the cumulative value.
export function perDayElapsedSeconds(
  row: { elapsed_seconds: number; carried_over_from_row_id: string | null },
  allReports: { rows?: { id: string; elapsed_seconds: number }[] }[],
): number {
  if (!row.carried_over_from_row_id) return row.elapsed_seconds;
  for (const rep of allReports) {
    const src = rep.rows?.find(r => r.id === row.carried_over_from_row_id);
    if (src) return Math.max(0, row.elapsed_seconds - src.elapsed_seconds);
  }
  return row.elapsed_seconds;
}

export function elapsedToTimeTaken(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s === 0) return '0s';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  // Show seconds when there are no hours (so we don't pollute "1h 5m" with seconds)
  if (sec > 0 && h === 0) parts.push(`${sec}s`);
  return parts.join(' ');
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
