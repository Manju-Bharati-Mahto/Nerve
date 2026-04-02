import type {
  WorkCategory, WorkSubCategory, DailyReport, DailyReportRow,
  KraParameter, SelfAppraisal, PeerMarking, AdminKraScore, KraReport,
  BrandingProject, MemberReportStatus, BrandingDesign, DesignVoter,
  BrandingPortalStats,
} from "./branding-types";

const BASE = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
const P = `${BASE}/branding/portal`;

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

export const brandingApi = {
  // ── Categories ─────────────────────────────────────────────────────────
  getCategories: () =>
    req<{ categories: WorkCategory[] }>("/categories"),
  createCategory: (name: string) =>
    req<{ category: WorkCategory }>("/categories", { method: "POST", body: JSON.stringify({ name }) }),
  updateCategory: (id: string, name: string) =>
    req<{ ok: boolean }>(`/categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteCategory: (id: string) =>
    req<{ ok: boolean; usageCount: number }>(`/categories/${id}`, { method: "DELETE" }),
  reorderCategories: (orderedIds: string[]) =>
    req<{ ok: boolean }>("/categories/reorder", { method: "POST", body: JSON.stringify({ orderedIds }) }),
  createSubCategory: (categoryId: string, name: string) =>
    req<{ sub: WorkSubCategory }>(`/categories/${categoryId}/sub`, { method: "POST", body: JSON.stringify({ name }) }),
  updateSubCategory: (id: string, name: string) =>
    req<{ ok: boolean }>(`/sub-categories/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteSubCategory: (id: string) =>
    req<{ ok: boolean; usageCount: number }>(`/sub-categories/${id}`, { method: "DELETE" }),

  // ── Daily Reports ───────────────────────────────────────────────────────
  getReport: (date: string) =>
    req<{ report: DailyReport }>(`/report?date=${date}`),
  saveRows: (reportId: string, rows: Omit<DailyReportRow, "id" | "report_id" | "created_at">[]) =>
    req<{ rows: DailyReportRow[] }>(`/report/${reportId}/rows`, {
      method: "PUT",
      body: JSON.stringify({ rows }),
    }),
  submitReport: (reportId: string) =>
    req<{ report: DailyReport }>(`/report/${reportId}/submit`, { method: "POST" }),
  getAllReports: (filters?: {
    userId?: string; dateFrom?: string; dateTo?: string;
    typeOfWork?: string; subCategory?: string; collaborator?: string; lockedOnly?: boolean;
  }) => {
    const params = new URLSearchParams();
    if (filters?.userId)       params.set("userId", filters.userId);
    if (filters?.dateFrom)     params.set("dateFrom", filters.dateFrom);
    if (filters?.dateTo)       params.set("dateTo", filters.dateTo);
    if (filters?.typeOfWork)   params.set("typeOfWork", filters.typeOfWork);
    if (filters?.subCategory)  params.set("subCategory", filters.subCategory);
    if (filters?.collaborator) params.set("collaborator", filters.collaborator);
    if (filters?.lockedOnly)   params.set("lockedOnly", "true");
    const qs = params.toString();
    return req<{ reports: DailyReport[] }>(`/reports${qs ? `?${qs}` : ""}`);
  },
  getAnalytics: (opts?: { dateFrom?: string; dateTo?: string; userId?: string }) => {
    const params = new URLSearchParams();
    if (opts?.dateFrom) params.set("dateFrom", opts.dateFrom);
    if (opts?.dateTo)   params.set("dateTo",   opts.dateTo);
    if (opts?.userId)   params.set("userId",   opts.userId);
    const qs = params.toString();
    return req<{ analytics: { typeHours: Record<string, number>; subCatHours: Record<string, Record<string, number>>; collaboratorMap: Record<string, { hours: number; count: number }>; totalReports: number } }>(`/analytics${qs ? `?${qs}` : ""}`);
  },

  // ── KRA ─────────────────────────────────────────────────────────────────
  getKraParameters: () =>
    req<{ parameters: KraParameter[] }>("/kra/parameters"),
  getPeerMarkingEnabled: () =>
    req<{ enabled: boolean }>("/kra/peer-marking-enabled"),
  togglePeerMarking: (enabled: boolean) =>
    req<{ ok: boolean; enabled: boolean }>("/kra/peer-marking-toggle", { method: "PATCH", body: JSON.stringify({ enabled }) }),
  getSelfAppraisal: (month: number, year: number) =>
    req<{ appraisal: SelfAppraisal | null }>(`/kra/self-appraisal?month=${month}&year=${year}`),
  submitSelfAppraisal: (month: number, year: number, scores: Record<string, number>) =>
    req<{ appraisal: SelfAppraisal }>("/kra/self-appraisal", { method: "POST", body: JSON.stringify({ month, year, scores }) }),
  getPeerMarkingCompleted: (month: number, year: number) =>
    req<{ completed: string[] }>(`/kra/peer-marking/completed?month=${month}&year=${year}`),
  submitPeerMarking: (revieweeId: string, month: number, year: number, scores: Record<string, number>) =>
    req<{ marking: PeerMarking }>("/kra/peer-marking", { method: "POST", body: JSON.stringify({ revieweeId, month, year, scores }) }),
  getKraReport: (userId: string, month: number, year: number) =>
    req<{ report: KraReport }>(`/kra/report/${userId}/${month}/${year}`),
  getAdminKraDashboard: (month: number, year: number) =>
    req<{ dashboard: KraReport[] }>(`/kra/admin/dashboard?month=${month}&year=${year}`),
  getAdminScore: (userId: string, month: number, year: number) =>
    req<{ score: AdminKraScore | null }>(`/kra/admin/score/${userId}/${month}/${year}`),
  setAdminScore: (userId: string, month: number, year: number, scores: Record<string, number>) =>
    req<{ score: AdminKraScore }>("/kra/admin/score", { method: "POST", body: JSON.stringify({ userId, month, year, scores }) }),
  finalPush: (userId: string, month: number, year: number) =>
    req<{ ok: boolean; score: AdminKraScore }>("/kra/admin/final-push", { method: "POST", body: JSON.stringify({ userId, month, year }) }),
  getAllPeerMarkings: (month: number, year: number) =>
    req<{ markings: PeerMarking[] }>(`/kra/admin/peer-markings?month=${month}&year=${year}`),

  // ── Super admin stats ──────────────────────────────────────────────────
  getSuperAdminStats: () =>
    req<BrandingPortalStats>(`/super-admin/stats`),

  // ── Team lead ──────────────────────────────────────────────────────────
  getTeamReportStatus: (date: string) =>
    req<{ statuses: MemberReportStatus[] }>(`/team/report-status?date=${date}`),

  // ── Design gallery ─────────────────────────────────────────────────────
  getDesigns: (filters?: { search?: string; category?: string; uploaderId?: string; dateFrom?: string; dateTo?: string }) => {
    const params = new URLSearchParams();
    if (filters?.search)     params.set("search", filters.search);
    if (filters?.category)   params.set("category", filters.category);
    if (filters?.uploaderId) params.set("uploaderId", filters.uploaderId);
    if (filters?.dateFrom)   params.set("dateFrom", filters.dateFrom);
    if (filters?.dateTo)     params.set("dateTo", filters.dateTo);
    const qs = params.toString();
    return req<{ designs: BrandingDesign[] }>(`/designs${qs ? `?${qs}` : ""}`);
  },
  uploadDesign: (formData: FormData) => {
    const base = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");
    return fetch(`${base}/branding/portal/designs`, {
      method: "POST",
      credentials: "include",
      body: formData,
    }).then(async r => {
      const payload = await r.json().catch(() => ({})) as { message?: string; design?: BrandingDesign };
      if (!r.ok) throw new Error(payload.message || "Upload failed.");
      return payload as { design: BrandingDesign };
    });
  },
  deleteDesign: (id: string) =>
    req<{ ok: boolean }>(`/designs/${id}`, { method: "DELETE" }),
  castVote: (id: string, voteType: "up" | "down" | null) =>
    req<{ upvotes: number; downvotes: number; user_vote: "up" | "down" | null }>(
      `/designs/${id}/vote`, { method: "POST", body: JSON.stringify({ vote_type: voteType }) }
    ),
  getVoters: (id: string) =>
    req<{ voters: DesignVoter[] }>(`/designs/${id}/voters`),

  // ── Projects ───────────────────────────────────────────────────────────
  getProjects: () =>
    req<{ projects: BrandingProject[] }>("/projects"),
  createProject: (data: { name: string; description?: string; deadline?: string; assigned_user_ids?: string[] }) =>
    req<{ project: BrandingProject }>("/projects", { method: "POST", body: JSON.stringify(data) }),
  updateProject: (id: string, data: { name: string; description?: string; deadline?: string; status?: BrandingProject["status"]; assigned_user_ids?: string[] }) =>
    req<{ project: BrandingProject }>(`/projects/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    req<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),
};
