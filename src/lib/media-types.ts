/** Nerve Media Ops — client types mirroring server/media-db.ts (PRD v1.0). */

export type MediaRole = "admin" | "team_lead" | "employee";

export const MEDIA_PROJECT_STATUSES = [
  "proposed", "approved", "planning", "in_production", "in_review",
  "delivered", "completed", "archived", "on_hold", "cancelled",
] as const;
export type MediaProjectStatus = (typeof MEDIA_PROJECT_STATUSES)[number];

export const MEDIA_DELIVERABLE_STATUSES = [
  "not_started", "in_progress", "in_review", "changes_requested",
  "approved", "delivered", "not_required", "cancelled",
] as const;
export type MediaDeliverableStatus = (typeof MEDIA_DELIVERABLE_STATUSES)[number];

export type MediaReportStatus = "draft" | "submitted" | "flagged" | "approved" | "auto_approved" | "returned";

export interface MediaLookup {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  icon: string | null;
  default_weight: number | null;
  default_unit: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface MediaAcademicYear {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  is_current: boolean;
}

export interface MediaTeamUser {
  id: string;
  full_name: string;
  role: string;
  email: string;
}

export interface MediaProject {
  id: string;
  code: string;
  name: string;
  description: string;
  project_type_id: string;
  academic_year_id: string;
  faculty_served: string;
  status: MediaProjectStatus;
  priority: "urgent" | "high" | "normal" | "low";
  owner_id: string;
  created_by: string;
  start_date: string | null;
  end_date: string | null;
  source: string;
  created_at: string;
  progress?: number;
  logged_minutes?: number;
  deliverable_total?: number;
  deliverable_done?: number;
}

export interface MediaAssignment {
  id: string;
  project_id: string;
  user_id: string;
  capacity_role_id: string | null;
  is_project_manager: boolean;
  assigned_at: string;
  full_name?: string;
  capacity_role_name?: string | null;
}

export interface MediaDeliverableVersion {
  id: string;
  deliverable_id: string;
  version_no: number;
  drive_url: string;
  note: string;
  submitted_by: string;
  submitted_at: string;
  review_status: "pending" | "approved" | "changes_requested";
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
}

export interface MediaDeliverable {
  id: string;
  project_id: string;
  deliverable_type_id: string;
  title: string;
  owner_id: string | null;
  due_date: string | null;
  completed_at: string | null;
  quantity_target: number | null;
  quantity_delivered: number | null;
  unit: string | null;
  spec_notes: string;
  weight: number;
  status: MediaDeliverableStatus;
  social_status: "na" | "scheduled" | "posted";
  social_post_url: string | null;
  mail_status: "na" | "pending" | "sent";
  project_code?: string;
  project_name?: string;
  version_count?: number;
  versions?: MediaDeliverableVersion[];
}

export interface MediaReportTask {
  id: string;
  daily_report_id: string;
  project_id: string;
  task_category_id: string;
  deliverable_id: string | null;
  description: string;
  start_time: string | null;
  end_time: string | null;
  minutes: number;
  quantity: number | null;
  unit: string | null;
  status: "done" | "in_progress" | "blocked";
  blocker_note: string | null;
  evidence_url: string | null;
  sort_order: number;
  project_name?: string;
  project_code?: string;
  category_name?: string;
  deliverable_title?: string | null;
}

export interface MediaDailyReport {
  id: string;
  user_id: string;
  report_date: string;
  status: MediaReportStatus;
  submitted_at: string | null;
  note: string;
  flagged_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_comment: string | null;
  total_minutes: number;
  tasks?: MediaReportTask[];
  user_name?: string;
}

export interface MediaNotification {
  id: string;
  user_id: string;
  kind: string;
  title: string;
  body: string;
  entity_type: string | null;
  entity_id: string | null;
  is_read: boolean;
  created_at: string;
}

export interface MediaActivityRow {
  action: string;
  entity_type: string;
  entity_id?: string;
  occurred_at: string;
  actor_name: string | null;
  project_name?: string | null;
}

export interface MediaDashboard {
  today: string;
  teamSize: number;
  pendingReports: Array<{ id: string; full_name: string }>;
  submittedTodayCount: number;
  deliverablesDueSoon: Array<{
    id: string; title: string; due_date: string; status: string; owner_id: string | null;
    owner_name: string | null; project_code: string; project_name: string; project_id: string; overdue: boolean;
  }>;
  runningProjects: MediaProject[];
  reviewQueue: MediaDailyReport[];
  reviewQueueCount: number;
  recentActivity: MediaActivityRow[];
}

export interface MediaLookups {
  project_types: MediaLookup[];
  deliverable_types: MediaLookup[];
  task_categories: MediaLookup[];
  capacity_roles: MediaLookup[];
  academic_years: MediaAcademicYear[];
}

export interface MediaTemplateRow {
  id: string;
  project_type_id: string;
  deliverable_type_id: string;
  deliverable_type_name?: string;
  default_weight: number;
  days_offset_due: number | null;
}

export const MEDIA_GREEN = "#1a472a";

export const PROJECT_STATUS_META: Record<MediaProjectStatus, { label: string; bg: string; fg: string }> = {
  proposed:      { label: "Proposed",      bg: "#ede9fe", fg: "#6d28d9" },
  approved:      { label: "Approved",      bg: "#dbeafe", fg: "#1d4ed8" },
  planning:      { label: "Planning",      bg: "#e0f2fe", fg: "#0369a1" },
  in_production: { label: "In Production", bg: "#fef3c7", fg: "#92400e" },
  in_review:     { label: "In Review",     bg: "#fce7f3", fg: "#9d174d" },
  delivered:     { label: "Delivered",     bg: "#dcfce7", fg: "#166534" },
  completed:     { label: "Completed",     bg: "#e6f4ea", fg: "#1a472a" },
  archived:      { label: "Archived",      bg: "#f3f4f6", fg: "#6b7280" },
  on_hold:       { label: "On Hold",       bg: "#fef9c3", fg: "#854d0e" },
  cancelled:     { label: "Cancelled",     bg: "#fee2e2", fg: "#b91c1c" },
};

export const DELIVERABLE_STATUS_META: Record<MediaDeliverableStatus, { label: string; bg: string; fg: string }> = {
  not_started:       { label: "Not Started",       bg: "#f3f4f6", fg: "#6b7280" },
  in_progress:       { label: "In Progress",       bg: "#e0f2fe", fg: "#0369a1" },
  in_review:         { label: "In Review",         bg: "#fef3c7", fg: "#92400e" },
  changes_requested: { label: "Changes Requested", bg: "#fee2e2", fg: "#b91c1c" },
  approved:          { label: "Approved",          bg: "#dbeafe", fg: "#1d4ed8" },
  delivered:         { label: "Delivered",         bg: "#dcfce7", fg: "#166534" },
  not_required:      { label: "Not Required",      bg: "#f3f4f6", fg: "#9ca3af" },
  cancelled:         { label: "Cancelled",         bg: "#fee2e2", fg: "#b91c1c" },
};

export const REPORT_STATUS_META: Record<MediaReportStatus, { label: string; bg: string; fg: string }> = {
  draft:         { label: "Draft",         bg: "#f3f4f6", fg: "#6b7280" },
  submitted:     { label: "Submitted",     bg: "#e0f2fe", fg: "#0369a1" },
  flagged:       { label: "Flagged",       bg: "#fee2e2", fg: "#b91c1c" },
  approved:      { label: "Approved",      bg: "#dcfce7", fg: "#166534" },
  auto_approved: { label: "Auto-approved", bg: "#e6f4ea", fg: "#1a472a" },
  returned:      { label: "Returned",      bg: "#fef3c7", fg: "#92400e" },
};

export function fmtMinutes(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
