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
}

export interface DraftRow {
  // Client-only draft row (no id until saved)
  _key: string;
  sr_no: number;
  type_of_work: string;
  sub_category: string;
  specific_work: string;
  time_taken: string;
  collaborative_colleagues: string[];
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

export const TIME_OPTIONS = [
  "30 min", "1 hr", "1.5 hr", "2 hr", "2.5 hr", "3 hr", "3.5 hr",
  "4 hr", "4.5 hr", "5 hr", "5.5 hr", "6 hr", "6.5 hr", "7 hr", "7.5 hr", "8 hr",
] as const;

export function timeToHours(t: string): number {
  if (t === "30 min") return 0.5;
  const m = t.match(/^(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : 0;
}

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
