/** Nerve Media Ops — API client for /api/v1/media (§13 conventions). */
import type {
  MediaRole, MediaLookups, MediaTeamUser, MediaDashboard, MediaProject,
  MediaAssignment, MediaDeliverable, MediaDeliverableVersion, MediaDailyReport,
  MediaNotification, MediaActivityRow, MediaTemplateRow,
} from "./media-types";

const BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const P = `${BASE}/v1/media`;

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${P}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const payload = await res.json().catch(() => ({})) as { message?: string } & Record<string, unknown>;
  if (!res.ok) throw new Error(payload.message || "Request failed.");
  return payload as T;
}

export interface ProjectDetailPayload {
  project: MediaProject;
  assignments: MediaAssignment[];
  deliverables: MediaDeliverable[];
  activity: MediaActivityRow[];
  links: Array<{ id: string; label: string; url: string; added_by_name?: string; created_at: string }>;
  memberHours: Array<{ user_id: string; full_name: string; minutes: number }>;
}

export const mediaApi = {
  bootstrap: () =>
    req<{ media_role: MediaRole; lookups: MediaLookups; team: MediaTeamUser[] }>("/bootstrap"),
  dashboard: () =>
    req<{ dashboard: MediaDashboard; media_role: MediaRole }>("/dashboard"),

  // Projects
  listProjects: (filters: { status?: string; type?: string; year?: string; q?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => !!v) as [string, string][]);
    return req<{ projects: MediaProject[] }>(`/projects${qs.size ? `?${qs}` : ""}`);
  },
  createProject: (input: {
    name: string; description?: string; project_type_id: string; academic_year_id: string;
    faculty_served?: string; priority?: string; start_date?: string | null; end_date?: string | null;
  }) => req<{ project: MediaProject }>("/projects", { method: "POST", body: JSON.stringify(input) }),
  getProject: (id: string) => req<ProjectDetailPayload>(`/projects/${id}`),
  updateProject: (id: string, patch: Record<string, unknown>) =>
    req<{ project: MediaProject }>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  setProjectStatus: (id: string, status: string) =>
    req<{ project: MediaProject }>(`/projects/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  addAssignment: (projectId: string, input: { user_id: string; capacity_role_id?: string | null; is_project_manager?: boolean }) =>
    req<{ assignment: MediaAssignment }>(`/projects/${projectId}/assignments`, { method: "POST", body: JSON.stringify(input) }),
  removeAssignment: (projectId: string, userId: string) =>
    req<{ ok: boolean }>(`/projects/${projectId}/assignments/${userId}`, { method: "DELETE" }),
  addProjectLink: (projectId: string, input: { label: string; url: string }) =>
    req<{ link: unknown }>(`/projects/${projectId}/links`, { method: "POST", body: JSON.stringify(input) }),

  // Deliverables
  listDeliverables: (filters: { status?: string; owner?: string; type?: string; project?: string } = {}) => {
    const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => !!v) as [string, string][]);
    return req<{ deliverables: MediaDeliverable[] }>(`/deliverables${qs.size ? `?${qs}` : ""}`);
  },
  getDeliverable: (id: string) => req<{ deliverable: MediaDeliverable }>(`/deliverables/${id}`),
  createDeliverable: (projectId: string, input: {
    deliverable_type_id: string; title: string; owner_id?: string | null; due_date?: string | null;
    quantity_target?: number | null; unit?: string | null; spec_notes?: string;
  }) => req<{ deliverable: MediaDeliverable }>(`/projects/${projectId}/deliverables`, { method: "POST", body: JSON.stringify(input) }),
  updateDeliverable: (id: string, patch: Record<string, unknown>) =>
    req<{ deliverable: MediaDeliverable }>(`/deliverables/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  submitVersion: (deliverableId: string, input: { drive_url: string; note?: string }) =>
    req<{ version: MediaDeliverableVersion }>(`/deliverables/${deliverableId}/versions`, { method: "POST", body: JSON.stringify(input) }),
  reviewVersion: (versionId: string, input: { outcome: "approved" | "changes_requested"; comment?: string }) =>
    req<{ version: MediaDeliverableVersion }>(`/versions/${versionId}/review`, { method: "POST", body: JSON.stringify(input) }),
  markDelivered: (deliverableId: string) =>
    req<{ deliverable: MediaDeliverable }>(`/deliverables/${deliverableId}/deliver`, { method: "POST", body: JSON.stringify({}) }),

  // Daily reporting
  myReport: (date?: string) =>
    req<{ report: MediaDailyReport | null; date: string }>(`/reports/mine${date ? `?date=${date}` : ""}`),
  myReportHistory: () => req<{ reports: MediaDailyReport[] }>("/reports/mine/history"),
  addTask: (date: string, input: Record<string, unknown>) =>
    req<{ report: MediaDailyReport }>(`/reports/${date}/tasks`, { method: "POST", body: JSON.stringify(input) }),
  updateTask: (taskId: string, patch: Record<string, unknown>) =>
    req<{ report: MediaDailyReport }>(`/report-tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteTask: (taskId: string) =>
    req<{ report: MediaDailyReport }>(`/report-tasks/${taskId}`, { method: "DELETE" }),
  submitReport: (date: string, note?: string) =>
    req<{ report: MediaDailyReport }>(`/reports/${date}/submit`, { method: "POST", body: JSON.stringify({ note }) }),
  reviewQueue: () => req<{ queue: MediaDailyReport[] }>("/reports/queue"),
  reportsForDate: (date?: string) =>
    req<{ reports: MediaDailyReport[]; date: string }>(`/reports${date ? `?date=${date}` : ""}`),
  getReport: (id: string) => req<{ report: MediaDailyReport }>(`/reports/${id}`),
  reviewReport: (id: string, input: { action: "approve" | "return" | "flag"; comment?: string }) =>
    req<{ report: MediaDailyReport }>(`/reports/${id}/review`, { method: "POST", body: JSON.stringify(input) }),

  // Notifications
  notifications: () => req<{ notifications: MediaNotification[] }>("/notifications"),
  markRead: (ids: string[] = []) =>
    req<{ ok: boolean }>("/notifications/read", { method: "POST", body: JSON.stringify({ ids }) }),

  // Admin
  createLookup: (type: string, name: string) =>
    req<{ item: unknown }>(`/admin/lookups/${type}`, { method: "POST", body: JSON.stringify({ name }) }),
  updateLookup: (type: string, id: string, patch: { name?: string; is_active?: boolean }) =>
    req<{ item: unknown }>(`/admin/lookups/${type}/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  templates: (projectTypeId?: string) =>
    req<{ templates: MediaTemplateRow[] }>(`/admin/templates${projectTypeId ? `?project_type_id=${projectTypeId}` : ""}`),
  setTemplates: (projectTypeId: string, entries: Array<{ deliverable_type_id: string; default_weight: number; days_offset_due: number | null }>) =>
    req<{ templates: MediaTemplateRow[] }>(`/admin/templates/${projectTypeId}`, { method: "PUT", body: JSON.stringify({ entries }) }),
  auditLogs: () => req<{ logs: Array<Record<string, unknown>> }>("/admin/audit"),
};
